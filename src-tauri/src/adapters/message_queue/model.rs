use crate::{
    error::{AppError, AppResult},
    meta::Engine,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::Value;
pub const MAX_BODY: usize = 256 * 1024;
pub const MAX_BATCH: usize = 4 * 1024 * 1024;
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Message {
    pub id: String,
    pub timestamp: Option<String>,
    pub partition: Option<i32>,
    pub offset: Option<String>,
    pub key: Option<String>,
    pub key_base64: Option<String>,
    pub body: Option<String>,
    pub body_base64: Option<String>,
    pub bytes: usize,
    pub truncated: bool,
    pub properties_json: String,
}
impl Message {
    pub fn new(id: String, body: Option<&[u8]>, key: Option<&[u8]>, properties: Value) -> Self {
        let bytes = body.map_or(0, |b| b.len());
        let body = body.map(|b| &b[..b.len().min(MAX_BODY)]);
        let key_truncated = key.is_some_and(|v| v.len() > 8192);
        let key = key.map(|b| &b[..b.len().min(8192)]);
        Self {
            id,
            timestamp: None,
            partition: None,
            offset: None,
            key: key
                .and_then(|b| std::str::from_utf8(b).ok())
                .map(str::to_owned),
            key_base64: key.map(|b| STANDARD.encode(b)),
            body: body
                .and_then(|b| std::str::from_utf8(b).ok())
                .map(str::to_owned),
            body_base64: body.map(|b| STANDARD.encode(b)),
            bytes,
            truncated: bytes > MAX_BODY || key_truncated,
            properties_json: properties.to_string(),
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Object {
    pub name: String,
    pub kind: String,
    pub count: Option<String>,
    pub partitions: Vec<i32>,
    pub state: Option<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub engine: Engine,
    pub scopes: Vec<String>,
    pub scope: String,
    pub objects: Vec<Object>,
    pub limited: bool,
    pub clusters: Vec<String>,
    pub capabilities: Capabilities,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub read: bool,
    pub read_changes_state: bool,
    pub publish: bool,
    pub create: bool,
    pub delete: bool,
    pub purge: bool,
    pub bindings: bool,
    pub consumers: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub messages: Vec<Message>,
    pub next_offset: Option<String>,
    pub earliest_offset: Option<String>,
    pub latest_offset: Option<String>,
    pub limited: bool,
    pub notice: String,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Read {
    pub scope: String,
    pub name: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub partition: i32,
    pub offset: Option<String>,
    pub timestamp: Option<i64>,
    pub end_timestamp: Option<i64>,
    pub key: Option<String>,
    pub message_id: Option<String>,
    pub limit: u32,
    #[serde(default)]
    pub confirmed: bool,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Mutation {
    pub action: String,
    pub scope: String,
    pub name: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub confirmed: bool,
    pub partition: Option<i32>,
    pub partitions: Option<i32>,
    pub replicas: Option<i16>,
    pub cluster_name: Option<String>,
    pub key: Option<String>,
    pub key_encoding: Option<String>,
    pub body: Option<String>,
    pub encoding: Option<String>,
    pub properties_json: Option<String>,
    pub routing_key: Option<String>,
    pub exchange: Option<String>,
    pub exchange_type: Option<String>,
    pub durable: Option<bool>,
    pub tag: Option<String>,
}
pub fn invalid(s: impl Into<String>) -> AppError {
    AppError::InvalidInput(s.into())
}
pub fn name(value: &str) -> AppResult<()> {
    if value.is_empty() || value.len() > 512 || value.chars().any(char::is_control) {
        return Err(invalid("对象名称不能为空、超过 512 字节或包含控制字符"));
    }
    Ok(())
}
pub fn decode(value: &str, encoding: Option<&str>) -> AppResult<Vec<u8>> {
    if value.len() > MAX_BODY * 2 {
        return Err(invalid("输入消息超过大小限制"));
    }
    let bytes = match encoding.unwrap_or("text") {
        "text" => value.as_bytes().to_vec(),
        "base64" => STANDARD
            .decode(value)
            .map_err(|_| invalid("Base64 内容无效"))?,
        _ => return Err(invalid("编码仅支持 text 或 base64")),
    };
    if bytes.len() > MAX_BODY {
        return Err(invalid("单条测试消息最大 256 KiB"));
    }
    Ok(bytes)
}
pub fn bound(messages: Vec<Message>, limit: u32) -> (Vec<Message>, bool) {
    let total = messages.len();
    let mut bytes = 0;
    let messages = messages
        .into_iter()
        .take(limit as usize)
        .take_while(|m| {
            bytes += m.body_base64.as_ref().map_or(0, String::len) + m.properties_json.len();
            bytes <= MAX_BATCH
        })
        .collect::<Vec<_>>();
    let limited = messages.len() < total;
    (messages, limited)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn binary_null_empty_and_truncation() {
        let a = Message::new("a".into(), None, None, Value::Null);
        assert!(a.body_base64.is_none());
        let b = Message::new("b".into(), Some(b""), Some(b""), Value::Null);
        assert_eq!(b.body.as_deref(), Some(""));
        let c = Message::new("c".into(), Some(&[255]), None, Value::Null);
        assert!(c.body.is_none());
        assert_eq!(c.body_base64.as_deref(), Some("/w=="));
        assert!(
            Message::new("d".into(), Some(&vec![1; MAX_BODY + 1]), None, Value::Null).truncated
        );
        assert!(decode("!", Some("base64")).is_err());
    }
    #[test]
    fn bounds_and_names() {
        assert!(name("../队列 /?").is_ok());
        assert!(name("bad\n").is_err());
        let data = (0..30)
            .map(|i| Message::new(i.to_string(), Some(&vec![0; MAX_BODY]), None, Value::Null))
            .collect();
        let (m, b) = bound(data, 200);
        assert!(b);
        assert!(m.len() < 30);
    }
}
