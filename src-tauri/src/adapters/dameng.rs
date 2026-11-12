//! DM8 native async adapter. Schemas share the existing database selector.
use super::{ColumnInfo, ConnectionParams, DbAdapter, QueryContext, QueryOutcome, SqlParams};
use crate::{
    error::{AppError, AppResult},
    meta::value::{preview_bytes, preview_text, DbValue},
    meta::{
        CanonicalType, ColumnMeta, DatabaseMeta, Engine, ForeignKeyMeta, IndexColumn, IndexMeta,
        InfoEntry, TableKind, TableMeta, TableRef,
    },
};
use async_trait::async_trait;
use chrono::{Datelike, Timelike};
use dm_rust::{ConnectOptions, Connection, Pool, PoolConfig, PooledConnection, QueryResult, Value};
use std::{collections::BTreeMap, str::FromStr, time::Duration};

#[path = "dameng/ddl.rs"]
mod ddl;

pub struct DamengAdapter {
    pool: Pool,
    options: ConnectOptions,
    version: String,
    schema: String,
}
pub fn ident(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}
fn err(error: impl std::fmt::Display) -> AppError {
    AppError::Database(format!("达梦：{error}"))
}
fn write_err(error: dm_rust::Error) -> AppError {
    match error {
        dm_rust::Error::Server { .. } | dm_rust::Error::Batch(_) => err(error),
        _ => AppError::WriteUncertain(format!(
            "达梦写入连接中断，结果尚未确认，请刷新核对后再操作：{error}"
        )),
    }
}
fn text(value: &Value) -> Option<String> {
    Some(match value {
        Value::Null => return None,
        Value::String(v) => v.clone(),
        Value::Decimal(v) => v.to_string(),
        Value::BigInt(v) => v.to_string(),
        Value::Int(v) => v.to_string(),
        Value::SmallInt(v) => v.to_string(),
        Value::TinyInt(v) => v.to_string(),
        _ => return None,
    })
}
fn field(row: &dm_rust::Row, key: &str) -> Option<String> {
    row.get_by_name(key).and_then(text)
}
fn number(row: &dm_rust::Row, key: &str) -> Option<u64> {
    field(row, key)?.parse().ok()
}
fn decode(value: &Value, preview: bool) -> DbValue {
    match value {
        Value::Null => DbValue::Null,
        Value::Bool(v) => DbValue::Bool(*v),
        Value::TinyInt(v) => DbValue::Int(*v as i64),
        Value::SmallInt(v) => DbValue::Int(*v as i64),
        Value::Int(v) => DbValue::Int(*v as i64),
        Value::BigInt(v) => DbValue::Int(*v),
        Value::Float(v) if v.is_finite() => DbValue::Float(*v as f64),
        Value::Double(v) if v.is_finite() => DbValue::Float(*v),
        Value::Float(v) => DbValue::ReadOnly(v.to_string()),
        Value::Double(v) => DbValue::ReadOnly(v.to_string()),
        Value::Decimal(v) => DbValue::Decimal(v.to_string()),
        Value::String(v) => {
            if preview {
                preview_text(v.clone())
            } else {
                DbValue::Text(v.clone())
            }
        }
        Value::Bytes(v) => {
            if preview {
                preview_bytes(v.to_vec())
            } else {
                DbValue::Bytes(v.to_vec())
            }
        }
        Value::Date(v) => DbValue::Date(v.to_string()),
        Value::Time(v) if v.tz.is_some() => DbValue::ReadOnly(v.to_string()),
        Value::DateTime(v) if v.time.tz.is_some() => DbValue::ReadOnly(v.to_string()),
        Value::Time(v) => DbValue::Time(v.to_string()),
        Value::DateTime(v) => DbValue::DateTime(v.to_string()),
        Value::IntervalYm(v) => DbValue::ReadOnly(v.to_string()),
        Value::IntervalDt(v) => DbValue::ReadOnly(v.to_string()),
        Value::Lob(_) => DbValue::ReadOnly("未解码的达梦 LOB，请使用 SQL 转换后查看".into()),
    }
}
fn parameter(value: &DbValue) -> AppResult<Value> {
    Ok(match value {
        DbValue::Null => Value::Null,
        DbValue::Bool(v) => Value::Bool(*v),
        DbValue::Int(v) => Value::BigInt(*v),
        DbValue::UInt(v) => {
            Value::Decimal(dm_rust::Decimal::from_str(&v.to_string()).map_err(err)?)
        }
        DbValue::Float(v) if v.is_finite() => Value::Double(*v),
        DbValue::Decimal(v) => Value::Decimal(dm_rust::Decimal::from_str(v).map_err(err)?),
        DbValue::Bytes(v) => v.clone().into(),
        DbValue::Date(v) => {
            let d = chrono::NaiveDate::parse_from_str(v, "%Y-%m-%d")
                .map_err(|_| AppError::InvalidInput("日期格式应为 YYYY-MM-DD".into()))?;
            Value::Date(dm_rust::Date {
                year: d.year(),
                month: d.month() as u8,
                day: d.day() as u8,
            })
        }
        DbValue::Time(v) => {
            let t = chrono::NaiveTime::parse_from_str(v, "%H:%M:%S%.f")
                .map_err(|_| AppError::InvalidInput("时间格式应为 HH:mm:ss[.小数秒]".into()))?;
            Value::Time(dm_rust::Time {
                hour: t.hour() as u8,
                minute: t.minute() as u8,
                second: t.second() as u8,
                nanos: t.nanosecond(),
                tz: None,
            })
        }
        DbValue::DateTime(v) => {
            let value = v.replace('T', " ");
            let t = chrono::NaiveDateTime::parse_from_str(&value, "%Y-%m-%d %H:%M:%S%.f").map_err(
                |_| {
                    AppError::InvalidInput(
                        "日期时间格式应为 YYYY-MM-DD HH:mm:ss[.小数秒]；时区类型请通过 SQL 修改"
                            .into(),
                    )
                },
            )?;
            Value::DateTime(dm_rust::DateTime {
                date: dm_rust::Date {
                    year: t.year(),
                    month: t.month() as u8,
                    day: t.day() as u8,
                },
                time: dm_rust::Time {
                    hour: t.hour() as u8,
                    minute: t.minute() as u8,
                    second: t.second() as u8,
                    nanos: t.nanosecond(),
                    tz: None,
                },
            })
        }
        DbValue::Text(v) | DbValue::Json(v) | DbValue::Uuid(v) => Value::String(v.clone()),
        _ => {
            return Err(AppError::InvalidInput(
                "截断、只读或非有限数值不能提交到达梦".into(),
            ))
        }
    })
}
pub(crate) fn outcome(query: QueryResult, preview: bool) -> QueryOutcome {
    QueryOutcome {
        columns: query
            .columns
            .iter()
            .map(|c| ColumnInfo {
                name: c.name.clone(),
                raw_type: c.type_name.clone(),
            })
            .collect(),
        rows: query
            .rows
            .iter()
            .map(|r| r.values.iter().map(|v| decode(v, preview)).collect())
            .collect(),
        ..Default::default()
    }
}

