import {
  aggregateCounts,
  filterIssues,
  parseDate,
  sortIssuesByStudentId,
  uniqueStudentIds
} from "./core.js";
import { createXlsxWorkbook } from "./xlsx-exporter.js";

const TYPE_LABELS = {
  absence: "旷课",
  inclass: "课中作业未完成",
  homework: "课后作业未完成",
  extension: "课后拓展未完成",
  transfer: "调课",
  mismatch: "班级不一致"
};

const FILTER_LABELS = {
  all: "全部",
  inclass: "课中作业",
  homework: "课后作业",
  extension: "课后拓展",
  absence: "旷课",
  transfer: "调课"
};

const EXPORT_HEADERS = ["学生 ID", "学生名字", "课节", "课中作业", "课后作业", "课后拓展"];

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

function taskDetailLines(items = []) {
  return (items || [])
    .filter((item) => Number(item.total || 0) > 0)
    .map((item) => {
      const passed = Number(item.passed ?? item.submitted ?? 0);
      const submitted = Number(item.submitted ?? passed);
      const total = Number(item.total || 0);
      const completion = submitted === passed ? "" : ` · 完成 ${submitted}/${total}`;
      return `${item.type}：通过 ${passed}/${total}${completion}`;
    });
}

function exportTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

function safeFilenamePart(value) {
  return String(value || "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .trim()
    .replace(/\s+/g, "_")
    .slice(0, 48);
}

function typeTags(types) {
  return (types || []).map((type) => `<span class="crm-alert-tag crm-alert-tag--${escapeHtml(type)}">${TYPE_LABELS[type] || escapeHtml(type)}</span>`).join("");
}

function optionMarkup(options, selected, placeholder) {
  return [`<option value="">${escapeHtml(placeholder)}</option>`, ...(options || []).map((option) =>
    `<option value="${escapeHtml(option.value)}"${option.value === selected ? " selected" : ""}>${escapeHtml(option.label)}</option>`
  )].join("");
}

function lessonOptionsDescending(options) {
  return (options || [])
    .map((option, index) => {
      const match = String(option.label || "").match(/\bP\s*0*(\d+)\b/i);
      return { option, index, sequence: match ? Number(match[1]) : null };
    })
    .sort((left, right) => {
      if (left.sequence !== null && right.sequence !== null && left.sequence !== right.sequence) {
        return right.sequence - left.sequence;
      }
      if (left.sequence !== null) return -1;
      if (right.sequence !== null) return 1;
      return left.index - right.index;
    })
    .map(({ option }) => option);
}

export class AlertUI {
  constructor(callbacks) {
    this.callbacks = callbacks;
    this.triggerAnchorFrame = 0;
    this.state = {
      open: false,
      loading: false,
      progress: "",
      error: "",
      roster: [],
      issues: [],
      summaryIssues: null,
      meta: {},
      catalog: { camps: [], classes: [], lessons: [] },
      selection: { campId: "", classId: "", lessonIds: [] },
      filters: { type: "all", query: "" }
    };
    this.lessonMenuOpen = false;
    this.lessonDraft = [];
    this.copyFeedback = "";
    this.exportFeedback = "";
    this.queryDraft = "";
    this.copyFeedbackTimer = null;
    this.exportFeedbackTimer = null;
  }

  mount() {
    const root = document.createElement("div");
    root.id = "crm-learning-alert-root";
    root.innerHTML = `
      <button class="crm-alert-trigger" type="button" aria-haspopup="dialog" title="打开作业统计看板">作业统计</button>
      <div class="crm-alert-backdrop" hidden></div>
      <aside class="crm-alert-drawer" role="dialog" aria-modal="true" aria-label="作业统计" aria-hidden="true">
        <header class="crm-alert-header">
          <div><h2>作业统计</h2></div>
          <div class="crm-alert-header__actions">
            <button type="button" data-action="refresh">刷新</button>
            <button class="crm-alert-icon-button" type="button" data-action="close" title="关闭" aria-label="关闭">×</button>
          </div>
        </header>
        <div class="crm-alert-loading-mask" role="status" aria-live="polite" aria-busy="true" hidden>
          <div class="crm-alert-loading-dialog">
            <span class="crm-alert-spinner" aria-hidden="true"></span>
            <strong>正在加载</strong>
            <span data-loading-progress>正在读取 CRM 学情数据…</span>
          </div>
        </div>
        <div class="crm-alert-body">
          <section class="crm-alert-status" aria-live="polite"></section>
          <section class="crm-alert-summary"></section>
          <section class="crm-alert-filters"></section>
          <section class="crm-alert-segments" aria-label="异常类型筛选"></section>
          <section class="crm-alert-results"></section>
          <section class="crm-alert-notes"></section>
        </div>
      </aside>`;
    document.body.appendChild(root);
    this.root = root;
    const trigger = root.querySelector(".crm-alert-trigger");
    this.trigger = trigger;
    this.anchorTrigger();
    this.triggerAnchorObserver = new MutationObserver(() => this.scheduleTriggerAnchor());
    this.triggerAnchorObserver.observe(document.body, { childList: true, subtree: true });
    trigger.addEventListener("click", () => this.callbacks.onOpen());
    root.querySelector(".crm-alert-backdrop").addEventListener("click", () => this.close());
    root.querySelector('[data-action="close"]').addEventListener("click", () => this.close());
    root.querySelector('[data-action="refresh"]').addEventListener("click", () => this.callbacks.onRefresh());
    root.addEventListener("click", (event) => this.handleClick(event));
    root.addEventListener("change", (event) => this.handleChange(event));
    root.addEventListener("input", (event) => this.handleInput(event));
    root.addEventListener("keydown", (event) => this.handleKeyDown(event));
    document.addEventListener("click", (event) => {
      if (!this.lessonMenuOpen || event.target.closest(".crm-alert-multi-select")) return;
      this.lessonMenuOpen = false;
      this.lessonDraft = [];
      this.renderFilters();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      if (this.lessonMenuOpen) {
        this.lessonMenuOpen = false;
        this.lessonDraft = [];
        this.renderFilters();
        return;
      }
      if (this.state.open) this.close();
    });
    this.render();
  }

  scheduleTriggerAnchor() {
    if (this.triggerAnchorFrame) return;
    this.triggerAnchorFrame = requestAnimationFrame(() => {
      this.triggerAnchorFrame = 0;
      this.anchorTrigger();
    });
  }

  anchorTrigger() {
    if (!this.root || !this.trigger) return;
    const teachingTab = [...document.querySelectorAll('[role="tab"]')]
      .find((tab) => String(tab.textContent || "").replace(/\s+/g, "").trim() === "教学期" && tab.getClientRects().length > 0);
    const tabNav = teachingTab?.closest(".ant-tabs-nav");
    if (tabNav) {
      if (this.trigger.parentElement !== tabNav) tabNav.appendChild(this.trigger);
      this.trigger.classList.add("is-page-anchored");
      return;
    }
    if (this.trigger.parentElement !== this.root) this.root.prepend(this.trigger);
    this.trigger.classList.remove("is-page-anchored");
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
    const catalog = patch.catalog ? { ...this.state.catalog, ...patch.catalog } : this.state.catalog;
    const selection = patch.selection ? { ...this.state.selection, ...patch.selection } : this.state.selection;
    this.state = { ...this.state, ...patch, catalog, selection };
    if (patch.loading) {
      this.lessonMenuOpen = false;
      this.lessonDraft = [];
    }
    this.render();
  }

  handleClick(event) {
    const button = event.target.closest("button[data-filter-type], button[data-row-action], button[data-copy-ids], button[data-export-excel], button[data-lesson-menu], button[data-lesson-clear], button[data-lesson-apply]");
    if (!button) return;
    if (button.dataset.lessonMenu !== undefined) {
      this.lessonMenuOpen = !this.lessonMenuOpen;
      this.lessonDraft = this.lessonMenuOpen ? [...(this.state.selection.lessonIds || [])] : [];
      this.renderFilters();
      if (this.lessonMenuOpen) this.updateLessonMenuChecks();
      return;
    }
    if (button.dataset.lessonClear !== undefined) {
      this.lessonDraft = [];
      this.updateLessonMenuChecks();
      return;
    }
    if (button.dataset.lessonApply !== undefined) {
      this.applyLessonSelection();
      return;
    }
    if (button.dataset.copyIds !== undefined) {
      this.copyVisibleStudentIds();
      return;
    }
    if (button.dataset.exportExcel !== undefined) {
      this.exportVisibleResults();
      return;
    }
    if (button.dataset.filterType) {
      this.state.filters.type = button.dataset.filterType;
      this.copyFeedback = "";
      this.render();
      this.callbacks.onFilterChange?.(button.dataset.filterType);
      return;
    }
    const issue = this.state.issues.find((item) => item.id === button.dataset.issueId);
    if (!issue) return;
    if (button.dataset.rowAction === "promote") this.callbacks.onPromote(issue);
    if (button.dataset.rowAction === "restore") this.callbacks.onRestore(issue);
  }

  handleChange(event) {
    if (event.target.dataset.lessonOption !== undefined) {
      const selected = new Set(this.lessonDraft);
      if (event.target.checked) selected.add(event.target.value);
      else selected.delete(event.target.value);
      this.lessonDraft = lessonOptionsDescending(this.state.catalog.lessons)
        .map((option) => String(option.value))
        .filter((value) => selected.has(value));
      this.updateLessonMenuChecks();
      return;
    }
    if (event.target.dataset.lessonAll !== undefined) {
      this.lessonDraft = event.target.checked
        ? lessonOptionsDescending(this.state.catalog.lessons).map((option) => String(option.value))
        : [];
      this.updateLessonMenuChecks();
      return;
    }
    if (event.target.dataset.selection) {
      const key = event.target.dataset.selection;
      const value = event.target.value;
      if (key === "campId") {
        this.state.filters.type = "all";
        this.state.selection = { campId: value, classId: "", lessonIds: [] };
        this.state.catalog = { ...this.state.catalog, classes: [], lessons: [] };
        this.state.issues = [];
        this.state.meta = {};
        this.copyFeedback = "";
        this.render();
        this.callbacks.onCampChange?.(value);
        return;
      }
      if (key === "classId") {
        this.state.filters.type = "all";
        this.state.selection = { ...this.state.selection, classId: value, lessonIds: [] };
        this.state.catalog = { ...this.state.catalog, lessons: [] };
        this.state.issues = [];
        this.state.meta = {};
        this.copyFeedback = "";
        this.render();
        this.callbacks.onClassChange?.(value);
        return;
      }
    }
    if (event.target.dataset.filter && event.target.dataset.filter !== "query") {
      this.state.filters[event.target.dataset.filter] = event.target.value;
      this.copyFeedback = "";
      this.render();
    }
  }

  handleInput(event) {
    if (event.target.dataset.filter === "query") {
      this.queryDraft = event.target.value;
      this.copyFeedback = "";
    }
  }

  handleKeyDown(event) {
    if (event.target.dataset.filter !== "query" || event.key !== "Enter" || event.isComposing) return;
    event.preventDefault();
    this.state.filters.query = this.queryDraft.trim();
    this.copyFeedback = "";
    this.render();
  }

  applyLessonSelection() {
    const validIds = new Set((this.state.catalog.lessons || []).map((option) => String(option.value)));
    const lessonIds = this.lessonDraft.filter((value) => validIds.has(String(value)));
    this.lessonMenuOpen = false;
    this.lessonDraft = [];
    this.state.filters.type = "all";
    this.state.selection = { ...this.state.selection, lessonIds };
    this.state.issues = [];
    this.state.meta = {};
    this.copyFeedback = "";
    this.render();
    this.callbacks.onLessonChange?.(lessonIds);
  }

  updateLessonMenuChecks() {
    const menu = this.root?.querySelector(".crm-alert-multi-select__menu");
    if (!menu) return;
    const selected = new Set(this.lessonDraft.map(String));
    const optionCheckboxes = [...menu.querySelectorAll("input[data-lesson-option]")];
    for (const checkbox of optionCheckboxes) checkbox.checked = selected.has(String(checkbox.value));
    const allCheckbox = menu.querySelector("input[data-lesson-all]");
    if (!allCheckbox) return;
    allCheckbox.checked = optionCheckboxes.length > 0 && optionCheckboxes.every((checkbox) => checkbox.checked);
    allCheckbox.indeterminate = !allCheckbox.checked && optionCheckboxes.some((checkbox) => checkbox.checked);
  }

  render() {
    if (!this.root) return;
    const summarySource = Array.isArray(this.state.summaryIssues) ? this.state.summaryIssues : this.state.issues;
    const countedIssues = filterIssues(summarySource, { ...this.state.filters, type: "all" });
    const counts = aggregateCounts(countedIssues);
    this.renderStatus();
    this.renderSummary(counts);
    this.renderFilters();
    this.renderSegments();
    this.renderResults();
    this.renderNotes();
  }

  renderStatus() {
    const target = this.root.querySelector(".crm-alert-status");
    const loadingMask = this.root.querySelector(".crm-alert-loading-mask");
    const drawer = this.root.querySelector(".crm-alert-drawer");
    loadingMask.hidden = !this.state.loading;
    loadingMask.querySelector("[data-loading-progress]").textContent = this.state.progress || "正在读取 CRM 学情数据…";
    drawer.setAttribute("aria-busy", String(this.state.loading));
    if (this.state.error) {
      target.innerHTML = `<div class="crm-alert-banner crm-alert-banner--error">${escapeHtml(this.state.error)}</div>`;
    } else {
      target.innerHTML = "";
    }
  }

  renderSummary(counts) {
    const target = this.root.querySelector(".crm-alert-summary");
    target.innerHTML = `
      <div class="crm-alert-summary__item crm-alert-summary__item--absence"><span>旷课</span><strong>${counts.absence}</strong></div>
      <div class="crm-alert-summary__item crm-alert-summary__item--homework"><span>作业未完成</span><strong>${counts.homework}</strong></div>
      <div class="crm-alert-summary__item crm-alert-summary__item--extension"><span>拓展未完成</span><strong>${counts.extension}</strong></div>
      <div class="crm-alert-summary__item crm-alert-summary__item--transfer"><span>调课 / 待确认</span><strong>${counts.transfer}</strong></div>`;
  }

  renderFilters() {
    const target = this.root.querySelector(".crm-alert-filters");
    const { catalog, selection, loading } = this.state;
    const lessonOptions = lessonOptionsDescending(catalog.lessons);
    const selectedIds = new Set((selection.lessonIds || []).map(String));
    const draftIds = new Set(this.lessonDraft.map(String));
    const selectedOptions = lessonOptions.filter((option) => selectedIds.has(String(option.value)));
    const lessonLabel = selectedOptions.length === 1
      ? selectedOptions[0].label
      : selectedOptions.length > 1
        ? `已选择 ${selectedOptions.length} 节课`
        : "请选择课节";
    const allDraftSelected = lessonOptions.length > 0 && lessonOptions.every((option) => draftIds.has(String(option.value)));
    target.innerHTML = `
      <div class="crm-alert-filter-grid">
        <select data-selection="campId" aria-label="选择营期"${loading ? " disabled" : ""}>${optionMarkup(catalog.camps, selection.campId, "请选择营期")}</select>
        <select data-selection="classId" aria-label="选择班级"${loading || !selection.campId ? " disabled" : ""}>${optionMarkup(catalog.classes, selection.classId, "请选择班级")}</select>
        <div class="crm-alert-multi-select${this.lessonMenuOpen ? " is-open" : ""}">
          <button type="button" class="crm-alert-multi-select__trigger" data-lesson-menu aria-haspopup="listbox" aria-expanded="${this.lessonMenuOpen}"${loading || !selection.classId || !lessonOptions.length ? " disabled" : ""}>
            <span>${escapeHtml(lessonLabel)}</span><span aria-hidden="true">▾</span>
          </button>
          ${this.lessonMenuOpen ? `
            <div class="crm-alert-multi-select__menu" role="listbox" aria-multiselectable="true">
              <label class="crm-alert-multi-select__all"><input type="checkbox" data-lesson-all${allDraftSelected ? " checked" : ""}>全选</label>
              <div class="crm-alert-multi-select__options">
                ${lessonOptions.map((option) => `<label><input type="checkbox" data-lesson-option value="${escapeHtml(option.value)}"${draftIds.has(String(option.value)) ? " checked" : ""}><span>${escapeHtml(option.label)}</span></label>`).join("")}
              </div>
              <div class="crm-alert-multi-select__actions">
                <button type="button" data-lesson-clear>清空</button>
                <button type="button" class="is-primary" data-lesson-apply>确定</button>
              </div>
            </div>` : ""}
        </div>
        <input data-filter="query" type="search" value="${escapeHtml(this.queryDraft)}" placeholder="搜索学员姓名或 ID" aria-label="搜索学员" enterkeyhint="search" />
      </div>`;
  }

  renderSegments() {
    const target = this.root.querySelector(".crm-alert-segments");
    const active = this.state.filters.type;
    target.innerHTML = [["all", "全部"], ["inclass", "课中作业"], ["homework", "课后作业"], ["extension", "课后拓展"], ["absence", "旷课"], ["transfer", "调课"]].map(([value, label]) =>
      `<button type="button" data-filter-type="${value}" class="${active === value ? "is-active" : ""}"${this.state.loading ? " disabled" : ""}>${label}</button>`
    ).join("");
  }

  renderResults() {
    if (!this.root) return;
    const target = this.root.querySelector(".crm-alert-results");
    if (!this.state.selection.campId && !this.state.loading) {
      target.innerHTML = '<div class="crm-alert-empty"><strong>请选择营期</strong><span>选择营期后会加载该营期下的班级。</span></div>';
      return;
    }
    if (!this.state.selection.classId && !this.state.loading) {
      target.innerHTML = '<div class="crm-alert-empty"><strong>请选择班级</strong><span>选择班级后会加载该营期的全部课节。</span></div>';
      return;
    }
    if (!(this.state.selection.lessonIds || []).length && !this.state.loading) {
      target.innerHTML = '<div class="crm-alert-empty"><strong>请选择课节</strong><span>可同时选择多节课，确认后加载该班级的作业数据。</span></div>';
      return;
    }
    if (!this.state.meta?.refreshedAt && !this.state.loading && !this.state.error) {
      target.innerHTML = '<div class="crm-alert-empty"><strong>准备读取作业数据</strong><span>课节和学员数据加载完成后会显示在这里。</span></div>';
      return;
    }
    const visible = this.visibleIssues();
    if (!this.state.loading && !this.state.error && !visible.length) {
      target.innerHTML = '<div class="crm-alert-empty"><strong>没有符合条件的作业明细</strong><span>可以调整筛选条件或刷新数据。</span></div>';
      return;
    }
    target.innerHTML = `
      <div class="crm-alert-result-heading">
        <div class="crm-alert-result-title"><strong>作业明细</strong><span>${visible.length} 条</span></div>
        <div class="crm-alert-result-actions">
          <button type="button" data-copy-ids>${escapeHtml(this.copyFeedback || `复制当前结果 ID（${uniqueStudentIds(visible).length}）`)}</button>
          <button type="button" data-export-excel>${escapeHtml(this.exportFeedback || "导出 Excel")}</button>
        </div>
      </div>
      <div class="crm-alert-table-wrap">
        <table class="crm-alert-table">
          <thead><tr><th>学生 ID</th><th>学生名字</th><th>课节</th><th>课中作业</th><th>课后作业</th><th>课后拓展</th></tr></thead>
          <tbody>${visible.map((issue) => this.renderRow(issue)).join("")}</tbody>
        </table>
      </div>`;
  }

  renderRow(issue) {
    const inClassDetails = this.renderTaskDetails("课中作业", issue.inClassHomework);
    const homeworkDetails = this.renderTaskDetails("课后作业", issue.homework);
    const extensionDetails = this.renderTaskDetails("课后拓展", issue.extensions);
    return `<tr>
      <td><strong>${escapeHtml(issue.studentId || "--")}</strong></td>
      <td><strong>${escapeHtml(issue.studentName || "未命名学员")}</strong></td>
      <td><strong>${escapeHtml(issue.lessonName || "--")}</strong></td>
      <td>${inClassDetails || "--"}</td>
      <td>${homeworkDetails || "--"}</td>
      <td>${extensionDetails || "--"}<small>更新 ${escapeHtml(formatDate(issue.dataUpdatedAt))}</small></td>
    </tr>`;
  }

  renderTaskDetails(label, items = []) {
    const details = taskDetailLines(items);
    if (!details.length) return "";
    return `<div class="crm-alert-homework-details"><strong>${escapeHtml(label)}</strong>${details.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div>`;
  }

  visibleIssues() {
    return sortIssuesByStudentId(filterIssues(this.state.issues, this.state.filters));
  }

  async copyVisibleStudentIds() {
    const visible = this.visibleIssues();
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

  exportVisibleResults() {
    const visible = this.visibleIssues();
    if (!visible.length) return;

    try {
      const rows = visible.map((issue) => {
        const extensionDetails = taskDetailLines(issue.extensions).join("\n") || "--";
        return [
          String(issue.studentId || "--"),
          issue.studentName || "未命名学员",
          issue.lessonName || "--",
          taskDetailLines(issue.inClassHomework).join("\n") || "--",
          taskDetailLines(issue.homework).join("\n") || "--",
          `${extensionDetails}\n更新 ${formatDate(issue.dataUpdatedAt)}`
        ];
      });
      const blob = createXlsxWorkbook({ headers: EXPORT_HEADERS, rows, sheetName: "作业明细" });
      const campLabel = this.selectedOptionLabel(this.state.catalog.camps, this.state.selection.campId);
      const classLabel = this.selectedOptionLabel(this.state.catalog.classes, this.state.selection.classId);
      const filterLabel = FILTER_LABELS[this.state.filters.type] || "全部";
      const filenameParts = ["CRM作业明细", campLabel, classLabel, filterLabel, exportTimestamp()]
        .map(safeFilenamePart)
        .filter(Boolean);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${filenameParts.join("_")}.xlsx`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      this.exportFeedback = `已导出 ${visible.length} 条`;
    } catch {
      this.exportFeedback = "导出失败，请重试";
    }

    clearTimeout(this.exportFeedbackTimer);
    this.renderResults();
    this.exportFeedbackTimer = setTimeout(() => {
      this.exportFeedback = "";
      this.renderResults();
    }, 1800);
  }

  selectedOptionLabel(options, selectedValue) {
    return (options || []).find((option) => String(option.value) === String(selectedValue))?.label || "";
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
    target.innerHTML = `
      ${warnings.length ? `<details><summary>${warnings.length} 条数据提示</summary><ul>${warnings.slice(0, 20).map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul></details>` : ""}
      ${refreshedAt ? `<p>最后刷新：${escapeHtml(formatDate(refreshedAt))} · CRM 实时查询</p>` : ""}`;
  }
}
