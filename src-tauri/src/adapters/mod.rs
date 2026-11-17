pub mod message_queue;
pub mod key_value;
pub mod mongodb;
pub mod mysql;
mod mysql_value;
pub mod postgres;
pub mod redis;
pub mod sqlite;
pub mod dameng;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio::sync::Mutex;

use crate::error::{AppError, AppResult};
use crate::meta::value::DbValue;
use crate::meta::{CharsetMeta, DatabaseMeta, Engine, InfoEntry, TableExtraInfo, TableMeta, TableRef};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionParams {
    #[serde(default)]
    pub network: crate::services::connection_config::NetworkConfig,
    #[serde(skip)] pub tunneled: bool,
    #[serde(skip)] pub tls_terminated: bool,
    #[serde(default)]
    pub read_only: bool,
    #[serde(default)]
    pub allowed_databases: Option<Vec<String>>,
    pub engine: Engine,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub username: Option<String>,
    pub password: Option<String>,
    pub database: Option<String>,
    pub file_path: Option<String>,
    pub ssl_mode: Option<String>,
    pub connect_timeout_secs: Option<u64>,
    /// Redis 逻辑库编号（默认 0）
    pub redis_db: Option<u16>,
    /// Redis TLS（rediss://）
    pub tls: Option<bool>,
    pub auth_source: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    pub raw_type: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct QueryOutcome {
    #[serde(skip_serializing_if="Option::is_none")]
    pub notices: Option<Vec<String>>,
    pub columns: Vec<ColumnInfo>,
    pub rows: Vec<Vec<DbValue>>,
    pub affected: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub script_statements: Option<usize>,
}

/// 查询取消上下文：适配器执行查询时把数据库连接 id 写入，供取消命令使用。
#[derive(Debug, Default, Clone)]
pub struct QueryContext {
    pub conn_id: std::sync::Arc<Mutex<Option<u64>>>,
    cancelled: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl QueryContext {
    pub fn cancel(&self) { self.cancelled.store(true, std::sync::atomic::Ordering::Relaxed); }
    pub fn is_cancelled(&self) -> bool { self.cancelled.load(std::sync::atomic::Ordering::Relaxed) }
    pub fn new() -> Self {
        Self::default()
    }
}

#[derive(Debug, Clone)]
pub struct SqlParams {
    pub sql: String,
    pub params: Vec<DbValue>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellValue {
    pub column: String,
    pub value: DbValue,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellChange {
    pub column: String,
    pub old_value: DbValue,
    pub new_value: DbValue,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RowChange {
    Insert { values: Vec<CellValue> },
    Update { keys: Vec<CellValue>, changes: Vec<CellChange> },
    Delete { keys: Vec<CellValue> },
}

impl RowChange {
    pub fn is_empty_edit(&self) -> bool {
        match self {
            Self::Insert { values } => values.is_empty(),
            Self::Update { keys, changes } => !keys.is_empty() && changes.is_empty(),
            Self::Delete { .. } => false,
        }
    }
}

#[async_trait]
pub trait DbAdapter: Send + Sync {
    fn message_queue(&self)->Option<&message_queue::MessageQueueAdapter>{None}
    fn query_timeout_secs(&self)->u64 {60}
    /// Dedicated connection: session state from scripts must never return to a query pool.
    async fn mysql_connection(&self, _database: &str, _write: bool) -> AppResult<sqlx::MySqlConnection> {
        Err(AppError::InvalidInput("此功能仅支持 MySQL".into()))
    }
    async fn dameng_connection(&self,_database:&str,_write:bool)->AppResult<dm_rust::Connection>{Err(AppError::InvalidInput("此功能仅支持达梦".into()))}
    async fn export_sql(&self, _request: &crate::services::sql_export::SqlExportRequest) -> AppResult<crate::services::sql_export::SqlExportResult> { Err(AppError::InvalidInput("SQL 文件导出目前仅支持 MySQL".into())) }
    fn engine(&self) -> Engine;

    fn quote_ident(&self, name: &str) -> String;
    fn placeholder(&self, one_based: usize) -> String;
    fn null_safe_eq(&self, column: &str, placeholder: &str) -> String;

    async fn ping(&self) -> AppResult<()>;
    async fn server_version(&self) -> AppResult<String>;
    async fn column_types(&self, _database: &str) -> AppResult<crate::meta::data_types::DataTypeCatalog> {
        Ok(crate::meta::data_types::builtin(self.engine(), &self.server_version().await?))
    }
    async fn list_databases(&self) -> AppResult<Vec<DatabaseMeta>>;
    async fn storage_engines(&self) -> AppResult<Vec<String>> { Ok(Vec::new()) }
    async fn list_tables(&self, database: &str) -> AppResult<Vec<TableRef>>;
    async fn introspect_table(
        &self,
        database: &str,
        schema: Option<&str>,
        table: &str,
    ) -> AppResult<TableMeta>;

    /// 引擎特有的表附加信息（默认返回空）
    async fn table_extra_info(
        &self,
        _database: &str,
        _schema: Option<&str>,
        _table: &str,
    ) -> AppResult<TableExtraInfo> {
        Ok(TableExtraInfo::default())
    }

    /// 服务器信息（分节键值对，供「服务器信息」对话框使用）
    async fn server_info(&self) -> AppResult<Vec<InfoEntry>>;

    /// 数据库信息（分节键值对，供「数据库信息」对话框使用）
    async fn database_info(&self, database: &str) -> AppResult<Vec<InfoEntry>>;

    /// 可用字符集（默认空，MySQL 实现）
    async fn charsets(&self) -> AppResult<Vec<CharsetMeta>> {
        Ok(Vec::new())
    }

    /// 指定字符集下的排序规则（默认空，MySQL 实现）
    async fn collations(&self, _charset: &str) -> AppResult<Vec<String>> {
        Ok(Vec::new())
    }

    async fn begin_manual(&self, _database: &str) -> AppResult<Box<dyn crate::services::manual_transaction::ManualTransaction>> {
        Err(AppError::InvalidInput("当前引擎不支持手动事务".into()))
    }

    /// 执行返回结果集的 SQL（已由服务层包装分页）。
    async fn query_page(
        &self,
        database: &str,
        sql: &str,
        offset: u64,
        limit: u32,
        ctx: &QueryContext,
    ) -> AppResult<QueryOutcome>;

    /// File exports must never silently serialize a truncated grid preview.
    async fn query_export_page(&self,database:&str,sql:&str,offset:u64,limit:u32,ctx:&QueryContext)->AppResult<QueryOutcome>{
        let result=self.query_page(database,sql,offset,limit,ctx).await?;
        if result.rows.iter().flatten().any(|v|matches!(v,DbValue::Truncated(_))){return Err(AppError::InvalidInput("导出结果包含截断预览值，已停止保存以避免数据不完整；请缩小列范围，或使用该引擎的完整 SQL 导出".into()));}
        Ok(result)
    }

    /// 执行不返回结果集的语句，返回受影响行数。
    async fn execute_affected(&self, database: &str, sql: &str) -> AppResult<QueryOutcome>;

    /// 顺序执行一组 DDL / 管理语句（无参数）。
    async fn execute_statements(&self, database: &str, statements: &[String]) -> AppResult<()>;
    async fn sqlite_schema_edit(&self, _database: &str, _spec: &crate::services::ddl::DdlSpec, _apply: bool) -> AppResult<Vec<String>> {
        Err(crate::error::AppError::InvalidInput("该引擎不支持 SQLite 结构操作".into()))
    }

    /// 在单个事务中执行一组参数化语句，返回受影响行数总和。
    async fn execute_transaction(&self, database: &str, items: &[SqlParams]) -> AppResult<u64>;

    /// 网格逐行提交：支持写入的适配器必须在提交前确认每项命中一行。
    async fn execute_grid_transaction(&self, _database: &str, _items: &[SqlParams]) -> AppResult<u64> {
        Err(AppError::InvalidInput("当前引擎不支持提交网格修改".into()))
    }

    /// 取消正在执行的查询。
    async fn cancel(&self, conn_id: u64) -> AppResult<()>;

    /// 取单行单列的完整值（不做截断），用于查看 / 编辑大字段。
    async fn fetch_full_value(&self, database: &str, sql: &str) -> AppResult<Option<DbValue>>;
}

pub const DEFAULT_CONNECT_TIMEOUT_SECS: u64 = 10;
pub const DEFAULT_QUERY_TIMEOUT_SECS: u64 = 30;

pub async fn connect(params: &ConnectionParams) -> AppResult<std::sync::Arc<dyn DbAdapter>> {
    if params.engine != Engine::Sqlite {
        if params.host.as_deref().unwrap_or("").trim().is_empty() {
            return Err(AppError::InvalidInput("主机地址不能为空".into()));
        }
    }
    match params.engine {
        Engine::Dameng => Ok(std::sync::Arc::new(dameng::DamengAdapter::connect(params).await?)),
        Engine::Kafka|Engine::Rabbitmq|Engine::Rocketmq => Ok(std::sync::Arc::new(message_queue::MessageQueueAdapter::connect(params).await?)),
        Engine::Mysql => Ok(std::sync::Arc::new(
            mysql::MySqlAdapter::connect(params).await?,
        )),
        Engine::Postgres => Ok(std::sync::Arc::new(
            postgres::PostgresAdapter::connect(params).await?,
        )),
        Engine::Sqlite => Ok(std::sync::Arc::new(
            sqlite::SqliteAdapter::connect(params).await?,
        )),
        Engine::Mongodb => Ok(std::sync::Arc::new(mongodb::MongoAdapter::connect(params).await?)),
        Engine::Redis => Ok(std::sync::Arc::new(
            redis::RedisAdapter::connect(params).await?,
        )),
    }
}

pub fn connect_timeout(params: &ConnectionParams) -> Duration {
    Duration::from_secs(
        params
            .connect_timeout_secs
            .filter(|v| *v > 0)
            .unwrap_or(DEFAULT_CONNECT_TIMEOUT_SECS),
    )
}

fn escape_string(engine: Engine, text: &str) -> String {
    match engine {
        Engine::Mysql => text.replace('\\', "\\\\").replace('\'', "''"),
        _ => text.replace('\'', "''"),
    }
}

/// 将 DbValue 渲染为 SQL 字面量（用于脚本预览 / 导出）。
pub fn render_literal(engine: Engine, value: &DbValue) -> String {
    match value {
        DbValue::Null => "NULL".to_string(),
        DbValue::Bool(v) => match engine {
            Engine::Postgres => {
                if *v {
                    "TRUE".into()
                } else {
                    "FALSE".into()
                }
            }
            _ => {
                if *v {
                    "1".into()
                } else {
                    "0".into()
                }
            }
        },
        DbValue::Int(v) => v.to_string(),
        DbValue::UInt(v) => v.to_string(),
        DbValue::Float(v) => {
            if v.is_finite() {
                format!("{v}")
            } else {
                "NULL".into()
            }
        }
        DbValue::Decimal(v) => v.clone(),
        DbValue::Text(v) | DbValue::Date(v) | DbValue::Time(v) | DbValue::DateTime(v) => {
            format!("'{}'", escape_string(engine, v))
        }
        DbValue::Json(v) => format!("'{}'", escape_string(engine, v)),
        DbValue::Uuid(v) => format!("'{}'", escape_string(engine, v)),
        DbValue::Truncated(_) | DbValue::ReadOnly(_) => "NULL".to_string(),
        DbValue::Bytes(bytes) => {
            let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
            match engine {
                Engine::Postgres => format!("decode('{hex}', 'hex')"),
                Engine::Dameng => format!("HEXTORAW('{hex}')"),
                _ => format!("X'{hex}'"),
            }
        }
    }
}

fn null_or_placeholder(
    adapter: &dyn DbAdapter,
    params: &mut Vec<DbValue>,
    column: &str,
    column_types: &std::collections::HashMap<String, String>,
    value: &DbValue,
) -> AppResult<String> {
    reject_truncated(value)?;
    let value = if adapter.engine() == Engine::Mysql {
        match column_types.get(column) {
            Some(raw_type) => mysql_value::normalize_column_value(column, raw_type, value)?,
            None => value.clone(),
        }
    } else {
        value.clone()
    };
    if matches!(value, DbValue::Null) {
        Ok("NULL".to_string())
    } else {
        params.push(value.clone());
        let placeholder = adapter.placeholder(params.len());
        // MySQL 的 JSON 比较不会把字符串参数自动当作 JSON 值；MariaDB 的别名实际为 LONGTEXT。
        if adapter.engine() == Engine::Mysql && column_types.get(column).is_some_and(|raw| raw.trim().eq_ignore_ascii_case("json")) {
            return Ok(format!("CAST({placeholder} AS JSON)"));
        }
        Ok(match pg_type_cast(adapter.engine(), column, &value, column_types) {
            Some(cast) => format!("{placeholder}::{cast}"),
            None => placeholder,
        })
    }
}

/// PostgreSQL 对参数类型严格：文本类参数需显式转换到目标列类型（日期、JSON、UUID、枚举、数组等）
fn pg_type_cast(
    engine: Engine,
    column: &str,
    value: &DbValue,
    column_types: &std::collections::HashMap<String, String>,
) -> Option<String> {
    if engine != Engine::Postgres {
        return None;
    }
    let needs_cast = matches!(
        value,
        DbValue::Text(_)
            | DbValue::Date(_)
            | DbValue::Time(_)
            | DbValue::DateTime(_)
            | DbValue::Json(_)
            | DbValue::Uuid(_)
    );
    if !needs_cast {
        return None;
    }
    let raw = column_types.get(column)?;
    let sanitized: String = raw
        .chars()
        .filter(|c| {
            c.is_ascii_alphanumeric()
                || matches!(c, ' ' | '_' | '(' | ')' | ',' | '[' | ']' | ':' | '"')
        })
        .collect();
    let trimmed = sanitized.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("user-defined") {
        return None;
    }
    Some(trimmed.to_string())
}

fn reject_truncated(value: &DbValue) -> AppResult<()> {
    if matches!(value, DbValue::Truncated(_) | DbValue::ReadOnly(_)) {
        return Err(AppError::InvalidInput(
            "包含截断或只读类型字段，无法提交修改（请用 SQL 直接更新该字段）".into(),
        ));
    }
    Ok(())
}

/// 根据编辑变更集生成参数化 SQL（供预览与提交共用）。
pub fn build_change_statements(
    adapter: &dyn DbAdapter,
    database: &str,
    schema: Option<&str>,
    table: &str,
    changes: &[RowChange],
    column_types: &std::collections::HashMap<String, String>,
) -> AppResult<Vec<SqlParams>> {
    let engine = adapter.engine();
    let quote = |name: &str| adapter.quote_ident(name);
    let table_ref = match schema.filter(|s| !s.is_empty()) {
        Some(s) => format!("{}.{}", quote(s), quote(table)),
        None => {
            if matches!(engine,Engine::Mysql|Engine::Dameng) && !database.is_empty() {
                format!("{}.{}", quote(database), quote(table))
            } else {
                quote(table)
            }
        }
    };

    let mut out = Vec::new();
    // 向量以只读文本展示；通用网格不承担向量类型写入转换。
    let reject_vector_write = |column: &str, value: &DbValue| -> AppResult<()> {
        let raw = column_types.get(column).map(|t| t.to_ascii_lowercase()).unwrap_or_default();
        let base = raw.split('(').next().unwrap_or("");
        if engine == Engine::Postgres && matches!(base, "vector" | "halfvec" | "sparsevec") && !matches!(value, DbValue::Null) {
            return Err(AppError::ReadOnly("向量列当前仅支持查看，请使用 SQL 更新".into()));
        }
        Ok(())
    };
    for change in changes.iter().filter(|change| !change.is_empty_edit()) {
        match change {
            RowChange::Insert { values } => {
                for cell in values {
                    reject_truncated(&cell.value)?;
                    reject_vector_write(&cell.column, &cell.value)?;
                }
                let columns: Vec<String> = values.iter().map(|c| quote(&c.column)).collect();
                let mut params: Vec<DbValue> = Vec::new();
                let placeholders: Vec<String> = values
                    .iter()
                    .map(|c| {
                        null_or_placeholder(adapter, &mut params, &c.column, column_types, &c.value)
                    })
                    .collect::<AppResult<Vec<_>>>()?;
                out.push(SqlParams {
                    sql: format!(
                        "INSERT INTO {} ({}) {}VALUES ({})",
                        table_ref,
                        columns.join(", "),
                        if engine == Engine::Postgres { "OVERRIDING SYSTEM VALUE " } else { "" },
                        placeholders.join(", ")
                    ),
                    params,
                });
            }
            RowChange::Update { keys, changes } => {
                if keys.is_empty() {
                    return Err(AppError::InvalidInput("更新操作缺少主键".into()));
                }
                let mut params: Vec<DbValue> = Vec::new();
                let mut set_parts = Vec::new();
                for change in changes {
                    reject_truncated(&change.new_value)?;
                    reject_vector_write(&change.column, &change.new_value)?;
                    reject_truncated(&change.old_value)?;
                    let placeholder = null_or_placeholder(
                        adapter,
                        &mut params,
                        &change.column,
                        column_types,
                        &change.new_value,
                    )?;
                    set_parts.push(format!("{} = {}", quote(&change.column), placeholder));
                }
                let mut where_parts = Vec::new();
                for key in keys {
                    reject_truncated(&key.value)?;
                    let placeholder = null_or_placeholder(
                        adapter,
                        &mut params,
                        &key.column,
                        column_types,
                        &key.value,
                    )?;
                    where_parts.push(format!("{} = {}", quote(&key.column), placeholder));
                }
                for change in changes {
                    if keys.iter().any(|k| k.column == change.column) {
                        continue;
                    }
                    let placeholder = null_or_placeholder(
                        adapter,
                        &mut params,
                        &change.column,
                        column_types,
                        &change.old_value,
                    )?;
                    where_parts.push(
                        adapter.null_safe_eq(&quote(&change.column), &placeholder),
                    );
                }
                out.push(SqlParams {
                    sql: format!(
                        "UPDATE {} SET {} WHERE {}",
                        table_ref,
                        set_parts.join(", "),
                        where_parts.join(" AND ")
                    ),
                    params,
                });
            }
            RowChange::Delete { keys } => {
                if keys.is_empty() {
                    return Err(AppError::InvalidInput("删除操作缺少主键".into()));
                }
                let mut params: Vec<DbValue> = Vec::new();
                let where_parts: Vec<String> = keys
                    .iter()
                    .map(|key| {
                        reject_truncated(&key.value)?;
                        let placeholder = null_or_placeholder(
                            adapter,
                            &mut params,
                            &key.column,
                            column_types,
                            &key.value,
                        )?;
                        Ok(adapter.null_safe_eq(&quote(&key.column), &placeholder))
                    })
                    .collect::<AppResult<Vec<String>>>()?;
                out.push(SqlParams {
                    sql: format!("DELETE FROM {} WHERE {}", table_ref, where_parts.join(" AND ")),
                    params,
                });
            }
        }
    }
    Ok(out)
}

/// 构建单单元格更新语句（用于编辑大字段，携带完整旧值做并发校验）
#[allow(clippy::too_many_arguments)]
pub fn build_cell_update(
    adapter: &dyn DbAdapter,
    database: &str,
    schema: Option<&str>,
    table: &str,
    column: &str,
    keys: &[CellValue],
    old_value: &DbValue,
    new_value: &DbValue,
    column_types: &std::collections::HashMap<String, String>,
) -> AppResult<SqlParams> {
    if keys.is_empty() {
        return Err(AppError::InvalidInput("缺少主键，无法定位该行".into()));
    }
    let engine = adapter.engine();
    let quote = |name: &str| adapter.quote_ident(name);
    let table_ref = match schema.filter(|s| !s.is_empty()) {
        Some(s) => format!("{}.{}", quote(s), quote(table)),
        None => {
            if matches!(engine,Engine::Mysql|Engine::Dameng) && !database.is_empty() {
                format!("{}.{}", quote(database), quote(table))
            } else {
                quote(table)
            }
        }
    };

    let mut params: Vec<DbValue> = Vec::new();
    let set_placeholder =
        null_or_placeholder(adapter, &mut params, column, column_types, new_value)?;
    let mut where_parts: Vec<String> = Vec::new();
    for key in keys {
        let placeholder = null_or_placeholder(adapter, &mut params, &key.column, column_types, &key.value)?;
        where_parts.push(format!("{} = {}", quote(&key.column), placeholder));
    }
    let old_placeholder =
        null_or_placeholder(adapter, &mut params, column, column_types, old_value)?;
    where_parts.push(adapter.null_safe_eq(&quote(column), &old_placeholder));

    Ok(SqlParams {
        sql: format!(
            "UPDATE {} SET {} = {} WHERE {}",
            table_ref,
            quote(column),
            set_placeholder,
            where_parts.join(" AND ")
        ),
        params,
    })
}

/// 将变更集渲染为可读 SQL 脚本（字面量内联）。
pub fn render_change_statements(
    adapter: &dyn DbAdapter,
    database: &str,
    schema: Option<&str>,
    table: &str,
    changes: &[RowChange],
    column_types: &std::collections::HashMap<String, String>,
) -> AppResult<Vec<String>> {
    let engine = adapter.engine();
    let statements =
        build_change_statements(adapter, database, schema, table, changes, column_types)?;
    Ok(statements
        .iter()
        .map(|item| {
            inline_parameters(engine, &item.sql, &item.params)
        })
        .collect())
}

/// 只扫描原 SQL，避免值里的问号或 $1 被再次替换。
fn inline_parameters(engine: Engine, sql: &str, params: &[DbValue]) -> String {
    let chars: Vec<char> = sql.chars().collect();
    let (mut out, mut i, mut quote, mut next) = (String::new(), 0, None, 0);
    while i < chars.len() {
        let c = chars[i];
        if let Some(q) = quote {
            out.push(c);
            if c == q {
                if chars.get(i + 1) == Some(&q) { i += 1; out.push(q); } else { quote = None; }
            } else if c == '\\' && engine == Engine::Mysql && i + 1 < chars.len() { i += 1; out.push(chars[i]); }
            i += 1; continue;
        }
        if c == '\'' || c == '"' || c == '`' { quote = Some(c); out.push(c); i += 1; continue; }
        if c == '?' && engine != Engine::Postgres {
            if let Some(value) = params.get(next) { out.push_str(&render_literal(engine, value)); next += 1; } else { out.push(c); }
            i += 1; continue;
        }
        if c == '$' && engine == Engine::Postgres {
            let start = i + 1; let mut end = start;
            while end < chars.len() && chars[end].is_ascii_digit() { end += 1; }
            if end > start {
                let n = chars[start..end].iter().collect::<String>().parse::<usize>().unwrap_or(0);
                if let Some(value) = n.checked_sub(1).and_then(|n| params.get(n)) { out.push_str(&render_literal(engine, value)); i = end; continue; }
            }
        }
        out.push(c); i += 1;
    }
    out
}

#[cfg(test)]
mod render_tests {
    use super::*;
    #[test]
    fn values_are_not_placeholders() {
        assert_eq!(inline_parameters(Engine::Mysql, "INSERT INTO `?` VALUES (?, ?)", &[DbValue::Int(7), DbValue::Text("? $1".into())]), "INSERT INTO `?` VALUES (7, '? $1')");
        assert_eq!(inline_parameters(Engine::Postgres, "SELECT $1,$2", &[DbValue::Text("$2".into()), DbValue::Int(9)]), "SELECT '$2',9");
    }
}

#[cfg(test)]
mod readonly_guard_tests {
    use super::*;
    #[test]
    fn readonly_values_cannot_be_submitted() {
        assert!(reject_truncated(&DbValue::ReadOnly("[1,2]".into())).is_err());
        assert!(reject_truncated(&DbValue::Null).is_ok());
    }
}

#[cfg(test)]
mod mysql_bit_write_tests {
    use super::*;

    fn metadata() -> std::collections::HashMap<String, String> {
        [("flag", "bit(1)"), ("id", "bit(64)"), ("wide", "bit(64)"), ("y", "year")]
            .into_iter().map(|(name, raw)| (name.into(), raw.into())).collect()
    }

    fn key() -> Vec<CellValue> {
        vec![CellValue { column: "id".into(), value: DbValue::Bytes(vec![255; 8]) }]
    }

    #[test]
    fn mysql_bit_parameters_are_numeric_in_every_write_position() {
        let adapter = mysql::MySqlAdapter::for_sql_tests();
        let types = metadata();
        let change = CellChange { column: "flag".into(), old_value: DbValue::Bytes(vec![0]), new_value: DbValue::Text("1".into()) };
        let statements = build_change_statements(&adapter, "qa", None, "t", &[
            RowChange::Insert { values: vec![CellValue { column: "wide".into(), value: DbValue::Text(u64::MAX.to_string()) }, CellValue { column: "flag".into(), value: DbValue::Null }] },
            RowChange::Update { keys: key(), changes: vec![change] },
            RowChange::Delete { keys: key() },
        ], &types).unwrap();
        assert_eq!(statements[0].params, vec![DbValue::UInt(u64::MAX)]);
        assert!(statements[0].sql.ends_with("VALUES (?, NULL)"));
        assert_eq!(statements[1].params, vec![DbValue::UInt(1), DbValue::UInt(u64::MAX), DbValue::UInt(0)]);
        assert!(statements[1].sql.contains("`flag` <=> ?"));
        assert_eq!(statements[2].params, vec![DbValue::UInt(u64::MAX)]);
        let direct = build_cell_update(&adapter, "qa", None, "t", "flag", &key(), &DbValue::Bytes(vec![0]), &DbValue::Int(1), &types).unwrap();
        assert_eq!(direct.params, statements[1].params);
    }

    #[test]
    fn mysql_bit_rejects_invalid_set_old_key_and_direct_values() {
        let adapter = mysql::MySqlAdapter::for_sql_tests();
        let types = metadata();
        let invalid = DbValue::Bytes(vec![b'1']);
        for (old_value, new_value) in [(DbValue::Int(0), invalid.clone()), (invalid.clone(), DbValue::Int(1))] {
            let changes = [RowChange::Update { keys: key(), changes: vec![CellChange { column: "flag".into(), old_value: old_value.clone(), new_value: new_value.clone() }] }];
            assert!(build_change_statements(&adapter, "qa", None, "t", &changes, &types).is_err());
            assert!(build_cell_update(&adapter, "qa", None, "t", "flag", &key(), &old_value, &new_value, &types).is_err());
        }
        for change in [RowChange::Insert { values: vec![CellValue { column: "flag".into(), value: invalid.clone() }] }, RowChange::Delete { keys: vec![CellValue { column: "flag".into(), value: invalid.clone() }] }] {
            assert!(build_change_statements(&adapter, "qa", None, "t", &[change], &types).is_err());
        }
        assert!(build_cell_update(&adapter, "qa", None, "t", "flag", &key(), &DbValue::Int(0), &DbValue::ReadOnly("preview".into()), &types).is_err());
        let legacy = build_cell_update(&adapter, "qa", None, "t", "y", &key(), &DbValue::Int(2025), &DbValue::Text("2026".into()), &types).unwrap();
        assert_eq!(legacy.params, vec![DbValue::UInt(2026), DbValue::UInt(u64::MAX), DbValue::UInt(2025)]);
    }

    #[test]
    fn mysql_json_parameters_use_json_comparison_without_changing_text() {
        let adapter = mysql::MySqlAdapter::for_sql_tests();
        let old = DbValue::Json("{\"n\":18446744073709551616,\"v\":0.1234567890123456789}".into());
        let new = DbValue::Json("{\"n\":18446744073709551617}".into());
        for (raw_type, cast) in [("json", true), ("longtext", false)] {
            let types = [("payload".into(), raw_type.into())].into_iter().collect();
            let statement = build_cell_update(&adapter, "qa", None, "t", "payload", &[CellValue { column: "id".into(), value: DbValue::Int(1) }], &old, &new, &types).unwrap();
            assert_eq!(statement.sql.matches("CAST(? AS JSON)").count(), if cast { 2 } else { 0 });
            assert_eq!(statement.params, vec![new.clone(), DbValue::Int(1), old.clone()]);
        }
    }
}
