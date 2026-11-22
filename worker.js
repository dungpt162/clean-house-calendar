// Cloudflare Worker:
//  - phục vụ web tĩnh qua ASSETS
//  - API quản lý lịch (/api/*) có đăng nhập bằng mật khẩu, dữ liệu động lưu trong KV (STATE)
//  - Cron Trigger (wrangler.jsonc) gửi thông báo đổ rác lên Discord
//
// Secrets cần đặt trong Cloudflare: ADMIN_PASSWORD, DISCORD_WEBHOOK_URL.
// schedule.json trong repo giữ thành viên + ngày bắt đầu; KV giữ overrides + helpers + penalties.
import { buildMessage, buildPenaltyMessage, vietnamToday } from "./notify-message.mjs";
import core from "./public/core.js";

const MAX_PENALTY_DAYS = 5;

const SESSION_TTL_SEC = 12 * 3600;
const MAX_FAILED_LOGINS = 5;
const FAIL_WINDOW_SEC = 15 * 60;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const enc = new TextEncoder();

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });

// ---------- Dữ liệu lịch ----------
async function loadBase(env) {
  const res = await env.ASSETS.fetch(new Request("https://assets.internal/schedule.json"));
  if (!res.ok) throw new Error("Không đọc được schedule.json: HTTP " + res.status);
  return res.json();
}

async function loadState(env) {
  if (!env.STATE) throw new Error("Chưa gắn KV namespace STATE");
  const raw = await env.STATE.get("state", "json");
  return {
    overrides: (raw && raw.overrides) || {},
    helpers: (raw && raw.helpers) || {},
    penalties: (raw && raw.penalties) || [],
    holidays: (raw && raw.holidays) || [],
    extraMembers: (raw && raw.extraMembers) || [],
    memberMeta: (raw && raw.memberMeta) || {},
    absences: (raw && raw.absences) || [],
  };
}

async function getSchedule(env) {
  const [base, state] = await Promise.all([loadBase(env), loadState(env)]);
  // Thành viên thêm sau (có `from`) xếp sau thành viên gốc, theo ngày vào.
  const extras = [...state.extraMembers].sort((a, b) => a.from.localeCompare(b.from));
  const members = [...base.members, ...extras].map((m) => ({ ...m, ...(state.memberMeta[m.name] || {}) }));
  return {
    ...base,
    members,
    extraMembers: state.extraMembers,
    memberMeta: state.memberMeta,
    absences: state.absences,
    overrides: state.overrides,
    helpers: state.helpers,
    penalties: state.penalties,
    holidays: state.holidays,
  };
}

const isWorkdayIso = (s) => typeof s === "string" && ISO_DATE.test(s) && !core.isWeekend(core.parseISODate(s));

function validatePenalties(penalties, names) {
  if (!Array.isArray(penalties) || penalties.length > 1000) return "penalties không hợp lệ";
  const usedDays = new Set();
  const keys = new Set();
  for (const p of penalties) {
    if (!p || typeof p !== "object" || Object.keys(p).some((k) => !["date", "name", "days"].includes(k))) {
      return "penalties không hợp lệ";
    }
    if (!isWorkdayIso(p.date) || !names.has(p.name)) return "penalties có ngày hoặc tên không hợp lệ";
    const key = p.date + "|" + p.name;
    if (keys.has(key)) return "Đã ghi phạt người này cho ngày đó";
    keys.add(key);
    if (!Array.isArray(p.days) || !p.days.length || p.days.length > MAX_PENALTY_DAYS) return "Số ngày phạt không hợp lệ";
    for (const d of p.days) {
      if (!isWorkdayIso(d) || d <= p.date) return "Ngày phạt phải là ngày làm việc sau ngày quên";
      if (usedDays.has(d)) return "Ngày phạt " + d + " bị trùng";
      usedDays.add(d);
    }
  }
  return null;
}

const MAX_MEMBERS = 50;

function validateExtraMembers(extra, baseMembers) {
  if (!Array.isArray(extra) || baseMembers.length + extra.length > MAX_MEMBERS) return "members không hợp lệ";
  const names = new Set(baseMembers.map((m) => m.name));
  for (const m of extra) {
    if (!m || typeof m !== "object" || Object.keys(m).some((k) => !["name", "color", "discordId", "from"].includes(k))) {
      return "members không hợp lệ";
    }
    if (typeof m.name !== "string" || !m.name.trim() || m.name.length > 40 || m.name !== m.name.trim()) {
      return "Tên nhân viên không hợp lệ";
    }
    if (names.has(m.name)) return "Tên nhân viên bị trùng: " + m.name;
    names.add(m.name);
    if (typeof m.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(m.color)) return "Màu không hợp lệ";
    if (typeof m.discordId !== "string" || !/^\d{5,25}$/.test(m.discordId)) return "Discord ID không hợp lệ";
    if (typeof m.from !== "string" || !ISO_DATE.test(m.from)) return "Ngày bắt đầu không hợp lệ";
  }
  return null;
}

