use crate::{
    error::AppResult,
    services::{
        ai,
        generation::{self as g, adapters, AiOptions, Plan, Preview, Target, WriteReport},
    },
    state::AppState,
};
use tauri::State;
#[tauri::command]
pub async fn ai_providers(state: State<'_, AppState>) -> AppResult<Vec<ai::Provider>> {
    ai::providers(&state).await
}
#[tauri::command]
pub async fn ai_save(
    state: State<'_, AppState>,
    provider: ai::Provider,
    key: Option<String>,
) -> AppResult<Vec<ai::Provider>> {
    ai::save(&state, provider, key).await
}
#[tauri::command]
pub async fn ai_remove(state: State<'_, AppState>, id: String) -> AppResult<Vec<ai::Provider>> {
    ai::remove(&state, &id).await
}
#[tauri::command]
pub async fn ai_models(
    state: State<'_, AppState>,
    provider: ai::Provider,
    key: Option<String>,
    task_id: Option<String>,
) -> AppResult<Vec<String>> {
    state.tasks.scope(task_id, ai::models(&provider, key)).await
}
#[tauri::command]
pub async fn ai_test(
    state: State<'_, AppState>,
    provider: ai::Provider,
    key: Option<String>,
    task_id: Option<String>,
) -> AppResult<ai::AiResult> {
    state.tasks.scope(task_id, ai::test(&provider, key)).await
}
#[tauri::command]
pub async fn generation_describe(
    state: State<'_, AppState>,
    target: Target,
) -> AppResult<adapters::TargetDescription> {
    ai::cancellable(async {
        tokio::time::timeout(std::time::Duration::from_secs(30), async {
            adapters::resolve(&state, &target).await?.describe().await
        })
        .await
        .map_err(|_| g::invalid("读取目标结构超时"))?
    })
    .await
}
#[tauri::command]
pub async fn generation_generate(
    state: State<'_, AppState>,
    plan: Plan,
    task_id: Option<String>,
    on_event: tauri::ipc::Channel<g::GenerationEvent>,
) -> AppResult<Preview> {
    let channel = on_event.clone();
    let observer: g::Observer = std::sync::Arc::new(move |event| {
        let _ = channel.send(event);
    });
    let result = state
        .tasks
        .scope(task_id, g::generate_observed(&state, plan, Some(observer)))
        .await;
    let _ = on_event.send(g::GenerationEvent::Finished);
    result
}
#[tauri::command]
pub async fn generation_preview(
    state: State<'_, AppState>,
    id: String,
    offset: u32,
) -> AppResult<Preview> {
    g::preview(&state, &id, offset)
}
#[tauri::command]
pub async fn generation_release(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.generation.release(&id)
}
#[tauri::command]
pub async fn generation_write(
    state: State<'_, AppState>,
    id: String,
    session_id: String,
    task_id: Option<String>,
) -> AppResult<WriteReport> {
    if state.generation.get(&id)?.plan.target.session_id != session_id {
        return Err(g::invalid("批次会话不匹配"));
    }
    state.tasks.scope(task_id, g::write(&state, &id)).await
}
#[tauri::command]
pub async fn generation_export(
    state: State<'_, AppState>,
    id: String,
    path: String,
    format: String,
    session_id: String,
    task_id: Option<String>,
) -> AppResult<serde_json::Value> {
    if state.generation.get(&id)?.plan.target.session_id != session_id {
        return Err(g::invalid("批次会话不匹配"));
    }
    state
        .tasks
        .scope(task_id, g::export(&state, &id, &path, &format))
        .await
}
#[tauri::command]
pub async fn generation_suggest(
    state: State<'_, AppState>,
    target: Target,
    options: AiOptions,
    task_id: Option<String>,
) -> AppResult<serde_json::Value> {
    state
        .tasks
        .scope(task_id, g::suggest(&state, target, options))
        .await
}
#[tauri::command]
pub async fn generation_template_read(path: String) -> AppResult<String> {
    let meta = tokio::fs::metadata(&path).await?;
    if meta.len() > 128 * 1024 {
        return Err(g::invalid("模板超过 128 KiB"));
    }
    Ok(tokio::fs::read_to_string(path).await?)
}
#[tauri::command]
pub async fn generation_template_write(path: String, text: String) -> AppResult<()> {
    let value: serde_json::Value = serde_json::from_str(&text)?;
    if text.len() > 128 * 1024 || value["version"] != 1 {
        return Err(g::invalid("模板格式无效"));
    }
    let path = std::path::Path::new(&path);
    if !path.is_absolute() {
        return Err(g::invalid("请选择绝对路径"));
    }
    let mut temp = tempfile::NamedTempFile::new_in(path.parent().unwrap())?;
    use std::io::Write;
    temp.write_all(text.as_bytes())?;
    temp.persist(path).map_err(|e| g::invalid(e.to_string()))?;
    Ok(())
}
