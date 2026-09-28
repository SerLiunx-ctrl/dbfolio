use async_trait::async_trait;
mod schema_edit;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions, SqliteRow};
use sqlx::{Column, ConnectOptions, Connection, Executor, Row, Sqlite};
use std::path::Path;
use std::time::Duration;

use crate::error::{AppError, AppResult};
use crate::meta::value::{preview_bytes, preview_text, DbValue};
use crate::meta::{
    CanonicalType, ColumnMeta, DatabaseMeta, Engine, ForeignKeyMeta, IndexColumn, IndexMeta,
    InfoEntry, TableExtraInfo, TableKind, TableMeta, TableRef,
};

use super::{connect_timeout, ColumnInfo, ConnectionParams, DbAdapter, QueryContext, QueryOutcome, SqlParams};

pub struct SqliteAdapter {
    pool: SqlitePool,
    path: String,
    read_only: bool,
    query_timeout_secs:u64,
}

impl SqliteAdapter {
    pub async fn connect(params: &ConnectionParams) -> AppResult<Self> {
        let path = params
            .file_path
            .as_deref()
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .ok_or_else(|| AppError::InvalidInput("SQLite 数据库文件路径不能为空".into()))?;

        if !Path::new(path).exists() {
            return Err(AppError::Connection(format!(
                "数据库文件不存在: {path}"
            )));
        }

        let opts = SqliteConnectOptions::new()
            .filename(path)
            .read_only(params.read_only)
            .busy_timeout(Duration::from_secs(5))
            .log_statements(tracing::log::LevelFilter::Trace);

        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .acquire_timeout(connect_timeout(params))
            .connect_with(opts)
            .await?;

        Ok(Self {
            pool,
            path: path.to_string(),
            read_only: params.read_only,
            query_timeout_secs:params.network.query_timeout(),
        })
    }
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

fn text(row: &SqliteRow, col: &str) -> String {
    row.try_get::<String, _>(col).unwrap_or_default()
}

fn text_opt(row: &SqliteRow, col: &str) -> Option<String> {
    row.try_get::<Option<String>, _>(col).unwrap_or(None)
}

fn int_opt(row: &SqliteRow, col: &str) -> Option<i64> {
    row.try_get::<Option<i64>, _>(col).unwrap_or(None)
}

fn decode_cell(row: &SqliteRow, idx: usize) -> DbValue {
    if let Ok(v) = row.try_get::<Option<i64>, _>(idx) {
        return v.map_or(DbValue::Null, DbValue::Int);
    }
    if let Ok(v) = row.try_get::<Option<f64>, _>(idx) {
        return v.map_or(DbValue::Null, DbValue::Float);
    }
    if let Ok(v) = row.try_get::<Option<String>, _>(idx) {
        return v.map_or(DbValue::Null, preview_text);
    }
    if let Ok(v) = row.try_get::<Option<Vec<u8>>, _>(idx) {
        return v.map_or(DbValue::Null, preview_bytes);
    }
    DbValue::Null
}

fn rows_to_outcome(rows: Vec<SqliteRow>, fallback: Vec<ColumnInfo>) -> QueryOutcome {
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
    query: sqlx::query::Query<'q, Sqlite, sqlx::sqlite::SqliteArguments<'q>>,
    value: &'q DbValue,
) -> sqlx::query::Query<'q, Sqlite, sqlx::sqlite::SqliteArguments<'q>> {
    match value {
        DbValue::Null => query.bind(None::<i64>),
        DbValue::Bool(v) => query.bind(if *v { 1i64 } else { 0i64 }),
        DbValue::Int(v) => query.bind(*v),
        DbValue::UInt(v) => {
            if *v <= i64::MAX as u64 {
                query.bind(*v as i64)
            } else {
                query.bind(v.to_string())
            }
        }
        DbValue::Float(v) => query.bind(*v),
        DbValue::Decimal(v) => {
            if let Ok(integer) = v.parse::<i64>() {
                query.bind(integer)
            } else if let Ok(number) = v.parse::<f64>() {
                query.bind(number)
            } else {
                query.bind(v.clone())
            }
        }
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
impl DbAdapter for SqliteAdapter {
    fn query_timeout_secs(&self)->u64 {self.query_timeout_secs}
    fn engine(&self) -> Engine {
        Engine::Sqlite
    }

    fn quote_ident(&self, name: &str) -> String {
        format!("\"{}\"", name.replace('"', "\"\""))
    }

    fn placeholder(&self, _one_based: usize) -> String {
        "?".to_string()
    }

    fn null_safe_eq(&self, column: &str, placeholder: &str) -> String {
        format!("{column} IS {placeholder}")
    }

    async fn ping(&self) -> AppResult<()> {
        sqlx::query("SELECT 1").fetch_one(&self.pool).await?;
        Ok(())
    }

    async fn server_version(&self) -> AppResult<String> {
        let row = sqlx::query("SELECT sqlite_version() AS v")
            .fetch_one(&self.pool)
            .await?;
        Ok(text(&row, "v"))
    }

    async fn list_databases(&self) -> AppResult<Vec<DatabaseMeta>> {
        Ok(vec![DatabaseMeta {
            name: "main".into(),
            charset: None,
            collation: None,
            comment: Some(self.path.clone()),
        }])
    }

    async fn list_tables(&self, _database: &str) -> AppResult<Vec<TableRef>> {
        let rows = sqlx::query(
            "SELECT name, type FROM sqlite_master \
             WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' \
             ORDER BY type, name",
        )
        .fetch_all(&self.pool)
        .await?;

        Ok(rows
            .iter()
            .map(|row| {
                let kind = match text(row, "type").as_str() {
                    "view" => TableKind::View,
                    _ => TableKind::Table,
                };
                TableRef {
                    name: text(row, "name"),
                    schema: None,
                    kind,
                    row_estimate: None,
                    comment: None,
                    size_bytes: None,
                    engine: Some("SQLite".into()),
                }
            })
            .collect())
    }

    async fn introspect_table(
        &self,
        _database: &str,
        _schema: Option<&str>,
        table: &str,
    ) -> AppResult<TableMeta> {
        let raw_ddl = sqlx::query(
            "SELECT sql FROM sqlite_master WHERE name = ? AND type IN ('table','view')",
        )
        .bind(table)
        .fetch_optional(&self.pool)
        .await?
        .and_then(|row| text_opt(&row, "sql"));

        let kind = sqlx::query("SELECT type FROM sqlite_master WHERE name = ?")
            .bind(table)
            .fetch_optional(&self.pool)
            .await?
            .map(|row| match text(&row, "type").as_str() {
                "view" => TableKind::View,
                _ => TableKind::Table,
            })
            .unwrap_or(TableKind::Table);

        let col_rows = sqlx::query(
            "SELECT cid, name, type, \"notnull\" AS is_not_null, dflt_value, pk, hidden \
             FROM pragma_table_xinfo(?) ORDER BY cid",
        )
        .bind(table)
        .fetch_all(&self.pool)
        .await?;

        let auto_columns = crate::services::column_edit::sqlite_auto_columns(raw_ddl.as_deref());
        let mut columns = Vec::new();
        let mut primary_key: Vec<(i64, String)> = Vec::new();
        for row in &col_rows {
            let name = text(row, "name");
            let raw_type = text(row, "type");
            let pk = int_opt(row, "pk").unwrap_or(0);
            let auto_increment = auto_columns.contains(&name);
            if pk > 0 {
                primary_key.push((pk, name.clone()));
            }
            columns.push(ColumnMeta {
                name,
                ordinal: int_opt(row, "cid").unwrap_or(0) as u32 + 1,
                canonical: CanonicalType::from_sqlite(&raw_type),
                raw_type,
                nullable: int_opt(row, "is_not_null").unwrap_or(0) == 0,
                default_value: text_opt(row, "dflt_value"),
                auto_increment,
                unsigned: false,
                charset: None,
                collation: None,
                comment: None,
            });
        }
        primary_key.sort_by_key(|(ord, _)| *ord);

        let index_rows = sqlx::query(
            "SELECT name, \"unique\" AS is_unique, origin FROM pragma_index_list(?) ORDER BY name",
        )
        .bind(table)
        .fetch_all(&self.pool)
        .await?;

        let mut indexes = Vec::new();
        for row in &index_rows {
            let index_name = text(row, "name");
            let unique = int_opt(row, "is_unique").unwrap_or(0) != 0;
            let origin = text(row, "origin");
            if origin == "pk" {
                continue;
            }
            let col_rows = sqlx::query(
                "SELECT name, \"desc\" AS is_desc FROM pragma_index_xinfo(?) \
                 WHERE key = 1 ORDER BY seqno",
            )
            .bind(&index_name)
            .fetch_all(&self.pool)
            .await?;
            let columns: Vec<IndexColumn> = col_rows
                .iter()
                .map(|r| IndexColumn {
                    name: text(r, "name"),
                    desc: int_opt(r, "is_desc").unwrap_or(0) != 0,
                    prefix_len: None,
                })
                .collect();
            indexes.push(IndexMeta {
                name: index_name,
                columns,
                unique,
                primary: false,
                method: None,
                comment: None,
            });
        }

        let fk_rows = sqlx::query(
            "SELECT id, seq, \"table\" AS ref_table, \"from\" AS col_from, \"to\" AS col_to, \
             on_update, on_delete FROM pragma_foreign_key_list(?) ORDER BY id, seq",
        )
        .bind(table)
        .fetch_all(&self.pool)
        .await?;

        let mut fk_map: std::collections::BTreeMap<i64, ForeignKeyMeta> = Default::default();
        for row in &fk_rows {
            let id = int_opt(row, "id").unwrap_or(0);
            let entry = fk_map.entry(id).or_insert_with(|| ForeignKeyMeta {
                        ref_database: None,
                        ref_schema: None,
                name: format!("fk_{table}_{id}"),
                columns: Vec::new(),
                ref_table: text(row, "ref_table"),
                ref_columns: Vec::new(),
                on_delete: text(row, "on_delete"),
                on_update: text(row, "on_update"),
            });
            entry.columns.push(text(row, "col_from"));
            entry.ref_columns.push(text(row, "col_to"));
        }

        Ok(TableMeta {
            name: table.to_string(),
            schema: None,
            kind,
            columns,
            primary_key: primary_key.into_iter().map(|(_, n)| n).collect(),
            indexes,
            foreign_keys: fk_map.into_values().collect(),
            comment: None,
            row_estimate: None,
            raw_ddl,
        })
    }

    async fn server_info(&self) -> AppResult<Vec<InfoEntry>> {
        let mut entries = Vec::new();
        if let Ok(row) = sqlx::query("SELECT sqlite_version() AS version")
            .fetch_one(&self.pool)
            .await
        {
            entries.push(entry("服务器", "版本", text(&row, "version")));
        }
        entries.push(entry("服务器", "数据库文件", self.path.clone()));
        if let Ok(row) = sqlx::query(
            "SELECT (SELECT * FROM pragma_page_count()) * (SELECT * FROM pragma_page_size()) AS size, \
             (SELECT * FROM pragma_page_count()) AS pages, \
             (SELECT * FROM pragma_page_size()) AS page_size, \
             (SELECT * FROM pragma_freelist_count()) AS freelist",
        )
        .fetch_one(&self.pool)
        .await
        {
            entries.push(entry(
                "存储",
                "文件大小",
                human_bytes(int_opt(&row, "size").unwrap_or(0).max(0) as u64),
            ));
            entries.push(entry("存储", "页数量", text(&row, "pages")));
            entries.push(entry("存储", "页大小（字节）", text(&row, "page_size")));
            entries.push(entry("存储", "空闲页数", text(&row, "freelist")));
        }
        Ok(entries)
    }

    async fn database_info(&self, database: &str) -> AppResult<Vec<InfoEntry>> {
        let mut entries = vec![
            entry("数据库", "名称", database.to_string()),
            entry("数据库", "数据库文件", self.path.clone()),
        ];
        if let Ok(row) = sqlx::query(
            "SELECT (SELECT * FROM pragma_page_count()) * (SELECT * FROM pragma_page_size()) AS size, \
             (SELECT * FROM pragma_freelist_count()) AS freelist",
        )
        .fetch_one(&self.pool)
        .await
        {
            entries.push(entry(
                "存储",
                "文件大小",
                human_bytes(int_opt(&row, "size").unwrap_or(0).max(0) as u64),
            ));
            entries.push(entry("存储", "空闲页数", text(&row, "freelist")));
        }
        if let Ok(row) = sqlx::query(
            "SELECT \
             (SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%') AS tables, \
             (SELECT count(*) FROM sqlite_master WHERE type = 'view') AS views, \
             (SELECT count(*) FROM sqlite_master WHERE type = 'index') AS indexes",
        )
        .fetch_one(&self.pool)
        .await
        {
            entries.push(entry("对象", "表数量", text(&row, "tables")));
            entries.push(entry("对象", "视图数量", text(&row, "views")));
            entries.push(entry("对象", "索引数量", text(&row, "indexes")));
        }
        Ok(entries)
    }

    async fn table_extra_info(
        &self,
        _database: &str,
        _schema: Option<&str>,
        table: &str,
    ) -> AppResult<TableExtraInfo> {
        // sqlite_sequence 仅在使用 AUTOINCREMENT 时存在，查询失败按无自增处理
        let auto_increment_value = sqlx::query("SELECT seq FROM sqlite_sequence WHERE name = ?")
            .bind(table)
            .fetch_optional(&self.pool)
            .await
            .ok()
            .flatten()
            .and_then(|row| int_opt(&row, "seq"))
            .filter(|v| *v >= 0)
            .map(|v| v as u64);

        Ok(TableExtraInfo {
            engine: Some("SQLite".into()),
            auto_increment_value,
            ..Default::default()
        })
    }

    async fn begin_manual(&self, database: &str) -> AppResult<Box<dyn crate::services::manual_transaction::ManualTransaction>> {
        let tx = SqlitePoolOptions::new().max_connections(1).connect_with(SqliteConnectOptions::new().filename(&self.path).foreign_keys(true)).await?.begin().await?;
        let conn_id=0;
        Ok(Box::new(ManualTx { tx, conn_id, database: database.into() }))
    }

    async fn query_page(
        &self,
        _database: &str,
        sql: &str,
        _offset: u64,
        _limit: u32,
        _ctx: &QueryContext,
    ) -> AppResult<QueryOutcome> {
        let mut conn = self.pool.acquire().await?;
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
        let rows = sqlx::query(sql).fetch_all(&mut *conn).await?;
        Ok(rows_to_outcome(rows, described))
    }

    async fn execute_affected(&self, _database: &str, sql: &str) -> AppResult<QueryOutcome> {
        let result = sqlx::query(sql).execute(&self.pool).await?;
        Ok(QueryOutcome {
            affected: Some(result.rows_affected()),
            ..Default::default()
        })
    }

    async fn execute_statements(&self, _database: &str, statements: &[String]) -> AppResult<()> {
        let mut conn = self.pool.acquire().await?;
        for statement in statements {
            sqlx::query(statement).execute(&mut *conn).await?;
        }
        Ok(())
    }

    async fn sqlite_schema_edit(&self, database: &str, spec: &crate::services::ddl::DdlSpec, apply: bool) -> AppResult<Vec<String>> {
        if apply && self.read_only { return Err(AppError::ReadOnly("只读连接不能修改表结构".into())); }
        let table=schema_edit::target(spec).ok_or_else(||crate::services::column_edit::invalid("不支持的结构操作"))?;
        let meta=self.introspect_table(database,None,table).await?;
        schema_edit::run(&self.path,&meta,spec,apply).await
    }

    async fn execute_transaction(&self, _database: &str, items: &[SqlParams]) -> AppResult<u64> {
        let mut conn = self.pool.acquire().await?;
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

    async fn execute_grid_transaction(&self, _database: &str, items: &[SqlParams]) -> AppResult<u64> {
        let mut conn = self.pool.acquire().await?;
        let mut tx = conn.begin().await?;
        for (index, item) in items.iter().enumerate() {
            let mut query = sqlx::query(&item.sql);
            for value in &item.params {
                query = bind_value(query, value);
            }
            let affected = query.execute(&mut *tx).await?.rows_affected();
            if affected != 1 {
                return Err(AppError::Message(format!(
                    "第 {} 项修改实际影响 {} 行，已回滚；请刷新数据后检查主键或并发修改",
                    index + 1, affected
                )));
            }
        }
        tx.commit().await?;
        Ok(items.len() as u64)
    }

    async fn cancel(&self, _conn_id: u64) -> AppResult<()> {
        Err(AppError::Message("SQLite 本地查询暂不支持取消".into()))
    }

    async fn fetch_full_value(&self, _database: &str, sql: &str) -> AppResult<Option<DbValue>> {
        let row = sqlx::query(sql).fetch_optional(&self.pool).await?;
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
        Ok(None)
    }
}

struct ManualTx { tx: sqlx::Transaction<'static, sqlx::Sqlite>, conn_id:u64, database:String }
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
