#[path = "mysql_export.rs"]
mod export;
use async_trait::async_trait;
use chrono::{NaiveDate, NaiveDateTime, NaiveTime};
use sqlx::mysql::{
    MySqlConnectOptions, MySqlPool, MySqlPoolOptions, MySqlQueryResult, MySqlRow, MySqlSslMode,
};
use sqlx::types::BigDecimal;
use sqlx::{Column, ConnectOptions, Connection, Executor, MySql, Row};
use std::collections::HashMap;
use std::str::FromStr;
use tokio::sync::Mutex;

use crate::error::{AppError, AppResult};
use crate::meta::value::{preview_bytes, preview_json, preview_text, DbValue};
use crate::meta::{
    CanonicalType, CharsetMeta, ColumnMeta, DatabaseMeta, Engine, ForeignKeyMeta, IndexColumn,
    IndexMeta, InfoEntry, TableExtraInfo, TableKind, TableMeta, TableRef,
};

use super::{
    connect_timeout, ColumnInfo, ConnectionParams, DbAdapter, QueryContext, QueryOutcome, SqlParams,
};



pub struct MySqlAdapter {
    params: ConnectionParams,
    pools: Mutex<HashMap<String, MySqlPool>>,
}

fn map_ssl_mode(mode: Option<&str>) -> MySqlSslMode {
    match mode.unwrap_or("prefer").to_ascii_lowercase().as_str() {
        "disable" | "disabled" => MySqlSslMode::Disabled,
        "require" => MySqlSslMode::Required,
        "verify-ca" => MySqlSslMode::VerifyCa,
        "verify-full" | "verify-identity" => MySqlSslMode::VerifyIdentity,
        _ => MySqlSslMode::Preferred,
    }
}

async fn connect_pool(params: &ConnectionParams, database: Option<&str>) -> AppResult<MySqlPool> {
    if let Some(db)=database.filter(|s| !s.is_empty()) { crate::services::database_access::check(params.allowed_databases.as_deref(),db)?; }
    let mut opts = MySqlConnectOptions::new()
        .host(params.host.as_deref().unwrap_or("127.0.0.1"))
        .ssl_mode(map_ssl_mode(params.ssl_mode.as_deref()))
        .log_statements(tracing::log::LevelFilter::Trace);

    if let Some(path)=&params.network.ca_file {opts=opts.ssl_ca(path);}
    if let Some(path)=&params.network.client_cert {opts=opts.ssl_client_cert(path);}
    if let Some(path)=&params.network.client_key {opts=opts.ssl_client_key(path);}
    if let Some(name)=&params.network.server_name {opts=opts.tls_server_name(name);}
    if let Some(port) = params.port {
        opts = opts.port(port);
    }
    if let Some(username) = params.username.as_deref().filter(|v| !v.is_empty()) {
        opts = opts.username(username);
    }
    if let Some(password) = params.password.as_deref() {
        opts = opts.password(password);
    }
    if let Some(database) = database.filter(|v| !v.is_empty()) {
        opts = opts.database(database);
    }

    let read_only = params.read_only;
    let pool = MySqlPoolOptions::new()
        .after_connect(move |conn, _| Box::pin(async move { if read_only { sqlx::query("SET SESSION TRANSACTION READ ONLY").execute(conn).await?; } Ok(()) }))
        .max_connections(5)
        .acquire_timeout(connect_timeout(params))
        .connect_with(opts)
        .await?;
    Ok(pool)
}

impl MySqlAdapter {
    #[cfg(test)]
    pub(crate) fn for_sql_tests() -> Self {
        Self { params: serde_json::from_value(serde_json::json!({"engine":"mysql"})).unwrap(), pools: Mutex::new(HashMap::new()) }
    }

    pub async fn connect(params: &ConnectionParams) -> AppResult<Self> {
        crate::services::database_access::validate(Engine::Mysql,params.allowed_databases.as_deref(),params.database.as_deref())?;
        let default_db = params
            .database
            .as_deref()
            .map(str::trim)
            .unwrap_or("")
            .to_string();
        let mut pools = HashMap::new();
        let pool = connect_pool(params, Some(default_db.as_str())).await?;
        pools.insert(default_db, pool);

        Ok(Self {
            params: params.clone(),
            pools: Mutex::new(pools),
        })
    }

    async fn pool_for(&self, database: &str) -> AppResult<MySqlPool> {
        let key = database.trim().to_string();
        if !key.is_empty() {crate::services::database_access::check(self.params.allowed_databases.as_deref(),&key)?;}
        let mut pools = self.pools.lock().await;
        if let Some(pool) = pools.get(&key) {
            return Ok(pool.clone());
        }
        let pool = connect_pool(&self.params, Some(key.as_str())).await?;
        pools.insert(key, pool.clone());
        Ok(pool)
    }
}

