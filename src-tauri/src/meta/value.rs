use serde::de::{Deserialize, Deserializer, Error as DeError, SeqAccess, Visitor};
use serde::ser::{Serialize, SerializeTuple, Serializer};
use std::fmt;

/// 统一值模型：查询结果、数据对比、网格编辑共用。
/// IPC 序列化为紧凑二元组：["int", 123] / ["null", null]。
#[derive(Debug, Clone, PartialEq)]
pub enum DbValue {
    Null,
    Bool(bool),
    Int(i64),
    UInt(u64),
    Float(f64),
    Decimal(String),
    Text(String),
    Bytes(Vec<u8>),
    Date(String),
    Time(String),
    DateTime(String),
    Json(String),
    Uuid(String),
    /// 超长文本/二进制字段的截断预览，只读展示，不参与编辑提交
    Truncated(String),
    /// 扩展类型的只读文本或明确的解析失败提示，不能作为写入值。
    ReadOnly(String),
}

impl DbValue {
    fn tag(&self) -> &'static str {
        match self {
            DbValue::Null => "null",
            DbValue::Bool(_) => "bool",
            DbValue::Int(_) => "int",
            DbValue::UInt(_) => "uint",
            DbValue::Float(_) => "float",
            DbValue::Decimal(_) => "decimal",
            DbValue::Text(_) => "text",
            DbValue::Bytes(_) => "bytes",
            DbValue::Date(_) => "date",
            DbValue::Time(_) => "time",
            DbValue::DateTime(_) => "datetime",
            DbValue::Json(_) => "json",
            DbValue::Uuid(_) => "uuid",
            DbValue::Truncated(_) => "trunc",
            DbValue::ReadOnly(_) => "readonly",
        }
    }
}

impl Serialize for DbValue {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut tuple = serializer.serialize_tuple(2)?;
        tuple.serialize_element(self.tag())?;
        match self {
            DbValue::Null => tuple.serialize_element(&Option::<u8>::None)?,
            DbValue::Bool(v) => tuple.serialize_element(v)?,
            DbValue::Int(v) if v.unsigned_abs() > 9_007_199_254_740_991 => {
                tuple.serialize_element(&v.to_string())?
            }
            DbValue::Int(v) => tuple.serialize_element(v)?,
            DbValue::UInt(v) if *v > 9_007_199_254_740_991 => {
                tuple.serialize_element(&v.to_string())?
            }
            DbValue::UInt(v) => tuple.serialize_element(v)?,
            DbValue::Float(v) => tuple.serialize_element(v)?,
            DbValue::Decimal(v)
            | DbValue::Text(v)
            | DbValue::Date(v)
            | DbValue::Time(v)
            | DbValue::DateTime(v)
            | DbValue::Json(v)
            | DbValue::Uuid(v)
            | DbValue::Truncated(v) | DbValue::ReadOnly(v) => tuple.serialize_element(v)?,
            DbValue::Bytes(v) => tuple.serialize_element(&hex_encode(v))?,
        }
        tuple.end()
    }
}

impl<'de> Deserialize<'de> for DbValue {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct DbValueVisitor;

        impl<'de> Visitor<'de> for DbValueVisitor {
            type Value = DbValue;

            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("a DbValue encoded as [tag, value]")
            }

            fn visit_seq<A>(self, mut seq: A) -> Result<DbValue, A::Error>
            where
                A: SeqAccess<'de>,
            {
                let tag: String = seq
                    .next_element()?
                    .ok_or_else(|| A::Error::invalid_length(0, &self))?;
                let value: serde_json::Value = seq
                    .next_element()?
                    .unwrap_or(serde_json::Value::Null);

                let expect_str = |value: &serde_json::Value| -> Result<String, A::Error> {
                    value
                        .as_str()
                        .map(str::to_string)
                        .ok_or_else(|| A::Error::custom("expected string value"))
                };

                match tag.as_str() {
                    "null" => Ok(DbValue::Null),
                    "bool" => value
                        .as_bool()
                        .map(DbValue::Bool)
                        .ok_or_else(|| A::Error::custom("expected bool value")),
                    "int" => {
                        if let Some(v) = value.as_i64() {
                            if v.unsigned_abs() <= 9_007_199_254_740_991 {
                                Ok(DbValue::Int(v))
                            } else {
                                Err(A::Error::custom("unsafe int number; send decimal text"))
                            }
                        } else if let Some(v) = value.as_str() {
                            v.parse::<i64>().map(DbValue::Int).map_err(|_| A::Error::custom("invalid int"))
                        } else {
                            Err(A::Error::custom("invalid int"))
                        }
                    }
                    "uint" => {
                        if let Some(v) = value.as_u64() {
                            if v <= 9_007_199_254_740_991 {
                                Ok(DbValue::UInt(v))
                            } else {
                                Err(A::Error::custom("unsafe uint number; send decimal text"))
                            }
                        } else if let Some(v) = value.as_str() {
                            v.parse::<u64>().map(DbValue::UInt).map_err(|_| A::Error::custom("invalid uint"))
                        } else {
                            Err(A::Error::custom("invalid uint"))
                        }
                    }
                    "float" => {
                        if let Some(v) = value.as_f64() {
                            Ok(DbValue::Float(v))
                        } else if let Ok(v) = expect_str(&value)
                            .and_then(|s| s.parse::<f64>().map_err(|_| A::Error::custom("invalid float")))
                        {
                            Ok(DbValue::Float(v))
                        } else {
                            Ok(DbValue::Null)
                        }
                    }
                    "decimal" => Ok(DbValue::Decimal(expect_str(&value)?)),
                    "text" => Ok(DbValue::Text(expect_str(&value)?)),
                    "date" => Ok(DbValue::Date(expect_str(&value)?)),
                    "time" => Ok(DbValue::Time(expect_str(&value)?)),
                    "datetime" => Ok(DbValue::DateTime(expect_str(&value)?)),
                    "json" => Ok(DbValue::Json(expect_str(&value)?)),
                    "uuid" => Ok(DbValue::Uuid(expect_str(&value)?)),
                    "readonly" => Ok(DbValue::ReadOnly(expect_str(&value)?)),
                    "trunc" => Ok(DbValue::Truncated(expect_str(&value)?)),
                    "bytes" => {
                        let text = expect_str(&value)?;
                        Ok(DbValue::Bytes(hex_decode(&text).map_err(A::Error::custom)?))
                    }
                    other => Err(A::Error::custom(format!("unknown DbValue tag: {other}"))),
                }
            }
        }

        deserializer.deserialize_tuple(2, DbValueVisitor)
    }
}

