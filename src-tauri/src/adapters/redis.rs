use async_trait::async_trait;
use redis::aio::ConnectionManager;
use redis::Client;
use std::collections::HashMap;
use tokio::sync::Mutex;

use crate::error::{AppError, AppResult};
use crate::meta::{
    DatabaseMeta, Engine, InfoEntry, RedisDatabaseInfo, RedisEditOp, RedisKeyInfo,
    RedisKeyPreview, RedisPreviewEntry, RedisScanPage, TableExtraInfo, TableMeta, TableRef,
};

use super::key_value::KeyValueAdapter;
use super::{ConnectionParams, DbAdapter, QueryContext, QueryOutcome, SqlParams};

const DEFAULT_REDIS_PORT: u16 = 6379;
const MAX_DATABASES: u32 = 256;

fn value_str(value: &redis::Value) -> Option<String> {
    match value {
        redis::Value::SimpleString(text) => Some(text.clone()),
        redis::Value::BulkString(bytes) => Some(String::from_utf8_lossy(bytes).to_string()),
        redis::Value::VerbatimString { text, .. } => Some(text.clone()),
        redis::Value::Int(number) => Some(number.to_string()),
        _ => None,
    }
}

fn value_i64(value: &redis::Value) -> Option<i64> {
    match value {
        redis::Value::Int(number) => Some(*number),
        redis::Value::SimpleString(text) => text.parse::<i64>().ok(),
        redis::Value::BulkString(bytes) => text_str(bytes).parse::<i64>().ok(),
        _ => None,
    }
}

fn text_str(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).to_string()
}

