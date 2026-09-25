import type { CanonicalType, ColumnMeta, DbValue } from "../../ipc/types";

export function quoteIdent(engine: string, name: string): string {
  if (engine === "mysql") return `\`${name.replace(/`/g, "``")}\``;
  return `"${name.replace(/"/g, '""')}"`;
}

export function qualifiedTableSql(
  engine: string,
  database: string,
  schema: string | null | undefined,
  table: string,
): string {
  if (engine === "mysql") {
    return `${quoteIdent(engine, database)}.${quoteIdent(engine, table)}`;
  }
  if (engine === "postgres") {
    return `${quoteIdent(engine, schema ?? "public")}.${quoteIdent(engine, table)}`;
  }
  return quoteIdent(engine, table);
}

const PREVIEW_CHARS = 1024;
const PREVIEW_BYTES = 256;
/** 多取 1 个字符，确保后端能识别「确实被截断」并标记为只读 */
const PREVIEW_CHARS_FETCH = PREVIEW_CHARS + 1;

function isLargeColumn(column: ColumnMeta): boolean {
  const kind = column.canonical.kind;
  if (kind === "json" || kind === "binary") return true;
  if (kind === "string") {
    const len = column.canonical.len;
    return len === null || len === undefined || len > PREVIEW_CHARS;
  }
  return false;
}

function previewExpression(engine: string, column: ColumnMeta): string {
  const ident = quoteIdent(engine, column.name);
  const alias = quoteIdent(engine, column.name);
  if (engine === "mysql") {
    return `LEFT(${ident}, ${PREVIEW_CHARS_FETCH}) AS ${alias}`;
  }
  if (engine === "postgres") {
    if (column.canonical.kind === "binary") {
      return `substring(${ident} from 1 for ${PREVIEW_BYTES + 1}) AS ${alias}`;
    }
    if (column.canonical.kind === "json") {
      return `LEFT(${ident}::text, ${PREVIEW_CHARS_FETCH}) AS ${alias}`;
    }
    return `LEFT(${ident}, ${PREVIEW_CHARS_FETCH}) AS ${alias}`;
  }
  return `substr(${ident}, 1, ${PREVIEW_CHARS_FETCH}) AS ${alias}`;
}

/** 表数据浏览专用 SELECT：对超长字段在服务端截断，避免传输/渲染超大值 */
export function buildTableSelect(
  engine: string,
  database: string,
  schema: string | null | undefined,
  table: string,
  columns: ColumnMeta[],
): string {
  const selectList = columns
    .map((column) =>
      isLargeColumn(column) ? previewExpression(engine, column) : quoteIdent(engine, column.name),
    )
    .join(", ");
  return `SELECT ${selectList} FROM ${qualifiedTableSql(engine, database, schema, table)}`;
}

export function parseCell(column: ColumnMeta, text: string): DbValue {
  if (text === "") return ["null", null];
  const canonical: CanonicalType = column.canonical;
  switch (canonical.kind) {
    case "int": {
      if (/^-?\d+$/.test(text)) {
        const number = Number(text);
        return ["int", Number.isSafeInteger(number) ? number : text];
      }
      return ["text", text];
    }
    case "float": {
      const value = Number(text);
      return Number.isFinite(value) ? ["float", value] : ["text", text];
    }
    case "decimal":
      return ["decimal", text];
    case "bool": {
      if (/^(1|true|yes)$/i.test(text)) return ["bool", true];
      if (/^(0|false|no)$/i.test(text)) return ["bool", false];
      return ["text", text];
    }
    case "date":
      return ["date", text];
    case "time":
      return ["time", text];
    case "dateTime":
      return ["datetime", text];
    case "json":
      return ["json", text];
    case "uuid":
      return ["uuid", text];
    case "binary": {
      if (/^0x[0-9a-f]*$/i.test(text)) return ["bytes", text];
      return ["text", text];
    }
    default:
      return ["text", text];
  }
}
