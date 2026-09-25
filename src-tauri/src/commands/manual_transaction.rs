use crate::{
    adapters::QueryOutcome,
    error::AppResult,
    services::{manual_transaction as tx, query::SortSpec},
    state::AppState,
};
use tauri::State;
#[tauri::command]
pub async fn transaction_begin(
    state: State<'_, AppState>,
    session_id: String,
    database: String,
    tab_id: String,
) -> AppResult<tx::TransactionInfo> {
    tx::begin(&state, &session_id, &database, &tab_id).await
}
#[tauri::command]
pub async fn transaction_status(
    state: State<'_, AppState>,
    id: String,
) -> AppResult<Option<tx::TransactionInfo>> {
    Ok(tx::status(&state, &id).await)
}
#[tauri::command]
pub async fn transaction_execute(
    state: State<'_, AppState>,
    task_id: Option<String>,
    id: String,
    session_id: String,
    sql: String,
    force: bool,
    offset: u64,
    sort: Vec<SortSpec>,
    limit: Option<u32>,
) -> AppResult<QueryOutcome> {
    state
        .tasks
        .scope(
            task_id,
            tx::execute_paged(&state, &id, &session_id, &sql, force, offset, &sort, limit.unwrap_or(200)),
        )
        .await
}
#[tauri::command]
pub async fn transaction_finish(
    state: State<'_, AppState>,
    id: String,
    session_id: String,
    commit: bool,
) -> AppResult<()> {
    tx::finish(&state, &id, &session_id, commit).await
}