async fn parameters(connection: &mut Connection, item: &SqlParams) -> AppResult<Vec<Value>> {
    // CSV inputs are text. Use PREPARE's actual parameter type rather than guessing
    // from the content: a date-looking VARCHAR must remain a VARCHAR.
    use dm_rust::proto::types::{
        DATE, DATETIME, DATETIME2, DATETIME2_TZ, DATETIME_TZ, TIME, TIME_TZ,
    };
    let info = connection.prepare(&item.sql).await.map_err(err)?;
    item.params
        .iter()
        .enumerate()
        .map(|(index, value)| {
            if let DbValue::Text(text) = value {
                let typed = match info.params.get(index).map(|p| p.col_type) {
                    Some(DATE) => Some(DbValue::Date(text.clone())),
                    Some(TIME) => Some(DbValue::Time(text.clone())),
                    Some(DATETIME | DATETIME2) => Some(DbValue::DateTime(text.clone())),
                    Some(TIME_TZ | DATETIME_TZ | DATETIME2_TZ) => {
                        return Err(AppError::InvalidInput(
                            "带时区字段请通过 SQL 导入或修改，避免丢失时区".into(),
                        ))
                    }
                    _ => None,
                };
                if let Some(value) = typed {
                    return parameter(&value);
                }
            }
            parameter(value)
        })
        .collect()
}
pub fn canonical(
    raw: &str,
    precision: Option<u8>,
    scale: Option<u8>,
    length: Option<u32>,
) -> CanonicalType {
    match raw.to_ascii_uppercase().as_str() {
        "BIT" | "BOOLEAN" => CanonicalType::Bool,
        "TINYINT" | "BYTE" => CanonicalType::Int {
            bits: 8,
            unsigned: false,
        },
        "SMALLINT" => CanonicalType::Int {
            bits: 16,
            unsigned: false,
        },
        "INT" | "INTEGER" => CanonicalType::Int {
            bits: 32,
            unsigned: false,
        },
        "BIGINT" => CanonicalType::Int {
            bits: 64,
            unsigned: false,
        },
        "DEC" | "DECIMAL" | "NUMBER" | "NUMERIC" => CanonicalType::Decimal { precision, scale },
        "REAL" | "FLOAT" => CanonicalType::Float { bits: 32 },
        "DOUBLE" | "DOUBLE PRECISION" => CanonicalType::Float { bits: 64 },
        "DATE" => CanonicalType::Date,
        "TIME" | "TIME WITH TIME ZONE" => CanonicalType::Time {
            precision: scale,
            tz: raw.contains("TIME ZONE"),
        },
        "TIMESTAMP" | "DATETIME" | "TIMESTAMP WITH TIME ZONE" | "DATETIME WITH TIME ZONE" => {
            CanonicalType::DateTime {
                precision: scale,
                tz: raw.contains("TIME ZONE"),
            }
        }
        "BINARY" | "VARBINARY" | "BLOB" | "IMAGE" | "LONGVARBINARY" => {
            CanonicalType::Binary { len: length }
        }
        "CHAR" | "CHARACTER" | "VARCHAR" | "VARCHAR2" | "NVARCHAR" | "NVARCHAR2" | "NCHAR" => {
            CanonicalType::String { len: length }
        }
        "CLOB" | "TEXT" | "LONGVARCHAR" => CanonicalType::String { len: None },
        _ => CanonicalType::Unknown { raw: raw.into() },
    }
}
impl DamengAdapter {
    pub async fn connect(params: &ConnectionParams) -> AppResult<Self> {
        if params.ssl_mode.is_some() {
            return Err(AppError::InvalidInput(
                "达梦 TLS 按服务器协商，不使用 MySQL/PostgreSQL 的 SSL 模式；请清空此项后连接"
                    .into(),
            ));
        }
        let mut options = ConnectOptions::new(
            params.host.as_deref().unwrap_or("127.0.0.1"),
            params.port.unwrap_or(5236),
            params
                .username
                .as_deref()
                .filter(|s| !s.is_empty())
                .unwrap_or("SYSDBA"),
            params.password.clone().unwrap_or_default(),
        );
        options.connect_timeout = super::connect_timeout(params);
        options.request_timeout = Some(Duration::from_secs(params.network.query_timeout()));
        options.app_name = "DBFolio".into();
        options.read_only = params.read_only;
        options.schema = params.database.clone().filter(|s| !s.trim().is_empty());
        options.tls_ca_file = params.network.ca_file.as_ref().map(Into::into);
        options.tls_server_name = params.network.server_name.clone();
        if params.network.client_cert.is_some() || params.network.client_key.is_some() {
            return Err(AppError::InvalidInput(
                "达梦首版不支持客户端 TLS 证书认证".into(),
            ));
        }
        let pool = Pool::new(
            options.clone(),
            PoolConfig {
                max_size: 4,
                acquire_timeout: options.connect_timeout,
                ..Default::default()
            },
        );
        let connection = pool
            .get()
            .await
            .map_err(|e| AppError::Connection(format!("达梦连接失败：{e}")))?;
        let version = format!("DM8 {}", connection.server_version().unwrap_or("未知版本"));
        let schema = connection.current_schema().to_owned();
        drop(connection);
        Ok(Self {
            pool,
            options,
            version,
            schema,
        })
    }
    async fn connection(&self, schema: &str) -> AppResult<PooledConnection> {
        let mut c = self
            .pool
            .get()
            .await
            .map_err(|e| AppError::Connection(format!("达梦连接失败：{e}")))?;
        let schema = if schema.is_empty() {
            &self.schema
        } else {
            schema
        };
        c.execute(&format!("SET SCHEMA {}", ident(schema)), &[])
            .await
            .map_err(err)?;
        Ok(c)
    }
    async fn query(&self, schema: &str, sql: &str, params: &[Value]) -> AppResult<QueryResult> {
        self.connection(schema)
            .await?
            .query(sql, params)
            .await
            .map_err(err)
    }
    async fn transaction(&self, schema: &str, items: &[SqlParams], exact: bool) -> AppResult<u64> {
        self.writable()?;
        let mut c = self.connection(schema).await?;
        c.begin().await.map_err(err)?;
        let result = async {
            let mut count = 0;
            for item in items {
                let params = parameters(&mut c, item).await?;
                let n = c
                    .execute(&item.sql, &params)
                    .await
                    .map_err(write_err)?
                    .rows_affected;
                if exact && n != 1 {
                    return Err(AppError::InvalidInput(format!(
                        "数据已变化，本次修改应命中 1 行，实际 {n} 行，已回滚"
                    )));
                }
                count += n.max(0) as u64;
            }
            Ok(count)
        }
        .await;
        match result {
            Ok(n) => {
                c.commit().await.map_err(write_err)?;
                Ok(n)
            }
            Err(e) => {
                let _ = c.rollback().await;
                Err(e)
            }
        }
    }
    fn writable(&self) -> AppResult<()> {
        if self.options.read_only {
            Err(AppError::ReadOnly(
                "当前达梦会话为只读模式，已阻止写入".into(),
            ))
        } else {
            Ok(())
        }
    }
}
async fn cancellable_query(
    c: &mut Connection,
    sql: &str,
    ctx: &QueryContext,
) -> AppResult<QueryResult> {
    // Cancellation closes this in-flight connection; no server session id is required.
    *ctx.conn_id.lock().await = Some(0);
    if ctx.is_cancelled() {
        return Err(AppError::Cancelled("查询已取消".into()));
    }
    let future = c.query(sql, &[]);
    tokio::pin!(future);
    loop {
        tokio::select! { biased; _=tokio::time::sleep(Duration::from_millis(50))=>{if ctx.is_cancelled(){return Err(AppError::Cancelled("查询已取消".into()));}}, r=&mut future=>return r.map_err(err) }
    }
}

