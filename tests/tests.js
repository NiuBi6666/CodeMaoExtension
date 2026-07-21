import {
  buildIssues,
  hasCategoryWorkIssue,
  homeworkGraceDeadline,
  inferLessonEndedAt,
  incompleteHomework,
  isLessonDue,
  filterIssues,
  issueMonthKey,
  sortIssuesByStudentId,
  sortIssuesNewestFirst,
  uniqueStudentIds,
  uniqueMonthOptions
} from "../src/core.js";
import { parseCsv, parseXlsx, validateRosterRows } from "../src/importer.js";
import {
  extractCamps,
  extractClasses,
  extractClassSchedules,
  extractExtensions,
  extractHomework,
  extractInClassHomework,
  extractLessons,
  extractStudentPage,
  findDataUpdatedAt,
  normalizeCompletionRate,
  normalizeStudentRecord,
  selectLatestLessonJob
} from "../src/crm-adapter.js";
import { createXlsxWorkbook } from "../src/xlsx-exporter.js";

const tests = [];
function test(name, callback) { tests.push({ name, callback }); }
function equal(actual, expected, message = "") {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`.trim());
  }
}
function ok(value, message = "expected truthy value") { if (!value) throw new Error(message); }

function concatBytes(parts) {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}

function uint16(value) { const bytes = new Uint8Array(2); new DataView(bytes.buffer).setUint16(0, value, true); return bytes; }
function uint32(value) { const bytes = new Uint8Array(4); new DataView(bytes.buffer).setUint32(0, value, true); return bytes; }

function storedZip(files) {
  const encoder = new TextEncoder();
  const locals = [];
  const centrals = [];
  let localOffset = 0;
  for (const [filename, content] of Object.entries(files)) {
    const name = encoder.encode(filename);
    const data = encoder.encode(content);
    const local = concatBytes([
      uint32(0x04034b50), uint16(20), uint16(0), uint16(0), uint16(0), uint16(0),
      uint32(0), uint32(data.length), uint32(data.length), uint16(name.length), uint16(0), name, data
    ]);
    const central = concatBytes([
      uint32(0x02014b50), uint16(20), uint16(20), uint16(0), uint16(0), uint16(0), uint16(0),
      uint32(0), uint32(data.length), uint32(data.length), uint16(name.length), uint16(0), uint16(0),
      uint16(0), uint16(0), uint32(0), uint32(localOffset), name
    ]);
    locals.push(local);
    centrals.push(central);
    localOffset += local.length;
  }
  const centralDirectory = concatBytes(centrals);
  const end = concatBytes([
    uint32(0x06054b50), uint16(0), uint16(0), uint16(centrals.length), uint16(centrals.length),
    uint32(centralDirectory.length), uint32(localOffset), uint16(0)
  ]);
  return concatBytes([...locals, centralDirectory, end]).buffer;
}

test("CSV 支持引号、逗号和 BOM", () => {
  equal(parseCsv('\uFEFF学员ID,学员姓名\n1,"张,三"\n'), [["学员ID", "学员姓名"], ["1", "张,三"]]);
});

test("名单校验拒绝重复 ID", () => {
  const result = validateRosterRows([
    ["学员ID", "原班级编号", "原上课时段"],
    ["100", "A", "周六 09:00"],
    ["100", "B", "周六 16:00"]
  ]);
  ok(result.errors.some((error) => error.includes("重复")));
});

test("名单校验生成标准记录", () => {
  const result = validateRosterRows([
    ["学员ID", "原班级编号", "原上课时段", "学员姓名"],
    ["100", "A", "周六 09:00", "小明"]
  ]);
  equal(result.records[0], { studentId: "100", studentName: "小明", homeClassId: "A", homeClassTime: "周六 09:00" });
});

test("XLSX 第一张工作表可解析", async () => {
  const workbook = `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="名单" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const rels = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"/></Relationships>`;
  const sheet = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>学员ID</t></is></c><c r="B1" t="inlineStr"><is><t>原班级编号</t></is></c><c r="C1" t="inlineStr"><is><t>原上课时段</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>100</t></is></c><c r="B2" t="inlineStr"><is><t>A</t></is></c><c r="C2" t="inlineStr"><is><t>周六 09:00</t></is></c></row></sheetData></worksheet>`;
  const rows = await parseXlsx(storedZip({
    "xl/workbook.xml": workbook,
    "xl/_rels/workbook.xml.rels": rels,
    "xl/worksheets/sheet1.xml": sheet
  }));
  equal(rows[1], ["100", "A", "周六 09:00"]);
});

test("导出的 XLSX 保留中文、换行和文本格式的学员 ID", async () => {
  const blob = createXlsxWorkbook({
    headers: ["学生 ID", "学生名字", "课中作业"],
    rows: [["001961457066", "郑明翔", "OJ题：通过 1/5\n客观题：通过 1/1"]]
  });
  const rows = await parseXlsx(await blob.arrayBuffer());
  equal(rows, [
    ["学生 ID", "学生名字", "课中作业"],
    ["001961457066", "郑明翔", "OJ题：通过 1/5\n客观题：通过 1/1"]
  ]);
});

test("宽限期为上海时区次日 20:00", () => {
  equal(homeworkGraceDeadline("2026-07-19 09:00:00").toISOString(), "2026-07-20T12:00:00.000Z");
});

test("数据更新时间未过宽限期时不判异常", () => {
  equal(isLessonDue({ sessionEndedAt: "2026-07-19 09:00:00", dataUpdatedAt: "2026-07-20 19:59:59", now: "2026-07-20 20:01:00" }), false);
  equal(isLessonDue({ sessionEndedAt: "2026-07-19 09:00:00", dataUpdatedAt: "2026-07-20 20:00:00", now: "2026-07-20 20:00:00" }), true);
});

test("课次专属 updateTime 可反推上一课日", () => {
  const unixSeconds = Date.parse("2026-07-19T20:00:00+08:00") / 1000;
  equal(findDataUpdatedAt({ data: { updateTime: unixSeconds } }), unixSeconds);
  equal(inferLessonEndedAt(unixSeconds), "2026-07-18 12:00:00");
});

test("月份按课次时间计算并按最近月份排序", () => {
  const issues = [
    { id: "july", lessonEndedAt: "2026-07-18 10:00:00", dataUpdatedAt: "2026-07-20 20:00:00", issueTypes: [] },
    { id: "may", lessonEndedAt: "2026-05-10 10:00:00", dataUpdatedAt: "2026-05-11 20:00:00", issueTypes: [] },
    { id: "unknown", lessonEndedAt: "", dataUpdatedAt: "", issueTypes: [] }
  ];
  equal(issueMonthKey(issues[0]), "2026-07");
  equal(uniqueMonthOptions(issues).map((option) => option.value), ["2026-07", "2026-05", "unknown"]);
  equal(filterIssues(issues, { month: "2026-05" }).map((issue) => issue.id), ["may"]);
});

test("异常明细始终按最新课次倒序且缺失时间排在最后", () => {
  const issues = [
    { id: "old", lessonEndedAt: "2026-06-10 10:00:00" },
    { id: "unknown", lessonEndedAt: "" },
    { id: "new", lessonEndedAt: "2026-07-18 10:00:00" }
  ];
  equal(sortIssuesNewestFirst(issues).map((issue) => issue.id), ["new", "old", "unknown"]);
});

test("作业明细按学员 ID 数值倒序分组且组内课节最新优先", () => {
  const issues = [
    { id: "100-old", studentId: "100", lessonEndedAt: "2026-06-10 10:00:00" },
    { id: "20-new", studentId: "20", lessonEndedAt: "2026-07-18 10:00:00" },
    { id: "100-new", studentId: "100", lessonEndedAt: "2026-07-18 10:00:00" },
    { id: "20-old", studentId: "20", lessonEndedAt: "2026-06-10 10:00:00" },
    { id: "blank", studentId: "", lessonEndedAt: "2026-07-20 10:00:00" }
  ];
  equal(sortIssuesByStudentId(issues).map((issue) => issue.id), ["100-new", "100-old", "20-new", "20-old", "blank"]);
});

test("复制学员 ID 时去重并忽略空 ID", () => {
  equal(uniqueStudentIds([{ studentId: "100" }, { studentId: " 100 " }, { studentId: "200" }, { studentId: "" }]), ["100", "200"]);
});

test("姓名和 ID 支持多关键词及字符顺序模糊搜索", () => {
  const issues = [
    { id: "1", studentId: "1961457066", studentName: "郑明翔", issueTypes: [] },
    { id: "2", studentId: "1956932913", studentName: "罗忆岚", issueTypes: [] }
  ];
  equal(filterIssues(issues, { query: "郑翔" }).map((item) => item.id), ["1"]);
  equal(filterIssues(issues, { query: "郑明 7066" }).map((item) => item.id), ["1"]);
  equal(filterIssues(issues, { query: "32913" }).map((item) => item.id), ["2"]);
});

test("0/0 题型不算未完成", () => {
  equal(incompleteHomework([{ type: "创作题", submitted: 0, total: 0 }, { type: "OJ题", submitted: 1, total: 2 }]).map((item) => item.type), ["OJ题"]);
});

test("作业完成以通过数而不是提交数判定", () => {
  const items = [
    { type: "OJ题", submitted: 2, total: 2, passed: 1 },
    { type: "客观题", submitted: 2, total: 2, passed: 2 }
  ];
  equal(incompleteHomework(items).map((item) => item.type), ["OJ题"]);
});

test("分类二次筛选中 OJ 看通过数，客观题只看提交数", () => {
  ok(hasCategoryWorkIssue([{ type: "OJ题", submitted: 5, total: 5, passed: 4 }]));
  ok(hasCategoryWorkIssue([{ type: "客观题", submitted: 0, total: 1, passed: 0 }]));
  equal(hasCategoryWorkIssue([{ type: "客观题", submitted: 1, total: 1, passed: 0 }]), false);
  equal(hasCategoryWorkIssue([{ type: "创作题", submitted: 0, total: 1, passed: 0 }]), false);
  equal(hasCategoryWorkIssue([{ type: "OJ题", submitted: 0, total: 0, passed: 0 }]), false);
});

test("同一记录可同时生成旷课、作业和调课", () => {
  const issues = buildIssues({
    roster: [{ campId: "C1", studentId: "100", homeClassId: "A", homeClassTime: "周六 09:00" }],
    records: [{ studentId: "100", studentName: "小明", currentClassId: "B", currentClassTime: "周六 16:00", transferStatus: "已完成", attendanceAt: "", homework: [{ type: "OJ题", submitted: 1, total: 2 }] }],
    overrides: {}, camp: { id: "C1", name: "营期" }, lesson: { id: "L1", name: "P1", endedAt: "2026-07-18 09:00:00" },
    dataUpdatedAt: "2026-07-20 20:00:00", now: "2026-07-20 21:00:00"
  });
  equal(issues[0].issueTypes, ["absence", "homework", "transfer"]);
});

test("课后作业和课后拓展可同时独立生成异常", () => {
  const issues = buildIssues({
    roster: [{ studentId: "100", homeClassId: "A" }],
    records: [{
      studentId: "100",
      currentClassId: "A",
      attendanceAt: "已到课",
      homework: [{ type: "OJ题", submitted: 2, total: 2, passed: 1 }],
      extensions: [{ type: "OJ题", submitted: 3, total: 3, passed: 2 }]
    }],
    camp: { id: "C1" }, lesson: { id: "L1", endedAt: "2026-07-18 09:00:00" },
    dataUpdatedAt: "2026-07-20 20:00:00", now: "2026-07-20 21:00:00"
  });
  equal(issues[0].issueTypes, ["homework", "extension"]);
  equal(issues[0].incompleteHomework[0].passed, 1);
  equal(issues[0].incompleteExtensions[0].passed, 2);
});

test("课中作业异常可独立生成并筛选", () => {
  const issues = buildIssues({
    roster: [{ studentId: "100", homeClassId: "A" }],
    records: [{
      studentId: "100",
      currentClassId: "A",
      attendanceAt: "已到课",
      inClassHomework: [{ type: "OJ题", submitted: 2, total: 3, passed: 1 }],
      homework: [{ type: "OJ题", submitted: 2, total: 2, passed: 2 }]
    }],
    camp: { id: "C1" },
    lesson: { id: "L1" },
    dataUpdatedAt: ""
  });
  equal(issues[0].issueTypes, ["inclass"]);
  equal(issues[0].incompleteInClassHomework[0].passed, 1);
  equal(filterIssues(issues, { type: "inclass" }).length, 1);
  equal(filterIssues(issues, { type: "homework" }).length, 0);
});

test("未到课和作业异常均立即判定", () => {
  const issues = buildIssues({
    roster: [{ studentId: "100", homeClassId: "A" }],
    records: [{
      studentId: "100",
      currentClassId: "A",
      attendanceAt: "",
      homework: [{ type: "OJ题", submitted: 1, total: 2, passed: 1 }],
      extensions: [{ type: "客观题", submitted: 0, total: 1, passed: 0 }]
    }],
    camp: { id: "C1" },
    lesson: { id: "L1", endedAt: "2026-07-20 20:00:00" },
    dataUpdatedAt: "2026-07-21 08:39:00",
    now: "2026-07-21 09:04:00"
  });
  equal(issues[0].issueTypes, ["absence", "homework", "extension"]);
});

test("是否完课为 0% 时即使存在到课时间也判定旷课", () => {
  const issues = buildIssues({
    roster: [{ studentId: "100", homeClassId: "A" }],
    records: [{ studentId: "100", currentClassId: "A", attendanceAt: "09:00", completionRate: 0, homework: [] }],
    camp: { id: "C1" },
    lesson: { id: "L1" },
    dataUpdatedAt: ""
  });
  equal(issues[0].issueTypes, ["absence"]);
});

test("有迟到记录不算旷课", () => {
  const issues = buildIssues({
    roster: [{ studentId: "100", homeClassId: "A", homeClassTime: "周六 09:00" }],
    records: [{ studentId: "100", currentClassId: "A", attendanceAt: "09:14 迟到", homework: [] }],
    camp: { id: "C1" }, lesson: { id: "L1", endedAt: "2026-07-18 09:00:00" },
    dataUpdatedAt: "2026-07-20 20:00:00", now: "2026-07-20 21:00:00"
  });
  equal(issues.length, 0);
});

test("作业明细可保留没有异常的正常学员", () => {
  const rows = buildIssues({
    roster: [{ studentId: "100", homeClassId: "A" }],
    records: [{
      studentId: "100",
      studentName: "小明",
      currentClassId: "A",
      attendanceAt: "已到课",
      inClassHomework: [{ type: "OJ题", submitted: 2, total: 2, passed: 2 }],
      homework: [{ type: "OJ题", submitted: 2, total: 2, passed: 2 }]
    }],
    camp: { id: "C1" },
    lesson: { id: "L1", name: "P1", endedAt: "2026-07-18 09:00:00" },
    dataUpdatedAt: "2026-07-20 20:00:00",
    now: "2026-07-20 21:00:00",
    includeAll: true
  });
  equal(rows.length, 1);
  equal(rows[0].issueTypes, []);
  equal(rows[0].inClassHomework[0].passed, 2);
});

test("正常状态的班级差异标为待确认", () => {
  const issues = buildIssues({
    roster: [{ studentId: "100", homeClassId: "A" }],
    records: [{ studentId: "100", currentClassId: "B", transferStatus: "正常", attendanceAt: "已到课", homework: [] }],
    camp: { id: "C1" }, lesson: { id: "L1" }, dataUpdatedAt: ""
  });
  equal(issues[0].issueTypes, ["mismatch"]);
});

test("永久转班覆盖只影响生效课次及之后", () => {
  const common = {
    roster: [{ studentId: "100", homeClassId: "A" }],
    records: [{ studentId: "100", currentClassId: "B", transferStatus: "已完成", attendanceAt: "已到课", homework: [] }],
    overrides: { "C1:100": { classId: "B", effectiveAt: "2026-07-15 00:00:00" } },
    camp: { id: "C1" }, dataUpdatedAt: ""
  };
  equal(buildIssues({ ...common, lesson: { id: "old", endedAt: "2026-07-14 09:00:00" } }).length, 1);
  equal(buildIssues({ ...common, lesson: { id: "new", endedAt: "2026-07-16 09:00:00" } }).length, 0);
});

test("营期解析排除已结营", () => {
  const camps = extractCamps({ data: [
    { campId: 1, campName: "在读", liveCampState: { name: "SERVICE", desc: "开营中" } },
    { campId: 2, campName: "结束", liveCampState: { name: "END", desc: "已结营" } }
  ] });
  equal(camps.map((camp) => camp.id), ["1"]);
});

test("课次解析兼容 lbkCourseId 和 lessonIds", () => {
  const lessons = extractLessons({ data: [{ lbkCourseId: 31, lbkCourseName: "P31", lessonIds: [901], endTime: "2026-07-18 10:00:00" }] });
  equal(lessons[0].requestFields.lessonIds, [901]);
  equal(lessons[0].name, "P31");
});

test("默认只选择当前月最后一次已结束课次", () => {
  const jobs = [
    { lesson: { id: "previous", endedAt: "2026-06-30 10:00:00" } },
    { lesson: { id: "early", endedAt: "2026-07-05 10:00:00" } },
    { lesson: { id: "latest", endedAt: "2026-07-18 10:00:00" } },
    { lesson: { id: "future", endedAt: "2026-07-25 10:00:00" } }
  ];
  equal(selectLatestLessonJob(jobs, "2026-07-20 12:00:00").job.lesson.id, "latest");
});

test("当前月没有已结束课次时回退最近课次", () => {
  const jobs = [
    { lesson: { id: "older", endedAt: "2026-05-20 10:00:00" } },
    { lesson: { id: "recent", endedAt: "2026-06-28 10:00:00" } },
    { lesson: { id: "future", endedAt: "2026-07-25 10:00:00" } }
  ];
  const selection = selectLatestLessonJob(jobs, "2026-07-20 12:00:00");
  equal(selection.job.lesson.id, "recent");
  equal(selection.usedFallback, true);
});

test("课次缺少时间时使用工作台当前课次标识", () => {
  const jobs = [
    { lesson: { id: "51", name: "P51", endedAt: "", requestFields: { lbkCourseId: 51 } } },
    { lesson: { id: "53", name: "P53", endedAt: "", requestFields: { lbkCourseId: 53 } } }
  ];
  const selection = selectLatestLessonJob(jobs, "2026-07-20 12:00:00", { ids: ["53"], name: "" });
  equal(selection.job.lesson.id, "53");
  equal(selection.fallbackReason, "template");
});

test("班级时段从营期班级信息提取", () => {
  const schedules = extractClassSchedules({ data: { liveClassInfoBaseRespList: [{ classId: 7, className: "A班", classTimeDesc: "每周六 09:00" }] } });
  equal(schedules.get("A班"), "每周六 09:00");
});

test("营期班级可转换为级联选择项", () => {
  const classes = extractClasses({ data: { liveClassInfoBaseRespList: [
    { classId: 7, className: "A班", classTimeDesc: "每周六 09:00" },
    { classId: 8, className: "B班", classTimeDesc: "每周六 19:00" }
  ] } });
  equal(classes.map(({ id, name, time }) => ({ id, name, time })), [
    { id: "7", name: "A班", time: "每周六 09:00" },
    { id: "8", name: "B班", time: "每周六 19:00" }
  ]);
});

test("教学期精确作业字段可标准化", () => {
  const raw = {
    userId: 100, userName: "小明", className: "B班", attendFlag: 0, adjustmentState: 2,
    finishRate: "0%",
    creationAfterclassRightHomework: 0, creationAfterclassFinishHomework: 0, creationAfterclassAllHomework: 0,
    ojAfterclassRightHomework: 1, ojAfterclassFinishHomework: 1, ojAfterclassAllHomework: 2,
    ptAfterclassRightHomework: 0, ptAfterclassFinishHomework: 0, ptAfterclassAllHomework: 0
  };
  const record = normalizeStudentRecord(raw);
  equal(record.transferStatus, "已完成");
  equal(record.attendanceAt, "");
  equal(record.completionRate, 0);
  equal(normalizeCompletionRate({ lessonFinishRate: "89.1%" }), 89.1);
  equal(extractHomework(raw).find((item) => item.type === "OJ题"), { type: "OJ题", submitted: 1, total: 2, passed: 1 });
});

test("教学期课上作业字段与课后作业独立标准化", () => {
  const raw = {
    ojClassinRightHomework: 3,
    ojClassinFinishHomework: 4,
    ojClassinAllHomework: 5,
    ojAfterclassRightHomework: 1,
    ojAfterclassFinishHomework: 2,
    ojAfterclassAllHomework: 3
  };
  equal(extractInClassHomework(raw).find((item) => item.type === "OJ题"), { type: "OJ题", submitted: 4, total: 5, passed: 3 });
  equal(extractHomework(raw).find((item) => item.type === "OJ题"), { type: "OJ题", submitted: 2, total: 3, passed: 1 });
});

test("教学期课后拓展真实字段可独立标准化", () => {
  const raw = {
    creationAfterclassTzRightHomework: 0,
    creationAfterclassTzFinishHomework: 0,
    creationAfterclassTzAll: 0,
    ojAfterclassTzkRightHomework: 1,
    ojAfterclassTzkFinishHomework: 2,
    ojAfterclassTzkAll: 2,
    ptAfterclassTzkRightHomework: 3,
    ptAfterclassTzFinishHomework: 3,
    ptAfterclassTzkAll: 3
  };
  const extensions = extractExtensions(raw);
  equal(extensions.find((item) => item.type === "OJ题"), { type: "OJ题", submitted: 2, total: 2, passed: 1 });
  equal(incompleteHomework(extensions).map((item) => item.type), ["OJ题"]);
});

test("作业项目名和完成状态可标准化", () => {
  const homework = extractHomework({
    homeworkList: [
      { homeworkName: "作业1", finishStatus: 0 },
      { homeworkName: "拓展1", finishStatus: 1 }
    ]
  });
  equal(homework.map(({ type, submitted, total }) => ({ type, submitted, total })), [
    { type: "作业1", submitted: 0, total: 1 },
    { type: "拓展1", submitted: 1, total: 1 }
  ]);
  equal(incompleteHomework(homework).map((item) => item.type), ["作业1"]);
});

test("用户学情响应可自动生成学员和班级记录", () => {
  const page = extractStudentPage({ data: { records: [{ userId: 100, userName: "小明", className: "A班" }], total: 1 } });
  equal(page.records[0].studentId, "100");
  equal(page.records[0].currentClassId, "A班");
});

test("扩展模块均可加载", async () => {
  const modules = await Promise.all([
    import("../src/app.js"),
    import("../src/ui.js"),
    import("../src/storage.js"),
    import("../src/xlsx-exporter.js")
  ]);
  ok(modules.every(Boolean));
});

test("Manifest V3 配置有效且权限收敛", async () => {
  const manifest = await fetch("../manifest.json").then((response) => response.json());
  equal(manifest.manifest_version, 3);
  equal(manifest.permissions, ["storage"]);
  ok(manifest.host_permissions.every((origin) => origin.includes("codemao.cn")));
});

test("页面脚本语法有效", async () => {
  for (const path of ["../src/page-bridge.js", "../src/content.js"]) {
    const source = await fetch(path).then((response) => response.text());
    ok(new Function(source));
  }
});

async function run() {
  const output = document.querySelector("#results");
  let passed = 0;
  for (const current of tests) {
    const item = document.createElement("li");
    try {
      await current.callback();
      item.className = "pass";
      item.textContent = `通过：${current.name}`;
      passed += 1;
    } catch (error) {
      item.className = "fail";
      item.textContent = `失败：${current.name} — ${error.message}`;
    }
    output.appendChild(item);
  }
  const failed = tests.length - passed;
  const summary = document.querySelector("#summary");
  summary.textContent = `${passed}/${tests.length} 通过${failed ? `，${failed} 失败` : ""}`;
  summary.dataset.passed = String(passed);
  summary.dataset.failed = String(failed);
  document.title = failed ? `FAIL ${failed} - CRM 扩展测试` : `PASS ${passed} - CRM 扩展测试`;
}

run();
