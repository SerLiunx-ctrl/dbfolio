use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

use crate::adapters::{DbAdapter, QueryContext, QueryOutcome};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

pub const DEFAULT_PAGE_SIZE: u32 = 200;
pub const MAX_PAGE_SIZE: u32 = 5000;
/// 单条查询的最长等待时间，超时后中断等待（连接由 sqlx 回收）
pub const QUERY_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SortSpec {
    pub column: String,
    pub dir: String,
}

/// 可视化筛选条件（值由后端安全转义为 SQL 字面量）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterCondition {
    pub literal: Option<crate::meta::value::DbValue>,
    pub column: String,
    pub operator: String,
    pub value: Option<String>,
    pub value2: Option<String>,
}

pub fn value_literal(engine: crate::meta::Engine, value: &crate::meta::value::DbValue) -> AppResult<String> {
    use crate::meta::value::DbValue;
    match value {
        DbValue::Decimal(text) if text.trim()!=text || text.is_empty() || !text.chars().all(|c| c.is_ascii_digit() || "+-.eE".contains(c)) || text.parse::<f64>().map(|v| !v.is_finite()).unwrap_or(true) => return Err(AppError::InvalidInput("数字格式无效".into())),
        DbValue::Truncated(_) | DbValue::ReadOnly(_) => return Err(AppError::InvalidInput("截断或只读类型值不能作为参数或筛选值".into())),
        _ => (),
    }
    Ok(crate::adapters::render_literal(engine,value))
}

fn escape_text(engine: crate::meta::Engine, text: &str) -> String {
    match engine {
        crate::meta::Engine::Mysql => text.replace('\\', "\\\\").replace('\'', "''"),
        _ => text.replace('\'', "''"),
    }
}

fn render_filter_literal(engine: crate::meta::Engine, raw: &str) -> String {
    let value = raw.trim();
    if value.is_empty() {
        return "''".to_string();
    }
    let numeric = value
        .chars()
        .enumerate()
        .all(|(index, c)| c.is_ascii_digit() || c == '.' || (c == '-' && index == 0));
    if numeric && value.chars().any(|c| c.is_ascii_digit()) {
        return value.to_string();
    }
    match value.to_ascii_lowercase().as_str() {
        "true" => {
            return match engine {
                crate::meta::Engine::Postgres => "TRUE".into(),
                _ => "1".into(),
            }
        }
        "false" => {
            return match engine {
                crate::meta::Engine::Postgres => "FALSE".into(),
                _ => "0".into(),
            }
        }
        "null" => return "NULL".into(),
        _ => {}
    }
    format!("'{}'", escape_text(engine, value))
}

