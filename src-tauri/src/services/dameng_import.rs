//! DM SQL imports use an immutable preflight snapshot and a dedicated connection.
use super::{
    dameng_script::{self, Item, Script, Statement},
    mysql_script,
    sql_import::{Entry, Plan, Preview, Report, Request},
};
use crate::{
    adapters::{QueryContext, QueryOutcome},
    error::{AppError, AppResult},
    meta::Engine,
    state::AppState,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    io::{BufRead, BufReader, Write},
    time::{Duration, Instant},
};

const PLAN_TTL: Duration = Duration::from_secs(1800);

#[derive(Serialize, Deserialize)]
struct SnapshotStatement {
    statement: Statement,
    stop_on_error: bool,
}

fn invalid(message: impl Into<String>) -> AppError {
    AppError::InvalidInput(message.into())
}

fn inspect(statement: &Statement, current: &mut String) -> AppResult<()> {
    dameng_script::inspect(statement, current)?;
    dameng_script::autocommit(&statement.sql)
        .map_err(|e| invalid(format!("第 {} 行：{e}", statement.line)))?;
    Ok(())
}

fn client_warning(line: u64, message: &str) -> String {
    // Keep PROMPT visible as a client directive rather than a server SQL result.
    let label = if message.starts_with("输出：") {
        "PROMPT "
    } else {
        ""
    };
    format!(
        "第 {line} 行：{label}{}",
        message.chars().take(400).collect::<String>()
    )
}

