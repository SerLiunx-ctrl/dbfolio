use tauri::State;

use crate::error::AppResult;
use crate::services::ddl::{self, DdlSpec};
use crate::state::AppState;

#[tauri::command]
pub async fn ddl_preview(
    state: State<'_, AppState>,
    session_id: String,
    database: String,
    spec: DdlSpec,
) -> AppResult<Vec<String>> {
    ddl::preview(&state, &session_id, &database, &spec).await
}

#[tauri::command]
pub async fn ddl_apply(
    state: State<'_, AppState>,
    session_id: String,
    database: String,
    spec: DdlSpec,
    force: Option<bool>,
) -> AppResult<Vec<String>> {
    ddl::apply(&state, &session_id, &database, &spec, force.unwrap_or(false)).await
}

#[tauri::command]
pub async fn ddl_create_database(
    state: State<'_, AppState>,
    session_id: String,
    name: String,
    charset: Option<String>,
    collation: Option<String>,
) -> AppResult<()> {
    ddl::create_database(&state, &session_id, &name, charset, collation).await
}

#[tauri::command]
pub async fn ddl_drop_database(
    state: State<'_, AppState>,
    session_id: String,
    name: String,
    force: Option<bool>,
) -> AppResult<()> {
    ddl::drop_database(&state, &session_id, &name, force.unwrap_or(false)).await
}
