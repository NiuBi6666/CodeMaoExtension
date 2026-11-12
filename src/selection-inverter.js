const BUTTON_CLASS = "crm-alert-invert-selection";
const ACTIVE_CELL_CLASS = "crm-alert-selection-has-invert";
const TARGET_HEADERS = ["学生姓名", "课程名称", "课后作业"];

let operationTable = null;
let refreshFrame = 0;

function isVisible(element) {
  return Boolean(element?.isConnected && element.getClientRects().length);
}

function targetTables() {
  return [...document.querySelectorAll(".ant-table-wrapper")].filter((table) => {
    if (!isVisible(table) || !table.querySelector("thead .ant-table-selection-column input[type='checkbox']")) return false;
    const headers = table.querySelector("thead")?.textContent || "";
    return TARGET_HEADERS.every((header) => headers.includes(header));
  });
}

function selectedOnCurrentPage(table) {
  return [...table.querySelectorAll("tbody tr[data-row-key] input[type='checkbox']")]
    .some((input) => input.checked);
}

function setButtonState(button, busy) {
  button.disabled = busy;
  button.textContent = busy ? "反选中" : "反选";
  button.setAttribute("aria-busy", String(busy));
  button.title = busy ? "正在反选当前页学员" : "反选当前页中的全部可选学员";
}

function ensureButton(table) {
  const headerCell = table.querySelector("thead .ant-table-selection-column");
  const selection = headerCell?.querySelector(".ant-table-selection");
  if (!headerCell || !selection) return;

  const isBusy = operationTable === table;
  const shouldShow = isBusy || selectedOnCurrentPage(table);
  let button = selection.querySelector(`.${BUTTON_CLASS}`);
  if (!button) {
    button = document.createElement("button");
    button.type = "button";
    button.className = BUTTON_CLASS;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void invertCurrentPage(table, button);
    });
    selection.append(button);
  }

  headerCell.classList.toggle(ACTIVE_CELL_CLASS, shouldShow);
  button.hidden = !shouldShow;
  setButtonState(button, isBusy);
}

function refreshButtons() {
  refreshFrame = 0;
  for (const table of targetTables()) ensureButton(table);
}

function scheduleRefresh() {
  if (refreshFrame) return;
  refreshFrame = requestAnimationFrame(refreshButtons);
}

function rowCheckbox(table, rowKey) {
  const row = [...table.querySelectorAll("tbody tr[data-row-key]")]
    .find((candidate) => candidate.getAttribute("data-row-key") === rowKey);
  return row?.querySelector(".ant-table-selection-column input[type='checkbox']") || null;
}

async function toggleCurrentPageCheckboxes(table) {
  const rowKeys = [...table.querySelectorAll("tbody tr[data-row-key]")]
    .map((row) => row.getAttribute("data-row-key"))
    .filter(Boolean);
  for (let index = 0; index < rowKeys.length; index += 1) {
    const checkbox = rowCheckbox(table, rowKeys[index]);
    if (!checkbox || checkbox.disabled) continue;
    checkbox.click();
    if ((index + 1) % 5 === 0) await new Promise(requestAnimationFrame);
  }
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

async function invertCurrentPage(table, button) {
  if (operationTable || !table.isConnected || !selectedOnCurrentPage(table)) return;
  operationTable = table;
  setButtonState(button, true);
  scheduleRefresh();
  try {
    await toggleCurrentPageCheckboxes(table);
  } catch (error) {
    console.warn("CRM 当前页学员反选未完成", error);
    button.title = error.message || "反选未完成，请重试";
  } finally {
    operationTable = null;
    scheduleRefresh();
  }
}

export function startSelectionInverter() {
  const observer = new MutationObserver(scheduleRefresh);
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true
  });
  document.addEventListener("change", scheduleRefresh, true);
  scheduleRefresh();
}
