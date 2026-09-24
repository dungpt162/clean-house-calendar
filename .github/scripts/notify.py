"""Tạo payload.json cho thông báo Discord từ schedule.json.

Không tạo payload.json nếu hôm nay là Thứ 7 / Chủ nhật (không đổ rác).
"""
import json
from datetime import date, datetime, timedelta, timezone

MONDAY_REF = date(2026, 9, 21)

with open("schedule.json", encoding="utf-8") as f:
    schedule = json.load(f)

members = schedule["members"]
overrides = schedule.get("overrides", {})
start = date.fromisoformat(schedule["startDate"])


def workday_index(d):
    dn = (d - MONDAY_REF).days
    return (dn // 7) * 5 + min(dn % 7, 5)


def member_for(d):
    """Trả về (thành viên, có_override) cho ngày làm việc d."""
    name = overrides.get(d.isoformat())
    if name:
        for m in members:
            if m["name"] == name:
                return m, True
    n = len(members)
    return members[(workday_index(d) - workday_index(start)) % n], False


def next_workday(d):
    d += timedelta(days=1)
    while d.weekday() >= 5:
        d += timedelta(days=1)
    return d


VN_TZ = timezone(timedelta(hours=7))  # Asia/Ho_Chi_Minh, không có DST
today = datetime.now(VN_TZ).date()
if today.weekday() >= 5:
    print("Weekend - no trash duty, skipping.")
    raise SystemExit(0)

nxt = next_workday(today)


def line(prefix, d):
    m, overridden = member_for(d)
    suffix = " (đổ hộ)" if overridden else ""
    return f"{prefix}: <@{m['discordId']}> (**{m['name']}**){suffix}"


content = (
    f"🗑️ **Lịch đổ rác ngày {today.strftime('%d/%m/%Y')}**\n\n"
    + line("Hôm nay là phiên đổ rác của", today) + "\n"
    + line("Ngày làm việc kế tiếp", nxt)
)

with open("payload.json", "w", encoding="utf-8") as f:
    json.dump({"content": content}, f, ensure_ascii=False)
print(content)
