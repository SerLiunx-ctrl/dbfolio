use async_trait::async_trait;

use crate::error::AppResult;
use crate::meta::{
    Engine, InfoEntry, RedisDatabaseInfo, RedisEditOp, RedisKeyPreview, RedisScanPage,
};

/// 键值引擎（Redis 等）适配层：与 DbAdapter 平级，按「引擎族」分派
#[async_trait]
pub trait KeyValueAdapter: Send + Sync {
    fn engine(&self) -> Engine;

    async fn ping(&self) -> AppResult<()>;
    /// 服务器 INFO（按分节解析为条目）
    async fn server_info(&self) -> AppResult<Vec<InfoEntry>>;
    /// 逻辑库列表（含各库键数量）
    async fn list_databases(&self) -> AppResult<Vec<RedisDatabaseInfo>>;
    /// 执行任意命令（供控制台使用）
    async fn command(&self, db: u32, args: &[String]) -> AppResult<serde_json::Value>;
    /// SCAN 分页浏览键（禁用 KEYS；cursor 为 0 表示迭代结束）
    async fn scan_page(
        &self,
        db: u32,
        cursor: u64,
        pattern: &str,
        key_type: Option<&str>,
        count: u32,
    ) -> AppResult<RedisScanPage>;
    /// 键预览（只读，按类型返回前 limit 个元素）
    async fn key_preview(&self, db: u32, key: &str, limit: u32, cursor: Option<&str>) -> AppResult<RedisKeyPreview>;
    /// 创建键（键已存在时报错）；op 必为可创建键的操作
    async fn create_key(&self, db: u32, key: &str, op: &RedisEditOp) -> AppResult<()>;
    /// 编辑键内容（键不存在时报错）
    async fn edit_key(&self, db: u32, key: &str, op: &RedisEditOp) -> AppResult<()>;
    /// 删除键，返回删除数量
    async fn delete_key(&self, db: u32, key: &str) -> AppResult<u64>;
    /// 批量删除键（分块执行 DEL），返回删除总数
    async fn delete_keys(&self, db: u32, keys: &[String]) -> AppResult<u64>;
    /// 重命名键（目标已存在时报错）
    async fn rename_key(&self, db: u32, key: &str, new_key: &str) -> AppResult<()>;
    /// 设置 TTL（None 表示持久化），返回新的 PTTL
    async fn set_ttl(&self, db: u32, key: &str, ttl_ms: Option<i64>) -> AppResult<i64>;
}
