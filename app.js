const STORAGE_KEY = "moonmood:journal:v1";
const PIN_HASH = "e72631d61de3f84f18dc081573e57313b236a2cbb4ade3e453407f0de19f99a0";
const groups = [
  {
    key: "symptoms",
    elementId: "symptom-options",
    label: "症状",
    options: ["痛经", "胸痛", "右腋下痛", "左腋下痛", "三角区右侧痛", "胀气", "胃不适", "腹泻", "夜间醒来", "口腔溃疡", "过敏性鼻炎"],
  },
  {
    key: "medicines",
    elementId: "medicine-options",
    label: "用药",
    options: ["散利痛", "eve", "布洛芬", "鼻炎药", "镁片1颗", "镁片2颗", "鱼油"],
  },
];

const get = (id) => document.getElementById(id);

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const lockView = get("lock-view");
const appView = get("app-view");
const dashboard = get("dashboard");
const editor = get("editor");
const pin = get("pin");
const pinError = get("pin-error");
const pinSlots = [...document.querySelectorAll(".pin-slots i")];
const entryDate = get("entry-date");
const entryError = get("entry-error");
const dashboardStatus = get("dashboard-status");
const weekdays = new Intl.DateTimeFormat("zh-CN", { weekday: "short" });
let visibleMonth = new Date();
let journal = emptyJournal();
let editing = null;

function dateKey(date = new Date()) {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function calendarDate(key) {
  return new Date(`${key}T12:00:00`);
}

function emptyJournal() {
  return { entries: {}, custom: { symptoms: [], medicines: [] } };
}

function readJournal() {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === null) return emptyJournal();
  const parsed = JSON.parse(stored);
  if (!parsed?.entries || !groups.every(({ key }) => Array.isArray(parsed.custom?.[key]))) {
    throw new Error("Invalid journal");
  }
  return parsed;
}

function refreshJournal() {
  try {
    journal = readJournal();
    dashboardStatus.textContent = "";
  } catch {
    dashboardStatus.textContent = "暂时无法读取记录，请检查浏览器的存储设置。";
  }
}

function updatePinSlots() {
  pin.value = pin.value.replace(/\D/g, "").slice(0, 4);
  pinSlots.forEach((slot, index) => {
    slot.classList.toggle("filled", index < pin.value.length);
    slot.classList.toggle("next", index === pin.value.length);
  });
}

pin.addEventListener("input", () => {
  pinError.textContent = "";
  pin.removeAttribute("aria-invalid");
  updatePinSlots();
});
updatePinSlots();

get("unlock-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const entered = pin.value;
  if (entered.length !== 4) {
    pinError.textContent = "请输入四位数字。";
    pin.focus();
    return;
  }

  let hash;
  try {
    const bytes = new TextEncoder().encode(`moonmood:v1:${entered}`);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    pinError.textContent = "请通过 HTTPS 或本地预览打开此网页。";
    return;
  }

  if (pin.value !== entered || lockView.hidden) return;
  pin.value = "";
  updatePinSlots();

  if (hash !== PIN_HASH) {
    pin.setAttribute("aria-invalid", "true");
    pinError.textContent = "密码不正确，请再试一次。";
    pin.parentElement.classList.remove("invalid");
    requestAnimationFrame(() => pin.parentElement.classList.add("invalid"));
    pin.focus();
    return;
  }

  refreshJournal();
  visibleMonth = new Date();
  showDashboard();
  lockView.hidden = true;
  appView.hidden = false;
  dashboard.querySelector("h1").focus();
});

get("lock-button").addEventListener("click", () => {
  appView.hidden = true;
  lockView.hidden = false;
  journal = emptyJournal();
  editing = null;
  get("record-list").replaceChildren();
  get("calendar-days").replaceChildren();
  get("record-form").reset();
  groups.forEach(({ elementId }) => get(elementId).replaceChildren());
  pin.focus();
});

