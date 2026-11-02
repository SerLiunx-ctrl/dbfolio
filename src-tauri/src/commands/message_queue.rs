use crate::{
    adapters::message_queue::model::{Catalog, Message, Mutation, Page, Read},
    error::{AppError, AppResult},
    state::AppState,
};
use serde_json::Value;
use tauri::State;
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportSource {
    pub engine: crate::meta::Engine,
    pub scope: String,
    pub name: String,
    pub kind: String,
}

fn missing() -> AppError {
    AppError::InvalidInput("当前会话不是消息系统".into())
}
async fn controlled<T>(
    work: impl std::future::Future<Output = AppResult<T>>,
    timeout: std::time::Duration,
    changes_state: bool,
) -> AppResult<T> {
    let work = tokio::time::timeout(timeout, work);
    tokio::pin!(work);
    let mut timer = tokio::time::interval(std::time::Duration::from_millis(100));
    loop {
        tokio::select! {result=&mut work=>return result.map_err(|_|if changes_state{AppError::WriteUncertain("诊断取样超时，队列状态可能已变化，请核对；不会自动补发".into())}else{AppError::Connection("消息系统读取超时".into())})?,_ = timer.tick()=>if crate::tasks::cancelled(){return Err(if changes_state{AppError::WriteUncertain("已停止等待；RabbitMQ 取样可能已经执行，请核对队列状态".into())}else{AppError::Cancelled("消息读取已取消".into())});}}
    }
}
#[tauri::command]
pub async fn mq_catalog(
    state: State<'_, AppState>,
    session_id: String,
    scope: Option<String>,
    task_id: Option<String>,
) -> AppResult<Catalog> {
    state
        .tasks
        .scope(task_id, async {
            let c = state.connected(&session_id).await?;
            let mq = c.adapter.message_queue().ok_or_else(missing)?;
            controlled(mq.catalog(scope.as_deref()), mq.timeout(), false).await
        })
        .await
}
#[tauri::command]
pub async fn mq_inspect(
    state: State<'_, AppState>,
    session_id: String,
    scope: String,
    name: String,
    kind: String,
    task_id: Option<String>,
) -> AppResult<String> {
    state
        .tasks
        .scope(task_id, async {
            let c = state.connected(&session_id).await?;
            let mq = c.adapter.message_queue().ok_or_else(missing)?;
            controlled(mq.inspect(&scope, &name, &kind), mq.timeout(), false).await
        })
        .await
}
#[tauri::command]
pub async fn mq_read(
    state: State<'_, AppState>,
    session_id: String,
    request: Read,
    task_id: Option<String>,
) -> AppResult<Page> {
    state
        .tasks
        .scope(task_id, async {
            let c = state.connected(&session_id).await?;
            let mq = c.adapter.message_queue().ok_or_else(missing)?;
            if c.adapter.engine() == crate::meta::Engine::Rabbitmq {
                if state.local.get_session(&session_id).await?.read_only {
                    return Err(AppError::ReadOnly(
                        "RabbitMQ 诊断取样会取出并重新入队；只读会话禁止此操作".into(),
                    ));
                }
                if !request.confirmed {
                    return Err(AppError::Dangerous(
                        "RabbitMQ 取样会改变顺序及 redelivered 标记；确认后取出并重新入队".into(),
                    ));
                }
            }
            controlled(
                mq.read(&request),
                mq.timeout(),
                c.adapter.engine() == crate::meta::Engine::Rabbitmq,
            )
            .await
        })
        .await
}
#[tauri::command]
pub async fn mq_mutate(
    state: State<'_, AppState>,
    session_id: String,
    request: Mutation,
    task_id: Option<String>,
) -> AppResult<Value> {
    state
        .tasks
        .scope(task_id, async {
            let record = state.local.get_session(&session_id).await?;
            if record.read_only {
                return Err(AppError::ReadOnly(
                    "只读会话禁止发送消息及修改消息系统对象".into(),
                ));
            }
            if !request.confirmed {
                return Err(AppError::Dangerous("请确认消息发送或对象变更后执行".into()));
            }
            let c = state.connected(&session_id).await?;
            let mq = c.adapter.message_queue().ok_or_else(missing)?;
            tokio::time::timeout(mq.timeout(), mq.mutate(&request))
                .await
                .map_err(|_| {
                    AppError::WriteUncertain(
                        "消息系统写操作超时，可能已执行，请检查实际状态；不会自动重试".into(),
                    )
                })?
        })
        .await
}
#[tauri::command]
pub async fn mq_export(
    path: String,
    messages: Vec<Message>,
    format: String,
    source: ExportSource,
) -> AppResult<u64> {
    if !source.engine.is_message_queue() {
        return Err(missing());
    }
    if messages.len() > 1000 {
        return Err(AppError::InvalidInput(
            "一次最多导出 1000 条已加载消息".into(),
        ));
    }
    let data = match format.as_str() {
        "json" => serde_json::to_vec_pretty(
            &serde_json::json!({"version":1,"source":source,"messages":messages}),
        )?,
        "jsonl" => {
            let mut v = Vec::new();
            for m in &messages {
                serde_json::to_writer(
                    &mut v,
                    &serde_json::json!({"version":1,"source":source,"message":m}),
                )?;
                v.push(b'\n');
            }
            v
        }
        _ => {
            return Err(AppError::InvalidInput(
                "导出格式只支持 json 或 jsonl".into(),
            ))
        }
    };
    if data.len() > 8 * 1024 * 1024 {
        return Err(AppError::InvalidInput(
            "消息导出超过 8 MiB，请缩小条目数".into(),
        ));
    }
    let target = std::path::Path::new(&path);
    let parent = target
        .parent()
        .filter(|p| p.is_dir())
        .ok_or_else(|| AppError::InvalidInput("导出目录不存在".into()))?;
    use std::io::Write;
    let mut file = tempfile::NamedTempFile::new_in(parent)?;
    file.write_all(&data)?;
    file.as_file().sync_all()?;
    file.persist(target)
        .map_err(|e| AppError::Internal(e.error.to_string()))?;
    Ok(data.len() as u64)
}
