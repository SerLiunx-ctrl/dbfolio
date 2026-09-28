use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::adapters::DbAdapter;
use crate::error::{AppError, AppResult};
use crate::meta::{CanonicalType, ColumnMeta, Engine, TableMeta, TableKind};
use crate::state::AppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnSpec {
    #[serde(default)]
    pub preserve_type: bool,
    pub name: String,
    /// 统一类型名：tinyint/smallint/int/bigint/bool/decimal/float/double/varchar/char/text/
    /// date/time/datetime/timestamp/json/blob/uuid，或其他引擎原始类型文本
    pub data_type: String,
    pub length: Option<u32>,
    pub precision: Option<u8>,
    pub scale: Option<u8>,
    pub nullable: bool,
    pub primary_key: bool,
    pub auto_increment: bool,
    pub default_value: Option<String>,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnPosition {
    pub first: bool,
    pub after: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexColumnSpec {
    pub name: String,
    #[serde(default)]
    pub desc: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub struct TableOptions { pub name:Option<String>, pub comment:Option<String>, pub engine:Option<String>, pub charset:Option<String>, pub collation:Option<String>, pub auto_increment:Option<String>, pub row_format:Option<String> }
fn option_word(value:&str)->AppResult<&str>{if value.is_empty()||!value.bytes().all(|c|c.is_ascii_alphanumeric()||c==b'_'){return Err(AppError::InvalidInput("表选项包含无效字符".into()));}Ok(value)}
fn table_options(adapter:&dyn DbAdapter,database:&str,schema:Option<&str>,table:&str,o:&TableOptions)->AppResult<Vec<String>> {
 let target=table_ref(adapter,database,schema,table);let engine=adapter.engine();
 if !matches!(engine,Engine::Mysql|Engine::Postgres|Engine::Sqlite){return Err(AppError::InvalidInput("该引擎不支持表属性修改".into()));}
 if let Some(name)=&o.name {if name.trim().is_empty()||name.contains('\0'){return Err(AppError::InvalidInput("表名不能为空或包含空字符".into()));}if o.comment.is_some()||o.engine.is_some()||o.charset.is_some()||o.collation.is_some()||o.auto_increment.is_some()||o.row_format.is_some(){return Err(AppError::InvalidInput("请先单独保存表名，再修改其他选项".into()));}return Ok(vec![format!("ALTER TABLE {} RENAME TO {}",target,quote(adapter,name))]);}
 if engine!=Engine::Mysql {
  if o.engine.is_some()||o.charset.is_some()||o.collation.is_some()||o.auto_increment.is_some()||o.row_format.is_some(){return Err(AppError::InvalidInput("该数据库不支持这些表选项".into()));}
  if engine==Engine::Postgres {if let Some(comment)=&o.comment{return Ok(vec![format!("COMMENT ON TABLE {} IS '{}'",target,escape(engine,comment))]);}}
  return Err(AppError::InvalidInput("没有可用的表选项修改".into()));
 }
 let mut parts=Vec::new();
 if let Some(v)=&o.comment{parts.push(format!("COMMENT='{}'",escape(engine,v)));}
 if let Some(v)=&o.engine{parts.push(format!("ENGINE={}",option_word(v)?));}
 if let Some(v)=&o.charset{parts.push(format!("DEFAULT CHARACTER SET={}",option_word(v)?));}
 if let Some(v)=&o.collation{parts.push(format!("COLLATE={}",option_word(v)?));}
 if let Some(v)=&o.auto_increment{let n=v.parse::<u64>().map_err(|_|AppError::InvalidInput("自增起始值必须是正整数".into()))?;if n==0{return Err(AppError::InvalidInput("自增起始值必须大于 0".into()));}parts.push(format!("AUTO_INCREMENT={n}"));}
 if let Some(v)=&o.row_format{if !["DEFAULT","DYNAMIC","COMPACT","REDUNDANT","COMPRESSED","FIXED","DYNAMIC"].contains(&v.as_str()){return Err(AppError::InvalidInput("记录行格式无效".into()));}parts.push(format!("ROW_FORMAT={v}"));}
 if parts.is_empty(){return Err(AppError::InvalidInput("没有需要保存的修改".into()));}Ok(vec![format!("ALTER TABLE {} {}",target,parts.join(", "))])
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum DdlSpec {
    CreateTableDraft { draft:super::create_table::TableDraft },
    ColumnFlags {schema:Option<String>,table:String,changes:Vec<ColumnFlags>},
    TableOptions { schema:Option<String>, table:String, options:TableOptions },
    CreateTable {
        schema: Option<String>,
        table: String,
        columns: Vec<ColumnSpec>,
    },
    DropTable {
        schema: Option<String>,
        table: String,
    },
    AddColumn {
        schema: Option<String>,
        table: String,
        column: ColumnSpec,
        position: Option<ColumnPosition>,
    },
    ModifyColumn {
        schema: Option<String>,
        table: String,
        column: ColumnSpec,
    },
    DropColumn {
        schema: Option<String>,
        table: String,
        column: String,
    },
    MoveColumn {
        schema: Option<String>,
        table: String,
        column: String,
        position: ColumnPosition,
    },
    CreateIndex {
        schema: Option<String>,
        table: String,
        name: String,
        columns: Vec<IndexColumnSpec>,
        unique: bool,
    },
    ReplaceIndex {
        schema: Option<String>,
        table: String,
        name: String,
        old_name: String,
        columns: Vec<IndexColumnSpec>,
        unique: bool,
    },
    DropIndex {
        schema: Option<String>,
        table: String,
        name: String,
    },
    AddForeignKey {
        schema: Option<String>,
        table: String,
        name: String,
        columns: Vec<String>,
        ref_table: String,
        ref_columns: Vec<String>,
        on_delete: String,
        on_update: String,
    },
    ReplaceForeignKey {
        schema: Option<String>,
        table: String,
        name: String,
        old_name: String,
        columns: Vec<String>,
        ref_table: String,
        ref_columns: Vec<String>,
        on_delete: String,
        on_update: String,
    },
    DropForeignKey {
        schema: Option<String>,
        table: String,
        name: String,
    },
}

fn quote(adapter: &dyn DbAdapter, name: &str) -> String {
    adapter.quote_ident(name)
}

fn table_ref(adapter: &dyn DbAdapter, database: &str, schema: Option<&str>, table: &str) -> String {
    match schema.filter(|s| !s.is_empty()) {
        Some(s) => format!("{}.{}", quote(adapter, s), quote(adapter, table)),
        None => {
            if adapter.engine() == Engine::Mysql && !database.is_empty() {
                format!("{}.{}", quote(adapter, database), quote(adapter, table))
            } else {
                quote(adapter, table)
            }
        }
    }
}

fn escape(engine: Engine, text: &str) -> String {
    match engine {
        Engine::Mysql => text.replace('\\', "\\\\").replace('\'', "''"),
        _ => text.replace('\'', "''"),
    }
}

fn with_precision(base: &str, precision: Option<u8>) -> String {
    match precision {
        Some(value) => format!("{base}({value})"),
        None => base.to_string(),
    }
}

fn sql_type(engine: Engine, spec: &ColumnSpec) -> String {
    if spec.preserve_type {
        return spec.data_type.trim().to_owned();
    }
    let dt = spec.data_type.trim().to_ascii_lowercase();
    match engine {
        Engine::Mysql => match dt.as_str() {
            "tinyint" => "TINYINT".into(),
            "smallint" => "SMALLINT".into(),
            "int" | "integer" => "INT".into(),
            "bigint" => "BIGINT".into(),
            "bool" | "boolean" => "TINYINT(1)".into(),
            "decimal" | "numeric" => format!(
                "DECIMAL({},{})",
                spec.precision.unwrap_or(10),
                spec.scale.unwrap_or(0)
            ),
            "float" => "FLOAT".into(),
            "double" => "DOUBLE".into(),
            "varchar" => format!("VARCHAR({})", spec.length.unwrap_or(255)),
            "char" => format!("CHAR({})", spec.length.unwrap_or(1)),
            "text" => "TEXT".into(),
            "date" => "DATE".into(),
            "time" => with_precision("TIME", spec.precision),
            "datetime" => with_precision("DATETIME", spec.precision),
            "timestamp" => with_precision("TIMESTAMP", spec.precision),
            "json" => "JSON".into(),
            "blob" => "BLOB".into(),
            "uuid" => "CHAR(36)".into(),
            _ => spec.data_type.trim().to_string(),
        },
        Engine::Postgres => match dt.as_str() {
            "tinyint" | "smallint" => "SMALLINT".into(),
            "int" | "integer" => "INTEGER".into(),
            "bigint" => "BIGINT".into(),
            "bool" | "boolean" => "BOOLEAN".into(),
            "decimal" | "numeric" => format!(
                "NUMERIC({},{})",
                spec.precision.unwrap_or(10),
                spec.scale.unwrap_or(0)
            ),
            "float" => "REAL".into(),
            "double" => "DOUBLE PRECISION".into(),
            "varchar" => format!("VARCHAR({})", spec.length.unwrap_or(255)),
            "char" => format!("CHAR({})", spec.length.unwrap_or(1)),
            "text" => "TEXT".into(),
            "date" => "DATE".into(),
            "time" => with_precision("TIME", spec.precision),
            "datetime" => with_precision("TIMESTAMP", spec.precision),
            "timestamp" => with_precision("TIMESTAMP", spec.precision),
            "timestamptz" => with_precision("TIMESTAMPTZ", spec.precision),
            "timetz" => with_precision("TIMETZ", spec.precision),
            "json" => "JSON".into(),
            "jsonb" => "JSONB".into(),
            "blob" => "BYTEA".into(),
            "uuid" => "UUID".into(),
            _ => spec.data_type.trim().to_string(),
        },
        Engine::Sqlite => match dt.as_str() {
            "tinyint" | "smallint" | "int" | "integer" | "bigint" | "bool" | "boolean" => {
                "INTEGER".into()
            }
            "decimal" | "numeric" => "NUMERIC".into(),
            "float" | "double" | "real" => "REAL".into(),
            "varchar" | "char" | "text" | "date" | "time" | "datetime" | "timestamp" | "json"
            | "uuid" => "TEXT".into(),
            "blob" => "BLOB".into(),
            _ => spec.data_type.trim().to_string(),
        },
        Engine::Redis | Engine::Mongodb => spec.data_type.trim().to_string(),
    }
}

fn normalize_pg_type(raw: &str) -> String {
    raw.trim()
        .to_ascii_lowercase()
        .replace("character varying", "varchar")
        .replace("timestamp with time zone", "timestamptz")
        .replace("timestamp without time zone", "timestamp")
        .replace("time with time zone", "timetz")
        .replace("time without time zone", "time")
        .replace("double precision", "double")
        .replace("integer", "int")
        .replace("boolean", "bool")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn render_default(engine: Engine, value: &str) -> Option<String> {
    let v = value.trim();
    if v.is_empty() {
        return None;
    }
    let upper = v.to_ascii_uppercase();
    let is_keyword = matches!(
        upper.as_str(),
        "NULL" | "TRUE" | "FALSE" | "CURRENT_TIMESTAMP" | "CURRENT_DATE" | "CURRENT_TIME"
    ) || upper.starts_with("NOW(")
        || upper.starts_with("CURRENT_TIMESTAMP(");
    if is_keyword {
        return Some(v.to_string());
    }
    if v.parse::<f64>().is_ok() {
        return Some(v.to_string());
    }
    if (v.starts_with('\'') && v.ends_with('\'')) || v.starts_with('(') {
        return Some(v.to_string());
    }
    Some(format!("'{}'", escape(engine, v)))
}

fn is_integer_type(data_type: &str) -> bool {
    matches!(
        data_type.trim().to_ascii_lowercase().as_str(),
        "tinyint" | "smallint" | "mediumint" | "int" | "integer" | "bigint"
    )
}

fn column_def(adapter: &dyn DbAdapter, spec: &ColumnSpec) -> String {
    let engine = adapter.engine();
    let mut parts = vec![quote(adapter, &spec.name), sql_type(engine, spec)];

    if engine == Engine::Postgres && spec.auto_increment {
        parts.push("GENERATED BY DEFAULT AS IDENTITY".into());
    }
    if !spec.nullable {
        parts.push("NOT NULL".into());
    }
    if !spec.auto_increment {
        if let Some(default) = spec
            .default_value
            .as_deref()
            .and_then(|v| render_default(engine, v))
        {
            parts.push(format!("DEFAULT {default}"));
        }
    }
    if engine == Engine::Mysql {
        if spec.auto_increment {
            parts.push("AUTO_INCREMENT".into());
        }
        if let Some(comment) = spec.comment.as_deref().filter(|c| !c.trim().is_empty()) {
            parts.push(format!("COMMENT '{}'", escape(engine, comment.trim())));
        }
    }

    parts.join(" ")
}

fn meta_column_type(engine: Engine, column: &ColumnMeta) -> String {
    if !column.raw_type.trim().is_empty() {
        return column.raw_type.clone();
    }
    canonical_sql(engine, &column.canonical)
}

/// 由已有列元数据重建列定义（用于 MySQL 的位置调整等）
fn column_def_from_meta(adapter: &dyn DbAdapter, column: &ColumnMeta) -> String {
    let engine = adapter.engine();
    let q = |name: &str| adapter.quote_ident(name);
    let mut parts = vec![q(&column.name), meta_column_type(engine, column)];
    if !column.nullable {
        parts.push("NOT NULL".into());
    }
    if !column.auto_increment {
        if let Some(default) = column
            .default_value
            .as_deref()
            .and_then(|value| render_default(engine, value))
        {
            parts.push(format!("DEFAULT {default}"));
        }
    }
    if engine == Engine::Mysql {
        if column.auto_increment {
            parts.push("AUTO_INCREMENT".into());
        }
        if let Some(comment) = column.comment.as_deref().filter(|c| !c.trim().is_empty()) {
            parts.push(format!("COMMENT '{}'", escape(engine, comment.trim())));
        }
    }
    parts.join(" ")
}

fn position_clause(adapter: &dyn DbAdapter, position: &ColumnPosition) -> String {
    if position.first {
        return " FIRST".to_string();
    }
    match position.after.as_deref().filter(|name| !name.is_empty()) {
        Some(after) => format!(" AFTER {}", adapter.quote_ident(after)),
        None => String::new(),
    }
}

fn move_column(
    adapter: &dyn DbAdapter,
    database: &str,
    schema: Option<&str>,
    table: &str,
    meta: &TableMeta,
    column: &str,
    position: &ColumnPosition,
) -> AppResult<Vec<String>> {
    let engine = adapter.engine();
    match engine {
        Engine::Redis | Engine::Mongodb => Err(AppError::InvalidInput("非 SQL 引擎不支持结构变更".into())),
        Engine::Postgres => Err(AppError::InvalidInput(
            "PostgreSQL 不支持调整列顺序（列顺序由创建时确定）".into(),
        )),
        Engine::Mysql => {
            let target = table_ref(adapter, database, schema, table);
            let col = meta
                .columns
                .iter()
                .find(|item| item.name == column)
                .ok_or_else(|| AppError::NotFound(format!("列不存在: {column}")))?;
            Ok(vec![format!(
                "ALTER TABLE {} MODIFY COLUMN {}{}",
                target,
                column_def_from_meta(adapter, col),
                position_clause(adapter, position)
            )])
        }
        Engine::Sqlite => {
            let mut columns: Vec<ColumnMeta> = meta.columns.clone();
            let index = columns
                .iter()
                .position(|item| item.name == column)
                .ok_or_else(|| AppError::NotFound(format!("列不存在: {column}")))?;
            let moved = columns.remove(index);
            if position.first {
                columns.insert(0, moved);
            } else if let Some(after) = position.after.as_deref() {
                let insert_at = columns
                    .iter()
                    .position(|item| item.name == after)
                    .map(|pos| pos + 1)
                    .unwrap_or(columns.len());
                columns.insert(insert_at, moved);
            } else {
                columns.push(moved);
            }
            Ok(render_sqlite_rebuild(
                adapter,
                database,
                schema,
                table,
                meta,
                &columns,
                &meta.primary_key,
            ))
        }
    }
}

fn canonical_sql(engine: Engine, canonical: &CanonicalType) -> String {
    let spec = match canonical {
        CanonicalType::Bool => ColumnSpec {
            preserve_type: false,
            name: String::new(),
            data_type: "bool".into(),
            length: None,
            precision: None,
            scale: None,
            nullable: true,
            primary_key: false,
            auto_increment: false,
            default_value: None,
            comment: None,
        },
        CanonicalType::Int { bits, .. } => ColumnSpec {
            preserve_type: false,
            name: String::new(),
            data_type: match bits {
                8 => "tinyint",
                16 => "smallint",
                64 => "bigint",
                _ => "int",
            }
            .into(),
            length: None,
            precision: None,
            scale: None,
            nullable: true,
            primary_key: false,
            auto_increment: false,
            default_value: None,
            comment: None,
        },
        CanonicalType::Decimal { precision, scale } => ColumnSpec {
            preserve_type: false,
            name: String::new(),
            data_type: "decimal".into(),
            length: None,
            precision: *precision,
            scale: *scale,
            nullable: true,
            primary_key: false,
            auto_increment: false,
            default_value: None,
            comment: None,
        },
        CanonicalType::Float { bits } => ColumnSpec {
            preserve_type: false,
            name: String::new(),
            data_type: if *bits == 32 { "float" } else { "double" }.into(),
            length: None,
            precision: None,
            scale: None,
            nullable: true,
            primary_key: false,
            auto_increment: false,
            default_value: None,
            comment: None,
        },
        CanonicalType::String { len } => ColumnSpec {
            preserve_type: false,
            name: String::new(),
            data_type: if len.is_some() { "varchar" } else { "text" }.into(),
            length: *len,
            precision: None,
            scale: None,
            nullable: true,
            primary_key: false,
            auto_increment: false,
            default_value: None,
            comment: None,
        },
        CanonicalType::Binary { .. } => ColumnSpec {
            preserve_type: false,
            name: String::new(),
            data_type: "blob".into(),
            length: None,
            precision: None,
            scale: None,
            nullable: true,
            primary_key: false,
            auto_increment: false,
            default_value: None,
            comment: None,
        },
        CanonicalType::Date => ColumnSpec {
            preserve_type: false,
            name: String::new(),
            data_type: "date".into(),
            length: None,
            precision: None,
            scale: None,
            nullable: true,
            primary_key: false,
            auto_increment: false,
            default_value: None,
            comment: None,
        },
        CanonicalType::Time { .. } => ColumnSpec {
            preserve_type: false,
            name: String::new(),
            data_type: "time".into(),
            length: None,
            precision: None,
            scale: None,
            nullable: true,
            primary_key: false,
            auto_increment: false,
            default_value: None,
            comment: None,
        },
        CanonicalType::DateTime { tz, .. } => ColumnSpec {
            preserve_type: false,
            name: String::new(),
            data_type: if *tz && engine == Engine::Postgres {
                "timestamptz"
            } else if *tz {
                "timestamp"
            } else {
                "datetime"
            }
            .into(),
            length: None,
            precision: None,
            scale: None,
            nullable: true,
            primary_key: false,
            auto_increment: false,
            default_value: None,
            comment: None,
        },
        CanonicalType::Json => ColumnSpec {
            preserve_type: false,
            name: String::new(),
            data_type: if engine == Engine::Postgres {
                "jsonb"
            } else {
                "json"
            }
            .into(),
            length: None,
            precision: None,
            scale: None,
            nullable: true,
            primary_key: false,
            auto_increment: false,
            default_value: None,
            comment: None,
        },
        CanonicalType::Uuid => ColumnSpec {
            preserve_type: false,
            name: String::new(),
            data_type: "uuid".into(),
            length: None,
            precision: None,
            scale: None,
            nullable: true,
            primary_key: false,
            auto_increment: false,
            default_value: None,
            comment: None,
        },
        CanonicalType::Enum { values } => ColumnSpec {
            preserve_type: false,
            name: String::new(),
            data_type: if engine == Engine::Mysql {
                format!(
                    "ENUM({})",
                    values
                        .iter()
                        .map(|v| format!("'{}'", escape(engine, v)))
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            } else {
                "varchar".into()
            },
            length: Some(255),
            precision: None,
            scale: None,
            nullable: true,
            primary_key: false,
            auto_increment: false,
            default_value: None,
            comment: None,
        },
        CanonicalType::Unknown { raw } => ColumnSpec {
            preserve_type: false,
            name: String::new(),
            data_type: raw.clone(),
            length: None,
            precision: None,
            scale: None,
            nullable: true,
            primary_key: false,
            auto_increment: false,
            default_value: None,
            comment: None,
        },
    };
    // ENUM 的 data_type 已包含括号，避免二次处理
    if spec.data_type.starts_with("ENUM(") {
        return spec.data_type;
    }
    sql_type(engine, &spec)
}

fn render_create_table(
    adapter: &dyn DbAdapter,
    target: &str,
    columns: &[ColumnSpec],
) -> AppResult<String> {
    if columns.is_empty() {
        return Err(AppError::InvalidInput("至少需要一个列".into()));
    }
    let mut names = std::collections::HashSet::new();
    for column in columns {
        if column.name.trim().is_empty() {
            return Err(AppError::InvalidInput("列名不能为空".into()));
        }
        if !names.insert(column.name.clone()) {
            return Err(AppError::InvalidInput(format!("列名重复: {}", column.name)));
        }
    }

    let engine = adapter.engine();
    let primary: Vec<&ColumnSpec> = columns.iter().filter(|c| c.primary_key).collect();
    if columns.iter().any(|c| {
        c.auto_increment
            && (!is_integer_type(&c.data_type)
                || (engine == Engine::Sqlite && (!c.primary_key || primary.len() != 1)))
    }) {
        return Err(AppError::InvalidInput(
            "自增需要整数列；SQLite 还需要单列整数主键".into(),
        ));
    }
    let sqlite_int_pk = engine == Engine::Sqlite
        && primary.len() == 1
        && primary[0].auto_increment
        && is_integer_type(&primary[0].data_type);

    let mut defs: Vec<String> = Vec::new();
    for column in columns {
        if sqlite_int_pk && column.primary_key {
            defs.push(format!(
                "{} INTEGER PRIMARY KEY AUTOINCREMENT",
                quote(adapter, &column.name)
            ));
        } else {
            defs.push(column_def(adapter, column));
        }
    }
    if !primary.is_empty() && !sqlite_int_pk {
        let cols: Vec<String> = primary.iter().map(|c| quote(adapter, &c.name)).collect();
        defs.push(format!("PRIMARY KEY ({})", cols.join(", ")));
    }

    Ok(format!(
        "CREATE TABLE {} (\n  {}\n)",
        target,
        defs.join(",\n  ")
    ))
}

fn apply_spec_to_column(engine: Engine, old: &ColumnMeta, spec: &ColumnSpec) -> ColumnMeta {
    let new_type = sql_type(engine, spec);
    ColumnMeta {
        name: spec.name.clone(),
        ordinal: old.ordinal,
        raw_type: new_type.clone(),
        canonical: match engine {
            Engine::Mysql => CanonicalType::from_mysql(&new_type),
            Engine::Postgres => CanonicalType::from_postgres(&new_type),
            Engine::Sqlite => CanonicalType::from_sqlite(&new_type),
            Engine::Redis | Engine::Mongodb => CanonicalType::from_sqlite(&new_type),
        },
        nullable: spec.nullable,
        default_value: spec.default_value.clone().filter(|v| !v.trim().is_empty()),
        auto_increment: spec.auto_increment,
        unsigned: old.unsigned,
        charset: old.charset.clone(),
        collation: old.collation.clone(),
        comment: spec.comment.clone(),
    }
}

fn render_sqlite_rebuild(
    adapter: &dyn DbAdapter,
    database: &str,
    schema: Option<&str>,
    table: &str,
    meta: &TableMeta,
    columns: &[ColumnMeta],
    primary_key: &[String],
) -> Vec<String> {
    let target = table_ref(adapter, database, schema, table);
    let temp_name = format!("_dw_tmp_{}_{}", table, &Uuid::new_v4().to_string()[..8]);
    let temp_ref = quote(adapter, &temp_name);

    let single_int_pk = primary_key.len() == 1
        && columns
            .iter()
            .find(|c| c.name == primary_key[0])
            .map(|c| {
                c.auto_increment
                    && matches!(
                        c.canonical,
                        CanonicalType::Int { bits: 64, .. } | CanonicalType::Int { .. }
                    )
            })
            .unwrap_or(false);

    let mut defs: Vec<String> = Vec::new();
    for column in columns {
        let mut parts = vec![
            quote(adapter, &column.name),
            meta_column_type(Engine::Sqlite, column),
        ];
        if single_int_pk && column.name == primary_key[0] {
            parts.push("PRIMARY KEY AUTOINCREMENT".into());
        }
        if !column.nullable {
            parts.push("NOT NULL".into());
        }
        if let Some(default) = column
            .default_value
            .as_deref()
            .filter(|v| !v.trim().is_empty())
        {
            parts.push(format!("DEFAULT {default}"));
        }
        defs.push(parts.join(" "));
    }
    if !primary_key.is_empty() && !single_int_pk {
        let cols: Vec<String> = primary_key.iter().map(|c| quote(adapter, c)).collect();
        defs.push(format!("PRIMARY KEY ({})", cols.join(", ")));
    }
    for fk in &meta.foreign_keys {
        if fk
            .columns
            .iter()
            .any(|c| !columns.iter().any(|col| &col.name == c))
        {
            continue;
        }
        let cols: Vec<String> = fk.columns.iter().map(|c| quote(adapter, c)).collect();
        let refs: Vec<String> = fk.ref_columns.iter().map(|c| quote(adapter, c)).collect();
        let mut clause = format!(
            "FOREIGN KEY ({}) REFERENCES {} ({})",
            cols.join(", "),
            quote(adapter, &fk.ref_table),
            refs.join(", ")
        );
        if !fk.on_delete.eq_ignore_ascii_case("NO ACTION") {
            clause.push_str(&format!(" ON DELETE {}", fk.on_delete.to_ascii_uppercase()));
        }
        if !fk.on_update.eq_ignore_ascii_case("NO ACTION") {
            clause.push_str(&format!(" ON UPDATE {}", fk.on_update.to_ascii_uppercase()));
        }
        defs.push(clause);
    }

    let column_list: Vec<String> = columns.iter().map(|c| quote(adapter, &c.name)).collect();
    let column_list = column_list.join(", ");

    let mut statements = vec![
        "PRAGMA foreign_keys=OFF".to_string(),
        format!("DROP TABLE IF EXISTS {temp_ref}"),
        format!("CREATE TABLE {} (\n  {}\n)", temp_ref, defs.join(",\n  ")),
        format!(
            "INSERT INTO {} ({}) SELECT {} FROM {}",
            temp_ref, column_list, column_list, target
        ),
        format!("DROP TABLE {target}"),
        format!(
            "ALTER TABLE {} RENAME TO {}",
            temp_ref,
            quote(adapter, table)
        ),
    ];

    for index in &meta.indexes {
        if index.primary {
            continue;
        }
        if index
            .columns
            .iter()
            .any(|c| !columns.iter().any(|col| col.name == c.name))
        {
            continue;
        }
        let cols: Vec<String> = index
            .columns
            .iter()
            .map(|c| {
                let base = quote(adapter, &c.name);
                if c.desc {
                    format!("{base} DESC")
                } else {
                    base
                }
            })
            .collect();
        statements.push(format!(
            "CREATE {}INDEX {} ON {} ({})",
            if index.unique { "UNIQUE " } else { "" },
            quote(adapter, &index.name),
            quote(adapter, table),
            cols.join(", ")
        ));
    }
    statements.push("PRAGMA foreign_keys=ON".to_string());
    statements
}

fn build_modify(
    adapter: &dyn DbAdapter,
    database: &str,
    schema: Option<&str>,
    table: &str,
    meta: &TableMeta,
    spec: &ColumnSpec,
) -> AppResult<Vec<String>> {
    let engine = adapter.engine();
    let target = table_ref(adapter, database, schema, table);
    let old = meta
        .columns
        .iter()
        .find(|c| c.name == spec.name)
        .ok_or_else(|| AppError::NotFound(format!("列不存在: {}", spec.name)))?;

    match engine {
        Engine::Redis | Engine::Mongodb => Err(AppError::InvalidInput("非 SQL 引擎不支持结构变更".into())),
        Engine::Mysql => Ok(vec![format!(
            "ALTER TABLE {} MODIFY COLUMN {}",
            target,
            column_def(adapter, spec)
        )]),
        Engine::Postgres => {
            let mut statements = Vec::new();
            let new_type = sql_type(engine, spec);
            // 仅在类型确有变化时才执行 TYPE 变更，避免无谓的全表重建
            if normalize_pg_type(&old.raw_type) != normalize_pg_type(&new_type) {
                statements.push(format!(
                    "ALTER TABLE {} ALTER COLUMN {} TYPE {}",
                    target,
                    quote(adapter, &spec.name),
                    new_type
                ));
            }
            if spec.nullable != old.nullable {
                statements.push(format!(
                    "ALTER TABLE {} ALTER COLUMN {} {}",
                    target,
                    quote(adapter, &spec.name),
                    if spec.nullable {
                        "DROP NOT NULL"
                    } else {
                        "SET NOT NULL"
                    }
                ));
            }
            let new_default = spec
                .default_value
                .as_deref()
                .and_then(|v| render_default(engine, v));
            let old_default = old.default_value.clone();
            if new_default != old_default {
                match new_default {
                    Some(value) => statements.push(format!(
                        "ALTER TABLE {} ALTER COLUMN {} SET DEFAULT {}",
                        target,
                        quote(adapter, &spec.name),
                        value
                    )),
                    None => statements.push(format!(
                        "ALTER TABLE {} ALTER COLUMN {} DROP DEFAULT",
                        target,
                        quote(adapter, &spec.name)
                    )),
                }
            }
            Ok(statements)
        }
        Engine::Sqlite => {
            let mut columns: Vec<ColumnMeta> = meta
                .columns
                .iter()
                .map(|c| {
                    if c.name == spec.name {
                        apply_spec_to_column(engine, c, spec)
                    } else {
                        c.clone()
                    }
                })
                .collect();
            columns.sort_by_key(|c| c.ordinal);

            let mut primary_key: Vec<String> = meta
                .primary_key
                .iter()
                .filter(|pk| columns.iter().any(|c| &c.name == *pk))
                .cloned()
                .collect();
            if spec.primary_key {
                if !primary_key.contains(&spec.name) {
                    primary_key.push(spec.name.clone());
                }
            } else {
                primary_key.retain(|pk| pk != &spec.name);
            }

            Ok(render_sqlite_rebuild(
                adapter,
                database,
                schema,
                table,
                meta,
                &columns,
                &primary_key,
            ))
        }
    }
}

fn build_drop_column(
    adapter: &dyn DbAdapter,
    database: &str,
    schema: Option<&str>,
    table: &str,
    meta: &TableMeta,
    column: &str,
) -> AppResult<Vec<String>> {
    let engine = adapter.engine();
    let target = table_ref(adapter, database, schema, table);
    if !meta.columns.iter().any(|c| c.name == column) {
        return Err(AppError::NotFound(format!("列不存在: {column}")));
    }

    match engine {
        Engine::Redis | Engine::Mongodb => Err(AppError::InvalidInput("非 SQL 引擎不支持结构变更".into())),
        Engine::Mysql | Engine::Postgres => Ok(vec![format!(
            "ALTER TABLE {} DROP COLUMN {}",
            target,
            quote(adapter, column)
        )]),
        Engine::Sqlite => {
            let columns: Vec<ColumnMeta> = meta
                .columns
                .iter()
                .filter(|c| c.name != column)
                .cloned()
                .collect();
            if columns.is_empty() {
                return Err(AppError::InvalidInput("不能删除最后一列".into()));
            }
            let primary_key: Vec<String> = meta
                .primary_key
                .iter()
                .filter(|pk| pk.as_str() != column)
                .cloned()
                .collect();
            Ok(render_sqlite_rebuild(
                adapter,
                database,
                schema,
                table,
                meta,
                &columns,
                &primary_key,
            ))
        }
    }
}

#[derive(Debug,Clone,Serialize,Deserialize,Default)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct ColumnFlags {pub name:String,pub nullable:bool,pub unsigned:Option<bool>,pub new_name:Option<String>,pub data_type:Option<String>,pub comment:Option<String>,pub default_mode:Option<String>,pub default_value:Option<String>,pub auto_increment:Option<bool>,pub on_update:Option<String>}
fn mysql_column_flags(raw:&str,changes:&[ColumnFlags])->AppResult<Vec<String>> {
 use sqlparser::{parser::Parser,dialect::MySqlDialect,ast::{Statement,ColumnOption}};
 let fail=|e:String|AppError::InvalidInput(format!("无法安全修改列属性：{e}"));
 let mut parsed=Parser::parse_sql(&MySqlDialect{},raw).map_err(|e|fail(e.to_string()))?;
 let Some(Statement::CreateTable(create))=parsed.first_mut() else{return Err(fail("无法解析建表定义".into()));};
 let mut result=Vec::new();
 for change in changes {
  let col=create.columns.iter_mut().find(|c|c.name.value==change.name).ok_or_else(||fail("列不存在".into()))?;
  if let Some(name)=&change.new_name {if name.trim().is_empty()||name.contains('\0'){return Err(fail("字段名无效".into()));}col.name=sqlparser::ast::Ident::with_quote('`',name);}
  if let Some(ty)=&change.data_type {
   let p=Parser::parse_sql(&MySqlDialect{},&format!("CREATE TABLE x (c {ty})")).map_err(|e|fail(e.to_string()))?;
   if p.len()!=1{return Err(fail("类型包含额外语句".into()));}
   let Statement::CreateTable(t)=&p[0] else{return Err(fail("类型无效".into()));};
   if t.columns.len()!=1||!t.columns[0].options.is_empty()||!t.constraints.is_empty(){return Err(fail("类型/长度只能包含类型定义".into()));}col.data_type=t.columns[0].data_type.clone();
  }
  if let Some(comment)=&change.comment{col.options.retain(|o|!matches!(o.option,ColumnOption::Comment(_)));col.options.push(sqlparser::ast::ColumnOptionDef{name:None,option:ColumnOption::Comment(comment.clone())});}
  let parse_option=|text:&str|->AppResult<sqlparser::ast::ColumnOptionDef>{let p=Parser::parse_sql(&MySqlDialect{},&format!("CREATE TABLE x (c INT {text})")).map_err(|e|fail(e.to_string()))?;let Statement::CreateTable(t)=&p[0] else{return Err(fail("属性无效".into()));};if p.len()!=1||t.columns.len()!=1||t.columns[0].options.len()!=1{return Err(fail("属性包含额外内容".into()));}Ok(t.columns[0].options[0].clone())};
  if let Some(mode)=&change.default_mode {
   col.options.retain(|o|!matches!(o.option,ColumnOption::Default(_)));
   let text=match mode.as_str(){"none"=>None,"null"=>Some("DEFAULT NULL".to_string()),"literal"=>Some(format!("DEFAULT '{}'",escape(Engine::Mysql,change.default_value.as_deref().unwrap_or("")))),"timestamp"=>Some("DEFAULT CURRENT_TIMESTAMP".into()),_=>return Err(fail("默认值模式无效".into()))};
   if let Some(text)=text{col.options.push(parse_option(&text)?);}
  }
  if let Some(value)=&change.on_update {col.options.retain(|o|!matches!(o.option,ColumnOption::OnUpdate(_)));if !value.is_empty(){if value!="CURRENT_TIMESTAMP"{return Err(fail("ON UPDATE 值无效".into()));}col.options.push(parse_option("ON UPDATE CURRENT_TIMESTAMP")?);}}
  if let Some(enabled)=change.auto_increment {col.options.retain(|o|!matches!(&o.option,ColumnOption::DialectSpecific(tokens) if tokens.iter().any(|t|t.to_string().eq_ignore_ascii_case("AUTO_INCREMENT"))));if enabled{col.options.push(parse_option("AUTO_INCREMENT")?);}}
  if let Some(unsigned)=change.unsigned {
   let ty=col.data_type.to_string();let first=ty.split(|c:char|!c.is_ascii_alphabetic()).next().unwrap_or("").to_ascii_uppercase();
   if !["TINYINT","SMALLINT","MEDIUMINT","INT","INTEGER","BIGINT","DECIMAL","NUMERIC","FLOAT","DOUBLE","REAL"].contains(&first.as_str()){return Err(fail("只有 MySQL 数值列支持 UNSIGNED".into()));}
   if ty.to_ascii_uppercase().contains("ZEROFILL")&&!unsigned{return Err(fail("ZEROFILL 列需先在列编辑中移除 ZEROFILL".into()));}
   let ty=ty.to_ascii_uppercase().replace(" UNSIGNED","");
   let probe=format!("CREATE TABLE x (c {}{})",ty,if unsigned{" UNSIGNED"}else{""});
   let p=Parser::parse_sql(&MySqlDialect{},&probe).map_err(|e|fail(e.to_string()))?;
   if let Statement::CreateTable(t)=&p[0]{col.data_type=t.columns[0].data_type.clone();}
  }
  col.options.retain(|o|!matches!(o.option,ColumnOption::Null|ColumnOption::NotNull));
  col.options.push(sqlparser::ast::ColumnOptionDef{name:None,option:if change.nullable{ColumnOption::Null}else{ColumnOption::NotNull}});
  if change.auto_increment==Some(true)&&change.nullable{return Err(fail("自增列不能可空".into()));}
  let rendered=col.to_string();let check=Parser::parse_sql(&MySqlDialect{},&format!("CREATE TABLE x ({rendered})")).map_err(|e|fail(e.to_string()))?;
  if let Statement::CreateTable(t)=&check[0]{if t.columns.len()!=1||t.columns[0].to_string()!=rendered{return Err(fail("列定义含无法安全往返保留的转义内容，请通过 SQL 修改".into()));}}
  result.push(if change.new_name.as_ref().is_some_and(|n|n!=&change.name){format!("CHANGE COLUMN `{}` {col}",change.name.replace('`',"``"))}else{format!("MODIFY COLUMN {col}")});
 }
 Ok(result)
}

pub async fn preview(
    state: &AppState,
    session_id: &str,
    database: &str,
    spec: &DdlSpec,
) -> AppResult<Vec<String>> {
    let connected = state.connected(session_id).await?;
    let adapter = connected.adapter.as_ref();
    if adapter.engine()==Engine::Sqlite && matches!(spec,DdlSpec::ColumnFlags{..}|DdlSpec::MoveColumn{..}|DdlSpec::DropColumn{..}) { return adapter.sqlite_schema_edit(database,spec,false).await; }

    match spec {
        DdlSpec::CreateTableDraft {draft} => super::create_table::render(adapter.engine(),database,draft),
        DdlSpec::ColumnFlags {schema,table,changes} => {
            if changes.is_empty(){return Err(AppError::InvalidInput("没有列属性修改".into()));}
            let meta=adapter.introspect_table(database,schema.as_deref(),table).await?;
            if meta.kind!=TableKind::Table{return Err(AppError::InvalidInput("视图不支持列属性修改".into()));}
            for c in changes {let column=meta.columns.iter().find(|v|v.name==c.name).ok_or_else(||AppError::InvalidInput("列不存在".into()))?;if c.nullable&&!column.nullable&&(column.auto_increment||meta.primary_key.contains(&c.name)){return Err(AppError::InvalidInput("主键或自增列不能设为可空".into()));}}
            let target=table_ref(adapter,database,schema.as_deref(),table);
            match adapter.engine(){
                Engine::Mysql=>Ok(vec![format!("ALTER TABLE {} {}",target,mysql_column_flags(meta.raw_ddl.as_deref().ok_or_else(||AppError::InvalidInput("缺少原始建表定义".into()))?,changes)?.join(", "))]),
                Engine::Postgres=>super::column_edit::postgres_columns(adapter,&target,&meta,changes),
                _=>Err(AppError::InvalidInput("该引擎暂不支持直接勾选修改列属性".into()))
            }
        },
        DdlSpec::TableOptions {schema,table,options} => {
            let meta=adapter.introspect_table(database,schema.as_deref(),table).await?;
            if meta.kind!=TableKind::Table{return Err(AppError::InvalidInput("仅支持修改表属性".into()));}
            table_options(adapter,database,schema.as_deref(),table,options)
        },
        DdlSpec::CreateTable {
            schema,
            table,
            columns,
        } => {
            let target = table_ref(adapter, database, schema.as_deref(), table);
            Ok(vec![render_create_table(adapter, &target, columns)?])
        }
        DdlSpec::DropTable { schema, table } => Ok(vec![format!(
            "DROP TABLE {}",
            table_ref(adapter, database, schema.as_deref(), table)
        )]),
        DdlSpec::AddColumn {
            schema,
            table,
            column,
            position,
        } => {
            if adapter.engine() == Engine::Sqlite
                && !column.nullable
                && column
                    .default_value
                    .as_deref()
                    .map(|v| v.trim().is_empty())
                    .unwrap_or(true)
            {
                return Err(AppError::InvalidInput(
                    "SQLite 添加 NOT NULL 列时必须提供默认值".into(),
                ));
            }
            let target = table_ref(adapter, database, schema.as_deref(), table);
            let mut statement = format!(
                "ALTER TABLE {} ADD COLUMN {}",
                target,
                column_def(adapter, column)
            );
            // 仅 MySQL 支持指定插入位置；PG / SQLite 只能追加到末尾
            if adapter.engine() == Engine::Mysql {
                if let Some(position) = position {
                    statement.push_str(&position_clause(adapter, position));
                }
            }
            Ok(vec![statement])
        }
        DdlSpec::ModifyColumn {
            schema,
            table,
            column,
        } => {
            let meta = adapter
                .introspect_table(database, schema.as_deref(), table)
                .await?;
            build_modify(adapter, database, schema.as_deref(), table, &meta, column)
        }
        DdlSpec::DropColumn {
            schema,
            table,
            column,
        } => {
            let meta = adapter
                .introspect_table(database, schema.as_deref(), table)
                .await?;
            build_drop_column(adapter, database, schema.as_deref(), table, &meta, column)
        }
        DdlSpec::MoveColumn {
            schema,
            table,
            column,
            position,
        } => {
            let meta = adapter
                .introspect_table(database, schema.as_deref(), table)
                .await?;
            move_column(
                adapter,
                database,
                schema.as_deref(),
                table,
                &meta,
                column,
                position,
            )
        }
        DdlSpec::CreateIndex {
            schema,
            table,
            name,
            columns,
            unique,
        } => {
            if columns.is_empty() {
                return Err(AppError::InvalidInput("索引至少需要一列".into()));
            }
            let target = table_ref(adapter, database, schema.as_deref(), table);
            Ok(vec![render_create_index(
                adapter, &target, name, columns, *unique,
            )])
        }
        DdlSpec::ReplaceIndex {
            schema,
            table,
            name,
            old_name,
            columns,
            unique,
        } => {
            if columns.is_empty() {
                return Err(AppError::InvalidInput("索引至少需要一列".into()));
            }
            let target = table_ref(adapter, database, schema.as_deref(), table);
            Ok(vec![
                render_drop_index(adapter, database, schema.as_deref(), table, old_name)?,
                render_create_index(adapter, &target, name, columns, *unique),
            ])
        }
        DdlSpec::DropIndex {
            schema,
            table,
            name,
        } => Ok(vec![render_drop_index(
            adapter,
            database,
            schema.as_deref(),
            table,
            name,
        )?]),
        DdlSpec::AddForeignKey {
            schema,
            table,
            name,
            columns,
            ref_table,
            ref_columns,
            on_delete,
            on_update,
        } => {
            let target = table_ref(adapter, database, schema.as_deref(), table);
            Ok(vec![render_add_foreign_key(
                adapter,
                &target,
                name,
                columns,
                ref_table,
                ref_columns,
                on_delete,
                on_update,
            )?])
        }
        DdlSpec::ReplaceForeignKey {
            schema,
            table,
            name,
            old_name,
            columns,
            ref_table,
            ref_columns,
            on_delete,
            on_update,
        } => {
            let target = table_ref(adapter, database, schema.as_deref(), table);
            Ok(vec![
                render_drop_foreign_key(adapter, &target, old_name)?,
                render_add_foreign_key(
                    adapter,
                    &target,
                    name,
                    columns,
                    ref_table,
                    ref_columns,
                    on_delete,
                    on_update,
                )?,
            ])
        }
        DdlSpec::DropForeignKey {
            schema,
            table,
            name,
        } => {
            let target = table_ref(adapter, database, schema.as_deref(), table);
            Ok(vec![render_drop_foreign_key(adapter, &target, name)?])
        }
    }
}

fn render_create_index(
    adapter: &dyn DbAdapter,
    target: &str,
    name: &str,
    columns: &[IndexColumnSpec],
    unique: bool,
) -> String {
    let column_list: Vec<String> = columns
        .iter()
        .map(|column| {
            let base = adapter.quote_ident(&column.name);
            if column.desc {
                format!("{base} DESC")
            } else {
                base
            }
        })
        .collect();
    format!(
        "CREATE {}INDEX {} ON {} ({})",
        if unique { "UNIQUE " } else { "" },
        adapter.quote_ident(name),
        target,
        column_list.join(", ")
    )
}

fn render_drop_index(
    adapter: &dyn DbAdapter,
    database: &str,
    schema: Option<&str>,
    table: &str,
    name: &str,
) -> AppResult<String> {
    match adapter.engine() {
        Engine::Mysql => Ok(format!(
            "DROP INDEX {} ON {}",
            adapter.quote_ident(name),
            table_ref(adapter, database, schema, table)
        )),
        Engine::Postgres => {
            let index_ref = match schema.filter(|value| !value.is_empty()) {
                Some(schema) => format!(
                    "{}.{}",
                    adapter.quote_ident(schema),
                    adapter.quote_ident(name)
                ),
                None => adapter.quote_ident(name),
            };
            Ok(format!("DROP INDEX {index_ref}"))
        }
        Engine::Sqlite => Ok(format!("DROP INDEX {}", adapter.quote_ident(name))),
        Engine::Redis | Engine::Mongodb => Err(AppError::InvalidInput("非 SQL 引擎不支持索引操作".into())),
    }
}

#[allow(clippy::too_many_arguments)]
fn render_add_foreign_key(
    adapter: &dyn DbAdapter,
    target: &str,
    name: &str,
    columns: &[String],
    ref_table: &str,
    ref_columns: &[String],
    on_delete: &str,
    on_update: &str,
) -> AppResult<String> {
    if adapter.engine() == Engine::Sqlite {
        return Err(AppError::InvalidInput(
            "SQLite 不支持通过 ALTER 添加外键，需要重建表".into(),
        ));
    }
    if columns.is_empty() || columns.len() != ref_columns.len() {
        return Err(AppError::InvalidInput(
            "外键的本地列与引用列数量必须一致".into(),
        ));
    }
    let column_list: Vec<String> = columns
        .iter()
        .map(|column| adapter.quote_ident(column))
        .collect();
    let ref_list: Vec<String> = ref_columns
        .iter()
        .map(|column| adapter.quote_ident(column))
        .collect();
    let mut statement = format!(
        "ALTER TABLE {} ADD CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {} ({})",
        target,
        adapter.quote_ident(name),
        column_list.join(", "),
        adapter.quote_ident(ref_table),
        ref_list.join(", ")
    );
    if !on_delete.eq_ignore_ascii_case("NO ACTION") {
        statement.push_str(&format!(" ON DELETE {}", on_delete.to_ascii_uppercase()));
    }
    if !on_update.eq_ignore_ascii_case("NO ACTION") {
        statement.push_str(&format!(" ON UPDATE {}", on_update.to_ascii_uppercase()));
    }
    Ok(statement)
}

fn render_drop_foreign_key(adapter: &dyn DbAdapter, target: &str, name: &str) -> AppResult<String> {
    match adapter.engine() {
        Engine::Mysql => Ok(format!(
            "ALTER TABLE {} DROP FOREIGN KEY {}",
            target,
            adapter.quote_ident(name)
        )),
        Engine::Postgres => Ok(format!(
            "ALTER TABLE {} DROP CONSTRAINT {}",
            target,
            adapter.quote_ident(name)
        )),
        Engine::Sqlite => Err(AppError::InvalidInput(
            "SQLite 不支持通过 ALTER 删除外键，需要重建表".into(),
        )),
        Engine::Redis | Engine::Mongodb => Err(AppError::InvalidInput("非 SQL 引擎不支持外键操作".into())),
    }
}

pub async fn apply(
    state: &AppState,
    session_id: &str,
    database: &str,
    spec: &DdlSpec,
    force: bool,
) -> AppResult<Vec<String>> {
    let record = state.local.get_session(session_id).await?;
    if record.read_only {
        return Err(AppError::ReadOnly(
            "当前会话为只读模式，已阻止结构变更".into(),
        ));
    }

    if !force {
        match spec {
            DdlSpec::DropTable { table, .. } => {
                return Err(AppError::Dangerous(format!(
                    "即将删除表 {table}，数据不可恢复"
                )));
            }
            DdlSpec::DropColumn { column, .. } => {
                return Err(AppError::Dangerous(format!(
                    "即将删除列 {column}，数据不可恢复"
                )));
            }
            _ => {}
        }
    }

    let adapter=state.connected(session_id).await?.adapter.clone();
    if adapter.engine()==Engine::Sqlite && matches!(spec,DdlSpec::ColumnFlags{..}|DdlSpec::MoveColumn{..}|DdlSpec::DropColumn{..}) { return adapter.sqlite_schema_edit(database,spec,true).await; }
    let statements = preview(state, session_id, database, spec).await?;
    if (adapter.engine()==Engine::Postgres && matches!(spec,DdlSpec::ColumnFlags{..})) || (adapter.engine()!=Engine::Mysql && matches!(spec,DdlSpec::CreateTableDraft{..})) {
        let items=statements.iter().map(|sql|crate::adapters::SqlParams{sql:sql.clone(),params:vec![]}).collect::<Vec<_>>();
        adapter.execute_transaction(database,&items).await?;return Ok(statements);
    }
    let connected = state.connected(session_id).await?;
    connected
        .adapter
        .execute_statements(database, &statements)
        .await?;
    tracing::info!(database, statements = statements.len(), "DDL 已执行");
    Ok(statements)
}

pub async fn create_database(
    state: &AppState,
    session_id: &str,
    name: &str,
    charset: Option<String>,
    collation: Option<String>,
) -> AppResult<()> {
    let record = state.local.get_session(session_id).await?;
    if record.read_only {
        return Err(AppError::ReadOnly(
            "当前会话为只读模式，已阻止创建数据库".into(),
        ));
    }
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::InvalidInput("数据库名不能为空".into()));
    }
    let connected = state.connected(session_id).await?;
    let adapter = connected.adapter.as_ref();
    let statements = match adapter.engine() {
        Engine::Mysql => {
            let mut statement = format!("CREATE DATABASE {}", quote(adapter, name));
            if let Some(charset) = charset.as_deref().filter(|v| !v.trim().is_empty()) {
                statement.push_str(&format!(" CHARACTER SET {charset}"));
            }
            if let Some(collation) = collation.as_deref().filter(|v| !v.trim().is_empty()) {
                statement.push_str(&format!(" COLLATE {collation}"));
            }
            vec![statement]
        }
        Engine::Postgres => vec![format!("CREATE DATABASE {}", quote(adapter, name))],
        Engine::Redis | Engine::Mongodb => {
            return Err(AppError::InvalidInput(
                "Redis 使用逻辑库（0-15），不支持创建数据库".into(),
            ));
        }
        Engine::Sqlite => {
            return Err(AppError::InvalidInput(
                "SQLite 不支持创建数据库，请新建数据库文件后添加会话".into(),
            ));
        }
    };
    adapter.execute_statements("", &statements).await?;
    Ok(())
}

pub async fn drop_database(
    state: &AppState,
    session_id: &str,
    name: &str,
    force: bool,
) -> AppResult<()> {
    let record = state.local.get_session(session_id).await?;
    if record.read_only {
        return Err(AppError::ReadOnly(
            "当前会话为只读模式，已阻止删除数据库".into(),
        ));
    }
    if !force {
        return Err(AppError::Dangerous(format!(
            "即将删除数据库 {name}，其中所有数据都将丢失"
        )));
    }
    let connected = state.connected(session_id).await?;
    let adapter = connected.adapter.as_ref();
    match adapter.engine() {
        Engine::Mysql | Engine::Postgres => {
            let statement = format!("DROP DATABASE {}", quote(adapter, name));
            adapter.execute_statements("", &[statement]).await?;
            Ok(())
        }
        Engine::Sqlite => Err(AppError::InvalidInput(
            "SQLite 不支持删除数据库，请直接删除数据库文件".into(),
        )),
        Engine::Redis | Engine::Mongodb => Err(AppError::InvalidInput(
            "Redis 使用逻辑库（0-15），不支持删除数据库".into(),
        )),
    }
}

#[cfg(test)]
mod type_tests {
    use super::*;
    fn spec(name: &str) -> ColumnSpec {
        serde_json::from_value(
            serde_json::json!({"name":"value", "dataType":name, "length":255,
            "precision":3,"scale":0,"nullable":true,"primaryKey":false,"autoIncrement":false}),
        )
        .unwrap()
    }
    #[test]
    fn native_pg_types_and_canonical_compatibility() {
        for (input, expected) in [
            ("json", "JSON"),
            ("jsonb", "JSONB"),
            ("timestamp", "TIMESTAMP(3)"),
            ("timestamptz", "TIMESTAMPTZ(3)"),
            ("timetz", "TIMETZ(3)"),
            ("bytea", "bytea"),
            ("numeric", "NUMERIC(3,0)"),
            ("double precision", "double precision"),
        ] {
            assert_eq!(sql_type(Engine::Postgres, &spec(input)), expected);
        }
        assert_eq!(
            canonical_sql(Engine::Postgres, &CanonicalType::Json),
            "JSONB"
        );
        assert_eq!(sql_type(Engine::Mysql, &spec("timestamp")), "TIMESTAMP(3)");
    }
    #[test]
    fn original_types_remain_exact_when_editing_other_attributes() {
        for engine in [Engine::Postgres, Engine::Mysql, Engine::Sqlite] {
            for name in [
                "json",
                "timestamp",
                "varchar",
                "numeric",
                "datetime",
                r#""MySchema"."MyEnum"[]"#,
                "ENUM('A','B')",
            ] {
                let mut column = spec(name);
                column.preserve_type = true;
                assert_eq!(sql_type(engine, &column), name);
            }
        }
    }
    #[tokio::test]
    async fn sqlite_native_choices_create_real_columns() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        for name in ["integer", "real", "text", "blob", "numeric"] {
            let column = spec(name);
            let sql = format!(
                "CREATE TABLE t_{} (value {})",
                name,
                sql_type(Engine::Sqlite, &column)
            );
            sqlx::query(&sql).execute(&pool).await.unwrap();
        }
        pool.close().await;
    }
}

#[cfg(test)] mod table_options_tests {
 use super::*;
 #[test] fn option_tokens(){for good in ["InnoDB","utf8mb4","utf8mb4_0900_ai_ci"]{assert!(option_word(good).is_ok());}for bad in ["", "InnoDB; DROP TABLE t", "x--", "x y", "x'", "x\\"]{assert!(option_word(bad).is_err());}}
 #[tokio::test] async fn rename_and_readonly(){
  let dir=tempfile::tempdir().unwrap();let path=dir.path().join("db.sqlite");std::fs::File::create(&path).unwrap();
  let state=AppState::with_local(crate::store::LocalStore::initialize_in(dir.path().join("config")).await.unwrap());
  let input=serde_json::from_value(serde_json::json!({"name":"test","engine":"sqlite","filePath":path.to_str().unwrap(),"readOnly":false})).unwrap();
  let session=state.local.create_session(&input).await.unwrap();crate::services::session::connect(&state,&session.id).await.unwrap();
  let adapter=state.connected(&session.id).await.unwrap().adapter.clone();adapter.execute_affected("main","CREATE TABLE old_name(id INTEGER)").await.unwrap();
  let options=TableOptions{name:Some("new_name".into()),..Default::default()};let spec=DdlSpec::TableOptions{schema:None,table:"old_name".into(),options};
  assert!(preview(&state,&session.id,"main",&spec).await.unwrap()[0].contains("RENAME TO"));apply(&state,&session.id,"main",&spec,true).await.unwrap();assert!(adapter.introspect_table("main",None,"new_name").await.is_ok());
  let bad=TableOptions{engine:Some("InnoDB".into()),..Default::default()};assert!(table_options(adapter.as_ref(),"main",None,"new_name",&bad).is_err());
  state.disconnect(&session.id).await;
 }
}

#[cfg(test)] mod column_flags_tests {
 use super::*;
 #[test] fn preserve_attributes(){
 let raw="CREATE TABLE `t` (`id` bigint NOT NULL AUTO_INCREMENT, `n` int DEFAULT '0' COMMENT 'quantity', `updated` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, PRIMARY KEY (`id`))";
 let changes=vec![ColumnFlags{name:"n".into(),nullable:false,unsigned:Some(true),..Default::default()},ColumnFlags{name:"updated".into(),nullable:false,unsigned:None,..Default::default()}];
 let clauses=mysql_column_flags(raw,&changes).unwrap().join(", ");assert!(clauses.contains("UNSIGNED"));assert!(clauses.contains("COMMENT 'quantity'"));assert!(clauses.contains("ON UPDATE CURRENT_TIMESTAMP"));assert!(clauses.contains("NOT NULL"));
 assert!(mysql_column_flags(raw,&[ColumnFlags{name:"updated".into(),nullable:true,unsigned:Some(true),..Default::default()}]).is_err());
 assert!(mysql_column_flags("invalid",&changes).is_err());
 }
}