/// 根据筛选条件生成 WHERE 片段（含前导空格；无有效条件时返回空串）
pub fn build_where_clause(
    adapter: &dyn DbAdapter,
    filters: &[FilterCondition],
    conjunction: &str,
) -> AppResult<String> {
    if filters.is_empty() {
        return Ok(String::new());
    }
    let engine = adapter.engine();
    let joiner = if conjunction.eq_ignore_ascii_case("or") {
        " OR "
    } else {
        " AND "
    };

    let mut parts: Vec<String> = Vec::new();
    for filter in filters {
        let column = filter.column.trim();
        if column.is_empty() {
            continue;
        }
        let col = adapter.quote_ident(column);
        let value = filter.value.as_deref().unwrap_or("").trim();
        let value2 = filter.value2.as_deref().unwrap_or("").trim();
        let operand = match filter.literal.as_ref() { Some(v) => value_literal(engine,v)?, None => render_filter_literal(engine,value) };
        let piece = match filter.operator.as_str() {
            "eq" => format!("{col} = {operand}"),
            "ne" => format!("{col} <> {operand}"),
            "gt" => format!("{col} > {operand}"),
            "ge" => format!("{col} >= {operand}"),
            "lt" => format!("{col} < {operand}"),
            "le" => format!("{col} <= {operand}"),
            "contains" => format!("{col} LIKE {}", render_filter_literal(engine, &format!("%{value}%"))),
            "startsWith" => format!("{col} LIKE {}", render_filter_literal(engine, &format!("{value}%"))),
            "endsWith" => format!("{col} LIKE {}", render_filter_literal(engine, &format!("%{value}"))),
            "isNull" => format!("{col} IS NULL"),
            "isNotNull" => format!("{col} IS NOT NULL"),
            "in" => {
                let items: Vec<String> = value
                    .split(',')
                    .map(str::trim)
                    .filter(|item| !item.is_empty())
                    .map(|item| render_filter_literal(engine, item))
                    .collect();
                if items.is_empty() {
                    continue;
                }
                format!("{col} IN ({})", items.join(", "))
            }
            "between" => {
                format!(
                    "{col} BETWEEN {} AND {}",
                    render_filter_literal(engine, value),
                    render_filter_literal(engine, value2)
                )
            }
            other => {
                return Err(AppError::InvalidInput(format!("未知的筛选操作符: {other}")));
            }
        };
        parts.push(piece);
    }

    if parts.is_empty() {
        return Ok(String::new());
    }
    Ok(format!(" WHERE {}", parts.join(joiner)))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatementKind {
    Rows,
    Write,
    Ddl,
    Other,
}

pub fn first_keyword(sql: &str) -> String {
    let mut rest = sql.trim_start();
    loop {
        if rest.starts_with("--") {
            match rest.find('\n') {
                Some(pos) => rest = rest[pos + 1..].trim_start(),
                None => return String::new(),
            }
        } else if rest.starts_with("/*") {
            match rest.find("*/") {
                Some(pos) => rest = rest[pos + 2..].trim_start(),
                None => return String::new(),
            }
        } else {
            break;
        }
    }
    rest.chars()
        .take_while(|c| c.is_ascii_alphabetic())
        .collect::<String>()
        .to_ascii_uppercase()
}

pub fn classify(sql: &str) -> StatementKind {
    match first_keyword(sql).as_str() {
        "SELECT" | "WITH" | "SHOW" | "PRAGMA" | "EXPLAIN" | "DESCRIBE" | "DESC" | "VALUES"
        | "TABLE" => StatementKind::Rows,
        "INSERT" | "UPDATE" | "DELETE" | "REPLACE" | "MERGE" | "UPSERT" | "CALL" | "DO"
        | "LOAD" | "COPY" => StatementKind::Write,
        "CREATE" | "ALTER" | "DROP" | "RENAME" | "TRUNCATE" | "COMMENT" | "GRANT" | "REVOKE"
        | "VACUUM" | "ANALYZE" | "SET" | "BEGIN" | "COMMIT" | "ROLLBACK" | "START" => {
            StatementKind::Ddl
        }
        _ => StatementKind::Other,
    }
}

pub fn trim_sql(sql: &str) -> String {
    sql.trim().trim_end_matches(';').trim_end().to_string()
}

pub fn wrap_pagination(
    adapter: &dyn DbAdapter,
    sql: &str,
    offset: u64,
    limit: u32,
    sort: &[SortSpec],
) -> String {
    let trimmed = trim_sql(sql);
    let order_by = if sort.is_empty() {
        String::new()
    } else {
        let parts: Vec<String> = sort
            .iter()
            .filter(|item| !item.column.trim().is_empty())
            .map(|item| {
                let dir = if item.dir.eq_ignore_ascii_case("desc") {
                    "DESC"
                } else {
                    "ASC"
                };
                format!("{} {}", adapter.quote_ident(&item.column), dir)
            })
            .collect();
        if parts.is_empty() {
            String::new()
        } else {
            format!(" ORDER BY {}", parts.join(", "))
        }
    };
    format!("SELECT * FROM ({trimmed}) AS _dw_sub{order_by} LIMIT {limit} OFFSET {offset}")
}

pub struct ExecuteOptions {
    pub session_id: String,
    pub database: String,
    pub sql: String,
    pub force: bool,
    pub limit: Option<u32>,
    pub sort: Vec<SortSpec>,
}

fn error_code(error: &AppError) -> &'static str {
    error.code()
}

