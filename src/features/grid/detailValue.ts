import type { ColumnMeta, DbValue } from "../../ipc/types";
import { numericValue } from "./numericValue";

export function detailValue(original: DbValue | null, text: string, nullValue: boolean, column?: ColumnMeta): DbValue {
  if(nullValue) return ["null",null];
  // 原值为 NULL 时也根据列元数据恢复类型，不能以旧值推断成字符串。
  const numeric = column && numericValue(column.canonical, text);
  if (numeric) return numeric;
  if(column?.canonical.kind==='json'){JSON.parse(text);return ['json',text];}
  if(column?.canonical.kind==='string'||column?.canonical.kind==='enum')return ['text',text];
  if(column?.canonical.kind==='binary'){if(!/^0x(?:[\da-f]{2})*$/i.test(text))throw Error('二进制值须为 0x 开头的完整十六进制字节');return ['bytes',text];}
  if(column?.canonical.kind==='date')return ['date',text];
  if(column?.canonical.kind==='time')return ['time',text];
  if(column?.canonical.kind==='dateTime')return ['datetime',text];
  if(column?.canonical.kind==='uuid')return ['uuid',text];
  switch(original?.[0]) {
    case "json": JSON.parse(text); return ["json",text];
    case "bytes": if(!/^0x(?:[\da-f]{2})*$/i.test(text))throw Error("二进制值须为 0x 开头的完整十六进制字节"); return ["bytes",text];
    case "int": if(!/^-?\d+$/.test(text) || !Number.isSafeInteger(Number(text)))throw Error("整数必须在安全整数范围内，超大整数请使用 SQL 编辑"); return ["int",Number(text)];
    case "float": if(!text.trim() || !Number.isFinite(Number(text)))throw Error("请输入有效数值");return ["float",Number(text)];
    case "bool": if(!/^(true|false|0|1)$/i.test(text))throw Error("布尔值请输入 true、false、0 或 1");return ["bool",/^(true|1)$/i.test(text)];
    case "null": case undefined: return ["text",text];
    default: return [original![0],text] as DbValue;
  }
}
