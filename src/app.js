import { collectAllIssues, collectCategoryRows, loadCampCatalog, loadClassCatalog, loadLessonCatalog } from "./crm-adapter.js";
import {
  clearCache,
  clearHomeClassOverride,
  loadCache,
  loadOverrides,
  loadRoster,
  saveCache,
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

function sameLessonIds(left, right) {
  const leftIds = normalizeLessonIds(left).sort();
  const rightIds = normalizeLessonIds(right).sort();
  return leftIds.length === rightIds.length && leftIds.every((value, index) => value === rightIds[index]);
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
  let teacherId = "";
  let catalog = { camps: [], classes: [], lessons: [] };
  let selection = { campId: "", classId: "", lessonIds: [] };

  const ui = new AlertUI({
    onOpen: async () => {
      ui.open();
      if (!catalog.camps.length && !loadingPromise) await loadCamps();
    },
    onRefresh: () => refresh(true),
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
      return loadSelectedClass(selection.classId, false, lessonIds);
    },
    onFilterChange: (type) => loadCategory(type),
    onPromote: promoteHomeClass,
    onRestore: restoreHomeClass
  });
  ui.mount();
  ui.update({ roster, issues, meta, catalog, selection, summaryIssues: null });

  async function loadCamps() {
    if (loadingPromise) return loadingPromise;
    loadingPromise = (async () => {
      ui.update({ loading: true, progress: "正在加载营期…", error: "" });
      try {
        const result = await loadCampCatalog();
        teacherId = result.teacherId;
        catalog = { camps: result.camps, classes: [], lessons: [] };
        selection = { campId: "", classId: "", lessonIds: [] };
        issues = [];
        meta = {};
        baseIssues = [];
        baseMeta = {};
        ui.update({ catalog, selection, issues, meta, summaryIssues: null, loading: false, progress: "", error: "" });
      } catch (error) {
        ui.update({ loading: false, progress: "", error: error.message || "营期加载失败" });
      } finally {
        loadingPromise = null;
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
    loadingPromise = (async () => {
      ui.update({ loading: true, progress: "正在加载该营期的班级…", error: "" });
      try {
        const result = await loadClassCatalog(nextCampId);
        teacherId = result.teacherId;
        catalog = { ...catalog, classes: result.classes, lessons: [] };
        ui.update({ catalog, selection, loading: false, progress: "", error: "" });
      } catch (error) {
        ui.update({ loading: false, progress: "", error: error.message || "班级加载失败" });
      } finally {
        loadingPromise = null;
      }
    })();
    return loadingPromise;
  }

  async function loadSelectedClass(classId, force = false, lessonIds = []) {
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
    loadingPromise = (async () => {
      ui.update({
        loading: true,
        progress: "正在加载所选课节…",
        error: ""
      });
      try {
        if (!force && teacherId) {
          const cached = await loadCache(teacherId);
          const cachedLessonIds = cached?.meta?.selectedLessonIds || [cached?.meta?.selectedLessonId || cached?.meta?.defaultLessonId || ""];
          const lessonMatches = sameLessonIds(cachedLessonIds, nextLessonIds);
          if (cached && cached.meta?.selectedCampId === selection.campId && cached.meta?.selectedClassId === nextClassId && lessonMatches) {
            issues = cached.issues || [];
            meta = { ...(cached.meta || {}), fromCache: true };
            baseIssues = issues;
            baseMeta = meta;
            catalog = { ...catalog, lessons: meta.lessonOptions || [] };
            selection = { ...selection, lessonIds: normalizeLessonIds(meta.selectedLessonIds || [meta.selectedLessonId || meta.defaultLessonId]) };
            ui.update({ issues, meta, catalog, selection, roster, summaryIssues: baseIssues, loading: false, progress: "", error: "" });
            return;
          }
        }
        const result = await collectAllIssues({
          roster,
          overrides,
          campId: selection.campId,
          classId: nextClassId,
          lessonIds: nextLessonIds,
          onProgress: ({ label }) => ui.update({ progress: `正在读取：${label}` })
        });
        teacherId = result.teacherId;
        issues = result.issues;
        meta = { ...result.meta, fromCache: false };
        baseIssues = issues;
        baseMeta = meta;
        catalog = { ...catalog, lessons: meta.lessonOptions || [] };
        selection = { ...selection, lessonIds: normalizeLessonIds(meta.selectedLessonIds || [meta.selectedLessonId || meta.defaultLessonId]) };
        await saveCache(result.teacherId, issues, meta);
        ui.update({ issues, meta, catalog, selection, roster, summaryIssues: baseIssues, loading: false, progress: "", error: "" });
      } catch (error) {
        ui.update({ loading: false, progress: "", error: error.message || "班级数据加载失败" });
      } finally {
        loadingPromise = null;
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
    loadingPromise = (async () => {
      ui.update({ loading: true, progress: "正在加载全部课节…", error: "" });
      try {
        const result = await loadLessonCatalog(selection.campId);
        teacherId = result.teacherId;
        catalog = { ...catalog, lessons: result.lessons };
        ui.update({ catalog, selection, loading: false, progress: "", error: "" });
      } catch (error) {
        ui.update({ loading: false, progress: "", error: error.message || "课节加载失败" });
      } finally {
        loadingPromise = null;
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
        teacherId = result.teacherId;
        issues = result.issues;
        meta = { ...baseMeta, ...result.meta, fromCache: false, lessonOptions: catalog.lessons };
        ui.update({ issues, meta, loading: false, progress: "", error: "" });
      } catch (error) {
        issues = [];
        ui.update({ issues, loading: false, progress: "", error: error.message || "分类数据加载失败" });
      } finally {
        loadingPromise = null;
      }
    })();
    return loadingPromise;
  }

  async function refresh(force = false) {
    if (CATEGORY_OPERATIONS[activeFilterType]) return loadCategory(activeFilterType);
    if (selection.classId && selection.lessonIds.length) return loadSelectedClass(selection.classId, force, selection.lessonIds);
    if (selection.classId) return loadLessons(selection.classId);
    if (selection.campId) return loadClasses(selection.campId);
    return loadCamps();
  }

  async function promoteHomeClass(issue) {
    overrides = await setHomeClassOverride(
      issue.campId,
      issue.studentId,
      issue.currentClassId,
      issue.currentClassTime,
      issue.lessonEndedAt
    );
    await clearCache();
    issues = [];
    ui.update({ issues, error: "", progress: "常驻班级已更新，正在重新判定…" });
    await refresh(true);
  }

  async function restoreHomeClass(issue) {
    overrides = await clearHomeClassOverride(issue.campId, issue.studentId);
    await clearCache();
    issues = [];
    ui.update({ issues, error: "", progress: "已恢复初始班级，正在重新判定…" });
    await refresh(true);
  }
}
