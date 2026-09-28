#[path = "postgres_vector.rs"]
mod vector;
use async_trait::async_trait;
use chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, Utc};
use sqlx::postgres::{PgConnectOptions, PgPool, PgPoolOptions, PgRow, PgSslMode, PgValueFormat};
use sqlx::types::BigDecimal;
use sqlx::{Column, ConnectOptions, Connection, Executor, Postgres, Row, ValueRef};
use std::collections::HashMap;
use std::str::FromStr;
use tokio::sync::Mutex;

use crate::error::{AppError, AppResult};
use crate::meta::value::{preview_bytes, preview_json, preview_text, DbValue};
use crate::meta::{
    CanonicalType, ColumnMeta, DatabaseMeta, Engine, ForeignKeyMeta, IndexColumn, IndexMeta,
    InfoEntry, TableExtraInfo, TableKind, TableMeta, TableRef,
};

use super::{
    connect_timeout, ColumnInfo, ConnectionParams, DbAdapter, QueryContext, QueryOutcome, SqlParams,
};

pub struct PostgresAdapter {
    params: ConnectionParams,
    default_db: String,
    pools: Mutex<HashMap<String, PgPool>>,
}

fn map_ssl_mode(mode: Option<&str>) -> PgSslMode {
    match mode.unwrap_or("prefer").to_ascii_lowercase().as_str() {
        "disable" | "disabled" => PgSslMode::Disable,
        "require" => PgSslMode::Require,
        "verify-ca" => PgSslMode::VerifyCa,
        "verify-full" | "verify-identity" => PgSslMode::VerifyFull,
        _ => PgSslMode::Prefer,
    }
}

impl PostgresAdapter {
    pub async fn connect(params: &ConnectionParams) -> AppResult<Self> {
        let default_db = params
            .database
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .unwrap_or("postgres")
            .to_string();

        let mut pools = HashMap::new();
        let pool = connect_pool(params, &default_db).await?;
        pools.insert(default_db.clone(), pool);

        Ok(Self {
            params: params.clone(),
            default_db,
            pools: Mutex::new(pools),
        })
    }

    async fn pool_for(&self, database: &str) -> AppResult<PgPool> {
        let database = if database.trim().is_empty() {
            &self.default_db
        } else {
            database
        };
        let mut pools = self.pools.lock().await;
        if let Some(pool) = pools.get(database) {
            return Ok(pool.clone());
        }
        let pool = connect_pool(&self.params, database).await?;
        pools.insert(database.to_string(), pool.clone());
        Ok(pool)
    }
}

async fn connect_pool(params: &ConnectionParams, database: &str) -> AppResult<PgPool> {
    let mut opts = PgConnectOptions::new()
        .host(params.host.as_deref().unwrap_or("127.0.0.1"))
        .database(database)
        .ssl_mode(map_ssl_mode(params.ssl_mode.as_deref()))
        .log_statements(tracing::log::LevelFilter::Trace);

    if let Some(path)=&params.network.ca_file {opts=opts.ssl_root_cert(path);}
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

    let read_only = params.read_only;
    let pool = PgPoolOptions::new()
        .after_connect(move |conn, _| Box::pin(async move { if read_only { sqlx::query("SET default_transaction_read_only = on").execute(conn).await?; } Ok(()) }))
        .max_connections(5)
        .acquire_timeout(connect_timeout(params))
        .connect_with(opts)
        .await?;
    Ok(pool)
}

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

fn text(row: &PgRow, col: &str) -> String {
    row.try_get::<String, _>(col).unwrap_or_default()
}

fn text_opt(row: &PgRow, col: &str) -> Option<String> {
    row.try_get::<Option<String>, _>(col).unwrap_or(None)
}

fn i64_opt(row: &PgRow, col: &str) -> Option<i64> {
    if let Ok(value) = row.try_get::<Option<i64>, _>(col) {
        return value;
    }
    if let Ok(value) = row.try_get::<Option<i32>, _>(col) {
        return value.map(i64::from);
    }
    if let Ok(value) = row.try_get::<Option<i16>, _>(col) {
        return value.map(i64::from);
    }
    None
}

fn bool_opt(row: &PgRow, col: &str) -> Option<bool> {
    row.try_get::<Option<bool>, _>(col).unwrap_or(None)
}

