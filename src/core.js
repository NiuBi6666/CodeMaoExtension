export const SHANGHAI_TIME_ZONE = "Asia/Shanghai";
export const CACHE_TTL_MS = 15 * 60 * 1000;
export const CACHE_SCHEMA_VERSION = 2;

export function normalizeId(value) {
  return String(value ?? "").trim();
}

export function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function parseDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number") {
    const date = new Date(value > 0 && value < 1e12 ? value * 1000 : value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const text = normalizeText(value);
  if (!text) return null;
  if (/^\d{10,13}$/.test(text)) return parseDate(Number(text));
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/.test(text)
    ? `${text.replace(" ", "T")}${text.includes("+") || text.endsWith("Z") ? "" : "+08:00"}`
    : text;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function inferLessonEndedAt(dataUpdatedAt) {
  const updatedAt = parseDate(dataUpdatedAt);
  if (!updatedAt) return "";
  const parts = shanghaiDateParts(updatedAt);
  const previousDayAnchor = new Date(Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day) - 1,
    12
  ));
  const previous = shanghaiDateParts(previousDayAnchor);
  return `${previous.year}-${previous.month}-${previous.day} 12:00:00`;
}

function shanghaiDateParts(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: SHANGHAI_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

export function homeworkGraceDeadline(sessionEndedAt) {
  const endedAt = parseDate(sessionEndedAt);
  if (!endedAt) return null;
  const parts = shanghaiDateParts(endedAt);
  const nextDayAnchor = new Date(Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day) + 1,
    12
  ));
  const nextParts = shanghaiDateParts(nextDayAnchor);
  return new Date(`${nextParts.year}-${nextParts.month}-${nextParts.day}T20:00:00+08:00`);
}

export function isLessonDue({ sessionEndedAt, dataUpdatedAt, now = new Date() }) {
  const deadline = homeworkGraceDeadline(sessionEndedAt);
  const updatedAt = parseDate(dataUpdatedAt);
  const current = parseDate(now);
  return Boolean(deadline && updatedAt && current && updatedAt >= deadline && current >= deadline);
}

export function normalizeHomeworkItems(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => {
      const submitted = Number(item.submitted ?? item.submitCount ?? item.finished ?? 0);
      const total = Number(item.total ?? item.totalCount ?? item.count ?? 0);
      const passed = Number(item.passed ?? item.passCount ?? item.right ?? item.rightCount ?? submitted);
      return {
        type: normalizeText(
          item.type || item.itemName || item.homeworkName || item.assignmentName || item.taskName ||
          item.name || item.title || item.label || item.questionTypeName || item.questionType || "作业"
        ),
        submitted,
        total,
        passed
      };
    })
    .filter((item) => Number.isFinite(item.submitted) && Number.isFinite(item.total) && Number.isFinite(item.passed) && item.total >= 0);
}

export function incompleteHomework(items) {
  return normalizeHomeworkItems(items).filter((item) => item.total > 0 && item.passed < item.total);
}

export function rosterMap(records) {
  const map = new Map();
  for (const record of records || []) {
    const studentId = normalizeId(record.studentId);
    if (!studentId) continue;
    if (record.campId) map.set(`${normalizeId(record.campId)}:${studentId}`, record);
    else map.set(studentId, record);
  }
  return map;
}

export function overrideKey(campId, studentId) {
  return `${normalizeId(campId)}:${normalizeId(studentId)}`;
}

export function issueMonthKey(issue) {
  if (issue?.monthKey) return issue.monthKey;
  const date = parseDate(issue?.lessonEndedAt) || parseDate(issue?.dataUpdatedAt);
  if (!date) return "unknown";
  const parts = shanghaiDateParts(date);
  return `${parts.year}-${parts.month}`;
}

export function monthLabel(monthKey) {
  if (monthKey === "unknown") return "时间未知";
  const match = String(monthKey || "").match(/^(\d{4})-(\d{2})$/);
  return match ? `${match[1]}年${match[2]}月` : monthKey;
}

export function uniqueMonthOptions(issues) {
  const values = new Set((issues || []).map(issueMonthKey));
  return [...values]
    .sort((left, right) => {
      if (left === "unknown") return 1;
      if (right === "unknown") return -1;
      return right.localeCompare(left);
    })
    .map((value) => ({ value, label: monthLabel(value) }));
}

