import {
  aggregateCounts,
  filterIssues,
  parseDate,
  sortIssuesNewestFirst,
  uniqueMonthOptions,
  uniqueOptions,
  uniqueStudentIds
} from "./core.js";

const TYPE_LABELS = {
  absence: "旷课",
  homework: "作业未完成",
  extension: "拓展未完成",
  transfer: "调课",
  mismatch: "班级不一致"
};

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatDate(value) {
  const date = parseDate(value);
  if (!date) return value || "--";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

function typeTags(types) {
  return (types || []).map((type) => `<span class="crm-alert-tag crm-alert-tag--${escapeHtml(type)}">${TYPE_LABELS[type] || escapeHtml(type)}</span>`).join("");
}

function optionMarkup(options, selected, placeholder) {
  return [`<option value="">${escapeHtml(placeholder)}</option>`, ...(options || []).map((option) =>
    `<option value="${escapeHtml(option.value)}"${option.value === selected ? " selected" : ""}>${escapeHtml(option.label)}</option>`
  )].join("");
}

export class AlertUI {
  constructor(callbacks) {
    this.callbacks = callbacks;
    this.state = {
      open: false,
      loading: false,
      progress: "",
      error: "",
      roster: [],
      issues: [],
      meta: {},
      filters: { type: "all", month: "", campId: "", classId: "", lessonId: "", query: "" }
    };
    this.monthTouched = false;
    this.copyFeedback = "";
    this.copyFeedbackTimer = null;
  }

  mount() {
    const root = document.createElement("div");
    root.id = "crm-learning-alert-root";
    root.innerHTML = `
      <button class="crm-alert-trigger" type="button" aria-haspopup="dialog" title="打开学情异常看板">
        <span>学情异常</span><strong class="crm-alert-trigger__count">0</strong>
      </button>
      <div class="crm-alert-backdrop" hidden></div>
      <aside class="crm-alert-drawer" role="dialog" aria-modal="true" aria-label="学情异常看板" aria-hidden="true">
        <header class="crm-alert-header">
          <div><h2>学情异常</h2><p class="crm-alert-subtitle">当前账号 · 在读营期</p></div>
          <div class="crm-alert-header__actions">
            <button type="button" data-action="refresh">刷新</button>
            <button class="crm-alert-icon-button" type="button" data-action="close" title="关闭" aria-label="关闭">×</button>
          </div>
        </header>
        <div class="crm-alert-body">
          <section class="crm-alert-roster"></section>
          <section class="crm-alert-status" aria-live="polite"></section>
          <section class="crm-alert-summary"></section>
          <section class="crm-alert-filters"></section>
          <section class="crm-alert-results"></section>
          <section class="crm-alert-notes"></section>
        </div>
      </aside>`;
    document.body.appendChild(root);
    this.root = root;
    root.querySelector(".crm-alert-trigger").addEventListener("click", () => this.callbacks.onOpen());
    root.querySelector(".crm-alert-backdrop").addEventListener("click", () => this.close());
    root.querySelector('[data-action="close"]').addEventListener("click", () => this.close());
    root.querySelector('[data-action="refresh"]').addEventListener("click", () => this.callbacks.onRefresh(true));
    root.addEventListener("click", (event) => this.handleClick(event));
    root.addEventListener("change", (event) => this.handleChange(event));
    root.addEventListener("input", (event) => this.handleInput(event));
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.state.open) this.close();
    });
    this.render();
  }

  open() {
    this.state.open = true;
    this.root.querySelector(".crm-alert-backdrop").hidden = false;
    this.root.querySelector(".crm-alert-drawer").classList.add("is-open");
    this.root.querySelector(".crm-alert-drawer").setAttribute("aria-hidden", "false");
  }

  close() {
    this.state.open = false;
    this.root.querySelector(".crm-alert-backdrop").hidden = true;
    this.root.querySelector(".crm-alert-drawer").classList.remove("is-open");
    this.root.querySelector(".crm-alert-drawer").setAttribute("aria-hidden", "true");
  }

  update(patch) {
    this.state = { ...this.state, ...patch };
    if (Object.hasOwn(patch, "issues") && !this.monthTouched) {
      const [latestMonth] = uniqueMonthOptions(patch.issues).filter((option) => option.value !== "unknown");
      if (latestMonth) this.state.filters = { ...this.state.filters, month: latestMonth.value };
    }
    this.render();
  }

  handleClick(event) {
    const button = event.target.closest("button[data-filter-type], button[data-row-action], button[data-copy-ids]");
    if (!button) return;
    if (button.dataset.copyIds !== undefined) {
      this.copyVisibleStudentIds();
      return;
    }
    if (button.dataset.filterType) {
      this.state.filters.type = button.dataset.filterType;
      this.copyFeedback = "";
      this.render();
      return;
    }
    const issue = this.state.issues.find((item) => item.id === button.dataset.issueId);
    if (!issue) return;
    if (button.dataset.rowAction === "promote") this.callbacks.onPromote(issue);
    if (button.dataset.rowAction === "restore") this.callbacks.onRestore(issue);
  }

  handleChange(event) {
    if (event.target.matches('input[type="file"]')) {
      const [file] = event.target.files || [];
      if (file) this.callbacks.onImport(file);
      event.target.value = "";
      return;
    }
    if (event.target.dataset.filter) {
      if (event.target.dataset.filter === "month") this.monthTouched = true;
      this.state.filters[event.target.dataset.filter] = event.target.value;
      this.copyFeedback = "";
      this.render();
    }
  }

  handleInput(event) {
    if (event.target.dataset.filter === "query") {
      this.state.filters.query = event.target.value;
      this.copyFeedback = "";
      this.render();
    }
  }

  render() {
    if (!this.root) return;
    const countedIssues = filterIssues(this.state.issues, { ...this.state.filters, type: "all" });
    const counts = aggregateCounts(countedIssues);
    this.root.querySelector(".crm-alert-trigger__count").textContent = String(counts.absence + counts.homework + counts.extension + counts.transfer);
    this.renderRoster();
    this.renderStatus();
    this.renderSummary(counts);
    this.renderFilters();
    this.renderResults();
    this.renderNotes();
  }

  renderRoster() {
    const target = this.root.querySelector(".crm-alert-roster");
    const count = this.state.roster.length;
    const automaticCount = this.state.meta?.automaticRosterCount || 0;
    target.innerHTML = `
      <div class="crm-alert-roster__line">
        <div><strong>常驻班级来源</strong><span>${automaticCount ? `已从用户学情自动匹配 ${automaticCount} 条` : "打开看板后自动读取用户学情"}${count ? ` · ${count} 条人工修正` : ""}</span></div>
        <label class="crm-alert-file-button">${count ? "更新修正名单" : "导入修正名单"}<input type="file" accept=".xlsx,.csv" /></label>
      </div>
      <p class="crm-alert-help">默认按学员 ID 自动读取“用户学情 → 班级名称”；文件仅用于历史班级或时段修正。</p>`;
  }

  renderStatus() {
    const target = this.root.querySelector(".crm-alert-status");
    if (this.state.loading) {
      target.innerHTML = `<div class="crm-alert-banner crm-alert-banner--loading"><span class="crm-alert-spinner"></span><span>${escapeHtml(this.state.progress || "正在读取 CRM 学情数据…")}</span></div>`;
    } else if (this.state.error) {
      target.innerHTML = `<div class="crm-alert-banner crm-alert-banner--error">${escapeHtml(this.state.error)}</div>`;
    } else {
      target.innerHTML = "";
    }
  }

  renderSummary(counts) {
    const target = this.root.querySelector(".crm-alert-summary");
    const active = this.state.filters.type;
    target.innerHTML = `
      <div class="crm-alert-summary__item crm-alert-summary__item--absence"><span>旷课</span><strong>${counts.absence}</strong></div>
      <div class="crm-alert-summary__item crm-alert-summary__item--homework"><span>作业未完成</span><strong>${counts.homework}</strong></div>
      <div class="crm-alert-summary__item crm-alert-summary__item--extension"><span>拓展未完成</span><strong>${counts.extension}</strong></div>
      <div class="crm-alert-summary__item crm-alert-summary__item--transfer"><span>调课 / 待确认</span><strong>${counts.transfer}</strong></div>
      <div class="crm-alert-segments" aria-label="异常类型筛选">
        ${[["all", "全部"], ["absence", "旷课"], ["homework", "作业"], ["extension", "拓展"], ["transfer", "调课"]].map(([value, label]) =>
          `<button type="button" data-filter-type="${value}" class="${active === value ? "is-active" : ""}">${label}</button>`
        ).join("")}
      </div>`;
  }

  renderFilters() {
    const target = this.root.querySelector(".crm-alert-filters");
    const filters = this.state.filters;
    target.innerHTML = `
      <div class="crm-alert-filter-grid">
        <select data-filter="month" aria-label="筛选月份">${optionMarkup(uniqueMonthOptions(this.state.issues), filters.month, "全部月份")}</select>
        <select data-filter="campId" aria-label="筛选营期">${optionMarkup(uniqueOptions(this.state.issues, "campId", "campName"), filters.campId, "全部营期")}</select>
        <select data-filter="classId" aria-label="筛选班级">${optionMarkup(uniqueOptions(this.state.issues, "currentClassId"), filters.classId, "全部班级")}</select>
        <select data-filter="lessonId" aria-label="筛选课次">${optionMarkup(uniqueOptions(this.state.issues, "lessonId", "lessonName"), filters.lessonId, "全部课次")}</select>
        <input data-filter="query" type="search" value="${escapeHtml(filters.query)}" placeholder="搜索学员姓名或 ID" aria-label="搜索学员" />
      </div>`;
  }

  renderResults() {
    if (!this.root) return;
    const target = this.root.querySelector(".crm-alert-results");
    if (!this.state.meta?.refreshedAt && !this.state.loading && !this.state.error) {
      target.innerHTML = '<div class="crm-alert-empty"><strong>准备读取学情数据</strong><span>打开看板后会自动匹配用户学情中的常驻班级。</span></div>';
      return;
    }
    const visible = sortIssuesNewestFirst(filterIssues(this.state.issues, this.state.filters));
    if (!this.state.loading && !this.state.error && !visible.length) {
      target.innerHTML = '<div class="crm-alert-empty"><strong>没有符合条件的异常</strong><span>可以调整筛选条件或刷新数据。</span></div>';
      return;
    }
    target.innerHTML = `
      <div class="crm-alert-result-heading">
        <div><strong>异常明细</strong><span>${visible.length} 条 · 最新课次优先</span></div>
        <button type="button" data-copy-ids>${escapeHtml(this.copyFeedback || `复制当前结果 ID（${uniqueStudentIds(visible).length}）`)}</button>
      </div>
      <div class="crm-alert-table-wrap">
        <table class="crm-alert-table">
          <thead><tr><th>学员 / 课次</th><th>异常</th><th>班级与时段</th><th>数据状态</th><th>常驻班级</th></tr></thead>
          <tbody>${visible.map((issue) => this.renderRow(issue)).join("")}</tbody>
        </table>
      </div>`;
  }

  renderRow(issue) {
    const attendanceStatus = issue.issueTypes.includes("absence")
      ? "无到课记录"
      : issue.attendanceAt ? `到课 ${issue.attendanceAt}` : "";
    const homeworkDetails = this.renderTaskDetails("课后作业", issue.incompleteHomework);
    const extensionDetails = this.renderTaskDetails("课后拓展", issue.incompleteExtensions);
    const taskDetails = `${homeworkDetails}${extensionDetails}`;
    const isTransfer = issue.issueTypes.some((type) => type === "transfer" || type === "mismatch");
    return `<tr>
      <td><strong>${escapeHtml(issue.studentName || "未命名学员")}</strong><span>ID ${escapeHtml(issue.studentId)}</span><span>${escapeHtml(issue.campName)} · ${escapeHtml(issue.lessonName)}</span></td>
      <td><div class="crm-alert-tags">${typeTags(issue.issueTypes)}</div></td>
      <td><span>${escapeHtml(issue.homeClassId || "--")} · ${escapeHtml(issue.homeClassTime || "--")}</span><b>→</b><span>${escapeHtml(issue.currentClassId || "--")} · ${escapeHtml(issue.currentClassTime || "时段未返回")}</span></td>
      <td>${attendanceStatus ? `<span>${escapeHtml(attendanceStatus)}</span>` : ""}${taskDetails || (!attendanceStatus ? "--" : "")}<small>更新 ${escapeHtml(formatDate(issue.dataUpdatedAt))}</small></td>
      <td>${isTransfer ? `
        <button type="button" data-row-action="promote" data-issue-id="${escapeHtml(issue.id)}">设为新常驻班级</button>
        ${issue.hasOverride ? `<button class="crm-alert-link-button" type="button" data-row-action="restore" data-issue-id="${escapeHtml(issue.id)}">恢复初始班级</button>` : ""}
      ` : "--"}</td>
    </tr>`;
  }

  renderTaskDetails(label, items = []) {
    if (!items.length) return "";
    const details = items.map((item) => {
      const passed = Number(item.passed ?? item.submitted ?? 0);
      const total = Number(item.total || 0);
      const missing = Math.max(0, total - passed);
      return `${item.type}：未通过 ${missing} 道（通过 ${passed}/${total}）`;
    });
    return `<div class="crm-alert-homework-details"><strong>${escapeHtml(label)}</strong>${details.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div>`;
  }

  async copyVisibleStudentIds() {
    const visible = sortIssuesNewestFirst(filterIssues(this.state.issues, this.state.filters));
    const ids = uniqueStudentIds(visible);
    if (!ids.length) return;
    try {
      await this.writeClipboard(ids.join("\n"));
      this.copyFeedback = `已复制 ${ids.length} 个 ID`;
    } catch {
      this.copyFeedback = "复制失败，请重试";
    }
    clearTimeout(this.copyFeedbackTimer);
    this.renderResults();
    this.copyFeedbackTimer = setTimeout(() => {
      this.copyFeedback = "";
      this.renderResults();
    }, 1800);
  }

  async writeClipboard(text) {
    if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    if (!copied) throw new Error("copy failed");
  }

  renderNotes() {
    const target = this.root.querySelector(".crm-alert-notes");
    const warnings = this.state.meta?.warnings || [];
    const refreshedAt = this.state.meta?.refreshedAt;
    const cacheLabel = this.state.meta?.fromCache ? "15 分钟缓存" : "CRM 实时查询";
    target.innerHTML = `
      ${warnings.length ? `<details><summary>${warnings.length} 条数据提示</summary><ul>${warnings.slice(0, 20).map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul></details>` : ""}
      ${refreshedAt ? `<p>最后刷新：${escapeHtml(formatDate(refreshedAt))} · ${cacheLabel}</p>` : ""}`;
  }
}