function renderCalendar() {
  const today = dateKey();
  const year = visibleMonth.getFullYear();
  const month = visibleMonth.getMonth();
  const first = new Date(year, month, 1, 12);
  first.setDate(1 - (first.getDay() + 6) % 7);
  const days = document.createDocumentFragment();

  get("today-button").textContent = today.replaceAll("-", ".");
  get("month-title").textContent = `${year} / ${String(month + 1).padStart(2, "0")}`;

  for (let offset = 0; offset < 42; offset += 1) {
    const date = new Date(first);
    date.setDate(first.getDate() + offset);
    const key = dateKey(date);
    const entry = journal.entries[key];
    const button = element("button", "day", date.getDate());
    button.type = "button";
    button.classList.toggle("adjacent", date.getMonth() !== month);
    button.classList.toggle("period", Boolean(entry?.flow));
    button.classList.toggle("today", key === today);
    button.classList.toggle("logged", Boolean(entry));
    if (key === today) button.setAttribute("aria-current", "date");
    const state = entry?.flow ? `经期，${entry.flow} 滴` : entry ? "有记录" : "添加记录";
    button.setAttribute("aria-label", `${key}，${state}`);
    button.addEventListener("click", () => openEditor(key));
    days.append(button);
  }

  get("calendar-days").replaceChildren(days);
}

function renderRecord(key, entry) {
  const card = element("article", "record-card");
  const head = element("div", "record-head");
  const button = element("button", "record-date pixel");
  button.type = "button";
  button.setAttribute("aria-label", `编辑 ${key} 的记录`);
  button.append(element("time", "", key.replaceAll("-", ".")), element("span", "weekday", weekdays.format(calendarDate(key))));
  button.querySelector("time").dateTime = key;
  const editMark = element("span", "edit-mark", "✎");
  editMark.setAttribute("aria-hidden", "true");
  button.append(editMark);
  button.addEventListener("click", () => openEditor(key));

  const flow = element("div", "record-flow");
  for (let level = 1; level <= 4; level += 1) {
    const drop = element("i", level <= entry.flow ? "drop" : "drop off");
    drop.setAttribute("aria-hidden", "true");
    flow.append(drop);
  }
  flow.append(element("span", "", `${entry.flow} 滴`));
  head.append(button, flow);

  const details = element("dl");
  details.style.margin = "0";
  for (const { key: group, label } of groups) {
    const row = element("div", "record-detail");
    row.append(element("dt", "", label), element("dd", "", entry[group].join("、") || "—"));
    details.append(row);
  }
  card.append(head, details);
  return card;
}

function renderDashboard() {
  renderCalendar();
  const month = dateKey(visibleMonth).slice(0, 7);
  const entries = Object.entries(journal.entries)
    .filter(([key]) => key.startsWith(month))
    .sort(([first], [second]) => second.localeCompare(first));
  get("record-count").textContent = `${entries.length} 条记录`;
  get("record-list").replaceChildren(
    ...(entries.length
      ? entries.map(([key, entry]) => renderRecord(key, entry))
      : [get("empty-records").content.cloneNode(true)])
  );
}

function showDashboard() {
  editing = null;
  editor.hidden = true;
  dashboard.hidden = false;
  renderDashboard();
}

function returnToDashboard() {
  showDashboard();
  dashboard.querySelector("h1").focus();
  window.scrollTo(0, 0);
}

function moveMonth(offset) {
  visibleMonth = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() + offset, 1, 12);
  dashboardStatus.textContent = "";
  renderDashboard();
}

get("previous-month").addEventListener("click", () => moveMonth(-1));
get("next-month").addEventListener("click", () => moveMonth(1));
get("today-button").addEventListener("click", () => {
  visibleMonth = new Date();
  dashboardStatus.textContent = "";
  renderDashboard();
});
get("add-button").addEventListener("click", () => openEditor(dateKey()));
get("back-button").addEventListener("click", returnToDashboard);
get("cancel-button").addEventListener("click", returnToDashboard);
entryDate.addEventListener("input", () => { entryError.textContent = ""; });

const flowOptions = get("flow-options");
for (let level = 0; level <= 4; level += 1) {
  const label = element("label", "flow-level");
  const radio = element("input");
  radio.type = "radio";
  radio.name = "flow";
  radio.value = level;
  radio.setAttribute("aria-label", level === 0 ? "0 滴，无月经" : `${level} 滴`);
  const icon = level === 0 ? element("span", "", "0") : element("i", "drop");
  icon.setAttribute("aria-hidden", "true");
  label.append(radio, icon);
  flowOptions.append(label);
}