/// information_schema 的部分文本列可能以 BINARY/BLOB 形式返回（如 COLUMN_TYPE / COLUMN_KEY /
/// COLUMN_COMMENT），因此 String 解码失败时回退为字节再按 UTF-8 转换。
fn entry(section: &str, key: &str, value: String) -> InfoEntry {
    InfoEntry {
        section: section.to_string(),
        key: key.to_string(),
        value,
    }
}

fn human_bytes(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["B", "KB", "MB", "GB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} B")
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

fn text(row: &MySqlRow, col: &str) -> String {
    if let Ok(value) = row.try_get::<String, _>(col) {
        return value;
    }
    if let Ok(value) = row.try_get::<Vec<u8>, _>(col) {
        return String::from_utf8_lossy(&value).to_string();
    }
    String::new()
}

fn text_opt(row: &MySqlRow, col: &str) -> Option<String> {
    if let Ok(value) = row.try_get::<Option<String>, _>(col) {
        return value;
    }
    if let Ok(value) = row.try_get::<Option<Vec<u8>>, _>(col) {
        return value.map(|bytes| String::from_utf8_lossy(&bytes).to_string());
    }
    None
}

// 统计表达式（包括 SUM）可能返回 DECIMAL；避免浮点转换损失大整数精度。
fn statistic_u64(value: &BigDecimal) -> Option<u64> {
    if value < &BigDecimal::from(0) {
        return Some(0);
    }
    value.with_scale(0).to_string().parse().ok()
}

fn u64_opt(row: &MySqlRow, col: &str) -> Option<u64> {
    if let Ok(value) = row.try_get::<Option<u64>, _>(col) {
        return value;
    }
    if let Ok(value) = row.try_get::<Option<i64>, _>(col) {
        return value.map(|v| v.max(0) as u64);
    }
    if let Ok(value) = row.try_get::<Option<i32>, _>(col) {
        return value.map(|v| v.max(0) as u64);
    }
    if let Ok(value) = row.try_get::<Option<BigDecimal>, _>(col) {
        return value.as_ref().and_then(statistic_u64);
    }
    // 兼容以文本返回统计值的服务端。
    text_opt(row, col)
        .and_then(|v| BigDecimal::from_str(v.trim()).ok())
        .as_ref()
        .and_then(statistic_u64)
}

fn u32_opt(row: &MySqlRow, col: &str) -> Option<u32> {
    u64_opt(row, col).map(|v| v as u32)
}

pub(crate) fn decode_cell(row: &MySqlRow, idx: usize) -> DbValue {
    let type_name = sqlx::TypeInfo::name(row.column(idx).type_info()).to_ascii_uppercase();

    if type_name.starts_with("TINYINT")
        || type_name.starts_with("SMALLINT")
        || type_name.starts_with("MEDIUMINT")
        || type_name.starts_with("INT")
        || type_name.starts_with("BIGINT")
        || type_name == "YEAR"
    {
        if let Ok(v) = row.try_get::<Option<i64>, _>(idx) {
            return v.map_or(DbValue::Null, DbValue::Int);
        }
        if let Ok(v) = row.try_get::<Option<u64>, _>(idx) {
            return v.map_or(DbValue::Null, DbValue::UInt);
        }
    } else if type_name.starts_with("DECIMAL") || type_name == "NEWDECIMAL" {
        if let Ok(v) = row.try_get::<Option<BigDecimal>, _>(idx) {
            return v.map_or(DbValue::Null, |d| DbValue::Decimal(d.to_string()));
        }
    } else if type_name == "FLOAT" {
        if let Ok(v) = row.try_get::<Option<f32>, _>(idx) {
            return v.map_or(DbValue::Null, |x| DbValue::Float(x as f64));
        }
    } else if type_name == "DOUBLE" {
        if let Ok(v) = row.try_get::<Option<f64>, _>(idx) {
            return v.map_or(DbValue::Null, DbValue::Float);
        }
    } else if type_name == "DATE" {
        if let Ok(v) = row.try_get::<Option<NaiveDate>, _>(idx) {
            return v.map_or(DbValue::Null, |d| DbValue::Date(d.to_string()));
        }
    } else if type_name == "TIME" {
        if let Ok(v) = row.try_get::<Option<NaiveTime>, _>(idx) {
            return v.map_or(DbValue::Null, |t| DbValue::Time(t.to_string()));
        }
    } else if type_name == "DATETIME" || type_name == "TIMESTAMP" {
        if let Ok(v) = row.try_get::<Option<NaiveDateTime>, _>(idx) {
            return v.map_or(DbValue::Null, |d| DbValue::DateTime(format_date_time(d)));
        }
    } else if type_name == "JSON" {
        if let Ok(v) = row.try_get::<Option<serde_json::Value>, _>(idx) {
            return v.map_or(DbValue::Null, |j| preview_json(j.to_string()));
        }
    } else if type_name == "BIT" {
        if let Ok(v) = row.try_get::<Option<u64>, _>(idx) {
            return v.map_or(DbValue::Null, DbValue::UInt);
        }
        if let Ok(v) = row.try_get::<Option<Vec<u8>>, _>(idx) {
            return v.map_or(DbValue::Null, preview_bytes);
        }
    } else if type_name.contains("BLOB")
        || type_name.starts_with("BINARY")
        || type_name.starts_with("VARBINARY")
    {
        if let Ok(v) = row.try_get::<Option<Vec<u8>>, _>(idx) {
            return v.map_or(DbValue::Null, preview_bytes);
        }
    }

    if let Ok(v) = row.try_get::<Option<String>, _>(idx) {
        return v.map_or(DbValue::Null, preview_text);
    }
    if let Ok(v) = row.try_get::<Option<Vec<u8>>, _>(idx) {
        return v.map_or(DbValue::Null, preview_bytes);
    }
    if let Ok(v) = row.try_get::<Option<i64>, _>(idx) {
        return v.map_or(DbValue::Null, DbValue::Int);
    }
    if let Ok(v) = row.try_get::<Option<u64>, _>(idx) {
        return v.map_or(DbValue::Null, DbValue::UInt);
    }
    if let Ok(v) = row.try_get::<Option<f64>, _>(idx) {
        return v.map_or(DbValue::Null, DbValue::Float);
    }
    DbValue::Null
}

fn format_date_time(value: NaiveDateTime) -> String {
    value.format("%Y-%m-%d %H:%M:%S%.f").to_string()
}

fn rows_to_outcome(rows: Vec<MySqlRow>, fallback: Vec<ColumnInfo>) -> QueryOutcome {
    let columns = rows
        .first()
        .map(|row| {
            row.columns()
                .iter()
                .map(|column| ColumnInfo {
                    name: column.name().to_string(),
                    raw_type: sqlx::TypeInfo::name(column.type_info()).to_string(),
                })
                .collect()
        })
        .unwrap_or(fallback);
    let data = rows
        .iter()
        .map(|row| (0..row.len()).map(|idx| decode_cell(row, idx)).collect())
        .collect();
    QueryOutcome {
        columns,
        rows: data,
        affected: None,
    }
}

fn bind_value<'q>(
    query: sqlx::query::Query<'q, MySql, sqlx::mysql::MySqlArguments>,
    value: &'q DbValue,
) -> sqlx::query::Query<'q, MySql, sqlx::mysql::MySqlArguments> {
    match value {
        DbValue::Null => query.bind(None::<i64>),
        DbValue::Bool(v) => query.bind(*v),
        DbValue::Int(v) => query.bind(*v),
        DbValue::UInt(v) => query.bind(*v),
        DbValue::Float(v) => query.bind(*v),
        DbValue::Decimal(v) => match BigDecimal::from_str(v) {
            Ok(decimal) => query.bind(decimal),
            Err(_) => query.bind(v.clone()),
        },
        DbValue::Text(v)
        | DbValue::Date(v)
        | DbValue::Time(v)
        | DbValue::DateTime(v)
        | DbValue::Json(v)
        | DbValue::Uuid(v) => query.bind(v.clone()),
        DbValue::Bytes(v) => query.bind(v.clone()),
        DbValue::Truncated(_) | DbValue::ReadOnly(_) => query.bind(None::<String>),
    }
}