fn value_text(value: &redis::Value) -> Option<(String, bool)> {
    match value {
        redis::Value::BulkString(bytes) => match std::str::from_utf8(bytes) {
            Ok(text) => Some((text.to_string(), false)),
            Err(_) => Some((hex_encode(bytes), true)),
        },
        redis::Value::SimpleString(text) => Some((text.clone(), false)),
        redis::Value::VerbatimString { text, .. } => Some((text.clone(), false)),
        redis::Value::Int(number) => Some((number.to_string(), false)),
        redis::Value::Double(number) => Some((number.to_string(), false)),
        redis::Value::Boolean(flag) => Some((flag.to_string(), false)),
        redis::Value::Nil => None,
        _ => Some((format!("{value:?}"), false)),
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn value_f64(value: &redis::Value) -> Option<f64> {
    match value {
        redis::Value::Double(number) => Some(*number),
        redis::Value::SimpleString(text) => text.parse::<f64>().ok(),
        redis::Value::BulkString(bytes) => text_str(bytes).parse::<f64>().ok(),
        redis::Value::Int(number) => Some(*number as f64),
        _ => None,
    }
}

fn values_array(value: &redis::Value) -> Vec<redis::Value> {
    match value {
        redis::Value::Array(items) | redis::Value::Set(items) => items.clone(),
        _ => Vec::new(),
    }
}

fn scan_reply(reply: &redis::Value) -> AppResult<(Option<String>, Vec<redis::Value>)> {
    let parts = values_array(reply);
    let cursor = parts.first().and_then(value_str).ok_or_else(|| AppError::InvalidInput("扫描响应缺少游标".into()))?;
    let numeric = cursor.parse::<u64>().map_err(|_| AppError::InvalidInput("扫描响应游标无效".into()))?;
    let items = parts.get(1).ok_or_else(|| AppError::InvalidInput("扫描响应缺少成员".into()))?;
    Ok(((numeric != 0).then_some(cursor), values_array(items)))
}

#[cfg(test)]
mod pagination_tests {
    use super::*;
    #[test]
    fn scan_preserves_cursor_precision_and_complete_batch() {
        let reply = redis::Value::Array(vec![redis::Value::BulkString(b"18446744073709551615".to_vec()), redis::Value::Array((0..150).map(redis::Value::Int).collect())]);
        let (cursor, entries) = scan_reply(&reply).unwrap();
        assert_eq!(cursor.as_deref(), Some("18446744073709551615"));
        assert_eq!(entries.len(), 150);
        let end = redis::Value::Array(vec![redis::Value::BulkString(b"0".to_vec()), redis::Value::Array(vec![])]);
        assert!(scan_reply(&end).unwrap().0.is_none());
        assert!(scan_reply(&redis::Value::Nil).is_err());
    }
}

pub struct RedisAdapter {
    params: ConnectionParams,
    managers: Mutex<HashMap<u32, ConnectionManager>>,
    databases: u32,
}

fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        let ch = *byte as char;
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '~') {
            out.push(ch);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn build_url(params: &ConnectionParams, db: u32) -> AppResult<String> {
    let host = params
        .host
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::InvalidInput("Redis 主机地址不能为空".into()))?;
    let port = params.port.unwrap_or(DEFAULT_REDIS_PORT);
    let scheme = if params.tls.unwrap_or(false) {
        "rediss"
    } else {
        "redis"
    };

    let credentials = match (
        params.username.as_deref().filter(|value| !value.is_empty()),
        params.password.as_deref().filter(|value| !value.is_empty()),
    ) {
        (Some(username), Some(password)) => {
            format!(
                "{}:{}@",
                percent_encode(username),
                percent_encode(password)
            )
        }
        (None, Some(password)) => format!(":{}@", percent_encode(password)),
        _ => String::new(),
    };

    Ok(format!(
        "{scheme}://{credentials}{host}:{port}/{db}"
    ))
}

impl RedisAdapter {
    pub async fn connect(params: &ConnectionParams) -> AppResult<Self> {
        let default_db = params.redis_db.unwrap_or(0) as u32;
        let url = build_url(params, default_db)?;
        let client = Client::open(url).map_err(redis_error)?;
        let manager = client
            .get_connection_manager_with_config(redis::aio::ConnectionManagerConfig::new().set_connection_timeout(Some(super::connect_timeout(params))).set_response_timeout(Some(std::time::Duration::from_secs(params.network.query_timeout()))))
            .await
            .map_err(redis_error)?;

        let mut managers = HashMap::new();
        managers.insert(default_db, manager);

        let adapter = Self {
            params: params.clone(),
            managers: Mutex::new(managers),
            databases: 16,
        };

        let databases = adapter.fetch_database_count().await.unwrap_or(16);
        Ok(Self {
            params: adapter.params,
            managers: adapter.managers,
            databases,
        })
    }

    async fn manager_for(&self, db: u32) -> AppResult<ConnectionManager> {
        let mut managers = self.managers.lock().await;
        if let Some(manager) = managers.get(&db) {
            return Ok(manager.clone());
        }
        let params=&self.params;
        let url = build_url(params, db)?;
        let client = Client::open(url).map_err(redis_error)?;
        let manager = client
            .get_connection_manager()
            .await
            .map_err(redis_error)?;
        managers.insert(db, manager.clone());
        Ok(manager)
    }

    async fn fetch_database_count(&self) -> AppResult<u32> {
        let mut manager = self.manager_for(self.params.redis_db.unwrap_or(0) as u32).await?;
        let value: Option<String> = redis::cmd("CONFIG")
            .arg("GET")
            .arg("databases")
            .query_async(&mut manager)
            .await
            .ok()
            .flatten();
        Ok(value
            .and_then(|text| text.parse::<u32>().ok())
            .unwrap_or(16)
            .clamp(1, MAX_DATABASES))
    }
}

fn redis_error(error: redis::RedisError) -> AppError {
    let text = error.to_string();
    let connection_like = error.is_io_error()
        || error.is_connection_refusal()
        || error.is_timeout()
        || text.contains("WRONGPASS")
        || text.contains("NOAUTH")
        || text.contains("invalid password")
        || text.contains("AUTH");
    if connection_like {
        AppError::Connection(text)
    } else {
        AppError::Database(text)
    }
}

fn parse_info(text: &str) -> Vec<InfoEntry> {
    let mut entries = Vec::new();
    let mut section = "Server".to_string();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(name) = line.strip_prefix('#') {
            section = name.trim().to_string();
            continue;
        }
        if let Some((key, value)) = line.split_once(':') {
            entries.push(InfoEntry {
                section: section.clone(),
                key: key.trim().to_string(),
                value: value.trim().to_string(),
            });
        }
    }
    entries
}

