use std::{collections::HashMap, future::Future, sync::{Arc, Mutex}};
use serde::Serialize;
use crate::error::{AppError, AppResult};

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub processed: u64,
    pub total: Option<u64>,
    pub message: String,
    pub cancel_requested: bool,
}
#[derive(Default)]
pub struct TaskRegistry(pub Mutex<HashMap<String, Arc<Mutex<Progress>>>>);
tokio::task_local! { static CURRENT: Arc<Mutex<Progress>>; }

impl TaskRegistry {
    pub fn begin(&self, id: String) -> AppResult<()> {
        let mut tasks = self.0.lock().unwrap();
        if tasks.contains_key(&id) || tasks.len() >= 100 {
            return Err(AppError::InvalidInput("任务重复或运行中任务过多".into()));
        }
        tasks.insert(id, Arc::new(Mutex::new(Progress::default())));
        Ok(())
    }
    pub fn cancel(&self, id: &str) -> AppResult<()> {
        let tasks = self.0.lock().unwrap();
        let task = tasks.get(id).ok_or_else(|| AppError::NotFound("任务已结束".into()))?;
        task.lock().unwrap().cancel_requested = true;
        Ok(())
    }
    pub fn snapshot(&self, id: &str) -> Option<Progress> {
        self.0.lock().unwrap().get(id).map(|p| p.lock().unwrap().clone())
    }
    pub async fn scope<T>(&self, id: Option<String>, work: impl Future<Output = AppResult<T>>) -> AppResult<T> {
        let Some(id) = id else { return work.await; };
        let task = self.0.lock().unwrap().get(&id).cloned()
            .ok_or_else(|| AppError::NotFound("任务未登记".into()))?;
        CURRENT.scope(task, async { checkpoint()?; work.await }).await
    }
}
pub fn progress(processed: u64, total: Option<u64>, message: impl Into<String>) {
    let message = message.into();
    let _ = CURRENT.try_with(|p| { let mut p = p.lock().unwrap(); p.processed = processed; p.total = total; p.message = message; });
}
fn note(message: impl Into<String>) {
    let message = message.into();
    let _ = CURRENT.try_with(|p| { let mut p = p.lock().unwrap(); p.message = format!("{}\n{}", p.message, message); });
}
pub fn cancelled() -> bool { CURRENT.try_with(|p| p.lock().unwrap().cancel_requested).unwrap_or(false) }
pub fn checkpoint() -> AppResult<()> {
    if cancelled() { Err(AppError::Cancelled("任务已取消；未开始的操作已停止，已完成的操作不会自动撤销".into())) } else { Ok(()) }
}

/// 仅取消这个请求持有的查询连接，不通过会话查找“最后一条查询”。
pub async fn query<T>(adapter: &dyn crate::adapters::DbAdapter, ctx: &crate::adapters::QueryContext,
    work: impl Future<Output = AppResult<T>>) -> AppResult<T> {
    checkpoint()?;
    let seconds=adapter.query_timeout_secs();
    let work = async { tokio::time::timeout(std::time::Duration::from_secs(seconds), work).await
        .map_err(|_| AppError::Database(format!("读取超过 {seconds} 秒，已停止等待；服务器执行结果需重新确认，不会自动重试")))? };
    tokio::pin!(work);
    let mut timer = tokio::time::interval(std::time::Duration::from_millis(100));
    let mut attempted = false;
    let mut stopped = false;
    loop {
        tokio::select! {
            result = &mut work => return match result {
                Err(_) if stopped => Err(AppError::Cancelled("查询已取消".into())),
                other => other,
            },
            _ = timer.tick(), if !attempted => {
                if cancelled() {
                    let conn_id = *ctx.conn_id.lock().await;
                    if conn_id.is_none() && adapter.engine() == crate::meta::Engine::Sqlite {
                        attempted = true;
                        note("SQLite 当前查询无法立即中断，正在等待结果；后续批次将停止");
                    }
                    if let Some(id) = conn_id {
                        attempted = true;
                        match tokio::time::timeout(std::time::Duration::from_secs(5), adapter.cancel(id)).await {
                            Ok(Ok(())) => stopped = true,
                            Ok(Err(error)) => note(format!("取消未生效：{error}；等待查询结果")),
                            Err(_) => note("取消请求超时；等待查询结果确认"),
                        }
                    }
                }
            }
        }
    }
}

#[tauri::command]
pub fn task_begin(state: tauri::State<'_, crate::state::AppState>, id: String) -> AppResult<()> { state.tasks.begin(id) }
#[tauri::command]
pub fn task_cancel(state: tauri::State<'_, crate::state::AppState>, id: String) -> AppResult<()> { state.tasks.cancel(&id) }
#[tauri::command]
pub fn task_progress(state: tauri::State<'_, crate::state::AppState>, id: String) -> Option<Progress> { state.tasks.snapshot(&id) }
#[tauri::command]
pub fn task_release(state: tauri::State<'_, crate::state::AppState>, id: String) { state.tasks.0.lock().unwrap().remove(&id); }

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn cancellation_is_isolated_and_keeps_committed_progress() {
        let registry = TaskRegistry::default();
        registry.begin("a".into()).unwrap(); registry.begin("b".into()).unwrap();
        registry.cancel("a").unwrap();
        assert!(matches!(registry.scope(Some("a".into()), async { Ok(()) }).await, Err(AppError::Cancelled(_))));
        registry.scope(Some("b".into()), async { progress(500, None, "已提交 500 行"); checkpoint() }).await.unwrap();
        assert_eq!(registry.snapshot("b").unwrap().processed, 500);
        assert!(!registry.snapshot("b").unwrap().cancel_requested);
    }
}