#[async_trait]
impl DbAdapter for MySqlAdapter {
    fn query_timeout_secs(&self)->u64 {self.params.network.query_timeout()}
    async fn mysql_connection(&self, database: &str, write: bool) -> AppResult<sqlx::MySqlConnection> {
        crate::services::database_access::check(self.params.allowed_databases.as_deref(), database)?;
        if write && self.params.read_only { return Err(AppError::ReadOnly("当前会话为只读模式".into())); }
        let pool = connect_pool(&self.params, Some(database)).await?;
        let conn = pool.acquire().await?.detach();
        pool.close().await;
        Ok(conn)
    }
    async fn export_sql(&self, request:&crate::services::sql_export::SqlExportRequest)->AppResult<crate::services::sql_export::SqlExportResult>{export::export(self,request).await}
    fn engine(&self) -> Engine {
        Engine::Mysql
    }

    fn quote_ident(&self, name: &str) -> String {
        format!("`{}`", name.replace('`', "``"))
    }

    fn placeholder(&self, _one_based: usize) -> String {
        "?".to_string()
    }

    fn null_safe_eq(&self, column: &str, placeholder: &str) -> String {
        format!("{column} <=> {placeholder}")
    }

    async fn ping(&self) -> AppResult<()> {
        let pool = self.pool_for("").await?;
        sqlx::query("SELECT 1").fetch_one(&pool).await?;
        Ok(())
    }

    async fn server_version(&self) -> AppResult<String> {
        let pool = self.pool_for("").await?;
        let row = sqlx::query("SELECT VERSION() AS v")
            .fetch_one(&pool)
            .await?;
        Ok(text(&row, "v"))
    }