#[async_trait]
impl KeyValueAdapter for RedisAdapter {
    fn engine(&self) -> Engine {
        Engine::Redis
    }

    async fn ping(&self) -> AppResult<()> {
        let mut manager = self
            .manager_for(self.params.redis_db.unwrap_or(0) as u32)
            .await?;
        let _: String = redis::cmd("PING")
            .query_async(&mut manager)
            .await
            .map_err(redis_error)?;
        Ok(())
    }

    async fn server_info(&self) -> AppResult<Vec<InfoEntry>> {
        let mut manager = self
            .manager_for(self.params.redis_db.unwrap_or(0) as u32)
            .await?;
        let text: String = redis::cmd("INFO")
            .query_async(&mut manager)
            .await
            .map_err(redis_error)?;
        Ok(parse_info(&text))
    }

    async fn list_databases(&self) -> AppResult<Vec<RedisDatabaseInfo>> {
        let mut result = Vec::new();
        for index in 0..self.databases {
            let size: u64 = match self.manager_for(index).await {
                Ok(mut manager) => redis::cmd("DBSIZE")
                    .query_async(&mut manager)
                    .await
                    .unwrap_or(0),
                Err(_) => 0,
            };
            result.push(RedisDatabaseInfo { index, keys: size });
        }
        Ok(result)
    }

    async fn command(&self, db: u32, args: &[String]) -> AppResult<serde_json::Value> {
        if args.is_empty() {
            return Err(AppError::InvalidInput("命令不能为空".into()));
        }
        let mut manager = self.manager_for(db).await?;
        let mut cmd = redis::cmd(&args[0]);
        for arg in &args[1..] {
            cmd.arg(arg);
        }
        let value: redis::Value = cmd.query_async(&mut manager).await.map_err(redis_error)?;
        Ok(redis_value_to_json(&value))
    }

    async fn scan_page(
        &self,
        db: u32,
        cursor: u64,
        pattern: &str,
        key_type: Option<&str>,
        count: u32,
    ) -> AppResult<RedisScanPage> {
        let mut manager = self.manager_for(db).await?;
        let pattern = pattern.trim();
        let mut cmd = redis::cmd("SCAN");
        cmd.arg(cursor)
            .arg("MATCH")
            .arg(if pattern.is_empty() { "*" } else { pattern });
        if let Some(kind) = key_type.filter(|value| !value.is_empty()) {
            cmd.arg("TYPE").arg(kind);
        }
        cmd.arg("COUNT").arg(count.clamp(1, 1000));
        let value: redis::Value = cmd.query_async(&mut manager).await.map_err(redis_error)?;
        let parts = values_array(&value);
        if parts.len() < 2 {
            return Err(AppError::Database("SCAN 返回格式异常".into()));
        }
        let next_cursor = value_str(&parts[0])
            .and_then(|text| text.parse::<u64>().ok())
            .unwrap_or(0);
        let keys: Vec<String> = values_array(&parts[1])
            .iter()
            .filter_map(value_str)
            .collect();
        if keys.is_empty() {
            return Ok(RedisScanPage {
                cursor: next_cursor,
                keys: Vec::new(),
            });
        }

        let mut pipe = redis::pipe();
        for key in &keys {
            pipe.cmd("TYPE")
                .arg(key)
                .cmd("PTTL")
                .arg(key)
                .cmd("MEMORY")
                .arg("USAGE")
                .arg(key);
        }
        let values: Vec<redis::Value> = pipe.query_async(&mut manager).await.map_err(redis_error)?;
        let mut result = Vec::with_capacity(keys.len());
        for (index, key) in keys.into_iter().enumerate() {
            let base = index * 3;
            let kind = values
                .get(base)
                .and_then(value_str)
                .unwrap_or_else(|| "none".into());
            let ttl_ms = values.get(base + 1).and_then(value_i64).unwrap_or(-2);
            let size = values
                .get(base + 2)
                .and_then(value_i64)
                .filter(|value| *value > 0)
                .map(|value| value as u64);
            result.push(RedisKeyInfo {
                key,
                kind,
                ttl_ms,
                size,
            });
        }
        Ok(RedisScanPage {
            cursor: next_cursor,
            keys: result,
        })
    }

