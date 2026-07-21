import { buildIssues, hasCategoryWorkIssue, inferLessonEndedAt, issueMonthKey, normalizeId, normalizeText, parseDate } from "./core.js";

const CHANNEL = "crm-learning-alert:v1";
const REQUEST_TIMEOUT_MS = 20000;
const LESSON_REQUEST_CONCURRENCY = 5;
const PAGE_REQUEST_CONCURRENCY = 4;

function walkObjects(root, visitor, maxDepth = 6) {
  const queue = [{ value: root, depth: 0, parent: null, key: "" }];
  const seen = new Set();
  while (queue.length) {
    const current = queue.shift();
    const value = current.value;
    if (!value || typeof value !== "object" || seen.has(value) || current.depth > maxDepth) continue;
    seen.add(value);
    visitor(value, current);
    if (Array.isArray(value)) {
      value.forEach((child, index) => queue.push({ value: child, depth: current.depth + 1, parent: value, key: String(index) }));
    } else {
      Object.entries(value).forEach(([key, child]) => queue.push({ value: child, depth: current.depth + 1, parent: value, key }));
    }
  }
}

function firstValue(object, keys) {
  for (const key of keys) {
    const value = object?.[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return "";
}

function firstDate(object, keys) {
  for (const key of keys) {
    const value = object?.[key];
    if (parseDate(value)) return value;
  }
  return "";
}

function primitiveFields(object, expression) {
  const result = {};
  for (const [key, value] of Object.entries(object || {})) {
    if (expression.test(key) && ["string", "number"].includes(typeof value)) result[key] = value;
  }
  return result;
}

export class BridgeClient {
  constructor() {
    this.pending = new Map();
    this.captures = {};
    this.sequence = 0;
    window.addEventListener("message", (event) => this.handleMessage(event));
  }

  handleMessage(event) {
    const message = event.data;
    if (event.source !== window || message?.channel !== CHANNEL || message.direction !== "from-page") return;
    if (message.type === "CAPTURE" && message.capture?.kind) this.captures[message.capture.kind] = message.capture;
    if (message.type !== "RESPONSE") return;
    const pending = this.pending.get(String(message.requestId));
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(String(message.requestId));
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(message.error || "CRM 页面查询失败"));
  }

  request(type, payload = {}) {
    const requestId = `${Date.now()}-${this.sequence += 1}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("CRM 页面响应超时，请刷新页面后重试"));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, reject, timer });
      window.postMessage({ channel: CHANNEL, direction: "to-page", requestId, type, ...payload }, location.origin);
    });
  }

  async state() {
    const state = await this.request("STATE_REQUEST");
    this.captures = { ...(state.captures || {}), ...this.captures };
    return { ...state, captures: this.captures };
  }

  replay(kind, params) {
    return this.request("REPLAY_REQUEST", { kind, params });
  }
}

let sharedBridge = null;

function getBridge() {
  if (!sharedBridge) sharedBridge = new BridgeClient();
  return sharedBridge;
}

function entityArrays(root) {
  const arrays = [];
  walkObjects(root, (value, current) => {
    if (Array.isArray(value) && value.length && value.some((item) => item && typeof item === "object" && !Array.isArray(item))) {
      arrays.push({ values: value, parent: current.parent, key: current.key });
    }
  });
  return arrays;
}

function campScore(item) {
  if (!item || typeof item !== "object") return 0;
  const keys = Object.keys(item).join(" ").toLowerCase();
  let score = 0;
  if (/campid|camp_id/.test(keys)) score += 5;
  if (/campname|camp_name/.test(keys)) score += 4;
  if (/starttime|endtime|status|phase/.test(keys)) score += 1;
  return score;
}

export function extractCamps(payload) {
  const candidates = entityArrays(payload)
    .map(({ values }) => ({ values, score: values.slice(0, 5).reduce((sum, item) => sum + campScore(item), 0) }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score);
  const combined = candidates.flatMap((candidate) => candidate.values);
  const byId = new Map();
  for (const raw of combined) {
    const id = normalizeId(firstValue(raw, ["campId", "camp_id", "id"]));
    const name = normalizeText(firstValue(raw, ["campName", "camp_name", "name", "title"]));
    if (!id || !name || byId.has(id)) continue;
    const nestedState = raw.liveCampState || raw.campState || {};
    const status = normalizeText(firstValue(raw, ["campStatusName", "statusName", "campStatus", "status", "phase"]) || firstValue(nestedState, ["name", "desc"]));
    const endedAt = firstDate(raw, ["endTime", "campEndTime", "endedAt", "endDate"]);
    const explicitlyClosed = /结营|已结束|结束|closed|finished|ended|^end$/i.test(status);
    const active = !explicitlyClosed && (!endedAt || parseDate(endedAt) >= new Date());
    byId.set(id, { id, name, status, active, raw });
  }
  return [...byId.values()].filter((camp) => camp.active);
}

function lessonScore(item) {
  if (!item || typeof item !== "object") return 0;
  const keys = Object.keys(item).join(" ").toLowerCase();
  let score = 0;
  if (/lessonid|lessonids|camp.*lesson.*id|course.*lesson.*id|lbkcourseid/.test(keys)) score += 5;
  if (/lessonname|coursename|lesson_name|lbkcoursename/.test(keys)) score += 4;
  if (/starttime|endtime|lessondate|classtime/.test(keys)) score += 2;
  return score;
}

export function extractLessons(payload) {
  const candidates = entityArrays(payload)
    .map(({ values }) => ({ values, score: values.slice(0, 5).reduce((sum, item) => sum + lessonScore(item), 0) }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!candidates.length) return [];
  const byId = new Map();
  for (const raw of candidates[0].values) {
    const id = normalizeId(firstValue(raw, ["lbkCourseId", "campLessonId", "lessonId", "courseLessonId", "id"]));
    const name = normalizeText(firstValue(raw, ["lbkCourseName", "lessonName", "courseName", "name", "title"]));
    if (!id || !name) continue;
    let endedAt = firstDate(raw, [
      "lessonEndTime", "classEndTime", "courseEndTime", "endTime", "endedAt",
      "lessonStartTime", "classStartTime", "courseStartTime", "liveStartTime", "startTime", "beginTime",
      "lessonDate", "classDate", "courseDate", "startDate"
    ]);
    if (!endedAt) {
      walkObjects(raw, (value) => {
        if (endedAt || Array.isArray(value)) return;
        for (const [key, child] of Object.entries(value)) {
          const normalizedKey = key.replace(/[_-]/g, "").toLowerCase();
          if (/^(lesson|class|course|live)?(end|start|begin)(time|at|date)$/.test(normalizedKey) && parseDate(child)) {
            endedAt = child;
            break;
          }
        }
      }, 3);
    }
    const requestFields = {
      ...primitiveFields(raw, /(lesson|course).*id|id.*(lesson|course)|lessonname|coursename/i),
      id,
      lessonId: firstValue(raw, ["lessonId", "campLessonId", "courseLessonId", "id"]),
      campLessonId: firstValue(raw, ["campLessonId", "lessonId", "id"]),
      courseLessonId: firstValue(raw, ["courseLessonId", "lessonId", "id"]),
      courseId: firstValue(raw, ["courseId"]),
      lbkCourseId: firstValue(raw, ["lbkCourseId", "courseId"]),
      lessonIds: Array.isArray(raw.lessonIds) ? raw.lessonIds : [],
      name,
      lessonName: name
    };
    byId.set(id, { id, name, endedAt, requestFields, raw });
  }
  return [...byId.values()];
}

export function extractClasses(payload) {
  const candidates = entityArrays(payload)
    .map(({ values }) => ({
      values,
      score: values.slice(0, 5).reduce((sum, item) => {
        const keys = Object.keys(item || {}).join(" ").toLowerCase();
        return sum + (/classid|classname/.test(keys) ? 3 : 0) + (/time|week|schedule/.test(keys) ? 2 : 0);
      }, 0)
    }))
    .sort((a, b) => b.score - a.score);
  const classes = new Map();
  for (const raw of candidates[0]?.values || []) {
    const className = normalizeText(firstValue(raw, ["className", "classCode", "liveClassName", "name"]));
    const classId = normalizeId(firstValue(raw, ["classId", "liveClassId", "id"]));
    const aliases = [...new Set([
      classId,
      raw?.className,
      raw?.classCode,
      raw?.liveClassName,
      raw?.name
    ].map(normalizeText).filter(Boolean))];
    const directTime = normalizeText(firstValue(raw, [
      "classTimeDesc", "classTime", "weeklyClassTime", "scheduleTime", "classSchedule",
      "liveClassTime", "courseTime", "startClassTime", "classStartTime"
    ]));
    const week = normalizeText(firstValue(raw, ["weekDesc", "weekName", "weekDayName", "dayOfWeek"]));
    const start = normalizeText(firstValue(raw, ["startTime", "beginTime", "startClock"]));
    const classTime = directTime || [week, start].filter(Boolean).join(" ");
    const id = classId || className;
    const name = className || classId;
    if (id && name && !classes.has(id)) classes.set(id, { id, name, time: classTime, aliases, raw });
  }
  return [...classes.values()];
}

export function extractClassSchedules(payload) {
  const schedules = new Map();
  for (const item of extractClasses(payload)) {
    schedules.set(item.id, item.time);
    schedules.set(item.name, item.time);
  }
  return schedules;
}

function studentScore(item) {
  if (!item || typeof item !== "object") return 0;
  const keys = Object.keys(item).join(" ").toLowerCase();
  let score = 0;
  if (/studentid|student.*user.*id|userid|accountid/.test(keys)) score += 5;
  if (/studentname|username|realname/.test(keys)) score += 3;
  if (/classname|classcode|attendance|attend|homework|afterclass/.test(keys)) score += 2;
  return score;
}

function extractStudentArray(payload) {
  const candidates = entityArrays(payload)
    .map((candidate) => ({ ...candidate, score: candidate.values.slice(0, 5).reduce((sum, item) => sum + studentScore(item), 0) }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score);
  return candidates[0] || { values: [], parent: null };
}

function parseHomeworkText(text) {
  const items = [];
  const normalized = normalizeText(text);
  const expression = /([^\s]+题)[^\d]{0,20}提交\s*(\d+)\s*\/\s*(\d+)/g;
  let match;
  while ((match = expression.exec(normalized))) {
    items.push({ type: match[1], submitted: Number(match[2]), total: Number(match[3]) });
  }
  return items;
}

function homeworkFromValue(value, fallbackType = "作业", depth = 0) {
  if (depth > 5 || value == null) return [];
  if (typeof value === "string") return parseHomeworkText(value);
  if (Array.isArray(value)) return value.flatMap((item) => homeworkFromValue(item, fallbackType, depth + 1));
  if (typeof value !== "object") return [];

  let submitted = firstValue(value, ["submitted", "submitCount", "finishedCount", "finishCount", "completedCount"]);
  let total = firstValue(value, ["total", "totalCount", "questionCount", "count"]);
  const completed = firstValue(value, ["completed", "isCompleted", "finished", "isFinished", "finishStatus", "status"]);
  if (submitted === "" && total === "" && completed !== "" && /^(?:0|1|true|false|完成|未完成|finished|unfinished)$/i.test(normalizeText(completed))) {
    const isComplete = completed === true || completed === 1 || completed === "1" || /^(?:完成|finished|true)$/i.test(normalizeText(completed));
    submitted = isComplete ? 1 : 0;
    total = 1;
  }
  const own = [];
  if (submitted !== "" && total !== "" && Number.isFinite(Number(submitted)) && Number.isFinite(Number(total))) {
    const passed = firstValue(value, ["passed", "passCount", "right", "rightCount", "correctCount"]);
    own.push({
      type: normalizeText(firstValue(value, [
        "itemName", "homeworkName", "assignmentName", "taskName", "questionTypeName",
        "typeName", "name", "title", "label"
      ])) || fallbackType,
      submitted: Number(submitted),
      total: Number(total),
      passed: Number(passed === "" ? submitted : passed)
    });
  }
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "object" && child) own.push(...homeworkFromValue(child, normalizeText(key) || fallbackType, depth + 1));
    else if (typeof child === "string") own.push(...parseHomeworkText(child));
  }
  return own;
}

function exactHomeworkItems(record, groups) {
  return groups.flatMap(([type, rightKeys, finishKeys, allKeys]) => {
    const allKey = allKeys.find((key) => Object.prototype.hasOwnProperty.call(record || {}, key));
    if (!allKey) return [];
    const rightKey = rightKeys.find((key) => Object.prototype.hasOwnProperty.call(record || {}, key));
    const finishKey = finishKeys.find((key) => Object.prototype.hasOwnProperty.call(record || {}, key));
    return [{
      type,
      submitted: Number(finishKey ? record[finishKey] || 0 : 0),
      total: Number(record[allKey] || 0),
      passed: Number(rightKey ? record[rightKey] || 0 : 0)
    }];
  });
}

export function extractInClassHomework(record) {
  const exactGroups = [
    ["创作题", ["creationClassinRightHomework", "creationClassInRightHomework", "creationInclassRightHomework", "creationInClassRightHomework", "creationRightHomework"], ["creationClassinFinishHomework", "creationClassInFinishHomework", "creationInclassFinishHomework", "creationInClassFinishHomework", "creationFinishHomework"], ["creationClassinAllHomework", "creationClassInAllHomework", "creationInclassAllHomework", "creationInClassAllHomework", "creationAllHomework"]],
    ["OJ题", ["ojClassinRightHomework", "ojClassInRightHomework", "ojInclassRightHomework", "ojInClassRightHomework", "ojRightHomework"], ["ojClassinFinishHomework", "ojClassInFinishHomework", "ojInclassFinishHomework", "ojInClassFinishHomework", "ojFinishHomework"], ["ojClassinAllHomework", "ojClassInAllHomework", "ojInclassAllHomework", "ojInClassAllHomework", "ojAllHomework"]],
    ["客观题", ["ptClassinRightHomework", "ptClassInRightHomework", "ptInclassRightHomework", "ptInClassRightHomework", "ptRightHomework"], ["ptClassinFinishHomework", "ptClassInFinishHomework", "ptInclassFinishHomework", "ptInClassFinishHomework", "ptFinishHomework"], ["ptClassinAllHomework", "ptClassInAllHomework", "ptInclassAllHomework", "ptInClassAllHomework", "ptAllHomework"]]
  ];
  const roots = [];
  for (const [key, value] of Object.entries(record || {})) {
    if (/in.?class|during.?class|classwork|课上作业|课堂作业/i.test(key)) {
      roots.push([key, value]);
    }
  }
  const items = [
    ...exactHomeworkItems(record, exactGroups),
    ...roots.flatMap(([key, value]) => homeworkFromValue(value, normalizeText(key)))
  ];
  const unique = new Map();
  for (const item of items) {
    const signature = `${item.type}:${item.submitted}:${item.total}:${item.passed}`;
    if (!unique.has(signature)) unique.set(signature, item);
  }
  return [...unique.values()];
}

export function extractHomework(record) {
  const exactGroups = [
    ["创作题", "creationAfterclassRightHomework", "creationAfterclassFinishHomework", "creationAfterclassAllHomework"],
    ["OJ题", "ojAfterclassRightHomework", "ojAfterclassFinishHomework", "ojAfterclassAllHomework"],
    ["客观题", "ptAfterclassRightHomework", "ptAfterclassFinishHomework", "ptAfterclassAllHomework"]
  ];
  const exactItems = exactGroups.flatMap(([type, rightKey, finishKey, allKey]) => {
    if (record?.[allKey] === undefined) return [];
    return [{
      type,
      submitted: Number(record[finishKey] || 0),
      total: Number(record[allKey] || 0),
      passed: Number(record[rightKey] || 0)
    }];
  });
  const roots = [];
  for (const [key, value] of Object.entries(record || {})) {
    if (/afterclass(?:tz|tzk)|in.?class|during.?class|classwork|课上作业|课堂作业/i.test(key)) continue;
    if (/homework|after.?class|after.?course|coursework|课后作业/i.test(key)) roots.push([key, value]);
  }
  const items = [...exactItems, ...roots.flatMap(([key, value]) => homeworkFromValue(value, normalizeText(key)))];
  const unique = new Map();
  for (const item of items) {
    const signature = `${item.type}:${item.submitted}:${item.total}`;
    if (!unique.has(signature)) unique.set(signature, item);
  }
  return [...unique.values()];
}

export function extractExtensions(record) {
  const exactGroups = [
    ["创作题", "creationAfterclassTzRightHomework", "creationAfterclassTzFinishHomework", "creationAfterclassTzAll"],
    ["OJ题", "ojAfterclassTzkRightHomework", "ojAfterclassTzkFinishHomework", "ojAfterclassTzkAll"],
    ["客观题", "ptAfterclassTzkRightHomework", "ptAfterclassTzFinishHomework", "ptAfterclassTzkAll"]
  ];
  const exactItems = exactGroups.flatMap(([type, rightKey, finishKey, allKey]) => {
    if (record?.[allKey] === undefined) return [];
    return [{
      type,
      submitted: Number(record[finishKey] || 0),
      total: Number(record[allKey] || 0),
      passed: Number(record[rightKey] || 0)
    }];
  });
  const roots = [];
  for (const [key, value] of Object.entries(record || {})) {
    if (/afterclass(?:tz|tzk)|extension|expand|课后拓展/i.test(key)) roots.push([key, value]);
  }
  const items = [...exactItems, ...roots.flatMap(([key, value]) => homeworkFromValue(value, normalizeText(key)))];
  const unique = new Map();
  for (const item of items) {
    const signature = `${item.type}:${item.submitted}:${item.total}:${item.passed}`;
    if (!unique.has(signature)) unique.set(signature, item);
  }
  return [...unique.values()];
}

function normalizeAttendance(raw) {
  const value = firstValue(raw, [
    "attendanceTime", "attendTime", "firstEnterTime", "enterTime", "joinTime", "classInTime",
    "attendanceAt", "attendDuration", "attendance"
  ]);
  if (raw?.attendFlag === 1 || raw?.attendFlag === "1") {
    return normalizeText(firstValue(raw, ["studentInClassTimeStr", "studentJoinTime", "joinClassTime"])) || "已到课";
  }
  if (raw?.attendFlag === 0 || raw?.attendFlag === "0") return "";
  if (value === true || value === 1 || value === "1") return "已到课";
  if (value === false || value === 0 || value === "0") return "";
  return normalizeText(value);
}

export function normalizeCompletionRate(raw) {
  const explicitKeys = [
    "lessonFinishRate", "courseFinishRate", "classFinishRate", "finishLessonRate", "finishCourseRate",
    "finishClassRate", "lessonCompletionRate", "courseCompletionRate", "completionRate", "completeRate",
    "finishRate", "lessonFinishPercent", "courseFinishPercent", "finishPercent", "completePercent",
    "lessonProgress", "courseProgress", "learningProgress", "是否完课", "完课率"
  ];
  let value = firstValue(raw, explicitKeys);
  if (value === "") {
    for (const [key, child] of Object.entries(raw || {})) {
      const normalizedKey = key.replace(/[_-]/g, "").toLowerCase();
      if (/homework|afterclass/.test(normalizedKey)) continue;
      if (/(?:finish|complete|completion).*(?:rate|percent|progress)$|(?:rate|percent|progress).*(?:finish|complete|completion)$/.test(normalizedKey)) {
        value = child;
        break;
      }
    }
  }
  if (value === true) return 100;
  if (value === false) return 0;
  const match = normalizeText(value).match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

export function normalizeStudentRecord(raw) {
  const adjustmentState = raw?.adjustmentState;
  const transferStatus = adjustmentState === 0 || adjustmentState === "0"
    ? "正常"
    : adjustmentState === 1 || adjustmentState === "1"
      ? "调课"
      : adjustmentState !== undefined && adjustmentState !== null
        ? "已完成"
        : normalizeText(firstValue(raw, ["transferStatusName", "adjustStatusName", "transferStatus", "adjustStatus", "classChangeStatus"]));
  return {
    studentId: normalizeId(firstValue(raw, ["studentId", "studentUserId", "studentUid", "userId", "accountId", "userCode", "id"])),
    studentName: normalizeText(firstValue(raw, ["studentName", "userName", "realName", "studentNickName", "name"])),
    currentClassId: normalizeText(firstValue(raw, ["classCode", "className", "currentClassCode", "currentClassName", "attendClassName", "classId"])),
    currentClassTime: normalizeText(firstValue(raw, ["classTime", "courseTime", "scheduleTime", "classSchedule", "attendTimeSlot"])),
    transferStatus,
    attendanceAt: normalizeAttendance(raw),
    completionRate: normalizeCompletionRate(raw),
    inClassHomework: extractInClassHomework(raw),
    homework: extractHomework(raw),
    extensions: extractExtensions(raw),
    raw
  };
}

function extractTotal(payload, rowCount) {
  let total = rowCount;
  walkObjects(payload, (value) => {
    if (Array.isArray(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (/^(total|totalcount|recordcount)$/i.test(key) && Number.isFinite(Number(child))) total = Math.max(total, Number(child));
    }
  }, 4);
  return total;
}

function extractPageSize(payload, rowCount) {
  let pageSize = 0;
  walkObjects(payload, (value) => {
    if (pageSize || Array.isArray(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (/^(pagesize|size|limit)$/i.test(key) && Number.isFinite(Number(child)) && Number(child) > 0) {
        pageSize = Number(child);
        break;
      }
    }
  }, 4);
  return pageSize || rowCount;
}

export function extractStudentPage(payload) {
  const candidate = extractStudentArray(payload);
  const records = candidate.values.map(normalizeStudentRecord).filter((record) => record.studentId);
  return { records, total: extractTotal(payload, records.length), pageSize: extractPageSize(payload, records.length) };
}

export function findLessonEndedAt(payload, records = []) {
  for (const record of records) {
    const value = firstDate(record.raw || record, ["lessonEndTime", "classEndTime", "courseEndTime", "endedAt", "endTime"]);
    if (value) return value;
  }
  let result = "";
  walkObjects(payload, (value) => {
    if (result || Array.isArray(value)) return;
    result = firstDate(value, ["lessonEndTime", "classEndTime", "courseEndTime", "endedAt"]);
  }, 4);
  return result;
}

export function findDataUpdatedAt(payload) {
  let result = "";
  walkObjects(payload, (value) => {
    if (result || Array.isArray(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (/^(dataupdatetime|updatedataat|lastupdatetime|updatetime)$/i.test(key) && parseDate(child)) {
        result = child;
        break;
      }
    }
  }, 5);
  return result;
}

function teacherIdFromState(state) {
  for (const capture of Object.values(state.captures || {})) {
    try {
      const id = new URL(capture.url).searchParams.get("internalTeacherId");
      if (id) return id;
    } catch {
      // Continue searching other captured requests.
    }
  }
  for (const entry of performance.getEntriesByType?.("resource") || []) {
    try {
      const id = new URL(entry.name).searchParams.get("internalTeacherId");
      if (id) return id;
    } catch {
      // Ignore non-URL performance entries.
    }
  }
  return "";
}

async function loadCrmContext() {
  const bridge = getBridge();
  const state = await bridge.state();
  const teacherId = teacherIdFromState(state);
  if (!teacherId) throw new Error("无法识别当前教师，请确认已登录并刷新 CRM 工作台");
  const campCapture = state.captures?.campInfo || state.captures?.courseCampInfo;
  if (!campCapture?.data) throw new Error("未读取到在读营期，请刷新 CRM 工作台后重试");
  const camps = extractCamps(campCapture.data);
  if (!camps.length) throw new Error("当前账号没有可识别的在读营期");
  return { bridge, state, teacherId, camps };
}

export async function loadCampCatalog() {
  const { teacherId, camps } = await loadCrmContext();
  return {
    teacherId,
    camps: camps.map((camp) => ({ value: camp.id, label: camp.name }))
  };
}

export async function loadClassCatalog(campId) {
  const { bridge, teacherId, camps } = await loadCrmContext();
  const selectedCampId = normalizeId(campId);
  const camp = camps.find((item) => item.id === selectedCampId);
  if (!camp) throw new Error("选择的营期不存在或已经结营");
  const response = await bridge.replay("courseCampInfo", { teacherId, campId: camp.id, allClasses: true });
  let classes = extractClasses(response.data);
  if (!classes.length) {
    const records = await fetchLearningSituation(bridge, teacherId, camp);
    const fallback = new Map();
    for (const record of records) {
      if (record.currentClassId && !fallback.has(record.currentClassId)) {
        fallback.set(record.currentClassId, { id: record.currentClassId, name: record.currentClassId, time: record.currentClassTime || "" });
      }
    }
    classes = [...fallback.values()];
  }
  if (!classes.length) throw new Error("该营期下没有可识别的班级");
  return {
    teacherId,
    camp: { value: camp.id, label: camp.name },
    classes: classes.map((item) => ({ value: item.id, label: item.name, className: item.name, time: item.time }))
  };
}

export async function loadLessonCatalog(campId) {
  const { bridge, state, teacherId, camps } = await loadCrmContext();
  const selectedCampId = normalizeId(campId);
  const camp = camps.find((item) => item.id === selectedCampId);
  if (!camp) throw new Error("选择的营期不存在或已经结营");
  if (!state.templates?.lessons) {
    throw new Error("CRM 课节查询尚未初始化，请刷新工作台后重试");
  }
  const response = await bridge.replay("lessons", { teacherId, campId: camp.id, allClasses: true });
  const lessonJobs = extractLessons(response.data).map((lesson) => ({ camp, lesson }));
  const lessons = lessonOptionsFromJobs(lessonJobs);
  if (!lessons.length) throw new Error("该营期下没有可识别的课节");
  return {
    teacherId,
    camp: { value: camp.id, label: camp.name },
    lessons
  };
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

function lessonIdentityValues(lesson) {
  const fields = lesson?.requestFields || {};
  return [
    lesson?.id,
    fields.id,
    fields.lessonId,
    fields.campLessonId,
    fields.courseLessonId,
    fields.lbkCourseId,
    ...(Array.isArray(fields.lessonIds) ? fields.lessonIds : [])
  ].map(normalizeId).filter(Boolean);
}

function lessonHintScore(lesson, hint) {
  const hintIds = new Set((hint?.ids || []).map(normalizeId).filter(Boolean));
  const hintCourseIds = new Set((hint?.courseIds || []).map(normalizeId).filter(Boolean));
  const fields = lesson?.requestFields || {};
  const lessonIds = lessonIdentityValues(lesson);
  if (lessonIds.some((id) => hintIds.has(id))) return 3;
  if (hint?.name && normalizeText(lesson?.name) === normalizeText(hint.name)) return 2;
  return hintCourseIds.has(normalizeId(fields.courseId)) ? 1 : 0;
}

function lessonOptionsFromJobs(jobs) {
  const values = new Map();
  (jobs || [])
    .map((job, index) => ({ job, index, endedAt: parseDate(job?.lesson?.endedAt) }))
    .sort((left, right) => {
      if (left.endedAt && right.endedAt) return right.endedAt.getTime() - left.endedAt.getTime();
      if (left.endedAt) return -1;
      if (right.endedAt) return 1;
      return left.index - right.index;
    })
    .forEach(({ job }) => {
      const value = normalizeId(job?.lesson?.id);
      if (value && !values.has(value)) {
        values.set(value, {
          value,
          label: normalizeText(job.lesson.name) || value,
          endedAt: job.lesson.endedAt || "",
          requestFields: { ...(job.lesson.requestFields || {}) }
        });
      }
    });
  return [...values.values()];
}

export function selectLatestLessonJob(jobs, now = new Date(), lessonHint = null) {
  const current = parseDate(now);
  if (!current) return { job: null, currentMonth: "", selectedMonth: "", usedFallback: false, fallbackReason: "" };
  const currentMonth = issueMonthKey({ lessonEndedAt: current });
  const completed = (jobs || [])
    .map((job) => ({ job, endedAt: parseDate(job?.lesson?.endedAt) }))
    .filter(({ endedAt }) => endedAt && endedAt <= current)
    .sort((left, right) => right.endedAt.getTime() - left.endedAt.getTime());
  const sameMonth = completed.find(({ endedAt }) => issueMonthKey({ lessonEndedAt: endedAt }) === currentMonth);
  const hinted = (jobs || [])
    .map((job) => ({ job, score: lessonHintScore(job.lesson, lessonHint) }))
    .sort((left, right) => right.score - left.score)
    .find(({ score }) => score > 0)?.job;
  const selected = sameMonth?.job || hinted || completed[0]?.job || jobs?.[0] || null;
  const fallbackReason = sameMonth ? "" : hinted ? "template" : completed.length ? "recent" : selected ? "first" : "";
  return {
    job: selected,
    currentMonth,
    selectedMonth: sameMonth
      ? currentMonth
      : completed[0]?.job === selected
        ? issueMonthKey({ lessonEndedAt: completed[0].endedAt })
        : currentMonth,
    usedFallback: Boolean(fallbackReason),
    fallbackReason
  };
}

async function fetchStudentPages(bridge, teacherId, camp, lesson, classId = "", { quicklyOperate = null, includeTotal = true } = {}) {
  const pageSize = 200;
  const first = await bridge.replay("teachSearch", {
    teacherId,
    campId: camp.id,
    classId,
    lesson: lesson.requestFields,
    quicklyOperate,
    page: 1,
    pageSize,
    allClasses: !classId
  });
  const firstPage = extractStudentPage(first.data);
  const pages = Math.min(20, Math.ceil(firstPage.total / Math.max(1, firstPage.pageSize || firstPage.records.length || pageSize)));
  const records = [...firstPage.records];
  const remainingPages = Array.from({ length: Math.max(0, pages - 1) }, (_, index) => index + 2);
  const [additionalRecords, totalResponse] = await Promise.all([
    mapWithConcurrency(remainingPages, PAGE_REQUEST_CONCURRENCY, async (page) => {
      const response = await bridge.replay("teachSearch", {
        teacherId,
        campId: camp.id,
        classId,
        lesson: lesson.requestFields,
        quicklyOperate,
        page,
        pageSize,
        allClasses: !classId
      });
      return extractStudentPage(response.data).records;
    }),
    includeTotal
      ? bridge.replay("teachTotal", {
          teacherId,
          campId: camp.id,
          classId,
          lesson: lesson.requestFields,
          allClasses: !classId
        }).catch(() => null)
      : Promise.resolve(null)
  ]);
  records.push(...additionalRecords.flat());
  const totalData = totalResponse?.data || null;
  const dataUpdatedAt = findDataUpdatedAt(totalData) || findDataUpdatedAt(first.data);
  return {
    records,
    dataUpdatedAt,
    lessonEndedAt: findLessonEndedAt(first.data, firstPage.records) || inferLessonEndedAt(dataUpdatedAt)
  };
}

export async function collectCategoryRows({ campId = "", classId = "", lessonOptions = [], lessonOption = null, quicklyOperate, categoryType = "", now = new Date() }) {
  const context = await loadCrmContext();
  const { bridge, state, teacherId } = context;
  if (!state.templates?.teachSearch) {
    throw new Error("CRM 教学期查询尚未初始化，请刷新工作台后重试");
  }
  const selectedCampId = normalizeId(campId);
  const selectedClassId = normalizeId(classId);
  const camp = context.camps.find((item) => item.id === selectedCampId);
  if (!camp) throw new Error("选择的营期不存在或已经结营");
  if (!selectedClassId) throw new Error("请先选择班级");
  const options = [...new Map(
    [...(Array.isArray(lessonOptions) ? lessonOptions : []), ...(lessonOption ? [lessonOption] : [])]
      .map((option) => [normalizeId(option?.value || option?.id), option])
      .filter(([lessonId]) => lessonId)
  ).values()];
  if (!options.length) throw new Error("请至少选择一节课");
  const warnings = [];
  let failures = 0;
  const resultSets = await mapWithConcurrency(options, LESSON_REQUEST_CONCURRENCY, async (option) => {
    const lessonId = normalizeId(option?.value || option?.id);
    const lessonName = normalizeText(option?.label || option?.name) || lessonId;
    const lesson = {
      id: lessonId,
      name: lessonName,
      endedAt: option?.endedAt || "",
      requestFields: {
        id: lessonId,
        lessonId,
        campLessonId: lessonId,
        name: lessonName,
        lessonName,
        ...(option?.requestFields || {})
      }
    };
    try {
      const page = await fetchStudentPages(bridge, teacherId, camp, lesson, selectedClassId, {
        quicklyOperate,
        includeTotal: false
      });
      const effectiveLesson = { ...lesson, endedAt: lesson.endedAt || page.lessonEndedAt || "" };
      return buildIssues({
        records: page.records,
        roster: [],
        camp,
        lesson: effectiveLesson,
        dataUpdatedAt: page.dataUpdatedAt,
        includeAll: true,
        now
      });
    } catch (error) {
      failures += 1;
      warnings.push(`${lessonName}：${error.message}`);
      return [];
    }
  });
  if (failures === options.length) throw new Error("所选课节的分类数据全部加载失败");
  const rows = resultSets.flat();
  const categoryRows = rows.filter((row) => {
    if (categoryType === "inclass") return hasCategoryWorkIssue(row.inClassHomework);
    if (categoryType === "homework") return hasCategoryWorkIssue(row.homework);
    if (categoryType === "extension") return hasCategoryWorkIssue(row.extensions);
    return true;
  });
  for (const row of categoryRows) {
    if (categoryType && !row.issueTypes.includes(categoryType)) row.issueTypes.push(categoryType);
  }
  return {
    teacherId,
    issues: [...new Map(categoryRows.map((row) => [row.id, row])).values()],
    meta: {
      selectedCampId,
      selectedClassId,
      selectedLessonId: normalizeId(options[0]?.value || options[0]?.id),
      selectedLessonIds: options.map((option) => normalizeId(option?.value || option?.id)),
      lessonCount: options.length,
      matchedStudentCount: categoryRows.length,
      categoryType,
      quicklyOperate,
      warnings,
      refreshedAt: new Date().toISOString()
    }
  };
}

async function fetchLearningSituation(bridge, teacherId, camp) {
  const pageSize = 200;
  const first = await bridge.replay("learningSituation", {
    teacherId,
    campId: camp.id,
    page: 1,
    pageSize,
    allClasses: true
  });
  const firstPage = extractStudentPage(first.data);
  const records = [...firstPage.records];
  const pages = Math.min(20, Math.ceil(firstPage.total / Math.max(1, firstPage.pageSize || firstPage.records.length || pageSize)));
  const remainingPages = Array.from({ length: Math.max(0, pages - 1) }, (_, index) => index + 2);
  const additionalRecords = await mapWithConcurrency(remainingPages, PAGE_REQUEST_CONCURRENCY, async (page) => {
    const response = await bridge.replay("learningSituation", {
      teacherId,
      campId: camp.id,
      page,
      pageSize,
      allClasses: true
    });
    return extractStudentPage(response.data).records;
  });
  records.push(...additionalRecords.flat());
  return records;
}

export async function collectAllIssues({ roster = [], overrides, campId = "", classId = "", lessonIds = [], lessonId = "", onProgress = () => {}, now = new Date() }) {
  const context = await loadCrmContext();
  const { bridge, state, teacherId } = context;
  if (!state.templates?.lessons || !state.templates?.teachSearch) {
    throw new Error("CRM 查询尚未初始化，请刷新工作台，等待表格出现后再打开 CRM作业助手");
  }
  const selectedCampId = normalizeId(campId);
  const selectedClassId = normalizeId(classId);
  if (!selectedCampId) throw new Error("请先选择营期");
  if (!selectedClassId) throw new Error("请先选择班级");
  const camps = context.camps.filter((camp) => camp.id === selectedCampId);
  if (!camps.length) throw new Error("选择的营期不存在或已经结营");

  const lessonJobs = [];
  const automaticRoster = [];
  let lessonsWithoutTime = 0;
  const setupWarnings = [];
  let selectedClass = null;
  for (const camp of camps) {
    const [courseInfoResult, homeRecordsResult, lessonsResult] = await Promise.allSettled([
      bridge.replay("courseCampInfo", { teacherId, campId: camp.id, allClasses: true }),
      fetchLearningSituation(bridge, teacherId, camp),
      bridge.replay("lessons", { teacherId, campId: camp.id, allClasses: true })
    ]);
    let schedules = new Map();
    if (courseInfoResult.status === "fulfilled") {
      schedules = extractClassSchedules(courseInfoResult.value.data);
      const classes = extractClasses(courseInfoResult.value.data);
      selectedClass = classes.find((item) => item.id === selectedClassId || item.name === selectedClassId) || null;
    } else {
      setupWarnings.push(`${camp.name}：未读取到班级时段（${courseInfoResult.reason?.message || "查询失败"}）`);
    }
    if (!selectedClass) {
      selectedClass = { id: selectedClassId, name: selectedClassId, time: schedules.get(selectedClassId) || "", aliases: [selectedClassId] };
    }
    if (homeRecordsResult.status === "fulfilled") {
      for (const record of homeRecordsResult.value) {
        automaticRoster.push({
          campId: camp.id,
          studentId: record.studentId,
          studentName: record.studentName,
          homeClassId: record.currentClassId,
          homeClassTime: schedules.get(record.currentClassId) || ""
        });
      }
    } else {
      setupWarnings.push(`${camp.name}：自动常驻班级读取失败（${homeRecordsResult.reason?.message || "查询失败"}）`);
    }
    if (lessonsResult.status === "rejected") throw lessonsResult.reason;
    const lessons = extractLessons(lessonsResult.value.data);
    for (const lesson of lessons) {
      lessonJobs.push({ camp, lesson, schedules });
    }
  }
  if (!automaticRoster.length && !roster.length) {
    throw new Error("无法从用户学情读取班级信息，请刷新 CRM 页面后重试");
  }
  const scopedRoster = roster.filter((record) => !record.campId || normalizeId(record.campId) === selectedCampId);
  const manualByStudent = new Map(scopedRoster.map((record) => [normalizeId(record.studentId), record]));
  const resolvedRoster = automaticRoster.map((record) => ({ ...record, ...(manualByStudent.get(record.studentId) || {}) }));
  const automaticIds = new Set(automaticRoster.map((record) => record.studentId));
  for (const record of scopedRoster) {
    if (!automaticIds.has(normalizeId(record.studentId))) resolvedRoster.push(record);
  }
  const requestedLessonIds = [...new Set(
    [...(Array.isArray(lessonIds) ? lessonIds : []), lessonId]
      .map(normalizeId)
      .filter(Boolean)
  )];
  const requestedJobs = requestedLessonIds.map((selectedLessonId) =>
    lessonJobs.find(({ lesson }) => lessonIdentityValues(lesson).includes(selectedLessonId))
  );
  if (requestedJobs.some((job) => !job)) throw new Error("部分选择的课程不属于当前营期");
  const selection = requestedJobs.length
    ? {
        job: requestedJobs[0],
        currentMonth: issueMonthKey({ lessonEndedAt: now }),
        selectedMonth: issueMonthKey({ lessonEndedAt: requestedJobs[0].lesson.endedAt || now }),
        usedFallback: false,
        fallbackReason: ""
      }
    : selectLatestLessonJob(lessonJobs, now, state.lessonHint);
  if (!selection.job) throw new Error("当前在读营期没有可识别的课次");
  const jobs = requestedJobs.length
    ? [...new Map(requestedJobs.map((job) => [normalizeId(job.lesson.id), job])).values()]
    : [selection.job];
  const selectedMonth = selection.selectedMonth || selection.currentMonth;
  if (selection.fallbackReason === "template") {
    setupWarnings.push(`课次列表缺少时间，已加载工作台当前课次：${selection.job.lesson.name}`);
  } else if (selection.fallbackReason === "recent") {
    setupWarnings.push(`当前月没有已结束课次，已加载最近课次：${selection.job.lesson.name}`);
  } else if (selection.fallbackReason === "first") {
    setupWarnings.push(`课次列表缺少时间和当前课次标识，已仅加载一节课：${selection.job.lesson.name}`);
  }

  const allIssues = [];
  const allStudentIds = new Set();
  const warnings = [...setupWarnings];
  let jobFailures = 0;
  let completed = 0;
  await mapWithConcurrency(jobs, LESSON_REQUEST_CONCURRENCY, async ({ camp, lesson, schedules }) => {
    try {
      const page = await fetchStudentPages(bridge, teacherId, camp, lesson, selectedClass.id);
      const acceptedClassIds = new Set([selectedClass.id, selectedClass.name, ...(selectedClass.aliases || [])].map(normalizeText).filter(Boolean));
      const scopedRecords = page.records.filter((record) => acceptedClassIds.has(normalizeText(record.currentClassId)));
      if (scopedRecords.length || !page.records.length) page.records = scopedRecords;
      else warnings.push(`${selectedClass.name}：学员行未返回可匹配的班级标识，已采用 CRM 班级筛选结果`);
      page.records.forEach((record) => {
        if (!record.currentClassTime) record.currentClassTime = schedules.get(record.currentClassId) || "";
      });
      page.records.forEach((record) => allStudentIds.add(record.studentId));
      const effectiveLesson = { ...lesson, endedAt: lesson.endedAt || page.lessonEndedAt || "" };
      if (!parseDate(effectiveLesson.endedAt)) lessonsWithoutTime += 1;
      allIssues.push(...buildIssues({
        records: page.records,
        roster: resolvedRoster,
        overrides,
        camp,
        lesson: effectiveLesson,
        dataUpdatedAt: page.dataUpdatedAt,
        includeAll: true,
        now
      }));
    } catch (error) {
      jobFailures += 1;
      warnings.push(`${camp.name} / ${lesson.name}：${error.message}`);
    } finally {
      completed += 1;
      onProgress({ completed, total: jobs.length, label: `${camp.name} / ${lesson.name}` });
    }
  });

  const unmatchedRoster = scopedRoster.filter((record) => !allStudentIds.has(normalizeId(record.studentId))).map((record) => record.studentId);
  if (lessonsWithoutTime) warnings.push(`${lessonsWithoutTime} 个课次缺少上课时间，仅判定班级差异，不判定旷课或作业`);
  if (unmatchedRoster.length) warnings.push(`${unmatchedRoster.length} 名名单学员未在本次 CRM 数据中匹配到`);
  if (jobFailures === jobs.length && !allIssues.length) throw new Error("所有课次查询均失败，请稍后重试或联系扩展维护人员");

  const uniqueIssues = [...new Map(allIssues.map((issue) => [issue.id, issue])).values()];
  return {
    teacherId,
    issues: uniqueIssues,
    meta: {
      campCount: camps.length,
      selectedCampId,
      selectedCampName: camps[0].name,
      selectedClassId: selectedClass.id,
      selectedClassName: selectedClass.name,
      lessonCount: jobs.length,
      availableLessonCount: lessonJobs.length,
      defaultLessonId: jobs[0].lesson.id,
      defaultMonth: selectedMonth,
      selectedLessonId: jobs[0].lesson.id,
      selectedLessonIds: jobs.map((job) => normalizeId(job.lesson.id)),
      explicitLessonSelection: requestedLessonIds.length > 0,
      lessonOptions: lessonOptionsFromJobs(lessonJobs),
      rosterCount: resolvedRoster.length,
      automaticRosterCount: automaticRoster.length,
      manualRosterCount: scopedRoster.length,
      matchedStudentCount: allStudentIds.size,
      unmatchedRoster,
      warnings,
      refreshedAt: new Date().toISOString()
    }
  };
}