    async fn list_databases(&self) -> AppResult<Vec<DatabaseMeta>> {
        let pool = self.pool_for("").await?;
        let rows = sqlx::query(
            "SELECT SCHEMA_NAME, DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME \
             FROM information_schema.SCHEMATA \
             ORDER BY SCHEMA_NAME",
        )
        .fetch_all(&pool)
        .await?;

        Ok(rows
            .iter()
            .filter(|row| crate::services::database_access::check(self.params.allowed_databases.as_deref(), &text(row,"SCHEMA_NAME")).is_ok())
            .map(|row| DatabaseMeta {
                name: text(row, "SCHEMA_NAME"),
                charset: text_opt(row, "DEFAULT_CHARACTER_SET_NAME"),
                collation: text_opt(row, "DEFAULT_COLLATION_NAME"),
                comment: None,
            })
            .collect())
    }

    async fn list_tables(&self, database: &str) -> AppResult<Vec<TableRef>> {
        let rows = sqlx::query(
            "SELECT TABLE_NAME, TABLE_TYPE, TABLE_ROWS, TABLE_COMMENT, ENGINE, \
             (COALESCE(DATA_LENGTH, 0) + COALESCE(INDEX_LENGTH, 0)) AS size_bytes \
             FROM information_schema.TABLES \
             WHERE TABLE_SCHEMA = ? AND TABLE_TYPE IN ('BASE TABLE','VIEW') \
             ORDER BY TABLE_TYPE, TABLE_NAME",
        )
        .bind(database)
        .fetch_all(&self.pool_for(database).await?)
        .await?;

        Ok(rows
            .iter()
            .map(|row| {
                let kind = match text(row, "TABLE_TYPE").as_str() {
                    "VIEW" => TableKind::View,
                    _ => TableKind::Table,
                };
                let comment = text_opt(row, "TABLE_COMMENT")
                    .filter(|c| !c.is_empty() && c.as_str() != "VIEW" && kind == TableKind::Table);
                TableRef {
                    name: text(row, "TABLE_NAME"),
                    schema: None,
                    kind,
                    row_estimate: u64_opt(row, "TABLE_ROWS"),
                    comment,
                    size_bytes: if kind == TableKind::Table {
                        u64_opt(row, "size_bytes")
                    } else {
                        None
                    },
                    engine: text_opt(row, "ENGINE").filter(|v| !v.is_empty()),
                }
            })
            .collect())
    }

