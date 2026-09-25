#[path = "sync_schema.rs"]
mod schema;
pub use schema::{SchemaPlan, Registry as SchemaRegistry};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::adapters::{render_literal, RowChange, CellChange, CellValue, DbAdapter, SqlParams};
use crate::error::{AppError, AppResult};
use crate::meta::value::DbValue;
use crate::meta::{ColumnMeta, Engine, TableMeta};
use crate::state::AppState;

/* ---------------- 通用模型 ---------------- */

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Endpoint {
    pub session_id: String,
    pub database: String,
}

pub struct AdapterPair {
    pub source: std::sync::Arc<dyn DbAdapter>,
    pub target: std::sync::Arc<dyn DbAdapter>,
    pub engine: Engine,
}

pub async fn connect_pair(
    state: &AppState,
    source: &Endpoint,
    target: &Endpoint,
) -> AppResult<AdapterPair> {
    let source_conn = state.connected(&source.session_id).await?;
    let target_conn = state.connected(&target.session_id).await?;
    if !source_conn.adapter.engine().is_sql() || !target_conn.adapter.engine().is_sql() {
        return Err(AppError::InvalidInput(
            "同步仅支持 SQL 引擎（MySQL / PostgreSQL / SQLite）".into(),
        ));
    }
    if source_conn.adapter.engine() != target_conn.adapter.engine() {
        return Err(AppError::InvalidInput(
            "首版仅支持同引擎同步（源与目标的数据库类型必须一致）".into(),
        ));
    }
    if source.session_id == target.session_id && source.database == target.database {
        return Err(AppError::InvalidInput("源与目标不能是同一个数据库".into()));
    }
    Ok(AdapterPair {
        engine: source_conn.adapter.engine(),
        source: source_conn.adapter.clone(),
        target: target_conn.adapter.clone(),
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnDiff {
    pub name: String,
    pub status: String,
    pub source_type: Option<String>,
    pub target_type: Option<String>,
    pub details: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexDiff {
    pub name: String,
    pub status: String,
    pub definition: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableSchemaDiff {
    pub table: String,
    pub schema: Option<String>,
    pub status: String,
    pub kind: Option<String>,
    pub comment: Option<String>,
    pub details: Vec<String>,
    pub columns: Vec<ColumnDiff>,
    pub indexes: Vec<IndexDiff>,
    pub foreign_keys: Vec<IndexDiff>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SchemaSummary {
    pub create_tables: usize,
    pub drop_tables: usize,
    pub alter_tables: usize,
    pub same_tables: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaCompareResult {
    pub tables: Vec<TableSchemaDiff>,
    pub summary: SchemaSummary,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatement {
    pub table: String,
    pub kind: String,
    pub description: String,
    pub sql: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaExecuteResult {
    pub executed: usize,
    pub failed: usize,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaSyncOptions {
    #[serde(default)]
    pub excluded_changes: Vec<String>,
    #[serde(default)]
    pub sync_primary_key: bool,
    #[serde(default)]
    pub sync_table_options: bool,
    #[serde(default)]
    pub drop_extra_indexes: bool,
    #[serde(default)]
    pub drop_extra_foreign_keys: bool,
    pub create_missing_tables: bool,
    pub drop_missing_tables: bool,
    pub add_missing_columns: bool,
    pub alter_changed_columns: bool,
    pub drop_extra_columns: bool,
    pub create_indexes: bool,
    pub create_foreign_keys: bool,
}

impl Default for SchemaSyncOptions {
    fn default() -> Self {
        Self {
            excluded_changes: Vec::new(),
            sync_primary_key: false,
            sync_table_options: false,
            drop_extra_indexes: false,
            drop_extra_foreign_keys: false,
            create_missing_tables: true,
            drop_missing_tables: false,
            add_missing_columns: true,
            alter_changed_columns: true,
            drop_extra_columns: false,
            create_indexes: true,
            create_foreign_keys: true,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaSyncRequest {
    pub source: Endpoint,
    pub target: Endpoint,
    pub tables: Vec<String>,
    #[serde(default)]
    pub options: SchemaSyncOptions,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldDiff { pub column: String, pub before: Option<String>, pub after: Option<String> }
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RowDiff { pub kind: String, pub key: String, pub fields: Vec<FieldDiff> }
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableDataDiff {
    pub samples: Vec<RowDiff>,
    pub table: String,
    pub key_columns: Vec<String>,
    pub source_rows: u64,
    pub target_rows: u64,
    pub inserts: u64,
    pub updates: u64,
    pub deletes: u64,
    pub skipped: bool,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataSyncOptions {
    pub insert_missing: bool,
    pub update_changed: bool,
    pub delete_extra: bool,
    pub batch_size: Option<usize>,
    pub continue_on_error: bool,
}

impl Default for DataSyncOptions {
    fn default() -> Self {
        Self {
            insert_missing: true,
            update_changed: true,
            delete_extra: false,
            batch_size: Some(500),
            continue_on_error: false,
        }
    }
}

#[derive(Default, Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceFilter {
 #[serde(default)] pub conditions: Vec<super::query::FilterCondition>,
 #[serde(default)] pub conjunction: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataSyncRequest {
    #[serde(default)]
    pub filters: HashMap<String, SourceFilter>,
    pub source: Endpoint,
    pub target: Endpoint,
    pub tables: Vec<String>,
    #[serde(default)]
    pub options: DataSyncOptions,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableSyncResult {
    pub table: String,
    pub inserts: u64,
    pub updates: u64,
    pub deletes: u64,
    pub failed: u64,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataExecuteResult {
    pub backup_directory: String,
    pub tables: Vec<TableSyncResult>,
}

/* ---------------- 结构对比 ---------------- */

fn normalized_type(raw: &str) -> String {
    raw.trim().to_ascii_lowercase()
}

fn column_details(source: &ColumnMeta, target: &ColumnMeta) -> Vec<String> {
    let mut details = Vec::new();
    if normalized_type(&source.raw_type) != normalized_type(&target.raw_type) {
        details.push("类型不同".into());
    }
    if source.nullable != target.nullable {
        details.push(if source.nullable {
            "源允许 NULL".into()
        } else {
            "源不允许 NULL".into()
        });
    }
    let source_default = source.default_value.clone().unwrap_or_default();
    let target_default = target.default_value.clone().unwrap_or_default();
    if !source.auto_increment
        && !target.auto_increment
        && source_default.trim() != target_default.trim()
    {
        details.push("默认值不同".into());
    }
    if (source.auto_increment) != (target.auto_increment) {
        details.push("自增属性不同".into());
    }
    if source.charset != target.charset { details.push("字符集不同".into()); }
    if source.collation != target.collation { details.push("排序规则不同".into()); }
    if source.comment.as_deref().unwrap_or("") != target.comment.as_deref().unwrap_or("") {
        details.push("注释不同".into());
    }
    details
}

fn diff_columns(source: &TableMeta, target: &TableMeta) -> Vec<ColumnDiff> {
    let mut diffs = Vec::new();
    for column in &source.columns {
        match target.columns.iter().find(|item| item.name == column.name) {
            None => diffs.push(ColumnDiff {
                name: column.name.clone(),
                status: "onlySource".into(),
                source_type: Some(column.raw_type.clone()),
                target_type: None,
                details: vec!["目标缺少该列".into()],
            }),
            Some(target_column) => {
                let details = column_details(column, target_column);
                diffs.push(ColumnDiff {
                    name: column.name.clone(),
                    status: if details.is_empty() {
                        "same".into()
                    } else {
                        "different".into()
                    },
                    source_type: Some(column.raw_type.clone()),
                    target_type: Some(target_column.raw_type.clone()),
                    details,
                });
            }
        }
    }
    for column in &target.columns {
        if !source.columns.iter().any(|item| item.name == column.name) {
            diffs.push(ColumnDiff {
                name: column.name.clone(),
                status: "onlyTarget".into(),
                source_type: None,
                target_type: Some(column.raw_type.clone()),
                details: vec!["源缺少该列".into()],
            });
        }
    }
    diffs
}

fn index_definition_unique(unique: bool, columns: &[String]) -> String {
    format!(
        "{} ({})",
        if unique { "唯一" } else { "普通" },
        columns.join(", ")
    )
}

fn diff_indexes(source: &TableMeta, target: &TableMeta) -> Vec<IndexDiff> {
    let mut diffs = Vec::new();
    for index in source.indexes.iter().filter(|item| !item.primary) {
        let columns: Vec<String> = index.columns.iter().map(|c| c.name.clone()).collect();
        let definition = index_definition_unique(index.unique, &columns);
        match target.indexes.iter().find(|item| item.name == index.name) {
            None => diffs.push(IndexDiff {
                name: index.name.clone(),
                status: "onlySource".into(),
                definition,
            }),
            Some(target_index) => {
                let target_columns: Vec<String> =
                    target_index.columns.iter().map(|c| c.name.clone()).collect();
                let same = schema::same_index(index, target_index);
                diffs.push(IndexDiff {
                    name: index.name.clone(),
                    status: if same { "same".into() } else { "different".into() },
                    definition: format!(
                        "{} → {}",
                        definition,
                        index_definition_unique(target_index.unique, &target_columns)
                    ),
                });
            }
        }
    }
    for index in target.indexes.iter().filter(|i| !i.primary) {
        if !source.indexes.iter().any(|i| i.name == index.name) {
            diffs.push(IndexDiff { name:index.name.clone(), status:"onlyTarget".into(), definition:index_definition_unique(index.unique,&index.columns.iter().map(|c|c.name.clone()).collect::<Vec<_>>()) });
        }
    }

    diffs
}

fn diff_foreign_keys(source: &TableMeta, target: &TableMeta) -> Vec<IndexDiff> {
    let mut diffs = Vec::new();
    for fk in &source.foreign_keys {
        let definition = format!(
            "({}) → {}({})",
            fk.columns.join(", "),
            fk.ref_table,
            fk.ref_columns.join(", ")
        );
        match target.foreign_keys.iter().find(|item| item.name == fk.name) {
            None => diffs.push(IndexDiff {
                name: fk.name.clone(),
                status: "onlySource".into(),
                definition,
            }),
            Some(target_fk) => diffs.push(IndexDiff {
                name: fk.name.clone(),
                status: if schema::same_fk(fk, target_fk, source.schema.as_deref(), target.schema.as_deref())
                {
                    "same".into()
                } else {
                    "different".into()
                },
                definition,
            }),
        }
    }
    for fk in &target.foreign_keys {
        if !source.foreign_keys.iter().any(|i| i.name == fk.name) { diffs.push(IndexDiff {name:fk.name.clone(),status:"onlyTarget".into(),definition:format!("({}) → {}({})",fk.columns.join(", "),fk.ref_table,fk.ref_columns.join(", "))}); }
    }

    diffs
}

pub async fn compare_schema(
    state: &AppState,
    source: &Endpoint,
    target: &Endpoint,
    tables: &[String],
) -> AppResult<SchemaCompareResult> {
    let pair = connect_pair(state, source, target).await?;
    let mut result = SchemaCompareResult {
        tables: Vec::new(),
        summary: SchemaSummary::default(),
    };

    let mut source_meta_cache: HashMap<String, Option<TableMeta>> = HashMap::new();
    let mut target_meta_cache: HashMap<String, Option<TableMeta>> = HashMap::new();

    for table in tables {
        crate::tasks::checkpoint()?;
        crate::tasks::progress(0, None, format!("正在检查表 {table}"));
        if !source_meta_cache.contains_key(table) {
            let meta = schema::read_table(pair.source.as_ref(), &source.database, table).await?;
            source_meta_cache.insert(table.clone(), meta);
        }
        if !target_meta_cache.contains_key(table) {
            let meta = schema::read_table(pair.target.as_ref(), &target.database, table).await?;
            target_meta_cache.insert(table.clone(), meta);
        }

        let source_meta = source_meta_cache.get(table).cloned().flatten();
        let target_meta = target_meta_cache.get(table).cloned().flatten();

        let diff = match (&source_meta, &target_meta) {
            (Some(src), Some(tgt)) => {
                let mut columns = diff_columns(src, tgt);
                if pair.engine == Engine::Mysql {
                    let a=schema::mysql_columns(src)?;let b=schema::mysql_columns(tgt)?;
                    for c in &mut columns {if let (Some(a),Some(b))=(a.get(&c.name),b.get(&c.name)){if a!=b && c.status=="same" {c.status="different".into();c.details.push("完整字段定义不同（表达式 / 自动更新等）".into());}}}
                }
                let mut table_details=schema::table_details(src,tgt);
                if pair.engine==Engine::Mysql {
                    let a=pair.source.table_extra_info(&source.database,None,table).await?;
                    let b=pair.target.table_extra_info(&target.database,None,table).await?;
                    if a.engine!=b.engine {table_details.push(format!("引擎：目标 {:?} → 源 {:?}",b.engine,a.engine));}
                    if a.charset!=b.charset || a.collation!=b.collation {table_details.push(format!("表字符集 / 排序规则：目标 {:?} / {:?} → 源 {:?} / {:?}",b.charset,b.collation,a.charset,a.collation));}
                }
                let indexes = diff_indexes(src, tgt);
                let foreign_keys = diff_foreign_keys(src, tgt);
                let changed = !table_details.is_empty() || columns.iter().any(|item| item.status != "same")
                    || indexes.iter().any(|item| item.status != "same")
                    || foreign_keys.iter().any(|item| item.status != "same");
                if changed {
                    result.summary.alter_tables += 1;
                } else {
                    result.summary.same_tables += 1;
                }
                TableSchemaDiff {
                    table: table.clone(),
                    schema: src.schema.clone(),
                    status: if changed { "different".into() } else { "same".into() },
                    kind: Some(match src.kind {
                        crate::meta::TableKind::View => "view".into(),
                        _ => "table".into(),
                    }),
                    comment: src.comment.clone(),
                    details: table_details,
                    columns,
                    indexes,
                    foreign_keys,
                }
            }
            (Some(src), None) => {
                result.summary.create_tables += 1;
                TableSchemaDiff {
                    table: table.clone(),
                    schema: src.schema.clone(),
                    status: "onlySource".into(),
                    kind: Some("table".into()),
                    comment: src.comment.clone(),
                    details: Vec::new(),
                    columns: diff_columns(src, src)
                        .into_iter()
                        .map(|mut item| {
                            item.status = "onlySource".into();
                            item
                        })
                        .collect(),
                    indexes: diff_indexes(src, src)
                        .into_iter()
                        .map(|mut item| {
                            item.status = "onlySource".into();
                            item
                        })
                        .collect(),
                    foreign_keys: diff_foreign_keys(src, src)
                        .into_iter()
                        .map(|mut item| {
                            item.status = "onlySource".into();
                            item
                        })
                        .collect(),
                }
            }
            (None, Some(tgt)) => {
                result.summary.drop_tables += 1;
                TableSchemaDiff {
                    table: table.clone(),
                    schema: tgt.schema.clone(),
                    status: "onlyTarget".into(),
                    kind: Some("table".into()),
                    comment: tgt.comment.clone(),
                    details: Vec::new(),
                    columns: Vec::new(),
                    indexes: Vec::new(),
                    foreign_keys: Vec::new(),
                }
            }
            (None, None) => TableSchemaDiff {
                table: table.clone(),
                schema: None,
                status: "missing".into(),
                kind: None,
                comment: None,
                details: Vec::new(),
                columns: Vec::new(),
                indexes: Vec::new(),
                foreign_keys: Vec::new(),
            },
        };
        result.tables.push(diff);
    }

    Ok(result)
}

/* ---------------- 结构脚本生成 ---------------- */

fn quote(adapter: &dyn DbAdapter, name: &str) -> String {
    adapter.quote_ident(name)
}

// MySQL 的 schema 即数据库名：端点数据库必须优先于源表元数据。
// PostgreSQL/SQLite 的 schema 则仍是库内命名空间。
fn endpoint_schema<'a>(engine: Engine, database: &'a str, schema: Option<&'a str>) -> Option<&'a str> {
    if engine == Engine::Mysql { Some(database).filter(|v| !v.is_empty()) }
    else { schema.filter(|v| !v.is_empty()) }
}

fn table_ref(adapter: &dyn DbAdapter, database: &str, schema: Option<&str>, table: &str) -> String {
    match endpoint_schema(adapter.engine(), database, schema) {
        Some(namespace) => format!("{}.{}", quote(adapter, namespace), quote(adapter, table)),
        None => quote(adapter, table),
    }
}

fn render_default(engine: Engine, value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let upper = trimmed.to_ascii_uppercase();
    let keyword = matches!(
        upper.as_str(),
        "NULL" | "TRUE" | "FALSE" | "CURRENT_TIMESTAMP" | "CURRENT_DATE" | "CURRENT_TIME"
    ) || upper.starts_with("NOW(")
        || upper.starts_with("CURRENT_TIMESTAMP(")
        || upper.contains("::")
        || upper.starts_with("nextval(");
    if keyword || trimmed.parse::<f64>().is_ok() {
        return Some(trimmed.to_string());
    }
    if trimmed.starts_with('\'') || trimmed.starts_with('(') {
        return Some(trimmed.to_string());
    }
    let escaped = match engine {
        Engine::Mysql => trimmed.replace('\\', "\\\\").replace('\'', "''"),
        _ => trimmed.replace('\'', "''"),
    };
    Some(format!("'{escaped}'"))
}

// MySQL 的 BIT 默认值在 COLUMN_DEFAULT 中已经是位字面量，不能再次包成字符串。
fn render_column_default(engine: Engine, raw_type: &str, value: &str) -> Option<String> {
    let kind = raw_type.split('(').next().unwrap_or(raw_type).trim();
    if engine == Engine::Mysql && kind.eq_ignore_ascii_case("bit") {
        let literal = value.trim();
        let bits = literal.strip_prefix("b'").or_else(|| literal.strip_prefix("B'"))
            .and_then(|v| v.strip_suffix("'"))
            .or_else(|| literal.strip_prefix("0b"));
        if let Some(bits) = bits.filter(|v| !v.is_empty() && v.bytes().all(|b| b == b'0' || b == b'1')) {
            return Some(format!("b'{bits}'"));
        }
    }
    render_default(engine, value)
}

fn column_definition(adapter: &dyn DbAdapter, column: &ColumnMeta) -> String {
    let engine = adapter.engine();
    let mut parts = vec![quote(adapter, &column.name), column.raw_type.clone()];
    if engine == Engine::Postgres && column.auto_increment {
        // PG 的自增列（serial/identity）统一用 IDENTITY，避免引用源库序列
        parts.push("GENERATED BY DEFAULT AS IDENTITY".into());
    }
    if engine == Engine::Mysql {
        if let Some(v) = &column.charset { parts.push(format!("CHARACTER SET {}", quote(adapter,v))); }
        if let Some(v) = &column.collation { parts.push(format!("COLLATE {}", quote(adapter,v))); }
    }
    if !column.nullable {
        parts.push("NOT NULL".into());
    }
    if !(engine == Engine::Postgres && column.auto_increment) && !column.auto_increment {
        if let Some(default) = column
            .default_value
            .as_deref()
            .and_then(|value| render_column_default(engine, &column.raw_type, value))
        {
            parts.push(format!("DEFAULT {default}"));
        }
    }
    if engine == Engine::Mysql {
        if column.auto_increment {
            parts.push("AUTO_INCREMENT".into());
        }
        if let Some(comment) = column.comment.as_deref().filter(|c| !c.trim().is_empty()) {
            let escaped = comment.replace('\\', "\\\\").replace('\'', "''");
            parts.push(format!("COMMENT '{escaped}'"));
        }
    }
    parts.join(" ")
}

fn create_table_sql(
    adapter: &dyn DbAdapter,
    database: &str,
    meta: &TableMeta,
    include_foreign_keys: bool,
) -> String {
    let target = table_ref(adapter, database, meta.schema.as_deref(), &meta.name);
    let mut defs: Vec<String> = meta
        .columns
        .iter()
        .map(|column| column_definition(adapter, column))
        .collect();
    if !meta.primary_key.is_empty() {
        let columns: Vec<String> = meta
            .primary_key
            .iter()
            .map(|name| quote(adapter, name))
            .collect();
        defs.push(format!("PRIMARY KEY ({})", columns.join(", ")));
    }
    if include_foreign_keys {
        for fk in &meta.foreign_keys {
            let columns: Vec<String> = fk.columns.iter().map(|c| quote(adapter, c)).collect();
            let ref_columns: Vec<String> =
                fk.ref_columns.iter().map(|c| quote(adapter, c)).collect();
            defs.push(format!(
                "CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {} ({}) ON DELETE {} ON UPDATE {}",
                quote(adapter, &fk.name),
                columns.join(", "),
                quote(adapter, &fk.ref_table),
                ref_columns.join(", "), fk.on_delete, fk.on_update
            ));
        }
    }
    format!("CREATE TABLE {} (\n  {}\n)", target, defs.join(",\n  "))
}

fn create_index_statements(
    adapter: &dyn DbAdapter,
    database: &str,
    meta: &TableMeta,
) -> Vec<SyncStatement> {
    let target = table_ref(adapter, database, meta.schema.as_deref(), &meta.name);
    let mut statements = Vec::new();
    for index in meta.indexes.iter().filter(|item| !item.primary) {
        let columns: Vec<String> = index
            .columns
            .iter()
            .map(|column| {
                let base = quote(adapter, &column.name);
                if column.desc {
                    format!("{base} DESC")
                } else {
                    base
                }
            })
            .collect();
        statements.push(SyncStatement {
            table: meta.name.clone(),
            kind: "createIndex".into(),
            description: format!("创建索引 {}", index.name),
            sql: format!(
                "CREATE {}INDEX {} ON {} ({})",
                if index.unique { "UNIQUE " } else { "" },
                quote(adapter, &index.name),
                target,
                columns.join(", ")
            ),
        });
    }
    statements
}

fn add_foreign_key_statements(
    adapter: &dyn DbAdapter,
    database: &str,
    meta: &TableMeta,
) -> Vec<SyncStatement> {
    let engine = adapter.engine();
    if engine == Engine::Sqlite {
        return Vec::new();
    }
    let target = table_ref(adapter, database, meta.schema.as_deref(), &meta.name);
    meta.foreign_keys
        .iter()
        .map(|fk| {
            let columns: Vec<String> = fk.columns.iter().map(|c| quote(adapter, c)).collect();
            let ref_columns: Vec<String> =
                fk.ref_columns.iter().map(|c| quote(adapter, c)).collect();
            SyncStatement {
                table: meta.name.clone(),
                kind: "addForeignKey".into(),
                description: format!("添加外键 {}", fk.name),
                sql: format!(
                    "ALTER TABLE {} ADD CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {} ({}) ON DELETE {} ON UPDATE {}",
                    target,
                    quote(adapter, &fk.name),
                    columns.join(", "),
                    if engine == Engine::Mysql { table_ref(adapter, database, None, &fk.ref_table) } else { table_ref(adapter,database,fk.ref_schema.as_deref(),&fk.ref_table) },
                    ref_columns.join(", "), fk.on_delete, fk.on_update
                ),
            }
        })
        .collect()
}

async fn build_schema_script(
    pair: &AdapterPair,
    source: &Endpoint,
    target: &Endpoint,
    tables: &[String],
    options: &SchemaSyncOptions,
) -> AppResult<Vec<SyncStatement>> {
    let mut statements: Vec<SyncStatement> = Vec::new();

    for table in tables {
        crate::tasks::checkpoint()?;
        crate::tasks::progress(0, None, format!("正在检查表 {table}"));
        let source_meta = schema::read_table(pair.source.as_ref(), &source.database, table).await?;
        let target_meta = schema::read_table(pair.target.as_ref(), &target.database, table).await?;

        match (source_meta, target_meta) {
            (Some(src), None) => {
                if !options.create_missing_tables {
                    continue;
                }
                let include_fks = pair.engine == Engine::Sqlite && options.create_foreign_keys;
                statements.push(SyncStatement {
                    table: table.clone(),
                    kind: "createTable".into(),
                    description: format!("创建表 {table}"),
                    sql: create_table_sql(pair.target.as_ref(), &target.database, &src, include_fks),
                });
                if options.create_indexes {
                    statements.extend(create_index_statements(
                        pair.target.as_ref(),
                        &target.database,
                        &src,
                    ));
                }
                if options.create_foreign_keys && !include_fks {
                    statements.extend(add_foreign_key_statements(
                        pair.target.as_ref(),
                        &target.database,
                        &src,
                    ));
                }
            }
            (None, Some(_)) => {
                if options.drop_missing_tables {
                    statements.push(SyncStatement {
                        table: table.clone(),
                        kind: "dropTable".into(),
                        description: format!("删除目标多余表 {table}"),
                        sql: format!(
                            "DROP TABLE {}",
                            table_ref(pair.target.as_ref(), &target.database, None, table)
                        ),
                    });
                }
            }
            (Some(src), Some(tgt)) => {
                let target_ref =
                    table_ref(pair.target.as_ref(), &target.database, tgt.schema.as_deref(), table);

                for diff in diff_columns(&src, &tgt) {
                    match diff.status.as_str() {
                        "onlySource" => {
                            if !options.add_missing_columns {
                                continue;
                            }
                            let column = src
                                .columns
                                .iter()
                                .find(|item| item.name == diff.name)
                                .expect("column exists");
                            statements.push(SyncStatement {
                                table: table.clone(),
                                kind: "addColumn".into(),
                                description: format!("添加列 {}", column.name),
                                sql: format!(
                                    "ALTER TABLE {} ADD COLUMN {}",
                                    target_ref,
                                    column_definition(pair.target.as_ref(), column)
                                ),
                            });
                        }
                        "different" => {
                            if !options.alter_changed_columns {
                                continue;
                            }
                            let column = src
                                .columns
                                .iter()
                                .find(|item| item.name == diff.name)
                                .expect("column exists");
                            match pair.engine {
                                Engine::Mysql => statements.push(SyncStatement {
                                    table: table.clone(),
                                    kind: "modifyColumn".into(),
                                    description: format!("修改列 {}", column.name),
                                    sql: format!(
                                        "ALTER TABLE {} MODIFY COLUMN {}",
                                        target_ref,
                                        column_definition(pair.target.as_ref(), column)
                                    ),
                                }),
                                Engine::Postgres => {
                                    let mut parts: Vec<String> = Vec::new();
                                    let target_column = tgt
                                        .columns
                                        .iter()
                                        .find(|item| item.name == column.name);
                                    if normalized_type(&column.raw_type)
                                        != normalized_type(
                                            &diff.target_type.clone().unwrap_or_default(),
                                        )
                                    {
                                        parts.push(format!(
                                            "ALTER TABLE {} ALTER COLUMN {} TYPE {}",
                                            target_ref,
                                            quote(pair.target.as_ref(), &column.name),
                                            column.raw_type
                                        ));
                                    }
                                    if let Some(target_column) = target_column {
                                        if column.nullable != target_column.nullable {
                                            parts.push(format!(
                                                "ALTER TABLE {} ALTER COLUMN {} {}",
                                                target_ref,
                                                quote(pair.target.as_ref(), &column.name),
                                                if column.nullable {
                                                    "DROP NOT NULL"
                                                } else {
                                                    "SET NOT NULL"
                                                }
                                            ));
                                        }
                                        let target_default = target_column
                                            .default_value
                                            .clone()
                                            .unwrap_or_default();
                                        if column.auto_increment {
                                            // 源为自增列：目标若无自增则添加 IDENTITY，避免复制源库序列
                                            if !target_column.auto_increment
                                                && !target_default.contains("nextval(")
                                            {
                                                parts.push(format!(
                                                    "ALTER TABLE {} ALTER COLUMN {} ADD GENERATED BY DEFAULT AS IDENTITY",
                                                    target_ref,
                                                    quote(pair.target.as_ref(), &column.name)
                                                ));
                                            }
                                        } else {
                                            let source_default = column
                                                .default_value
                                                .clone()
                                                .unwrap_or_default();
                                            if source_default.trim() != target_default.trim() {
                                                match column.default_value.as_deref().and_then(
                                                    |value| render_default(Engine::Postgres, value),
                                                ) {
                                                    Some(default) => parts.push(format!(
                                                        "ALTER TABLE {} ALTER COLUMN {} SET DEFAULT {}",
                                                        target_ref,
                                                        quote(pair.target.as_ref(), &column.name),
                                                        default
                                                    )),
                                                    None => parts.push(format!(
                                                        "ALTER TABLE {} ALTER COLUMN {} DROP DEFAULT",
                                                        target_ref,
                                                        quote(pair.target.as_ref(), &column.name)
                                                    )),
                                                }
                                            }
                                        }
                                    }
                                    if !parts.is_empty() {
                                        statements.push(SyncStatement {
                                            table: table.clone(),
                                            kind: "modifyColumn".into(),
                                            description: format!("修改列 {}", column.name),
                                            sql: parts.join(";\n"),
                                        });
                                    }
                                }
                                Engine::Sqlite => statements.push(SyncStatement {
                                    table: table.clone(),
                                    kind: "warning".into(),
                                    description: format!(
                                        "SQLite 不支持修改列 {}，需手工重建表",
                                        column.name
                                    ),
                                    sql: String::new(),
                                }),
                                Engine::Redis | Engine::Mongodb => {}
                            }
                        }
                        "onlyTarget" => {
                            if !options.drop_extra_columns {
                                continue;
                            }
                            if pair.engine == Engine::Sqlite {
                                statements.push(SyncStatement {
                                    table: table.clone(),
                                    kind: "warning".into(),
                                    description: format!(
                                        "SQLite 不支持删除列 {}，需手工重建表",
                                        diff.name
                                    ),
                                    sql: String::new(),
                                });
                            } else {
                                statements.push(SyncStatement {
                                    table: table.clone(),
                                    kind: "dropColumn".into(),
                                    description: format!("删除目标多余列 {}", diff.name),
                                    sql: format!(
                                        "ALTER TABLE {} DROP COLUMN {}",
                                        target_ref,
                                        quote(pair.target.as_ref(), &diff.name)
                                    ),
                                });
                            }
                        }
                        _ => {}
                    }
                }

                if options.create_indexes {
                    for index in diff_indexes(&src, &tgt) {
                        if index.status != "onlySource" {
                            continue;
                        }
                        if let Some(source_index) =
                            src.indexes.iter().find(|item| item.name == index.name)
                        {
                            let columns: Vec<String> = source_index
                                .columns
                                .iter()
                                .map(|column| {
                                    let base = quote(pair.target.as_ref(), &column.name);
                                    if column.desc {
                                        format!("{base} DESC")
                                    } else {
                                        base
                                    }
                                })
                                .collect();
                            statements.push(SyncStatement {
                                table: table.clone(),
                                kind: "createIndex".into(),
                                description: format!("创建索引 {}", index.name),
                                sql: format!(
                                    "CREATE {}INDEX {} ON {} ({})",
                                    if source_index.unique { "UNIQUE " } else { "" },
                                    quote(pair.target.as_ref(), &index.name),
                                    target_ref,
                                    columns.join(", ")
                                ),
                            });
                        }
                    }
                }

                if options.create_foreign_keys && pair.engine != Engine::Sqlite {
                    for fk in diff_foreign_keys(&src, &tgt) {
                        if fk.status != "onlySource" {
                            continue;
                        }
                        if let Some(source_fk) =
                            src.foreign_keys.iter().find(|item| item.name == fk.name)
                        {
                            let columns: Vec<String> = source_fk
                                .columns
                                .iter()
                                .map(|name| quote(pair.target.as_ref(), name))
                                .collect();
                            let ref_columns: Vec<String> = source_fk
                                .ref_columns
                                .iter()
                                .map(|name| quote(pair.target.as_ref(), name))
                                .collect();
                            statements.push(SyncStatement {
                                table: table.clone(),
                                kind: "addForeignKey".into(),
                                description: format!("添加外键 {}", fk.name),
                                sql: format!(
                                    "ALTER TABLE {} ADD CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {} ({}) ON DELETE {} ON UPDATE {}",
                                    target_ref,
                                    quote(pair.target.as_ref(), &source_fk.name),
                                    columns.join(", "),
                                    table_ref(pair.target.as_ref(),&target.database,source_fk.ref_schema.as_deref(), &source_fk.ref_table),
                                    ref_columns.join(", "), source_fk.on_delete, source_fk.on_update
                                ),
                            });
                        }
                    }
                }
            }
            (None, None) => {}
        }
    }

    Ok(statements)
}

pub async fn preview_schema(state: &AppState, request: &SchemaSyncRequest) -> AppResult<SchemaPlan> {
    schema::prepare(state, request).await
}

pub async fn execute_schema(state: &AppState, plan_id: &str, selected: &[usize]) -> AppResult<SchemaExecuteResult> {
    schema::execute(state, plan_id, selected).await
}

/* ---------------- 数据对比与同步 ---------------- */

fn value_to_key(value: &DbValue) -> String {
    serde_json::to_string(value).unwrap_or_default()
}

fn compare_values(left: &DbValue, right: &DbValue) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    match (left, right) {
        (DbValue::Null, DbValue::Null) => Ordering::Equal,
        (DbValue::Null, _) => Ordering::Less,
        (_, DbValue::Null) => Ordering::Greater,
        (DbValue::Int(a), DbValue::Int(b)) => a.cmp(b),
        (DbValue::UInt(a), DbValue::UInt(b)) => a.cmp(b),
        (DbValue::Int(a), DbValue::UInt(b)) => (*a as i128).cmp(&(*b as i128)),
        (DbValue::UInt(a), DbValue::Int(b)) => (*a as i128).cmp(&(*b as i128)),
        (DbValue::Float(a), DbValue::Float(b)) => a.partial_cmp(b).unwrap_or(Ordering::Equal),
        (DbValue::Int(a), DbValue::Float(b)) => {
            (*a as f64).partial_cmp(b).unwrap_or(Ordering::Equal)
        }
        (DbValue::Float(a), DbValue::Int(b)) => {
            a.partial_cmp(&(*b as f64)).unwrap_or(Ordering::Equal)
        }
        _ => left
            .serialize_key()
            .cmp(&right.serialize_key()),
    }
}

trait SerializeKey {
    fn serialize_key(&self) -> String;
}
impl SerializeKey for DbValue {
    fn serialize_key(&self) -> String {
        match self {
            DbValue::Decimal(v)
            | DbValue::Text(v)
            | DbValue::Date(v)
            | DbValue::Time(v)
            | DbValue::DateTime(v)
            | DbValue::Json(v)
            | DbValue::Uuid(v) => v.clone(),
            DbValue::Bool(v) => v.to_string(),
            DbValue::Bytes(v) => v.iter().map(|b| format!("{b:02x}")).collect(),
            _ => value_to_key(self),
        }
    }
}

fn compare_keys(left: &[DbValue], right: &[DbValue]) -> std::cmp::Ordering {
    for (a, b) in left.iter().zip(right.iter()) {
        let ordering = compare_values(a, b);
        if ordering != std::cmp::Ordering::Equal {
            return ordering;
        }
    }
    left.len().cmp(&right.len())
}

fn row_equal(left: &[DbValue], right: &[DbValue]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter().zip(right.iter()).all(|(a, b)| {
        serde_json::to_string(a).unwrap_or_default() == serde_json::to_string(b).unwrap_or_default()
    })
}

struct TablePlan {
    filter: String,
    meta: TableMeta,
    key_indexes: Vec<usize>,
    has_key: bool,
}

async fn plan_table(
    adapter: &dyn DbAdapter,
    database: &str,
    table: &str,
) -> Option<TablePlan> {
    let meta = adapter.introspect_table(database, None, table).await.ok()?;
    let key_indexes: Vec<usize> = meta
        .primary_key
        .iter()
        .filter_map(|name| meta.columns.iter().position(|column| &column.name == name))
        .collect();
    let has_key = !key_indexes.is_empty();
    Some(TablePlan {
        filter: String::new(),
        meta,
        key_indexes,
        has_key,
    })
}

const PAGE_SIZE: u32 = 1000;

async fn fetch_page(
    adapter: &dyn DbAdapter,
    database: &str,
    plan: &TablePlan,
    after: Option<&[DbValue]>,
) -> AppResult<Vec<Vec<DbValue>>> {
    let table = table_ref(adapter, database, plan.meta.schema.as_deref(), &plan.meta.name);
    let columns: Vec<String> = plan
        .meta
        .columns
        .iter()
        .map(|column| quote(adapter, &column.name))
        .collect();
    let key_names: Vec<String> = plan
        .key_indexes
        .iter()
        .map(|index| quote(adapter, &plan.meta.columns[*index].name))
        .collect();
    let order = key_names.join(", ");

    let cursor_clause = match after {
        Some(values) => {
            let left = format!("({})", key_names.join(", "));
            let right: Vec<String> = values
                .iter()
                .map(|value| render_literal(adapter.engine(), value))
                .collect();
            format!("{left} > ({})", right.join(", "))
        }
        None => String::new(),
    };

    let predicates: Vec<String> = [plan.filter.clone(), cursor_clause].into_iter().filter(|v| !v.is_empty()).map(|v| format!("({v})")).collect();
    let where_clause=if predicates.is_empty(){String::new()}else{format!(" WHERE {}",predicates.join(" AND "))};
    let sql = format!(
        "SELECT {} FROM {}{} ORDER BY {} LIMIT {}",
        columns.join(", "),
        table,
        where_clause,
        order,
        PAGE_SIZE
    );
    let ctx = crate::adapters::QueryContext::new();
    let outcome = crate::tasks::query(adapter, &ctx, adapter.query_page(database, &sql, 0, PAGE_SIZE, &ctx)).await?;
    Ok(outcome.rows)
}

fn key_of(row: &[DbValue], indexes: &[usize]) -> Vec<DbValue> {
    indexes.iter().map(|index| row[*index].clone()).collect()
}

fn sample_value(value: &DbValue) -> String {
    let text = match value { DbValue::Null=>"NULL".into(), DbValue::Text(s)|DbValue::Json(s)|DbValue::Truncated(s)|DbValue::ReadOnly(s)=>s.clone(), _=>serde_json::to_string(value).unwrap_or_default() };
    let mut chars=text.chars(); let head:String=chars.by_ref().take(256).collect();
    if chars.next().is_some(){format!("{head}…")}else{head}
}
fn push_sample(samples: &mut Vec<RowDiff>,kind:&str,plan:&TablePlan,before:Option<&Vec<DbValue>>,after:Option<&Vec<DbValue>>){
 if samples.len()>=100{return;}
 let row=after.or(before).unwrap();
 let key=plan.key_indexes.iter().map(|i|sample_value(row.get(*i).unwrap_or(&DbValue::Null))).collect::<Vec<_>>().join(" / ");
 let fields=plan.meta.columns.iter().enumerate().filter_map(|(i,c)|{
 let old=before.and_then(|r|r.get(i));let new=after.and_then(|r|r.get(i));
 if old==new{return None;}Some(FieldDiff{column:c.name.clone(),before:old.map(sample_value),after:new.map(sample_value)})
 }).take(100).collect();samples.push(RowDiff{kind:kind.into(),key,fields});
}

async fn scan_data_diff(
    pair: &AdapterPair,
    source: &Endpoint,
    target: &Endpoint,
    plans: &[(String, Option<TablePlan>, Option<TablePlan>)],
    options: &DataSyncOptions,
    collector: &mut Option<&mut DataCollector<'_>>,
) -> AppResult<Vec<TableDataDiff>> {
    let mut results = Vec::new();

    for (table, source_plan, target_plan) in plans {
        crate::tasks::checkpoint()?;
        let (Some(source_plan), Some(target_plan)) = (source_plan, target_plan) else {
            results.push(TableDataDiff {
                table: table.clone(),
                key_columns: Vec::new(),
                source_rows: 0,
                target_rows: 0,
                inserts: 0,
                updates: 0,
                deletes: 0,
                samples: Vec::new(),
                skipped: true,
                note: Some("目标缺少该表，请先同步结构".into()),
            });
            continue;
        };
        if !source_plan.has_key || !target_plan.has_key {
            results.push(TableDataDiff {
                table: table.clone(),
                key_columns: source_plan.meta.primary_key.clone(),
                source_rows: 0,
                target_rows: 0,
                inserts: 0,
                updates: 0,
                deletes: 0,
                samples: Vec::new(),
                skipped: true,
                note: Some("无主键表：数据同步仅支持结构同步".into()),
            });
            continue;
        }

        if collector.as_ref().is_some_and(|c|c.aborted){break;}
        let counts_before=collector.as_ref().map(|c|(c.inserted,c.updated,c.deleted,c.failed));
        let mut samples = Vec::new();
        let mut source_rows = 0u64;
        let mut target_rows = 0u64;
        let mut inserts = 0u64;
        let mut updates = 0u64;
        let mut deletes = 0u64;

        let mut source_cursor: Option<Vec<DbValue>> = None;
        let mut target_cursor: Option<Vec<DbValue>> = None;
        let mut source_buffer = fetch_page(pair.source.as_ref(), &source.database, source_plan, None)
            .await?;
        let mut target_buffer = fetch_page(pair.target.as_ref(), &target.database, target_plan, None)
            .await?;
        let _ = (&source_cursor, &target_cursor);
        let mut source_index = 0usize;
        let mut target_index = 0usize;

        'scan: loop {
            crate::tasks::checkpoint()?;
            if collector.is_none() && (source_rows + target_rows) % 500 == 0 {
                crate::tasks::progress(source_rows + target_rows, None, format!("正在比较 {table}：源 {source_rows} 行 / 目标 {target_rows} 行"));
            }
            if source_index >= source_buffer.len() {
                if source_buffer.len() as u32 == PAGE_SIZE {
                    source_cursor = source_buffer.last().map(|row| key_of(row, &source_plan.key_indexes));
                    source_buffer = fetch_page(
                        pair.source.as_ref(),
                        &source.database,
                        source_plan,
                        source_cursor.as_deref(),
                    )
                    .await?;
                    source_index = 0;

                } else {
                    source_buffer.clear();
                    source_index = 0;
                }
            }
            if target_index >= target_buffer.len() {
                if target_buffer.len() as u32 == PAGE_SIZE {
                    target_cursor = target_buffer.last().map(|row| key_of(row, &target_plan.key_indexes));
                    target_buffer = fetch_page(
                        pair.target.as_ref(),
                        &target.database,
                        target_plan,
                        target_cursor.as_deref(),
                    )
                    .await?;
                    target_index = 0;

                } else {
                    target_buffer.clear();
                    target_index = 0;
                }
            }

            let source_row = source_buffer.get(source_index);
            let target_row = target_buffer.get(target_index);

            match (source_row, target_row) {
                (None, None) => break,
                (Some(row), None) => {
                    // 剩余源行全部为插入
                    push_sample(&mut samples,"insert",source_plan,None,Some(row));
                    inserts += 1;
                    source_rows += 1;
                    if let Some(collector) = collector.as_deref_mut() {
                        collector.record_insert(table, &source_plan.meta, row).await;
                        if collector.aborted {
                            break 'scan;
                        }
                    }
                    source_index += 1;
                }
                (None, Some(row)) => {
                    if source_plan.filter.is_empty() {push_sample(&mut samples,"delete",target_plan,Some(row),None);deletes += 1;}
                    target_rows += 1;
                    if options.delete_extra {
                        if let Some(collector) = collector.as_deref_mut() {
                            collector.record_delete(table, target_plan, row).await;
                            if collector.aborted {
                                break 'scan;
                            }
                        }
                    }
                    target_index += 1;
                }
                (Some(source_row), Some(target_row)) => {
                    let source_key = key_of(source_row, &source_plan.key_indexes);
                    let target_key = key_of(target_row, &target_plan.key_indexes);
                    match compare_keys(&source_key, &target_key) {
                        std::cmp::Ordering::Equal => {
                            source_rows += 1;
                            target_rows += 1;
                            if !row_equal(source_row, target_row) {
                                push_sample(&mut samples,"update",source_plan,Some(target_row),Some(source_row));
                                updates += 1;
                                if options.update_changed {
                                    if let Some(collector) = collector.as_deref_mut() {
                                        collector
                                            .record_update(
                                                table,
                                                &target_plan.meta,
                                                source_row,
                                                target_row,
                                            )
                                            .await;
                                        if collector.aborted {
                                            break 'scan;
                                        }
                                    }
                                }
                            }
                            source_index += 1;
                            target_index += 1;
                        }
                        std::cmp::Ordering::Less => {
                            push_sample(&mut samples,"insert",source_plan,None,Some(source_row));
                            inserts += 1;
                            source_rows += 1;
                            if let Some(collector) = collector.as_deref_mut() {
                                collector
                                    .record_insert(table, &source_plan.meta, source_row)
                                    .await;
                                if collector.aborted {
                                    break 'scan;
                                }
                            }
                            source_index += 1;
                        }
                        std::cmp::Ordering::Greater => {
                            if source_plan.filter.is_empty() {push_sample(&mut samples,"delete",target_plan,Some(target_row),None);deletes += 1;}
                            target_rows += 1;
                            if options.delete_extra {
                                if let Some(collector) = collector.as_deref_mut() {
                                    collector
                                        .record_delete(table, target_plan, target_row)
                                        .await;
                                    if collector.aborted {
                                        break 'scan;
                                    }
                                }
                            }
                            target_index += 1;
                        }
                    }
                }
            }

            let source_done =
                source_index >= source_buffer.len() && (source_buffer.len() as u32) < PAGE_SIZE;
            let target_done =
                target_index >= target_buffer.len() && (target_buffer.len() as u32) < PAGE_SIZE;
            if source_done && target_done {
                break;
            }
        }

        if let Some(c)=collector.as_deref_mut(){
          if !c.aborted {if !c.statements.is_empty() {crate::tasks::checkpoint()?;} c.flush().await;}else{c.statements.clear();c.undo.clear();c.pending_counts=[0;3];}
          let (i,u,d,f)=counts_before.unwrap();
          c.results.push(TableSyncResult{table:table.clone(),inserts:c.inserted-i,updates:c.updated-u,deletes:c.deleted-d,failed:c.failed-f,error:if c.failed>f{c.error.clone()}else{None}});
        }
        results.push(TableDataDiff {
            table: table.clone(),
            key_columns: source_plan.meta.primary_key.clone(),
            source_rows,
            target_rows,
            inserts,
            updates,
            deletes,
            samples,
            skipped: false,
            note: None,
        });
    }

    Ok(results)
}

struct DataCollector<'a> {
    write_guard: Option<(&'a AppState, &'a str)>,
    backup_directory: std::path::PathBuf,
    undo: Vec<Vec<String>>,
    batch_id: u64,
    pending_counts: [u64; 3],
    results: Vec<TableSyncResult>,
    insert_missing: bool,
    pair: &'a AdapterPair,
    target_database: String,
    target_column_types: HashMap<String, HashMap<String, String>>,
    statements: Vec<SqlParams>,
    batch_size: usize,
    inserted: u64,
    updated: u64,
    deleted: u64,
    failed: u64,
    error: Option<String>,
    continue_on_error: bool,
    aborted: bool,
}

impl DataCollector<'_> {
    fn record_error(&mut self, error: AppError) {
        self.failed += 1;
        if self.error.is_none() {
            self.error = Some(error.to_string());
        }
        if !self.continue_on_error {
            self.aborted = true;
        }
    }

    fn rollback_sql(&self, meta:&TableMeta, change:RowChange)->AppResult<Vec<String>> {
      let types=self.target_column_types.get(&meta.name).cloned().unwrap_or_default();
      crate::adapters::render_change_statements(self.pair.target.as_ref(),&self.target_database,endpoint_schema(self.pair.engine, &self.target_database, meta.schema.as_deref()),&meta.name,&[change],&types)
    }
    async fn flush(&mut self) {
        if self.statements.is_empty() || crate::tasks::cancelled() { return; }
        if let Some((state,id))=self.write_guard { if let Err(error)=super::readonly::writable(state,id).await {self.record_error(error);self.aborted=true;return;} }
        let items=std::mem::take(&mut self.statements);
        let undo=std::mem::take(&mut self.undo);
        let counts=std::mem::take(&mut self.pending_counts);
        self.batch_id+=1;
        let pending=self.backup_directory.join(format!("pending-{:08}.sql",self.batch_id));
        let body=format!("-- 请先核对目标库与提交状态；该文件仅恢复直接修改的行，不包含触发器副作用。\nBEGIN;\n{};\nCOMMIT;\n",undo.into_iter().rev().flatten().collect::<Vec<_>>().join(";\n"));
        let persist=(||->std::io::Result<()>{use std::io::Write;let mut file=std::fs::File::create(&pending)?;file.write_all(body.as_bytes())?;file.sync_all()})();
        if let Err(error)=persist {self.record_error(error.into());self.aborted=true;return;}
        match self.pair.target.execute_transaction(&self.target_database,&items).await {
          Ok(_)=>{
            self.inserted+=counts[0];self.updated+=counts[1];self.deleted+=counts[2];
            crate::tasks::progress(self.inserted+self.updated+self.deleted, None, format!("已提交：新增 {} / 更新 {} / 删除 {}；回滚材料：{}",self.inserted,self.updated,self.deleted,self.backup_directory.display()));
            if let Err(error)=std::fs::rename(&pending,self.backup_directory.join(format!("committed-{:08}.sql",self.batch_id))){self.record_error(error.into());self.aborted=true;}
          }
          Err(error)=>{self.record_error(error);self.aborted=true;}
        }
    }

    async fn record_insert(&mut self, table: &str, meta: &TableMeta, row: &[DbValue]) {
        if !self.insert_missing { return; }
        let values: Vec<CellValue> = meta
            .columns
            .iter()
            .enumerate()
            .map(|(index, column)| CellValue {
                column: column.name.clone(),
                value: row.get(index).cloned().unwrap_or(DbValue::Null),
            })
            .collect();
        if values
            .iter()
            .any(|cell| matches!(cell.value, DbValue::Truncated(_) | DbValue::ReadOnly(_)))
        {
            self.record_error(AppError::InvalidInput(
                "行包含截断或只读类型字段，已跳过以避免写入不完整数据".into(),
            ));
            return;
        }
        let column_types = self
            .target_column_types
            .get(table)
            .cloned()
            .unwrap_or_default();
        let keys=values.clone();
        let rollback=match self.rollback_sql(meta,RowChange::Delete{keys}) {Ok(v)=>v,Err(e)=>{self.record_error(e);return;}};
        match crate::adapters::build_change_statements(
            self.pair.target.as_ref(),
            &self.target_database,
            endpoint_schema(self.pair.engine, &self.target_database, meta.schema.as_deref()),
            &meta.name,
            &[RowChange::Insert { values }],
            &column_types,
        ) {
            Ok(statements) => {
                self.statements.extend(statements);
                self.undo.push(rollback);
                self.pending_counts[0] += 1;
            }
            Err(error) => {
                self.record_error(error);
                return;
            }
        }
        if self.statements.len() >= self.batch_size {
            self.flush().await;
        }
    }

    async fn record_update(
        &mut self,
        table: &str,
        meta: &TableMeta,
        source_row: &[DbValue],
        target_row: &[DbValue],
    ) {
        let mut changes: Vec<CellChange> = Vec::new();
        let mut keys: Vec<CellValue> = Vec::new();
        for (index, column) in meta.columns.iter().enumerate() {
            let is_key = meta.primary_key.contains(&column.name);
            let source_value = source_row.get(index).cloned().unwrap_or(DbValue::Null);
            if is_key {
                keys.push(CellValue {
                    column: column.name.clone(),
                    value: target_row.get(index).cloned().unwrap_or(DbValue::Null),
                });
                continue;
            }
            let target_value = target_row.get(index).cloned().unwrap_or(DbValue::Null);
            if matches!(source_value, DbValue::Truncated(_) | DbValue::ReadOnly(_)) {
                if !row_equal_ignore_truncated(&source_value, &target_value) {
                    self.record_error(AppError::InvalidInput(
                        "行包含截断或只读类型字段，已跳过以避免写入不完整数据".into(),
                    ));
                    return;
                }
                continue;
            }
            let same = serde_json::to_string(&source_value).unwrap_or_default()
                == serde_json::to_string(&target_value).unwrap_or_default();
            if !same {
                changes.push(CellChange {
                    column: column.name.clone(),
                    old_value: target_value,
                    new_value: source_value,
                });
            }
        }
        if changes.is_empty() {
            return;
        }
        let column_types = self
            .target_column_types
            .get(table)
            .cloned()
            .unwrap_or_default();
        let inverse=changes.iter().map(|c|CellChange{column:c.column.clone(),old_value:c.new_value.clone(),new_value:c.old_value.clone()}).collect();
        let rollback=match self.rollback_sql(meta,RowChange::Update{keys:keys.clone(),changes:inverse}) {Ok(v)=>v,Err(e)=>{self.record_error(e);return;}};
        match crate::adapters::build_change_statements(
            self.pair.target.as_ref(),
            &self.target_database,
            endpoint_schema(self.pair.engine, &self.target_database, meta.schema.as_deref()),
            &meta.name,
            &[RowChange::Update { keys, changes }],
            &column_types,
        ) {
            Ok(statements) => {
                self.statements.extend(statements);
                self.undo.push(rollback);
                self.pending_counts[1] += 1;
            }
            Err(error) => {
                self.record_error(error);
                return;
            }
        }
        if self.statements.len() >= self.batch_size {
            self.flush().await;
        }
    }

    async fn record_delete(&mut self, table: &str, plan: &TablePlan, row: &[DbValue]) {
        let keys: Vec<CellValue> = plan
            .key_indexes
            .iter()
            .map(|index| CellValue {
                column: plan.meta.columns[*index].name.clone(),
                value: row.get(*index).cloned().unwrap_or(DbValue::Null),
            })
            .collect();
        let column_types = self
            .target_column_types
            .get(table)
            .cloned()
            .unwrap_or_default();
        let values=plan.meta.columns.iter().enumerate().map(|(i,c)|CellValue{column:c.name.clone(),value:row.get(i).cloned().unwrap_or(DbValue::Null)}).collect();
        let rollback=match self.rollback_sql(&plan.meta,RowChange::Insert{values}) {Ok(v)=>v,Err(e)=>{self.record_error(e);return;}};
        match crate::adapters::build_change_statements(
            self.pair.target.as_ref(),
            &self.target_database,
            endpoint_schema(self.pair.engine, &self.target_database, plan.meta.schema.as_deref()),
            &plan.meta.name,
            &[RowChange::Delete { keys }],
            &column_types,
        ) {
            Ok(statements) => {
                self.statements.extend(statements);
                self.undo.push(rollback);
                self.pending_counts[2] += 1;
            }
            Err(error) => {
                self.record_error(error);
            }
        }
        if self.statements.len() >= self.batch_size { self.flush().await; }
    }
}

fn row_equal_ignore_truncated(left: &DbValue, right: &DbValue) -> bool {
    match left {
        DbValue::Truncated(preview) => match right {
            DbValue::Text(value) | DbValue::Json(value) => value.starts_with(preview.as_str()),
            _ => false,
        },
        _ => {
            serde_json::to_string(left).unwrap_or_default()
                == serde_json::to_string(right).unwrap_or_default()
        }
    }
}

fn validate_filters(request: &DataSyncRequest) -> AppResult<()> {
 if request.filters.keys().any(|t| !request.tables.contains(t)) {return Err(AppError::InvalidInput("筛选包含未选择的表，请重新配置".into()));}
 if request.options.delete_extra && request.filters.values().any(|f|!f.conditions.is_empty()) {return Err(AppError::InvalidInput("源数据筛选模式不允许删除目标多余行".into()));}
 Ok(())
}
fn apply_source_filter(adapter:&dyn DbAdapter, plan:&mut TablePlan, filter:Option<&SourceFilter>)->AppResult<()> {
 let Some(filter)=filter else{return Ok(())};
 if filter.conditions.len()>50 || !["","and","or"].contains(&filter.conjunction.as_str()) {return Err(AppError::InvalidInput("筛选条件最多 50 条，组合方式仅支持 AND/OR".into()));}
 for c in &filter.conditions {
  if !plan.meta.columns.iter().any(|v|v.name==c.column) || !["eq","ne","gt","ge","lt","le","contains","startsWith","endsWith","isNull","isNotNull","between"].contains(&c.operator.as_str()) {
   return Err(AppError::InvalidInput(format!("无效的筛选字段或操作符：{}",c.column)));
  }
 }
 let clause=super::query::build_where_clause(adapter,&filter.conditions,&filter.conjunction)?;
 plan.filter=clause.strip_prefix(" WHERE ").unwrap_or(&clause).to_string();
 Ok(())
}

pub async fn compare_data(
    state: &AppState,
    request: &DataSyncRequest,
) -> AppResult<Vec<TableDataDiff>> {
    validate_filters(request)?;
    let pair = connect_pair(state, &request.source, &request.target).await?;
    let mut plans = Vec::new();
    for table in &request.tables {
        crate::tasks::checkpoint()?;
        let mut source_plan = plan_table(pair.source.as_ref(), &request.source.database, table).await;
        if let Some(plan)=source_plan.as_mut(){apply_source_filter(pair.source.as_ref(),plan,request.filters.get(table))?;}
        let target_plan = plan_table(pair.target.as_ref(), &request.target.database, table).await;
        plans.push((table.clone(), source_plan, target_plan));
    }
    let mut no_collector: Option<&mut DataCollector<'_>> = None;
    scan_data_diff(
        &pair,
        &request.source,
        &request.target,
        &plans,
        &request.options,
        &mut no_collector,
    )
    .await
}

pub async fn execute_data(
    state: &AppState,
    request: &DataSyncRequest,
) -> AppResult<DataExecuteResult> {
    super::readonly::writable(state,&request.target.session_id).await?;
    validate_filters(request)?;
    let pair = connect_pair(state, &request.source, &request.target).await?;

    let mut plans = Vec::new();
    let mut column_types: HashMap<String, HashMap<String, String>> = HashMap::new();
    for table in &request.tables {
        crate::tasks::checkpoint()?;
        let mut source_plan = plan_table(pair.source.as_ref(), &request.source.database, table).await;
        if let Some(plan)=source_plan.as_mut(){apply_source_filter(pair.source.as_ref(),plan,request.filters.get(table))?;}
        let target_plan = plan_table(pair.target.as_ref(), &request.target.database, table).await;
        if let Some(plan) = &target_plan {
            column_types.insert(
                table.clone(),
                plan.meta
                    .columns
                    .iter()
                    .map(|column| (column.name.clone(), column.raw_type.clone()))
                    .collect(),
            );
        }
        plans.push((table.clone(), source_plan, target_plan));
    }

    let backup_directory=crate::store::local::app_data_dir().join("sync-backups").join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&backup_directory)?;
    std::fs::write(backup_directory.join("README.txt"),format!("目标会话：{}\n目标库：{}\n按 committed 文件编号从大到小执行回滚。pending 文件提交状态不确定，必须先核对，不能直接运行。\n脚本只覆盖本次直接数据变更，不覆盖结构、触发器或级联副作用；恢复前停止相关写入并核对冲突。\n",request.target.session_id,request.target.database))?;
    crate::tasks::progress(0, None, format!("正在同步；已提交批次保留。回滚材料：{}", backup_directory.display()));
    let mut collector = DataCollector {
        write_guard:Some((state,&request.target.session_id)),
        backup_directory:backup_directory.clone(),undo:Vec::new(),batch_id:0,pending_counts:[0;3],results:Vec::new(),insert_missing:request.options.insert_missing,
        pair: &pair,
        target_database: request.target.database.clone(),
        target_column_types: column_types,
        statements: Vec::new(),
        batch_size: request.options.batch_size.unwrap_or(500).clamp(50, 5000),
        inserted: 0,
        updated: 0,
        deleted: 0,
        failed: 0,
        error: None,
        continue_on_error: request.options.continue_on_error,
        aborted: false,
    };

    let diffs = {
        let mut some_collector = Some(&mut collector);
        scan_data_diff(
            &pair,
            &request.source,
            &request.target,
            &plans,
            &request.options,
            &mut some_collector,
        )
        .await.map_err(|error| { let message=format!("同步中断：{}。回滚材料目录：{}；请先检查 README 与批次状态。", error, backup_directory.display()); if matches!(error, AppError::Cancelled(_)) { AppError::Cancelled(message) } else { AppError::Message(message) } })?
    };

    for diff in diffs.iter().filter(|d|d.skipped) { collector.results.push(TableSyncResult{table:diff.table.clone(),inserts:0,updates:0,deletes:0,failed:0,error:diff.note.clone()}); }
    Ok(DataExecuteResult { tables: collector.results, backup_directory: backup_directory.to_string_lossy().into_owned() })
}

#[cfg(test)]
mod sync_integration_tests {
 #[tokio::test]
 async fn filtered_source_paginates_and_preserves_unmatched_target(){
  let (dir,pair,source,target)=setup().await;
  execute(pair.source.as_ref(),"WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1105) INSERT INTO items SELECT x,'new' FROM n").await;
  execute(pair.target.as_ref(),"INSERT INTO items VALUES (1,'old'),(2000,'untouched')").await;
  let mut plans=plans(&pair).await;
  let filter:SourceFilter=serde_json::from_value(serde_json::json!({"conjunction":"or","conditions":[{"column":"id","operator":"le","value":"1100"},{"column":"id","operator":"eq","value":"1105"}]})).unwrap();
  apply_source_filter(pair.source.as_ref(),plans[0].1.as_mut().unwrap(),Some(&filter)).unwrap();
  let result=scan_data_diff(&pair,&source,&target,&plans,&DataSyncOptions::default(),&mut None).await.unwrap();
  assert_eq!((result[0].source_rows,result[0].inserts,result[0].updates,result[0].deletes),(1101,1100,1,0));
  let mut c=collector(&pair,dir.join("filter-undo"),true);c.batch_size=500;
  scan_data_diff(&pair,&source,&target,&plans,&DataSyncOptions::default(),&mut Some(&mut c)).await.unwrap();
  assert_eq!((c.inserted,c.updated,c.deleted),(1100,1,0));
  let rows=pair.target.query_page("main","SELECT * FROM items WHERE id IN (1,1104,1105,2000) ORDER BY id",0,10,&crate::adapters::QueryContext::new()).await.unwrap().rows;
  assert_eq!(rows.len(),3);assert_eq!(rows[2][1],DbValue::Text("untouched".into()));
  let bad:SourceFilter=serde_json::from_value(serde_json::json!({"conditions":[{"column":"missing","operator":"eq","value":"x"}]})).unwrap();
  assert!(apply_source_filter(pair.source.as_ref(),plans[0].1.as_mut().unwrap(),Some(&bad)).is_err());
  let request:DataSyncRequest=serde_json::from_value(serde_json::json!({"source":{"sessionId":"s","database":"a"},"target":{"sessionId":"t","database":"b"},"tables":["items"],"filters":{"items":{"conditions":[{"column":"id","operator":"eq","value":"1"}]}},"options":{"insertMissing":true,"updateChanged":true,"deleteExtra":true,"batchSize":500,"continueOnError":false}})).unwrap();
  assert!(validate_filters(&request).is_err());
 }
 #[tokio::test]
 async fn mysql_target_database_in_generated_sql(){
  let (dir,sqlite_pair,_,_)=setup().await;
  let mut plan=plan_table(sqlite_pair.source.as_ref(),"main","items").await.unwrap();
  plan.meta.schema=Some("source_a".into());
  let adapter=Arc::new(crate::adapters::mysql::MySqlAdapter::for_sql_tests());
  plan.meta.indexes.push(crate::meta::IndexMeta{name:"idx_value".into(),columns:vec![crate::meta::IndexColumn{name:"value".into(),desc:false,prefix_len:None}],unique:false,primary:false,method:None,comment:None});
  plan.meta.foreign_keys.push(crate::meta::ForeignKeyMeta{ref_database:None,ref_schema:None,name:"fk_parent".into(),columns:vec!["id".into()],ref_table:"parent".into(),ref_columns:vec!["id".into()],on_delete:"NO ACTION".into(),on_update:"NO ACTION".into()});
  assert!(create_table_sql(adapter.as_ref(),"target_b",&plan.meta,false).starts_with("CREATE TABLE `target_b`.`items`"));
  for statement in create_index_statements(adapter.as_ref(),"target_b",&plan.meta).into_iter().chain(add_foreign_key_statements(adapter.as_ref(),"target_b",&plan.meta)){
   assert!(statement.sql.contains("`target_b`.`items`"));assert!(!statement.sql.contains("source_a"));
   if statement.kind=="addForeignKey" {assert!(statement.sql.contains("REFERENCES `target_b`.`parent`"));}
  }
  assert_eq!(table_ref(adapter.as_ref(),"b`x",Some("source_a"),"it`ems"),"`b``x`.`it``ems`");
  assert_eq!(endpoint_schema(Engine::Postgres,"target_b",Some("public")),Some("public"));
  assert_eq!(endpoint_schema(Engine::Sqlite,"target_b",Some("main")),Some("main"));
  let pair=AdapterPair{source:adapter.clone(),target:adapter,engine:Engine::Mysql};
  let mut c=collector(&pair,dir.join("mysql-undo"),true);c.target_database="target_b".into();c.batch_size=500;
  let old=vec![DbValue::Int(1),DbValue::Text("old".into())];
  let new=vec![DbValue::Int(1),DbValue::Text("new".into())];
  c.record_insert("items",&plan.meta,&new).await;
  c.record_update("items",&plan.meta,&new,&old).await;
  c.record_delete("items",&plan,&old).await;
  assert_eq!(c.statements.len(),3);assert_eq!(c.undo.len(),3);
  for sql in c.statements.iter().map(|s|s.sql.as_str()).chain(c.undo.iter().flatten().map(String::as_str)){
   assert!(sql.contains("`target_b`.`items`"),"{sql}");assert!(!sql.contains("source_a"),"{sql}");
  }
  // 不 flush：仅验证生成语句，不连接或修改真实 MySQL。
 }
 #[test]
 fn mysql_bit_defaults_are_literals() {
  use super::*;
  for (value, expected) in [("b'0'", "b'0'"), ("B'1'", "b'1'"), ("b'10101010'", "b'10101010'"), ("0b10", "b'10'"), ("0", "0"), ("1", "1")] {
   assert_eq!(render_column_default(Engine::Mysql, "BIT(8)", value).as_deref(), Some(expected));
  }
  assert_eq!(render_column_default(Engine::Mysql, "varchar(20)", "b'0'").as_deref(), Some("'b''0'''"));
  assert_eq!(render_column_default(Engine::Mysql, "bit(1)", "b'2'").as_deref(), Some("'b''2'''"));
  assert_eq!(render_column_default(Engine::Mysql, "datetime", "CURRENT_TIMESTAMP").as_deref(), Some("CURRENT_TIMESTAMP"));
 }
 use super::*;
 use crate::adapters::{sqlite::SqliteAdapter,ConnectionParams};
 use std::sync::Arc;
 async fn setup()->(std::path::PathBuf,AdapterPair,Endpoint,Endpoint){
  let dir=std::env::temp_dir().join(format!("dw-sync-test-{}",uuid::Uuid::new_v4()));std::fs::create_dir_all(&dir).unwrap();
  async fn open(path:std::path::PathBuf)->Arc<dyn DbAdapter>{
   std::fs::File::create(&path).unwrap();
   let params:ConnectionParams=serde_json::from_value(serde_json::json!({"engine":"sqlite","filePath":path.to_string_lossy()})).unwrap();
   let adapter=Arc::new(SqliteAdapter::connect(&params).await.unwrap());
   adapter.execute_transaction("",&[SqlParams{sql:"CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT)".into(),params:vec![]}]).await.unwrap();adapter
  }
  let source=open(dir.join("source.db")).await;let target=open(dir.join("target.db")).await;
  (dir,AdapterPair{source,target,engine:Engine::Sqlite},Endpoint{session_id:"source".into(),database:"main".into()},Endpoint{session_id:"target".into(),database:"main".into()})
 }
 async fn execute(adapter:&dyn DbAdapter,sql:&str){adapter.execute_transaction("main",&[SqlParams{sql:sql.into(),params:vec![]}]).await.unwrap();}
 async fn plans(pair:&AdapterPair)->Vec<(String,Option<TablePlan>,Option<TablePlan>)>{vec![("items".into(),plan_table(pair.source.as_ref(),"main","items").await,plan_table(pair.target.as_ref(),"main","items").await)]}
 fn collector<'a>(pair:&'a AdapterPair,dir:std::path::PathBuf,insert:bool)->DataCollector<'a>{
  std::fs::create_dir_all(&dir).unwrap();DataCollector{write_guard:None,pair,target_database:"main".into(),target_column_types:HashMap::new(),statements:vec![],batch_size:2,inserted:0,updated:0,deleted:0,failed:0,error:None,continue_on_error:false,aborted:false,backup_directory:dir,undo:vec![],batch_id:0,pending_counts:[0;3],results:vec![],insert_missing:insert}
 }
 #[tokio::test]
 async fn exact_page_boundary_and_insert_option(){
  let (dir,pair,source,target)=setup().await;
  execute(pair.source.as_ref(),"WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1000) INSERT INTO items SELECT x,'same' FROM n").await;
  execute(pair.target.as_ref(),"WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1001) INSERT INTO items SELECT x,'same' FROM n").await;
  let plans=plans(&pair).await;let options=DataSyncOptions::default();
  let result=scan_data_diff(&pair,&source,&target,&plans,&options,&mut None).await.unwrap();assert_eq!(result[0].deletes,1);assert_eq!(result[0].target_rows,1001);
  execute(pair.source.as_ref(),"INSERT INTO items VALUES (1002,'new')").await;
  let mut c=collector(&pair,dir.join("backup"),false);
  scan_data_diff(&pair,&source,&target,&plans,&options,&mut Some(&mut c)).await.unwrap();assert_eq!(c.inserted,0);assert_eq!(c.batch_id,0);
  let check=pair.target.query_page("main","SELECT * FROM items WHERE id=1002",0,10,&crate::adapters::QueryContext::new()).await.unwrap();assert!(check.rows.is_empty());
 }
 #[tokio::test]
 async fn committed_batches_restore_original_data(){
  let (dir,pair,source,target)=setup().await;
  execute(pair.source.as_ref(),"INSERT INTO items VALUES (1,'new ? $1'),(2,'inserted')").await;
  execute(pair.target.as_ref(),"INSERT INTO items VALUES (1,'old'),(3,'deleted')").await;
  let plans=plans(&pair).await;let options=DataSyncOptions{delete_extra:true,..Default::default()};
  let before=pair.target.query_page("main","SELECT * FROM items ORDER BY id",0,10,&crate::adapters::QueryContext::new()).await.unwrap().rows;
  let backup=dir.join("backup");let mut c=collector(&pair,backup.clone(),true);
  scan_data_diff(&pair,&source,&target,&plans,&options,&mut Some(&mut c)).await.unwrap();
  assert_eq!((c.inserted,c.updated,c.deleted,c.failed),(1,1,1,0));
  let mut files=std::fs::read_dir(&backup).unwrap().map(|f|f.unwrap().path()).collect::<Vec<_>>();files.sort();files.reverse();assert!(!files.is_empty());
  use sqlx::Connection;
  let mut conn=sqlx::SqliteConnection::connect_with(&sqlx::sqlite::SqliteConnectOptions::new().filename(dir.join("target.db"))).await.unwrap();
  for file in files{assert!(file.file_name().unwrap().to_string_lossy().starts_with("committed-"));sqlx::raw_sql(&std::fs::read_to_string(file).unwrap()).execute(&mut conn).await.unwrap();}
  let after=pair.target.query_page("main","SELECT * FROM items ORDER BY id",0,10,&crate::adapters::QueryContext::new()).await.unwrap().rows;assert_eq!(before,after);
 }
 #[tokio::test]
 async fn cancellation_preserves_only_committed_batches(){
  let (dir,pair,source,target)=setup().await;
  execute(pair.source.as_ref(),"WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<500) INSERT INTO items SELECT x,'new' FROM n").await;
  let plans=plans(&pair).await;
  let mut c=collector(&pair,dir.join("backup"),true);
  let registry=crate::tasks::TaskRegistry::default();registry.begin("cancel-sync".into()).unwrap();
  let options=DataSyncOptions::default();
  let work=registry.scope(Some("cancel-sync".into()),async {
    scan_data_diff(&pair,&source,&target,&plans,&options,&mut Some(&mut c)).await
  });
  let cancel=async {
    tokio::time::timeout(std::time::Duration::from_secs(10),async {
      loop {
        if registry.snapshot("cancel-sync").unwrap().processed>=2 {registry.cancel("cancel-sync").unwrap();break;}
        tokio::task::yield_now().await;
      }
    }).await.unwrap();
  };
  let (result,())=tokio::join!(work,cancel);
  assert!(matches!(result,Err(AppError::Cancelled(_))));
  let rows=pair.target.query_page("main","SELECT * FROM items",0,1000,&crate::adapters::QueryContext::new()).await.unwrap().rows;
  assert!(rows.len()>=2 && rows.len()<500);
  assert_eq!(rows.len() as u64,registry.snapshot("cancel-sync").unwrap().processed);
  assert_eq!(rows.len() as u64,c.inserted);
 }
 #[tokio::test]
 async fn backup_failure_prevents_database_write(){
  let (dir,pair,source,target)=setup().await;execute(pair.source.as_ref(),"INSERT INTO items VALUES (1,'new')").await;
  let plans=plans(&pair).await;let mut c=collector(&pair,dir.join("backup"),true);c.backup_directory=dir.join("missing").join("cannot-write");
  scan_data_diff(&pair,&source,&target,&plans,&DataSyncOptions::default(),&mut Some(&mut c)).await.unwrap();assert!(c.aborted);assert_eq!(c.inserted,0);
  assert!(pair.target.query_page("main","SELECT * FROM items",0,10,&crate::adapters::QueryContext::new()).await.unwrap().rows.is_empty());
 }
}
