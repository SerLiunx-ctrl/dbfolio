use crate::error::{AppError, AppResult};
use crate::{services::er_ai, state::AppState};
use std::{io::Write, path::Path};
#[tauri::command]
pub async fn er_ai_suggest(
    state: tauri::State<'_, AppState>,
    request: er_ai::Request,
    task_id: Option<String>,
) -> AppResult<er_ai::Reply> {
    state
        .tasks
        .scope(task_id, er_ai::suggest(&state, request))
        .await
}
#[tauri::command]
pub async fn er_ai_verify(
    state: tauri::State<'_, AppState>,
    request: er_ai::Verify,
    task_id: Option<String>,
) -> AppResult<er_ai::Verified> {
    state
        .tasks
        .scope(task_id, er_ai::verify(&state, request))
        .await
}

fn write_export(path: &Path, bytes: &[u8]) -> AppResult<()> {
    let ext = path
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !path.is_absolute()
        || !matches!(ext.as_str(), "svg" | "png" | "mmd")
        || bytes.len() > 32 * 1024 * 1024
    {
        return Err(AppError::InvalidInput(
            "请选择 SVG、PNG 或 MMD 绝对路径，文件不能超过 32 MiB".into(),
        ));
    }
    if ext == "png" {
        if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            return Err(AppError::InvalidInput("PNG 格式无效".into()));
        }
    } else {
        let text = std::str::from_utf8(bytes)
            .map_err(|_| AppError::InvalidInput("关系图文本必须为 UTF-8".into()))?;
        if (ext == "svg" && !text.trim_start().starts_with("<svg "))
            || (ext == "mmd" && !text.starts_with("flowchart LR\n"))
        {
            return Err(AppError::InvalidInput("关系图格式与扩展名不一致".into()));
        }
    }
    let parent = path
        .parent()
        .ok_or_else(|| AppError::InvalidInput("路径无效".into()))?;
    let mut temp =
        tempfile::NamedTempFile::new_in(parent).map_err(|e| AppError::Message(e.to_string()))?;
    temp.write_all(bytes)
        .and_then(|_| temp.as_file().sync_all())
        .map_err(|e| AppError::Message(e.to_string()))?;
    temp.persist(path)
        .map_err(|e| AppError::Message(format!("导出失败，原文件未修改：{e}")))?;
    Ok(())
}
#[tauri::command]
pub async fn er_export(path: String, bytes: Vec<u8>) -> AppResult<()> {
    tauri::async_runtime::spawn_blocking(move || write_export(Path::new(&path), &bytes))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn formats_and_failed_write_preserve_original() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("中文.svg");
        let svg = b"<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>";
        write_export(&p, svg).unwrap();
        assert!(write_export(&p, b"not svg").is_err());
        assert_eq!(std::fs::read(&p).unwrap(), svg);
        assert!(write_export(Path::new("relative.svg"), svg).is_err());
        assert!(write_export(&dir.path().join("bad.exe"), svg).is_err());
        write_export(&dir.path().join("graph.mmd"), b"flowchart LR\n T0 --> T1\n").unwrap();
        assert!(write_export(&dir.path().join("bad.png"), svg).is_err());
    }
}
