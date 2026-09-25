use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{BufWriter, Write};

use crate::adapters::QueryContext;
use crate::error::{AppError, AppResult};
use crate::meta::value::DbValue;
use crate::services::query::{self, SortSpec};
use crate::state::AppState;

const BATCH_SIZE: u32 = 5000;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    pub session_id: String,
    pub database: String,
    pub sql: String,
    pub sort: Vec<SortSpec>,
    pub offset: Option<u64>,
    pub limit: Option<u32>,
    pub format: String,
    pub file_path: String,
    pub include_header: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub rows: u64,
    pub path: String,
}

fn text_of(value: &DbValue) -> String {
    match value {
        DbValue::Null => String::new(),
        DbValue::Bool(v) => {
            if *v {
                "true".into()
            } else {
                "false".into()
            }
        }
        DbValue::Int(v) => v.to_string(),
        DbValue::UInt(v) => v.to_string(),
        DbValue::Float(v) => v.to_string(),
        DbValue::Decimal(v)
        | DbValue::Text(v)
        | DbValue::Date(v)
        | DbValue::Time(v)
        | DbValue::DateTime(v)
        | DbValue::Json(v)
        | DbValue::Uuid(v)
        | DbValue::Truncated(v) | DbValue::ReadOnly(v) => v.clone(),
        DbValue::Bytes(bytes) => {
            let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
            format!("0x{hex}")
        }
    }
}

fn json_of(value: &DbValue) -> serde_json::Value {
    match value {
        DbValue::Null => serde_json::Value::Null,
        DbValue::Bool(v) => serde_json::Value::Bool(*v),
        DbValue::Int(v) => serde_json::json!(v),
        DbValue::UInt(v) => serde_json::json!(v),
        DbValue::Float(v) => {
            if v.is_finite() {
                serde_json::json!(v)
            } else {
                serde_json::Value::Null
            }
        }
        DbValue::Bytes(bytes) => {
            let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
            serde_json::Value::String(format!("0x{hex}"))
        }
        other => serde_json::Value::String(text_of(other)),
    }
}

enum Sink {
    Csv {
        writer: csv::Writer<BufWriter<File>>,
        header_written: bool,
        include_header: bool,
    },
    Json {
        writer: BufWriter<File>,
        first: bool,
    },
    Xlsx {
        headers: Vec<String>,
        rows: Vec<Vec<XlsxCell>>,
    },
}

enum XlsxCell {
    Number(f64),
    Text(String),
    Bool(bool),
}

impl Sink {
    fn new(format: &str, path: &str, include_header: bool) -> AppResult<Self> {
        match format {
            "csv" => {
                let file = File::create(path)?;
                Ok(Sink::Csv {
                    writer: csv::Writer::from_writer(BufWriter::new(file)),
                    header_written: false,
                    include_header,
                })
            }
            "json" => {
                let file = File::create(path)?;
                let mut writer = BufWriter::new(file);
                writer.write_all(b"[\n")?;
                Ok(Sink::Json { writer, first: true })
            }
            "xlsx" => Ok(Sink::Xlsx {
                headers: Vec::new(),
                rows: Vec::new(),
            }),
            other => Err(AppError::InvalidInput(format!("不支持的导出格式: {other}"))),
        }
    }

    fn write_batch(
        &mut self,
        columns: &[String],
        rows: &[Vec<DbValue>],
        path: &str,
    ) -> AppResult<()> {
        match self {
            Sink::Csv {
                writer,
                header_written,
                include_header,
            } => {
                if !*header_written {
                    if *include_header {
                        writer.write_record(columns).map_err(csv_err)?;
                    }
                    *header_written = true;
                }
                for row in rows {
                    let record: Vec<String> = row.iter().map(text_of).collect();
                    writer.write_record(record).map_err(csv_err)?;
                }
            }
            Sink::Json { writer, first } => {
                for row in rows {
                    let mut object = serde_json::Map::new();
                    for (index, value) in row.iter().enumerate() {
                        let key = columns
                            .get(index)
                            .cloned()
                            .unwrap_or_else(|| format!("col_{}", index + 1));
                        object.insert(key, json_of(value));
                    }
                    let text = serde_json::Value::Object(object).to_string();
                    if *first {
                        *first = false;
                    } else {
                        writer.write_all(b",\n")?;
                    }
                    writer.write_all(text.as_bytes())?;
                }
            }
            Sink::Xlsx { headers, rows: data } => {
                if headers.is_empty() {
                    *headers = columns.to_vec();
                }
                for row in rows {
                    let cells: Vec<XlsxCell> = row
                        .iter()
                        .map(|value| match value {
                            DbValue::Int(v) => XlsxCell::Number(*v as f64),
                            DbValue::UInt(v) => XlsxCell::Number(*v as f64),
                            DbValue::Float(v) if v.is_finite() => XlsxCell::Number(*v),
                            DbValue::Bool(v) => XlsxCell::Bool(*v),
                            other => XlsxCell::Text(text_of(other)),
                        })
                        .collect();
                    data.push(cells);
                }
            }
        }
        let _ = path;
        Ok(())
    }

