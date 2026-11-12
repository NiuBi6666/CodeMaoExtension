const TARGET_HEADERS = ["学生姓名", "课程名称", "课后作业"];

const cycles = new WeakMap();
let operationTable = null;

function isVisible(element) {
  return Boolean(element?.isConnected && element.getClientRects().length);
}

function isTargetTable(table) {
  if (!isVisible(table) || !table.querySelector("thead .ant-table-selection-column input[type='checkbox']")) return false;
  const headers = table.querySelector("thead")?.textContent || "";
  return TARGET_HEADERS.every((header) => headers.includes(header));
}

function currentRows(table) {
  return [...table.querySelectorAll("tbody tr[data-row-key]")];
}

function currentPageSignature(table) {
  return currentRows(table)
    .map((row) => row.getAttribute("data-row-key"))
    .filter(Boolean)
    .join("|");
}

function rowCheckbox(table, rowKey) {
  const row = currentRows(table)
    .find((candidate) => candidate.getAttribute("data-row-key") === rowKey);
  return row?.querySelector(".ant-table-selection-column input[type='checkbox']") || null;
}

function hasCurrentPageSelection(table) {
  return currentRows(table).some((row) => {
    const checkbox = row.querySelector(".ant-table-selection-column input[type='checkbox']");
    return checkbox?.checked;
  });
}

async function updateCurrentPage(table, mode) {
  const rowKeys = currentRows(table)
    .map((row) => row.getAttribute("data-row-key"))
    .filter(Boolean);
  for (let index = 0; index < rowKeys.length; index += 1) {
    const checkbox = rowCheckbox(table, rowKeys[index]);
    if (!checkbox || checkbox.disabled) continue;
    if (mode === "all" && checkbox.checked) continue;
    checkbox.click();
    if ((index + 1) % 5 === 0) await new Promise(requestAnimationFrame);
  }
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

function intercept(event) {
  event.preventDefault();
  event.stopPropagation();
}

async function runEnhancedAction(table, selection, mode, nextStage, signature) {
  operationTable = table;
  selection.setAttribute("aria-busy", "true");
  cycles.set(table, { stage: nextStage, signature });
  try {
    await updateCurrentPage(table, mode);
  } catch (error) {
    cycles.delete(table);
    console.warn("CRM 当前页学员选择操作未完成", error);
  } finally {
    operationTable = null;
    if (selection.isConnected) selection.removeAttribute("aria-busy");
  }
}

function handleHeaderSelectionClick(event) {
  const selection = event.target.closest?.("thead .ant-table-selection");
  const table = selection?.closest(".ant-table-wrapper");
  if (!selection || !table || !isTargetTable(table)) return;

  if (operationTable) {
    intercept(event);
    return;
  }

  const signature = currentPageSignature(table);
  const saved = cycles.get(table);
  const stage = saved?.signature === signature ? saved.stage : 0;
  if (saved && saved.signature !== signature) cycles.delete(table);

  if (stage === 0) {
    if (!hasCurrentPageSelection(table)) return;
    intercept(event);
    void runEnhancedAction(table, selection, "invert", 1, signature);
    return;
  }

  if (stage === 1) {
    intercept(event);
    void runEnhancedAction(table, selection, "all", 2, signature);
    return;
  }

  cycles.delete(table);
}

function handleRowSelectionChange(event) {
  const checkbox = event.target.closest?.("tbody tr[data-row-key] .ant-table-selection-column input[type='checkbox']");
  const table = checkbox?.closest(".ant-table-wrapper");
  if (table && operationTable !== table) cycles.delete(table);
}

export function startSelectionInverter() {
  document.addEventListener("click", handleHeaderSelectionClick, true);
  document.addEventListener("change", handleRowSelectionChange, true);
}
