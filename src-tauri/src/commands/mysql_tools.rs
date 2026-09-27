use crate::{
    error::AppResult,
    services::{mysql_objects as objects, sql_import},
    state::AppState,
};
use tauri::State;
#[tauri::command]
pub async fn sql_import_preview(
    state: State<'_, AppState>,
    request: sql_import::Request,
    task_id: Option<String>,
) -> AppResult<sql_import::Preview> {
    state
        .tasks
        .scope(task_id, sql_import::preview(&state, request))
        .await
}
#[tauri::command]
pub async fn sql_import_execute(
    state: State<'_, AppState>,
    session_id: String,
    id: String,
    confirmed: bool,
    report_directory: String,
    task_id: Option<String>,
) -> AppResult<sql_import::Report> {
    state
        .tasks
        .scope(
            task_id,
            sql_import::execute(&state, &session_id, &id, confirmed, &report_directory),
        )
        .await
}
#[tauri::command]
pub async fn mysql_objects(
    state: State<'_, AppState>,
    session_id: String,
    database: String,
) -> AppResult<objects::Catalog> {
    let mut conn = objects::connect(&state, &session_id, &database, false).await?;
    objects::catalog(&mut conn, &database).await
}
#[tauri::command]
pub async fn mysql_object_definition(
    state: State<'_, AppState>,
    session_id: String,
    database: String,
    kind: objects::Kind,
    name: String,
) -> AppResult<objects::Definition> {
    let mut conn = objects::connect(&state, &session_id, &database, false).await?;
    objects::definition(&mut conn, &database, &kind, &name).await
}
#[tauri::command]
pub async fn mysql_object_apply(
    state: State<'_, AppState>,
    request: objects::Change,
) -> AppResult<()> {
    objects::apply(&state, request).await
}
#[tauri::command]
pub async fn mysql_procedure_call(
    state: State<'_, AppState>,
    request: objects::Call,
    task_id: Option<String>,
) -> AppResult<objects::CallResult> {
    state
        .tasks
        .scope(task_id, objects::call(&state, request))
        .await
}