function openEditor(key) {
  const recorded = journal.entries[key];
  editing = {
    originalDate: recorded ? key : null,
    originalEntry: recorded ?? null,
    selected: Object.fromEntries(groups.map(({ key }) => [key, new Set(recorded?.[key] ?? [])])),
    custom: Object.fromEntries(groups.map(({ key }) => [key, [...journal.custom[key]]])),
  };
  get("editor-title").textContent = recorded ? "编辑记录" : "添加记录";
  entryDate.value = key;
  flowOptions.querySelector(`[value="${recorded?.flow ?? 0}"]`).checked = true;
  entryError.textContent = "";
  for (const group of groups) renderChips(group);
  dashboard.hidden = true;
  editor.hidden = false;
  get("editor-title").focus();
  window.scrollTo(0, 0);
}

function renderChips(group) {
  const { key, elementId, label, options } = group;
  const container = get(elementId);
  const names = new Set([...options, ...editing.custom[key], ...editing.selected[key]]);
  const chips = [...names].map((name) => {
    const chip = element("button", "chip", name);
    chip.type = "button";
    chip.setAttribute("aria-pressed", editing.selected[key].has(name));
    chip.addEventListener("click", () => {
      const selected = editing.selected[key];
      if (selected.has(name)) selected.delete(name);
      else selected.add(name);
      chip.setAttribute("aria-pressed", selected.has(name));
    });
    return chip;
  });

  const add = element("button", "chip custom", "+ 自定义");
  add.type = "button";
  add.setAttribute("aria-label", `添加自定义${label}`);
  add.addEventListener("click", () => {
    const existing = container.querySelector("input");
    if (existing) {
      existing.focus();
      return;
    }
    const row = element("div", "custom-chip");
    const input = element("input");
    input.type = "text";
    input.maxLength = 32;
    input.placeholder = `输入${label}名称`;
    input.setAttribute("aria-label", input.placeholder);
    const confirm = element("button", "button", "添加");
    confirm.type = "button";
    confirm.addEventListener("click", () => addCustom(group, input, true));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
        addCustom(group, input, true);
      }
    });
    row.append(input, confirm);
    container.append(row);
    input.focus();
  });
  container.replaceChildren(...chips, add);
}

function addCustom(group, input, restoreFocus) {
  const name = input.value.trim();
  if (!name) {
    if (restoreFocus) input.focus();
    return;
  }
  const { key, options, elementId } = group;
  if (!options.includes(name) && !editing.custom[key].includes(name)) {
    editing.custom[key].push(name);
  }
  editing.selected[key].add(name);
  renderChips(group);
  if (restoreFocus) {
    const added = [...get(elementId).querySelectorAll(".chip")].find((chip) => chip.textContent === name);
    added?.focus();
  }
}

get("record-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const key = entryDate.value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || Number.isNaN(+calendarDate(key))) {
    entryError.textContent = "请选择有效日期。";
    entryDate.focus();
    return;
  }

  for (const group of groups) {
    const input = get(group.elementId).querySelector(".custom-chip input");
    if (input) addCustom(group, input, false);
  }

  try {
    const updated = readJournal();
    const original = editing.originalDate;
    if (key !== original && updated.entries[key]) {
      entryError.textContent = "这一天已有记录。请选择其他日期，或返回日历点开原记录。";
      entryDate.focus();
      return;
    }
    if (original && JSON.stringify(updated.entries[original]) !== JSON.stringify(editing.originalEntry)) {
      entryError.textContent = "这条记录已在另一标签页更新，请返回后重新打开。";
      return;
    }

    const entry = { flow: Number(flowOptions.querySelector(":checked").value) };
    for (const { key: group } of groups) {
      entry[group] = [...editing.selected[group]];
      updated.custom[group] = [...new Set([...updated.custom[group], ...editing.custom[group]])];
    }
    if (original && original !== key) delete updated.entries[original];
    updated.entries[key] = entry;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    journal = updated;
  } catch {
    entryError.textContent = "保存失败，请检查浏览器的可用存储后重试。";
    return;
  }

  visibleMonth = calendarDate(key);
  returnToDashboard();
  dashboardStatus.textContent = "记录已保存。";
});

window.addEventListener("storage", (event) => {
  if ((event.key === STORAGE_KEY || event.key === null) && !appView.hidden) {
    refreshJournal();
    if (!dashboard.hidden) renderDashboard();
  }
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && !appView.hidden && !dashboard.hidden) renderDashboard();
});
