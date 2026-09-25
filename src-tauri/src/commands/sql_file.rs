use crate::error::{AppError, AppResult};
use std::{io::{Read, Write}, path::Path};
const LIMIT: u64 = 2 * 1024 * 1024;

fn check_path(path: &Path) -> AppResult<()> {
    if !path.is_absolute() || !path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("sql")) {
        return Err(AppError::InvalidInput("请选择绝对路径的 .sql 文件".into()));
    }
    Ok(())
}

fn read(path: &Path) -> AppResult<Option<String>> {
    check_path(path)?;
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(AppError::Message(format!("读取 SQL 文件失败：{e}"))),
    };
    let mut bytes = Vec::new();
    file.take(LIMIT + 1).read_to_end(&mut bytes).map_err(|e| AppError::Message(e.to_string()))?;
    if bytes.len() as u64 > LIMIT { return Err(AppError::InvalidInput("SQL 文件超过 2 MB，请拆分后打开".into())); }
    let text = String::from_utf8(bytes).map_err(|_| AppError::InvalidInput("文件不是 UTF-8 编码，请转换后打开".into()))?;
    Ok(Some(text.trim_start_matches('\u{feff}').to_owned()))
}

#[tauri::command]
pub async fn sql_file_read(path: String) -> AppResult<Option<String>> {
    tauri::async_runtime::spawn_blocking(move || read(Path::new(&path))).await.map_err(|e| AppError::Internal(e.to_string()))?
}

fn write(path: &Path, text: &str, expected: Option<&str>) -> AppResult<()> {
    check_path(path)?;
    if text.len() as u64 > LIMIT { return Err(AppError::InvalidInput("SQL 文件超过 2 MB".into())); }
    if read(path)?.as_deref() != expected { return Err(AppError::Message("文件已被外部修改或删除，请另存为新文件，避免覆盖外部修改".into())); }
    let parent = path.parent().ok_or_else(|| AppError::InvalidInput("文件路径无效".into()))?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(|e| AppError::Message(e.to_string()))?;
    temporary.write_all(text.as_bytes()).and_then(|_| temporary.as_file().sync_all()).map_err(|e| AppError::Message(format!("保存失败，原文件未修改：{e}")))?;
    // 同目录临时文件完成后才替换，避免写入失败留下半个 SQL 文件。
    temporary.persist(path).map_err(|e| AppError::Message(format!("替换文件失败：{e}")))?;
    Ok(())
}

#[tauri::command]
pub async fn sql_file_write(path: String, text: String, expected: Option<String>) -> AppResult<()> {
    tauri::async_runtime::spawn_blocking(move || write(Path::new(&path), &text, expected.as_deref())).await.map_err(|e| AppError::Internal(e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn roundtrip_and_conflict() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("中文.sql");
        write(&path,"SELECT '中文';",None).unwrap();
        assert_eq!(read(&path).unwrap().as_deref(),Some("SELECT '中文';"));
        assert!(write(&path,"overwrite",None).is_err());
        assert!(write(&path,"overwrite",Some("stale")).is_err());
        assert_eq!(read(&path).unwrap().as_deref(),Some("SELECT '中文';"));
        write(&path,"",Some("SELECT '中文';")).unwrap();
        assert_eq!(read(&path).unwrap().as_deref(),Some(""));
        assert!(write(&dir.path().join("bad.txt"),"",None).is_err());
        assert!(write(&dir.path().join("large.sql"),&"x".repeat(LIMIT as usize+1),None).is_err());
    }
}
