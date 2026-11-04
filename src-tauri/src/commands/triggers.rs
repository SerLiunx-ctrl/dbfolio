use crate::{error::AppResult, services::triggers, state::AppState};
use tauri::State;
#[tauri::command]
pub async fn trigger_catalog(
    state: State<'_, AppState>,
    session_id: String,
    database: String,
) -> AppResult<triggers::Catalog> {
    triggers::catalog(&state, &session_id, &database).await
}
#[tauri::command]
pub async fn trigger_definition(
    state: State<'_, AppState>,
    session_id: String,
    database: String,
    schema: Option<String>,
    table: String,
    name: String,
) -> AppResult<triggers::Definition> {
    triggers::definition(
        &state,
        &session_id,
        &database,
        schema.as_deref(),
        &table,
        &name,
    )
    .await
}
#[tauri::command]
pub async fn trigger_preview(
    state: State<'_, AppState>,
    request: triggers::Change,
) -> AppResult<triggers::Preview> {
    triggers::preview(&state, &request).await
}
#[tauri::command]
pub async fn trigger_apply(state: State<'_, AppState>, request: triggers::Change) -> AppResult<()> {
    triggers::apply(&state, request).await
}