    async fn introspect_table(
        &self,
        database: &str,
        _schema: Option<&str>,
        table: &str,
    ) -> AppResult<TableMeta> {
        let pool = self.pool_for(database).await?;
        let table_info = sqlx::query(
            "SELECT TABLE_TYPE, TABLE_ROWS, TABLE_COMMENT FROM information_schema.TABLES \
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
        )
        .bind(database)
        .bind(table)
        .fetch_optional(&pool)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("表不存在: {database}.{table}")))?;

        let kind = match text(&table_info, "TABLE_TYPE").as_str() {
            "VIEW" => TableKind::View,
            _ => TableKind::Table,
        };

        let col_rows = sqlx::query(
            "SELECT COLUMN_NAME, ORDINAL_POSITION, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, \
             EXTRA, COLUMN_KEY, CHARACTER_SET_NAME, COLLATION_NAME, COLUMN_COMMENT \
             FROM information_schema.COLUMNS \
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
        )
        .bind(database)
        .bind(table)
        .fetch_all(&pool)
        .await?;

        let mut columns = Vec::new();
        let mut primary_key = Vec::new();
        for row in &col_rows {
            let name = text(row, "COLUMN_NAME");
            let raw_type = text(row, "COLUMN_TYPE");
            let extra = text(row, "EXTRA");
            if text(row, "COLUMN_KEY") == "PRI" {
                primary_key.push(name.clone());
            }
            columns.push(ColumnMeta {
                canonical: CanonicalType::from_mysql(&raw_type),
                raw_type,
                name,
                ordinal: u32_opt(row, "ORDINAL_POSITION").unwrap_or(0),
                nullable: text(row, "IS_NULLABLE").eq_ignore_ascii_case("YES"),
                default_value: text_opt(row, "COLUMN_DEFAULT"),
                auto_increment: extra.contains("auto_increment"),
                unsigned: text(row, "COLUMN_TYPE").contains("unsigned"),
                charset: text_opt(row, "CHARACTER_SET_NAME"),
                collation: text_opt(row, "COLLATION_NAME"),
                comment: text_opt(row, "COLUMN_COMMENT").filter(|c| !c.is_empty()),
            });
        }

        let index_rows = sqlx::query(
            "SELECT INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME, COLLATION, SUB_PART, INDEX_TYPE, INDEX_COMMENT \
             FROM information_schema.STATISTICS \
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX",
        )
        .bind(database)
        .bind(table)
        .fetch_all(&pool)
        .await?;

        let mut indexes: Vec<IndexMeta> = Vec::new();
        for row in &index_rows {
            let index_name = text(row, "INDEX_NAME");
            let unique = u64_opt(row, "NON_UNIQUE").unwrap_or(1) == 0;
            let entry = match indexes.iter_mut().find(|i| i.name == index_name) {
                Some(entry) => entry,
                None => {
                    indexes.push(IndexMeta {
                        name: index_name.clone(),
                        columns: Vec::new(),
                        unique,
                        primary: index_name == "PRIMARY",
                        method: text_opt(row, "INDEX_TYPE"),
                        comment: text_opt(row, "INDEX_COMMENT").filter(|c| !c.is_empty()),
                    });
                    indexes.last_mut().expect("just pushed")
                }
            };
            entry.columns.push(IndexColumn {
                name: text(row, "COLUMN_NAME"),
                desc: text(row, "COLLATION") == "D",
                prefix_len: u32_opt(row, "SUB_PART"),
            });
        }

        if let Some(primary) = indexes.iter().find(|i| i.primary) { primary_key = primary.columns.iter().map(|c| c.name.clone()).collect(); }

        let fk_rows = sqlx::query(
            "SELECT k.CONSTRAINT_NAME, k.COLUMN_NAME, k.REFERENCED_TABLE_NAME, \
             k.REFERENCED_COLUMN_NAME, k.REFERENCED_TABLE_SCHEMA, r.DELETE_RULE, r.UPDATE_RULE \
             FROM information_schema.KEY_COLUMN_USAGE k \
             JOIN information_schema.REFERENTIAL_CONSTRAINTS r \
               ON k.CONSTRAINT_NAME = r.CONSTRAINT_NAME \
              AND k.CONSTRAINT_SCHEMA = r.CONSTRAINT_SCHEMA \
             WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ? \
               AND k.REFERENCED_TABLE_NAME IS NOT NULL \
             ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION",
        )
        .bind(database)
        .bind(table)
        .fetch_all(&pool)
        .await?;

        let mut foreign_keys: Vec<ForeignKeyMeta> = Vec::new();
        for row in &fk_rows {
            let name = text(row, "CONSTRAINT_NAME");
            let entry = match foreign_keys.iter_mut().find(|f| f.name == name) {
                Some(entry) => entry,
                None => {
                    foreign_keys.push(ForeignKeyMeta {
                        ref_database: Some(text(row, "REFERENCED_TABLE_SCHEMA")),
                        ref_schema: None,
                        name,
                        columns: Vec::new(),
                        ref_table: text(row, "REFERENCED_TABLE_NAME"),
                        ref_columns: Vec::new(),
                        on_delete: text(row, "DELETE_RULE"),
                        on_update: text(row, "UPDATE_RULE"),
                    });
                    foreign_keys.last_mut().expect("just pushed")
                }
            };
            entry.columns.push(text(row, "COLUMN_NAME"));
            entry.ref_columns.push(text(row, "REFERENCED_COLUMN_NAME"));
        }

        let raw_ddl = fetch_raw_ddl(&pool, database, table).await;

        Ok(TableMeta {
            name: table.to_string(),
            schema: Some(database.to_string()),
            kind,
            columns,
            primary_key,
            indexes,
            foreign_keys,
            comment: text_opt(&table_info, "TABLE_COMMENT")
                .filter(|c| !c.is_empty() && c.as_str() != "VIEW"),
            row_estimate: u64_opt(&table_info, "TABLE_ROWS"),
            raw_ddl,
        })
    }

    async fn server_info(&self) -> AppResult<Vec<InfoEntry>> {
        let pool = self.pool_for("").await?;
        let mut entries = Vec::new();
        if let Ok(row) = sqlx::query(
            "SELECT VERSION() AS version, @@version_comment AS comment, @@hostname AS hostname, \
             @@port AS port, @@character_set_server AS charset, @@collation_server AS collation, \
             @@max_connections AS max_connections, CURRENT_USER() AS current_user",
        )
        .fetch_one(&pool)
        .await
        {
            entries.push(entry("服务器", "版本", text(&row, "version")));
            entries.push(entry("服务器", "版本说明", text(&row, "comment")));
            entries.push(entry("服务器", "主机名", text(&row, "hostname")));
            entries.push(entry("服务器", "端口", text(&row, "port")));
            entries.push(entry("服务器", "当前用户", text(&row, "current_user")));
            entries.push(entry("服务器", "字符集", text(&row, "charset")));
            entries.push(entry("服务器", "排序规则", text(&row, "collation")));
            entries.push(entry("服务器", "最大连接数", text(&row, "max_connections")));
        }
        if let Ok(rows) = sqlx::query(
            "SHOW GLOBAL STATUS WHERE Variable_name IN \
             ('Uptime','Threads_connected','Queries','Slow_queries','Innodb_buffer_pool_size')",
        )
        .fetch_all(&pool)
        .await
        {
            for row in &rows {
                let label = match text(row, "Variable_name").as_str() {
                    "Uptime" => "运行时间（秒）",
                    "Threads_connected" => "当前连接数",
                    "Queries" => "查询总数",
                    "Slow_queries" => "慢查询数",
                    "Innodb_buffer_pool_size" => "缓冲池大小（字节）",
                    _ => continue,
                };
                entries.push(entry("运行状态", label, text(row, "Value")));
            }
        }
        Ok(entries)
    }

    async fn database_info(&self, database: &str) -> AppResult<Vec<InfoEntry>> {
        let pool = self.pool_for(database).await?;
        let mut entries = Vec::new();
        if let Some(row) = sqlx::query(
            "SELECT DEFAULT_CHARACTER_SET_NAME AS charset, DEFAULT_COLLATION_NAME AS collation \
             FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?",
        )
        .bind(database)
        .fetch_optional(&pool)
        .await?
        {
            entries.push(entry("数据库", "名称", database.to_string()));
            entries.push(entry("数据库", "字符集", text(&row, "charset")));
            entries.push(entry("数据库", "排序规则", text(&row, "collation")));
        }
        if let Ok(row) = sqlx::query(
            "SELECT COUNT(*) AS tables, COALESCE(SUM(TABLE_ROWS), 0) AS rows, \
             COALESCE(SUM(DATA_LENGTH), 0) AS data_length, COALESCE(SUM(INDEX_LENGTH), 0) AS index_length \
             FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?",
        )
        .bind(database)
        .fetch_one(&pool)
        .await
        {
            entries.push(entry(
                "存储",
                "表数量",
                u64_opt(&row, "tables").map(|v| v.to_string()).unwrap_or_default(),
            ));
            entries.push(entry(
                "存储",
                "估算行数",
                u64_opt(&row, "rows").map(|v| v.to_string()).unwrap_or_default(),
            ));
            entries.push(entry(
                "存储",
                "数据大小",
                human_bytes(u64_opt(&row, "data_length").unwrap_or(0)),
            ));
            entries.push(entry(
                "存储",
                "索引大小",
                human_bytes(u64_opt(&row, "index_length").unwrap_or(0)),
            ));
        }
        Ok(entries)
    }

    async fn storage_engines(&self) -> AppResult<Vec<String>> {
        let pool=self.pool_for("").await?;
        let rows=sqlx::query("SHOW ENGINES").fetch_all(&pool).await?;
        Ok(rows.iter().filter(|r| matches!(text(r,"Support").as_str(),"YES"|"DEFAULT")).map(|r|text(r,"Engine")).collect())
    }
    async fn charsets(&self) -> AppResult<Vec<CharsetMeta>> {
        let pool = self.pool_for("").await?;
        let rows = sqlx::query("SHOW CHARACTER SET").fetch_all(&pool).await?;
        Ok(rows
            .iter()
            .map(|row| CharsetMeta {
                charset: text(row, "Charset"),
                default_collation: text_opt(row, "Default collation"),
            })
            .collect())
    }

    async fn collations(&self, charset: &str) -> AppResult<Vec<String>> {
        let pool = self.pool_for("").await?;
        let rows = sqlx::query("SHOW COLLATION WHERE Charset = ?")
            .bind(charset)
            .fetch_all(&pool)
            .await?;
        Ok(rows.iter().map(|row| text(row, "Collation")).collect())
    }

    async fn table_extra_info(
        &self,
        database: &str,
        _schema: Option<&str>,
        table: &str,
    ) -> AppResult<TableExtraInfo> {
        let pool = self.pool_for(database).await?;
        let row = sqlx::query(
            "SELECT ENGINE, TABLE_COLLATION, AUTO_INCREMENT, CREATE_TIME, UPDATE_TIME, \
             DATA_LENGTH, INDEX_LENGTH, DATA_LENGTH + INDEX_LENGTH AS total_size \
             FROM information_schema.TABLES \
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
        )
        .bind(database)
        .bind(table)
        .fetch_optional(&pool)
        .await?;

        let Some(row) = row else {
            return Ok(TableExtraInfo::default());
        };

        let collation = text_opt(&row, "TABLE_COLLATION").filter(|c| !c.is_empty());
        let charset = collation
            .as_deref()
            .and_then(|value| value.split('_').next())
            .map(str::to_string);

        Ok(TableExtraInfo {
            engine: text_opt(&row, "ENGINE").filter(|v| !v.is_empty()),
            charset,
            collation,
            auto_increment_value: u64_opt(&row, "AUTO_INCREMENT"),
            created_at: text_opt(&row, "CREATE_TIME").filter(|v| !v.is_empty()),
            updated_at: text_opt(&row, "UPDATE_TIME").filter(|v| !v.is_empty()),
            data_size: u64_opt(&row, "DATA_LENGTH"),
            index_size: u64_opt(&row, "INDEX_LENGTH"),
            total_size: u64_opt(&row, "total_size"),
        })
    }

    async fn begin_manual(&self, database: &str) -> AppResult<Box<dyn crate::services::manual_transaction::ManualTransaction>> {
        let mut tx = connect_pool(&self.params, Some(database)).await?.begin().await?;
        let conn_id: u64 = sqlx::query_scalar("SELECT CONNECTION_ID()").fetch_one(&mut *tx).await?;
        Ok(Box::new(ManualTx { tx, conn_id, database: database.into(), allowed_databases: self.params.allowed_databases.clone() }))
    }

    async fn query_page(
        &self,
        database: &str,
        sql: &str,
        _offset: u64,
        _limit: u32,
        ctx: &QueryContext,
    ) -> AppResult<QueryOutcome> {
        crate::services::database_access::sql(self.params.allowed_databases.as_deref(),database,sql)?;
        let pool = self.pool_for(database).await?;
        let mut conn = pool.acquire().await?;
        let conn_id: u64 = sqlx::query_scalar("SELECT CONNECTION_ID()")
            .fetch_one(&mut *conn)
            .await?;
        *ctx.conn_id.lock().await = Some(conn_id);
        let described: Vec<ColumnInfo> = conn
            .describe(sql)
            .await
            .map(|desc| {
                desc.columns
                    .iter()
                    .map(|column| ColumnInfo {
                        name: column.name().to_string(),
                        raw_type: sqlx::TypeInfo::name(column.type_info()).to_string(),
                    })
                    .collect()
            })
            .unwrap_or_default();

        let result = sqlx::query(sql).fetch_all(&mut *conn).await;
        *ctx.conn_id.lock().await = None;
        let rows = result?;
        Ok(rows_to_outcome(rows, described))
    }

    async fn execute_affected(&self, database: &str, sql: &str) -> AppResult<QueryOutcome> {
        crate::services::database_access::sql(self.params.allowed_databases.as_deref(),database,sql)?;
        let pool = self.pool_for(database).await?;
        let result: MySqlQueryResult = sqlx::query(sql).execute(&pool).await?;
        Ok(QueryOutcome {
            affected: Some(result.rows_affected()),
            ..Default::default()
        })
    }

    async fn execute_statements(&self, database: &str, statements: &[String]) -> AppResult<()> {
        for sql in statements {crate::services::database_access::sql(self.params.allowed_databases.as_deref(),database,sql)?;}
        let pool = self.pool_for(database).await?;
        let mut conn = pool.acquire().await?;
        for statement in statements {
            sqlx::query(statement).execute(&mut *conn).await?;
        }
        Ok(())
    }

    async fn execute_transaction(&self, database: &str, items: &[SqlParams]) -> AppResult<u64> {
        for item in items {crate::services::database_access::sql(self.params.allowed_databases.as_deref(),database,&item.sql)?;}
        let pool = self.pool_for(database).await?;
        let mut conn = pool.acquire().await?;
        let mut tx = conn.begin().await?;
        let mut affected = 0u64;
        for item in items {
            let mut query = sqlx::query(&item.sql);
            for value in &item.params {
                query = bind_value(query, value);
            }
            affected += query.execute(&mut *tx).await?.rows_affected();
        }
        tx.commit().await?;
        Ok(affected)
    }

    async fn cancel(&self, conn_id: u64) -> AppResult<()> {
        let pool = self.pool_for("").await?;
        sqlx::query(&format!("KILL QUERY {conn_id}"))
            .execute(&pool)
            .await?;
        Ok(())
    }

    async fn fetch_full_value(&self, database: &str, sql: &str) -> AppResult<Option<DbValue>> {
        crate::services::database_access::sql(self.params.allowed_databases.as_deref(),database,sql)?;
        let pool = self.pool_for(database).await?;
        let row = sqlx::query(sql).fetch_optional(&pool).await?;
        let Some(row) = row else { return Ok(None) };
        if row.is_empty() {
            return Ok(None);
        }
        if let Ok(value) = row.try_get::<Option<String>, _>(0) {
            return Ok(value.map(DbValue::Text));
        }
        if let Ok(value) = row.try_get::<Option<Vec<u8>>, _>(0) {
            return Ok(value.map(DbValue::Bytes));
        }
        if let Ok(value) = row.try_get::<Option<serde_json::Value>, _>(0) {
            return Ok(value.map(|value| DbValue::Json(value.to_string())));
        }
        Ok(None)
    }
}

