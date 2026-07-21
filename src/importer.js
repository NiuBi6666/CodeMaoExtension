import { normalizeId, normalizeText } from "./core.js";

const REQUIRED_HEADERS = ["学员ID", "原班级编号", "原上课时段"];
const OPTIONAL_HEADERS = ["学员姓名"];

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const input = String(text || "").replace(/^\uFEFF/, "");

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field || row.length) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows.filter((values) => values.some((value) => normalizeText(value)));
}

function decodeXml(buffer) {
  return new TextDecoder("utf-8").decode(buffer);
}

function findEndOfCentralDirectory(view) {
  const minimum = Math.max(0, view.byteLength - 65557);
  for (let offset = view.byteLength - 22; offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset;
  }
  throw new Error("不是有效的 XLSX 文件：未找到 ZIP 目录");
}

async function unzipEntries(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const endOffset = findEndOfCentralDirectory(view);
  const entryCount = view.getUint16(endOffset + 10, true);
  let offset = view.getUint32(endOffset + 16, true);
  const entries = new Map();

  for (let index = 0; index < entryCount; index += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error("XLSX ZIP 目录已损坏");
    const compression = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const filenameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    const filename = new TextDecoder().decode(new Uint8Array(arrayBuffer, offset + 46, filenameLength));

    if (view.getUint32(localHeaderOffset, true) !== 0x04034b50) throw new Error("XLSX ZIP 条目已损坏");
    const localFilenameLength = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLength = view.getUint16(localHeaderOffset + 28, true);
    const dataOffset = localHeaderOffset + 30 + localFilenameLength + localExtraLength;
    const compressed = new Uint8Array(arrayBuffer.slice(dataOffset, dataOffset + compressedSize));
    let content;
    if (compression === 0) {
      content = compressed;
    } else if (compression === 8 && typeof DecompressionStream !== "undefined") {
      const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      content = new Uint8Array(await new Response(stream).arrayBuffer());
    } else {
      throw new Error("当前浏览器无法解压该 XLSX 文件");
    }
    entries.set(filename.replace(/\\/g, "/"), content);
    offset += 46 + filenameLength + extraLength + commentLength;
  }
  return entries;
}

function parseXml(text, label) {
  const documentNode = new DOMParser().parseFromString(text, "application/xml");
  if (documentNode.querySelector("parsererror")) throw new Error(`${label} XML 无法解析`);
  return documentNode;
}

function normalizeZipPath(base, target) {
  const parts = `${base}/${target}`.split("/");
  const normalized = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") normalized.pop();
    else normalized.push(part);
  }
  return normalized.join("/");
}

function columnIndex(reference) {
  const letters = String(reference || "").match(/^[A-Z]+/i)?.[0]?.toUpperCase() || "A";
  let value = 0;
  for (const letter of letters) value = value * 26 + letter.charCodeAt(0) - 64;
  return value - 1;
}

function sharedStringValues(documentNode) {
  return [...documentNode.querySelectorAll("si")].map((item) =>
    [...item.querySelectorAll("t")].map((node) => node.textContent || "").join("")
  );
}

function worksheetRows(documentNode, sharedStrings) {
  return [...documentNode.querySelectorAll("sheetData > row")].map((rowNode) => {
    const values = [];
    for (const cell of rowNode.querySelectorAll("c")) {
      const index = columnIndex(cell.getAttribute("r"));
      const type = cell.getAttribute("t");
      const raw = cell.querySelector("v")?.textContent ?? "";
      let value = raw;
      if (type === "s") value = sharedStrings[Number(raw)] ?? "";
      if (type === "inlineStr") value = [...cell.querySelectorAll("is t")].map((node) => node.textContent || "").join("");
      if (type === "b") value = raw === "1" ? "TRUE" : "FALSE";
      values[index] = value;
    }
    return values;
  }).filter((row) => row.some((value) => normalizeText(value)));
}

export async function parseXlsx(arrayBuffer) {
  const entries = await unzipEntries(arrayBuffer);
  const workbookBytes = entries.get("xl/workbook.xml");
  const relsBytes = entries.get("xl/_rels/workbook.xml.rels");
  if (!workbookBytes || !relsBytes) throw new Error("XLSX 缺少工作簿信息");

  const workbook = parseXml(decodeXml(workbookBytes), "工作簿");
  const relationships = parseXml(decodeXml(relsBytes), "工作簿关系");
  const firstSheet = workbook.querySelector("sheets > sheet");
  if (!firstSheet) throw new Error("XLSX 中没有工作表");
  const relationshipId = firstSheet.getAttribute("r:id") || firstSheet.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
  const relationship = [...relationships.querySelectorAll("Relationship")].find((node) => node.getAttribute("Id") === relationshipId);
  if (!relationship) throw new Error("无法定位 XLSX 的第一张工作表");

  const sheetPath = normalizeZipPath("xl", relationship.getAttribute("Target"));
  const sheetBytes = entries.get(sheetPath);
  if (!sheetBytes) throw new Error("XLSX 第一张工作表不存在");
  const sharedBytes = entries.get("xl/sharedStrings.xml");
  const sharedStrings = sharedBytes
    ? sharedStringValues(parseXml(decodeXml(sharedBytes), "共享文本"))
    : [];
  return worksheetRows(parseXml(decodeXml(sheetBytes), "工作表"), sharedStrings);
}

export function validateRosterRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { records: [], errors: ["文件中没有数据"], warnings: [] };
  }

  const headers = rows[0].map(normalizeText);
  const missing = REQUIRED_HEADERS.filter((header) => !headers.includes(header));
  if (missing.length) {
    return { records: [], errors: [`缺少必填列：${missing.join("、")}`], warnings: [] };
  }

  const indexes = Object.fromEntries([...REQUIRED_HEADERS, ...OPTIONAL_HEADERS].map((header) => [header, headers.indexOf(header)]));
  const records = [];
  const errors = [];
  const warnings = [];
  const seen = new Set();

  rows.slice(1).forEach((row, rowOffset) => {
    const rowNumber = rowOffset + 2;
    const studentId = normalizeId(row[indexes["学员ID"]]);
    const homeClassId = normalizeText(row[indexes["原班级编号"]]);
    const homeClassTime = normalizeText(row[indexes["原上课时段"]]);
    const studentName = indexes["学员姓名"] >= 0 ? normalizeText(row[indexes["学员姓名"]]) : "";
    if (!studentId && !homeClassId && !homeClassTime && !studentName) return;
    if (!studentId || !homeClassId || !homeClassTime) {
      errors.push(`第 ${rowNumber} 行缺少学员ID、原班级编号或原上课时段`);
      return;
    }
    if (seen.has(studentId)) {
      errors.push(`第 ${rowNumber} 行学员ID重复：${studentId}`);
      return;
    }
    seen.add(studentId);
    records.push({ studentId, studentName, homeClassId, homeClassTime });
  });

  if (!records.length && !errors.length) errors.push("文件中没有有效的学员记录");
  if (records.some((record) => !record.studentName)) warnings.push("部分记录没有学员姓名，将以 CRM 中的姓名显示");
  return { records, errors, warnings };
}

export async function parseRosterFile(file) {
  if (!file) throw new Error("请选择名单文件");
  const filename = String(file.name || "").toLowerCase();
  let rows;
  if (filename.endsWith(".csv")) rows = parseCsv(await file.text());
  else if (filename.endsWith(".xlsx")) rows = await parseXlsx(await file.arrayBuffer());
  else throw new Error("仅支持 .xlsx 或 .csv 文件");
  return validateRosterRows(rows);
}
