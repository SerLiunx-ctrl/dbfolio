import { api } from "../../ipc";
import type { DbValue } from "../../ipc/types";

export interface ClipboardColumn {
  name: string;
  rawType: string;
}

export interface ClipboardRows {
  columns: ClipboardColumn[];
  rows: DbValue[][];
}

interface RowSnapshot extends ClipboardRows {
  text: string;
}

let snapshot: RowSnapshot | null = null;
let lastCellText: string | null = null;
let revision = 0;
let writes: Promise<void> = Promise.resolve();

/** Discard internal copy origins without changing the operating system clipboard. */
export function clearRowClipboard(): void {
  snapshot = null;
  lastCellText = null;
  revision += 1;
}

function enqueueWrite<T>(write: () => Promise<T>): Promise<T> {
  const result = writes.then(write);
  writes = result.then(() => undefined, () => undefined);
  return result;
}

function clone<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    throw Error("复制数据包含无法保存的值，请刷新后重试");
  }
}

function cellText(value: DbValue, row: number, column: number): string {
  if (!Array.isArray(value) || value.length !== 2) {
    throw Error(`第 ${row + 1} 行第 ${column + 1} 列的数据无效，无法完整复制`);
  }
  const [tag, raw] = value;
  if (tag === "trunc" || tag === "readonly") {
    throw Error(`第 ${row + 1} 行第 ${column + 1} 列包含截断或只读扩展值，请获取完整数据后再复制`);
  }
  if (tag === "null") return "";
  if (raw === null || raw === undefined || typeof raw === "function" || typeof raw === "symbol") {
    throw Error(`第 ${row + 1} 行第 ${column + 1} 列的值无效，无法完整复制`);
  }
  if (typeof raw === "number" && !Number.isFinite(raw)) {
    throw Error(`第 ${row + 1} 行第 ${column + 1} 列包含非有限数值，无法完整复制`);
  }
  if (tag === "bytes" && (Array.isArray(raw) || raw instanceof Uint8Array)) {
    const bytes = Array.from(raw as ArrayLike<number>);
    if (bytes.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
      throw Error(`第 ${row + 1} 行第 ${column + 1} 列的二进制数据无效，无法完整复制`);
    }
    return "0x" + bytes.map(byte => byte.toString(16).padStart(2, "0")).join("");
  }
  if (typeof raw === "object") {
    try {
      const text = JSON.stringify(raw);
      if (text === undefined) throw Error();
      return text;
    } catch {
      throw Error(`第 ${row + 1} 行第 ${column + 1} 列无法转换为剪贴板文本`);
    }
  }
  return Object.is(raw, -0) ? "-0" : String(raw);
}

function tsvField(text: string): string {
  return /[\t\r\n"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Copy standard TSV while retaining an exact, process-local typed snapshot. */
export async function writeRowClipboard(columns: ClipboardColumn[], rows: DbValue[][]): Promise<number> {
  if (rows.length === 0) return 0;
  if (!columns.length || columns.some(column => typeof column.name !== "string" || typeof column.rawType !== "string")) {
    throw Error("复制列信息无效，请选择需要复制的列后重试");
  }
  const text = rows.map((row, rowIndex) => {
    if (row.length !== columns.length) {
      throw Error(`第 ${rowIndex + 1} 行的列数与复制列不一致，无法完整复制`);
    }
    return row.map((value, columnIndex) => tsvField(cellText(value, rowIndex, columnIndex))).join("\t");
  }).join("\r\n");
  const copied = clone({ columns: columns.map(({ name, rawType }) => ({ name, rawType })), rows });
  clearRowClipboard();
  const current = revision;
  return enqueueWrite(async () => {
    await api.clipboardWriteText(text);
    if (revision === current) snapshot = { ...copied, text };
    return copied.rows.length;
  });
}

/** External text edits invalidate typed data, even if old text is pasted back later. */
export async function readRowClipboard(): Promise<ClipboardRows | null> {
  const current = snapshot;
  const cell = lastCellText;
  if (!current && cell === null) return null;
  const version = revision;
  const text = await api.clipboardReadText();
  if (snapshot !== current || lastCellText !== cell || revision !== version) return null;
  if (text !== (current ? current.text : cell)) {
    clearRowClipboard();
    return null;
  }
  if (!current) return null;
  return clone({ columns: current.columns, rows: current.rows });
}

/** A cell copy must never be mistaken for a previous typed row copy. */
export async function writeCellClipboard(text: string): Promise<void> {
  clearRowClipboard();
  const current = revision;
  return enqueueWrite(async () => {
    await api.clipboardWriteText(text);
    if (revision === current) lastCellText = text;
  });
}

/** Copy opaque text such as generated SQL without assigning it a cell origin. */
export async function writeTextClipboard(text: string): Promise<void> {
  clearRowClipboard();
  return enqueueWrite(() => api.clipboardWriteText(text));
}

/** Parse Excel-style quoted TSV without trimming cells or losing final empty columns. */
export function parseClipboardTsv(text: string): string[][] {
  if (lastCellText !== null) {
    if (text === lastCellText) return text === "" ? [] : [[text]];
    clearRowClipboard();
  }
  if (text === "") return [];
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let closedQuote = false;
  let started = false;
  let endedRecord = false;
  const finishField = () => {
    row.push(field);
    field = "";
    closedQuote = false;
    started = false;
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          closedQuote = true;
        }
      } else {
        field += char;
      }
      continue;
    }
    const separator = char === "\t" || char === "\r" || char === "\n";
    if (closedQuote && !separator) {
      throw Error(`剪贴板 TSV 格式无效：第 ${rows.length + 1} 行第 ${row.length + 1} 列的结束引号后存在其他内容`);
    }
    if (char === "\t") {
      finishField();
      endedRecord = false;
    } else if (char === "\r" || char === "\n") {
      finishField();
      rows.push(row);
      row = [];
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      endedRecord = true;
    } else if (char === '"' && !started) {
      quoted = true;
      started = true;
      endedRecord = false;
    } else {
      field += char;
      started = true;
      endedRecord = false;
    }
  }
  if (quoted) {
    throw Error(`剪贴板 TSV 格式无效：第 ${rows.length + 1} 行第 ${row.length + 1} 列的引号未闭合`);
  }
  if (!endedRecord) {
    finishField();
    rows.push(row);
  }
  return rows;
}