    async fn key_preview(&self, db: u32, key: &str, limit: u32, cursor: Option<&str>) -> AppResult<RedisKeyPreview> {
        let limit = limit.clamp(1, 1_000_000) as usize;
        let entry_limit = limit.min(1000);
        let mut manager = self.manager_for(db).await?;
        let kind: String = redis::cmd("TYPE")
            .arg(key)
            .query_async(&mut manager)
            .await
            .map_err(redis_error)?;
        if kind == "none" {
            return Err(AppError::NotFound(format!("键 {key} 不存在")));
        }
        let ttl_ms = redis::cmd("PTTL")
            .arg(key)
            .query_async::<Option<i64>>(&mut manager)
            .await
            .map_err(redis_error)?
            .unwrap_or(-2);
        let size = redis::cmd("MEMORY")
            .arg("USAGE")
            .arg(key)
            .query_async::<Option<i64>>(&mut manager)
            .await
            .ok()
            .flatten()
            .filter(|value| *value > 0)
            .map(|value| value as u64);
        let encoding = redis::cmd("OBJECT")
            .arg("ENCODING")
            .arg(key)
            .query_async::<Option<String>>(&mut manager)
            .await
            .ok()
            .flatten();

        let mut preview = RedisKeyPreview {
            next_cursor: None,
            key: key.to_string(),
            kind: kind.clone(),
            ttl_ms,
            size,
            encoding,
            length: None,
            truncated: false,
            binary: false,
            entries: Vec::new(),
        };

        match kind.as_str() {
            "string" => {
                let length: i64 = redis::cmd("STRLEN")
                    .arg(key)
                    .query_async(&mut manager)
                    .await
                    .map_err(redis_error)?;
                let raw: Option<redis::Value> = redis::cmd("GETRANGE")
                    .arg(key)
                    .arg(0)
                    .arg(limit as i64 - 1)
                    .query_async(&mut manager)
                    .await
                    .map_err(redis_error)?;
                preview.length = Some(length.max(0) as u64);
                preview.truncated = length as usize > limit;
                if let Some((text, binary)) = raw.as_ref().and_then(value_text) {
                    preview.binary = binary;
                    preview.entries.push(RedisPreviewEntry {
                        field: None,
                        value: text,
                        score: None,
                    });
                }
            }
            "list" => {
                let start = cursor.unwrap_or("0").parse::<u64>().map_err(|_| AppError::InvalidInput("无效的列表游标".into()))?;
                let end = start.checked_add(entry_limit as u64).ok_or_else(|| AppError::InvalidInput("游标超出范围".into()))?;
                let length: i64 = redis::cmd("LLEN")
                    .arg(key)
                    .query_async(&mut manager)
                    .await
                    .map_err(redis_error)?;
                let items: Vec<redis::Value> = redis::cmd("LRANGE")
                    .arg(key)
                    .arg(start)
                    .arg(end - 1)
                    .query_async(&mut manager)
                    .await
                    .map_err(redis_error)?;
                preview.length = Some(length.max(0) as u64);
                preview.next_cursor = (end < length.max(0) as u64).then(|| end.to_string());
                preview.truncated = preview.next_cursor.is_some();
                for item in items.into_iter().take(entry_limit) {
                    if let Some((text, binary)) = value_text(&item) {
                        preview.binary |= binary;
                        preview.entries.push(RedisPreviewEntry {
                            field: None,
                            value: text,
                            score: None,
                        });
                    }
                }
            }
            "set" => {
                let length: i64 = redis::cmd("SCARD")
                    .arg(key)
                    .query_async(&mut manager)
                    .await
                    .map_err(redis_error)?;
                let reply: redis::Value = redis::cmd("SSCAN")
                    .arg(key)
                    .arg(cursor.unwrap_or("0"))
                    .arg("COUNT")
                    .arg(entry_limit)
                    .query_async(&mut manager)
                    .await
                    .map_err(redis_error)?;
                let (next_cursor, items) = scan_reply(&reply)?;
                preview.length = Some(length.max(0) as u64);
                preview.next_cursor = next_cursor;
                preview.truncated = preview.next_cursor.is_some();
                // COUNT 是提示值，不截掉服务端返回的数据，否则后续游标将跳过这些成员。
                for item in items {
                    if let Some((text, binary)) = value_text(&item) {
                        preview.binary |= binary;
                        preview.entries.push(RedisPreviewEntry {
                            field: None,
                            value: text,
                            score: None,
                        });
                    }
                }
            }
            "zset" => {
                let start = cursor.unwrap_or("0").parse::<u64>().map_err(|_| AppError::InvalidInput("无效的有序集合游标".into()))?;
                let end = start.checked_add(entry_limit as u64).ok_or_else(|| AppError::InvalidInput("游标超出范围".into()))?;
                let length: i64 = redis::cmd("ZCARD")
                    .arg(key)
                    .query_async(&mut manager)
                    .await
                    .map_err(redis_error)?;
                let items: Vec<redis::Value> = redis::cmd("ZRANGE")
                    .arg(key)
                    .arg(start)
                    .arg(end - 1)
                    .arg("WITHSCORES")
                    .query_async(&mut manager)
                    .await
                    .map_err(redis_error)?;
                preview.length = Some(length.max(0) as u64);
                preview.next_cursor = (end < length.max(0) as u64).then(|| end.to_string());
                preview.truncated = preview.next_cursor.is_some();
                for pair in items.chunks(2) {
                    if pair.len() < 2 {
                        break;
                    }
                    if let Some((text, binary)) = value_text(&pair[0]) {
                        preview.binary |= binary;
                        preview.entries.push(RedisPreviewEntry {
                            field: None,
                            value: text,
                            score: value_f64(&pair[1]),
                        });
                    }
                }
            }
            "hash" => {
                let length: i64 = redis::cmd("HLEN")
                    .arg(key)
                    .query_async(&mut manager)
                    .await
                    .map_err(redis_error)?;
                let reply: redis::Value = redis::cmd("HSCAN")
                    .arg(key)
                    .arg(cursor.unwrap_or("0"))
                    .arg("COUNT")
                    .arg(entry_limit)
                    .query_async(&mut manager)
                    .await
                    .map_err(redis_error)?;
                let (next_cursor, items) = scan_reply(&reply)?;
                preview.length = Some(length.max(0) as u64);
                preview.next_cursor = next_cursor;
                preview.truncated = preview.next_cursor.is_some();
                for pair in items.chunks(2) {
                    if pair.len() < 2 {
                        break;
                    }
                    let field = value_text(&pair[0]).map(|(text, _)| text);
                    if let Some((text, binary)) = value_text(&pair[1]) {
                        preview.binary |= binary;
                        preview.entries.push(RedisPreviewEntry {
                            field,
                            value: text,
                            score: None,
                        });
                    }
                }
            }
            "stream" => {
                let length: i64 = redis::cmd("XLEN")
                    .arg(key)
                    .query_async(&mut manager)
                    .await
                    .map_err(redis_error)?;
                let items: Vec<redis::Value> = redis::cmd("XRANGE")
                    .arg(key)
                    .arg(cursor.map(|value| format!("({value}")).unwrap_or_else(|| "-".into()))
                    .arg("+")
                    .arg("COUNT")
                    .arg(entry_limit)
                    .query_async(&mut manager)
                    .await
                    .map_err(redis_error)?;
                preview.length = Some(length.max(0) as u64);
                preview.next_cursor = if items.len() == entry_limit { items.last().and_then(|item| values_array(item).first().and_then(value_text)).map(|(text, _)| text) } else { None };
                preview.truncated = preview.next_cursor.is_some();
                for item in items.into_iter().take(entry_limit) {
                    let parts = values_array(&item);
                    let id = parts.first().and_then(value_text).map(|(text, _)| text);
                    let fields = parts
                        .get(1)
                        .map(values_array)
                        .unwrap_or_default()
                        .chunks(2)
                        .filter_map(|pair| {
                            if pair.len() < 2 {
                                return None;
                            }
                            let name = value_text(&pair[0]).map(|(text, _)| text)?;
                            let value = value_text(&pair[1]).map(|(text, _)| text)?;
                            Some(format!("{name}={value}"))
                        })
                        .collect::<Vec<_>>()
                        .join(", ");
                    preview.entries.push(RedisPreviewEntry {
                        field: id,
                        value: fields,
                        score: None,
                    });
                }
            }
            _ => {}
        }

        Ok(preview)
    }

