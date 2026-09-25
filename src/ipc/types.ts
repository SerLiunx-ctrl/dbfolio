export type Engine = "mysql" | "postgres" | "sqlite" | "redis" | "mongodb";

export interface SessionRecord {
  id: string;
  name: string;
  engine: Engine;
  host?: string | null;
  port?: number | null;
  username?: string | null;
  database?: string | null;
  filePath?: string | null;
  sslMode?: string | null;
  redisDb?: number | null;
  tls?: boolean | null;
  authSource?: string | null;
  readOnly: boolean;
  allowedDatabases?: string[] | null;
  groupName?: string | null;
  color?: string | null;
  hasPassword: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SessionInput {
  name: string;
  engine: Engine;
  host?: string | null;
  port?: number | null;
  username?: string | null;
  /** null 表示不修改已保存密码；"" 表示删除；其他表示保存 */
  password?: string | null;
  database?: string | null;
  filePath?: string | null;
  sslMode?: string | null;
  redisDb?: number | null;
  tls?: boolean | null;
  authSource?: string | null;
  readOnly: boolean;
  allowedDatabases?: string[] | null;
  groupName?: string | null;
  color?: string | null;
}

export interface InfoEntry {
  section: string;
  key: string;
  value: string;
}

export interface RedisDatabaseInfo {
  index: number;
  keys: number;
}

export interface CharsetMeta {
  charset: string;
  defaultCollation?: string | null;
}

export interface RedisKeyInfo {
  key: string;
  kind: string;
  ttlMs: number;
  size?: number | null;
}

export interface RedisScanPage {
  cursor: number;
  keys: RedisKeyInfo[];
}

export interface RedisPreviewEntry {
  field?: string | null;
  value: string;
  score?: number | null;
}

export interface RedisKeyPreview {
  nextCursor?: string | null;
  key: string;
  kind: string;
  ttlMs: number;
  size?: number | null;
  encoding?: string | null;
  length?: number | null;
  truncated: boolean;
  binary: boolean;
  entries: RedisPreviewEntry[];
}

export interface RedisFieldPair {
  field: string;
  value: string;
}

export type RedisEditOp =
  | { op: "setString"; value: string; ttlMs?: number | null }
  | { op: "listPush"; value: string; head: boolean }
  | { op: "listSet"; index: number; value: string }
  | { op: "listRemove"; value: string; count: number }
  | { op: "setAdd"; member: string }
  | { op: "setRemove"; member: string }
  | { op: "zAdd"; member: string; score: number }
  | { op: "zRemove"; member: string }
  | { op: "hashSet"; field: string; value: string }
  | { op: "hashRemove"; field: string }
  | { op: "streamAdd"; fields: RedisFieldPair[] };

export interface ConnectionStatus {
  sessionId: string;
  connected: boolean;
  serverVersion?: string | null;
}

export interface TestResult {
  ok: boolean;
  serverVersion: string;
}

export interface DatabaseMeta {
  name: string;
  charset?: string | null;
  collation?: string | null;
  comment?: string | null;
}

export type TableKind = "table" | "view";

export interface TableRef {
  name: string;
  schema?: string | null;
  kind: TableKind;
  rowEstimate?: number | null;
  comment?: string | null;
  sizeBytes?: number | null;
  engine?: string | null;
}

export type CanonicalType =
  | { kind: "bool" }
  | { kind: "int"; bits: number; unsigned: boolean }
  | { kind: "decimal"; precision?: number | null; scale?: number | null }
  | { kind: "float"; bits: number }
  | { kind: "string"; len?: number | null }
  | { kind: "binary"; len?: number | null }
  | { kind: "date" }
  | { kind: "time"; precision?: number | null; tz: boolean }
  | { kind: "dateTime"; precision?: number | null; tz: boolean }
  | { kind: "json" }
  | { kind: "uuid" }
  | { kind: "enum"; values: string[] }
  | { kind: "unknown"; raw: string };

export interface ColumnMeta {
  name: string;
  ordinal: number;
  rawType: string;
  canonical: CanonicalType;
  nullable: boolean;
  defaultValue?: string | null;
  autoIncrement: boolean;
  unsigned: boolean;
  charset?: string | null;
  collation?: string | null;
  comment?: string | null;
}

export interface IndexColumn {
  name: string;
  desc: boolean;
  prefixLen?: number | null;
}

export interface IndexMeta {
  name: string;
  columns: IndexColumn[];
  unique: boolean;
  primary: boolean;
  method?: string | null;
  comment?: string | null;
}

export interface ForeignKeyMeta {
  refDatabase?: string | null;
  refSchema?: string | null;
  name: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
  onDelete: string;
  onUpdate: string;
}

export interface TableMeta {
  name: string;
  schema?: string | null;
  kind: TableKind;
  columns: ColumnMeta[];
  primaryKey: string[];
  indexes: IndexMeta[];
  foreignKeys: ForeignKeyMeta[];
  comment?: string | null;
  rowEstimate?: number | null;
  rawDdl?: string | null;
}

export interface TableExtraInfo {
  engine?: string | null;
  charset?: string | null;
  collation?: string | null;
  autoIncrementValue?: number | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  dataSize?: number | null;
  indexSize?: number | null;
  totalSize?: number | null;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unitIndex]}`;
}

export interface TableInfo {
  name: string;
  database: string;
  schema?: string | null;
  kind: TableKind;
  comment?: string | null;
  rowEstimate?: number | null;
  columnCount: number;
  indexCount: number;
  foreignKeyCount: number;
  primaryKey: string[];
  autoIncrementColumn?: string | null;
  extra: TableExtraInfo;
}

export interface AppErrorPayload {
  code: string;
  message: string;
  detail?: string | null;
}

export interface TableSelection {
  sessionId: string;
  database: string;
  schema?: string | null;
  table: string;
}

export type DbValueTag =
  | "null"
  | "bool"
  | "int"
  | "uint"
  | "float"
  | "decimal"
  | "text"
  | "bytes"
  | "date"
  | "time"
  | "datetime"
  | "json"
  | "uuid"
  | "trunc"
  | "readonly";

export type DbValue = [DbValueTag, unknown];

export interface ColumnInfo {
  name: string;
  rawType: string;
}

export interface QueryOutcome {
  columns: ColumnInfo[];
  rows: DbValue[][];
  affected: number | null;
}

export interface SortSpec {
  column: string;
  dir: "asc" | "desc";
}

export type FilterOperator =
  | "eq"
  | "ne"
  | "gt"
  | "ge"
  | "lt"
  | "le"
  | "contains"
  | "startsWith"
  | "endsWith"
  | "isNull"
  | "isNotNull"
  | "in"
  | "between";

export interface FilterCondition {
  literal?: DbValue;
  column: string;
  operator: FilterOperator;
  value?: string | null;
  value2?: string | null;
}

export interface ExportResult {
  rows: number;
  path: string;
}

export type ExportFormat = "csv" | "json" | "xlsx";

export interface ExportRequest {
  sessionId: string;
  database: string;
  sql: string;
  sort: SortSpec[];
  offset?: number | null;
  limit?: number | null;
  format: ExportFormat;
  filePath: string;
  includeHeader?: boolean | null;
}

export interface ImportOptions {
  delimiter?: string | null;
  encoding?: string | null;
  hasHeader?: boolean | null;
  emptyAsNull?: boolean | null;
  batchSize?: number | null;
}

export interface ImportPreview {
  columns: string[];
  rows: string[][];
  totalRows: number;
}

export interface ImportRequest {
  sessionId: string;
  database: string;
  schema?: string | null;
  table: string;
  filePath: string;
  options: ImportOptions;
  mapping: (string | null)[];
}

export interface ImportResult {
  inserted: number;
  skipped: number;
  error?: string | null;
}

/* ---------------- 同步 ---------------- */

export interface SyncEndpoint {
  sessionId: string;
  database: string;
}

export interface ColumnDiff {
  name: string;
  status: "same" | "onlySource" | "onlyTarget" | "different";
  sourceType?: string | null;
  targetType?: string | null;
  details: string[];
}

export interface IndexDiff {
  name: string;
  status: "same" | "onlySource" | "onlyTarget" | "different";
  definition: string;
}

export interface TableSchemaDiff {
  details: string[];
  table: string;
  schema?: string | null;
  status: "same" | "different" | "onlySource" | "onlyTarget" | "missing";
  kind?: string | null;
  comment?: string | null;
  columns: ColumnDiff[];
  indexes: IndexDiff[];
  foreignKeys: IndexDiff[];
}

export interface SchemaSummary {
  createTables: number;
  dropTables: number;
  alterTables: number;
  sameTables: number;
}

export interface SchemaCompareResult {
  tables: TableSchemaDiff[];
  summary: SchemaSummary;
}

export interface SyncStatement {
  table: string;
  kind: string;
  description: string;
  sql: string;
}

export interface SchemaExecuteResult {
  executed: number;
  failed: number;
  error?: string | null;
}

export interface SchemaSyncOptions {
  excludedChanges?: string[];
  syncPrimaryKey?: boolean;
  syncTableOptions?: boolean;
  dropExtraIndexes?: boolean;
  dropExtraForeignKeys?: boolean;
  createMissingTables: boolean;
  dropMissingTables: boolean;
  addMissingColumns: boolean;
  alterChangedColumns: boolean;
  dropExtraColumns: boolean;
  createIndexes: boolean;
  createForeignKeys: boolean;
}

export interface SchemaSyncRequest {
  source: SyncEndpoint;
  target: SyncEndpoint;
  tables: string[];
  options: SchemaSyncOptions;
}

export interface TableDataDiff {
  samples: {kind:string;key:string;fields:{column:string;before:string|null;after:string|null}[]}[];
  table: string;
  keyColumns: string[];
  sourceRows: number;
  targetRows: number;
  inserts: number;
  updates: number;
  deletes: number;
  skipped: boolean;
  note?: string | null;
}

export interface DataSyncOptions {
  insertMissing: boolean;
  updateChanged: boolean;
  deleteExtra: boolean;
  batchSize?: number | null;
  continueOnError: boolean;
}

export interface DataSyncRequest {
  filters?:Record<string,{conditions:FilterCondition[];conjunction:string}>;
  source: SyncEndpoint;
  target: SyncEndpoint;
  tables: string[];
  options: DataSyncOptions;
}

export interface TableSyncResult {
  table: string;
  inserts: number;
  updates: number;
  deletes: number;
  failed: number;
  error?: string | null;
}

export interface DataExecuteResult {
  backupDirectory: string;
  tables: TableSyncResult[];
}

export interface HistoryEntry {
  id: number;
  sessionId: string;
  database?: string | null;
  sql: string;
  success: boolean;
  rowsAffected?: number | null;
  durationMs?: number | null;
  errorCode?: string | null;
  executedAt: string;
}

export interface CellValue {
  column: string;
  value: DbValue;
}

export interface CellChange {
  column: string;
  oldValue: DbValue;
  newValue: DbValue;
}

export type RowChange =
  | { kind: "insert"; values: CellValue[] }
  | { kind: "update"; keys: CellValue[]; changes: CellChange[] }
  | { kind: "delete"; keys: CellValue[]; before?: CellValue[] };

export interface ColumnSpec {
  preserveType?: boolean;
  name: string;
  dataType: string;
  length?: number | null;
  precision?: number | null;
  scale?: number | null;
  nullable: boolean;
  primaryKey: boolean;
  autoIncrement: boolean;
  defaultValue?: string | null;
  comment?: string | null;
}

export interface ColumnPosition {
  first: boolean;
  after?: string | null;
}

export interface IndexColumnSpec {
  name: string;
  desc?: boolean;
}

export type DdlSpec =
  | {type:"columnFlags";schema?:string|null;table:string;changes:{name:string;nullable:boolean;unsigned?:boolean;newName?:string;dataType?:string;comment?:string;defaultMode?:string;defaultValue?:string;autoIncrement?:boolean;onUpdate?:string}[]}
  | {type:"tableOptions";schema?:string|null;table:string;options:{name?:string;comment?:string;engine?:string;charset?:string;collation?:string;autoIncrement?:string;rowFormat?:string}}
  | { type: "createTable"; schema?: string | null; table: string; columns: ColumnSpec[] }
  | { type: "dropTable"; schema?: string | null; table: string }
  | {
      type: "addColumn";
      schema?: string | null;
      table: string;
      column: ColumnSpec;
      position?: ColumnPosition | null;
    }
  | { type: "modifyColumn"; schema?: string | null; table: string; column: ColumnSpec }
  | { type: "dropColumn"; schema?: string | null; table: string; column: string }
  | {
      type: "moveColumn";
      schema?: string | null;
      table: string;
      column: string;
      position: ColumnPosition;
    }
  | {
      type: "createIndex";
      schema?: string | null;
      table: string;
      name: string;
      columns: IndexColumnSpec[];
      unique: boolean;
    }
  | {
      type: "replaceIndex";
      schema?: string | null;
      table: string;
      name: string;
      oldName: string;
      columns: IndexColumnSpec[];
      unique: boolean;
    }
  | { type: "dropIndex"; schema?: string | null; table: string; name: string }
  | {
      type: "addForeignKey";
      schema?: string | null;
      table: string;
      name: string;
      columns: string[];
      refTable: string;
      refColumns: string[];
      onDelete: string;
      onUpdate: string;
    }
  | {
      type: "replaceForeignKey";
      schema?: string | null;
      table: string;
      name: string;
      oldName: string;
      columns: string[];
      refTable: string;
      refColumns: string[];
      onDelete: string;
      onUpdate: string;
    }
  | { type: "dropForeignKey"; schema?: string | null; table: string; name: string };

export function formatDbValue(value: DbValue | null | undefined): string {
  if (!value) return "";
  const [tag, raw] = value;
  switch (tag) {
    case "null":
      return "(NULL)";
    case "bool":
      return raw ? "true" : "false";
    case "bytes":
      return String(raw);
    case "trunc":
      return `${String(raw ?? "")} …（超长已截断）`;
    default:
      return String(raw ?? "");
  }
}

export function isNullValue(value: DbValue | null | undefined): boolean {
  return !value || value[0] === "null";
}

export function isReadOnlyValue(value: DbValue | null | undefined): boolean {
  return !!value && (value[0] === "trunc" || value[0] === "readonly");
}

export function isTruncatedValue(value: DbValue | null | undefined): boolean {
  return !!value && value[0] === "trunc";
}

export function formatCanonicalType(t: CanonicalType): string {
  switch (t.kind) {
    case "bool":
      return "bool";
    case "int":
      return `${t.unsigned ? "uint" : "int"}${t.bits}`;
    case "decimal": {
      const scale = t.scale ?? 0;
      return t.precision ? `decimal(${t.precision},${scale})` : "decimal";
    }
    case "float":
      return t.bits === 32 ? "float32" : "float64";
    case "string":
      return t.len ? `varchar(${t.len})` : "text";
    case "binary":
      return t.len ? `varbinary(${t.len})` : "blob";
    case "date":
      return "date";
    case "time":
      return `time${t.tz ? "tz" : ""}`;
    case "dateTime":
      return `datetime${t.tz ? "tz" : ""}`;
    case "json":
      return "json";
    case "uuid":
      return "uuid";
    case "enum":
      return `enum(${t.values.length})`;
    case "unknown":
      return t.raw;
  }
}

export interface SchemaPlan { id: string; statements: SyncStatement[]; groups: number[][]; warnings: string[]; }
