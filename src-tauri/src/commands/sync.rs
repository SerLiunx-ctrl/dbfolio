use tauri::State;

use crate::error::AppResult;
use crate::services::sync::{
    self, DataExecuteResult, DataSyncRequest, Endpoint, SchemaCompareResult, SchemaExecuteResult,
    SchemaPlan, SchemaSyncRequest, TableDataDiff,
};
use crate::state::AppState;

#[tauri::command]
pub async fn sync_compare_schema(
    state: State<'_, AppState>,
    task_id: Option<String>,
    source: Endpoint,
    target: Endpoint,
    tables: Vec<String>,
) -> AppResult<SchemaCompareResult> {
    state
        .tasks
        .scope(task_id, async {
            sync::compare_schema(&state, &source, &target, &tables).await
        })
        .await
}

#[tauri::command]
pub async fn sync_preview_schema(
    state: State<'_, AppState>,
    task_id: Option<String>,
    request: SchemaSyncRequest,
) -> AppResult<SchemaPlan> {
    state
        .tasks
        .scope(task_id, async {
            sync::preview_schema(&state, &request).await
        })
        .await
}

#[tauri::command]
pub async fn sync_execute_schema(
    state: State<'_, AppState>,
    task_id: Option<String>,
    plan_id: String,
    selected: Vec<usize>,
) -> AppResult<SchemaExecuteResult> {
    state
        .tasks
        .scope(task_id, async {
            sync::execute_schema(&state, &plan_id, &selected).await
        })
        .await
}

#[tauri::command]
pub async fn sync_compare_data(
    state: State<'_, AppState>,
    task_id: Option<String>,
    request: DataSyncRequest,
) -> AppResult<Vec<TableDataDiff>> {
    state
        .tasks
        .scope(task_id, async {
            sync::compare_data(&state, &request).await
        })
        .await
}

#[tauri::command]
pub async fn sync_execute_data(
    state: State<'_, AppState>,
    task_id: Option<String>,
    request: DataSyncRequest,
) -> AppResult<DataExecuteResult> {
    state
        .tasks
        .scope(task_id, async {
            sync::execute_data(&state, &request).await
        })
        .await
}
