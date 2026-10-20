use crate::{
    error::{AppError, AppResult},
    state::AppState,
    store::migration::{ConfigBundle, ExportOptions, ImportOptions, ImportPreview, MAX_BYTES},
};
use std::{
    io::{Read, Write},
    path::Path,
};
use tauri::State;

fn json_path(path: &str) -> AppResult<&Path> {
    let path = Path::new(path);
    if !path.is_absolute()
        || !path
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("json"))
    {
        return Err(AppError::InvalidInput(
            "请选择绝对路径的 JSON 配置文件".into(),
        ));
    }
    Ok(path)
}

#[tauri::command]
pub async fn config_export(
    state: State<'_, AppState>,
    path: String,
    options: ExportOptions,
) -> AppResult<()> {
    let path = json_path(&path)?;
    let bundle = state.local.config_export(&options).await?;
    write_bundle(path, &bundle)
}

fn write_bundle(path: &Path, bundle: &ConfigBundle) -> AppResult<()> {
    let bytes = serde_json::to_vec_pretty(&bundle)?;
    if bytes.len() > MAX_BYTES {
        return Err(AppError::InvalidInput(
            "配置文件超过 16 MiB，请减少导出范围".into(),
        ));
    }
    let mut file = tempfile::NamedTempFile::new_in(
        path.parent()
            .ok_or_else(|| AppError::InvalidInput("目标目录无效".into()))?,
    )?;
    file.write_all(&bytes)?;
    file.as_file().sync_all()?;
    file.persist(path)
        .map_err(|e| AppError::Internal(format!("保存配置文件失败：{}", e.error)))?;
    Ok(())
}

#[tauri::command]
pub fn config_read(path: String) -> AppResult<ConfigBundle> {
    let mut bytes = Vec::new();
    std::fs::File::open(json_path(&path)?)?
        .take(MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_BYTES {
        return Err(AppError::InvalidInput("配置文件超过 16 MiB".into()));
    }
    let bundle: ConfigBundle = serde_json::from_slice(
        bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes),
    )
    .map_err(|_| {
        AppError::InvalidInput("配置文件损坏或格式不受支持，请选择 DBFolio 导出的 JSON 文件".into())
    })?;
    bundle.validate()?;
    Ok(bundle)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn config_file_roundtrip_and_invalid_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("中文 配置.json");
        let bundle:ConfigBundle=serde_json::from_value(json!({"format":"dbfolio-config","version":1,"appVersion":"1.0.0-alpha.10","exportedAt":"2026-10-18","sessions":[],"folders":["空分组"],"preferences":{},"favorites":[],"filters":[],"analyses":[],"relations":[],"environments":{},"objectFavorites":[]})).unwrap();
        write_bundle(&path, &bundle).unwrap();
        assert_eq!(
            config_read(path.to_string_lossy().into()).unwrap().folders,
            vec!["空分组"]
        );
        std::fs::write(&path, "损坏的文件").unwrap();
        assert!(config_read(path.to_string_lossy().into()).is_err());
        let mut bytes = vec![0xef, 0xbb, 0xbf];
        bytes.extend(serde_json::to_vec(&bundle).unwrap());
        std::fs::write(&path, bytes).unwrap();
        assert!(config_read(path.to_string_lossy().into()).is_ok());
        let oversized = dir.path().join("large.json");
        std::fs::File::create(&oversized)
            .unwrap()
            .set_len(MAX_BYTES as u64 + 1)
            .unwrap();
        assert!(config_read(oversized.to_string_lossy().into()).is_err());
        assert!(json_path("relative.json").is_err());
        assert!(json_path("C:/data/app.db").is_err());
        write_bundle(&path, &bundle).unwrap();
        assert!(config_read(path.to_string_lossy().into()).is_ok());
    }
}

#[tauri::command]
pub async fn config_preview(
    state: State<'_, AppState>,
    bundle: ConfigBundle,
    options: ImportOptions,
) -> AppResult<ImportPreview> {
    state.local.config_import(&bundle, &options, None).await
}

#[tauri::command]
pub async fn config_import(
    state: State<'_, AppState>,
    bundle: ConfigBundle,
    options: ImportOptions,
    fingerprint: String,
) -> AppResult<ImportPreview> {
    // The UI reloads after import so cached libraries cannot overwrite migrated data.
    let connections = state.connections.lock().await;
    if !connections.is_empty()
        || !state.transactions.0.lock().await.is_empty()
        || !state.running_queries.lock().await.is_empty()
    {
        return Err(AppError::InvalidInput(
            "请先结束任务并断开所有会话，再导入配置".into(),
        ));
    }
    state
        .local
        .config_import(&bundle, &options, Some(&fingerprint))
        .await
}