function validateHolidays(holidays) {
  if (!Array.isArray(holidays) || holidays.length > 1000) return "holidays không hợp lệ";
  if (!holidays.every((d) => isWorkdayIso(d)) || new Set(holidays).size !== holidays.length) {
    return "Ngày nghỉ phải là ngày làm việc (T2-T6), không trùng nhau";
  }
  return null;
}

function validateMemberMeta(meta, names) {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return "memberMeta không hợp lệ";
  for (const [name, v] of Object.entries(meta)) {
    if (!names.has(name) || !v || typeof v !== "object" || Object.keys(v).some((k) => !["color", "discordId", "to"].includes(k))) {
      return "memberMeta không hợp lệ";
    }
    if ("color" in v && !(typeof v.color === "string" && /^#[0-9a-fA-F]{6}$/.test(v.color))) return "Màu không hợp lệ";
    if ("discordId" in v && !(typeof v.discordId === "string" && /^\d{5,25}$/.test(v.discordId))) return "Discord ID không hợp lệ";
    if ("to" in v && !(typeof v.to === "string" && ISO_DATE.test(v.to))) return "Ngày nghỉ việc không hợp lệ";
  }
  return null;
}

function validateAbsences(absences, names) {
  if (!Array.isArray(absences) || absences.length > 500) return "absences không hợp lệ";
  for (const a of absences) {
    if (!a || typeof a !== "object" || Object.keys(a).some((k) => !["name", "from", "to"].includes(k))) return "absences không hợp lệ";
    if (!names.has(a.name) || !ISO_DATE.test(a.from) || !ISO_DATE.test(a.to) || a.from > a.to) {
      return "Khoảng vắng mặt không hợp lệ";
    }
  }
  return null;
}

function validateState(body, baseMembers) {
  const { overrides, helpers, penalties, holidays, members: extra, memberMeta, absences } = body || {};
  const extraErr = validateExtraMembers(extra, baseMembers);
  if (extraErr) return extraErr;
  const holidayErr = validateHolidays(holidays);
  if (holidayErr) return holidayErr;
  const members = [...baseMembers, ...extra];
  const names = new Set(members.map((m) => m.name));
  const metaErr = validateMemberMeta(memberMeta, names) || validateAbsences(absences, names);
  if (metaErr) return metaErr;
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) return "overrides không hợp lệ";
  if (!helpers || typeof helpers !== "object" || Array.isArray(helpers)) return "helpers không hợp lệ";
  const penaltyErr = validatePenalties(penalties, names);
  if (penaltyErr) return penaltyErr;
  if (Object.keys(overrides).length > 1000 || Object.keys(helpers).length > 1000) return "Quá nhiều mục";
  for (const [d, name] of Object.entries(overrides)) {
    if (!ISO_DATE.test(d) || !names.has(name)) return "overrides có ngày hoặc tên không hợp lệ";
  }
  for (const [d, list] of Object.entries(helpers)) {
    if (!ISO_DATE.test(d) || !Array.isArray(list) || list.length > members.length) return "helpers không hợp lệ";
    if (!list.every((n) => names.has(n)) || new Set(list).size !== list.length) return "helpers có tên không hợp lệ";
  }
  return null;
}

// ---------- Nhật ký thay đổi ----------
const AUDIT_MAX = 200;

async function audit(env, request, entries) {
  const list = (Array.isArray(entries) ? entries : [entries]).filter(Boolean);
  if (!list.length) return;
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const t = new Date().toISOString();
  const log = (await env.STATE.get("audit", "json")) || [];
  list.forEach((text) => log.unshift({ t, ip, text }));
  await env.STATE.put("audit", JSON.stringify(log.slice(0, AUDIT_MAX)));
}

const dayLabel = (iso) => iso.slice(8) + "/" + iso.slice(5, 7) + "/" + iso.slice(0, 4);

// So sánh state cũ/mới thành các dòng mô tả dễ đọc.
function diffState(a, b) {
  const out = [];
  const keysDiff = (x, y) => [
    Object.keys(y).filter((k) => !(k in x)),
    Object.keys(x).filter((k) => !(k in y)),
    Object.keys(y).filter((k) => k in x && JSON.stringify(x[k]) !== JSON.stringify(y[k])),
  ];
  const [oAdd, oDel, oChg] = keysDiff(a.overrides, b.overrides);
  oAdd.forEach((d) => out.push(`Hoán đổi: ${dayLabel(d)} → ${b.overrides[d]}`));
  oChg.forEach((d) => out.push(`Hoán đổi: ${dayLabel(d)} đổi từ ${a.overrides[d]} → ${b.overrides[d]}`));
  oDel.forEach((d) => out.push(`Huỷ hoán đổi ngày ${dayLabel(d)}`));
  const [hAdd, hDel, hChg] = keysDiff(a.helpers, b.helpers);
  [...hAdd, ...hChg].forEach((d) => {
    const before = a.helpers[d] || [];
    b.helpers[d].filter((n) => !before.includes(n)).forEach((n) => out.push(`Đổ chung: ${n} phụ ngày ${dayLabel(d)}`));
    before.filter((n) => !b.helpers[d].includes(n)).forEach((n) => out.push(`Huỷ đổ chung: ${n} ngày ${dayLabel(d)}`));
  });
  hDel.forEach((d) => a.helpers[d].forEach((n) => out.push(`Huỷ đổ chung: ${n} ngày ${dayLabel(d)}`)));
  const pk = (p) => p.date + "|" + p.name;
  const oldP = new Set(a.penalties.map(pk));
  const newP = new Set(b.penalties.map(pk));
  b.penalties.filter((p) => !oldP.has(pk(p))).forEach((p) => out.push(`Ghi phạt: ${p.name} quên ngày ${dayLabel(p.date)}`));
  a.penalties.filter((p) => !newP.has(pk(p))).forEach((p) => out.push(`Huỷ phạt: ${p.name} ngày ${dayLabel(p.date)}`));
  b.holidays.filter((d) => !a.holidays.includes(d)).forEach((d) => out.push(`Đánh dấu nghỉ ngày ${dayLabel(d)}`));
  a.holidays.filter((d) => !b.holidays.includes(d)).forEach((d) => out.push(`Bỏ ngày nghỉ ${dayLabel(d)}`));
  const en = new Set(a.extraMembers.map((m) => m.name));
  b.extraMembers.filter((m) => !en.has(m.name)).forEach((m) => out.push(`Thêm nhân viên ${m.name} (vào từ ${dayLabel(m.from)})`));
  const fields = { color: "màu", discordId: "Discord ID", to: "ngày nghỉ việc" };
  new Set([...Object.keys(a.memberMeta), ...Object.keys(b.memberMeta)]).forEach((name) => {
    const x = a.memberMeta[name] || {};
    const y = b.memberMeta[name] || {};
    Object.keys(fields).forEach((f) => {
      if (x[f] === y[f]) return;
      if (f === "to") out.push(y.to ? `${name} nghỉ việc từ sau ngày ${dayLabel(y.to)}` : `${name} bỏ ngày nghỉ việc`);
      else out.push(`Sửa ${fields[f]} của ${name}`);
    });
  });
  const ak = (x) => `${x.name}|${x.from}|${x.to}`;
  const oldA = new Set(a.absences.map(ak));
  const newA = new Set(b.absences.map(ak));
  b.absences.filter((x) => !oldA.has(ak(x))).forEach((x) => out.push(`Vắng mặt: ${x.name} ${dayLabel(x.from)} - ${dayLabel(x.to)}`));
  a.absences.filter((x) => !newA.has(ak(x))).forEach((x) => out.push(`Huỷ vắng mặt: ${x.name} ${dayLabel(x.from)} - ${dayLabel(x.to)}`));
  return out;
}

// ---------- Thông báo Discord ----------
async function postDiscord(env, content) {
  if (!env.DISCORD_WEBHOOK_URL) throw new Error("Thiếu secret DISCORD_WEBHOOK_URL");
  const post = await fetch(env.DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!post.ok) throw new Error("Discord trả về HTTP " + post.status + ": " + (await post.text()));
  console.log("Đã gửi thông báo:\n" + content);
}

async function sendDailyNotification(env) {
  if (!env.DISCORD_WEBHOOK_URL) throw new Error("Thiếu secret DISCORD_WEBHOOK_URL");
  const content = buildMessage(await getSchedule(env), vietnamToday());
  if (!content) {
    console.log("Cuối tuần - không đổ rác, bỏ qua.");
    return null;
  }
  await postDiscord(env, content);
  return content;
}

// Nội dung lấy từ mục phạt đã lưu trong KV, không nhận văn bản tuỳ ý từ client.
async function sendPenaltyNotification(env, date, name) {
  const schedule = await getSchedule(env);
  const penalty = schedule.penalties.find((p) => p.date === date && p.name === name);
  if (!penalty) return false;
  await postDiscord(env, buildPenaltyMessage(schedule, penalty));
  return true;
}

// ---------- Đăng nhập ----------
async function sha256(s) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a[i] ^ b[i];
  return r === 0;
}

