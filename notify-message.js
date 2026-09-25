// Dựng nội dung thông báo Discord. Dùng bởi worker.js (cron trên Cloudflare).
import core from "./core.js";

const { getMemberForDate, getRotationMember, nextWorkday, isWeekend, toISODate } = core;

const VN_OFFSET_MS = 7 * 3600 * 1000; // Asia/Ho_Chi_Minh, không có DST

// Ngày hiện tại ở Việt Nam, dạng Date "giờ địa phương" (Worker chạy ở UTC).
export function vietnamToday(nowMs = Date.now()) {
  const vn = new Date(nowMs + VN_OFFSET_MS);
  return new Date(vn.getUTCFullYear(), vn.getUTCMonth(), vn.getUTCDate());
}

function line(prefix, date, schedule) {
  const m = getMemberForDate(date, schedule);
  const overridden = m.name !== getRotationMember(date, schedule).name;
  return `${prefix}: <@${m.discordId}> (**${m.name}**)${overridden ? " (đổ hộ)" : ""}`;
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