    async fn create_key(&self, db: u32, key: &str, op: &RedisEditOp) -> AppResult<()> {
        let mut manager = self.manager_for(db).await?;
        let exists: i64 = redis::cmd("EXISTS")
            .arg(key)
            .query_async(&mut manager)
            .await
            .map_err(redis_error)?;
        if exists > 0 {
            return Err(AppError::InvalidInput(format!("键 {key} 已存在")));
        }
        self.edit_key(db, key, op).await
    }

    async fn edit_key(&self, db: u32, key: &str, op: &RedisEditOp) -> AppResult<()> {
        let mut manager = self.manager_for(db).await?;
        match op {
            RedisEditOp::SetString { value, ttl_ms } => {
                let mut cmd = redis::cmd("SET");
                cmd.arg(key).arg(value);
                match ttl_ms {
                    Some(ttl) if *ttl > 0 => {
                        cmd.arg("PX").arg(*ttl);
                    }
                    _ => {
                        cmd.arg("KEEPTTL");
                    }
                }
                let _: redis::Value = cmd.query_async(&mut manager).await.map_err(redis_error)?;
            }
            RedisEditOp::ListPush { value, head } => {
                let name = if *head { "LPUSH" } else { "RPUSH" };
                let _: i64 = redis::cmd(name)
                    .arg(key)
                    .arg(value)
                    .query_async(&mut manager)
                    .await
                    .map_err(redis_error)?;
            }
            RedisEditOp::ListSet { index, value } => {
                let _: redis::Value = redis::cmd("LSET")
                    .arg(key)
                    .arg(*index)
                    .arg(value)
                    .query_async(&mut manager)
                    .await
                    .map_err(redis_error)?;
            }
            RedisEditOp::ListRemove { value, count } => {
                let _: i64 = redis::cmd("LREM")
                    .arg(key)
                    .arg(*count)
                    .arg(value)
                    .query_async(&mut manager)
                    .await
                    .map_err(redis_error)?;
            }
            RedisEditOp::SetAdd { member } => {
                let _: i64 = redis::cmd("SADD")
                    .arg(key)
                    .arg(member)
                    .query_async(&mut manager)
                    .await
                    .map_err(redis_error)?;
            }
            RedisEditOp::SetRemove { member } => {
                let _: i64 = redis::cmd("SREM")
                    .arg(key)
                    .arg(member)
                    .query_async(&mut manager)
                    .await
                    .map_err(redis_error)?;
            }
            RedisEditOp::ZAdd { member, score } => {
                let _: i64 = redis::cmd("ZADD")
                    .arg(key)
                    .arg(*score)
                    .arg(member)
                    .query_async(&mut manager)
                    .await
                    .map_err(redis_error)?;
            }
            RedisEditOp::ZRemove { member } => {
                let _: i64 = redis::cmd("ZREM")
                    .arg(key)
                    .arg(member)
                    .query_async(&mut manager)
                    .await
                    .map_err(redis_error)?;
            }
            RedisEditOp::HashSet { field, value } => {
                let _: i64 = redis::cmd("HSET")
                    .arg(key)
                    .arg(field)
                    .arg(value)
                    .query_async(&mut manager)
                    .await
                    .map_err(redis_error)?;
            }
            RedisEditOp::HashRemove { field } => {
                let _: i64 = redis::cmd("HDEL")
                    .arg(key)
                    .arg(field)
                    .query_async(&mut manager)
                    .await
                    .map_err(redis_error)?;
            }
            RedisEditOp::StreamAdd { fields } => {
                if fields.is_empty() {
                    return Err(AppError::InvalidInput("流条目至少需要一个字段".into()));
                }
                let mut cmd = redis::cmd("XADD");
                cmd.arg(key).arg("*");
                for pair in fields {
                    cmd.arg(&pair.field).arg(&pair.value);
                }
                let _: redis::Value = cmd.query_async(&mut manager).await.map_err(redis_error)?;
            }
        }
        Ok(())
    }

