use crate::{
    error::{AppError, AppResult},
    meta::{Engine, TableMeta},
    state::AppState,
    tasks,
};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObjectRef {
    pub name: String,
    pub schema: Option<String>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub name: String,
    pub schema: Option<String>,
    pub meta: Option<TableMeta>,
    pub error: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub engine: Engine,
    pub database: String,
    pub server_version: String,
    pub collected_at: String,
    pub items: Vec<Item>,
}

async fn collect(
    state: &AppState,
    session_id: String,
    database: String,
    objects: Vec<ObjectRef>,
) -> AppResult<Snapshot> {
    if objects.is_empty() || objects.len() > 300 {
        return Err(AppError::InvalidInput("请选择 1～300 个表或视图".into()));
    }
    let session = state.local.get_session(&session_id).await?;
    crate::services::database_access::check(session.allowed_databases.as_deref(), &database)?;
    let connected = state.connected(&session_id).await?;
    let engine = connected.adapter.engine();
    if !engine.is_sql() {
        return Err(AppError::InvalidInput(
            "数据字典支持 MySQL、PostgreSQL、SQLite".into(),
        ));
    }
    let catalog = crate::services::ai::cancellable(async {
        tokio::time::timeout(
            std::time::Duration::from_secs(30),
            connected.adapter.list_tables(&database),
        )
        .await
        .map_err(|_| AppError::Message("读取对象列表超时".into()))?
    })
    .await?;
    let mut seen = HashSet::new();
    let mut items = Vec::new();
    let mut bytes = 0usize;
    let mut fields = 0usize;
    for object in &objects {
        tasks::checkpoint()?;
        if !seen.insert((&object.schema, &object.name))
            || !catalog
                .iter()
                .any(|v| v.schema == object.schema && v.name == object.name)
        {
            return Err(AppError::InvalidInput(
                "选定范围重复或对象已不存在，请刷新对象列表".into(),
            ));
        }
        tasks::progress(
            items.len() as u64,
            Some(objects.len() as u64),
            format!("读取数据字典：{}", object.name),
        );
        let result = crate::services::ai::cancellable(async {
            tokio::time::timeout(
                std::time::Duration::from_secs(30),
                connected.adapter.introspect_table(
                    &database,
                    object.schema.as_deref(),
                    &object.name,
                ),
            )
            .await
            .map_err(|_| AppError::Message("读取结构超时".into()))?
        })
        .await;
        let (meta, error) = match result {
            Ok(meta) => (Some(meta), None),
            Err(e) => {
                if matches!(e, AppError::Cancelled(_)) {
                    return Err(e);
                }
                (None, Some(e.to_string()))
            }
        };
        if let Some(m) = &meta {
            fields += m.columns.len();
            bytes += serde_json::to_vec(m)?.len();
        }
        if fields > 30000 || bytes > 16 * 1024 * 1024 {
            return Err(AppError::InvalidInput(
                "字典超过 30000 个字段或 16 MiB，请缩小对象范围".into(),
            ));
        }
        items.push(Item {
            name: object.name.clone(),
            schema: object.schema.clone(),
            meta,
            error,
        });
    }
    tasks::progress(
        items.len() as u64,
        Some(items.len() as u64),
        "数据字典读取完成",
    );
    Ok(Snapshot {
        engine,
        database,
        server_version: connected.server_version.clone(),
        collected_at: chrono::Utc::now().to_rfc3339(),
        items,
    })
}
#[tauri::command]
pub async fn dictionary_collect(
    state: tauri::State<'_, AppState>,
    session_id: String,
    database: String,
    objects: Vec<ObjectRef>,
    task_id: Option<String>,
) -> AppResult<Snapshot> {
    state
        .tasks
        .scope(task_id, collect(&state, session_id, database, objects))
        .await
}
#[tauri::command]
pub async fn dictionary_export(
    state: tauri::State<'_, AppState>,
    path: String,
    document: crate::services::dictionary::Document,
    format: String,
    task_id: Option<String>,
) -> AppResult<usize> {
    crate::services::dictionary::validate_path(&path, &format)?;
    state
        .tasks
        .scope(task_id, async {
            tasks::checkpoint()?;
            tasks::progress(0, Some(2), "正在生成字典文档");
            let render_format = format.clone();
            let bytes = tauri::async_runtime::spawn_blocking(move || {
                crate::services::dictionary::render(&document, &render_format)
            })
            .await
            .map_err(|e| AppError::Internal(e.to_string()))??;
            // Cancellation during rendering must not replace the destination file.
            tasks::checkpoint()?;
            tasks::progress(1, Some(2), "正在保存字典文档");
            let length = tauri::async_runtime::spawn_blocking(move || {
                crate::services::dictionary::write(&path, &bytes, &format)
            })
            .await
            .map_err(|e| AppError::Internal(e.to_string()))??;
            tasks::progress(2, Some(2), "数据字典已导出");
            Ok(length)
        })
        .await
}
