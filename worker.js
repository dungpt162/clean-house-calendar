// Cloudflare Worker:
//  - phục vụ web tĩnh qua ASSETS
//  - API quản lý lịch (/api/*) có đăng nhập bằng mật khẩu, dữ liệu động lưu trong KV (STATE)
//  - Cron Trigger (wrangler.jsonc) gửi thông báo đổ rác lên Discord
//
// Secrets cần đặt trong Cloudflare: ADMIN_PASSWORD, DISCORD_WEBHOOK_URL.
// schedule.json trong repo giữ thành viên + ngày bắt đầu; KV giữ overrides + helpers.
import { buildMessage, vietnamToday } from "./notify-message.mjs";

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
  return { overrides: (raw && raw.overrides) || {}, helpers: (raw && raw.helpers) || {} };
}

async function getSchedule(env) {
  const [base, state] = await Promise.all([loadBase(env), loadState(env)]);
  return { ...base, overrides: state.overrides, helpers: state.helpers };
}

function validateState(body, members) {
  const names = new Set(members.map((m) => m.name));
  const { overrides, helpers } = body || {};
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) return "overrides không hợp lệ";
  if (!helpers || typeof helpers !== "object" || Array.isArray(helpers)) return "helpers không hợp lệ";
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

// ---------- Thông báo Discord ----------
async function sendDailyNotification(env) {
  if (!env.DISCORD_WEBHOOK_URL) throw new Error("Thiếu secret DISCORD_WEBHOOK_URL");
  const content = buildMessage(await getSchedule(env), vietnamToday());
  if (!content) {
    console.log("Cuối tuần - không đổ rác, bỏ qua.");
    return null;
  }
  const post = await fetch(env.DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!post.ok) throw new Error("Discord trả về HTTP " + post.status + ": " + (await post.text()));
  console.log("Đã gửi thông báo:\n" + content);
  return content;
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
    return json({ ok: true }, 200, { "Set-Cookie": cookie(await makeSession(env), SESSION_TTL_SEC) });
  }

  if (method === "POST" && pathname === "/api/logout") {
    return json({ ok: true }, 200, { "Set-Cookie": cookie("", 0) });
  }

  if (pathname === "/api/schedule" || pathname === "/api/notify") {
    if (!(await isAuthed(request, env))) return json({ error: "Chưa đăng nhập" }, 401);

    if (method === "PUT" && pathname === "/api/schedule") {
      let body;
      try { body = await request.json(); } catch (e) { return json({ error: "JSON không hợp lệ" }, 400); }
      const base = await loadBase(env);
      const err = validateState(body, base.members);
      if (err) return json({ error: err }, 400);
      await env.STATE.put("state", JSON.stringify({ overrides: body.overrides, helpers: body.helpers }));
      return json(await getSchedule(env));
    }

    if (method === "POST" && pathname === "/api/notify") {
      try {
        const sent = await sendDailyNotification(env);
        return json({ ok: true, sent: !!sent });
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
