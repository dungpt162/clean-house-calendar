// Logic lịch dùng chung cho trang chính (app.js), trang quản lý (cms/) và Worker.
//
// Dữ liệu lịch (thành viên + startDate từ schedule.json, cộng với phần động lưu trong KV):
//   overrides: { "YYYY-MM-DD": "Tên" }      người đổ chính của ngày đó (dùng cho hoán đổi ngày)
//   helpers:   { "YYYY-MM-DD": ["Tên"] }    người đổ phụ (đổ chung); lượt kế tiếp của họ bị bỏ qua
//   holidays:  ["YYYY-MM-DD"]               ngày nghỉ: không đổ rác, vòng xoay không tiến (như cuối tuần)
//   members:   thành viên gốc + thành viên thêm sau có `from` (ngày bắt đầu vào vòng xoay, xếp cuối vòng);
//              `to` (nếu có) là ngày cuối cùng còn trong vòng xoay (nghỉ việc)
//   absences:  [{ name, from, to }]         vắng mặt theo khoảng ngày: vòng xoay bỏ qua người đó (không nợ lượt)
//   penalties: [{ date, name, days: ["YYYY-MM-DD", ...] }]
//              người quên đổ rác ngày `date` phải đổ bù + đổ phạt vào các ngày `days`; vòng xoay
//              tạm dừng ở những ngày đó (người phía sau lùi lại), lượt thường của người bị phạt giữ nguyên.
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

// Ngày nghỉ: cuối tuần hoặc ngày được đánh dấu nghỉ trong schedule.holidays.
function isOffDay(date, schedule) {
  return isWeekend(date) || ((schedule && schedule.holidays) || []).includes(toISODate(date));
}

function nextWorkday(date, schedule) {
  const d = new Date(date);
  do {
    d.setDate(d.getDate() + 1);
  } while (isOffDay(d, schedule));
  return d;
}

// Thành viên đã tham gia vòng xoay tại ngày `iso`.
function activeMembers(members, iso) {
  return members.filter((m) => (!m.from || m.from <= iso) && (!m.to || m.to >= iso));
}

function isAbsent(schedule, name, iso) {
  return (schedule.absences || []).some((a) => a.name === name && a.from <= iso && iso <= a.to);
}

// Số ngày làm việc (T2-T6) tính từ một mốc thứ 2 cố định đến `date`.
const MONDAY_REF = new Date(2026, 8, 21);
function workdayIndex(date) {
  const dn = daysBetween(MONDAY_REF, date);
  const weeks = Math.floor(dn / 7);
  const dow = ((dn % 7) + 7) % 7; // 0 = Thứ 2
  return weeks * 5 + Math.min(dow, 5);
}

// Ngày phạt -> mục phạt tương ứng.
function penaltyDayMap(schedule) {
  const map = new Map();
  (schedule.penalties || []).forEach((p) => p.days.forEach((iso) => map.set(iso, p)));
  return map;
}

// `count` ngày làm việc liên tiếp tính từ `start` (gồm cả start nếu là ngày làm việc),
// bỏ qua những ngày đã là ngày phạt của mục khác.
function nextPenaltyDays(start, count, schedule) {
  const taken = penaltyDayMap(schedule);
  const days = [];
  let d = stripTime(start);
  if (isOffDay(d, schedule)) d = nextWorkday(d, schedule);
  while (days.length < count) {
    if (!taken.has(toISODate(d))) days.push(toISODate(d));
    d = nextWorkday(d, schedule);
  }
  return days;
}

// Vòng xoay được dựng dần theo từng ngày làm việc kể từ startDate, vì người đổ phụ
// tạo "điểm" bỏ qua ở lượt kế tiếp của họ và ngày phạt chèn thêm lượt.
// Kết quả được cache theo nội dung lịch.
const rotationCache = { sig: null, byDate: new Map(), ptr: 0, list: null, credits: {}, next: null };

function rotationSignature(schedule) {
  return [
    schedule.startDate,
    schedule.members.map((m) => m.name + "@" + (m.from || "") + "~" + (m.to || "")).join(","),
    JSON.stringify(schedule.absences || []),
    (schedule.holidays || []).join(","),
    JSON.stringify(schedule.helpers || {}),
    JSON.stringify(schedule.penalties || []),
  ].join("|");
}