    async fn delete_key(&self, db: u32, key: &str) -> AppResult<u64> {
        self.delete_keys(db, &[key.to_string()]).await
    }

    async fn delete_keys(&self, db: u32, keys: &[String]) -> AppResult<u64> {
        if keys.is_empty() {
            return Ok(0);
        }
        let mut manager = self.manager_for(db).await?;
        let mut deleted = 0u64;
        for chunk in keys.chunks(500) {
            let mut cmd = redis::cmd("DEL");
            for key in chunk {
                cmd.arg(key);
            }
            let count: i64 = cmd.query_async(&mut manager).await.map_err(redis_error)?;
            deleted += count.max(0) as u64;
        }
        Ok(deleted)
    }

    async fn rename_key(&self, db: u32, key: &str, new_key: &str) -> AppResult<()> {
        if new_key.trim().is_empty() {
            return Err(AppError::InvalidInput("新键名不能为空".into()));
        }
        if new_key == key {
            return Err(AppError::InvalidInput("新键名与当前键名相同".into()));
        }
        let mut manager = self.manager_for(db).await?;
        let renamed: i64 = redis::cmd("RENAMENX")
            .arg(key)
            .arg(new_key)
            .query_async(&mut manager)
            .await
            .map_err(redis_error)?;
        if renamed == 0 {
            return Err(AppError::InvalidInput(format!("目标键 {new_key} 已存在")));
        }
        Ok(())
    }

