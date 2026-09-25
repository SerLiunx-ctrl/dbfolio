use super::{explain, query, readonly};
use crate::{
    adapters::{QueryContext, QueryOutcome},
    error::{AppError, AppResult},
    meta::Engine,
    state::AppState,
};
use serde::Serialize;
use std::{collections::HashMap, sync::Arc, time::Instant};
use tokio::sync::Mutex;

#[async_trait::async_trait]
pub trait ManualTransaction: Send {
    async fn run(&mut self, sql: &str, rows: bool, ctx: &QueryContext) -> AppResult<QueryOutcome>;
    async fn finish(self: Box<Self>, commit: bool) -> AppResult<()>;
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionInfo {
    pub id: String,
    pub tab_id: String,
    pub session_id: String,
    pub database: String,
    pub statements: u32,
}
pub struct Entry {
    pub info: TransactionInfo,
    pub tx: Option<Box<dyn ManualTransaction>>,
}
#[derive(Default)]
pub struct Registry(pub Mutex<HashMap<String, Arc<Mutex<Entry>>>>);

pub fn validate(engine: Engine, sql: &str, force: bool) -> AppResult<(String, bool)> {
    let (text, words) = explain::scan_sql(engine, sql)
        .map_err(|e| AppError::InvalidInput(e.to_string().replace("执行计划", "手动事务")))?;
    let tokens: Vec<_> = words
        .split_whitespace()
        .map(str::to_ascii_uppercase)
        .collect();
    let first = tokens.first().map(String::as_str).unwrap_or("");
    let rows = matches!(first, "SELECT" | "WITH");
    if rows {
        readonly::sql(engine, &text)?;
    } else {
        if !matches!(first, "INSERT" | "UPDATE" | "DELETE")
            || tokens.iter().any(|w| {
                [
                    "CREATE",
                    "ALTER",
                    "DROP",
                    "TRUNCATE",
                    "RENAME",
                    "COMMIT",
                    "ROLLBACK",
                    "BEGIN",
                    "START",
                    "CALL",
                    "EXEC",
                    "COPY",
                    "LOAD",
                    "ATTACH",
                    "DETACH",
                    "PRAGMA",
                    "RETURNING",
                ]
                .contains(&w.as_str())
            })
        {
            return Err(AppError::InvalidInput("手动事务支持 SELECT / 只读 WITH / INSERT / UPDATE / DELETE；DDL、事务控制、RETURNING 和管理命令请在事务结束后执行".into()));
        }
        if !force {
            if let Some(reason)=super::sql_risk::danger_reason(engine,&text) {
                return Err(AppError::Dangerous(format!("{reason}；手动事务仍需提交才会生效")));
            }
        }
    }
    Ok((text, rows))
}

pub async fn begin(
    state: &AppState,
    session_id: &str,
    database: &str,
    tab_id: &str,
) -> AppResult<TransactionInfo> {
    let _session = state.session_lock(session_id).await;
    readonly::writable(state, session_id).await?;
    let connected = state.connected(session_id).await?;
    let entries: Vec<_> = state
        .transactions
        .0
        .lock()
        .await
        .values()
        .cloned()
        .collect();
    for entry in entries {
        if entry.lock().await.info.tab_id == tab_id {
            return Err(AppError::InvalidInput(
                "该页签已有事务，请先提交或回滚".into(),
            ));
        }
    }
    let tx = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        connected.adapter.begin_manual(database),
    )
    .await
    .map_err(|_| AppError::Database("开启事务超时，请检查连接池或其他未结束事务".into()))??;
    let info = TransactionInfo {
        id: uuid::Uuid::new_v4().to_string(),
        tab_id: tab_id.into(),
        session_id: session_id.into(),
        database: database.into(),
        statements: 0,
    };
    state.transactions.0.lock().await.insert(
        info.id.clone(),
        Arc::new(Mutex::new(Entry {
            info: info.clone(),
            tx: Some(tx),
        })),
    );
    Ok(info)
}
async fn entry(state: &AppState, id: &str) -> AppResult<Arc<Mutex<Entry>>> {
    state
        .transactions
        .0
        .lock()
        .await
        .get(id)
        .cloned()
        .ok_or_else(|| AppError::InvalidInput("事务已结束或连接已断开，请重新开启事务".into()))
}
pub async fn status(state: &AppState, id: &str) -> Option<TransactionInfo> {
    let entry = state.transactions.0.lock().await.get(id).cloned()?;
    let e = entry.lock().await;
    e.tx.as_ref().map(|_| e.info.clone())
}

