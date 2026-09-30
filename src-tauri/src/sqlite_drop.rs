//! Read-only identification for files dropped into the session editor.
use crate::error::{AppError, AppResult};
use serde::Serialize;
use std::{fs::File, io::Read, path::Path};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqliteFileDraft {
    pub path: String,
    pub name: String,
}

fn inspect(path: &Path) -> AppResult<SqliteFileDraft> {
    if !path.is_absolute() {
        return Err(AppError::InvalidInput(
            "请拖入本地 SQLite 数据库文件".into(),
        ));
    }
    let mut file =
        File::open(path).map_err(|e| AppError::InvalidInput(format!("无法读取数据库文件：{e}")))?;
    if !file.metadata()?.is_file() {
        return Err(AppError::InvalidInput("请拖入文件，不能拖入文件夹".into()));
    }
    let mut header = [0u8; 100];
    if file.read_exact(&mut header).is_err() || &header[..16] != b"SQLite format 3\0" {
        return Err(AppError::InvalidInput(
            "未识别为 SQLite 数据库；空文件、加密数据库及 WAL/SHM 辅助文件请勿拖入".into(),
        ));
    }
    let page_size = u16::from_be_bytes([header[16], header[17]]);
    if !(page_size == 1 || (page_size >= 512 && page_size.is_power_of_two())) {
        return Err(AppError::InvalidInput("SQLite 文件头无效".into()));
    }
    let canonical = std::fs::canonicalize(path)?;
    let path_string = canonical.to_string_lossy();
    // Windows canonical paths use the extended-length prefix; retain UNC semantics.
    let normalized = if let Some(unc) = path_string.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else {
        path_string
            .strip_prefix(r"\\?\")
            .unwrap_or(&path_string)
            .to_owned()
    };
    let extension = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let name = if ["db", "sqlite", "sqlite3", "db3", "s3db"].contains(&extension.as_str()) {
        path.file_stem()
    } else {
        path.file_name()
    }
    .and_then(|s| s.to_str())
    .unwrap_or("SQLite")
    .to_owned();
    Ok(SqliteFileDraft {
        path: normalized,
        name,
    })
}

#[tauri::command]
pub async fn sqlite_file_inspect(path: String) -> AppResult<SqliteFileDraft> {
    tauri::async_runtime::spawn_blocking(move || inspect(Path::new(&path)))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn sqlite_drop_identifies_existing_database_without_writes() {
        use sqlx::{Connection, Executor};
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("中文 空格.SQLITE3");
        let mut db = sqlx::SqliteConnection::connect_with(
            &sqlx::sqlite::SqliteConnectOptions::new()
                .filename(&path)
                .create_if_missing(true),
        )
        .await
        .unwrap();
        db.execute("CREATE TABLE example(id INTEGER PRIMARY KEY, name TEXT)")
            .await
            .unwrap();
        db.close().await.unwrap();
        let before = std::fs::read(&path).unwrap();
        let result = inspect(&path).unwrap();
        assert_eq!(result.name, "中文 空格");
        assert!(Path::new(&result.path).is_absolute());
        assert_eq!(before, std::fs::read(&path).unwrap());
        let no_extension = dir.path().join("database");
        std::fs::copy(&path, &no_extension).unwrap();
        assert_eq!(inspect(&no_extension).unwrap().name, "database");
        for (name, content) in [
            ("empty.db", vec![]),
            ("fake.sqlite", b"not a database".to_vec()),
            ("db-wal", vec![0; 100]),
        ] {
            let p = dir.path().join(name);
            std::fs::write(&p, content).unwrap();
            assert!(inspect(&p).is_err());
        }
        assert!(inspect(dir.path()).is_err());
        assert!(inspect(&dir.path().join("missing.db")).is_err());
        assert!(!dir.path().join("missing.db").exists());
        assert!(inspect(Path::new("relative.db")).is_err());
    }
}
