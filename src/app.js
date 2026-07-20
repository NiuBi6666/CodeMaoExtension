import { collectAllIssues, BridgeClient } from "./crm-adapter.js";
import { parseRosterFile } from "./importer.js";
import {
  clearCache,
  clearHomeClassOverride,
  loadCache,
  loadOverrides,
  loadRoster,
  loadTriggerPosition,
  saveCache,
  saveRoster,
  saveTriggerPosition,
  setHomeClassOverride
} from "./storage.js";
import { AlertUI } from "./ui.js";

async function currentTeacherId() {
  const state = await new BridgeClient().state();
  for (const capture of Object.values(state.captures || {})) {
    try {
      const id = new URL(capture.url).searchParams.get("internalTeacherId");
      if (id) return id;
    } catch {
      // Try the next captured URL.
    }
  }
  for (const entry of performance.getEntriesByType?.("resource") || []) {
    try {
      const id = new URL(entry.name).searchParams.get("internalTeacherId");
      if (id) return id;
    } catch {
      // Ignore invalid resource URLs.
    }
  }
  return "";
}

export async function startApp() {
  let roster = await loadRoster();
  let overrides = await loadOverrides();
  let issues = [];
  let meta = {};
  let loadingPromise = null;
  const triggerPosition = await loadTriggerPosition();

  const ui = new AlertUI({
    onOpen: async () => {
      ui.open();
      if (!issues.length && !loadingPromise) await refresh(false);
    },
    onRefresh: (force) => refresh(force),
    onImport: importRoster,
    onPromote: promoteHomeClass,
    onRestore: restoreHomeClass,
    onTriggerPositionChange: (position) => {
      saveTriggerPosition(position).catch((error) => console.error("学情异常按钮位置保存失败", error));
    }
  }, { triggerPosition });
  ui.mount();
  ui.update({ roster, issues, meta });

  async function importRoster(file) {
    ui.update({ loading: true, progress: "正在校验名单…", error: "" });
    try {
      const parsed = await parseRosterFile(file);
      if (parsed.errors.length) throw new Error(parsed.errors.join("；"));
      roster = parsed.records;
      await saveRoster(roster);
      await clearCache();
      issues = [];
      meta = { warnings: parsed.warnings };
      ui.update({ roster, issues, meta, loading: false, progress: "" });
      await refresh(true);
    } catch (error) {
      ui.update({ loading: false, progress: "", error: error.message || "名单导入失败" });
    }
  }

  async function refresh(force = false) {
    if (loadingPromise) return loadingPromise;
    loadingPromise = (async () => {
      ui.update({ loading: true, progress: "正在识别当前 CRM 账号…", error: "" });
      try {
        const teacherId = await currentTeacherId();
        if (!teacherId) throw new Error("无法识别当前教师，请刷新 CRM 工作台后重试");
        if (!force) {
          const cached = await loadCache(teacherId);
          if (cached) {
            issues = cached.issues || [];
            meta = { ...(cached.meta || {}), fromCache: true };
            ui.update({ issues, meta, loading: false, progress: "" });
            return;
          }
        }
        const result = await collectAllIssues({
          roster,
          overrides,
          onProgress: ({ completed, total, label }) => {
            ui.update({ progress: `正在读取 ${completed}/${total}：${label}` });
          }
        });
        issues = result.issues;
        meta = { ...result.meta, fromCache: false };
        await saveCache(result.teacherId, issues, meta);
        ui.update({ issues, meta, loading: false, progress: "", error: "" });
      } catch (error) {
        ui.update({ loading: false, progress: "", error: error.message || "CRM 数据读取失败" });
      } finally {
        loadingPromise = null;
      }
    })();
    return loadingPromise;
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