    async fn set_ttl(&self, db: u32, key: &str, ttl_ms: Option<i64>) -> AppResult<i64> {
        let mut manager = self.manager_for(db).await?;
        match ttl_ms {
            Some(ttl) if ttl > 0 => {
                let applied: i64 = redis::cmd("PEXPIRE")
                    .arg(key)
                    .arg(ttl)
                    .query_async(&mut manager)
                    .await
                    .map_err(redis_error)?;
                if applied == 0 {
                    return Err(AppError::NotFound(format!("键 {key} 不存在")));
                }
            }
            _ => {
                let applied: i64 = redis::cmd("PERSIST")
                    .arg(key)
                    .query_async(&mut manager)
                    .await
                    .map_err(redis_error)?;
                if applied == 0 {
                    let exists: i64 = redis::cmd("EXISTS")
                        .arg(key)
                        .query_async(&mut manager)
                        .await
                        .map_err(redis_error)?;
                    if exists == 0 {
                        return Err(AppError::NotFound(format!("键 {key} 不存在")));
                    }
                }
            }
        }
        let ttl: i64 = redis::cmd("PTTL")
            .arg(key)
            .query_async(&mut manager)
            .await
            .map_err(redis_error)?;
        Ok(ttl)
    }
}

fn redis_value_to_json(value: &redis::Value) -> serde_json::Value {
    use serde_json::Value as Json;
    match value {
        redis::Value::Nil => Json::Null,
        redis::Value::Int(number) => Json::from(*number),
        redis::Value::Double(number) => Json::from(*number),
        redis::Value::Boolean(flag) => Json::from(*flag),
        redis::Value::SimpleString(text) => Json::from(text.clone()),
        redis::Value::Okay => Json::from("OK"),
        redis::Value::BulkString(bytes) => Json::from(String::from_utf8_lossy(bytes).to_string()),
        redis::Value::VerbatimString { text, .. } => Json::from(text.clone()),
        redis::Value::BigNumber(number) => Json::from(number.to_string()),
        redis::Value::Array(items) => {
            Json::Array(items.iter().map(redis_value_to_json).collect())
        }
        redis::Value::Set(items) => Json::Array(items.iter().map(redis_value_to_json).collect()),
        redis::Value::Map(pairs) => {
            let mut object = serde_json::Map::new();
            for (key, item) in pairs {
                object.insert(redis_value_to_json(key).to_string(), redis_value_to_json(item));
            }
            Json::Object(object)
        }
        _ => Json::Null,
    }
}

