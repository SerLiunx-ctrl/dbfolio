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
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlExportResult {
    pub path: String,
    pub rows: u64,
    pub bytes: u64,
    pub tables: usize,
}
impl SqlExportRequest {
    pub fn validate(&self) -> AppResult<()> {
        if self.database.is_empty()
            || self.path.is_empty()
            || (!self.all_tables && self.tables.is_empty())
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
    let connection = state.connected(&request.session_id).await?;
    {
        let work = connection.adapter.export_sql(request);
        tokio::pin!(work);
        loop {
            tokio::select! {result=&mut work=>break result,_=tokio::time::sleep(std::time::Duration::from_millis(150))=>{crate::tasks::checkpoint()?;}}
        }
    }
}
