// Logic lịch dùng chung cho trang chính (app.js), trang quản lý (cms/) và Worker.
//
// Dữ liệu lịch (thành viên + startDate từ schedule.json, cộng với phần động lưu trong KV):
//   overrides: { "YYYY-MM-DD": "Tên" }      người đổ chính của ngày đó (dùng cho hoán đổi ngày)
//   helpers:   { "YYYY-MM-DD": ["Tên"] }    người đổ phụ (đổ chung); lượt kế tiếp của họ bị bỏ qua
function stripTime(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function daysBetween(a, b) {
  const MS_PER_DAY = 86400000;
  return Math.round((stripTime(b) - stripTime(a)) / MS_PER_DAY);
}

function parseISODate(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function toISODate(d) {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function isWeekend(date) {
  const dow = date.getDay();
  return dow === 0 || dow === 6;
}

function nextWorkday(date) {
  const d = new Date(date);
  do {
    d.setDate(d.getDate() + 1);
  } while (isWeekend(d));
  return d;
}

// Số ngày làm việc (T2-T6) tính từ một mốc thứ 2 cố định đến `date`.
const MONDAY_REF = new Date(2026, 8, 21);
function workdayIndex(date) {
  const dn = daysBetween(MONDAY_REF, date);
  const weeks = Math.floor(dn / 7);
  const dow = ((dn % 7) + 7) % 7; // 0 = Thứ 2
  return weeks * 5 + Math.min(dow, 5);
}

// Vòng xoay được dựng dần theo từng ngày làm việc kể từ startDate, vì người đổ phụ
// tạo "điểm" bỏ qua ở lượt kế tiếp của họ. Kết quả được cache theo nội dung lịch.
const rotationCache = { sig: null, byDate: new Map(), ptr: 0, credits: {}, next: null };

function rotationSignature(schedule) {
  return [
    schedule.startDate,
    schedule.members.map((m) => m.name).join(","),
    JSON.stringify(schedule.helpers || {}),
  ].join("|");
}

function extendRotation(schedule, target) {
  const c = rotationCache;
  const sig = rotationSignature(schedule);
  if (c.sig !== sig) {
    c.sig = sig;
    c.byDate = new Map();
    c.ptr = 0;
    c.credits = {};
    let d = parseISODate(schedule.startDate);
    while (isWeekend(d)) d.setDate(d.getDate() + 1);
    c.next = d;
  }
  const members = schedule.members;
  const n = members.length;
  const helpers = schedule.helpers || {};
  while (c.next <= target) {
    // Bỏ qua người còn "điểm" (đã đổ phụ trước đó), mỗi điểm bỏ qua một lượt.
    while ((c.credits[members[c.ptr % n].name] || 0) > 0) {
      c.credits[members[c.ptr % n].name] -= 1;
      c.ptr += 1;
    }
    const main = members[c.ptr % n];
    const iso = toISODate(c.next);
    c.byDate.set(iso, main);
    c.ptr += 1;
    (helpers[iso] || []).forEach((name) => {
      if (name !== main.name) c.credits[name] = (c.credits[name] || 0) + 1;
    });
    c.next = nextWorkday(c.next);
  }
}

// Người đổ theo vòng xoay, bỏ qua override. null nếu là Thứ 7 / Chủ nhật.
function getRotationMember(date, schedule) {
  if (isWeekend(date)) return null;
  const day = stripTime(date);
  const start = parseISODate(schedule.startDate);
  if (day < start) {
    const n = schedule.members.length;
    const diff = workdayIndex(day) - workdayIndex(start);
    return schedule.members[((diff % n) + n) % n];
  }
  extendRotation(schedule, day);
  return rotationCache.byDate.get(toISODate(day));
}

// Người đổ chính thực tế: ưu tiên override (hoán đổi), sau đó tới vòng xoay.
function getMemberForDate(date, schedule) {
  if (isWeekend(date)) return null;
  const overrideName = (schedule.overrides || {})[toISODate(date)];
  if (overrideName) {
    const m = schedule.members.find((x) => x.name === overrideName);
    if (m) return m;
  }
  return getRotationMember(date, schedule);
}

// Những người đổ phụ trong ngày (không gồm người chính).
function getHelpersForDate(date, schedule) {
  if (isWeekend(date)) return [];
  const main = getMemberForDate(date, schedule);
  const names = (schedule.helpers || {})[toISODate(date)] || [];
  return names
    .map((name) => schedule.members.find((m) => m.name === name))
    .filter((m) => m && m !== main);
}

// Tất cả người đổ trong ngày: người chính trước, rồi tới người phụ. [] nếu cuối tuần.
function getMembersForDate(date, schedule) {
  const main = getMemberForDate(date, schedule);
  if (!main) return [];
  return [main, ...getHelpersForDate(date, schedule)];
}

// Cho phép Worker (Node/bundler) import file này; trình duyệt bỏ qua khối này.
if (typeof module !== "undefined") {
  module.exports = {
    getMemberForDate, getMembersForDate, getHelpersForDate, getRotationMember,
    nextWorkday, isWeekend, toISODate, parseISODate,
  };
}