pub async fn preview(state: &AppState, request: Request) -> AppResult<Preview> {
    super::readonly::writable(state, &request.session_id).await?;
    let record = state.local.get_session(&request.session_id).await?;
    super::database_access::validate(
        Engine::Dameng,
        record.allowed_databases.as_deref(),
        Some(&request.database),
    )?;
    if state.connected(&request.session_id).await?.adapter.engine() != Engine::Dameng {
        return Err(invalid("此预检入口仅支持达梦会话"));
    }
    if request.database.trim().is_empty() {
        return Err(invalid("请选择目标模式"));
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
    let mut scopes = BTreeSet::from([format!("默认模式：{current}")]);
    let mut warnings = vec![
        "执行预检时固定的文件快照。DDL 可能隐式提交；停止或取消不会撤销此前已提交的修改。".into(),
        "客户端显示指令不会发送到服务器；文件包含、外部命令和连接切换不受支持。存储程序、动态 SQL 和触发器可能产生间接影响。".into(),
        "脚本结束后回滚未提交事务；执行成功不等于事务已提交，请在脚本中显式 COMMIT。".into(),
    ];
    let mut samples = vec![];
    let mut count = 0u64;
    let mut client_count = 0u64;
    let mut stop_on_error = !request.continue_on_error;
    let mut whenever = false;
    while let Some(item) = script.next()? {
        crate::tasks::checkpoint()?;
        match item {
            Item::Client {
                line,
                message,
                stop_on_error: stop,
            } => {
                client_count += 1;
                if stop {
                    stop_on_error = true;
                    whenever = true;
                }
                if client_count <= 200 {
                    warnings.push(client_warning(line, &message));
                }
            }
            Item::Sql(statement) => {
                let previous = current.clone();
                inspect(&statement, &mut current)?;
                if previous != current {
                    scopes.insert(format!("SET SCHEMA {current}"));
                }
                scopes.insert(format!("默认模式：{current}"));
                if scopes.len() > 1000 {
                    return Err(invalid("脚本作用模式超过 1000 项，请拆分文件"));
                }
                count += 1;
                if samples.len() < 200 {
                    samples.push(mysql_script::Statement {
                        line: statement.line,
                        sql: statement.sql.chars().take(400).collect(),
                    });
                }
                serde_json::to_writer(
                    &mut spool,
                    &SnapshotStatement {
                        statement,
                        stop_on_error,
                    },
                )?;
                spool.write_all(b"\n")?;
                if count % 100 == 0 {
                    crate::tasks::progress(count, None, "预检达梦 SQL 语句");
                    tokio::task::yield_now().await;
                }
            }
        }
    }
    if count == 0 {
        return Err(invalid("SQL 文件没有可执行语句"));
    }
    if whenever {
        warnings
            .push("WHENEVER SQLERROR EXIT 优先于“出错后继续”；该指令后的语句遇错即停止。".into());
    }
    if client_count > 200 {
        warnings.push(format!(
            "另有 {} 条客户端提示未在此展开。",
            client_count - 200
        ));
    }
    // The error policy is fixed per statement in the snapshot, not re-read from the file.
    spool.flush()?;
    spool.as_file().sync_all()?;
    let preview = Preview {
        id: uuid::Uuid::new_v4().to_string(),
        statements: count,
        bytes,
        scopes: scopes.into_iter().collect(),
        samples,
        warnings,
    };
    let mut plans = state.sql_imports.0.lock().await;
    plans.retain(|_, plan| plan.created.elapsed() < PLAN_TTL);
    if plans.len() >= 8 {
        if let Some(oldest) = plans
            .iter()
            .min_by_key(|(_, plan)| plan.created)
            .map(|(id, _)| id.clone())
        {
            plans.remove(&oldest);
        }
    }
    plans.insert(
        preview.id.clone(),
        Plan {
            engine: Engine::Dameng,
            request,
            spool,
            preview: preview.clone(),
            created: Instant::now(),
        },
    );
    Ok(preview)
}

async fn run_statement(
    conn: &mut dm_rust::Connection,
    statement: &Statement,
) -> AppResult<QueryOutcome> {
    let ctx = QueryContext::new();
    let first = dameng_script::first(&statement.sql)?;
    let read = matches!(first.as_str(), "SELECT" | "WITH");
    let work = tokio::time::timeout(
        Duration::from_secs(300),
        dameng_script::run(conn, statement, 1, &ctx),
    );
    tokio::pin!(work);
    loop {
        tokio::select! {
            result = &mut work => return result.map_err(|_| AppError::WriteUncertain("执行超过 300 秒，结果待核对；不会自动重试".into()))?,
            _ = tokio::time::sleep(Duration::from_millis(50)) => if crate::tasks::cancelled() {
                ctx.cancel();
                // A dropped request can leave an unread protocol response, so even a
                // cancelled SELECT must not reuse this connection for ROLLBACK.
                return Err(AppError::WriteUncertain(if read {
                    "已停止等待当前查询；连接已弃用，请核对服务器执行状态，后续语句不再执行".into()
                } else {
                    "已停止等待当前语句；服务器写入结果待核对，不会自动重试".into()
                }));
            }
        }
    }
}

pub async fn execute(
    state: &AppState,
    session_id: &str,
    id: &str,
    confirmed: bool,
    report_directory: &str,
) -> AppResult<Report> {
    if !confirmed {
        return Err(AppError::Dangerous("请先确认目标模式与脚本作用范围".into()));
    }
    let _lock = state.session_lock(session_id).await;
    super::readonly::writable(state, session_id).await?;
    let connected = state.connected(session_id).await?;
    if connected.adapter.engine() != Engine::Dameng {
        return Err(invalid("会话数据库类型已改变，请重新预检"));
    }
    let record = state.local.get_session(session_id).await?;
    let mut registry = state.sql_imports.0.lock().await;
    let plan = registry
        .get(id)
        .ok_or_else(|| invalid("预检已失效，请重新预检"))?;
    if plan.engine != Engine::Dameng
        || plan.request.session_id != session_id
        || plan.created.elapsed() > PLAN_TTL
    {
        return Err(invalid("预检会话不匹配、类型已改变或已过期，请重新预检"));
    }
    super::database_access::validate(
        Engine::Dameng,
        record.allowed_databases.as_deref(),
        Some(&plan.request.database),
    )?;
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
    let mut conn = connected
        .adapter
        .dameng_connection(&plan.request.database, true)
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
        serde_json::json!({"status":"running","engine":"dameng","statements":plan.preview.statements,"database":current,"warnings":plan.preview.warnings,"note":"执行成功不等于事务已提交；结束时回滚未提交事务"})
    )?;
    file.sync_data()?;
    for (index, line) in BufReader::new(plan.spool.reopen()?).lines().enumerate() {
        if crate::tasks::cancelled() {
            report.cancelled = true;
            break;
        }
        let snapshot: SnapshotStatement = serde_json::from_str(&line?)?;
        let statement = snapshot.statement;
        let mut target = current.clone();
        inspect(&statement, &mut target)?;
        let number = index as u64 + 1;
        let first = dameng_script::first(&statement.sql)?;
        let was_transaction = !conn.auto_commit();
        // A durable pending record is written before the first byte reaches the server.
        writeln!(
            file,
            "{}",
            serde_json::json!({"number":number,"line":statement.line,"database":target,"status":"pending"})
        )?;
        file.sync_data()?;
        let outcome = run_statement(&mut conn, &statement).await;
        let mut stop = false;
        let (status, affected, error) = match outcome {
            Ok(outcome) => {
                current = target.clone();
                report.executed += 1;
                ("success", outcome.affected.unwrap_or(0), None)
            }
            Err(error) => {
                let cancelled =
                    matches!(error, AppError::Cancelled(_)) || crate::tasks::cancelled();
                let program_call = matches!(first.as_str(), "CALL" | "DECLARE")
                    || first == "BEGIN" && dameng_script::autocommit(&statement.sql)?.is_none();
                let uncertain =
                    matches!(error, AppError::WriteUncertain(_) | AppError::Connection(_))
                        || program_call;
                report.cancelled |= cancelled;
                report.uncertain |= uncertain;
                if !cancelled || uncertain {
                    report.failed += 1;
                }
                let message = if uncertain {
                    format!("{error}；请核对服务器实际结果，后续语句未执行")
                } else {
                    error.to_string()
                };
                report.error = Some(format!("第 {} 行：{message}", statement.line));
                stop = uncertain
                    || cancelled
                    || was_transaction
                    || !conn.auto_commit()
                    || snapshot.stop_on_error;
                (
                    if uncertain {
                        "uncertain"
                    } else if cancelled {
                        "cancelled"
                    } else {
                        "failed"
                    },
                    0,
                    Some(message),
                )
            }
        };
        let entry = Entry {
            number,
            line: statement.line,
            database: target,
            status: status.into(),
            affected,
            error: error.clone(),
        };
        writeln!(file, "{}", serde_json::to_string(&entry)?)?;
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
        if stop {
            break;
        }
    }
    // An uncertain transport must be dropped, never reused for another command.
    if !report.uncertain {
        if !matches!(
            tokio::time::timeout(Duration::from_secs(30), conn.rollback()).await,
            Ok(Ok(()))
        ) {
            report.uncertain = true;
            report.error = Some("事务收尾失败，请核对服务器状态；此前已提交修改保留".into());
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
    fn snapshot_preserves_statement_error_policy() {
        let value = SnapshotStatement {
            statement: Statement {
                line: 17,
                sql: "INSERT INTO T VALUES(1)".into(),
            },
            stop_on_error: true,
        };
        let data = serde_json::to_vec(&value).unwrap();
        let value: SnapshotStatement = serde_json::from_slice(&data).unwrap();
        assert_eq!(value.statement.line, 17);
        assert!(value.stop_on_error);
        assert!(client_warning(7, "输出：DM8_IMPORT_OK_AGENT").contains("PROMPT"));
    }
    #[test]
    fn preflight_checks_schema_and_transaction_options() {
        let mut current = "OLD".into();
        inspect(
            &Statement {
                line: 8,
                sql: "SET SCHEMA \"AGENT\"".into(),
            },
            &mut current,
        )
        .unwrap();
        assert_eq!(current, "AGENT");
        assert!(inspect(
            &Statement {
                line: 9,
                sql: "SET AUTOCOMMIT invalid".into()
            },
            &mut current
        )
        .is_err());
    }
}