pub async fn execute(state: &AppState, opts: ExecuteOptions) -> AppResult<QueryOutcome> {
    let record = state.local.get_session(&opts.session_id).await?;
    let connected = state.connected(&opts.session_id).await?;
    let sql = opts.sql.trim().to_string();

    if sql.is_empty() {
        return Err(AppError::InvalidInput("SQL 不能为空".into()));
    }

    if matches!(first_keyword(&sql).as_str(), "BEGIN"|"START"|"COMMIT"|"ROLLBACK"|"SAVEPOINT"|"RELEASE"|"END") {
        return Err(AppError::InvalidInput("请使用查询页的开启事务、提交事务、回滚事务按钮；普通查询使用连接池，不能用独立 SQL 管理事务".into()));
    }
    if first_keyword(&sql)=="SET" {
        if let Ok((_,words))=super::explain::scan_sql(connected.adapter.engine(),&sql) {
            if words.split_whitespace().any(|w|w.eq_ignore_ascii_case("autocommit")||w.eq_ignore_ascii_case("transaction")) {
                return Err(AppError::InvalidInput("请使用手动事务按钮管理提交模式，普通查询连接不能修改事务设置".into()));
            }
        }
    }
    let kind = classify(&sql);
    if record.read_only { super::readonly::sql(connected.adapter.engine(), &sql)?; }
    if !opts.force {
        if let Some(reason) = super::sql_risk::danger_reason(connected.adapter.engine(), &sql) {
            return Err(AppError::Dangerous(reason));
        }
    }

    let adapter = connected.adapter.clone();
    let ctx = QueryContext::new();
    state
        .set_running(&opts.session_id, ctx.clone())
        .await;

    let started = Instant::now();
    let execution = async {
        match kind {
            StatementKind::Rows => {
                let limit = opts.limit.unwrap_or(DEFAULT_PAGE_SIZE).clamp(1, MAX_PAGE_SIZE);
                let wrapped =
                    wrap_pagination(adapter.as_ref(), &sql, 0, limit, &opts.sort);
                crate::tasks::query(adapter.as_ref(), &ctx, adapter.query_page(&opts.database, &wrapped, 0, limit, &ctx)).await
            }
            _ => { crate::tasks::checkpoint()?; adapter.execute_affected(&opts.database, &sql).await },
        }
    };
    let result = match tokio::time::timeout(QUERY_TIMEOUT, execution).await {
        Ok(inner) => inner,
        Err(_) => Err(AppError::Database(format!(
            "查询超过 {} 秒未完成，已中断等待；请优化查询或缩小范围",
            QUERY_TIMEOUT.as_secs()
        ))),
    };
    state.clear_running(&opts.session_id).await;
    let duration_ms = started.elapsed().as_millis() as i64;

    match &result {
        Ok(outcome) => {
            let affected = outcome.affected.map(|v| v as i64);
            tracing::info!(
                rows = outcome.rows.len(),
                affected = ?outcome.affected,
                duration_ms,
                sql = %sql,
                "查询完成"
            );
            let _ = state
                .local
                .insert_history(
                    &opts.session_id,
                    Some(&opts.database),
                    &sql,
                    true,
                    affected,
                    duration_ms,
                    None,
                )
                .await;
        }
        Err(error) => {
            tracing::warn!(error = %error, sql = %sql, "查询执行失败");
            let _ = state
                .local
                .insert_history(
                    &opts.session_id,
                    Some(&opts.database),
                    &sql,
                    false,
                    None,
                    duration_ms,
                    Some(error_code(error)),
                )
                .await;
        }
    }

    result
}

pub async fn fetch_page(
    state: &AppState,
    session_id: &str,
    database: &str,
    sql: &str,
    offset: u64,
    limit: u32,
    sort: &[SortSpec],
) -> AppResult<QueryOutcome> {
    let connected = state.connected(session_id).await?;
    if state.local.get_session(session_id).await?.read_only { super::readonly::sql(connected.adapter.engine(), sql)?; }
    let limit = limit.clamp(1, MAX_PAGE_SIZE);
    let wrapped = wrap_pagination(connected.adapter.as_ref(), sql, offset, limit, sort);
    let ctx = QueryContext::new();
    state.set_running(session_id, ctx.clone()).await;
    let result = match tokio::time::timeout(
        QUERY_TIMEOUT,
        crate::tasks::query(connected.adapter.as_ref(), &ctx, connected.adapter.query_page(database, &wrapped, offset, limit, &ctx)),
    )
    .await
    {
        Ok(inner) => inner,
        Err(_) => Err(AppError::Database(format!(
            "查询超过 {} 秒未完成，已中断等待",
            QUERY_TIMEOUT.as_secs()
        ))),
    };
    state.clear_running(session_id).await;
    result
}

pub async fn cancel(state: &AppState, session_id: &str) -> AppResult<()> {
    let connected = state.connected(session_id).await?;
    match state.take_running_conn_id(session_id).await {
        Some(conn_id) => connected.adapter.cancel(conn_id).await,
        None => Err(AppError::Message("当前没有正在执行的查询".into())),
    }
}

#[cfg(test)]
mod productivity_tests {
    use super::*;
    use crate::meta::{Engine, value::DbValue};
    #[test]
    fn literal_types_and_injection() {
        assert_eq!(value_literal(Engine::Sqlite, &DbValue::Text("001".into())).unwrap(), "'001'");
        assert_eq!(value_literal(Engine::Postgres, &DbValue::Text("x'; DROP TABLE t;--".into())).unwrap(), "'x''; DROP TABLE t;--'");
        assert_eq!(value_literal(Engine::Postgres, &DbValue::Decimal("9007199254740993".into())).unwrap(), "9007199254740993");
        assert_eq!(value_literal(Engine::Postgres, &DbValue::Null).unwrap(), "NULL");
        assert_eq!(value_literal(Engine::Postgres, &DbValue::Bool(false)).unwrap(), "FALSE");
        assert!(value_literal(Engine::Mysql, &DbValue::Decimal("0 OR 1=1".into())).is_err());
        assert!(value_literal(Engine::Mysql, &DbValue::Decimal("NaN".into())).is_err());
        assert!(value_literal(Engine::Mysql, &DbValue::Truncated("cut".into())).is_err());
    }
}