#[cfg(test)]
pub async fn execute(
    state: &AppState,
    id: &str,
    session_id: &str,
    sql: &str,
    force: bool,
    offset: u64,
    sort: &[query::SortSpec],
) -> AppResult<QueryOutcome> {
    execute_paged(state, id, session_id, sql, force, offset, sort, 200).await
}

pub async fn execute_paged(
    state: &AppState,
    id: &str,
    session_id: &str,
    sql: &str,
    force: bool,
    offset: u64,
    sort: &[query::SortSpec],
    limit: u32,
) -> AppResult<QueryOutcome> {
    let _session = state.session_lock(session_id).await;
    readonly::writable(state, session_id).await?;
    let connected = state.connected(session_id).await?;
    let (text, rows) = validate(connected.adapter.engine(), sql, force)?;
    let entry = entry(state, id).await?;
    let mut e = entry.lock().await;
    if e.info.session_id != session_id {
        return Err(AppError::InvalidInput("事务不属于当前会话".into()));
    }
    let mut tx =
        e.tx.take()
            .ok_or_else(|| AppError::InvalidInput("事务已结束".into()))?;
    let sql = if rows {
        query::wrap_pagination(connected.adapter.as_ref(), &text, offset, limit.clamp(1, query::MAX_PAGE_SIZE), sort)
    } else {
        text.clone()
    };
    let ctx = QueryContext::new();
    let started = Instant::now();
    let result =
        crate::tasks::query(connected.adapter.as_ref(), &ctx, tx.run(&sql, rows, &ctx)).await;
    let result = if crate::tasks::cancelled() {
        Err(AppError::Cancelled("事务查询已取消".into()))
    } else {
        result
    };
    let duration = started.elapsed().as_millis() as i64;
    let _ = state
        .local
        .insert_history(
            session_id,
            Some(&e.info.database),
            &format!("-- 手动事务：语句执行记录，不代表已提交\n{text}"),
            result.is_ok(),
            result
                .as_ref()
                .ok()
                .and_then(|v| v.affected)
                .map(|v| v as i64),
            duration,
            result.as_ref().err().map(|v| v.code()),
        )
        .await;
    match result {
        Ok(value) => {
            e.info.statements += 1;
            e.tx = Some(tx);
            Ok(value)
        }
        Err(error) => {
            let rolled =
                tokio::time::timeout(std::time::Duration::from_secs(10), tx.finish(false)).await;
            let message = if matches!(rolled, Ok(Ok(()))) {
                format!("{error}；本次事务已回滚")
            } else {
                format!("{error}；回滚未能确认，事务连接已释放，请核对数据库状态")
            };
            drop(e);
            state.transactions.0.lock().await.remove(id);
            Err(AppError::Database(message))
        }
    }
}

