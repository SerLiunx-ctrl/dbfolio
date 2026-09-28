use crate::{
    adapters::mongodb::{DocumentAdapter, FindRequest, MongoPage},
    error::{AppError, AppResult},
    state::AppState,
};
use std::{future::Future, sync::Arc, time::Duration};
use tauri::State;
#[tauri::command]
pub async fn mongo_inspect(state: State<'_, AppState>, session_id:String, database:String, collection:String, operation:String, text:String, task_id:Option<String>)->AppResult<serde_json::Value> {
    let a=adapter(&state,&session_id).await?;
    state.tasks.scope(task_id,read(a.query_timeout_secs(),a.inspect(&database,&collection,&operation,&text))).await
}
#[tauri::command]
pub async fn mongo_create_index(state: State<'_, AppState>, session_id:String, database:String, collection:String, text:String, task_id:Option<String>)->AppResult<serde_json::Value> {
    if state.local.get_session(&session_id).await?.read_only {return Err(AppError::ReadOnly("只读会话不能创建索引".into()));}
    let a=adapter(&state,&session_id).await?;
    state.tasks.scope(task_id,async {
        crate::tasks::checkpoint()?;
        tokio::time::timeout(Duration::from_secs(60),a.create_index(&database,&collection,&text)).await.map_err(|_|AppError::WriteUncertain("索引创建仍可能在服务器执行，请刷新索引列表核对".into()))?
    }).await
}
#[tauri::command]
pub async fn mongo_transfer(state: State<'_, AppState>, session_id:String, request:crate::adapters::mongodb::TransferRequest, task_id:Option<String>)->AppResult<serde_json::Value> {
    if request.direction=="import" && state.local.get_session(&session_id).await?.read_only {return Err(AppError::ReadOnly("只读会话不能导入文档".into()));}
    let a=adapter(&state,&session_id).await?;
    state.tasks.scope(task_id,a.transfer(request)).await
}
async fn adapter(state: &AppState, id: &str) -> AppResult<Arc<dyn DocumentAdapter>> {
    state
        .connected(id)
        .await?
        .mongo
        .clone()
        .ok_or_else(|| AppError::InvalidInput("当前会话不是 MongoDB".into()))
}
async fn read<T>(seconds:u64,work: impl Future<Output = AppResult<T>>) -> AppResult<T> {
    let work = tokio::time::timeout(Duration::from_secs(seconds), work);
    tokio::pin!(work);
    loop {
        tokio::select! {result=&mut work=>return result.map_err(|_|AppError::Message("MongoDB 读取超时，请缩小查询范围".into()))?,_=tokio::time::sleep(Duration::from_millis(100))=>crate::tasks::checkpoint()?}
    }
}
#[tauri::command]
pub async fn mongo_collections(
    state: State<'_, AppState>,
    session_id: String,
    database: String,
) -> AppResult<Vec<String>> {
    let a=adapter(&state,&session_id).await?;
    read(a.query_timeout_secs(),a.collections(&database)).await
}
#[tauri::command]
pub async fn mongo_find(
    state: State<'_, AppState>,
    session_id: String,
    request: FindRequest,
    task_id: Option<String>,
) -> AppResult<MongoPage> {
    let a = adapter(&state, &session_id).await?;
    state.tasks.scope(task_id, read(a.query_timeout_secs(),a.find(request))).await
}
#[tauri::command]
pub async fn mongo_next(
    state: State<'_, AppState>,
    session_id: String,
    cursor: String,
    task_id: Option<String>,
) -> AppResult<MongoPage> {
    let a = adapter(&state, &session_id).await?;
    let result = state.tasks.scope(task_id, read(a.query_timeout_secs(),a.next(&cursor))).await;
    if result.is_err() {
        a.release(&cursor).await;
    }
    result
}
#[tauri::command]
pub async fn mongo_release(
    state: State<'_, AppState>,
    session_id: String,
    cursor: String,
) -> AppResult<()> {
    if let Ok(a) = adapter(&state, &session_id).await {
        a.release(&cursor).await;
    }
    Ok(())
}
#[tauri::command]
pub async fn mongo_document(
    state: State<'_, AppState>,
    session_id: String,
    database: String,
    collection: String,
    id: String,
) -> AppResult<String> {
    read(
        adapter(&state,&session_id).await?.query_timeout_secs(),
        adapter(&state, &session_id)
            .await?
            .document(&database, &collection, &id),
    )
    .await
}
#[tauri::command]
pub async fn mongo_write(
    state: State<'_, AppState>,
    session_id: String,
    database: String,
    collection: String,
    operation: String,
    original: Option<String>,
    text: String,
    task_id: Option<String>,
) -> AppResult<String> {
    let record = state.local.get_session(&session_id).await?;
    if record.read_only {
        return Err(AppError::ReadOnly("此会话为只读，不能修改文档".into()));
    }
    let a = adapter(&state, &session_id).await?;
    state
        .tasks
        .scope(task_id, async {
            crate::tasks::checkpoint()?;
            // 写入发送后不能把停止等待当成回滚；保留最终结果或明确标记结果待确认。
            tokio::time::timeout(
                Duration::from_secs(30),
                a.write(
                    &database,
                    &collection,
                    &operation,
                    original.as_deref(),
                    &text,
                ),
            )
            .await
            .map_err(|_| {
                AppError::WriteUncertain(
                    "写入超时，结果待确认。请刷新查询核对，不要直接重复提交".into(),
                )
            })?
        })
        .await
}
