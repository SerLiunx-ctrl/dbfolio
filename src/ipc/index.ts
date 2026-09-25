import type {SqlExportDraft,SqlExportResult} from "../features/transfer/sqlExportModel";
import { activeSessionTasks, cancelTask } from "../stores/useTaskStore";
import { trackedInvoke as invoke } from "./taskInvoke";
import type {
  AppErrorPayload,
  CellValue,
  CharsetMeta,
  ConnectionStatus,
  DataExecuteResult,
  DataSyncRequest,
  DatabaseMeta,
  DbValue,
  DdlSpec,
  ExportRequest,
  ExportResult,
  FilterCondition,
  HistoryEntry,
  ImportOptions,
  ImportPreview,
  ImportRequest,
  ImportResult,
  InfoEntry,
  QueryOutcome,
  RedisDatabaseInfo,
  RedisEditOp,
  RedisKeyPreview,
  RedisScanPage,
  RowChange,
  SchemaCompareResult,
  SchemaExecuteResult,
  SchemaSyncRequest,
  SessionInput,
  SessionRecord,
  SortSpec,
  SyncEndpoint,
  SchemaPlan,
  TableDataDiff,
  TableInfo,
  TableMeta,
  TableRef,
  TestResult,
} from "./types";

export function normalizeError(error: unknown): AppErrorPayload {
  if (typeof error === "object" && error !== null && "message" in error) {
    const value = error as { code?: unknown; message?: unknown; detail?: unknown };
    return {
      code: typeof value.code === "string" ? value.code : "E_INTERNAL",
      message: String(value.message),
      detail: typeof value.detail === "string" ? value.detail : null,
    };
  }
  return { code: "E_INTERNAL", message: String(error), detail: null };
}

