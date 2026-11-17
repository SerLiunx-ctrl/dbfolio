import type { ColumnMeta, DbValue } from "../../ipc/types";
import { isReadOnlyValue } from "../../ipc/types";
import { binaryValue, parseColumnValue } from "./value";

function byteText(value: unknown): string {
  if (Array.isArray(value) || value instanceof Uint8Array) {
    const bytes: number[] = Array.from(value);
    if (!bytes.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) throw Error("剪贴板二进制数据无效");
    return "0x" + bytes.map(byte => byte.toString(16).padStart(2, "0")).join("");
  }
  if (typeof value !== "string") throw Error("剪贴板二进制数据无效");
  binaryValue(value);
  return value;
}

/** Convert against the destination type without rounding or erasing empty text. */
export function clipboardValue(column: ColumnMeta, value: DbValue): DbValue {
  if (isReadOnlyValue(value)) throw Error(`${column.name} 的剪贴板内容不完整`);
  if (value[0] === "null") return ["null", null];
  // MySQL BIT 的新元数据是无符号整数；PG bit/varbit 和 SQLite 的同名声明不能按名称推测成整数。
  if (column.canonical.kind === "int" && column.canonical.unsigned && /^bit(?:\(\d+\))?$/i.test(column.rawType.trim())) {
    if (value[0] === "bool") {
      if (typeof value[1] !== "boolean") throw Error("剪贴板布尔值无效");
      return parseColumnValue(column, value[1] ? "1" : "0");
    }
    if (value[0] === "bytes") {
      const hex = byteText(value[1]);
      if (hex.length === 2) throw Error("空二进制值不能转换为 BIT，请使用数值 0");
      return parseColumnValue(column, BigInt(hex).toString());
    }
  }
  const text = String(value[1] ?? "");
  if (["bool", "int", "float", "decimal"].includes(column.canonical.kind)) return parseColumnValue(column, text);
  if (column.canonical.kind === "binary") {
    if (value[0] !== "bytes") throw Error(`${column.name} 需要二进制数据`);
    byteText(value[1]);
    return structuredClone(value);
  }
  if (column.canonical.kind === "json") {
    JSON.parse(text);
    return ["json", text];
  }
  if (["date", "time", "dateTime", "uuid"].includes(column.canonical.kind)) return parseColumnValue(column, text);
  if (/^(vector|halfvec|sparsevec)(\(|$)/i.test(column.rawType)) throw Error(`${column.name} 暂不支持行粘贴`);
  return ["text", text];
}
