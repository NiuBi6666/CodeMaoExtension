import {
  buildIssues,
  homeworkGraceDeadline,
  inferLessonEndedAt,
  incompleteHomework,
  isLessonDue,
  filterIssues,
  issueMonthKey,
  sortIssuesNewestFirst,
  uniqueStudentIds,
  uniqueMonthOptions
} from "../src/core.js";
import { parseCsv, parseXlsx, validateRosterRows } from "../src/importer.js";
import {
  extractCamps,
  extractClassSchedules,
  extractExtensions,
  extractHomework,
  extractLessons,
  extractStudentPage,
  findDataUpdatedAt,
  normalizeStudentRecord
} from "../src/crm-adapter.js";

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

test("复制学员 ID 时去重并忽略空 ID", () => {
  equal(uniqueStudentIds([{ studentId: "100" }, { studentId: " 100 " }, { studentId: "200" }, { studentId: "" }]), ["100", "200"]);
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

test("有迟到记录不算旷课", () => {
  const issues = buildIssues({
    roster: [{ studentId: "100", homeClassId: "A", homeClassTime: "周六 09:00" }],
    records: [{ studentId: "100", currentClassId: "A", attendanceAt: "09:14 迟到", homework: [] }],
    camp: { id: "C1" }, lesson: { id: "L1", endedAt: "2026-07-18 09:00:00" },
    dataUpdatedAt: "2026-07-20 20:00:00", now: "2026-07-20 21:00:00"
  });
  equal(issues.length, 0);
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

test("班级时段从营期班级信息提取", () => {
  const schedules = extractClassSchedules({ data: { liveClassInfoBaseRespList: [{ classId: 7, className: "A班", classTimeDesc: "每周六 09:00" }] } });
  equal(schedules.get("A班"), "每周六 09:00");
});

test("教学期精确作业字段可标准化", () => {
  const raw = {
    userId: 100, userName: "小明", className: "B班", attendFlag: 0, adjustmentState: 2,
    creationAfterclassRightHomework: 0, creationAfterclassFinishHomework: 0, creationAfterclassAllHomework: 0,
    ojAfterclassRightHomework: 1, ojAfterclassFinishHomework: 1, ojAfterclassAllHomework: 2,
    ptAfterclassRightHomework: 0, ptAfterclassFinishHomework: 0, ptAfterclassAllHomework: 0
  };
  const record = normalizeStudentRecord(raw);
  equal(record.transferStatus, "已完成");
  equal(record.attendanceAt, "");
  equal(extractHomework(raw).find((item) => item.type === "OJ题"), { type: "OJ题", submitted: 1, total: 2, passed: 1 });
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
    import("../src/storage.js")
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