async fn fetch_raw_ddl(pool: &MySqlPool, database: &str, table: &str) -> Option<String> {
    let quoted = format!(
        "`{}`.`{}`",
        database.replace('`', "``"),
        table.replace('`', "``")
    );

    let row = sqlx::query(&format!("SHOW CREATE TABLE {quoted}"))
        .fetch_one(pool)
        .await
        .ok()?;
    let value: String = row.try_get(1).ok()?;
    Some(value)
}

#[cfg(test)]
mod statistic_tests {
    use super::*;
    #[test]
    fn decimal_statistics_support_scaled_and_large_integers() {
        for (value, expected) in [
            ("0", Some(0)),
            ("0.000", Some(0)),
            ("65536.0000", Some(65536)),
            ("1.6384E4", Some(16384)),
            ("9007199254740993", Some(9007199254740993)),
            ("18446744073709551615", Some(u64::MAX)),
            ("18446744073709551616", None),
            ("12.75", Some(12)),
            ("-1", Some(0)),
        ] {
            assert_eq!(
                statistic_u64(&BigDecimal::from_str(value).unwrap()),
                expected,
                "{}",
                value
            );
        }
    }
}

struct ManualTx { tx: sqlx::Transaction<'static, sqlx::MySql>, conn_id:u64, database:String, allowed_databases:Option<Vec<String>> }
#[async_trait]
impl crate::services::manual_transaction::ManualTransaction for ManualTx {
    async fn run(&mut self, sql:&str, rows:bool, ctx:&QueryContext)->AppResult<QueryOutcome> {
        crate::services::database_access::sql(self.allowed_databases.as_deref(),&self.database,sql)?;
        *ctx.conn_id.lock().await = if self.conn_id == 0 {None} else {Some(self.conn_id)};
        if !rows {
            let (db,table)=crate::services::manual_transaction::mysql_target(sql,&self.database)?;
            let engine:Option<String>=sqlx::query_scalar("SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?").bind(&db).bind(&table).fetch_optional(&mut *self.tx).await?.flatten();
            if engine.as_deref()!=Some("InnoDB") {return Err(AppError::InvalidInput("手动事务仅支持修改 InnoDB 基表；目标可能为视图或非事务表".into()));}
            let triggers:i64=sqlx::query_scalar("SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA=? AND EVENT_OBJECT_TABLE=?").bind(&db).bind(&table).fetch_one(&mut *self.tx).await?;
            if triggers>0{return Err(AppError::InvalidInput("该表存在触发器，可能间接修改非事务表；首版手动事务暂不支持修改此表".into()));}
        }
        if rows {
            let described=(&mut *self.tx).describe(sql).await.map(|d|d.columns.iter().map(|c|ColumnInfo{name:c.name().into(),raw_type:sqlx::TypeInfo::name(c.type_info()).into()}).collect()).unwrap_or_default();
            let values=sqlx::query(sql).fetch_all(&mut *self.tx).await?;
            Ok(rows_to_outcome(values,described))
        } else {
            let result=sqlx::query(sql).execute(&mut *self.tx).await?;
            Ok(QueryOutcome{affected:Some(result.rows_affected()),..Default::default()})
        }
    }
    async fn finish(self:Box<Self>,commit:bool)->AppResult<()> {if commit {self.tx.commit().await?;} else {self.tx.rollback().await?;} Ok(())}
}

#[cfg(test)]
mod access_scope_tests {
    use super::*;
    #[tokio::test]
    async fn all_entry_points_reject_before_connecting() {
        let mut adapter=MySqlAdapter::for_sql_tests();
        adapter.params.allowed_databases=Some(vec!["test_db".into()]);
        let scope=|e:AppError| assert!(e.to_string().contains("数据库访问范围限制"),"{e}");
        scope(adapter.list_tables("prod").await.err().unwrap());
        scope(adapter.database_info("prod").await.err().unwrap());
        scope(adapter.introspect_table("prod",None,"t").await.err().unwrap());
        scope(adapter.table_extra_info("prod",None,"t").await.err().unwrap());
        scope(adapter.query_page("test_db","SELECT * FROM prod.t",0,10,&QueryContext::new()).await.err().unwrap());
        scope(adapter.execute_affected("test_db","DELETE FROM prod.t").await.err().unwrap());
        scope(adapter.execute_statements("test_db",&["DROP TABLE prod.t".into()]).await.err().unwrap());
        scope(adapter.execute_transaction("test_db",&[SqlParams{sql:"INSERT INTO prod.t VALUES(?)".into(),params:vec![DbValue::Int(1)]}]).await.err().unwrap());
        scope(adapter.fetch_full_value("test_db","SELECT value FROM prod.t").await.err().unwrap());
        scope(adapter.begin_manual("prod").await.err().unwrap());
        let request=serde_json::from_value(serde_json::json!({"sessionId":"s","database":"prod","tables":["t"],"allTables":false,"mode":"both","path":"unused.sql","splitFiles":false,"includeDatabase":false,"dropTables":false,"consistentSnapshot":true,"batchRows":500,"batchBytes":1048576})).unwrap();
        scope(adapter.export_sql(&request).await.err().unwrap());
    }
}
