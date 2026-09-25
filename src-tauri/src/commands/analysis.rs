use crate::{
    adapters::{QueryContext, QueryOutcome},
    error::{AppError, AppResult},
    state::AppState,
};
use serde::Serialize;
use std::{io::Write, path::Path, time::Duration};
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisResult {
    result: QueryOutcome,
    limited: bool,
    limit: u32,
}

#[tauri::command]
pub async fn analysis_query(
    state: State<'_, AppState>,
    task_id: Option<String>,
    session_id: String,
    database: String,
    sql: String,
) -> AppResult<AnalysisResult> {
    state
        .tasks
        .scope(task_id, async {
            let connected = state.connected(&session_id).await?;
            run_query(connected.adapter.as_ref(), &database, &sql).await
        })
        .await
}

async fn run_query(
    adapter: &dyn crate::adapters::DbAdapter,
    database: &str,
    sql: &str,
) -> AppResult<AnalysisResult> {
    if sql.len() > 200_000 {
        return Err(AppError::InvalidInput("分析 SQL 超过 200 KB".into()));
    }
    let sql = crate::services::explain::analysis_sql(adapter.engine(), &sql)?;
    let wrapped = format!("SELECT * FROM (\n{sql}\n) AS _dw_analysis LIMIT 5001");
    let ctx = QueryContext::new();
    let mut result = tokio::time::timeout(
        Duration::from_secs(60),
        crate::tasks::query(
            adapter,
            &ctx,
            adapter.query_page(&database, &wrapped, 0, 5001, &ctx),
        ),
    )
    .await
    .map_err(|_| AppError::Message("分析查询超过 60 秒，请缩小范围或先在数据库聚合".into()))??;
    let limited = result.rows.len() > 5000;
    result.rows.truncate(5000);
    crate::tasks::checkpoint()?;
    // Preserve integer text before crossing the JavaScript number boundary.
    for cell in result.rows.iter_mut().flatten() {
        use crate::meta::value::DbValue;
        match cell {
            DbValue::Int(value) if value.unsigned_abs() > 9_007_199_254_740_991 => {
                *cell = DbValue::Decimal(value.to_string())
            }
            DbValue::UInt(value) if *value > 9_007_199_254_740_991 => {
                *cell = DbValue::Decimal(value.to_string())
            }
            _ => {}
        }
    }
    if serde_json::to_vec(&result)
        .map_err(|e| AppError::Internal(e.to_string()))?
        .len()
        > 8 * 1024 * 1024
    {
        return Err(AppError::InvalidInput(
            "分析结果超过 8 MiB，请减少字段或在数据库中聚合".into(),
        ));
    }
    Ok(AnalysisResult {
        result,
        limited,
        limit: 5000,
    })
}

fn write_export(path: &Path, bytes: &[u8]) -> AppResult<()> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !path.is_absolute() || !matches!(ext.as_str(), "png" | "csv" | "json") {
        return Err(AppError::InvalidInput(
            "请选择 .png / .csv / .json 绝对路径".into(),
        ));
    }
    if bytes.len() > 16 * 1024 * 1024 {
        return Err(AppError::InvalidInput("分析导出不能超过 16 MiB".into()));
    }
    if ext == "png" && !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err(AppError::InvalidInput("PNG 数据无效".into()));
    }
    if ext != "png" {
        let text = std::str::from_utf8(bytes)
            .map_err(|_| AppError::InvalidInput("导出内容不是 UTF-8".into()))?;
        if ext == "json" {
            serde_json::from_str::<serde_json::Value>(text)
                .map_err(|_| AppError::InvalidInput("JSON 无效".into()))?;
        }
    }
    let parent = path
        .parent()
        .ok_or_else(|| AppError::InvalidInput("路径无效".into()))?;
    let mut temp =
        tempfile::NamedTempFile::new_in(parent).map_err(|e| AppError::Message(e.to_string()))?;
    temp.write_all(bytes)
        .and_then(|_| temp.as_file().sync_all())
        .map_err(|e| AppError::Message(e.to_string()))?;
    temp.persist(path)
        .map_err(|e| AppError::Message(e.to_string()))?;
    Ok(())
}
#[tauri::command]
pub async fn analysis_export(path: String, bytes: Vec<u8>) -> AppResult<()> {
    tauri::async_runtime::spawn_blocking(move || write_export(Path::new(&path), &bytes))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{meta::Engine, services::explain::analysis_sql};
    #[test]
    fn reject_writes_and_multiple_statements() {
        for engine in [Engine::Mysql, Engine::Postgres, Engine::Sqlite] {
            assert!(analysis_sql(engine, "WITH x AS (SELECT 1 AS n) SELECT * FROM x;").is_ok());
            assert!(analysis_sql(engine, "SELECT 'delete; insert'").is_ok());
            for sql in [
                "DELETE FROM x",
                "SELECT 1; DROP TABLE x",
                "WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x",
                "SELECT * INTO copy FROM t",
                "SELECT * FROM t FOR UPDATE",
                "SELECT 1 /*! INTO OUTFILE 'x' */",
            ] {
                assert!(analysis_sql(engine, sql).is_err(), "{sql}");
            }
        }
    }

    #[tokio::test]
    async fn sqlite_bounded_analysis_and_aggregate() {
        use crate::adapters::{sqlite::SqliteAdapter, ConnectionParams};
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("analysis.sqlite");
        std::fs::File::create(&path).unwrap();
        let params: ConnectionParams = serde_json::from_value(
            serde_json::json!({"engine":"sqlite","filePath":path.to_str().unwrap()}),
        )
        .unwrap();
        let adapter = SqliteAdapter::connect(&params).await.unwrap();
        let sequence="WITH RECURSIVE n(v) AS (SELECT 1 UNION ALL SELECT v+1 FROM n WHERE v<5002) SELECT v FROM n";
        let result = run_query(&adapter, "main", sequence).await.unwrap();
        assert!(result.limited);
        assert_eq!(result.result.rows.len(), 5000);
        let exact = run_query(&adapter, "main", &sequence.replace("5002", "5000"))
            .await
            .unwrap();
        assert!(!exact.limited);
        assert_eq!(exact.result.rows.len(), 5000);
        let big = run_query(
            &adapter,
            "main",
            "SELECT 9223372036854775807 AS update_time",
        )
        .await
        .unwrap();
        assert_eq!(
            serde_json::to_value(&big.result.rows).unwrap(),
            serde_json::json!([[["decimal", "9223372036854775807"]]])
        );
        let empty = run_query(
            &adapter,
            "main",
            "SELECT 1 AS value WHERE 0 -- trailing comment",
        )
        .await
        .unwrap();
        assert!(!empty.limited);
        assert!(empty.result.rows.is_empty());
        let aggregate = run_query(
            &adapter,
            "main",
            "SELECT SUM(v) AS total FROM (SELECT 3 AS v UNION ALL SELECT 5)",
        )
        .await
        .unwrap();
        assert_eq!(
            serde_json::to_value(&aggregate.result.rows).unwrap(),
            serde_json::json!([[["int", 8]]])
        );
        assert!(run_query(&adapter, "main", "CREATE TABLE bad(x)")
            .await
            .is_err());
    }

    #[test]
    fn atomic_export_validation() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("分析.json");
        write_export(&path, b"{\"rows\":[]}").unwrap();
        assert!(write_export(&path, b"invalid").is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"{\"rows\":[]}");
        assert!(write_export(&dir.path().join("bad.exe"), b"x").is_err());
        assert!(write_export(&dir.path().join("bad.png"), b"x").is_err());
    }
}
