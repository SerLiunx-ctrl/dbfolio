use super::mysql_script::{self, Script, Statement};
use crate::{
    error::{AppError, AppResult},
    state::AppState,
};
use serde::{Deserialize, Serialize};
use sqlx::{Connection, Executor};
use std::{
    collections::{BTreeSet, HashMap},
    io::{BufRead, BufReader, Write},
    time::{Duration, Instant},
};
use tokio::sync::Mutex;
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub session_id: String,
    pub database: String,
    pub path: String,
    pub encoding: String,
    #[serde(default)]
    pub continue_on_error: bool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub id: String,
    pub statements: u64,
    pub bytes: u64,
    pub scopes: Vec<String>,
    pub samples: Vec<Statement>,
    pub warnings: Vec<String>,
}
struct Plan {
    request: Request,
    spool: tempfile::NamedTempFile,
    preview: Preview,
    created: Instant,
}
#[derive(Default)]
pub struct Registry(Mutex<HashMap<String, Plan>>);
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub executed: u64,
    pub failed: u64,
    pub cancelled: bool,
    pub uncertain: bool,
    pub error: Option<String>,
    pub report_path: String,
    pub entries: Vec<Entry>,
}
#[derive(Clone, Serialize)]
pub struct Entry {
    pub number: u64,
    pub line: u64,
    pub database: String,
    pub status: String,
    pub affected: u64,
    pub error: Option<String>,
}
fn invalid(s: impl Into<String>) -> AppError {
    AppError::InvalidInput(s.into())
}
fn inspect(
    sql: &str,
    current: &mut String,
    allowed: Option<&[String]>,
    scopes: &mut BTreeSet<String>,
) -> AppResult<()> {
    let w = mysql_script::words(sql);
    let first = w
        .first()
        .map(|s| s.to_ascii_uppercase())
        .unwrap_or_default();
    if first == "USE" {
        if w.len() != 2 {
            return Err(invalid("USE 必须包含一个明确的数据库名称"));
        }
        super::database_access::check(allowed, &w[1])?;
        *current = w[1].clone();
        scopes.insert(format!("USE {}", current));
        return Ok(());
    }
    if ![
        "SELECT",
        "WITH",
        "INSERT",
        "UPDATE",
        "DELETE",
        "REPLACE",
        "CREATE",
        "ALTER",
        "DROP",
        "TRUNCATE",
        "SET",
        "START",
        "BEGIN",
        "COMMIT",
        "ROLLBACK",
        "SAVEPOINT",
        "RELEASE",
        "LOCK",
        "UNLOCK",
        "CALL",
        "DO",
        "ANALYZE",
        "OPTIMIZE",
        "CHECK",
    ]
    .contains(&first.as_str())
    {
        return Err(invalid(format!(
            "不支持 SQL/客户端指令 {first}；SOURCE、shell、连接切换等客户端指令不会执行"
        )));
    }
    if first == "SET"
        && sql.to_ascii_uppercase().contains("SQL_MODE")
        && (sql.to_ascii_uppercase().contains("NO_BACKSLASH_ESCAPES")
            || sql.to_ascii_uppercase().contains("ANSI_QUOTES"))
    {
        return Err(invalid(
            "导入暂不支持在脚本中启用 NO_BACKSLASH_ESCAPES / ANSI_QUOTES，请用标准转义模式导出",
        ));
    }
    super::database_access::sql(allowed, current, sql)?;
    scopes.insert(format!("默认库：{current}"));
    if first == "SET"
        && w.iter().any(|s| {
            ["GLOBAL", "PERSIST", "PERSIST_ONLY", "GTID_PURGED"]
                .contains(&s.to_ascii_uppercase().as_str())
        })
    {
        scopes.insert("服务器级设置：请核对 GLOBAL / PERSIST / GTID 影响".into());
    }
    if ["CREATE", "ALTER", "DROP"].contains(&first.as_str())
        && w.get(1)
            .is_some_and(|s| s.eq_ignore_ascii_case("DATABASE") || s.eq_ignore_ascii_case("SCHEMA"))
    {
        scopes.insert(w.iter().take(6).cloned().collect::<Vec<_>>().join(" "));
    }
    for pair in w.windows(2) {
        if pair[1] == "." {
            scopes.insert(format!("限定名称/别名：{}", pair[0]));
        }
    }
    if scopes.len() > 1000 {
        return Err(invalid("脚本作用范围超过 1000 项，请拆分文件"));
    }
    Ok(())
}
pub async fn preview(state: &AppState, request: Request) -> AppResult<Preview> {
    super::readonly::writable(state, &request.session_id).await?;
    let record = state.local.get_session(&request.session_id).await?;
    super::database_access::check(record.allowed_databases.as_deref(), &request.database)?;
    let connected = state.connected(&request.session_id).await?;
    let mut conn = connected
        .adapter
        .mysql_connection(&request.database, false)
        .await?;
    let mode: String = sqlx::query_scalar("SELECT @@SQL_MODE")
        .fetch_one(&mut conn)
        .await?;
    conn.close().await?;
    if mysql_script::nonstandard_quotes(&mode) {
        return Err(invalid(
            "目标会话使用 NO_BACKSLASH_ESCAPES / ANSI_QUOTES，暂不支持该脚本解析模式",
        ));
    }
    let path = std::path::Path::new(&request.path);
    if !path.is_absolute() || !path.is_file() {
        return Err(invalid("请选择本机 SQL 文件"));
    }
    let bytes = std::fs::metadata(path)?.len();
    let decoded = mysql_script::decode(path, &request.encoding)?;
    let mut script = Script::new(BufReader::new(decoded.reopen()?));
    let mut spool = tempfile::NamedTempFile::new()?;
    let mut current = request.database.clone();
    let mut scopes = BTreeSet::new();
    let mut samples = vec![];
    let mut count = 0;
    while let Some(statement) = script.next()? {
        crate::tasks::checkpoint()?;
        inspect(
            &statement.sql,
            &mut current,
            record.allowed_databases.as_deref(),
            &mut scopes,
        )
        .map_err(|e| invalid(format!("第 {} 行：{e}", statement.line)))?;
        count += 1;
        if samples.len() < 200 {
            samples.push(Statement {
                line: statement.line,
                sql: statement.sql.chars().take(400).collect(),
            });
        }
        serde_json::to_writer(&mut spool, &statement).map_err(|e| invalid(e.to_string()))?;
        spool.write_all(b"\n")?;
        if count % 100 == 0 {
            crate::tasks::progress(count, None, "预检 SQL 语句");
            tokio::task::yield_now().await;
        }
    }
    if count == 0 {
        return Err(invalid("SQL 文件没有可执行语句"));
    }
    spool.flush()?;
    let preview=Preview{id:uuid::Uuid::new_v4().to_string(),statements:count,bytes,scopes:scopes.into_iter().collect(),samples,warnings:vec!["执行预检时固定的文件快照。DDL 通常隐式提交；停止或取消不会撤销此前已提交的修改。".into(),"显示的作用范围为静态提示；存储程序、动态 SQL、触发器可产生间接影响。限制数据库的会话拒绝无法可靠判定范围的语句。".into()]};
    let mut plans = state.sql_imports.0.lock().await;
    plans.retain(|_, p| p.created.elapsed() < Duration::from_secs(1800));
    if plans.len() >= 8 {
        let oldest = plans
            .iter()
            .min_by_key(|(_, p)| p.created)
            .map(|(k, _)| k.clone())
            .unwrap();
        plans.remove(&oldest);
    }
    plans.insert(
        preview.id.clone(),
        Plan {
            request,
            spool,
            preview: preview.clone(),
            created: Instant::now(),
        },
    );
    Ok(preview)
}
pub async fn execute(
    state: &AppState,
    session_id: &str,
    id: &str,
    confirmed: bool,
    report_directory: &str,
) -> AppResult<Report> {
    if !confirmed {
        return Err(AppError::Dangerous("请先确认目标与脚本作用范围".into()));
    }
    let _lock = state.session_lock(session_id).await;
    super::readonly::writable(state, session_id).await?;
    let mut registry = state.sql_imports.0.lock().await;
    let plan = registry
        .get(id)
        .ok_or_else(|| invalid("预检已失效，请重新预检"))?;
    if plan.request.session_id != session_id || plan.created.elapsed() > Duration::from_secs(1800) {
        return Err(invalid("预检会话不匹配或已过期"));
    }
    let directory = std::path::Path::new(report_directory);
    if !directory.is_absolute() || !directory.is_dir() {
        return Err(invalid("请选择报告目录"));
    }
    let report_path = directory.join(format!("dbfolio-import-{}.jsonl", uuid::Uuid::new_v4()));
    let mut file = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&report_path)?;
    let plan = registry.remove(id).unwrap();
    drop(registry);
    let record = state.local.get_session(session_id).await?;
    let connected = state.connected(session_id).await?;
    let mut conn = connected
        .adapter
        .mysql_connection(&plan.request.database, true)
        .await?;
    let mut current = plan.request.database.clone();
    let mut report = Report {
        executed: 0,
        failed: 0,
        cancelled: false,
        uncertain: false,
        error: None,
        report_path: report_path.to_string_lossy().into_owned(),
        entries: vec![],
    };
    writeln!(
        file,
        "{}",
        serde_json::json!({"status":"running","statements":plan.preview.statements,"database":current,"note":"语句执行成功不等于事务已提交；最终关闭连接会回滚未提交事务"})
    )?;
    file.sync_data()?;
    let mut explicit_transaction = false;
    for (i, line) in BufReader::new(plan.spool.reopen()?).lines().enumerate() {
        if crate::tasks::cancelled() {
            report.cancelled = true;
            break;
        }
        let statement: Statement =
            serde_json::from_str(&line?).map_err(|e| invalid(e.to_string()))?;
        inspect(
            &statement.sql,
            &mut current,
            record.allowed_databases.as_deref(),
            &mut BTreeSet::new(),
        )?;
        let number = i as u64 + 1;
        let first = mysql_script::words(&statement.sql)
            .first()
            .map(|s| s.to_ascii_uppercase())
            .unwrap_or_default();
        if first == "BEGIN" || first == "START" {
            explicit_transaction = true;
        }
        // Persist the pending entry before sending SQL; a crashed process leaves an explicit uncertain boundary.
        writeln!(
            file,
            "{}",
            serde_json::json!({"number":number,"line":statement.line,"database":current,"status":"pending"})
        )?;
        file.sync_data()?;
        let outcome = tokio::time::timeout(
            Duration::from_secs(300),
            conn.execute(sqlx::raw_sql(&statement.sql)),
        )
        .await;
        let (status, affected, error, uncertain) = match outcome {
            Ok(Ok(result)) => {
                report.executed += 1;
                ("success", result.rows_affected(), None, false)
            }
            Ok(Err(sqlx::Error::Database(error))) => {
                let uncertain = first == "CALL"
                    || error.code().is_some_and(|c| c.starts_with("08"))
                    || error
                        .try_downcast_ref::<sqlx::mysql::MySqlDatabaseError>()
                        .is_some_and(|e| {
                            [1053, 1317, 1927, 2006, 2013, 2055].contains(&e.number())
                        });
                report.failed += 1;
                (
                    if uncertain { "uncertain" } else { "failed" },
                    0,
                    Some(if uncertain {
                        format!("{error}；可能已发生部分写入，请核对服务器结果")
                    } else {
                        error.to_string()
                    }),
                    uncertain,
                )
            }
            Ok(Err(error)) => (
                "uncertain",
                0,
                Some(format!("连接中断，结果待核对：{error}")),
                true,
            ),
            Err(_) => (
                "uncertain",
                0,
                Some("执行超过 300 秒，结果待核对；不会自动重试".into()),
                true,
            ),
        };
        let entry = Entry {
            number,
            line: statement.line,
            database: current.clone(),
            status: status.into(),
            affected,
            error: error.clone(),
        };
        writeln!(file, "{}", serde_json::to_string(&entry).unwrap())?;
        file.sync_data()?;
        if report.entries.len() < 200 || error.is_some() && report.entries.len() < 500 {
            report.entries.push(entry);
        }
        crate::tasks::progress(
            number,
            Some(plan.preview.statements),
            format!(
                "第 {number} 条 · 成功 {} · 失败 {}",
                report.executed, report.failed
            ),
        );
        if let Some(error) = error {
            report.error = Some(format!("第 {} 行：{error}", statement.line));
            report.uncertain = uncertain;
            if uncertain || explicit_transaction || !plan.request.continue_on_error {
                break;
            }
        }
        if first == "COMMIT" || first == "ROLLBACK" {
            explicit_transaction = false;
        }
        // A changed lexical mode must not make later pre-parsed statements ambiguous.
        let mode = tokio::time::timeout(
            Duration::from_secs(30),
            sqlx::query_as::<_, (String, i32)>("SELECT @@SQL_MODE,@@autocommit")
                .fetch_one(&mut conn),
        )
        .await;
        match mode {
            Ok(Ok((mode, autocommit))) => {
                if autocommit == 0 {
                    explicit_transaction = true;
                }
                if mysql_script::nonstandard_quotes(&mode) {
                    report.error = Some("SQL_MODE 已变化，已停止，剩余语句未执行".into());
                    break;
                }
            }
            _ => {
                report.uncertain = true;
                report.error =
                    Some("无法确认连接/事务状态，已停止，请核对服务器；剩余语句未执行".into());
                break;
            }
        }
    }
    // Roll back a script's unfinished transaction. DDL/autocommit work remains committed.
    if !report.uncertain {
        if !matches!(
            tokio::time::timeout(Duration::from_secs(30), conn.execute("ROLLBACK")).await,
            Ok(Ok(_))
        ) {
            report.uncertain = true;
            report.error = Some("事务收尾失败，请核对服务器状态".into());
        }
    }
    drop(conn);
    writeln!(
        file,
        "{}",
        serde_json::json!({"status":"finished","executed":report.executed,"failed":report.failed,"uncertain":report.uncertain,"cancelled":report.cancelled,"error":report.error})
    )?;
    file.sync_all()?;
    Ok(report)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scope_and_client_commands() {
        let mut db: String = "allowed".into();
        let allowed = vec![db.clone()];
        let mut scopes = BTreeSet::new();
        assert!(inspect("USE denied", &mut db, Some(&allowed), &mut scopes).is_err());
        assert!(inspect(
            "/*!50000 USE denied */",
            &mut db,
            Some(&allowed),
            &mut scopes
        )
        .is_err());
        for sql in ["SOURCE x.sql", "\\! rm", "connect x"] {
            assert!(inspect(sql, &mut db, None, &mut scopes).is_err());
        }
        assert!(inspect("USE `allowed`", &mut db, Some(&allowed), &mut scopes).is_ok());
    }
}