fn fk_action(code: i8) -> String {
    match code as u8 as char {
        'r' => "RESTRICT",
        'c' => "CASCADE",
        'n' => "SET NULL",
        'd' => "SET DEFAULT",
        _ => "NO ACTION",
    }
    .to_string()
}

fn decode_cell(row: &PgRow, idx: usize) -> DbValue {
    let type_name = sqlx::TypeInfo::name(row.column(idx).type_info()).to_ascii_uppercase();

    let raw = match row.try_get_raw(idx) {
        Ok(raw) if raw.is_null() => return DbValue::Null,
        Ok(raw) => raw,
        Err(_) => return DbValue::ReadOnly(format!("[读取失败：{}]", type_name)),
    };
    if type_name == "VECTOR" {
        return match raw.as_bytes().map_err(|_| "无法读取向量字节").and_then(|bytes| vector::decode_vector(bytes, raw.format() == PgValueFormat::Binary)) {
            Ok(value) => DbValue::ReadOnly(value),
            Err(error) => DbValue::ReadOnly(format!("[向量解析失败：{}]", error)),
        };
    }

    match type_name.as_str() {
        "BOOL" => {
            if let Ok(v) = row.try_get::<Option<bool>, _>(idx) {
                return v.map_or(DbValue::Null, DbValue::Bool);
            }
        }
        "INT2" => {
            if let Ok(v) = row.try_get::<Option<i16>, _>(idx) {
                return v.map_or(DbValue::Null, |x| DbValue::Int(x as i64));
            }
        }
        "INT4" => {
            if let Ok(v) = row.try_get::<Option<i32>, _>(idx) {
                return v.map_or(DbValue::Null, |x| DbValue::Int(x as i64));
            }
        }
        "INT8" => {
            if let Ok(v) = row.try_get::<Option<i64>, _>(idx) {
                return v.map_or(DbValue::Null, DbValue::Int);
            }
        }
        "FLOAT4" => {
            if let Ok(v) = row.try_get::<Option<f32>, _>(idx) {
                return v.map_or(DbValue::Null, |x| DbValue::Float(x as f64));
            }
        }
        "FLOAT8" => {
            if let Ok(v) = row.try_get::<Option<f64>, _>(idx) {
                return v.map_or(DbValue::Null, DbValue::Float);
            }
        }
        "NUMERIC" => {
            if let Ok(v) = row.try_get::<Option<BigDecimal>, _>(idx) {
                return v.map_or(DbValue::Null, |x| DbValue::Decimal(x.to_string()));
            }
        }
        "TEXT" | "VARCHAR" | "BPCHAR" | "NAME" | "CHAR" | "UNKNOWN" => {
            if let Ok(v) = row.try_get::<Option<String>, _>(idx) {
                return v.map_or(DbValue::Null, preview_text);
            }
        }
        "BYTEA" => {
            if let Ok(v) = row.try_get::<Option<Vec<u8>>, _>(idx) {
                return v.map_or(DbValue::Null, preview_bytes);
            }
        }
        "DATE" => {
            if let Ok(v) = row.try_get::<Option<NaiveDate>, _>(idx) {
                return v.map_or(DbValue::Null, |x| DbValue::Date(x.to_string()));
            }
        }
        "TIME" => {
            if let Ok(v) = row.try_get::<Option<NaiveTime>, _>(idx) {
                return v.map_or(DbValue::Null, |x| DbValue::Time(x.to_string()));
            }
        }
        "TIMESTAMP" => {
            if let Ok(v) = row.try_get::<Option<NaiveDateTime>, _>(idx) {
                return v.map_or(DbValue::Null, |x| {
                    DbValue::DateTime(x.format("%Y-%m-%d %H:%M:%S%.f").to_string())
                });
            }
        }
        "TIMESTAMPTZ" => {
            if let Ok(v) = row.try_get::<Option<DateTime<Utc>>, _>(idx) {
                return v.map_or(DbValue::Null, |x| DbValue::DateTime(x.to_rfc3339()));
            }
        }
        "JSON" | "JSONB" => {
            if let Ok(v) = row.try_get::<Option<serde_json::Value>, _>(idx) {
                return v.map_or(DbValue::Null, |x| preview_json(x.to_string()));
            }
        }
        "UUID" => {
            if let Ok(v) = row.try_get::<Option<uuid::Uuid>, _>(idx) {
                return v.map_or(DbValue::Null, |x| DbValue::Uuid(x.to_string()));
            }
        }
        _ => {}
    }

    // 数组类型（类型名可能是 _TEXT 或 TEXT[]），以 JSON 文本展示
    if type_name.starts_with('_') || type_name.ends_with("[]") {
        if let Ok(v) = row.try_get::<Option<Vec<String>>, _>(idx) {
            if let Some(items) = v {
                return DbValue::Json(serde_json::to_string(&items).unwrap_or_default());
            }
            return DbValue::Null;
        }
        if let Ok(v) = row.try_get::<Option<Vec<i64>>, _>(idx) {
            if let Some(items) = v {
                return DbValue::Json(serde_json::to_string(&items).unwrap_or_default());
            }
            return DbValue::Null;
        }
        if let Ok(v) = row.try_get::<Option<Vec<i32>>, _>(idx) {
            if let Some(items) = v {
                return DbValue::Json(serde_json::to_string(&items).unwrap_or_default());
            }
            return DbValue::Null;
        }
        if let Ok(v) = row.try_get::<Option<Vec<f64>>, _>(idx) {
            if let Some(items) = v {
                return DbValue::Json(serde_json::to_string(&items).unwrap_or_default());
            }
            return DbValue::Null;
        }
        if let Ok(v) = row.try_get::<Option<Vec<bool>>, _>(idx) {
            if let Some(items) = v {
                return DbValue::Json(serde_json::to_string(&items).unwrap_or_default());
            }
            return DbValue::Null;
        }
        if let Ok(v) = row.try_get::<Option<Vec<uuid::Uuid>>, _>(idx) {
            if let Some(items) = v {
                let text: Vec<String> = items.iter().map(|item| item.to_string()).collect();
                return DbValue::Json(serde_json::to_string(&text).unwrap_or_default());
            }
            return DbValue::Null;
        }
    }

    if let Ok(v) = row.try_get::<Option<String>, _>(idx) {
        return v.map_or(DbValue::Null, preview_text);
    }
    if let Ok(v) = row.try_get::<Option<i64>, _>(idx) {
        return v.map_or(DbValue::Null, DbValue::Int);
    }
    if let Ok(v) = row.try_get::<Option<f64>, _>(idx) {
        return v.map_or(DbValue::Null, DbValue::Float);
    }
    if let Ok(v) = row.try_get::<Option<Vec<u8>>, _>(idx) {
        return v.map_or(DbValue::Null, preview_bytes);
    }
    DbValue::ReadOnly(format!("[未支持或解析失败的类型：{}；可通过 SQL 转为 text 查看]", type_name))
}

