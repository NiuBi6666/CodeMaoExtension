const BUTTON_CLASS = "crm-alert-invert-selection";
const ACTIVE_CELL_CLASS = "crm-alert-selection-has-invert";
const TARGET_HEADERS = ["学生姓名", "课程名称", "课后作业"];

let operation = null;
let refreshFrame = 0;

export function parseSelectionSummary(text) {
  const normalized = String(text || "").replace(/\s+/g, "");
  const total = Number(normalized.match(/共计(\d+)(?:个)?(?:学生|记录)/)?.[1] || 0);
  const selected = Number(normalized.match(/已选中(\d+)(?:个)?(?:学生|记录)/)?.[1] || 0);
  return { total, selected };
}

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

function paginationState(table) {
  const pagination = table.querySelector(".ant-pagination");
  const summary = parseSelectionSummary(pagination?.querySelector(".ant-pagination-total-text")?.textContent);
  const current = Number(pagination?.querySelector(".ant-pagination-item-active")?.textContent?.trim() || 1);
  const pageSizeText = pagination?.querySelector(".ant-pagination-options-size-changer .ant-select-selection-item")?.textContent || "";
  const pageSize = Number(pageSizeText.match(/(\d+)/)?.[1] || 0);
  const listedPages = [...(pagination?.querySelectorAll(".ant-pagination-item") || [])]
    .map((item) => Number(item.textContent?.trim()))
    .filter(Number.isFinite);
  const pages = summary.total && pageSize
    ? Math.max(1, Math.ceil(summary.total / pageSize))
    : Math.max(1, ...listedPages);
  return { pagination, summary, current, pages };
}

function selectedOnCurrentPage(table) {
  return [...table.querySelectorAll("tbody tr[data-row-key] input[type='checkbox']")]
    .some((input) => input.checked);
}

function setButtonState(button, busy) {
  button.disabled = busy;
  button.textContent = busy ? "反选中" : "反选";
  button.setAttribute("aria-busy", String(busy));
  button.title = busy ? "正在反选全部分页中的学员" : "反选当前筛选结果中的全部可选学员";
}

function ensureButton(table) {
  const headerCell = table.querySelector("thead .ant-table-selection-column");
  const selection = headerCell?.querySelector(".ant-table-selection");
  if (!headerCell || !selection) return;

  const { summary } = paginationState(table);
  const isBusy = operation?.table === table;
  const shouldShow = isBusy || summary.selected > 0 || selectedOnCurrentPage(table);
  let button = selection.querySelector(`.${BUTTON_CLASS}`);
  if (!button) {
    button = document.createElement("button");
    button.type = "button";
    button.className = BUTTON_CLASS;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void invertAcrossPages(table, button);
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

function waitForPage(table, expectedPage, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const check = () => {
      if (!table.isConnected) {
        reject(new Error("CRM 表格已刷新，请重新操作"));
        return;
      }
      if (paginationState(table).current === expectedPage) {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
        return;
      }
      if (Date.now() - startedAt >= timeout) {
        reject(new Error(`切换到第 ${expectedPage} 页超时`));
        return;
      }
      setTimeout(check, 50);
    };
    check();
  });
}

async function moveOnePage(table, direction) {
  const state = paginationState(table);
  const expectedPage = state.current + (direction === "next" ? 1 : -1);
  const item = state.pagination?.querySelector(`.ant-pagination-${direction}`);
  const button = item?.querySelector("button");
  if (!button || button.disabled || item.classList.contains("ant-pagination-disabled")) {
    throw new Error(`无法切换到第 ${expectedPage} 页`);
  }
  button.click();
  await waitForPage(table, expectedPage);
}

async function goToPage(table, targetPage) {
  let currentPage = paginationState(table).current;
  while (currentPage < targetPage) {
    await moveOnePage(table, "next");
    currentPage = paginationState(table).current;
  }
  while (currentPage > targetPage) {
    await moveOnePage(table, "prev");
    currentPage = paginationState(table).current;
  }
}

function rowCheckbox(table, rowKey) {
  const row = [...table.querySelectorAll("tbody tr[data-row-key]")]
    .find((candidate) => candidate.getAttribute("data-row-key") === rowKey);
  return row?.querySelector(".ant-table-selection-column input[type='checkbox']") || null;
}

async function invertCurrentPage(table) {
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

async function invertAcrossPages(table, button) {
  if (operation || !table.isConnected) return;
  const initial = paginationState(table);
  if (initial.summary.selected <= 0 && !selectedOnCurrentPage(table)) return;

  const body = table.querySelector(".ant-table-body");
  const originalScrollLeft = body?.scrollLeft || 0;
  operation = { table, originalPage: initial.current };
  setButtonState(button, true);
  scheduleRefresh();
  try {
    await goToPage(table, 1);
    for (let page = 1; page <= initial.pages; page += 1) {
      const current = paginationState(table);
      if (current.pages !== initial.pages || current.summary.total !== initial.summary.total) {
        throw new Error("操作期间列表发生变化，请重新反选");
      }
      await invertCurrentPage(table);
      if (page < initial.pages) await moveOnePage(table, "next");
    }
  } catch (error) {
    console.warn("CRM 学员反选未完成", error);
    button.title = error.message || "反选未完成，请重试";
  } finally {
    try {
      if (table.isConnected) await goToPage(table, operation.originalPage);
    } catch (error) {
      console.warn("CRM 学员反选后恢复页码失败", error);
    }
    if (body?.isConnected) body.scrollLeft = originalScrollLeft;
    operation = null;
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
