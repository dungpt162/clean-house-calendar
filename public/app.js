// Dữ liệu lịch lấy từ /api/schedule (thành viên trong schedule.json, hoán đổi/đổ chung trong KV),
// logic tính lịch nằm trong core.js. Chỉnh lịch qua trang /cms.
let schedule = { startDate: "2026-09-23", members: [], overrides: {} };
const membersFor = (date) => getMembersForDate(date, schedule);
const namesOf = (members) => members.map((m) => m.name).join(" + ");

const WEEKDAY_LABELS = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];
const MONTH_FMT = new Intl.DateTimeFormat("vi-VN", { month: "long", year: "numeric" });
const LONG_DATE_FMT = new Intl.DateTimeFormat("vi-VN", { weekday: "long", day: "2-digit", month: "2-digit" });
const SHORT_DATE_FMT = new Intl.DateTimeFormat("vi-VN", { weekday: "short", day: "2-digit", month: "2-digit" });

let viewYear, viewMonth; // tháng đang xem trên lịch (0-based month)

function renderToday() {
  const today = stripTime(new Date());
  const tomorrow = nextWorkday(today);
  const isTomorrow = daysBetween(today, tomorrow) === 1;

  const todayMembers = membersFor(today);
  const tomorrowMembers = membersFor(tomorrow);

  document.getElementById("todayDate").textContent = LONG_DATE_FMT.format(today);
  document.getElementById("todayPerson").textContent = todayMembers.length ? namesOf(todayMembers) : "Nghỉ (không đổ rác)";
  document.getElementById("todayPerson").style.color = todayMembers.length ? todayMembers[0].color : "";

  document.getElementById("tomorrowLabel").textContent = isTomorrow ? "Ngày mai" : "Ngày đổ rác kế tiếp";
  document.getElementById("tomorrowDate").textContent = LONG_DATE_FMT.format(tomorrow);
  document.getElementById("tomorrowPerson").textContent = namesOf(tomorrowMembers);
  document.getElementById("tomorrowPerson").style.color = tomorrowMembers[0].color;
}

function renderUpcoming() {
  const list = document.getElementById("upcomingList");
  list.innerHTML = "";
  const today = stripTime(new Date());
  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    const members = membersFor(d);
    const li = document.createElement("li");

    const dateSpan = document.createElement("span");
    dateSpan.className = "u-date";
    dateSpan.textContent = i === 0 ? "Hôm nay" : i === 1 ? "Ngày mai" : SHORT_DATE_FMT.format(d);

    const personSpan = document.createElement("span");
    personSpan.className = "u-person";
    if (members.length) {
      members.forEach((member, idx) => {
        if (idx > 0) personSpan.appendChild(document.createTextNode(" + "));
        const dot = document.createElement("span");
        dot.className = "dot";
        dot.style.background = member.color;
        personSpan.appendChild(dot);
        personSpan.appendChild(document.createTextNode(member.name));
      });
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
  schedule.members.forEach((m) => {
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
    const members = membersFor(date);
    const member = members[0];

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
      person.textContent = namesOf(members);
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

// Lấy lịch từ API (gồm dữ liệu hoán đổi/đổ chung); dự phòng schedule.json khi chạy cục bộ.
async function loadSchedule() {
  for (const url of ["/api/schedule", "schedule.json"]) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (res.ok) return await res.json();
    } catch (e) { /* thử nguồn tiếp theo */ }
  }
  throw new Error("Không tải được lịch");
}

async function init() {
  try {
    schedule = await loadSchedule();
  } catch (e) {
    document.querySelector(".subtitle").textContent = "Không tải được lịch";
    return;
  }

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
