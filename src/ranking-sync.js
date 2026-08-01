import { collectAllIssues, loadClassCatalog, loadLessonCatalog } from "./crm-adapter.js";

const CODEDOG_ORIGIN = "https://codedog.online";
const CONNECTION_KEY = "crmLearningAlert.rankingConnection";
const CAMP_KEY = "crmLearningAlert.rankingCampId";
const HASHES_KEY = "crmLearningAlert.rankingHashes";
const SLOT_KEY = "crmLearningAlert.rankingLastSlot";
const SCHEDULES = new Set(["11:30", "16:00", "18:30", "21:05"]);

const storage = () => chrome.storage.local;
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function connection() {
  const data = await storage().get(CONNECTION_KEY);
  return data[CONNECTION_KEY] || null;
}

async function api(path, options = {}) {
  const response = await fetch(`${CODEDOG_ORIGIN}${path}`, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `CodeDog 请求失败（${response.status}）`);
  return payload;
}

export async function rankingStatus() {
  const current = await connection();
  return {
    connected: Boolean(current?.token),
    deviceId: current?.deviceId || null,
    lastSyncAt: current?.lastSyncAt || "",
    message: current?.lastMessage || ""
  };
}

export async function connectRanking(code) {
  const normalized = String(code || "").replace(/[^0-9]/g, "");
  if (normalized.length !== 8) throw new Error("请输入 8 位连接码");
  const result = await api("/api/public/rankings/extension/connect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: normalized, deviceName: `CRM 扩展 ${chrome.runtime.getManifest().version}` })
  });
  await storage().set({
    [CONNECTION_KEY]: { token: result.token, deviceId: result.deviceId, connectedAt: new Date().toISOString() }
  });
  return rankingStatus();
}

export async function disconnectRanking() {
  await storage().remove([CONNECTION_KEY, HASHES_KEY]);
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

async function retry(action) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { return await action(); } catch (error) {
      lastError = error;
      if (!/429|频繁|超时|网络|5\d\d/.test(String(error?.message || "")) || attempt === 2) throw error;
      await wait(1000 * (2 ** attempt));
    }
  }
  throw lastError;
}

async function digest(value) {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function syncRankingCamp({ campId, roster, overrides, force = false, onProgress = () => {} }) {
  const current = await connection();
  if (!current?.token) throw new Error("请先连接 CodeDog 积分系统");
  const selectedCampId = String(campId || "").trim();
  if (!selectedCampId) throw new Error("请先选择需要同步的训练营");
  await rememberRankingCamp(selectedCampId);

  const [classCatalog, lessonCatalog] = await Promise.all([
    loadClassCatalog(selectedCampId),
    loadLessonCatalog(selectedCampId)
  ]);
  const classes = [];
  const total = classCatalog.classes.length * lessonCatalog.lessons.length;
  let completed = 0;
  const warnings = [];

  for (const classOption of classCatalog.classes) {
    const lessons = [];
    for (const [lessonIndex, lessonOption] of lessonCatalog.lessons.entries()) {
      onProgress({ completed, total, label: `${classOption.label} / ${lessonOption.label}` });
      try {
        const result = await retry(() => collectAllIssues({
          roster,
          overrides,
          campId: selectedCampId,
          classId: classOption.value,
          lessonIds: [lessonOption.value],
          onProgress: () => {}
        }));
        lessons.push({
          lessonId: String(lessonOption.value),
          lessonName: lessonOption.label,
          lessonOrder: lessonCatalog.lessons.length - lessonIndex,
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
        warnings.push(`${classOption.label} / ${lessonOption.label}：${error.message}`);
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
  if (force || hashes[selectedCampId] !== hash) {
    result = await api("/api/public/rankings/extension/import", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${current.token}` },
      body: JSON.stringify(payload)
    });
    hashes[selectedCampId] = hash;
    await storage().set({ [HASHES_KEY]: hashes });
  }
  const lastSyncAt = new Date().toISOString();
  const lastMessage = warnings.length ? `同步完成，${warnings.length} 个课节读取失败` : "同步完成";
  await storage().set({ [CONNECTION_KEY]: { ...current, lastSyncAt, lastMessage } });
  return { ...result, rowCount, warnings, lastSyncAt, message: lastMessage };
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
