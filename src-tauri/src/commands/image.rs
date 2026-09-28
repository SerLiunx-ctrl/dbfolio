use crate::error::{AppError, AppResult};
use base64::{engine::general_purpose::STANDARD, Engine};
use std::{io::Write, path::Path};

fn write_image(path: &Path, encoded: &str) -> AppResult<()> {
    if !path.is_absolute() || encoded.len() > 64 * 1024 * 1024 {
        return Err(AppError::InvalidInput("图片路径无效或图片超过导出大小限制".into()));
    }
    let bytes = STANDARD.decode(encoded).map_err(|_| AppError::InvalidInput("图片 Base64 内容无效".into()))?;
    let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("").to_ascii_lowercase();
    let valid = match ext.as_str() {
        "png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "jpg" | "jpeg" => bytes.starts_with(b"\xff\xd8\xff"),
        "gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "webp" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"),
        "bmp" => bytes.starts_with(b"BM"),
        _ => false,
    };
    if !valid { return Err(AppError::InvalidInput("文件扩展名与图片格式不一致".into())); }
    let parent = path.parent().ok_or_else(|| AppError::InvalidInput("图片路径无效".into()))?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(|e| AppError::Message(e.to_string()))?;
    temporary.write_all(&bytes).and_then(|_| temporary.as_file().sync_all()).map_err(|e| AppError::Message(format!("导出失败，原文件未修改：{e}")))?;
    temporary.persist(path).map_err(|e| AppError::Message(format!("保存图片失败：{e}")))?;
    Ok(())
}

#[tauri::command]
pub async fn image_export(path: String, base64: String) -> AppResult<()> {
    tauri::async_runtime::spawn_blocking(move || write_image(Path::new(&path), &base64)).await.map_err(|e| AppError::Internal(e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn original_bytes_and_failed_exports_preserve_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("原图.png");
        let mut original = STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6z8AAAAASUVORK5CYII=").unwrap();
        original.extend_from_slice(b"application trailing bytes");
        write_image(&path, &STANDARD.encode(&original)).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), original);
        assert!(write_image(&path, "not-base64!").is_err());
        assert!(write_image(&path, &STANDARD.encode(b"GIF89a")).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), original);
        assert!(write_image(Path::new("relative.png"), &STANDARD.encode(&original)).is_err());
        assert!(write_image(&dir.path().join("bad.svg"), &STANDARD.encode(&original)).is_err());
        write_image(&path, &STANDARD.encode(&original)).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), original);
    }
}
