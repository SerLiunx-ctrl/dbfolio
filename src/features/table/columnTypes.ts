import type { Engine } from "../../ipc/types";
const TYPES: Record<Engine, string[]> = {
  mysql: ["tinyint", "smallint", "mediumint", "int", "bigint", "boolean", "decimal", "float", "double", "varchar", "char", "text", "mediumtext", "longtext", "date", "time", "datetime", "timestamp", "json", "blob", "mediumblob", "longblob"],
  postgres: ["smallint", "integer", "bigint", "boolean", "numeric", "real", "double precision", "varchar", "char", "text", "date", "time", "timetz", "timestamp", "timestamptz", "interval", "json", "jsonb", "bytea", "uuid", "inet", "cidr", "macaddr"],
  sqlite: ["integer", "int", "bigint", "real", "numeric", "decimal", "text", "varchar", "char", "blob", "boolean", "date", "datetime", "timestamp", "any"],
  mongodb: [], redis: [],
};
export const typeOptions = (engine: Engine, current?: string) => current && !TYPES[engine].includes(current) ? [current, ...TYPES[engine]] : TYPES[engine];
export const defaultColumnType = (engine: Engine) => engine === "sqlite" ? "text" : "varchar";
export const hasLength = (type: string) => ["varchar", "char"].includes(type);
export const hasPrecision = (engine: Engine, type: string) => engine !== "sqlite" && ["decimal", "numeric"].includes(type);
export const hasTimePrecision = (engine: Engine, type: string) => engine !== "sqlite" && ["time", "timetz", "datetime", "timestamp", "timestamptz"].includes(type);
export const supportsIdentity = (engine: Engine, type: string) => (engine === "sqlite" ? ["integer"] : engine === "postgres" ? ["smallint", "integer", "bigint"] : ["tinyint", "smallint", "mediumint", "int", "integer", "bigint"]).includes(type);
export const typeHint = (engine: Engine) => engine === "sqlite"
  ? "SQLite 普通表按类型亲和性处理；NUMERIC 不是定点精度约束。日期/JSON 通常存为 TEXT，布尔值通常存为 INTEGER（0/1）。STRICT 表仅支持 INT、INTEGER、REAL、TEXT、BLOB、ANY，请通过 SQL 管理。"
  : engine === "postgres" ? "PostgreSQL：timestamp 不带时区，timestamptz 带时区；json 与 jsonb 分别保留。数组、枚举和自定义类型可通过 SQL 管理。" : "MySQL：按原生类型生成 SQL；自增仅适用于整数列。";

const TYPE_GROUPS: { label: string; types: string[] }[] = [
  { label: "数值型", types: ["tinyint", "smallint", "mediumint", "int", "integer", "bigint", "decimal", "numeric", "float", "double", "real", "double precision"] },
  { label: "布尔型", types: ["boolean"] },
  { label: "文本型", types: ["varchar", "char", "text", "mediumtext", "longtext"] },
  { label: "日期与时间", types: ["date", "time", "timetz", "datetime", "timestamp", "timestamptz", "interval"] },
  { label: "JSON", types: ["json", "jsonb"] },
  { label: "二进制", types: ["blob", "mediumblob", "longblob", "bytea"] },
  { label: "标识与网络", types: ["uuid", "inet", "cidr", "macaddr"] },
];
export function groupedTypeOptions(engine: Engine, current?: string) {
  const allowed = TYPES[engine];
  const groups = TYPE_GROUPS.map(group => ({ label: group.label, types: group.types.filter(type => allowed.includes(type)) })).filter(group => group.types.length);
  if (current && !allowed.includes(current)) groups.unshift({ label: "当前声明类型", types: [current] });
  return groups;
}
