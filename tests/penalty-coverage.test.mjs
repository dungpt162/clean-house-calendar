import test from "node:test";
import assert from "node:assert/strict";
import core from "../public/core.js";
import worker from "../worker.js";
import { buildMessage, buildPenaltyMessage } from "../notify-message.mjs";

const base = {
  startDate: "2026-11-23",
  members: ["A", "B", "C"].map((name) => ({ name, color: "#000000", discordId: "1234567890" })),
};

function state(penalties = [], extra = {}) {
  return {
    overrides: {}, helpers: {}, penalties, holidays: [],
    extraMembers: [], memberMeta: {}, absences: [], ...extra,
  };
}

function schedule(s) {
  return { ...base, ...s, members: base.members };
}

const date = (iso) => core.parseISODate(iso);
const who = (iso, s) => core.getMemberForDate(date(iso), s)?.name;

test("coverage moves B's next turn into A's vacant date without assigning A to B's turn", () => {
  const penalty = { date: "2026-11-23", name: "A", coveredBy: "B", days: ["2026-11-24", "2026-11-25"] };
  const s = schedule(state([penalty]));
  assert.deepEqual([23, 24, 25, 26, 27, 30].map((day) => who(`2026-11-${day}`, s)),
    ["B", "A", "A", "C", "A", "B"]);
  assert.equal(core.getPenaltyForDate(date("2026-11-24"), s), penalty);
  assert.equal(core.getPenaltyForDate(date("2026-11-23"), s), null);
  assert.match(buildPenaltyMessage(s, penalty), /B.*chuyển lượt đổ của mình lên ngày này để đổ hộ/);

  s.helpers["2026-11-23"] = ["B"];
  assert.equal(who("2026-11-26", s), "C");
  s.helpers = {};
  s.penalties = [];
  assert.deepEqual([23, 24, 25].map((day) => who(`2026-11-${day}`, s)), ["A", "B", "C"]);
});

test("old penalties remain valid and weekend delays the two consecutive workdays", () => {
  const s = schedule(state([{ date: "2026-11-27", name: "B", days: ["2026-11-30", "2026-12-01"] }]));
  assert.equal(who("2026-11-27", s), undefined);
  assert.equal(core.getRotationMember(date("2026-11-27"), s).name, "B");
  assert.equal(who("2026-11-30", s), "B");
  assert.equal(who("2026-12-01", s), "B");
  assert.equal(core.getMemberForDate(date("2026-11-28"), s), null);
});

test("without coverage the missed day stays vacant and the reminder remains readable", () => {
  const penalty = { date: "2026-11-23", name: "A", days: ["2026-11-24", "2026-11-25"] };
  const s = schedule(state([penalty]));
  assert.equal(who("2026-11-23", s), undefined);
  assert.deepEqual(core.getMembersForDate(date("2026-11-23"), s), []);
  assert.deepEqual([24, 25, 26].map((day) => who(`2026-11-${day}`, s)), ["A", "A", "B"]);
  assert.match(buildMessage(s, date("2026-11-23")), /chưa ai đổ hộ/);
  assert.match(buildPenaltyMessage(s, penalty), /không có ai đổ hộ/);
});

test("a blocked penalty day moves the full two-day window", () => {
  const s = schedule(state([{ date: "2026-11-23", name: "A", days: ["2026-11-25"] }]));
  assert.deepEqual(core.nextPenaltyDays(date("2026-11-24"), 2, s), ["2026-11-26", "2026-11-27"]);
});

test("API stores coverage and rejects conflicting or inactive covering members", async () => {
  const kv = new Map();
  const env = {
    ADMIN_PASSWORD: "test-password",
    ASSETS: { fetch: async () => Response.json(base) },
    STATE: {
      get: async (key, type) => type === "json" ? JSON.parse(kv.get(key) || "null") : kv.get(key),
      put: async (key, value) => kv.set(key, value),
      delete: async (key) => kv.delete(key),
    },
  };
  const call = (path, method = "GET", body, cookie) => worker.fetch(new Request(`https://example.com${path}`, {
    method, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: body && JSON.stringify(body),
  }), env);
  const login = await call("/api/login", "POST", { password: env.ADMIN_PASSWORD });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("Set-Cookie").split(";")[0];
  const penalty = { date: "2026-11-23", name: "A", coveredBy: "B", days: ["2026-11-24", "2026-11-25"] };
  const put = (s) => call("/api/schedule", "PUT", {
    overrides: s.overrides, helpers: s.helpers, penalties: s.penalties, holidays: s.holidays,
    members: s.extraMembers, memberMeta: s.memberMeta, absences: s.absences,
  }, cookie);

  let res = await put(state([penalty]));
  assert.equal(res.status, 200);
  assert.equal(who("2026-11-23", await res.json()), "B");

  res = await put(state([penalty], { overrides: { "2026-11-23": "C" } }));
  assert.equal(res.status, 400);
  res = await put(state([{ ...penalty, coveredBy: "A" }]));
  assert.equal(res.status, 400);
  res = await put(state([penalty], { absences: [{ name: "B", from: "2026-11-23", to: "2026-11-23" }] }));
  assert.equal(res.status, 400);
  res = await put(state([{ ...penalty, name: "C" }]));
  assert.equal(res.status, 400);
  res = await put(state([{ ...penalty, days: ["2026-11-24", "2026-11-26"] }]));
  assert.equal(res.status, 400);

  const withoutCover = { date: penalty.date, name: penalty.name, days: penalty.days };
  res = await put(state([withoutCover]));
  assert.equal(res.status, 200);
  assert.equal(who("2026-11-23", await res.json()), undefined);

  res = await put(state([]));
  assert.equal(res.status, 200);
  assert.equal(who("2026-11-23", await res.json()), "A");
});