    fn finish(self, path: &str) -> AppResult<()> {
        match self {
            Sink::Csv { mut writer, .. } => {
                writer.flush()?;
                Ok(())
            }
            Sink::Json { mut writer, .. } => {
                writer.write_all(b"\n]\n")?;
                writer.flush()?;
                Ok(())
            }
            Sink::Xlsx { headers, rows } => {
                let mut workbook = rust_xlsxwriter::Workbook::new();
                let sheet = workbook.add_worksheet();
                for (col, name) in headers.iter().enumerate() {
                    sheet
                        .write_string(0, col as u16, name)
                        .map_err(xlsx_err)?;
                }
                for (row_index, row) in rows.iter().enumerate() {
                    for (col, cell) in row.iter().enumerate() {
                        let row_number = row_index as u32 + 1;
                        let col_number = col as u16;
                        match cell {
                            XlsxCell::Number(value) => {
                                sheet
                                    .write_number(row_number, col_number, *value)
                                    .map_err(xlsx_err)?;
                            }
                            XlsxCell::Bool(value) => {
                                sheet
                                    .write_boolean(row_number, col_number, *value)
                                    .map_err(xlsx_err)?;
                            }
                            XlsxCell::Text(value) => {
                                sheet
                                    .write_string(row_number, col_number, value)
                                    .map_err(xlsx_err)?;
                            }
                        }
                    }
                }
                workbook.save(path).map_err(xlsx_err)?;
                Ok(())
            }
        }
    }
}

fn csv_err(error: csv::Error) -> AppError {
    AppError::Internal(format!("CSV 写入失败: {error}"))
}

fn xlsx_err(error: rust_xlsxwriter::XlsxError) -> AppError {
    AppError::Internal(format!("Excel 写入失败: {error}"))
}

#[cfg(test)]
mod export_file_tests {
    use super::*;
    #[test]
    fn interrupted_export_preserves_destination_and_removes_temporary_file() {
        let dir = tempfile::tempdir().unwrap();
        let destination = dir.path().join("result.json");
        std::fs::write(&destination, "original").unwrap();
        let temporary_path;
        {
            let temporary = tempfile::NamedTempFile::new_in(dir.path()).unwrap();
            temporary_path = temporary.path().to_path_buf();
            let mut sink = Sink::new("json", temporary.path().to_str().unwrap(), true).unwrap();
            sink.write_batch(&["id".into()], &[vec![DbValue::Int(1)]], "").unwrap();
            // 取消/失败时先丢弃输出流，再删除临时文件。
            drop(sink);
        }
        assert_eq!(std::fs::read_to_string(&destination).unwrap(), "original");
        assert!(!temporary_path.exists());
        let temporary = tempfile::NamedTempFile::new_in(dir.path()).unwrap();
        let path = temporary.path().to_str().unwrap();
        let mut sink = Sink::new("json", path, true).unwrap();
        sink.write_batch(&["id".into()], &[vec![DbValue::Int(2)]], "").unwrap();
        sink.finish(path).unwrap();
        temporary.persist(&destination).unwrap();
        let value: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(destination).unwrap()).unwrap();
        assert_eq!(value[0]["id"], 2);
    }
}

