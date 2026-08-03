import { collectAllIssues, loadClassCatalog, loadCrmTeacherIdentity, loadLessonCatalog, resolveLessonEndedAt } from "./crm-adapter.js";
import { issueMonthKey } from "./core.js";

const CODEDOG_ORIGIN = "https://codedog.online";
const CONNECTION_KEY = "crmLearningAlert.rankingConnection";
const CAMP_KEY = "crmLearningAlert.rankingCampId";
const HASHES_KEY = "crmLearningAlert.rankingHashes";
const SLOT_KEY = "crmLearningAlert.rankingLastSlot";
const SCHEDULES = new Set(["11:30", "16:00", "18:30", "21:05"]);

const storage = () => chrome.storage.local;
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
let bootstrapPromise = null;
let activeTransport = null;

async function connection() {
  const data = await storage().get(CONNECTION_KEY);
  return data[CONNECTION_KEY] || null;
}

function apiError(message, status = 0) {
  const error = new Error(message);
  error.status = Number(status || 0);
  return error;
}

async function parseResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json") ? await response.json() : {};
  if (!response.ok) throw apiError(payload.error || `CodeDog 请求失败（${response.status}）`, response.status);
  return payload;
}

async function directRequest(path, options = {}) {
  let response;
  try {
    response = await fetch(`${CODEDOG_ORIGIN}${path}`, {
      method: options.method || "GET",
      headers: options.headers || {},
      body: options.body || undefined,
      credentials: "omit"
    });
  } catch (error) {
    throw apiError(error?.message || "CodeDog 网络请求失败");
  }
  return parseResponse(response);
}

async function backgroundRequest(path, options = {}) {
  const response = await chrome.runtime.sendMessage({
    type: "CODEDOG_API",
    path,
    request: {
      method: options.method || "POST",
      headers: options.headers || {},
      body: options.body || ""
    }
  });
  if (!response?.ok) {
    throw apiError(response?.error || "CodeDog 后台请求失败", response?.status);
  }
  return response.payload;
}

export function codeDogNetworkMessage(error) {
  const message = String(error?.message || error || "");
  if (/failed to fetch|networkerror|load failed|receiving end does not exist|message port closed|网络请求失败/i.test(message)) {
    return "无法连接 CodeDog，请检查网络后重试";
  }
  return message || "无法连接 CodeDog，请稍后重试";
}

export async function selectCodeDogTransport({
  force = false,
  direct = directRequest,
  background = backgroundRequest
} = {}) {
  if (!force && activeTransport) return activeTransport;
  const probeOptions = { method: "GET" };
  try {
    await direct("/api/public/rankings/extension/status", probeOptions);
    activeTransport = { name: "direct", request: direct };
    return activeTransport;
  } catch (directError) {
    try {
      await background("/api/public/rankings/extension/status", probeOptions);
      activeTransport = { name: "background", request: background };
      return activeTransport;
    } catch (backgroundError) {
      activeTransport = null;
      throw apiError(codeDogNetworkMessage(backgroundError || directError));
    }
  }
}

export async function codeDogApi(path, options = {}) {
  const transport = await selectCodeDogTransport();
  try {
    return await transport.request(path, options);
  } catch (error) {
    if (!Number(error?.status || 0)) activeTransport = null;
    throw apiError(codeDogNetworkMessage(error), error?.status);
  }
}

export async function rankingStatus() {
  const current = await connection();
  return {
    connected: Boolean(current?.token),
    deviceId: current?.deviceId || null,
    username: current?.username || "",
    teacherId: current?.teacherId || "",
    crmTeacherId: current?.crmTeacherId || "",
    lastSyncAt: current?.lastSyncAt || "",
    message: current?.lastMessage || ""
  };
}

