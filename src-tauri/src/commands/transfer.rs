use tauri::State;

use crate::error::AppResult;
use crate::services::transfer::{
    self, ExportRequest, ExportResult, ImportPreview, ImportRequest, ImportResult,
};
use crate::state::AppState;

#[tauri::command]
pub async fn export_data(
    state: State<'_, AppState>,
    task_id: Option<String>,
    request: ExportRequest,
) -> AppResult<ExportResult> {
    state.tasks.scope(task_id, async {
    transfer::export(&state, &request).await
    }).await
}

#[tauri::command]
pub async fn import_preview(
    file_path: String,
    options: transfer::ImportOptions,
) -> AppResult<ImportPreview> {
    transfer::preview(&file_path, &options)
}

#[tauri::command]
pub async fn import_csv(
    state: State<'_, AppState>,
    task_id: Option<String>,
    request: ImportRequest,
) -> AppResult<ImportResult> {
    state.tasks.scope(task_id, async {
    transfer::import_csv(&state, &request).await
    }).await
}

#[tauri::command]
pub async fn export_sql(state: State<'_ , AppState>, task_id: Option<String>, request: crate::services::sql_export::SqlExportRequest) -> AppResult<crate::services::sql_export::SqlExportResult> {state.tasks.scope(task_id,async {crate::services::sql_export::export(&state,&request).await}).await}
