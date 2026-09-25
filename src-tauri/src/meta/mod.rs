pub mod value;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Engine {
    Mysql,
    Postgres,
    Sqlite,
    Redis,
    Mongodb,
}

impl Engine {
    pub fn as_str(&self) -> &'static str {
        match self {
            Engine::Mysql => "mysql",
            Engine::Postgres => "postgres",
            Engine::Sqlite => "sqlite",
            Engine::Redis => "redis",
            Engine::Mongodb => "mongodb",
        }
    }

    pub fn parse(value: &str) -> Option<Engine> {
        match value.to_ascii_lowercase().as_str() {
            "mysql" => Some(Engine::Mysql),
            "postgres" | "postgresql" | "pgsql" => Some(Engine::Postgres),
            "sqlite" => Some(Engine::Sqlite),
            "redis" => Some(Engine::Redis),
            "mongodb" => Some(Engine::Mongodb),
            _ => None,
        }
    }

    /// 是否属于 SQL 引擎族（同步、SQL 编辑器等仅适用于 SQL 族）
    pub fn is_sql(&self) -> bool {
        matches!(self, Engine::Mysql | Engine::Postgres | Engine::Sqlite)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TableKind {
    Table,
    View,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseMeta {
    pub name: String,
    pub charset: Option<String>,
    pub collation: Option<String>,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableRef {
    pub name: String,
    pub schema: Option<String>,
    pub kind: TableKind,
    pub row_estimate: Option<u64>,
    pub comment: Option<String>,
    pub size_bytes: Option<u64>,
    pub engine: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnMeta {
    pub name: String,
    pub ordinal: u32,
    pub raw_type: String,
    pub canonical: CanonicalType,
    pub nullable: bool,
    pub default_value: Option<String>,
    pub auto_increment: bool,
    pub unsigned: bool,
    pub charset: Option<String>,
    pub collation: Option<String>,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexColumn {
    pub name: String,
    pub desc: bool,
    pub prefix_len: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexMeta {
    pub name: String,
    pub columns: Vec<IndexColumn>,
    pub unique: bool,
    pub primary: bool,
    pub method: Option<String>,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeyMeta {
    #[serde(default)]
    pub ref_database: Option<String>,
    #[serde(default)]
    pub ref_schema: Option<String>,
    pub name: String,
    pub columns: Vec<String>,
    pub ref_table: String,
    pub ref_columns: Vec<String>,
    pub on_delete: String,
    pub on_update: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableMeta {
    pub name: String,
    pub schema: Option<String>,
    pub kind: TableKind,
    pub columns: Vec<ColumnMeta>,
    pub primary_key: Vec<String>,
    pub indexes: Vec<IndexMeta>,
    pub foreign_keys: Vec<ForeignKeyMeta>,
    pub comment: Option<String>,
    pub row_estimate: Option<u64>,
    pub raw_ddl: Option<String>,
}

/// 引擎特有补充信息（MySQL 引擎/字符集/自增值/时间，SQLite 自增值等）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableExtraInfo {
    pub engine: Option<String>,
    pub charset: Option<String>,
    pub collation: Option<String>,
    pub auto_increment_value: Option<u64>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub data_size: Option<u64>,
    pub index_size: Option<u64>,
    pub total_size: Option<u64>,
}

/// 表基础信息（供「信息」页签展示）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableInfo {
    pub name: String,
    pub database: String,
    pub schema: Option<String>,
    pub kind: TableKind,
    pub comment: Option<String>,
    pub row_estimate: Option<u64>,
    pub column_count: usize,
    pub index_count: usize,
    pub foreign_key_count: usize,
    pub primary_key: Vec<String>,
    pub auto_increment_column: Option<String>,
    pub extra: TableExtraInfo,
}

/// Redis 服务器信息条目（按 INFO 分节）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InfoEntry {
    pub section: String,
    pub key: String,
    pub value: String,
}

/// Redis 逻辑库信息
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisDatabaseInfo {
    pub index: u32,
    pub keys: u64,
}

/// 字符集信息（MySQL 建库选择用）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CharsetMeta {
    pub charset: String,
    pub default_collation: Option<String>,
}

/// Redis 键摘要（SCAN 结果 + TYPE/PTTL/MEMORY USAGE）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisKeyInfo {
    pub key: String,
    /// string / list / set / zset / hash / stream / none
    pub kind: String,
    /// 毫秒；-1 永久，-2 键不存在
    pub ttl_ms: i64,
    pub size: Option<u64>,
}

/// Redis SCAN 分页结果（cursor 为 0 表示迭代结束）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisScanPage {
    pub cursor: u64,
    pub keys: Vec<RedisKeyInfo>,
}

/// Redis 键预览条目：field 用于 hash（字段名）、zset（成员）；score 用于 zset
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisPreviewEntry {
    pub field: Option<String>,
    pub value: String,
    pub score: Option<f64>,
}

/// Redis 键预览（只读，R3 提供编辑）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisKeyPreview {
    pub next_cursor: Option<String>,
    pub key: String,
    pub kind: String,
    pub ttl_ms: i64,
    pub size: Option<u64>,
    pub encoding: Option<String>,
    /// 元素总数（string 为字节长度）
    pub length: Option<u64>,
    /// 是否只返回了部分元素
    pub truncated: bool,
    /// 值含非 UTF-8 字节，已按十六进制展示
    pub binary: bool,
    pub entries: Vec<RedisPreviewEntry>,
}

/// Redis stream 字段键值对
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisFieldPair {
    pub field: String,
    pub value: String,
}

/// Redis 键编辑操作（R3）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum RedisEditOp {
    /// 写入字符串值（ttlMs 为空时保留原 TTL）
    SetString {
        value: String,
        ttl_ms: Option<i64>,
    },
    /// 列表头/尾插入
    ListPush {
        value: String,
        head: bool,
    },
    /// 按索引改写列表元素
    ListSet {
        index: i64,
        value: String,
    },
    /// 删除列表元素（count=0 全部，>0 从头删 count 个，<0 从尾）
    ListRemove {
        value: String,
        count: i64,
    },
    /// 集合添加成员
    SetAdd {
        member: String,
    },
    /// 集合移除成员
    SetRemove {
        member: String,
    },
    /// 有序集合添加/更新成员
    ZAdd {
        member: String,
        score: f64,
    },
    /// 有序集合移除成员
    ZRemove {
        member: String,
    },
    /// 哈希设置字段
    HashSet {
        field: String,
        value: String,
    },
    /// 哈希删除字段
    HashRemove {
        field: String,
    },
    /// 流追加条目
    StreamAdd {
        fields: Vec<RedisFieldPair>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CanonicalType {
    Bool,
    Int {
        bits: u8,
        unsigned: bool,
    },
    Decimal {
        precision: Option<u8>,
        scale: Option<u8>,
    },
    Float {
        bits: u8,
    },
    String {
        len: Option<u32>,
    },
    Binary {
        len: Option<u32>,
    },
    Date,
    Time {
        precision: Option<u8>,
        tz: bool,
    },
    DateTime {
        precision: Option<u8>,
        tz: bool,
    },
    Json,
    Uuid,
    Enum {
        values: Vec<String>,
    },
    Unknown {
        raw: String,
    },
}

fn split_type(raw: &str) -> (String, Vec<String>) {
    let trimmed = raw.trim().to_ascii_lowercase();
    if let Some(idx) = trimmed.find('(') {
        let name = trimmed[..idx].trim().to_string();
        let args = trimmed[idx + 1..]
            .trim_end_matches(')')
            .split(',')
            .map(|s| s.trim().trim_matches('\'').trim_matches('"').to_string())
            .collect();
        (name, args)
    } else {
        (trimmed, Vec::new())
    }
}

fn first_u32(args: &[String]) -> Option<u32> {
    args.first().and_then(|v| v.parse().ok())
}

fn first_u8(args: &[String]) -> Option<u8> {
    args.first().and_then(|v| v.parse().ok())
}

impl CanonicalType {
    pub fn from_mysql(raw: &str) -> CanonicalType {
        let lower = raw.trim().to_ascii_lowercase();
        let unsigned = lower.contains("unsigned");
        let cleaned = lower
            .replace("unsigned", "")
            .replace("zerofill", "")
            .trim()
            .to_string();
        let (name, args) = split_type(&cleaned);
        match name.as_str() {
            "tinyint" if args.first().map(|s| s.as_str()) == Some("1") => CanonicalType::Bool,
            "bool" | "boolean" => CanonicalType::Bool,
            "tinyint" | "smallint" | "mediumint" | "int" | "integer" | "bigint" => {
                let bits = match name.as_str() {
                    "tinyint" => 8,
                    "smallint" => 16,
                    "mediumint" => 24,
                    "bigint" => 64,
                    _ => 32,
                };
                CanonicalType::Int { bits, unsigned }
            }
            "decimal" | "numeric" => CanonicalType::Decimal {
                precision: args.first().and_then(|v| v.parse().ok()),
                scale: args.get(1).and_then(|v| v.parse().ok()),
            },
            "float" => CanonicalType::Float { bits: 32 },
            "double" | "real" => CanonicalType::Float { bits: 64 },
            "varchar" | "char" | "varbinary" | "binary" => {
                if name.ends_with("binary") {
                    CanonicalType::Binary {
                        len: first_u32(&args),
                    }
                } else {
                    CanonicalType::String {
                        len: first_u32(&args),
                    }
                }
            }
            "tinytext" | "text" | "mediumtext" | "longtext" => {
                CanonicalType::String { len: None }
            }
            "tinyblob" | "blob" | "mediumblob" | "longblob" => {
                CanonicalType::Binary { len: None }
            }
            "date" => CanonicalType::Date,
            "time" => CanonicalType::Time {
                precision: first_u8(&args),
                tz: false,
            },
            "datetime" => CanonicalType::DateTime {
                precision: first_u8(&args),
                tz: false,
            },
            "timestamp" => CanonicalType::DateTime {
                precision: first_u8(&args),
                tz: true,
            },
            "json" => CanonicalType::Json,
            "enum" | "set" => CanonicalType::Enum { values: args },
            _ => CanonicalType::Unknown {
                raw: raw.trim().to_string(),
            },
        }
    }

    pub fn from_postgres(raw: &str) -> CanonicalType {
        let lower = raw.trim().to_ascii_lowercase();
        let (base, args) = split_type(&lower);
        let base = base.trim().to_string();
        match base.as_str() {
            "boolean" | "bool" => CanonicalType::Bool,
            "smallint" | "int2" => CanonicalType::Int {
                bits: 16,
                unsigned: false,
            },
            "integer" | "int" | "int4" => CanonicalType::Int {
                bits: 32,
                unsigned: false,
            },
            "bigint" | "int8" => CanonicalType::Int {
                bits: 64,
                unsigned: false,
            },
            "numeric" | "decimal" => CanonicalType::Decimal {
                precision: args.first().and_then(|v| v.parse().ok()),
                scale: args.get(1).and_then(|v| v.parse().ok()),
            },
            "real" | "float4" => CanonicalType::Float { bits: 32 },
            "double precision" | "float8" => CanonicalType::Float { bits: 64 },
            "character varying" | "varchar" => CanonicalType::String {
                len: first_u32(&args),
            },
            "character" | "char" | "bpchar" => CanonicalType::String {
                len: first_u32(&args),
            },
            "text" => CanonicalType::String { len: None },
            "bytea" => CanonicalType::Binary { len: None },
            "date" => CanonicalType::Date,
            "time" | "time without time zone" => CanonicalType::Time {
                precision: first_u8(&args),
                tz: false,
            },
            "time with time zone" | "timetz" => CanonicalType::Time {
                precision: first_u8(&args),
                tz: true,
            },
            "timestamp" | "timestamp without time zone" => CanonicalType::DateTime {
                precision: first_u8(&args),
                tz: false,
            },
            "timestamp with time zone" | "timestamptz" => CanonicalType::DateTime {
                precision: first_u8(&args),
                tz: true,
            },
            "json" => CanonicalType::Json,
            "jsonb" => CanonicalType::Json,
            "uuid" => CanonicalType::Uuid,
            _ => CanonicalType::Unknown {
                raw: raw.trim().to_string(),
            },
        }
    }

    pub fn from_sqlite(raw: &str) -> CanonicalType {
        let lower = raw.trim().to_ascii_lowercase();
        if lower.is_empty() {
            return CanonicalType::Unknown {
                raw: raw.to_string(),
            };
        }
        let (name, args) = split_type(&lower);
        if lower.contains("bool") {
            return CanonicalType::Bool;
        }
        if lower.contains("int") {
            return CanonicalType::Int {
                bits: 64,
                unsigned: false,
            };
        }
        if lower.contains("char") || lower.contains("clob") || lower.contains("text") {
            return CanonicalType::String {
                len: first_u32(&args),
            };
        }
        if lower.contains("blob") {
            return CanonicalType::Binary { len: None };
        }
        if lower.contains("real") || lower.contains("floa") || lower.contains("doub") {
            return CanonicalType::Float { bits: 64 };
        }
        if lower.contains("dec") || lower.contains("num") {
            return CanonicalType::Decimal {
                precision: args.first().and_then(|v| v.parse().ok()),
                scale: args.get(1).and_then(|v| v.parse().ok()),
            };
        }
        if lower.contains("date") && lower.contains("time") {
            return CanonicalType::DateTime {
                precision: None,
                tz: false,
            };
        }
        if lower.contains("date") {
            return CanonicalType::Date;
        }
        if lower.contains("time") {
            return CanonicalType::Time {
                precision: None,
                tz: false,
            };
        }
        match name.as_str() {
            "json" => CanonicalType::Json,
            _ => CanonicalType::Unknown {
                raw: raw.trim().to_string(),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::CanonicalType;

    #[test]
    fn mysql_types() {
        assert_eq!(
            CanonicalType::from_mysql("tinyint(1)"),
            CanonicalType::Bool
        );
        assert_eq!(
            CanonicalType::from_mysql("int unsigned"),
            CanonicalType::Int {
                bits: 32,
                unsigned: true
            }
        );
        assert_eq!(
            CanonicalType::from_mysql("varchar(255)"),
            CanonicalType::String { len: Some(255) }
        );
        assert_eq!(
            CanonicalType::from_mysql("decimal(10,2)"),
            CanonicalType::Decimal {
                precision: Some(10),
                scale: Some(2)
            }
        );
    }

    #[test]
    fn postgres_types() {
        assert_eq!(
            CanonicalType::from_postgres("timestamp with time zone"),
            CanonicalType::DateTime {
                precision: None,
                tz: true
            }
        );
        assert_eq!(
            CanonicalType::from_postgres("character varying(120)"),
            CanonicalType::String { len: Some(120) }
        );
    }

    #[test]
    fn sqlite_types() {
        assert_eq!(
            CanonicalType::from_sqlite("INTEGER"),
            CanonicalType::Int {
                bits: 64,
                unsigned: false
            }
        );
        assert_eq!(
            CanonicalType::from_sqlite("DATETIME"),
            CanonicalType::DateTime {
                precision: None,
                tz: false
            }
        );
    }
}
