use serde::Deserialize;
use std::collections::HashMap;

use crate::adapters::{build_change_statements, render_change_statements, RowChange};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GridRequest {
    pub session_id: String,
    pub database: String,
    pub schema: Option<String>,
    pub table: String,
    pub changes: Vec<RowChange>,
}

async fn column_types(
    state: &AppState,
    req: &GridRequest,
) -> AppResult<HashMap<String, String>> {
    let connected = state.connected(&req.session_id).await?;
    let meta = connected
        .adapter
        .introspect_table(&req.database, req.schema.as_deref(), &req.table)
        .await?;
    Ok(meta
        .columns
        .iter()
        .map(|column| (column.name.clone(), column.raw_type.clone()))
        .collect())
}

pub async fn preview(state: &AppState, req: &GridRequest) -> AppResult<Vec<String>> {
    let connected = state.connected(&req.session_id).await?;
    let types = column_types(state, req).await?;
    render_change_statements(
        connected.adapter.as_ref(),
        &req.database,
        req.schema.as_deref(),
        &req.table,
        &req.changes,
        &types,
    )
}

pub async fn commit(state: &AppState, req: &GridRequest) -> AppResult<u64> {
    let record = state.local.get_session(&req.session_id).await?;
    if record.read_only {
        return Err(AppError::ReadOnly(
            "当前会话为只读模式，已阻止提交修改".into(),
        ));
    }
    if req.changes.is_empty() {
        return Ok(0);
    }

    let connected = state.connected(&req.session_id).await?;
    let types = column_types(state, req).await?;
    let items = build_change_statements(
        connected.adapter.as_ref(),
        &req.database,
        req.schema.as_deref(),
        &req.table,
        &req.changes,
        &types,
    )?;
    if items.is_empty() {
        return Ok(0);
    }

    let affected = connected
        .adapter
        .execute_grid_transaction(&req.database, &items)
        .await?;
    tracing::info!(
        table = %req.table,
        statements = items.len(),
        affected,
        "网格变更已提交"
    );
    Ok(affected)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn sqlite_numeric_cell_edits_preserve_storage_types_and_large_integer() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("numeric.sqlite");
        std::fs::File::create(&path).unwrap();
        let state = AppState::with_local(
            crate::store::LocalStore::initialize_in(dir.path().join("config")).await.unwrap(),
        );
        let input = serde_json::from_value(json!({
            "name": "数值编辑回归", "engine": "sqlite", "filePath": path.to_str().unwrap(), "readOnly": false
        })).unwrap();
        let session = state.local.create_session(&input).await.unwrap();
        crate::services::session::connect(&state, &session.id).await.unwrap();
        let adapter = state.connected(&session.id).await.unwrap().adapter.clone();
        adapter.execute_affected("main", "CREATE TABLE numbers(id INTEGER PRIMARY KEY, count INTEGER, ratio REAL, large INTEGER, code TEXT)").await.unwrap();
        adapter.execute_affected("main", "INSERT INTO numbers VALUES (1, NULL, 1.5, 2, 'old')").await.unwrap();
        // 与前端 getChanges 相同的 IPC 载荷；大整数通过十进制文本承载，但标签仍为 int。
        let request: GridRequest = serde_json::from_value(json!({
            "sessionId": session.id, "database": "main", "table": "numbers",
            "changes": [{"kind": "update", "keys": [{"column": "id", "value": ["int", 1]}], "changes": [
                {"column": "count", "oldValue": ["null", null], "newValue": ["int", 42]},
                {"column": "ratio", "oldValue": ["float", 1.5], "newValue": ["float", 125.0]},
                {"column": "large", "oldValue": ["int", 2], "newValue": ["int", "9007199254740993"]},
                {"column": "code", "oldValue": ["text", "old"], "newValue": ["text", "0012"]}
            ]}]
        })).unwrap();
        assert_eq!(commit(&state, &request).await.unwrap(), 1);
        let result = adapter.query_page("main", "SELECT count, ratio, large, code, typeof(count), typeof(ratio), typeof(large), typeof(code) FROM numbers", 0, 10, &Default::default()).await.unwrap();
        use crate::meta::value::DbValue;
        assert_eq!(result.rows, vec![vec![
            DbValue::Int(42), DbValue::Float(125.0), DbValue::Int(9_007_199_254_740_993), DbValue::Text("0012".into()),
            DbValue::Text("integer".into()), DbValue::Text("real".into()), DbValue::Text("integer".into()), DbValue::Text("text".into()),
        ]]);
    }

    #[tokio::test]
    async fn sqlite_large_primary_key_delete_is_exact_and_stale_delete_rolls_back() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rows.sqlite");
        std::fs::File::create(&path).unwrap();
        let state = AppState::with_local(
            crate::store::LocalStore::initialize_in(dir.path().join("config"))
                .await
                .unwrap(),
        );
        let input = serde_json::from_value(json!({
            "name": "SQLite 删除测试", "engine": "sqlite", "filePath": path.to_str().unwrap(), "readOnly": false
        })).unwrap();
        let session = state.local.create_session(&input).await.unwrap();
        crate::services::session::connect(&state, &session.id).await.unwrap();
        let adapter = state.connected(&session.id).await.unwrap().adapter.clone();
        adapter.execute_affected("main", "CREATE TABLE rows(id INTEGER PRIMARY KEY, title TEXT)").await.unwrap();
        adapter.execute_affected("main", "INSERT INTO rows VALUES (9007199254740993, 'first'), (9007199254740995, 'second')").await.unwrap();

        let result = adapter.query_page("main", "SELECT id, title FROM rows ORDER BY id", 0, 10, &Default::default()).await.unwrap();
        let wire = serde_json::to_string(&result.rows).unwrap();
        assert!(wire.contains("[\"int\",\"9007199254740993\"]"));
        let rows: Vec<Vec<crate::meta::value::DbValue>> = serde_json::from_str(&wire).unwrap();
        let request = GridRequest {
            session_id: session.id.clone(), database: "main".into(), schema: None, table: "rows".into(),
            changes: vec![RowChange::Delete { keys: vec![crate::adapters::CellValue {
                column: "id".into(), value: rows[0][0].clone(),
            }] }],
        };
        assert_eq!(commit(&state, &request).await.unwrap(), 1);
        let remaining = adapter.query_page("main", "SELECT id FROM rows", 0, 10, &Default::default()).await.unwrap();
        assert_eq!(remaining.rows, vec![vec![rows[1][0].clone()]]);

        let stale = GridRequest {
            changes: vec![RowChange::Delete { keys: vec![crate::adapters::CellValue {
                column: "id".into(), value: rows[0][0].clone(),
            }] }, RowChange::Delete { keys: vec![crate::adapters::CellValue {
                column: "id".into(), value: rows[1][0].clone(),
            }] }],
            ..request
        };
        assert!(commit(&state, &stale).await.is_err());
        let still_there = adapter.query_page("main", "SELECT id FROM rows", 0, 10, &Default::default()).await.unwrap();
        assert_eq!(still_there.rows, remaining.rows);
    }
}
