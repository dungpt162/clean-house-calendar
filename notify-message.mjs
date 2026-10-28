// Dựng nội dung thông báo Discord. Dùng bởi worker.js (cron trên Cloudflare)
// và .github/scripts/notify.mjs (chạy tay từ GitHub Actions).
import core from "./public/core.js";

const { getMembersForDate, getRotationMember, getPenaltyForDate, nextWorkday, isWeekend, parseISODate } = core;
const WEEKDAYS = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];

const VN_OFFSET_MS = 7 * 3600 * 1000; // Asia/Ho_Chi_Minh, không có DST

// Ngày hiện tại ở Việt Nam, dạng Date "giờ địa phương" (Worker và runner chạy ở UTC).
export function vietnamToday(nowMs = Date.now()) {
  const vn = new Date(nowMs + VN_OFFSET_MS);
  return new Date(vn.getUTCFullYear(), vn.getUTCMonth(), vn.getUTCDate());
}

function line(prefix, date, schedule) {
  const members = getMembersForDate(date, schedule);
  const swapped = members[0].name !== getRotationMember(date, schedule).name;
  const penalty = getPenaltyForDate(date, schedule);
  const who = members.map((m) => `<@${m.discordId}> (**${m.name}**)`).join(" + ");
  return `${prefix}: ${who}${swapped ? " (đổi lịch)" : ""}${penalty ? " (đổ phạt)" : ""}`;
}

function shortDate(d) {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${WEEKDAYS[d.getDay()]} ${dd}/${mm}`;
}

// Thông báo khi ghi phạt một người quên đổ rác.
export function buildPenaltyMessage(schedule, penalty) {
  const m = schedule.members.find((x) => x.name === penalty.name);
  const days = penalty.days.map((iso) => `**${shortDate(parseISODate(iso))}**`).join(", ");
  return (
    `🚨 **Phạt quên đổ rác**\n\n` +
    `<@${m.discordId}> (**${m.name}**) đã quên đổ rác ngày ${shortDate(parseISODate(penalty.date))}.\n` +
    `Hình phạt: đổ bù + đổ phạt ${penalty.days.length} ngày liền: ${days}.\n` +
    `Lịch của những người phía sau được lùi lại tương ứng.`
  );
}

// Trả về null nếu hôm nay là Thứ 7 / Chủ nhật.
export function buildMessage(schedule, today) {
  if (isWeekend(today)) return null;
  const dd = String(today.getDate()).padStart(2, "0");
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  return (
    `🗑️ **Lịch đổ rác ngày ${dd}/${mm}/${today.getFullYear()}**\n\n` +
    line("Hôm nay là phiên đổ rác của", today, schedule) + "\n" +
    line("Ngày làm việc kế tiếp", nextWorkday(today), schedule)
  );
}
