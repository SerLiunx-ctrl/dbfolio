import type { ColumnMeta, DbValue } from "../../ipc/types";
import { binaryValue, parseColumnValue } from "./value";

export function detailValue(original: DbValue | null, text: string, nullValue: boolean, column?: ColumnMeta): DbValue {
  if(nullValue) return ["null",null];
  // 原值为 NULL 时也根据列元数据恢复类型，不能以旧值推断成字符串。
  if (column) return parseColumnValue(column, text);
  switch(original?.[0]) {
    case "json": JSON.parse(text); return ["json",text];
    case "bytes": return binaryValue(text);
    case "int": if(!/^-?\d+$/.test(text) || !Number.isSafeInteger(Number(text)))throw Error("整数必须在安全整数范围内，超大整数请使用 SQL 编辑"); return ["int",Number(text)];
    case "float": if(!text.trim() || !Number.isFinite(Number(text)))throw Error("请输入有效数值");return ["float",Number(text)];
    case "bool": if(!/^(true|false|0|1)$/i.test(text))throw Error("布尔值请输入 true、false、0 或 1");return ["bool",/^(true|1)$/i.test(text)];
    case "null": case undefined: return ["text",text];
    default: return [original![0],text] as DbValue;
  }
}