pub async fn export(state: &AppState, req: &ExportRequest) -> AppResult<ExportResult> {
    let connected = state.connected(&req.session_id).await?;
    let adapter = connected.adapter.clone();
    let include_header = req.include_header.unwrap_or(true);
    let destination = std::path::Path::new(&req.file_path);
    let temporary = tempfile::NamedTempFile::new_in(destination.parent().unwrap_or(std::path::Path::new(".")))?;
    let temporary_path = temporary.path().to_string_lossy().into_owned();
    let mut sink = Sink::new(&req.format, &temporary_path, include_header)?;
    crate::tasks::progress(0, req.limit.map(u64::from), "正在读取数据；完成后替换目标文件");

    let mut offset = req.offset.unwrap_or(0);
    let mut written: u64 = 0;
    let mut columns_written: Vec<String> = Vec::new();

    loop {
        crate::tasks::checkpoint()?;
        let take = match req.limit {
            Some(limit) => {
                let remaining = limit.saturating_sub(written as u32);
                if remaining == 0 {
                    break;
                }
                remaining.min(BATCH_SIZE)
            }
            None => BATCH_SIZE,
        };

        let wrapped =
            query::wrap_pagination(adapter.as_ref(), &req.sql, offset, take, &req.sort);
        let ctx = QueryContext::new();
        let outcome = crate::tasks::query(adapter.as_ref(), &ctx, adapter.query_page(&req.database, &wrapped, offset, take, &ctx)).await?;

        if outcome.columns.is_empty() && outcome.rows.is_empty() {
            break;
        }
        if columns_written.is_empty() {
            columns_written = outcome.columns.iter().map(|c| c.name.clone()).collect();
        }

        let count = outcome.rows.len() as u32;
        crate::tasks::checkpoint()?;
        sink.write_batch(&columns_written, &outcome.rows, &temporary_path)?;
        written += outcome.rows.len() as u64;
        crate::tasks::progress(written, req.limit.map(u64::from), format!("已读取 {written} 行，正在生成文件"));

        if count < take {
            break;
        }
        offset += take as u64;
    }

    sink.finish(&temporary_path)?;
    crate::tasks::checkpoint()?;
    temporary.persist(destination).map_err(|e| AppError::Internal(format!("保存导出文件失败：{}", e.error)))?;
    crate::tasks::progress(written, Some(written), "导出完成，文件已保存");
    tracing::info!(
        format = %req.format,
        rows = written,
        path = %req.file_path,
        "导出完成"
    );
    Ok(ExportResult {
        rows: written,
        path: req.file_path.clone(),
    })
}

/* ---------------- 导入 ---------------- */

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOptions {
    pub delimiter: Option<String>,
    pub encoding: Option<String>, // utf-8 | gbk
    pub has_header: Option<bool>,
    pub empty_as_null: Option<bool>,
    pub batch_size: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub total_rows: u64,
}

fn read_text(path: &str, encoding: &str) -> AppResult<String> {
    let bytes = std::fs::read(path)?;
    if encoding.eq_ignore_ascii_case("gbk") {
        let (text, _, _) = encoding_rs::GBK.decode(&bytes);
        return Ok(text.into_owned());
    }
    // UTF-8（含 BOM）
    let bytes = bytes
        .strip_prefix(&[0xEF, 0xBB, 0xBF])
        .map(|rest| rest.to_vec())
        .unwrap_or(bytes);
    String::from_utf8(bytes).map_err(|error| AppError::InvalidInput(format!("文件不是有效的 UTF-8: {error}")))
}

fn delimiter_byte(delimiter: Option<&String>) -> u8 {
    match delimiter.map(|d| d.as_str()) {
        Some(";") => b';',
        Some("|") => b'|',
        Some("\t") => b'\t',
        Some(",") | None => b',',
        Some("tab") => b'\t',
        _ => b',',
    }
}