export function buildIssues({
  records,
  roster,
  overrides = {},
  camp,
  lesson,
  dataUpdatedAt,
  now = new Date()
}) {
  const byStudent = rosterMap(roster);
  const due = isLessonDue({ sessionEndedAt: lesson?.endedAt, dataUpdatedAt, now });
  const issues = [];

  for (const record of records || []) {
    const studentId = normalizeId(record.studentId);
    const baseline = byStudent.get(`${normalizeId(camp?.id)}:${studentId}`) || byStudent.get(studentId);
    if (!baseline) continue;

    const overrideCandidate = overrides[overrideKey(camp?.id, studentId)];
    const overrideEffectiveAt = parseDate(overrideCandidate?.effectiveAt || overrideCandidate?.updatedAt);
    const lessonEndedAt = parseDate(lesson?.endedAt);
    const savedOverride = overrideCandidate && (!overrideEffectiveAt || !lessonEndedAt || lessonEndedAt >= overrideEffectiveAt)
      ? overrideCandidate
      : null;
    const homeClassId = normalizeText(savedOverride?.classId || baseline.homeClassId);
    const homeClassTime = normalizeText(savedOverride?.classTime || baseline.homeClassTime);
    const currentClassId = normalizeText(record.currentClassId);
    const currentClassTime = normalizeText(record.currentClassTime);
    const attendanceAt = normalizeText(record.attendanceAt);
    const unfinished = incompleteHomework(record.homework);
    const unfinishedExtensions = incompleteHomework(record.extensions);
    const issueTypes = [];
    let transferState = "";

    if (due && !attendanceAt) issueTypes.push("absence");
    if (due && unfinished.length > 0) issueTypes.push("homework");
    if (due && unfinishedExtensions.length > 0) issueTypes.push("extension");

    if (homeClassId && currentClassId && homeClassId !== currentClassId) {
      const confirmed = /已完成|调课|转入|completed|adjusted/i.test(normalizeText(record.transferStatus));
      transferState = confirmed ? "confirmed" : "unconfirmed";
      issueTypes.push(confirmed ? "transfer" : "mismatch");
    }

    if (!issueTypes.length) continue;
    issues.push({
      id: [camp?.id, lesson?.id, studentId, currentClassId].map(normalizeId).join(":"),
      studentId,
      studentName: normalizeText(record.studentName || baseline.studentName),
      campId: normalizeId(camp?.id),
      campName: normalizeText(camp?.name),
      lessonId: normalizeId(lesson?.id),
      lessonName: normalizeText(lesson?.name),
      lessonEndedAt: lesson?.endedAt || "",
      monthKey: issueMonthKey({ lessonEndedAt: lesson?.endedAt, dataUpdatedAt }),
      issueTypes,
      attendanceAt,
      homework: normalizeHomeworkItems(record.homework),
      incompleteHomework: unfinished,
      extensions: normalizeHomeworkItems(record.extensions),
      incompleteExtensions: unfinishedExtensions,
      homeClassId,
      homeClassTime,
      currentClassId,
      currentClassTime,
      transferStatus: normalizeText(record.transferStatus),
      transferState,
      hasOverride: Boolean(savedOverride),
      dataUpdatedAt: dataUpdatedAt || ""
    });
  }
  return issues;
}

export function aggregateCounts(issues) {
  return (issues || []).reduce((counts, issue) => {
    for (const type of issue.issueTypes || []) {
      if (type === "absence") counts.absence += 1;
      if (type === "homework") counts.homework += 1;
      if (type === "extension") counts.extension += 1;
      if (type === "transfer" || type === "mismatch") counts.transfer += 1;
    }
    return counts;
  }, { absence: 0, homework: 0, extension: 0, transfer: 0 });
}

export function filterIssues(issues, filters = {}) {
  const query = normalizeText(filters.query).toLowerCase();
  return (issues || []).filter((issue) => {
    if (filters.month && issueMonthKey(issue) !== filters.month) return false;
    if (filters.campId && issue.campId !== filters.campId) return false;
    if (filters.classId && issue.currentClassId !== filters.classId) return false;
    if (filters.lessonId && issue.lessonId !== filters.lessonId) return false;
    if (filters.type === "transfer" && !issue.issueTypes.some((type) => type === "transfer" || type === "mismatch")) return false;
    if (filters.type && filters.type !== "all" && filters.type !== "transfer" && !issue.issueTypes.includes(filters.type)) return false;
    if (query && !`${issue.studentName} ${issue.studentId}`.toLowerCase().includes(query)) return false;
    return true;
  });
}

export function sortIssuesNewestFirst(issues) {
  return (issues || [])
    .map((issue, index) => ({ issue, index }))
    .sort((left, right) => {
      const leftTime = parseDate(left.issue.lessonEndedAt)?.getTime() ?? Number.NEGATIVE_INFINITY;
      const rightTime = parseDate(right.issue.lessonEndedAt)?.getTime() ?? Number.NEGATIVE_INFINITY;
      if (leftTime !== rightTime) return rightTime - leftTime;

      const leftUpdatedAt = parseDate(left.issue.dataUpdatedAt)?.getTime() ?? Number.NEGATIVE_INFINITY;
      const rightUpdatedAt = parseDate(right.issue.dataUpdatedAt)?.getTime() ?? Number.NEGATIVE_INFINITY;
      if (leftUpdatedAt !== rightUpdatedAt) return rightUpdatedAt - leftUpdatedAt;
      return left.index - right.index;
    })
    .map(({ issue }) => issue);
}

export function uniqueStudentIds(issues) {
  const ids = new Set();
  for (const issue of issues || []) {
    const studentId = normalizeId(issue.studentId);
    if (studentId) ids.add(studentId);
  }
  return [...ids];
}

export function uniqueOptions(issues, key, labelKey = key) {
  const values = new Map();
  for (const issue of issues || []) {
    const value = normalizeText(issue[key]);
    if (value && !values.has(value)) values.set(value, normalizeText(issue[labelKey]) || value);
  }
  return [...values.entries()].map(([value, label]) => ({ value, label }));
}