async function hmacHex(key, msg) {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function makeSession(env) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SEC;
  return `${exp}.${await hmacHex(env.ADMIN_PASSWORD, "session:" + exp)}`;
}

async function isAuthed(request, env) {
  const m = /(?:^|;\s*)cms_session=([^;]+)/.exec(request.headers.get("Cookie") || "");
  if (!m) return false;
  const [exp, sig] = m[1].split(".");
  if (!exp || !sig || Number(exp) < Date.now() / 1000) return false;
  const expected = await hmacHex(env.ADMIN_PASSWORD, "session:" + exp);
  return bytesEqual(enc.encode(sig), enc.encode(expected));
}

const cookie = (value, maxAge) =>
  `cms_session=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

// ---------- API ----------
async function handleApi(request, env, url) {
  const { pathname } = url;
  const method = request.method;

  if (method === "GET" && pathname === "/api/schedule") {
    return json(await getSchedule(env));
  }

  if (!env.ADMIN_PASSWORD) return json({ error: "Chưa đặt secret ADMIN_PASSWORD" }, 503);

  if (method === "GET" && pathname === "/api/me") {
    return json({ authed: await isAuthed(request, env) });
  }

  // Các request ghi: bắt buộc JSON và cùng origin (chống CSRF, kèm SameSite=Strict).
  if (method !== "GET") {
    const origin = request.headers.get("Origin");
    if (origin && origin !== url.origin) return json({ error: "Origin không hợp lệ" }, 403);
    if (!(request.headers.get("Content-Type") || "").includes("application/json")) {
      return json({ error: "Cần Content-Type: application/json" }, 415);
    }
  }

  if (method === "POST" && pathname === "/api/login") {
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const failKey = "fail:" + ip;
    const fails = Number(await env.STATE.get(failKey)) || 0;
    if (fails >= MAX_FAILED_LOGINS) return json({ error: "Nhập sai quá nhiều lần, thử lại sau 15 phút." }, 429);

    let body;
    try { body = await request.json(); } catch (e) { return json({ error: "JSON không hợp lệ" }, 400); }
    const ok = typeof body.password === "string" &&
      bytesEqual(await sha256(body.password), await sha256(env.ADMIN_PASSWORD));
    if (!ok) {
      await env.STATE.put(failKey, String(fails + 1), { expirationTtl: FAIL_WINDOW_SEC });
      return json({ error: "Sai mật khẩu." }, 401);
    }
    if (fails) await env.STATE.delete(failKey);
    await audit(env, request, "Đăng nhập /cms");
    return json({ ok: true }, 200, { "Set-Cookie": cookie(await makeSession(env), SESSION_TTL_SEC) });
  }

  if (method === "POST" && pathname === "/api/logout") {
    return json({ ok: true }, 200, { "Set-Cookie": cookie("", 0) });
  }

  if (pathname === "/api/schedule" || pathname === "/api/notify" || pathname === "/api/penalty-notify" || pathname === "/api/audit") {
    if (!(await isAuthed(request, env))) return json({ error: "Chưa đăng nhập" }, 401);

    if (method === "GET" && pathname === "/api/audit") {
      return json({ log: (await env.STATE.get("audit", "json")) || [] });
    }

    if (method === "PUT" && pathname === "/api/schedule") {
      let body;
      try { body = await request.json(); } catch (e) { return json({ error: "JSON không hợp lệ" }, 400); }
      const base = await loadBase(env);
      const err = validateState(body, base.members);
      if (err) return json({ error: err }, 400);
      const before = await loadState(env);
      const next = {
        overrides: body.overrides, helpers: body.helpers, penalties: body.penalties,
        holidays: [...body.holidays].sort(), extraMembers: body.members,
        memberMeta: body.memberMeta, absences: body.absences,
      };
      await env.STATE.put("state", JSON.stringify(next));
      await audit(env, request, diffState(before, next));
      return json(await getSchedule(env));
    }

    if (method === "POST" && pathname === "/api/notify") {
      try {
        const sent = await sendDailyNotification(env);
        await audit(env, request, sent ? "Gửi thông báo Discord thủ công" : null);
        return json({ ok: true, sent: !!sent });
      } catch (e) {
        return json({ error: e.message }, 502);
      }
    }

    if (method === "POST" && pathname === "/api/penalty-notify") {
      let body;
      try { body = await request.json(); } catch (e) { return json({ error: "JSON không hợp lệ" }, 400); }
      try {
        if (!(await sendPenaltyNotification(env, body.date, body.name))) {
          return json({ error: "Không tìm thấy mục phạt" }, 404);
        }
        await audit(env, request, `Gửi thông báo phạt: ${body.name} ngày ${dayLabel(body.date)}`);
        return json({ ok: true });
      } catch (e) {
        return json({ error: e.message }, 502);
      }
    }
  }

  return json({ error: "Not found" }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env, url);
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendDailyNotification(env));
  },
};