fn rows_to_outcome(rows: Vec<PgRow>, fallback: Vec<ColumnInfo>) -> QueryOutcome {
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
    query: sqlx::query::Query<'q, Postgres, sqlx::postgres::PgArguments>,
    value: &'q DbValue,
) -> sqlx::query::Query<'q, Postgres, sqlx::postgres::PgArguments> {
    match value {
        DbValue::Null => query.bind(None::<String>),
        DbValue::Bool(v) => query.bind(*v),
        DbValue::Int(v) => query.bind(*v),
        DbValue::UInt(v) => {
            if *v <= i64::MAX as u64 {
                query.bind(*v as i64)
            } else {
                query.bind(v.to_string())
            }
        }
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
impl DbAdapter for PostgresAdapter {
    fn query_timeout_secs(&self)->u64 {self.params.network.query_timeout()}
    fn engine(&self) -> Engine {
        Engine::Postgres
    }

    fn quote_ident(&self, name: &str) -> String {
        format!("\"{}\"", name.replace('"', "\"\""))
    }

    fn placeholder(&self, one_based: usize) -> String {
        format!("${one_based}")
    }

    fn null_safe_eq(&self, column: &str, placeholder: &str) -> String {
        format!("{column} IS NOT DISTINCT FROM {placeholder}")
    }

    async fn ping(&self) -> AppResult<()> {
        let pool = self.pool_for(&self.default_db).await?;
        sqlx::query("SELECT 1").fetch_one(&pool).await?;
        Ok(())
    }

    async fn server_version(&self) -> AppResult<String> {
        let pool = self.pool_for(&self.default_db).await?;
        let row = sqlx::query("SHOW server_version").fetch_one(&pool).await?;
        Ok(text(&row, "server_version"))
    }

    async fn list_databases(&self) -> AppResult<Vec<DatabaseMeta>> {
        let pool = self.pool_for(&self.default_db).await?;
        let rows = sqlx::query(
            "SELECT datname, pg_encoding_to_char(encoding) AS encoding, \
                    datcollate AS collation \
             FROM pg_database \
             WHERE datistemplate = false AND datallowconn = true \
             ORDER BY datname",
        )
        .fetch_all(&pool)
        .await?;

        Ok(rows
            .iter()
            .map(|row| DatabaseMeta {
                name: text(row, "datname"),
                charset: text_opt(row, "encoding"),
                collation: text_opt(row, "collation"),
                comment: None,
            })
            .collect())
    }

    async fn list_tables(&self, database: &str) -> AppResult<Vec<TableRef>> {
        let pool = self.pool_for(database).await?;
        let rows = sqlx::query(
            "SELECT c.relname AS name, n.nspname AS schema, \
                    CASE WHEN c.relkind IN ('v','m') THEN 'view' ELSE 'table' END AS kind, \
                    c.reltuples::bigint AS row_estimate, \
                    obj_description(c.oid, 'pg_class') AS comment, \
                    CASE WHEN c.relkind IN ('r','p') THEN pg_total_relation_size(c.oid) ELSE NULL END AS size_bytes, \
                    am.amname AS engine \
             FROM pg_class c \
             JOIN pg_namespace n ON n.oid = c.relnamespace \
             LEFT JOIN pg_am am ON am.oid = c.relam \
             WHERE c.relkind IN ('r','p','v','m') \
               AND n.nspname NOT IN ('pg_catalog', 'information_schema') \
             ORDER BY n.nspname, c.relname",
        )
        .fetch_all(&pool)
        .await?;

        Ok(rows
            .iter()
            .map(|row| {
                let estimate = i64_opt(row, "row_estimate").filter(|v| *v >= 0).map(|v| v as u64);
                TableRef {
                    name: text(row, "name"),
                    schema: text_opt(row, "schema"),
                    kind: match text(row, "kind").as_str() {
                        "view" => TableKind::View,
                        _ => TableKind::Table,
                    },
                    row_estimate: estimate,
                    comment: text_opt(row, "comment"),
                    size_bytes: i64_opt(row, "size_bytes")
                        .filter(|v| *v > 0)
                        .map(|v| v as u64),
                    engine: text_opt(row, "engine"),
                }
            })
            .collect())
    }

    async fn introspect_table(
        &self,
        database: &str,
        schema: Option<&str>,
        table: &str,
    ) -> AppResult<TableMeta> {
        let pool = self.pool_for(database).await?;
        let schema = schema.unwrap_or("public");
        let rel = format!(
            "\"{}\".\"{}\"",
            schema.replace('"', "\"\""),
            table.replace('"', "\"\"")
        );

        let col_rows = sqlx::query(
            "SELECT a.attname AS name, a.attnum AS ordinal, \
                    format_type(a.atttypid, a.atttypmod) AS raw_type, \
                    a.attnotnull AS not_null, \
                    pg_get_expr(d.adbin, d.adrelid) AS default_expr, \
                    a.attidentity AS identity, \
                    col_description(a.attrelid, a.attnum) AS comment \
             FROM pg_attribute a \
             LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum \
             WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped \
             ORDER BY a.attnum",
        )
        .bind(&rel)
        .fetch_all(&pool)
        .await?;

        if col_rows.is_empty() {
            return Err(AppError::NotFound(format!("表不存在: {schema}.{table}")));
        }

        let kind = sqlx::query(
            "SELECT CASE WHEN c.relkind IN ('v','m') THEN 'view' ELSE 'table' END AS kind, \
                    c.reltuples::bigint AS row_estimate, \
                    obj_description(c.oid, 'pg_class') AS comment \
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
             WHERE c.oid = $1::regclass",
        )
        .bind(&rel)
        .fetch_optional(&pool)
        .await?;

        let columns: Vec<ColumnMeta> = col_rows
            .iter()
            .map(|row| {
                let raw_type = text(row, "raw_type");
                let default_expr = text_opt(row, "default_expr");
                // attidentity 是单字节 "char" 类型，按 i8 解码（'a'=ALWAYS, 'd'=BY DEFAULT, 0=无）
                let identity: Option<i8> = row.try_get::<Option<i8>, _>("identity").unwrap_or(None);
                let auto_increment = identity.map(|value| value != 0).unwrap_or(false)
                    || default_expr
                        .as_deref()
                        .map(|v| v.contains("nextval("))
                        .unwrap_or(false);
                ColumnMeta {
                    name: text(row, "name"),
                    ordinal: i64_opt(row, "ordinal").unwrap_or(0) as u32,
                    canonical: CanonicalType::from_postgres(&raw_type),
                    raw_type,
                    nullable: !bool_opt(row, "not_null").unwrap_or(false),
                    default_value: default_expr,
                    auto_increment,
                    unsigned: false,
                    charset: None,
                    collation: None,
                    comment: text_opt(row, "comment"),
                }
            })
            .collect();

        let index_rows = sqlx::query(
            "SELECT i.relname AS index_name, ix.indisunique AS is_unique, \
                    ix.indisprimary AS is_primary, a.attname AS column_name, \
                    k.ordinality AS ordinality, \
                    CASE WHEN a.attname IS NULL THEN pg_get_indexdef(ix.indexrelid, k.ordinality::int, true) END AS expression \
             FROM pg_index ix \
             JOIN pg_class i ON i.oid = ix.indexrelid \
             JOIN pg_class t ON t.oid = ix.indrelid \
             JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ordinality) ON true \
             LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum \
             WHERE t.oid = $1::regclass \
             ORDER BY i.relname, k.ordinality",
        )
        .bind(&rel)
        .fetch_all(&pool)
        .await?;

        let mut indexes: Vec<IndexMeta> = Vec::new();
        let mut primary_key: Vec<(i64, String)> = Vec::new();
        for row in &index_rows {
            let index_name = text(row, "index_name");
            let is_primary = bool_opt(row, "is_primary").unwrap_or(false);
            let ordinality = i64_opt(row, "ordinality").unwrap_or(0);
            let column_name = text_opt(row, "column_name")
                .or_else(|| text_opt(row, "expression"))
                .unwrap_or_default();
            if is_primary {
                primary_key.push((ordinality, column_name.clone()));
            }
            let entry = match indexes.iter_mut().find(|i| i.name == index_name) {
                Some(entry) => entry,
                None => {
                    indexes.push(IndexMeta {
                        name: index_name.clone(),
                        columns: Vec::new(),
                        unique: bool_opt(row, "is_unique").unwrap_or(false),
                        primary: is_primary,
                        method: None,
                        comment: None,
                    });
                    indexes.last_mut().expect("just pushed")
                }
            };
            entry.columns.push(IndexColumn {
                name: column_name,
                desc: false,
                prefix_len: None,
            });
        }
        primary_key.sort_by_key(|(ord, _)| *ord);

        let fk_rows = sqlx::query(
            "SELECT con.conname AS name, att.attname AS column_name, \
                    cl2.relname AS ref_table, ns2.nspname AS ref_schema, att2.attname AS ref_column, \
                    con.confdeltype AS on_delete, con.confupdtype AS on_update, \
                    ck.ord AS ordinality \
             FROM pg_constraint con \
             JOIN pg_class cl ON cl.oid = con.conrelid \
             JOIN unnest(con.conkey) WITH ORDINALITY AS ck(attnum, ord) ON true \
             JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ck.attnum \
             JOIN unnest(con.confkey) WITH ORDINALITY AS fk(attnum, ord) ON fk.ord = ck.ord \
             JOIN pg_attribute att2 ON att2.attrelid = con.confrelid AND att2.attnum = fk.attnum \
             JOIN pg_class cl2 ON cl2.oid = con.confrelid \
             JOIN pg_namespace ns2 ON ns2.oid = cl2.relnamespace \
             WHERE con.contype = 'f' AND con.conrelid = $1::regclass \
             ORDER BY con.conname, ck.ord",
        )
        .bind(&rel)
        .fetch_all(&pool)
        .await?;

        let mut foreign_keys: Vec<ForeignKeyMeta> = Vec::new();
        for row in &fk_rows {
            let name = text(row, "name");
            let entry = match foreign_keys.iter_mut().find(|f| f.name == name) {
                Some(entry) => entry,
                None => {
                    let on_delete = row.try_get::<i8, _>("on_delete").map(fk_action).unwrap_or_default();
                    let on_update = row.try_get::<i8, _>("on_update").map(fk_action).unwrap_or_default();
                    foreign_keys.push(ForeignKeyMeta {
                        ref_database: None,
                        ref_schema: Some(text(row, "ref_schema")),
                        name,
                        columns: Vec::new(),
                        ref_table: text(row, "ref_table"),
                        ref_columns: Vec::new(),
                        on_delete,
                        on_update,
                    });
                    foreign_keys.last_mut().expect("just pushed")
                }
            };
            entry.columns.push(text(row, "column_name"));
            entry.ref_columns.push(text(row, "ref_column"));
        }

        Ok(TableMeta {
            name: table.to_string(),
            schema: Some(schema.to_string()),
            kind: kind
                .as_ref()
                .map(|row| match text(row, "kind").as_str() {
                    "view" => TableKind::View,
                    _ => TableKind::Table,
                })
                .unwrap_or(TableKind::Table),
            columns,
            primary_key: primary_key.into_iter().map(|(_, n)| n).collect(),
            indexes,
            foreign_keys,
            comment: kind.as_ref().and_then(|row| text_opt(row, "comment")),
            row_estimate: kind
                .as_ref()
                .and_then(|row| i64_opt(row, "row_estimate"))
                .filter(|v| *v >= 0)
                .map(|v| v as u64),
            raw_ddl: None,
        })
    }

    async fn server_info(&self) -> AppResult<Vec<InfoEntry>> {
        let pool = self.pool_for(&self.default_db).await?;
        let mut entries = Vec::new();
        if let Ok(row) = sqlx::query(
            "SELECT version() AS version, current_database() AS database, current_user AS current_user, \
             COALESCE(inet_server_addr()::text, '-') AS host, inet_server_port() AS port, \
             pg_size_pretty(pg_database_size(current_database())) AS db_size, \
             (SELECT count(*) FROM pg_stat_activity) AS connections, \
             (SELECT setting FROM pg_settings WHERE name = 'max_connections') AS max_connections, \
             (now() - pg_postmaster_start_time())::text AS uptime",
        )
        .fetch_one(&pool)
        .await
        {
            entries.push(entry("服务器", "版本", text(&row, "version")));
            entries.push(entry("服务器", "主机", text(&row, "host")));
            entries.push(entry(
                "服务器",
                "端口",
                i64_opt(&row, "port").map(|v| v.to_string()).unwrap_or_default(),
            ));
            entries.push(entry("服务器", "当前用户", text(&row, "current_user")));
            entries.push(entry("服务器", "最大连接数", text(&row, "max_connections")));
            entries.push(entry(
                "运行状态",
                "当前连接数",
                i64_opt(&row, "connections")
                    .map(|v| v.to_string())
                    .unwrap_or_default(),
            ));
            entries.push(entry("运行状态", "运行时间", text(&row, "uptime")));
            entries.push(entry("数据库", "当前数据库", text(&row, "database")));
            entries.push(entry("数据库", "数据库大小", text(&row, "db_size")));
        }
        Ok(entries)
    }

    async fn database_info(&self, database: &str) -> AppResult<Vec<InfoEntry>> {
        let pool = self.pool_for(&self.default_db).await?;
        let mut entries = Vec::new();
        if let Some(row) = sqlx::query(
            "SELECT pg_encoding_to_char(encoding) AS encoding, datcollate, datctype, \
             pg_size_pretty(pg_database_size(datname)) AS size \
             FROM pg_database WHERE datname = $1",
        )
        .bind(database)
        .fetch_optional(&pool)
        .await?
        {
            entries.push(entry("数据库", "名称", database.to_string()));
            entries.push(entry("数据库", "字符集编码", text(&row, "encoding")));
            entries.push(entry("数据库", "排序规则", text(&row, "datcollate")));
            entries.push(entry("数据库", "字符分类", text(&row, "datctype")));
            entries.push(entry("存储", "数据库大小", text(&row, "size")));
        }
        if let Ok(row) = sqlx::query(
            "SELECT count(*) AS tables, \
             COALESCE(sum(pg_total_relation_size(c.oid)), 0)::bigint AS size_bytes \
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
             WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog','information_schema')",
        )
        .fetch_one(&pool)
        .await
        {
            entries.push(entry(
                "存储",
                "表数量",
                i64_opt(&row, "tables").map(|v| v.to_string()).unwrap_or_default(),
            ));
            entries.push(entry(
                "存储",
                "表数据总量",
                human_bytes(i64_opt(&row, "size_bytes").unwrap_or(0).max(0) as u64),
            ));
        }
        Ok(entries)
    }

    async fn table_extra_info(
        &self,
        database: &str,
        schema: Option<&str>,
        table: &str,
    ) -> AppResult<TableExtraInfo> {
        let pool = self.pool_for(database).await?;
        let schema = schema.unwrap_or("public");
        let rel = format!(
            "\"{}\".\"{}\"",
            schema.replace('"', "\"\""),
            table.replace('"', "\"\"")
        );

        let column_row = sqlx::query(
            "SELECT a.attname AS name \
             FROM pg_attribute a \
             LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum \
             WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped \
               AND (a.attidentity <> '' OR pg_get_expr(d.adbin, d.adrelid) LIKE '%nextval%') \
             ORDER BY a.attnum LIMIT 1",
        )
        .bind(&rel)
        .fetch_optional(&pool)
        .await?;

        let mut auto_increment_value = None;
        if let Some(row) = column_row {
            let column = text(&row, "name");
            let sequence: Option<String> =
                sqlx::query_scalar("SELECT pg_get_serial_sequence($1, $2)")
                    .bind(&rel)
                    .bind(&column)
                    .fetch_one(&pool)
                    .await
                    .unwrap_or(None);
            if let Some(sequence) = sequence {
                let seq_row = sqlx::query(&format!(
                    "SELECT last_value::bigint AS v FROM {sequence}"
                ))
                .fetch_optional(&pool)
                .await
                .ok()
                .flatten();
                auto_increment_value = seq_row
                    .and_then(|row| i64_opt(&row, "v"))
                    .filter(|v| *v >= 0)
                    .map(|v| v as u64);
            }
        }

        Ok(TableExtraInfo {
            auto_increment_value,
            total_size: sqlx::query_scalar::<_, i64>(
                "SELECT CASE WHEN c.relkind IN ('r','p') THEN pg_total_relation_size(c.oid) ELSE NULL END \
                 FROM pg_class c WHERE c.oid = $1::regclass",
            )
            .bind(&rel)
            .fetch_optional(&pool)
            .await
            .ok()
            .flatten()
            .filter(|v| *v > 0)
            .map(|v| v as u64),
            ..Default::default()
        })
    }

    async fn begin_manual(&self, database: &str) -> AppResult<Box<dyn crate::services::manual_transaction::ManualTransaction>> {
        let mut tx = connect_pool(&self.params, if database.trim().is_empty(){&self.default_db}else{database}).await?.begin().await?;
        let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()").fetch_one(&mut *tx).await?; let conn_id=pid.max(0) as u64;
        Ok(Box::new(ManualTx { tx, conn_id, database: database.into() }))
    }

    async fn query_page(
        &self,
        database: &str,
        sql: &str,
        _offset: u64,
        _limit: u32,
        ctx: &QueryContext,
    ) -> AppResult<QueryOutcome> {
        let pool = self.pool_for(database).await?;
        let mut conn = pool.acquire().await?;
        let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
            .fetch_one(&mut *conn)
            .await?;
        *ctx.conn_id.lock().await = Some(pid.max(0) as u64);

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
        let pool = self.pool_for(database).await?;
        let result = sqlx::query(sql).execute(&pool).await?;
        Ok(QueryOutcome {
            affected: Some(result.rows_affected()),
            ..Default::default()
        })
    }

    async fn execute_statements(&self, database: &str, statements: &[String]) -> AppResult<()> {
        let pool = self.pool_for(database).await?;
        let mut conn = pool.acquire().await?;
        for statement in statements {
            sqlx::query(statement).execute(&mut *conn).await?;
        }
        Ok(())
    }

    async fn execute_transaction(&self, database: &str, items: &[SqlParams]) -> AppResult<u64> {
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
        let pool = self.pool_for(&self.default_db).await?;
        sqlx::query("SELECT pg_cancel_backend($1)")
            .bind(conn_id as i32)
            .execute(&pool)
            .await?;
        Ok(())
    }

    async fn fetch_full_value(&self, database: &str, sql: &str) -> AppResult<Option<DbValue>> {
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
        Ok(Some(decode_cell(&row, 0)))
    }
}

struct ManualTx { tx: sqlx::Transaction<'static, sqlx::Postgres>, conn_id:u64, database:String }
#[async_trait]
impl crate::services::manual_transaction::ManualTransaction for ManualTx {
    async fn run(&mut self, sql:&str, rows:bool, ctx:&QueryContext)->AppResult<QueryOutcome> {
        *ctx.conn_id.lock().await = if self.conn_id == 0 {None} else {Some(self.conn_id)};

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
