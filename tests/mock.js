import { AlertUI } from "../src/ui.js";

const issues = [
  {
    id: "150:31:1001:B",
    studentId: "1001",
    studentName: "示例学员甲",
    campId: "150",
    campName: "251219-2",
    lessonId: "31",
    lessonName: "P31-函数初识（一）",
    lessonEndedAt: "2026-07-18 10:00:00",
    issueTypes: ["absence", "inclass", "homework", "extension", "transfer"],
    attendanceAt: "",
    inClassHomework: [{ type: "OJ题", submitted: 3, total: 3, passed: 2 }],
    homework: [{ type: "OJ题", submitted: 2, total: 2, passed: 0 }],
    incompleteHomework: [
      { type: "OJ题", submitted: 2, total: 2, passed: 0 }
    ],
    incompleteExtensions: [{ type: "OJ题", submitted: 2, total: 3, passed: 1 }],
    extensions: [{ type: "OJ题", submitted: 2, total: 3, passed: 1 }],
    homeClassId: "251219-2E609C20080",
    homeClassTime: "每周六 09:00",
    currentClassId: "251219-2E616C20080",
    currentClassTime: "每周六 16:00",
    transferStatus: "已完成",
    dataUpdatedAt: "2026-07-20 20:00:00"
  },
  {
    id: "150:31:1002:A",
    studentId: "1002",
    studentName: "示例学员乙",
    campId: "150",
    campName: "251219-2",
    lessonId: "31",
    lessonName: "P31-函数初识（一）",
    lessonEndedAt: "2026-07-18 10:00:00",
    issueTypes: ["homework"],
    attendanceAt: "08:58:12",
    inClassHomework: [{ type: "客观题", submitted: 5, total: 5, passed: 5 }],
    homework: [{ type: "客观题", submitted: 6, total: 6, passed: 4 }],
    incompleteHomework: [{ type: "客观题", submitted: 6, total: 6, passed: 4 }],
    extensions: [],
    homeClassId: "251219-2E609C20080",
    homeClassTime: "每周六 09:00",
    currentClassId: "251219-2E609C20080",
    currentClassTime: "每周六 09:00",
    transferStatus: "正常",
    dataUpdatedAt: "2026-07-20 20:00:00"
  },
  {
    id: "150:30:1003:C",
    studentId: "1003",
    studentName: "示例学员丙",
    campId: "150",
    campName: "251219-2",
    lessonId: "30",
    lessonName: "P30-函数基础",
    lessonEndedAt: "2026-07-11 10:00:00",
    issueTypes: ["mismatch"],
    attendanceAt: "09:01:05",
    inClassHomework: [],
    homework: [],
    incompleteHomework: [],
    incompleteExtensions: [],
    extensions: [],
    homeClassId: "251219-2E709C20080",
    homeClassTime: "每周日 09:00",
    currentClassId: "251219-2E616C20080",
    currentClassTime: "每周六 16:00",
    transferStatus: "正常",
    dataUpdatedAt: "2026-07-20 20:00:00"
  },
  {
    id: "150:22:1004:A",
    studentId: "1004",
    studentName: "历史学员丁",
    campId: "150",
    campName: "251219-2",
    lessonId: "22",
    lessonName: "P22-循环复习",
    lessonEndedAt: "2026-06-06 10:00:00",
    issueTypes: ["absence"],
    attendanceAt: "",
    inClassHomework: [],
    homework: [],
    incompleteHomework: [],
    incompleteExtensions: [],
    extensions: [],
    homeClassId: "251219-2E609C20080",
    homeClassTime: "每周六 09:00",
    currentClassId: "251219-2E609C20080",
    currentClassTime: "每周六 09:00",
    transferStatus: "正常",
    dataUpdatedAt: "2026-06-07 20:00:00"
  }
];

const ui = new AlertUI({
  onOpen: () => ui.open(),
  onRefresh: () => undefined,
  onCampChange: () => undefined,
  onClassChange: () => undefined,
  onLessonChange: () => undefined,
  onImport: () => undefined,
  onPromote: () => undefined,
  onRestore: () => undefined
});
ui.mount();
ui.update({
  roster: [],
  issues,
  catalog: {
    camps: [{ value: "150", label: "251219-2" }],
    classes: [{ value: "7", label: "A班" }],
    lessons: [
      { value: "31", label: "P31-函数初识（一）" },
      { value: "30", label: "P30-函数基础" }
    ]
  },
  selection: { campId: "150", classId: "7", lessonIds: ["31", "30"] },
  meta: {
    selectedCampId: "150",
    selectedClassId: "7",
    defaultLessonId: "31",
    selectedLessonIds: ["31", "30"],
    lessonOptions: [
      { value: "31", label: "P31-函数初识（一）" },
      { value: "30", label: "P30-函数基础" }
    ],
    automaticRosterCount: 54,
    refreshedAt: "2026-07-20T12:05:00.000Z",
    warnings: ["1 个课次缺少上课时间，未参与异常判定"]
  }
});
ui.open();