/// Redis 也实现 SQL 适配 trait，便于复用会话连接/测试流程；
/// 所有 SQL 专属操作返回明确的不支持错误。
#[async_trait]
impl DbAdapter for RedisAdapter {
    fn query_timeout_secs(&self)->u64 {self.params.network.query_timeout()}
    fn engine(&self) -> Engine {
        Engine::Redis
    }

    fn quote_ident(&self, name: &str) -> String {
        format!("\"{name}\"")
    }

    fn placeholder(&self, _one_based: usize) -> String {
        "?".to_string()
    }

    fn null_safe_eq(&self, column: &str, placeholder: &str) -> String {
        format!("{column} = {placeholder}")
    }

    async fn ping(&self) -> AppResult<()> {
        KeyValueAdapter::ping(self).await
    }

    async fn server_info(&self) -> AppResult<Vec<InfoEntry>> {
        KeyValueAdapter::server_info(self).await
    }

    async fn database_info(&self, _database: &str) -> AppResult<Vec<InfoEntry>> {
        Err(AppError::InvalidInput(
            "Redis 不支持数据库信息（请查看服务器概览或在对象树浏览逻辑库）".into(),
        ))
    }

    async fn server_version(&self) -> AppResult<String> {
        let info = KeyValueAdapter::server_info(self).await?;
        Ok(info
            .iter()
            .find(|entry| entry.key == "redis_version")
            .map(|entry| entry.value.clone())
            .unwrap_or_else(|| "unknown".into()))
    }

    async fn list_databases(&self) -> AppResult<Vec<DatabaseMeta>> {
        let databases = KeyValueAdapter::list_databases(self).await?;
        Ok(databases
            .into_iter()
            .map(|database| DatabaseMeta {
                name: format!("db{}", database.index),
                charset: None,
                collation: None,
                comment: Some(format!("{} 个键", database.keys)),
            })
            .collect())
    }

    async fn list_tables(&self, _database: &str) -> AppResult<Vec<TableRef>> {
        Ok(Vec::new())
    }

    async fn introspect_table(
        &self,
        _database: &str,
        _schema: Option<&str>,
        _table: &str,
    ) -> AppResult<TableMeta> {
        Err(AppError::InvalidInput(
            "Redis 不支持表结构内省（请使用键浏览）".into(),
        ))
    }

    async fn table_extra_info(
        &self,
        _database: &str,
        _schema: Option<&str>,
        _table: &str,
    ) -> AppResult<TableExtraInfo> {
        Ok(TableExtraInfo::default())
    }

    async fn query_page(
        &self,
        _database: &str,
        _sql: &str,
        _offset: u64,
        _limit: u32,
        _ctx: &QueryContext,
    ) -> AppResult<QueryOutcome> {
        Err(AppError::InvalidInput("Redis 不支持 SQL 查询".into()))
    }

    async fn execute_affected(&self, _database: &str, _sql: &str) -> AppResult<QueryOutcome> {
        Err(AppError::InvalidInput("Redis 不支持 SQL 执行".into()))
    }

    async fn execute_statements(&self, _database: &str, _statements: &[String]) -> AppResult<()> {
        Err(AppError::InvalidInput("Redis 不支持 DDL".into()))
    }

    async fn execute_transaction(&self, _database: &str, _items: &[SqlParams]) -> AppResult<u64> {
        Err(AppError::InvalidInput("Redis 不支持 SQL 事务".into()))
    }

    async fn cancel(&self, _conn_id: u64) -> AppResult<()> {
        Err(AppError::Message("Redis 命令暂不支持取消".into()))
    }

    async fn fetch_full_value(
        &self,
        _database: &str,
        _sql: &str,
    ) -> AppResult<Option<crate::meta::value::DbValue>> {
        Err(AppError::InvalidInput("Redis 不支持该操作".into()))
    }
}