function extendRotation(schedule, target) {
  const c = rotationCache;
  const sig = rotationSignature(schedule);
  if (c.sig !== sig) {
    c.sig = sig;
    c.byDate = new Map();
    c.ptr = 0;
    c.list = null;
    c.credits = {};
    let d = parseISODate(schedule.startDate);
    while (isOffDay(d, schedule)) d.setDate(d.getDate() + 1);
    c.next = d;
  }
  const helpers = schedule.helpers || {};
  const penaltyDays = penaltyDayMap(schedule);
  while (c.next <= target) {
    const iso = toISODate(c.next);
    const members = activeMembers(schedule.members, iso);
    const n = members.length;
    // Danh sách đổi (có người vào/nghỉ việc): giữ vị trí "người kế tiếp" theo tên.
    if (c.list && c.list.length && n && c.list.map((m) => m.name).join() !== members.map((m) => m.name).join()) {
      const from = c.ptr % c.list.length;
      for (let k = 0; k < c.list.length; k++) {
        const name = c.list[(from + k) % c.list.length].name;
        const idx = members.findIndex((m) => m.name === name);
        if (idx >= 0) { c.ptr = idx; break; }
      }
    }
    c.list = members;
    const penalty = penaltyDays.get(iso);
    // Ngày phạt: người bị phạt đổ, vòng xoay không tiến.
    let main = penalty && members.find((m) => m.name === penalty.name);
    if (!main) {
      // Bỏ qua người còn "điểm" (đã đổ phụ trước đó), mỗi điểm bỏ qua một lượt.
      // Người vắng mặt cũng bị bỏ qua (không nợ lượt).
      for (let tries = 0; tries < n * 100; tries++) {
        const name = members[c.ptr % n].name;
        if ((c.credits[name] || 0) > 0) c.credits[name] -= 1;
        else if (!isAbsent(schedule, name, iso)) break;
        c.ptr += 1;
      }
      main = members[c.ptr % n];
      c.ptr += 1;
    }
    c.byDate.set(iso, main);
    (helpers[iso] || []).forEach((name) => {
      if (name !== main.name) c.credits[name] = (c.credits[name] || 0) + 1;
    });
    c.next = nextWorkday(c.next, schedule);
  }
}

// Người đổ theo vòng xoay, bỏ qua override. null nếu là Thứ 7 / Chủ nhật.
function getRotationMember(date, schedule) {
  if (isOffDay(date, schedule)) return null;
  const day = stripTime(date);
  const start = parseISODate(schedule.startDate);
  if (day < start) {
    const members = activeMembers(schedule.members, toISODate(day));
    const n = members.length;
    const diff = workdayIndex(day) - workdayIndex(start);
    return members[((diff % n) + n) % n];
  }
  extendRotation(schedule, day);
  return rotationCache.byDate.get(toISODate(day));
}

// Người đổ chính thực tế: ưu tiên override (hoán đổi), sau đó tới vòng xoay.
function getMemberForDate(date, schedule) {
  if (isOffDay(date, schedule)) return null;
  const overrideName = (schedule.overrides || {})[toISODate(date)];
  if (overrideName) {
    const m = schedule.members.find((x) => x.name === overrideName);
    if (m) return m;
  }
  return getRotationMember(date, schedule);
}

// Những người đổ phụ trong ngày (không gồm người chính).
function getHelpersForDate(date, schedule) {
  if (isOffDay(date, schedule)) return [];
  const main = getMemberForDate(date, schedule);
  const names = (schedule.helpers || {})[toISODate(date)] || [];
  return names
    .map((name) => schedule.members.find((m) => m.name === name))
    .filter((m) => m && m !== main);
}

// Mục phạt nếu người đổ chính của ngày đang đổ phạt (không bị hoán đổi đi), ngược lại null.
function getPenaltyForDate(date, schedule) {
  const p = penaltyDayMap(schedule).get(toISODate(date));
  const main = getMemberForDate(date, schedule);
  return p && main && main.name === p.name ? p : null;
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
    getPenaltyForDate, nextPenaltyDays, nextWorkday, isWeekend, isOffDay, toISODate, parseISODate,
  };
}