pub fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2 + 2);
    out.push_str("0x");
    for b in bytes {
        out.push_str(&format!("{:02x}", b));
    }
    out
}

/// 单元格文本预览上限（字符数），超出则标记为截断只读。
/// 所有文本类值（VARCHAR/TEXT/JSON 等）统一生效，避免超长内容进入 IPC 与 DOM。
pub const MAX_PREVIEW_CHARS: usize = 1024;
/// 二进制字段预览上限（字节数）
pub const MAX_PREVIEW_BYTES: usize = 256;

pub fn preview_text(value: String) -> DbValue {
    if value.chars().take(MAX_PREVIEW_CHARS + 1).count() > MAX_PREVIEW_CHARS {
        let truncated: String = value.chars().take(MAX_PREVIEW_CHARS).collect();
        DbValue::Truncated(truncated)
    } else {
        DbValue::Text(value)
    }
}

pub fn preview_json(value: String) -> DbValue {
    match preview_text(value) {
        DbValue::Text(v) => DbValue::Json(v),
        other => other,
    }
}

pub fn preview_bytes(bytes: Vec<u8>) -> DbValue {
    if bytes.len() > MAX_PREVIEW_BYTES {
        let head: String = bytes
            .iter()
            .take(64)
            .map(|b| format!("{b:02x}"))
            .collect();
        DbValue::Truncated(format!("0x{head}… ({} 字节)", bytes.len()))
    } else {
        DbValue::Bytes(bytes)
    }
}

pub fn hex_decode(text: &str) -> Result<Vec<u8>, String> {
    let trimmed = text
        .strip_prefix("0x")
        .or_else(|| text.strip_prefix("0X"))
        .unwrap_or(text);
    if trimmed.len() % 2 != 0 {
        return Err("十六进制长度必须为偶数".into());
    }
    (0..trimmed.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&trimmed[i..i + 2], 16).map_err(|e| e.to_string()))
        .collect()
}

#[cfg(test)]
mod readonly_tests {
    use super::*;
    #[test]
    fn readonly_roundtrip_is_not_null_or_truncated() {
        let value=DbValue::ReadOnly("[0.1,0.2]".into());
        let json=serde_json::to_string(&value).unwrap();
        assert_eq!(serde_json::from_str::<DbValue>(&json).unwrap(),value);
        assert!(json.starts_with("[\"readonly\""));
    }

    #[test]
    fn large_integers_cross_json_without_rounding() {
        for value in [DbValue::Int(9_007_199_254_740_993), DbValue::Int(i64::MIN), DbValue::UInt(u64::MAX)] {
            let json = serde_json::to_string(&value).unwrap();
            assert!(json.contains("\",\""), "large integer should use a string payload: {json}");
            assert_eq!(serde_json::from_str::<DbValue>(&json).unwrap(), value);
        }
        assert_eq!(serde_json::to_string(&DbValue::Int(9_007_199_254_740_991)).unwrap(), "[\"int\",9007199254740991]");
        for unsafe_value in [
            "[\"int\",9007199254740993]",
            "[\"uint\",9007199254740993]",
            "[\"int\",\"9223372036854775808\"]",
            "[\"uint\",-1]",
        ] {
            assert!(serde_json::from_str::<DbValue>(unsafe_value).is_err());
        }
    }
}
