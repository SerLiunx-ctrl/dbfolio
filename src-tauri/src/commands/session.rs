use tauri::State;

use crate::error::AppResult;
use crate::services::session::{self, ConnectionStatus, TestResult};
use crate::state::AppState;
use crate::store::{SessionInput, SessionRecord};

#[tauri::command]
pub async fn session_list(state: State<'_, AppState>) -> AppResult<Vec<SessionRecord>> {
    state.local.list_sessions().await
}

#[tauri::command]
pub async fn session_create(
    state: State<'_, AppState>,
    input: SessionInput,
) -> AppResult<SessionRecord> {
    state.local.create_session(&input).await
}

#[tauri::command]
pub async fn session_update(
    state: State<'_, AppState>,
    id: String,
    input: SessionInput,
) -> AppResult<SessionRecord> {
    let _guard = state.session_lock(&id).await;
    let record = state.local.update_session(&id, &input).await?;
    state.disconnect_locked(&id).await;
    Ok(record)
}

#[tauri::command]
pub async fn session_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let _guard = state.session_lock(&id).await;
    state.disconnect_locked(&id).await;
    state.local.delete_session(&id).await
}

#[tauri::command]
pub async fn session_test(
    state: State<'_, AppState>,
    input: SessionInput,
    session_id: Option<String>,
) -> AppResult<TestResult> {
    session::test(&state, session_id.as_deref(), &input).await
}

#[tauri::command]
pub async fn session_connect(
    state: State<'_, AppState>,
    id: String,
) -> AppResult<ConnectionStatus> {
    session::connect(&state, &id).await
}

#[tauri::command]
pub async fn session_disconnect(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.disconnect(&id).await;
    Ok(())
}

#[tauri::command]
pub async fn session_set_group(
    state: State<'_, AppState>,
    id: String,
    group: Option<String>,
) -> AppResult<()> {
    let group = group.as_deref().map(str::trim).filter(|v| !v.is_empty());
    state.local.update_session_group(&id, group).await
}

#[tauri::command]
pub async fn session_statuses(state: State<'_, AppState>) -> AppResult<Vec<ConnectionStatus>> {
    Ok(session::statuses(&state).await)
}

#[tauri::command]
pub async fn session_health(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let connected = state.connected(&id).await?;
    let result = tokio::time::timeout(std::time::Duration::from_secs(5), connected.adapter.ping())
        .await
        .unwrap_or_else(|_| {
            Err(crate::error::AppError::Connection(
                "连接探测超时，请重试连接".into(),
            ))
        });
    if result.is_err() {
        let mut connections = state.connections.lock().await;
        if connections
            .get(&id)
            .is_some_and(|current| std::sync::Arc::ptr_eq(current, &connected))
        {
            connections.remove(&id);
        }
    }
    result
}

#[tauri::command]
pub async fn session_duplicate(state: State<'_, AppState>, source_id:String, input:SessionInput) -> AppResult<SessionRecord> {
    session::duplicate(&state,&source_id,input).await
}

#[tauri::command]
pub async fn session_ssh_fingerprint(ssh:crate::services::connection_config::SshConfig,timeout_secs:Option<u64>)->AppResult<String>{crate::services::transport::fingerprint(&ssh,timeout_secs.unwrap_or(15)).await}