#[cfg(test)]
#[path = "dameng/tests.rs"]
mod tests;

#[async_trait]
impl DbAdapter for DamengAdapter {
    async fn dameng_connection(&self,database:&str,write:bool)->AppResult<Connection>{
        if write{self.writable()?;}
        let mut options=self.options.clone();options.schema=Some(if database.is_empty(){self.schema.clone()}else{database.into()});
        options.stmt_cache_capacity=0;
        Connection::connect(&options).await.map_err(err)
    }
    fn engine(&self) -> Engine {
        Engine::Dameng
    }
    fn quote_ident(&self, name: &str) -> String {
        ident(name)
    }
    fn placeholder(&self, _: usize) -> String {
        "?".into()
    }
    fn null_safe_eq(&self, column: &str, placeholder: &str) -> String {
        format!("DECODE({column},{placeholder},1,0)=1")
    }
    async fn ping(&self) -> AppResult<()> {
        self.pool
            .get()
            .await
            .map_err(err)?
            .ping()
            .await
            .map_err(err)
    }
    async fn server_version(&self) -> AppResult<String> {
        Ok(self.version.clone())
    }
    async fn column_types(
        &self,
        _database: &str,
    ) -> AppResult<crate::meta::data_types::DataTypeCatalog> {
        use crate::meta::data_types::{option, DataTypeCatalog};
        let types = [
            ("tinyint", "1 字节整数", "数值", "none", ""),
            ("smallint", "2 字节整数", "数值", "none", ""),
            ("int", "4 字节整数", "数值", "none", ""),
            ("bigint", "8 字节整数", "数值", "none", ""),
            (
                "decimal",
                "精确定点数，保留全部有效位",
                "数值",
                "precision",
                "18,2",
            ),
            ("real", "单精度浮点数", "数值", "none", ""),
            ("double", "双精度浮点数", "数值", "none", ""),
            ("bit", "布尔值 0 / 1", "布尔", "none", ""),
            ("varchar", "可变长度字符串", "文本", "length", "255"),
            ("char", "固定长度字符串", "文本", "length", "1"),
            ("clob", "大文本", "文本", "none", ""),
            ("date", "日期", "时间", "none", ""),
            ("time", "时间", "时间", "temporal", "6"),
            ("timestamp", "日期时间", "时间", "temporal", "6"),
            ("binary", "固定长度二进制", "二进制", "length", "16"),
            ("varbinary", "可变长度二进制", "二进制", "length", "255"),
            ("blob", "大二进制", "二进制", "none", ""),
        ]
        .into_iter()
        .map(|(n, d, c, a, v)| option(n, d, c, a, v))
        .collect();
        Ok(DataTypeCatalog {
            server_version: self.version.clone(),
            types,
        })
    }
    async fn list_databases(&self) -> AppResult<Vec<DatabaseMeta>> {
        let rows=self.query("","SELECT NAME FROM SYS.SYSOBJECTS WHERE TYPE$='SCH' ORDER BY CASE WHEN NAME IN ('SYS','SYSAUDITOR','SYSSSO','CTISYS') THEN 1 ELSE 0 END,NAME",&[]).await?;
        Ok(rows
            .rows
            .iter()
            .filter_map(|r| field(r, "NAME"))
            .map(|name| DatabaseMeta {
                name,
                charset: None,
                collation: None,
                comment: Some("达梦模式（Schema）".into()),
            })
            .collect())
    }
    async fn list_tables(&self, database: &str) -> AppResult<Vec<TableRef>> {
        let rows=self.query(database,"SELECT T.TABLE_NAME,'TABLE' AS KIND,T.NUM_ROWS,C.COMMENTS FROM ALL_TABLES T LEFT JOIN ALL_TAB_COMMENTS C ON C.OWNER=T.OWNER AND C.TABLE_NAME=T.TABLE_NAME WHERE T.OWNER=? UNION ALL SELECT V.VIEW_NAME,'VIEW',NULL,C.COMMENTS FROM ALL_VIEWS V LEFT JOIN ALL_TAB_COMMENTS C ON C.OWNER=V.OWNER AND C.TABLE_NAME=V.VIEW_NAME WHERE V.OWNER=? ORDER BY 1",&[database.into(),database.into()]).await?;
        Ok(rows
            .rows
            .iter()
            .map(|r| TableRef {
                name: field(r, "TABLE_NAME").unwrap_or_default(),
                schema: Some(database.into()),
                kind: if field(r, "KIND").as_deref() == Some("VIEW") {
                    TableKind::View
                } else {
                    TableKind::Table
                },
                row_estimate: number(r, "NUM_ROWS"),
                comment: field(r, "COMMENTS"),
                size_bytes: None,
                engine: Some("DM8".into()),
            })
            .collect())
    }
    async fn introspect_table(
        &self,
        database: &str,
        schema: Option<&str>,
        table: &str,
    ) -> AppResult<TableMeta> {
        let owner = schema.filter(|s| !s.is_empty()).unwrap_or(database);
        let args = [Value::from(owner), Value::from(table)];
        let object = self
            .query(
                owner,
                "SELECT TABLE_TYPE,COMMENTS FROM ALL_TAB_COMMENTS WHERE OWNER=? AND TABLE_NAME=?",
                &args,
            )
            .await?;
        let object = object
            .rows
            .first()
            .ok_or_else(|| AppError::NotFound(format!("表或视图不存在：{owner}.{table}")))?;
        let view = field(object, "TABLE_TYPE").as_deref() == Some("VIEW");
        let rows=self.query(owner,"SELECT C.COLUMN_NAME,C.COLUMN_ID,C.DATA_TYPE,C.DATA_LENGTH,C.DATA_PRECISION,C.DATA_SCALE,C.NULLABLE,C.DATA_DEFAULT,M.COMMENT$ AS COMMENTS FROM ALL_TAB_COLUMNS C LEFT JOIN SYS.SYSCOLUMNCOMMENTS M ON M.SCHNAME=C.OWNER AND M.TVNAME=C.TABLE_NAME AND M.COLNAME=C.COLUMN_NAME WHERE C.OWNER=? AND C.TABLE_NAME=? ORDER BY C.COLUMN_ID",&args).await?;
        let identities=self.query(owner,"SELECT C.NAME FROM SYS.SYSCOLUMNS C JOIN SYS.SYSOBJECTS T ON C.ID=T.ID JOIN SYS.SYSOBJECTS S ON S.ID=T.SCHID WHERE S.NAME=? AND T.NAME=? AND (C.INFO2 & 1)=1",&args).await?;
        let identities: Vec<_> = identities
            .rows
            .iter()
            .filter_map(|r| field(r, "NAME"))
            .collect();
        let columns: Vec<ColumnMeta> = rows
            .rows
            .iter()
            .map(|r| {
                let name = field(r, "COLUMN_NAME").unwrap_or_default();
                let ty = field(r, "DATA_TYPE")
                    .unwrap_or_default()
                    .to_ascii_uppercase();
                let len = number(r, "DATA_LENGTH").and_then(|n| n.try_into().ok());
                let precision = number(r, "DATA_PRECISION").and_then(|n| n.try_into().ok());
                let scale = number(r, "DATA_SCALE").and_then(|n| n.try_into().ok());
                let raw = match ty.as_str() {
                    "VARCHAR" | "VARCHAR2" | "CHAR" | "NCHAR" | "NVARCHAR" | "NVARCHAR2"
                    | "BINARY" | "VARBINARY" => {
                        len.map(|n| format!("{ty}({n})")).unwrap_or(ty.clone())
                    }
                    "DEC" | "DECIMAL" | "NUMERIC" | "NUMBER" => precision
                        .map(|p| format!("{ty}({p},{})", scale.unwrap_or(0)))
                        .unwrap_or(ty.clone()),
                    "TIMESTAMP" | "DATETIME" | "TIME" => {
                        scale.map(|s| format!("{ty}({s})")).unwrap_or(ty.clone())
                    }
                    _ => ty.clone(),
                };
                ColumnMeta {
                    name: name.clone(),
                    ordinal: number(r, "COLUMN_ID").unwrap_or(1) as u32,
                    raw_type: raw,
                    canonical: canonical(&ty, precision, scale, len),
                    nullable: field(r, "NULLABLE").as_deref() == Some("Y"),
                    default_value: field(r, "DATA_DEFAULT"),
                    auto_increment: identities.contains(&name),
                    unsigned: false,
                    charset: None,
                    collation: None,
                    comment: field(r, "COMMENTS"),
                }
            })
            .collect();
        let constraints=self.query(owner,"SELECT C.CONSTRAINT_NAME,C.CONSTRAINT_TYPE,L.COLUMN_NAME,L.POSITION,C.DELETE_RULE,CASE SUBSTR(SC.FACTION,1,1) WHEN 'C' THEN 'CASCADE' WHEN 'N' THEN 'SET NULL' WHEN 'D' THEN 'SET DEFAULT' WHEN 'A' THEN 'NO ACTION' ELSE '未知' END AS UPDATE_RULE,R.OWNER AS REF_OWNER,R.TABLE_NAME AS REF_TABLE,RC.COLUMN_NAME AS REF_COLUMN FROM ALL_CONSTRAINTS C LEFT JOIN SYS.SYSOBJECTS CSCH ON CSCH.NAME=C.OWNER AND CSCH.TYPE$='SCH' LEFT JOIN SYS.SYSOBJECTS CO ON CO.NAME=C.CONSTRAINT_NAME AND CO.SCHID=CSCH.ID LEFT JOIN SYS.SYSCONS SC ON SC.ID=CO.ID JOIN ALL_CONS_COLUMNS L ON L.OWNER=C.OWNER AND L.CONSTRAINT_NAME=C.CONSTRAINT_NAME LEFT JOIN ALL_CONSTRAINTS R ON R.OWNER=C.R_OWNER AND R.CONSTRAINT_NAME=C.R_CONSTRAINT_NAME LEFT JOIN ALL_CONS_COLUMNS RC ON RC.OWNER=R.OWNER AND RC.CONSTRAINT_NAME=R.CONSTRAINT_NAME AND RC.POSITION=L.POSITION WHERE C.OWNER=? AND C.TABLE_NAME=? AND C.CONSTRAINT_TYPE IN ('P','R') ORDER BY C.CONSTRAINT_NAME,L.POSITION",&args).await?;
        let mut primary_key = Vec::new();
        let mut foreign_keys: BTreeMap<String, ForeignKeyMeta> = BTreeMap::new();
        for r in &constraints.rows {
            let col = field(r, "COLUMN_NAME").unwrap_or_default();
            if field(r, "CONSTRAINT_TYPE").as_deref() == Some("P") {
                primary_key.push(col);
                continue;
            }
            let name = field(r, "CONSTRAINT_NAME").unwrap_or_default();
            let fk = foreign_keys
                .entry(name.clone())
                .or_insert_with(|| ForeignKeyMeta {
                    name,
                    columns: Vec::new(),
                    ref_schema: field(r, "REF_OWNER"),
                    ref_database: field(r, "REF_OWNER"),
                    ref_table: field(r, "REF_TABLE").unwrap_or_default(),
                    ref_columns: Vec::new(),
                    on_delete: field(r, "DELETE_RULE").unwrap_or_else(|| "NO ACTION".into()),
                    on_update: field(r, "UPDATE_RULE").unwrap_or_else(|| "未知".into()),
                });
            fk.columns.push(col);
            fk.ref_columns
                .push(field(r, "REF_COLUMN").unwrap_or_default());
        }
        let idx=self.query(owner,"SELECT I.INDEX_NAME,I.INDEX_TYPE,I.UNIQUENESS,C.COLUMN_NAME,C.DESCEND,C.COLUMN_POSITION,P.CONSTRAINT_TYPE FROM ALL_INDEXES I JOIN ALL_IND_COLUMNS C ON C.INDEX_OWNER=I.OWNER AND C.INDEX_NAME=I.INDEX_NAME LEFT JOIN ALL_CONSTRAINTS P ON P.OWNER=I.OWNER AND P.INDEX_NAME=I.INDEX_NAME AND P.CONSTRAINT_TYPE IN ('P','U') WHERE I.TABLE_OWNER=? AND I.TABLE_NAME=? ORDER BY I.INDEX_NAME,C.COLUMN_POSITION",&args).await?;
        let mut indexes: BTreeMap<String, IndexMeta> = BTreeMap::new();
        for r in &idx.rows {
            let name = field(r, "INDEX_NAME").unwrap_or_default();
            let primary = field(r, "CONSTRAINT_TYPE").as_deref() == Some("P");
            let constraint = field(r, "CONSTRAINT_TYPE").is_some();
            let index = indexes.entry(name.clone()).or_insert_with(|| IndexMeta {
                name,
                columns: Vec::new(),
                unique: field(r, "UNIQUENESS").as_deref() == Some("UNIQUE"),
                primary,
                method: field(r, "INDEX_TYPE"),
                comment: None,
                definition: None,
                edit_unsupported_reason: if constraint {
                    Some("约束关联索引请通过 SQL 管理，避免删除约束".into())
                } else {
                    None
                },
            });
            index.columns.push(IndexColumn {
                name: field(r, "COLUMN_NAME").unwrap_or_default(),
                desc: field(r, "DESCEND").as_deref() == Some("DESC"),
                prefix_len: None,
            });
        }
        let indexes = indexes.into_values().collect::<Vec<_>>();
        let comment = field(object, "COMMENTS");
        let definition = ddl::read(self, owner, table, view, &indexes, &columns, comment.as_deref()).await;
        Ok(TableMeta {
            name: table.into(),
            schema: Some(owner.into()),
            kind: if view {
                TableKind::View
            } else {
                TableKind::Table
            },
            columns,
            primary_key,
            indexes,
            foreign_keys: foreign_keys.into_values().collect(),
            comment,
            row_estimate: None,
            raw_ddl: definition.sql,
            ddl_warnings: definition.warnings,
        })
    }
    async fn server_info(&self) -> AppResult<Vec<InfoEntry>> {
        let mut entries = vec![InfoEntry {
            section: "服务器".into(),
            key: "版本".into(),
            value: self.version.clone(),
        }];
        let rows = self
            .query("", "SELECT NAME,INSTANCE_NAME FROM V$INSTANCE", &[])
            .await?;
        if let Some(r) = rows.rows.first() {
            for key in ["NAME", "INSTANCE_NAME"] {
                entries.push(InfoEntry {
                    section: "服务器".into(),
                    key: key.into(),
                    value: field(r, key).unwrap_or_default(),
                });
            }
        }
        Ok(entries)
    }
    async fn database_info(&self, database: &str) -> AppResult<Vec<InfoEntry>> {
        Ok(vec![
            InfoEntry {
                section: "模式".into(),
                key: "名称".into(),
                value: database.into(),
            },
            InfoEntry {
                section: "模式".into(),
                key: "对象数量".into(),
                value: self.list_tables(database).await?.len().to_string(),
            },
        ])
    }
    async fn query_page(
        &self,
        database: &str,
        sql: &str,
        _offset: u64,
        _limit: u32,
        ctx: &QueryContext,
    ) -> AppResult<QueryOutcome> {
        let mut c = self.connection(database).await?;
        Ok(outcome(cancellable_query(&mut c, sql, ctx).await?, true))
    }
    async fn query_export_page(
        &self,
        database: &str,
        sql: &str,
        _offset: u64,
        _limit: u32,
        ctx: &QueryContext,
    ) -> AppResult<QueryOutcome> {
        let mut c = self.connection(database).await?;
        Ok(outcome(cancellable_query(&mut c, sql, ctx).await?, false))
    }
    async fn execute_affected(&self, database: &str, sql: &str) -> AppResult<QueryOutcome> {
        self.writable()?;
        let n = self
            .connection(database)
            .await?
            .execute(sql, &[])
            .await
            .map_err(write_err)?
            .rows_affected;
        Ok(QueryOutcome {
            affected: Some(n.max(0) as u64),
            ..Default::default()
        })
    }
    async fn execute_statements(&self, database: &str, statements: &[String]) -> AppResult<()> {
        self.writable()?;
        let mut c = self.connection(database).await?;
        for (i, s) in statements.iter().enumerate() {
            c.execute(s, &[]).await.map_err(|e| {
                AppError::Database(format!(
                    "达梦第 {} 条语句失败：{e}。DDL 可能已隐式提交，请刷新核对已执行结果",
                    i + 1
                ))
            })?;
        }
        Ok(())
    }
    async fn execute_transaction(&self, database: &str, items: &[SqlParams]) -> AppResult<u64> {
        self.transaction(database, items, false).await
    }
    async fn execute_grid_transaction(
        &self,
        database: &str,
        items: &[SqlParams],
    ) -> AppResult<u64> {
        self.transaction(database, items, true).await
    }
    async fn cancel(&self, _conn_id: u64) -> AppResult<()> {
        Ok(())
    }
    async fn fetch_full_value(&self, database: &str, sql: &str) -> AppResult<Option<DbValue>> {
        let r = self.query(database, sql, &[]).await?;
        Ok(r.rows
            .first()
            .and_then(|r| r.values.first())
            .map(|v| decode(v, false)))
    }
    async fn begin_manual(
        &self,
        database: &str,
    ) -> AppResult<Box<dyn crate::services::manual_transaction::ManualTransaction>> {
        self.writable()?;
        let mut options = self.options.clone();
        options.schema = Some(database.into());
        let mut c = Connection::connect(&options).await.map_err(err)?;
        c.begin().await.map_err(err)?;
        Ok(Box::new(DamengTransaction(c)))
    }
}
struct DamengTransaction(Connection);
#[async_trait]
impl crate::services::manual_transaction::ManualTransaction for DamengTransaction {
    async fn run(&mut self, sql: &str, rows: bool, ctx: &QueryContext) -> AppResult<QueryOutcome> {
        if rows {
            Ok(outcome(
                cancellable_query(&mut self.0, sql, ctx).await?,
                true,
            ))
        } else {
            let n = self
                .0
                .execute(sql, &[])
                .await
                .map_err(write_err)?
                .rows_affected;
            Ok(QueryOutcome {
                affected: Some(n.max(0) as u64),
                ..Default::default()
            })
        }
    }
    async fn finish(mut self: Box<Self>, commit: bool) -> AppResult<()> {
        if commit {
            self.0.commit().await.map_err(write_err)
        } else {
            self.0.rollback().await.map_err(err)
        }
    }
}
