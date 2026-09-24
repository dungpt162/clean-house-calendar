// Logic lịch dùng chung cho trang chính (app.js) và trang quản lý (cms/).
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

// Số ngày làm việc (T2-T6) tính từ một mốc thứ 2 cố định đến `date`.
const MONDAY_REF = new Date(2026, 8, 21);
function workdayIndex(date) {
  const dn = daysBetween(MONDAY_REF, date);
  const weeks = Math.floor(dn / 7);
  const dow = ((dn % 7) + 7) % 7; // 0 = Thứ 2
  return weeks * 5 + Math.min(dow, 5);
}

// Người đổ theo vòng xoay, bỏ qua override. null nếu là Thứ 7 / Chủ nhật.
function getRotationMember(date, schedule) {
  if (isWeekend(date)) return null;
  const diff = workdayIndex(date) - workdayIndex(parseISODate(schedule.startDate));
  const n = schedule.members.length;
  return schedule.members[((diff % n) + n) % n];
}

// Người đổ thực tế: ưu tiên override (nhờ đổ hộ), sau đó tới vòng xoay.
function getMemberForDate(date, schedule) {
  if (isWeekend(date)) return null;
  const overrideName = (schedule.overrides || {})[toISODate(date)];
  if (overrideName) {
    const m = schedule.members.find((x) => x.name === overrideName);
    if (m) return m;
  }
  return getRotationMember(date, schedule);
}

function nextWorkday(date) {
  const d = new Date(date);
  do {
    d.setDate(d.getDate() + 1);
  } while (isWeekend(d));
  return d;
}
