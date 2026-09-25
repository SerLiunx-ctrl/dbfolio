use tauri::State;

use crate::error::AppResult;
use crate::meta::{CharsetMeta, DatabaseMeta, InfoEntry, TableInfo, TableMeta, TableRef};
use crate::state::AppState;

#[tauri::command]
pub async fn meta_charsets(
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<Vec<CharsetMeta>> {
    let connected = state.connected(&session_id).await?;
    connected.adapter.charsets().await
}

#[tauri::command]
pub async fn meta_collations(
    state: State<'_, AppState>,
    session_id: String,
    charset: String,
) -> AppResult<Vec<String>> {
    let connected = state.connected(&session_id).await?;
    connected.adapter.collations(&charset).await
}

#[tauri::command]
pub async fn meta_server_info(
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<Vec<InfoEntry>> {
    let connected = state.connected(&session_id).await?;
    connected.adapter.server_info().await
}

#[tauri::command]
pub async fn meta_database_info(
    state: State<'_, AppState>,
    session_id: String,
    database: String,
) -> AppResult<Vec<InfoEntry>> {
    let connected = state.connected(&session_id).await?;
    connected.adapter.database_info(&database).await
}

#[tauri::command]
pub async fn meta_databases(
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<Vec<DatabaseMeta>> {
    let connected = state.connected(&session_id).await?;
    connected.adapter.list_databases().await
}

#[tauri::command]
pub async fn meta_tables(
    state: State<'_, AppState>,
    session_id: String,
    database: String,
) -> AppResult<Vec<TableRef>> {
    let connected = state.connected(&session_id).await?;
    connected.adapter.list_tables(&database).await
}

#[tauri::command]
pub async fn meta_table_info(
    state: State<'_, AppState>,
    session_id: String,
    database: String,
    schema: Option<String>,
    table: String,
) -> AppResult<TableInfo> {
    let connected = state.connected(&session_id).await?;
    let meta = connected
        .adapter
        .introspect_table(&database, schema.as_deref(), &table)
        .await?;
    let extra = connected
        .adapter
        .table_extra_info(&database, schema.as_deref(), &table)
        .await
        .unwrap_or_default();

    Ok(TableInfo {
        name: meta.name.clone(),
        database: database.clone(),
        schema: meta.schema.clone(),
        kind: meta.kind,
        comment: meta.comment.clone(),
        row_estimate: meta.row_estimate,
        column_count: meta.columns.len(),
        index_count: meta.indexes.len(),
        foreign_key_count: meta.foreign_keys.len(),
        primary_key: meta.primary_key.clone(),
        auto_increment_column: meta
            .columns
            .iter()
            .find(|column| column.auto_increment)
            .map(|column| column.name.clone()),
        extra,
    })
}

#[tauri::command]
pub async fn meta_table_detail(
    state: State<'_, AppState>,
    session_id: String,
    database: String,
    schema: Option<String>,
    table: String,
) -> AppResult<TableMeta> {
    let connected = state.connected(&session_id).await?;
    connected
        .adapter
        .introspect_table(&database, schema.as_deref(), &table)
        .await
}

#[tauri::command]
pub async fn meta_storage_engines(state:State<'_ ,AppState>,session_id:String)->AppResult<Vec<String>> {state.connected(&session_id).await?.adapter.storage_engines().await}
