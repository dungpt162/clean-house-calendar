// ==== CẤU HÌNH ====
// Danh sách thành viên theo thứ tự đổ rác (lặp lại vòng tròn).
const MEMBERS = [
  { name: "Tiến Dũng Dev", color: "#2563eb" },
  { name: "Như Quỳnh",     color: "#db2777" },
  { name: "Thành Luân",    color: "#16a34a" },
  { name: "Tiến Dũng GD",  color: "#ea580c" },
  { name: "Tuyết Nhung",   color: "#9333ea" },
  { name: "Trung Lê",      color: "#0891b2" },
  { name: "Mạnh Cường",    color: "#ca8a04" },
  { name: "Nam Dev",       color: "#dc2626" },
  { name: "Hachi",         color: "#4d7c0f" },
  { name: "Thảo",          color: "#0f766e" },
];

// Ngày mà người đầu tiên (MEMBERS[0]) bắt đầu phiên đổ rác.
// Đổi ngày này nếu muốn dịch chuyển toàn bộ lịch.
const START_DATE = new Date(2026, 8, 23); // 23/09/2026 (tháng tính từ 0)

// ==== LOGIC ====
function stripTime(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function daysBetween(a, b) {
  const MS_PER_DAY = 86400000;
  return Math.round((stripTime(b) - stripTime(a)) / MS_PER_DAY);
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

// Trả về null nếu là Thứ 7 / Chủ nhật (không đổ rác).
function getMemberForDate(date) {
  if (isWeekend(date)) return null;
  const diff = workdayIndex(date) - workdayIndex(START_DATE);
  const n = MEMBERS.length;
  const idx = ((diff % n) + n) % n;
  return MEMBERS[idx];
}

function nextWorkday(date) {
  const d = new Date(date);
  do {
    d.setDate(d.getDate() + 1);
  } while (isWeekend(d));
  return d;
}

const WEEKDAY_LABELS = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];
const MONTH_FMT = new Intl.DateTimeFormat("vi-VN", { month: "long", year: "numeric" });
const LONG_DATE_FMT = new Intl.DateTimeFormat("vi-VN", { weekday: "long", day: "2-digit", month: "2-digit" });
const SHORT_DATE_FMT = new Intl.DateTimeFormat("vi-VN", { weekday: "short", day: "2-digit", month: "2-digit" });

let viewYear, viewMonth; // tháng đang xem trên lịch (0-based month)

function renderToday() {
  const today = stripTime(new Date());
  const tomorrow = nextWorkday(today);
  const isTomorrow = daysBetween(today, tomorrow) === 1;

  const todayMember = getMemberForDate(today);
  const tomorrowMember = getMemberForDate(tomorrow);

  document.getElementById("todayDate").textContent = LONG_DATE_FMT.format(today);
  document.getElementById("todayPerson").textContent = todayMember ? todayMember.name : "Nghỉ (không đổ rác)";
  document.getElementById("todayPerson").style.color = todayMember ? todayMember.color : "";

  document.getElementById("tomorrowLabel").textContent = isTomorrow ? "Ngày mai" : "Ngày đổ rác kế tiếp";
  document.getElementById("tomorrowDate").textContent = LONG_DATE_FMT.format(tomorrow);
  document.getElementById("tomorrowPerson").textContent = tomorrowMember.name;
  document.getElementById("tomorrowPerson").style.color = tomorrowMember.color;
}

function renderUpcoming() {
  const list = document.getElementById("upcomingList");
  list.innerHTML = "";
  const today = stripTime(new Date());
  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    const member = getMemberForDate(d);
    const li = document.createElement("li");

    const dateSpan = document.createElement("span");
    dateSpan.className = "u-date";
    dateSpan.textContent = i === 0 ? "Hôm nay" : i === 1 ? "Ngày mai" : SHORT_DATE_FMT.format(d);

    const personSpan = document.createElement("span");
    personSpan.className = "u-person";
    if (member) {
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.style.background = member.color;
      personSpan.appendChild(dot);
      personSpan.appendChild(document.createTextNode(member.name));
    } else {
      personSpan.textContent = "Nghỉ";
      li.style.opacity = "0.5";
    }

    li.appendChild(dateSpan);
    li.appendChild(personSpan);
    list.appendChild(li);
  }
}

function renderLegend() {
  const list = document.getElementById("legendList");
  list.innerHTML = "";
  MEMBERS.forEach((m) => {
    const li = document.createElement("li");
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = m.color;
    li.appendChild(dot);
    li.appendChild(document.createTextNode(m.name));
    list.appendChild(li);
  });
}

function renderCalendar() {
  document.getElementById("monthLabel").textContent =
    MONTH_FMT.format(new Date(viewYear, viewMonth, 1));

  const grid = document.getElementById("calendarGrid");
  grid.innerHTML = "";

  const firstOfMonth = new Date(viewYear, viewMonth, 1);
  // Chuyển Chủ nhật (0) thành cuối tuần (6) để tuần bắt đầu từ Thứ 2.
  const leadingBlanks = (firstOfMonth.getDay() + 6) % 7;
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const today = stripTime(new Date());

  for (let i = 0; i < leadingBlanks; i++) {
    const blank = document.createElement("div");
    blank.className = "day-cell empty";
    grid.appendChild(blank);
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const date = new Date(viewYear, viewMonth, day);
    const member = getMemberForDate(date);

    const cell = document.createElement("div");
    cell.className = "day-cell";
    if (member) {
      cell.style.background = member.color + "22";
      cell.style.color = member.color;
    } else {
      cell.style.opacity = "0.45";
    }
    if (daysBetween(today, date) === 0) {
      cell.classList.add("is-today");
    }

    const num = document.createElement("span");
    num.className = "day-num";
    num.textContent = String(day);
    cell.appendChild(num);

    if (member) {
      const person = document.createElement("span");
      person.className = "day-person";
      person.textContent = member.name;
      cell.appendChild(person);
    }
    grid.appendChild(cell);
  }
}

function renderAll() {
  renderToday();
  renderUpcoming();
  renderLegend();
  renderCalendar();
}

function init() {
  const today = new Date();
  viewYear = today.getFullYear();
  viewMonth = today.getMonth();

  document.getElementById("prevMonth").addEventListener("click", () => {
    viewMonth -= 1;
    if (viewMonth < 0) { viewMonth = 11; viewYear -= 1; }
    renderCalendar();
  });

  document.getElementById("nextMonth").addEventListener("click", () => {
    viewMonth += 1;
    if (viewMonth > 11) { viewMonth = 0; viewYear += 1; }
    renderCalendar();
  });

  document.getElementById("todayBtn").addEventListener("click", () => {
    const t = new Date();
    viewYear = t.getFullYear();
    viewMonth = t.getMonth();
    renderCalendar();
  });

  renderAll();
}

document.addEventListener("DOMContentLoaded", init);