async function ensureConnection({ force = false } = {}) {
  if (!force && bootstrapPromise) return bootstrapPromise;
  const task = (async () => {
    const identity = await loadCrmTeacherIdentity();
    const current = await connection();
    if (current?.token) {
      try {
        const session = await codeDogApi("/api/public/rankings/extension/session", {
          method: "GET",
          headers: { Authorization: `Bearer ${current.token}` }
        });
        if (session.crmTeacherId === identity.crmTeacherId) {
          const restored = {
            ...current,
            deviceId: session.deviceId,
            username: session.username,
            teacherId: session.teacherId,
            crmTeacherId: session.crmTeacherId,
            lastMessage: "已自动连接"
          };
          await storage().set({ [CONNECTION_KEY]: restored });
          return restored;
        }
      } catch (error) {
        if (error?.status !== 401) throw error;
        await storage().remove(CONNECTION_KEY);
      }
    }
    const result = await codeDogApi("/api/public/rankings/extension/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        crmTeacherId: identity.crmTeacherId,
        deviceName: `CRM 扩展 ${chrome.runtime.getManifest().version}`
      })
    });
    const next = {
      token: result.token,
      deviceId: result.deviceId,
      username: result.username,
      teacherId: result.teacherId,
      crmTeacherId: result.crmTeacherId || identity.crmTeacherId,
      connectedAt: new Date().toISOString(),
      lastSyncAt: current?.crmTeacherId === identity.crmTeacherId ? current.lastSyncAt || "" : "",
      lastMessage: "已自动连接"
    };
    if (current?.crmTeacherId && current.crmTeacherId !== identity.crmTeacherId) {
      await storage().remove(HASHES_KEY);
    }
    await storage().set({ [CONNECTION_KEY]: next });
    return next;
  })();
  if (!force) bootstrapPromise = task;
  try {
    return await task;
  } finally {
    if (bootstrapPromise === task) bootstrapPromise = null;
  }
}

export async function ensureRankingConnection(options = {}) {
  if (options.force) await selectCodeDogTransport({ force: true });
  await ensureConnection(options);
  return rankingStatus();
}

export async function rememberRankingCamp(campId) {
  if (campId) await storage().set({ [CAMP_KEY]: String(campId) });
}

function sumCounts(items = []) {
  return (items || []).reduce((result, item) => ({
    total: result.total + Number(item.total || 0),
    submitted: result.submitted + Number(item.submitted || 0),
    passed: result.passed + Number(item.passed ?? item.submitted ?? 0)
  }), { total: 0, submitted: 0, passed: 0 });
}

export function isTransientSyncError(error) {
  if (error?.name === "AbortError") return true;
  return /failed to fetch|networkerror|network request failed|load failed|err_(?:network|connection|timed_out)|429|(?:^|\D)5\d{2}(?:\D|$)|频繁|超时|网络|连接中断/i
    .test(String(error?.message || error || ""));
}

export async function retrySync(action, {
  attempts = 3,
  baseDelayMs = 1000,
  sleep = wait,
  onRetry = () => {}
} = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return await action(); } catch (error) {
      lastError = error;
      if (!isTransientSyncError(error) || attempt === attempts - 1) throw error;
      const delayMs = baseDelayMs * (2 ** attempt);
      onRetry({ attempt: attempt + 1, nextAttempt: attempt + 2, delayMs, error });
      await sleep(delayMs);
    }
  }
  throw lastError;
}

export async function runSyncStage(label, action, options = {}) {
  try {
    return await retrySync(action, options);
  } catch (error) {
    throw new Error(`${label}失败：${error?.message || "未知错误"}`, { cause: error });
  }
}

async function digest(value) {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function buildRankingImportBatches(payload) {
  const batches = new Map();
  for (const classItem of payload.classes || []) {
    for (const lesson of classItem.lessons || []) {
      if (!(lesson.students || []).length) continue;
      const lessonId = String(lesson.lessonId || "");
      if (!batches.has(lessonId)) {
        batches.set(lessonId, {
          campId: payload.campId,
          campName: payload.campName,
          classes: []
        });
      }
      batches.get(lessonId).classes.push({
        classId: classItem.classId,
        className: classItem.className,
        lessons: [lesson]
      });
    }
  }
  return [...batches.values()];
}

export function rankingSyncMonthKeys(now = new Date()) {
  const current = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(current.getTime())) throw new Error("无法计算积分同步月份");
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(current).map((part) => [part.type, part.value]));
  const year = Number(parts.year);
  const month = Number(parts.month);
  const keys = [`${parts.year}-${parts.month}`];
  if (Number(parts.day) <= 7) {
    const previousYear = month === 1 ? year - 1 : year;
    const previousMonth = month === 1 ? 12 : month - 1;
    keys.push(`${previousYear}-${String(previousMonth).padStart(2, "0")}`);
  }
  return keys;
}

export function selectRankingSyncLessons(lessons, now = new Date()) {
  const monthKeys = new Set(rankingSyncMonthKeys(now));
  return (lessons || []).filter((lesson) => monthKeys.has(issueMonthKey({
    lessonEndedAt: lesson?.endedAt
  })));
}