/// Only simple single-target DML is accepted for MySQL, so its storage engine can be checked.
pub fn mysql_target(sql: &str, default_db: &str) -> AppResult<(String, String)> {
    fn invalid() -> AppError {
        AppError::InvalidInput("MySQL 手动事务仅支持明确目标表的单表 INSERT INTO / UPDATE / DELETE FROM；请去掉修饰词或多表写入".into())
    }
    fn whitespace(s: &mut &str) -> AppResult<()> {
        loop {
            *s = s.trim_start();
            if s.starts_with('#')
                || (s.starts_with("--")
                    && s.as_bytes()
                        .get(2)
                        .map(|b| b.is_ascii_whitespace())
                        .unwrap_or(true))
            {
                *s = s.find('\n').map(|i| &s[i + 1..]).unwrap_or("");
            } else if s.starts_with("/*") {
                let end = s.find("*/").ok_or_else(invalid)?;
                *s = &s[end + 2..];
            } else {
                return Ok(());
            }
        }
    }
    fn word<'a>(s: &mut &'a str) -> AppResult<String> {
        whitespace(s)?;
        if s.starts_with('`') {
            let mut out = String::new();
            let mut iter = s[1..].char_indices().peekable();
            while let Some((i, c)) = iter.next() {
                if c == '`' {
                    if iter.peek().map(|(_, c)| *c) == Some('`') {
                        iter.next();
                        out.push('`');
                    } else {
                        *s = &s[i + 2..];
                        return Ok(out);
                    }
                } else {
                    out.push(c);
                }
            }
            return Err(invalid());
        }
        let end = s
            .find(|c: char| !c.is_alphanumeric() && c != '_' && c != '$')
            .unwrap_or(s.len());
        if end == 0 {
            return Err(invalid());
        }
        let out = s[..end].to_string();
        *s = &s[end..];
        Ok(out)
    }
    let mut rest = sql;
    let op = word(&mut rest)?.to_ascii_uppercase();
    if op == "INSERT" {
        if word(&mut rest)?.to_ascii_uppercase() != "INTO" {
            return Err(invalid());
        }
    } else if op == "DELETE" {
        if word(&mut rest)?.to_ascii_uppercase() != "FROM" {
            return Err(invalid());
        }
    } else if op != "UPDATE" {
        return Err(invalid());
    }
    let first = word(&mut rest)?;
    whitespace(&mut rest)?;
    let (db, table) = if rest.starts_with('.') {
        rest = &rest[1..];
        (first, word(&mut rest)?)
    } else {
        (default_db.to_owned(), first)
    };
    whitespace(&mut rest)?;
    if op == "UPDATE" && word(&mut rest)?.to_ascii_uppercase() != "SET" {
        return Err(invalid());
    }
    if op == "DELETE" && !rest.is_empty() {
        let next = word(&mut rest)?.to_ascii_uppercase();
        if !["WHERE", "ORDER", "LIMIT"].contains(&next.as_str()) {
            return Err(invalid());
        }
    }
    if table.is_empty() || db.is_empty() {
        return Err(invalid());
    }
    Ok((db, table))
}
pub async fn finish(state: &AppState, id: &str, session_id: &str, commit: bool) -> AppResult<()> {
    let _session = state.session_lock(session_id).await;
    if commit {
        readonly::writable(state, session_id).await?;
    }
    let entry = match entry(state, id).await {
        Ok(e) => e,
        Err(_) if !commit => return Ok(()),
        Err(e) => return Err(e),
    };
    let mut e = entry.lock().await;
    if e.info.session_id != session_id {
        return Err(AppError::InvalidInput("事务不属于当前会话".into()));
    }
    let tx = e.tx.take();
    drop(e);
    state.transactions.0.lock().await.remove(id);
    if let Some(tx) = tx {
        match tokio::time::timeout(std::time::Duration::from_secs(15), tx.finish(commit)).await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(e)) => Err(AppError::Database(format!(
                "{}失败，结果可能不确定，请核对数据库：{e}",
                if commit { "提交" } else { "回滚" }
            ))),
            Err(_) => Err(AppError::Database(
                "事务结束请求超时，结果可能不确定，请核对数据库；不要直接重试写入".into(),
            )),
        }
    } else if commit {
        Err(AppError::InvalidInput("事务已因错误结束，无法提交".into()))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn statement_boundaries() {
        for engine in [Engine::Mysql, Engine::Postgres, Engine::Sqlite] {
            for sql in [
                "SELECT * FROM t",
                "INSERT INTO t VALUES (1)",
                "UPDATE t SET a=1 WHERE id=2",
                "DELETE FROM t WHERE id=1",
            ] {
                assert!(validate(engine, sql, false).is_ok(), "{sql}");
            }
            for sql in [
                "COMMIT",
                "SET autocommit=1",
                "CREATE TABLE t(a INT)",
                "SELECT 1; DELETE FROM t",
                "/*! COMMIT */ SELECT 1",
                "WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x",
                "CALL p()",
                "UPDATE t SET a='WHERE'",
            ] {
                assert!(validate(engine, sql, false).is_err(), "{sql}");
            }
        }
    }
    #[test]
    fn mysql_targets() {
        assert_eq!(
            mysql_target(
                "-- 历史记录\nUPDATE /*目标*/ `db` /*schema*/ . `t` SET x=1",
                "default"
            )
            .unwrap(),
            ("db".into(), "t".into())
        );
        assert_eq!(
            mysql_target("UPDATE `other`.`a``b` SET x=1 WHERE id=2", "db").unwrap(),
            ("other".into(), "a`b".into())
        );
        assert_eq!(
            mysql_target("INSERT INTO t(id) VALUES(1)", "db").unwrap(),
            ("db".into(), "t".into())
        );
        for sql in [
            "UPDATE a,b SET a.x=1",
            "UPDATE a JOIN b ON a.id=b.id SET a.x=1",
            "DELETE a FROM a JOIN b",
            "INSERT LOW_PRIORITY INTO t VALUES(1)",
        ] {
            assert!(mysql_target(sql, "db").is_err());
        }
    }
    #[tokio::test]
    async fn sqlite_transaction_lifecycle() {
        use serde_json::json;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data.sqlite");
        std::fs::File::create(&path).unwrap();
        let state = AppState::with_local(
            crate::store::LocalStore::initialize_in(dir.path().join("config"))
                .await
                .unwrap(),
        );
        let input:crate::store::SessionInput=serde_json::from_value(json!({"name":"事务测试","engine":"sqlite","filePath":path.to_str().unwrap(),"readOnly":false})).unwrap();
        let session = state.local.create_session(&input).await.unwrap();
        super::super::session::connect(&state, &session.id)
            .await
            .unwrap();
        let adapter = state.connected(&session.id).await.unwrap().adapter.clone();
        adapter
            .execute_affected("main", "CREATE TABLE t(id INTEGER PRIMARY KEY, value TEXT)")
            .await
            .unwrap();
        let tx = begin(&state, &session.id, "main", "q").await.unwrap();
        assert!(begin(&state, &session.id, "main", "q").await.is_err());
        execute(
            &state,
            &tx.id,
            &session.id,
            "INSERT INTO t VALUES (1,'pending')",
            false,
            0,
            &[],
        )
        .await
        .unwrap();
        execute(
            &state,
            &tx.id,
            &session.id,
            "UPDATE t SET value='updated' WHERE id=1",
            false,
            0,
            &[],
        )
        .await
        .unwrap();
        assert_eq!(
            execute(
                &state,
                &tx.id,
                &session.id,
                "SELECT * FROM t",
                false,
                0,
                &[]
            )
            .await
            .unwrap()
            .rows
            .len(),
            1
        );
        assert!(
            execute(&state, &tx.id, &session.id, "DROP TABLE t", false, 0, &[])
                .await
                .is_err()
        );
        assert!(
            status(&state, &tx.id).await.is_some(),
            "rejected SQL does not abort an otherwise valid transaction"
        );
        assert_eq!(
            adapter
                .query_page("main", "SELECT * FROM t", 0, 200, &QueryContext::new())
                .await
                .unwrap()
                .rows
                .len(),
            0,
            "uncommitted data must be isolated"
        );
        finish(&state, &tx.id, &session.id, true).await.unwrap();
        assert_eq!(
            adapter
                .query_page("main", "SELECT * FROM t", 0, 200, &QueryContext::new())
                .await
                .unwrap()
                .rows
                .len(),
            1
        );
        let tx = begin(&state, &session.id, "main", "q").await.unwrap();
        execute(
            &state,
            &tx.id,
            &session.id,
            "DELETE FROM t WHERE id=1",
            false,
            0,
            &[],
        )
        .await
        .unwrap();
        finish(&state, &tx.id, &session.id, false).await.unwrap();
        assert_eq!(
            adapter
                .query_page("main", "SELECT * FROM t", 0, 200, &QueryContext::new())
                .await
                .unwrap()
                .rows
                .len(),
            1
        );
        let tx = begin(&state, &session.id, "main", "q").await.unwrap();
        execute(
            &state,
            &tx.id,
            &session.id,
            "INSERT INTO t VALUES (2,'rollback')",
            false,
            0,
            &[],
        )
        .await
        .unwrap();
        assert!(execute(
            &state,
            &tx.id,
            &session.id,
            "INSERT INTO t VALUES (1,'duplicate')",
            false,
            0,
            &[]
        )
        .await
        .is_err());
        assert!(status(&state, &tx.id).await.is_none());
        assert_eq!(
            adapter
                .query_page("main", "SELECT * FROM t", 0, 200, &QueryContext::new())
                .await
                .unwrap()
                .rows
                .len(),
            1,
            "statement error rolls back prior writes"
        );
        let tx = begin(&state, &session.id, "main", "q").await.unwrap();
        execute(
            &state,
            &tx.id,
            &session.id,
            "INSERT INTO t VALUES (3,'disconnect')",
            false,
            0,
            &[],
        )
        .await
        .unwrap();
        state.disconnect(&session.id).await;
        assert!(status(&state, &tx.id).await.is_none());
        assert_eq!(
            adapter
                .query_page("main", "SELECT * FROM t", 0, 200, &QueryContext::new())
                .await
                .unwrap()
                .rows
                .len(),
            1
        );
    }
}