export interface TransactionInfo {id:string;tabId:string;sessionId:string;database:string;statements:number}
export const api = {
  transactionBegin:(sessionId:string,database:string,tabId:string)=>invoke<TransactionInfo>('transaction_begin',{sessionId,database,tabId}),
  transactionStatus:(id:string)=>invoke<TransactionInfo|null>('transaction_status',{id}),
  transactionExecute:(id:string,sessionId:string,sql:string,force=false,offset=0,sort:SortSpec[]=[],limit=200)=>invoke<QueryOutcome>('transaction_execute',{id,sessionId,sql,force,offset,sort,limit}),
  transactionFinish:(id:string,sessionId:string,commit:boolean)=>invoke<void>('transaction_finish',{id,sessionId,commit}),
  listSessions: () => invoke<SessionRecord[]>("session_list"),
  duplicateSession: (sourceId:string,input:SessionInput) => invoke<SessionRecord>("session_duplicate",{sourceId,input}),
  createSession: (input: SessionInput) => invoke<SessionRecord>("session_create", { input }),
  updateSession: (id: string, input: SessionInput) =>
    invoke<SessionRecord>("session_update", { id, input }),
  deleteSession: (id: string) => invoke<void>("session_delete", { id }),
  testSession: (input: SessionInput, sessionId?: string | null) =>
    invoke<TestResult>("session_test", { input, sessionId: sessionId ?? null }),
  connectSession: (id: string) => invoke<ConnectionStatus>("session_connect", { id }),
  disconnectSession: (id: string) => invoke<void>("session_disconnect", { id }),
  sessionSetGroup: (id: string, group: string | null) =>
    invoke<void>("session_set_group", { id, group }),
  sessionHealth: (id: string) => invoke<void>("session_health", { id }),
  sessionStatuses: () => invoke<ConnectionStatus[]>("session_statuses"),

  settingsGet: (key: string) => invoke<string | null>("settings_get", { key }),
  settingsSetMany: (values: Record<string, string>) => invoke<void>("settings_set_many", { values }),
  settingsSet: (key: string, value: string) =>
    invoke<void>("settings_set", { key, value }),
  systemAccentColor: () => invoke<string | null>("system_accent_color"),
  clipboardReadText: () => invoke<string>("clipboard_read_text"),
  sqlFileRead: (path: string) => invoke<string | null>("sql_file_read",{path}),
  sqlFileWrite: (path: string,text: string,expected: string | null) => invoke<void>("sql_file_write",{path,text,expected}),
  clipboardWriteText: (text: string) => invoke<void>("clipboard_write_text", { text }),

  listDatabases: (sessionId: string) =>
    invoke<DatabaseMeta[]>("meta_databases", { sessionId }),
  listTables: (sessionId: string, database: string) =>
    invoke<TableRef[]>("meta_tables", { sessionId, database }),
  tableDetail: (
    sessionId: string,
    database: string,
    table: string,
    schema?: string | null,
  ) =>
    invoke<TableMeta>("meta_table_detail", {
      sessionId,
      database,
      table,
      schema: schema ?? null,
    }),
  tableInfo: (
    sessionId: string,
    database: string,
    table: string,
    schema?: string | null,
  ) =>
    invoke<TableInfo>("meta_table_info", {
      sessionId,
      database,
      table,
      schema: schema ?? null,
    }),
  serverInfo: (sessionId: string) =>
    invoke<InfoEntry[]>("meta_server_info", { sessionId }),
  databaseInfo: (sessionId: string, database: string) =>
    invoke<InfoEntry[]>("meta_database_info", { sessionId, database }),
  storageEngines: (sessionId:string)=>invoke<string[]>("meta_storage_engines",{sessionId}),
  charsets: (sessionId: string) =>
    invoke<CharsetMeta[]>("meta_charsets", { sessionId }),
  collations: (sessionId: string, charset: string) =>
    invoke<string[]>("meta_collations", { sessionId, charset }),

  queryExecute: (
    sessionId: string,
    database: string,
    sql: string,
    options?: { force?: boolean; limit?: number; sort?: SortSpec[] },
  ) =>
    invoke<QueryOutcome>("query_execute", {
      sessionId,
      database,
      sql,
      force: options?.force ?? false,
      limit: options?.limit ?? null,
      sort: options?.sort ?? null,
    }),
  queryFetchPage: (
    sessionId: string,
    database: string,
    sql: string,
    offset: number,
    limit: number,
    sort?: SortSpec[],
  ) =>
    invoke<QueryOutcome>("query_fetch_page", {
      sessionId,
      database,
      sql,
      offset,
      limit,
      sort: sort ?? null,
    }),
  queryCancel: async (sessionId: string) => {
    const tasks = activeSessionTasks(sessionId).filter(t => t.kind === "查询");
    if (tasks.length === 1) return cancelTask(tasks[0].id);
    if (tasks.length > 1) throw new Error("该会话有多个查询，请在任务中心选择要取消的任务");
    throw new Error("当前没有正在执行的查询");
  },
  queryHistorySearch: (filters: { sessionId?: string; database?: string; text: string; from?: string; to?: string; success?: boolean; offset: number }) => invoke<HistoryEntry[]>("query_history_search", filters),
  queryParameterLiterals: (sessionId: string, values: Record<string,DbValue>) => invoke<Record<string,string>>("query_parameter_literals", {sessionId,values}),
  queryHistory: (sessionId?: string | null, limit?: number) =>
    invoke<HistoryEntry[]>("query_history_list", {
      sessionId: sessionId ?? null,
      limit: limit ?? null,
    }),
  buildFilterClause: (
    sessionId: string,
    filters: FilterCondition[],
    conjunction: "and" | "or",
  ) =>
    invoke<string>("build_filter_clause", { sessionId, filters, conjunction }),

  exportData: (request: ExportRequest) =>
    invoke<ExportResult>("export_data", { request }),
  importPreview: (filePath: string, options: ImportOptions) =>
    invoke<ImportPreview>("import_preview", { filePath, options }),
  importCsv: (request: ImportRequest) =>
    invoke<ImportResult>("import_csv", { request }),

  gridPreviewChanges: (
    sessionId: string,
    database: string,
    schema: string | null,
    table: string,
    changes: RowChange[],
  ) =>
    invoke<string[]>("grid_preview_changes", {
      sessionId,
      database,
      schema,
      table,
      changes,
    }),
  gridCommit: (
    sessionId: string,
    database: string,
    schema: string | null,
    table: string,
    changes: RowChange[],
  ) =>
    invoke<number>("grid_commit", {
      sessionId,
      database,
      schema,
      table,
      changes,
    }),

  ddlPreview: (sessionId: string, database: string, spec: DdlSpec) =>
    invoke<string[]>("ddl_preview", { sessionId, database, spec }),
  ddlApply: (sessionId: string, database: string, spec: DdlSpec, force?: boolean) =>
    invoke<string[]>("ddl_apply", {
      sessionId,
      database,
      spec,
      force: force ?? false,
    }),
  ddlCreateDatabase: (
    sessionId: string,
    name: string,
    charset?: string | null,
    collation?: string | null,
  ) =>
    invoke<void>("ddl_create_database", {
      sessionId,
      name,
      charset: charset ?? null,
      collation: collation ?? null,
    }),
  ddlDropDatabase: (sessionId: string, name: string, force?: boolean) =>
    invoke<void>("ddl_drop_database", { sessionId, name, force: force ?? false }),

  syncCompareSchema: (source: SyncEndpoint, target: SyncEndpoint, tables: string[], originTabId?:string) =>
    invoke<SchemaCompareResult>("sync_compare_schema", { source, target, tables,originTabId }),
  exportSql: (request: SqlExportDraft & {path:string}, originTabId?:string) => invoke<SqlExportResult>("export_sql",{request,originTabId}),
  syncPreviewSchema: (request: SchemaSyncRequest, originTabId?:string) =>
    invoke<SchemaPlan>("sync_preview_schema", { request,originTabId }),
  syncExecuteSchema: (planId: string, selected: number[], originTabId?:string, sessionId?:string) =>
    invoke<SchemaExecuteResult>("sync_execute_schema", { planId,selected,originTabId,sessionId }),
  syncCompareData: (request: DataSyncRequest, originTabId?:string) =>
    invoke<TableDataDiff[]>("sync_compare_data", { request,originTabId }),
  syncExecuteData: (request: DataSyncRequest, originTabId?:string) =>
    invoke<DataExecuteResult>("sync_execute_data", { request,originTabId }),

  redisCommand: (sessionId: string, db: number, args: string[], force = false) => invoke<unknown>("redis_command", { sessionId, db, args, force }),
  redisServerInfo: (sessionId: string) =>
    invoke<InfoEntry[]>("redis_server_info", { sessionId }),
  redisDatabases: (sessionId: string) =>
    invoke<RedisDatabaseInfo[]>("redis_databases", { sessionId }),
  redisScanKeys: (
    sessionId: string,
    db: number,
    cursor: number,
    pattern: string,
    keyType: string | null,
    count = 200,
  ) =>
    invoke<RedisScanPage>("redis_scan_keys", {
      sessionId,
      db,
      cursor,
      pattern,
      keyType,
      count,
    }),
  redisKeyPreview: (sessionId: string, db: number, key: string, limit = 100, cursor?: string) =>
    invoke<RedisKeyPreview>("redis_key_preview", { sessionId, db, key, limit, cursor }),
  redisEdit: (
    sessionId: string,
    db: number,
    key: string,
    edit: RedisEditOp,
    create = false,
  ) => invoke<void>("redis_edit", { sessionId, db, key, edit, create }),
  redisDeleteKey: (sessionId: string, db: number, key: string) =>
    invoke<number>("redis_delete_key", { sessionId, db, key }),
  redisDeleteKeys: (sessionId: string, db: number, keys: string[]) =>
    invoke<number>("redis_delete_keys", { sessionId, db, keys }),
  redisRenameKey: (sessionId: string, db: number, key: string, newKey: string) =>
    invoke<void>("redis_rename_key", { sessionId, db, key, newKey }),
  redisKeyTtl: (sessionId: string, db: number, key: string, ttlMs: number | null) =>
    invoke<number>("redis_key_ttl", { sessionId, db, key, ttlMs }),

  queryExplain: (sessionId: string, database: string, sql: string) =>
    invoke<QueryOutcome>("query_explain", { sessionId, database, sql }),
  cellFullValue: (
    sessionId: string,
    database: string,
    schema: string | null,
    table: string,
    column: string,
    keys: CellValue[],
  ) =>    invoke<DbValue | null>("cell_full_value", {
      sessionId,
      database,
      schema,
      table,
      column,
      keys,
    }),
  updateCell: (
    sessionId: string,
    database: string,
    schema: string | null,
    table: string,
    column: string,
    keys: CellValue[],
    oldValue: DbValue,
    newValue: DbValue,
  ) =>
    invoke<number>("update_cell", {
      sessionId,
      database,
      schema,
      table,
      column,
      keys,
      oldValue,
      newValue,
    }),
};