export async function resolveRankingSyncLessons({
  lessons = [],
  campId,
  classId,
  now = new Date(),
  resolveLessonDate = resolveLessonEndedAt,
  onProgress = () => {}
}) {
  const monthKeys = new Set(rankingSyncMonthKeys(now));
  const resolvedLessons = [];
  const warnings = [];
  let unresolvedCount = 0;
  for (const [index, lesson] of lessons.entries()) {
    let endedAt = lesson?.endedAt || "";
    if (issueMonthKey({ lessonEndedAt: endedAt }) === "unknown") {
      onProgress({
        completed: index,
        total: lessons.length,
        label: `正在识别课节日期：${lesson?.label || lesson?.value || index + 1}`
      });
      try {
        const resolved = await resolveLessonDate({ campId, classId, lessonOption: lesson });
        endedAt = resolved?.endedAt || "";
      } catch (error) {
        warnings.push(`${lesson?.label || lesson?.value || "未知课节"}：${error?.message || "日期读取失败"}`);
      }
    }
    const monthKey = issueMonthKey({ lessonEndedAt: endedAt });
    if (monthKey === "unknown") unresolvedCount += 1;
    else if (monthKeys.has(monthKey)) resolvedLessons.push({ ...lesson, endedAt });
  }
  if (unresolvedCount) warnings.push(`${unresolvedCount} 个课节无法识别上课时间，已跳过`);
  return { lessons: resolvedLessons, warnings, unresolvedCount };
}

export function noRankingSyncLessonsMessage(syncMonths, unresolvedCount = 0) {
  const prefix = `同步月份 ${syncMonths.join("、")}`;
  if (unresolvedCount) {
    return `${prefix} 没有确认属于目标月份的课节；另有 ${unresolvedCount} 个课节无法识别上课时间`;
  }
  return `${prefix} 没有已上课课节`;
}

