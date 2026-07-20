import { CACHE_SCHEMA_VERSION, CACHE_TTL_MS, normalizeId, overrideKey } from "./core.js";

const KEYS = {
  roster: "crmLearningAlert.roster",
  overrides: "crmLearningAlert.overrides",
  cache: "crmLearningAlert.cache"
};

function getStorage() {
  if (!globalThis.chrome?.storage?.local) throw new Error("扩展本地存储不可用");
  return chrome.storage.local;
}

export async function loadRoster() {
  const data = await getStorage().get(KEYS.roster);
  return Array.isArray(data[KEYS.roster]) ? data[KEYS.roster] : [];
}

export async function saveRoster(records) {
  await getStorage().set({ [KEYS.roster]: records || [] });
}

export async function loadOverrides() {
  const data = await getStorage().get(KEYS.overrides);
  return data[KEYS.overrides] && typeof data[KEYS.overrides] === "object" ? data[KEYS.overrides] : {};
}

export async function setHomeClassOverride(campId, studentId, classId, classTime, effectiveAt = "") {
  const overrides = await loadOverrides();
  overrides[overrideKey(campId, studentId)] = {
    classId: String(classId || "").trim(),
    classTime: String(classTime || "").trim(),
    effectiveAt: effectiveAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  await getStorage().set({ [KEYS.overrides]: overrides });
  return overrides;
}

export async function clearHomeClassOverride(campId, studentId) {
  const overrides = await loadOverrides();
  delete overrides[overrideKey(campId, studentId)];
  await getStorage().set({ [KEYS.overrides]: overrides });
  return overrides;
}

export async function loadCache(teacherId, { allowStale = false } = {}) {
  const data = await getStorage().get(KEYS.cache);
  const cache = data[KEYS.cache];
  if (!cache || normalizeId(cache.teacherId) !== normalizeId(teacherId)) return null;
  if (cache.schemaVersion !== CACHE_SCHEMA_VERSION) return null;
  if (!allowStale && Date.now() - Number(cache.savedAt || 0) > CACHE_TTL_MS) return null;
  return cache;
}

export async function saveCache(teacherId, issues, meta = {}) {
  const cache = {
    schemaVersion: CACHE_SCHEMA_VERSION,
    teacherId: normalizeId(teacherId),
    issues: Array.isArray(issues) ? issues : [],
    meta,
    savedAt: Date.now()
  };
  await getStorage().set({ [KEYS.cache]: cache });
  return cache;
}

export async function clearCache() {
  await getStorage().remove(KEYS.cache);
}
