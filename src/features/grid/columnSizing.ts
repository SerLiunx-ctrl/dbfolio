import type { DbValue } from "../../ipc/types";

/** 只采样首次列定义的少量短文本；不扫描大字段，也不覆盖用户拖动后的宽度。 */
export function initialColumnSizing(column: { name: string; rawType: string }, rows: DbValue[][], index: number) {
  const type = column.rawType.toLowerCase();
  const short = /^(bool|boolean|bit)\b/.test(type) || /(^|_)(status|state|type|method|flag|enabled)$/.test(column.name);
  const numeric = /^(tinyint|smallint|mediumint|int|integer|bigint|serial|bigserial|decimal|numeric|float|double|real)\b/.test(type);
  const temporal = /^(date|time|timestamp|datetime)\b/.test(type);
  const large = /text|json|blob|binary|bytea/.test(type);
  let characters = Math.min(column.name.length, 32);
  for (const row of rows.slice(0, 32)) {
    const value = row[index]?.[1];
    if (value == null || typeof value === "object") continue;
    const sample = String(value).slice(0, 64);
    characters = Math.max(characters, Array.from(sample).reduce((width, char) => width + (char.charCodeAt(0) > 255 ? 2 : 1), 0));
  }
  const minimum = short ? 96 : temporal ? 172 : numeric ? 120 : large ? 220 : 160;
  const maximum = short ? 172 : numeric ? 210 : temporal ? 236 : large ? 360 : 320;
  const initialWidth = Math.max(minimum, Math.min(maximum, characters * 7 + 28));
  // 短列固定初始宽度；宽文本分配剩余空间，全部列仍允许自由拖动。
  return { initialWidth, initialFlex: short || numeric || temporal ? 0 : large ? 2 : 1, minWidth: short ? 80 : numeric || temporal ? 100 : Math.min(initialWidth, large ? 240 : 220) };
}