pub fn preview(path: &str, options: &ImportOptions) -> AppResult<ImportPreview> {
    let text = read_text(path, options.encoding.as_deref().unwrap_or("utf-8"))?;
    let delimiter = delimiter_byte(options.delimiter.as_ref());
    let has_header = options.has_header.unwrap_or(true);
    let mut reader = csv::ReaderBuilder::new()
        .delimiter(delimiter)
        .has_headers(false)
        .flexible(true)
        .from_reader(text.as_bytes());

    let mut columns: Vec<String> = Vec::new();
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut total: u64 = 0;
    for (index, record) in reader.records().enumerate() {
        let record = record.map_err(|error| {
            AppError::InvalidInput(format!("CSV 解析失败（第 {} 行）: {error}", index + 1))
        })?;
        let values: Vec<String> = record.iter().map(str::to_string).collect();
        if index == 0 && has_header {
            columns = values;
            continue;
        }
        total += 1;
        if rows.len() < 200 {
            if columns.is_empty() {
                columns = (1..=values.len()).map(|i| format!("col_{i}")).collect();
            }
            rows.push(values);
        }
    }

    Ok(ImportPreview {
        columns,
        rows,
        total_rows: total,
    })
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRequest {
    pub session_id: String,
    pub database: String,
    pub schema: Option<String>,
    pub table: String,
    pub file_path: String,
    pub options: ImportOptions,
    /// 文件列索引 → 目标列名（None 表示忽略该列）
    pub mapping: Vec<Option<String>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub inserted: u64,
    pub skipped: u64,
    pub error: Option<String>,
}

pub async fn import_csv(state: &AppState, req: &ImportRequest) -> AppResult<ImportResult> {
    crate::tasks::progress(0, None, "正在读取 CSV；取消在批次之间生效，已提交数据保留");
    let record = state.local.get_session(&req.session_id).await?;
    if record.read_only {
        return Err(AppError::ReadOnly(
            "当前会话为只读模式，已阻止导入数据".into(),
        ));
    }

    let connected = state.connected(&req.session_id).await?;
    let meta = connected
        .adapter
        .introspect_table(&req.database, req.schema.as_deref(), &req.table)
        .await?;
    let column_types: std::collections::HashMap<String, String> = meta
        .columns
        .iter()
        .map(|column| (column.name.clone(), column.raw_type.clone()))
        .collect();

    let text = read_text(&req.file_path, req.options.encoding.as_deref().unwrap_or("utf-8"))?;
    let delimiter = delimiter_byte(req.options.delimiter.as_ref());
    let has_header = req.options.has_header.unwrap_or(true);
    let empty_as_null = req.options.empty_as_null.unwrap_or(true);
    let batch_size = req.options.batch_size.unwrap_or(500).clamp(50, 5000);

    let mut reader = csv::ReaderBuilder::new()
        .delimiter(delimiter)
        .has_headers(false)
        .flexible(true)
        .from_reader(text.as_bytes());

    let mut inserted: u64 = 0;
    let mut skipped: u64 = 0;
    let mut first_error: Option<String> = None;
    let mut pending: Vec<crate::adapters::SqlParams> = Vec::new();

    for (index, record) in reader.records().enumerate() {
        crate::tasks::checkpoint()?;
        if index == 0 && has_header {
            continue;
        }
        let record = match record {
            Ok(record) => record,
            Err(error) => {
                skipped += 1;
                if first_error.is_none() {
                    first_error = Some(format!("第 {} 行解析失败: {error}", index + 1));
                }
                continue;
            }
        };

        let mut values = Vec::new();
        for (file_index, target) in req.mapping.iter().enumerate() {
            let Some(column) = target else { continue };
            let raw = record.get(file_index).unwrap_or("");
            let value = if raw.is_empty() && empty_as_null {
                DbValue::Null
            } else {
                DbValue::Text(raw.to_string())
            };
            values.push(crate::adapters::CellValue {
                column: column.clone(),
                value,
            });
        }
        if values.is_empty() {
            skipped += 1;
            continue;
        }

        match crate::adapters::build_change_statements(
            connected.adapter.as_ref(),
            &req.database,
            req.schema.as_deref(),
            &req.table,
            &[crate::adapters::RowChange::Insert { values }],
            &column_types,
        ) {
            Ok(mut statements) => pending.append(&mut statements),
            Err(error) => {
                skipped += 1;
                if first_error.is_none() {
                    first_error = Some(error.to_string());
                }
            }
        }

        if pending.len() >= batch_size {
            match connected
                .adapter
                .execute_transaction(&req.database, &pending)
                .await
            {
                Ok(affected) => { inserted += affected; crate::tasks::progress(inserted, None, format!("已提交 {inserted} 行，跳过 {skipped} 行；已提交批次保留")); },
                Err(error) => {
                    if first_error.is_none() {
                        first_error = Some(error.to_string());
                    }
                    return Ok(ImportResult {
                        inserted,
                        skipped,
                        error: first_error,
                    });
                }
            }
            pending.clear();
        }
    }

    crate::tasks::checkpoint()?;
    if !pending.is_empty() {
        match connected
            .adapter
            .execute_transaction(&req.database, &pending)
            .await
        {
            Ok(affected) => { inserted += affected; crate::tasks::progress(inserted, None, format!("已提交 {inserted} 行，跳过 {skipped} 行；已提交批次保留")); },
            Err(error) => {
                if first_error.is_none() {
                    first_error = Some(error.to_string());
                }
            }
        }
    }

    tracing::info!(table = %req.table, inserted, skipped, "CSV 导入完成");
    Ok(ImportResult {
        inserted,
        skipped,
        error: first_error,
    })
}
