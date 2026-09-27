use crate::{
    error::{AppError, AppResult},
    state::AppState,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlExportRequest {
    pub session_id: String,
    pub database: String,
    pub tables: Vec<String>,
    pub all_tables: bool,
    pub mode: String,
    pub path: String,
    pub split_files: bool,
    pub include_database: bool,
    pub drop_tables: bool,
    pub consistent_snapshot: bool,
    pub batch_rows: usize,
    pub batch_bytes: usize,
    #[serde(default)]
    pub filters: HashMap<String, super::sync::SourceFilter>,
    #[serde(default)]
    pub object_kinds: Vec<super::mysql_objects::Kind>,
    #[serde(default)]
    pub target_database: String,
    #[serde(default)]
    pub omit_definer: bool,
    #[serde(default)]
    pub compressed: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlExportResult {
    pub path: String,
    pub rows: u64,
    pub bytes: u64,
    pub tables: usize,
    pub objects: usize,
}
impl SqlExportRequest {
    pub fn validate(&self) -> AppResult<()> {
        if self.database.is_empty()
            || self.path.is_empty()
            || (!self.all_tables && self.tables.is_empty() && self.object_kinds.is_empty())
        {
            return Err(AppError::InvalidInput(
                "请选择数据库、数据表和输出路径".into(),
            ));
        }
        if !["structure", "data", "both"].contains(&self.mode.as_str())
            || !(1..=10000).contains(&self.batch_rows)
            || !(1024..=16 * 1024 * 1024).contains(&self.batch_bytes)
        {
            return Err(AppError::InvalidInput(
                "导出模式或 INSERT 批次大小无效".into(),
            ));
        }
        if self.mode == "data" && self.drop_tables {
            return Err(AppError::InvalidInput(
                "仅数据导出不能包含 DROP TABLE".into(),
            ));
        }
        Ok(())
    }
}
pub async fn export(state: &AppState, request: &SqlExportRequest) -> AppResult<SqlExportResult> {
    request.validate()?;
    if request.compressed {
        use std::io::{Read, Write};
        let destination = std::path::Path::new(&request.path);
        let parent = destination
            .parent()
            .filter(|p| p.is_dir())
            .ok_or_else(|| AppError::InvalidInput("输出目录不存在".into()))?;
        let staging = tempfile::tempdir_in(parent)?;
        let mut nested = request.clone();
        nested.compressed = false;
        nested.path = if request.split_files {
            staging.path().to_path_buf()
        } else {
            staging.path().join("export.sql")
        }
        .to_string_lossy()
        .into_owned();
        let mut result = export_inner(state, &nested).await?;
        let source = std::path::Path::new(&result.path);
        let paths = if source.is_dir() {
            std::fs::read_dir(source)?
                .map(|e| e.map(|e| e.path()))
                .collect::<Result<Vec<_>, _>>()?
        } else {
            vec![source.to_path_buf()]
        };
        let output = tempfile::NamedTempFile::new_in(parent)?;
        let mut zip = zip::ZipWriter::new(output.reopen()?);
        for path in paths {
            zip.start_file(
                path.file_name().unwrap().to_string_lossy(),
                zip::write::SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Deflated),
            )
            .map_err(|e| AppError::Internal(e.to_string()))?;
            let mut input = std::fs::File::open(path)?;
            let mut buffer = vec![0u8; 65536];
            loop {
                crate::tasks::checkpoint()?;
                let n = input.read(&mut buffer)?;
                if n == 0 {
                    break;
                }
                zip.write_all(&buffer[..n])?;
                tokio::task::yield_now().await;
            }
        }
        zip.finish()
            .map_err(|e| AppError::Internal(e.to_string()))?
            .sync_all()?;
        result.bytes = output.as_file().metadata()?.len();
        crate::tasks::checkpoint()?;
        output
            .persist(destination)
            .map_err(|e| AppError::Internal(e.to_string()))?;
        result.path = request.path.clone();
        return Ok(result);
    }
    export_inner(state, request).await
}
async fn export_inner(state: &AppState, request: &SqlExportRequest) -> AppResult<SqlExportResult> {
    let connection = state.connected(&request.session_id).await?;
    {
        let work = connection.adapter.export_sql(request);
        tokio::pin!(work);
        loop {
            tokio::select! {result=&mut work=>break result,_=tokio::time::sleep(std::time::Duration::from_millis(150))=>{crate::tasks::checkpoint()?;}}
        }
    }
}
