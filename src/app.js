import { collectAllIssues, collectCategoryRows, loadCampCatalog, loadClassCatalog, loadLessonCatalog } from "./crm-adapter.js";
import {
  clearHomeClassOverride,
  loadOverrides,
  loadRoster,
  setHomeClassOverride
} from "./storage.js";
import { AlertUI } from "./ui.js";

const CATEGORY_OPERATIONS = {
  inclass: 5,
  homework: 6,
  extension: 8
};

function normalizeLessonIds(values) {
  const source = Array.isArray(values) ? values : [values];
  return [...new Set(source.map((value) => String(value || "").trim()).filter(Boolean))];
}

export async function startApp() {
  let roster = await loadRoster();
  let overrides = await loadOverrides();
  let issues = [];
  let meta = {};
  let baseIssues = [];
  let baseMeta = {};
  let activeFilterType = "all";
  let loadingPromise = null;
  let requestGeneration = 0;
  let catalog = { camps: [], classes: [], lessons: [] };
  let selection = { campId: "", classId: "", lessonIds: [] };

  const ui = new AlertUI({
    onOpen: async () => {
      ui.open();
      if (!catalog.camps.length && !loadingPromise) await loadCamps();
    },
    onClose: () => clearSearchState({ clearCamps: true }),
    onReset: () => resetSearchConditions(),
    onRefresh: () => refresh(),
    onCampChange: (campId) => {
      activeFilterType = "all";
      return loadClasses(campId);
    },
    onClassChange: (classId) => {
      activeFilterType = "all";
      return loadLessons(classId);
    },
    onLessonChange: (lessonIds) => {
      activeFilterType = "all";
      return loadSelectedClass(selection.classId, lessonIds);
    },
    onFilterChange: (type) => loadCategory(type),
    onPromote: promoteHomeClass,
    onRestore: restoreHomeClass
  });
  ui.mount();
  ui.update({ roster, issues, meta, catalog, selection, summaryIssues: null });

  async function loadCamps() {
    if (loadingPromise) return loadingPromise;
    const generation = requestGeneration;
    loadingPromise = (async () => {
      ui.update({ loading: true, progress: "正在加载营期…", error: "" });
      try {
        const result = await loadCampCatalog();
        if (generation !== requestGeneration) return;
        catalog = { camps: result.camps, classes: [], lessons: [] };
        selection = { campId: "", classId: "", lessonIds: [] };
        issues = [];
        meta = {};
        baseIssues = [];
        baseMeta = {};
        ui.update({ catalog, selection, issues, meta, summaryIssues: null, loading: false, progress: "", error: "" });
      } catch (error) {
        if (generation === requestGeneration) {
          ui.update({ loading: false, progress: "", error: error.message || "营期加载失败" });
        }
      } finally {
        if (generation === requestGeneration) loadingPromise = null;
      }
    })();
    return loadingPromise;
  }

  async function loadClasses(campId) {
    if (loadingPromise) return loadingPromise;
    const nextCampId = String(campId || "").trim();
    selection = { campId: nextCampId, classId: "", lessonIds: [] };
    catalog = { ...catalog, classes: [], lessons: [] };
    issues = [];
    meta = {};
    baseIssues = [];
    baseMeta = {};
    ui.update({ selection, catalog, issues, meta, summaryIssues: null, error: "" });
    if (!nextCampId) return;
    const generation = requestGeneration;
    loadingPromise = (async () => {
      ui.update({ loading: true, progress: "正在加载该营期的班级…", error: "" });
      try {
        const result = await loadClassCatalog(nextCampId);
        if (generation !== requestGeneration) return;
        catalog = { ...catalog, classes: result.classes, lessons: [] };
        ui.update({ catalog, selection, loading: false, progress: "", error: "" });
      } catch (error) {
        if (generation === requestGeneration) {
          ui.update({ loading: false, progress: "", error: error.message || "班级加载失败" });
        }
      } finally {
        if (generation === requestGeneration) loadingPromise = null;
      }
    })();
    return loadingPromise;
  }

  async function loadSelectedClass(classId, lessonIds = []) {
    if (loadingPromise) return loadingPromise;
    const nextClassId = String(classId || "").trim();
    const nextLessonIds = normalizeLessonIds(lessonIds);
    selection = { ...selection, classId: nextClassId, lessonIds: nextLessonIds };
    issues = [];
    meta = {};
    baseIssues = [];
    baseMeta = {};
    ui.update({ selection, catalog, issues, meta, summaryIssues: null, error: "" });
    if (!selection.campId || !nextClassId || !nextLessonIds.length) return;
    const generation = requestGeneration;
    loadingPromise = (async () => {
      ui.update({
        loading: true,
        progress: "正在加载所选课节…",
        error: ""
      });
      try {
        const result = await collectAllIssues({
          roster,
          overrides,
          campId: selection.campId,
          classId: nextClassId,
          lessonIds: nextLessonIds,
          onProgress: ({ label }) => {
            if (generation === requestGeneration) ui.update({ progress: `正在读取：${label}` });
          }
        });
        if (generation !== requestGeneration) return;
        issues = result.issues;
        meta = result.meta;
        baseIssues = issues;
        baseMeta = meta;
        catalog = { ...catalog, lessons: meta.lessonOptions || [] };
        selection = { ...selection, lessonIds: normalizeLessonIds(meta.selectedLessonIds || [meta.selectedLessonId || meta.defaultLessonId]) };
        ui.update({ issues, meta, catalog, selection, roster, summaryIssues: baseIssues, loading: false, progress: "", error: "" });
      } catch (error) {
        if (generation === requestGeneration) {
          ui.update({ loading: false, progress: "", error: error.message || "班级数据加载失败" });
        }
      } finally {
        if (generation === requestGeneration) loadingPromise = null;
      }
    })();
    return loadingPromise;
  }

  async function loadLessons(classId) {
    if (loadingPromise) return loadingPromise;
    const nextClassId = String(classId || "").trim();
    selection = { ...selection, classId: nextClassId, lessonIds: [] };
    catalog = { ...catalog, lessons: [] };
    issues = [];
    meta = {};
    baseIssues = [];
    baseMeta = {};
    ui.update({ selection, catalog, issues, meta, summaryIssues: null, error: "" });
    if (!selection.campId || !nextClassId) return;
    const generation = requestGeneration;
    loadingPromise = (async () => {
      ui.update({ loading: true, progress: "正在加载全部课节…", error: "" });
      try {
        const result = await loadLessonCatalog(selection.campId);
        if (generation !== requestGeneration) return;
        catalog = { ...catalog, lessons: result.lessons };
        ui.update({ catalog, selection, loading: false, progress: "", error: "" });
      } catch (error) {
        if (generation === requestGeneration) {
          ui.update({ loading: false, progress: "", error: error.message || "课节加载失败" });
        }
      } finally {
        if (generation === requestGeneration) loadingPromise = null;
      }
    })();
    return loadingPromise;
  }

  async function loadCategory(type) {
    activeFilterType = type || "all";
    const quicklyOperate = CATEGORY_OPERATIONS[activeFilterType];
    if (!quicklyOperate) {
      issues = baseIssues;
      meta = baseMeta;
      ui.update({ issues, meta, summaryIssues: baseIssues, loading: false, progress: "", error: "" });
      return;
    }
    if (loadingPromise) return loadingPromise;
    const selectedLessonIds = normalizeLessonIds(selection.lessonIds);
    const lessonOptions = selectedLessonIds
      .map((lessonId) => catalog.lessons.find((option) => String(option.value) === lessonId))
      .filter(Boolean);
    if (!selection.campId || !selection.classId || !selectedLessonIds.length || lessonOptions.length !== selectedLessonIds.length) return;
    const generation = requestGeneration;
    loadingPromise = (async () => {
      ui.update({ loading: true, progress: `正在读取${activeFilterType === "inclass" ? "课中作业" : activeFilterType === "homework" ? "课后作业" : "课后拓展"}分类…`, error: "" });
      try {
        const result = await collectCategoryRows({
          campId: selection.campId,
          classId: selection.classId,
          lessonOptions,
          quicklyOperate,
          categoryType: activeFilterType
        });
        if (generation !== requestGeneration) return;
        issues = result.issues;
        meta = { ...baseMeta, ...result.meta, lessonOptions: catalog.lessons };
        ui.update({ issues, meta, loading: false, progress: "", error: "" });
      } catch (error) {
        if (generation === requestGeneration) {
          issues = [];
          ui.update({ issues, loading: false, progress: "", error: error.message || "分类数据加载失败" });
        }
      } finally {
        if (generation === requestGeneration) loadingPromise = null;
      }
    })();
    return loadingPromise;
  }

  async function refresh() {
    const generation = requestGeneration;
    const preservedFilterType = activeFilterType;
    const preservedSelection = {
      campId: selection.campId,
      classId: selection.classId,
      lessonIds: normalizeLessonIds(selection.lessonIds)
    };

    if (preservedSelection.classId && preservedSelection.lessonIds.length) {
      await loadSelectedClass(preservedSelection.classId, preservedSelection.lessonIds);
      if (generation !== requestGeneration) return;
      activeFilterType = preservedFilterType;
      if (CATEGORY_OPERATIONS[preservedFilterType]) return loadCategory(preservedFilterType);
      return;
    }
    if (preservedSelection.classId) return loadLessons(preservedSelection.classId);
    if (preservedSelection.campId) return loadClasses(preservedSelection.campId);
    return loadCamps();
  }

  function resetSearchConditions() {
    if (loadingPromise) return;
    clearSearchState({ clearCamps: false });
  }

  function clearSearchState({ clearCamps }) {
    requestGeneration += 1;
    loadingPromise = null;
    activeFilterType = "all";
    selection = { campId: "", classId: "", lessonIds: [] };
    catalog = clearCamps
      ? { camps: [], classes: [], lessons: [] }
      : { ...catalog, classes: [], lessons: [] };
    issues = [];
    meta = {};
    baseIssues = [];
    baseMeta = {};
    ui.update({ selection, catalog, issues, meta, summaryIssues: null, loading: false, error: "", progress: "" });
  }

  async function promoteHomeClass(issue) {
    const generation = requestGeneration;
    overrides = await setHomeClassOverride(
      issue.campId,
      issue.studentId,
      issue.currentClassId,
      issue.currentClassTime,
      issue.lessonEndedAt
    );
    if (generation !== requestGeneration) return;
    issues = [];
    ui.update({ issues, error: "", progress: "常驻班级已更新，正在重新判定…" });
    await refresh();
  }

  async function restoreHomeClass(issue) {
    const generation = requestGeneration;
    overrides = await clearHomeClassOverride(issue.campId, issue.studentId);
    if (generation !== requestGeneration) return;
    issues = [];
    ui.update({ issues, error: "", progress: "已恢复初始班级，正在重新判定…" });
    await refresh();
  }
}