#[cfg(test)] mod inline_column_tests {
 use super::*;
 #[test] fn inline_edits(){
 let raw="CREATE TABLE t (`n` int NULL DEFAULT 1 COMMENT 'old', `ts` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)";
 let c=ColumnFlags{name:"n".into(),new_name:Some("count_new".into()),data_type:Some("bigint".into()),nullable:false,unsigned:Some(true),comment:Some("new".into()),default_mode:Some("literal".into()),default_value:Some("12".into()),..Default::default()};
 let sql=mysql_column_flags(raw,&[c]).unwrap().join(",");assert!(sql.contains("CHANGE COLUMN `n` `count_new` BIGINT UNSIGNED"));assert!(sql.contains("DEFAULT '12'"));assert!(sql.contains("COMMENT 'new'"));
 let c=ColumnFlags{name:"ts".into(),nullable:true,on_update:Some("".into()),default_mode:Some("null".into()),..Default::default()};let sql=mysql_column_flags(raw,&[c]).unwrap().join(",");assert!(!sql.contains("ON UPDATE"));assert!(sql.contains("DEFAULT NULL"));
 let c=ColumnFlags{name:"n".into(),nullable:true,data_type:Some("int); DROP TABLE t; CREATE TABLE y(c int".into()),..Default::default()};assert!(mysql_column_flags(raw,&[c]).is_err());
 }
}
