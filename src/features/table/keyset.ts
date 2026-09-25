import type { DbValue } from "../../ipc/types";
import { quoteIdent } from "../grid/value";

/** 只接受可精确保留的整数主键；其它类型沿用原分页。 */
export function integerCursor(value: DbValue | undefined): string | null {
  if (!value || !["int", "uint"].includes(value[0])) return null;
  const raw = value[1];
  if (typeof raw === "number" && !Number.isSafeInteger(raw)) return null;
  if (typeof raw !== "number" && typeof raw !== "string") return null;
  const text = String(raw);
  return /^-?\d+$/.test(text) ? text : null;
}
export function keysetSql(sql: string, engine: string, key: string, cursor: string | null): string {
  if (cursor !== null && !/^-?\d+$/.test(cursor)) throw new Error("无效的分页游标");
  const column = quoteIdent(engine, key);
  return `${sql}${cursor === null ? "" : ` WHERE ${column} > ${cursor}`} ORDER BY ${column} ASC`;
}