export async function syncRankingCamp({ campId, roster, overrides, force = false, onProgress = () => {}, now = new Date() }) {
  let current = await ensureConnection();
  const selectedCampId = String(campId || "").trim();
  if (!selectedCampId) throw new Error("请先选择需要同步的训练营");
  await rememberRankingCamp(selectedCampId);

  onProgress({ completed: 0, total: 0, label: "正在读取 CRM 班级和课节目录" });
  const [classCatalog, lessonCatalog] = await Promise.all([
    runSyncStage("读取 CRM 班级目录", () => loadClassCatalog(selectedCampId), {
      onRetry: ({ nextAttempt }) => onProgress({ completed: 0, total: 0, label: `班级目录读取失败，正在第 ${nextAttempt} 次重试` })
    }),
    runSyncStage("读取 CRM 课节目录", () => loadLessonCatalog(selectedCampId), {
      onRetry: ({ nextAttempt }) => onProgress({ completed: 0, total: 0, label: `课节目录读取失败，正在第 ${nextAttempt} 次重试` })
    })
  ]);
  const syncMonths = rankingSyncMonthKeys(now);
  const dateResolution = await resolveRankingSyncLessons({
    lessons: lessonCatalog.lessons,
    campId: selectedCampId,
    classId: classCatalog.classes[0]?.value,
    now,
    onProgress
  });
  const syncLessons = dateResolution.lessons;
  if (!syncLessons.length) {
    throw new Error(noRankingSyncLessonsMessage(syncMonths, dateResolution.unresolvedCount));
  }
  onProgress({ completed: 0, total: 0, label: `同步范围：${syncMonths.join("、")}` });
  const classes = [];
  const total = classCatalog.classes.length * syncLessons.length;
  let completed = 0;
  const warnings = [...dateResolution.warnings];

  for (const classOption of classCatalog.classes) {
    const lessons = [];
    for (const [lessonIndex, lessonOption] of syncLessons.entries()) {
      onProgress({ completed, total, label: `${classOption.label} / ${lessonOption.label}` });
      try {
        const stageLabel = `读取 ${classOption.label} / ${lessonOption.label}`;
        const result = await runSyncStage(stageLabel, () => collectAllIssues({
            roster,
            overrides,
            campId: selectedCampId,
            classId: classOption.value,
            lessonIds: [lessonOption.value],
            onProgress: () => {}
          }), {
            onRetry: ({ nextAttempt }) => onProgress({
              completed,
              total,
              label: `${classOption.label} / ${lessonOption.label} 读取失败，正在第 ${nextAttempt} 次重试`
            })
          });
        lessons.push({
          lessonId: String(lessonOption.value),
          lessonName: lessonOption.label,
          lessonOrder: syncLessons.length - lessonIndex,
          endedAt: lessonOption.endedAt || null,
          students: result.issues.map((row) => ({
            studentId: row.studentId,
            studentName: row.studentName,
            completionRate: row.completionRate ?? 0,
            inclass: sumCounts(row.inClassHomework),
            homework: sumCounts(row.homework)
          }))
        });
      } catch (error) {
        warnings.push(error.message);
      }
      completed += 1;
      onProgress({ completed, total, label: `${classOption.label} / ${lessonOption.label}` });
      await wait(600);
    }
    classes.push({ classId: String(classOption.value), className: classOption.label, lessons });
  }

  const payload = {
    campId: selectedCampId,
    campName: classCatalog.camp.label,
    classes
  };
  const rowCount = classes.reduce((count, item) => count + item.lessons.reduce((sum, lesson) => sum + lesson.students.length, 0), 0);
  if (!rowCount) throw new Error(warnings[0] || "当前训练营没有可同步的学情数据");
  const hash = await digest(JSON.stringify(payload));
  const stored = await storage().get(HASHES_KEY);
  const hashes = stored[HASHES_KEY] || {};
  let result = { changedRows: 0, unchangedRows: rowCount, rejectedRows: 0, skipped: true };
  const hashKey = `${current.crmTeacherId}:${selectedCampId}`;
  if (force || hashes[hashKey] !== hash) {
    const importBatches = buildRankingImportBatches(payload);
    result = { changedRows: 0, unchangedRows: 0, rejectedRows: 0, skipped: false, batchCount: importBatches.length };
    for (const [batchIndex, importPayload] of importBatches.entries()) {
      const batchNumber = batchIndex + 1;
      const batchLabel = `上传 CodeDog 积分（${batchNumber}/${importBatches.length}）`;
      onProgress({ completed: total, total, label: batchLabel });
      const batchResult = await runSyncStage(batchLabel, async () => {
        const upload = () => codeDogApi("/api/public/rankings/extension/import", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${current.token}` },
          body: JSON.stringify(importPayload)
        });
        try {
          return await upload();
        } catch (error) {
          if (error?.status !== 401) throw error;
          current = await ensureConnection({ force: true });
          return upload();
        }
      }, {
          onRetry: ({ nextAttempt }) => onProgress({
            completed: total,
            total,
            label: `${batchLabel}失败，正在第 ${nextAttempt} 次重试`
          })
      });
      result.changedRows += Number(batchResult.changedRows || 0);
      result.unchangedRows += Number(batchResult.unchangedRows || 0);
      result.rejectedRows += Number(batchResult.rejectedRows || 0);
    }
    hashes[hashKey] = hash;
    await storage().set({ [HASHES_KEY]: hashes });
  }
  const lastSyncAt = new Date().toISOString();
  const monthLabel = syncMonths.join("、");
  const lastMessage = warnings.length ? `同步 ${monthLabel} 完成，${warnings.length} 个课节读取失败` : `同步 ${monthLabel} 完成`;
  await storage().set({ [CONNECTION_KEY]: { ...current, lastSyncAt, lastMessage } });
  return { ...result, rowCount, warnings, syncMonths, lastSyncAt, message: lastMessage };
}

function chinaSlot(now = new Date()) {
  const values = Object.fromEntries(new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  }).formatToParts(now).map((part) => [part.type, part.value]));
  return { date: `${values.year}-${values.month}-${values.day}`, time: `${values.hour}:${values.minute}` };
}

export function startRankingScheduler({ getRoster, getOverrides, onState }) {
  let running = false;
  const check = async () => {
    if (running) return;
    const slot = chinaSlot();
    if (!SCHEDULES.has(slot.time)) return;
    const key = `${slot.date} ${slot.time}`;
    const data = await storage().get([SLOT_KEY, CAMP_KEY]);
    if (data[SLOT_KEY] === key || !data[CAMP_KEY]) return;
    running = true;
    await storage().set({ [SLOT_KEY]: key });
    onState({ syncing: true, message: `定时同步 ${slot.time}` });
    try {
      const result = await syncRankingCamp({ campId: data[CAMP_KEY], roster: getRoster(), overrides: getOverrides(), onProgress: ({ label }) => onState({ syncing: true, message: label }) });
      onState({ ...(await rankingStatus()), syncing: false, message: result.message });
    } catch (error) {
      onState({ ...(await rankingStatus()), syncing: false, message: error.message || "定时同步失败" });
    } finally { running = false; }
  };
  check();
  const timer = setInterval(check, 30_000);
  return () => clearInterval(timer);
}
