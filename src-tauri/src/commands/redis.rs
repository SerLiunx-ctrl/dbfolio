use tauri::State;

use crate::error::{AppError, AppResult};
use crate::meta::{InfoEntry, RedisDatabaseInfo, RedisEditOp, RedisKeyPreview, RedisScanPage};
use crate::state::AppState;

async fn ensure_writable(state: &State<'_, AppState>, session_id: &str) -> AppResult<()> {
    let record = state.local.get_session(session_id).await?;
    if record.read_only {
        return Err(AppError::ReadOnly(
            "当前会话为只读模式，已阻止修改".into(),
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn redis_server_info(
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<Vec<InfoEntry>> {
    let adapter = state.key_value(&session_id).await?;
    adapter.server_info().await
}

#[tauri::command]
pub async fn redis_databases(
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<Vec<RedisDatabaseInfo>> {
    let adapter = state.key_value(&session_id).await?;
    adapter.list_databases().await
}

#[tauri::command]
pub async fn redis_command(
    state: State<'_, AppState>, session_id: String, db: u32, args: Vec<String>, force: Option<bool>,
) -> AppResult<serde_json::Value> {
    let record = state.local.get_session(&session_id).await?;
    validate_console_command(&args, record.read_only, force.unwrap_or(false))?;
    let adapter = state.key_value(&session_id).await?;
    tokio::time::timeout(std::time::Duration::from_secs(15), adapter.command(db, &args)).await
      .map_err(|_| AppError::Message("命令等待超时；写入结果可能已生效，请刷新核实，勿直接重复执行".into()))?
}

fn validate_console_command(args: &[String], read_only: bool, force: bool) -> AppResult<()> {
    let command = args.first().map(|s| s.to_ascii_uppercase()).unwrap_or_default();
    let read = matches!(command.as_str(), "PING"|"GET"|"MGET"|"GETRANGE"|"STRLEN"|"TYPE"|"TTL"|"PTTL"|"EXISTS"|"SCAN"|"HGET"|"HMGET"|"HLEN"|"HSCAN"|"LLEN"|"LRANGE"|"LINDEX"|"SCARD"|"SISMEMBER"|"SSCAN"|"ZCARD"|"ZSCORE"|"ZRANGE"|"ZSCAN"|"XLEN"|"XRANGE"|"INFO"|"DBSIZE"|"TIME");
    let write = matches!(command.as_str(), "SET"|"MSET"|"DEL"|"UNLINK"|"INCR"|"DECR"|"INCRBY"|"DECRBY"|"EXPIRE"|"PEXPIRE"|"PERSIST"|"RENAME"|"RENAMENX"|"HSET"|"HDEL"|"SADD"|"SREM"|"LPUSH"|"RPUSH"|"LSET"|"LREM"|"ZADD"|"ZREM"|"XADD"|"XDEL");
    if !read && !write { return Err(AppError::InvalidInput("此命令暂不在控制台支持范围内；不支持切换连接状态、阻塞命令、脚本及管理命令".into())); }
    if write && read_only { return Err(AppError::ReadOnly("只读会话禁止写命令".into())); }
    if write && !force { return Err(AppError::Dangerous("此命令会修改当前 Redis 数据，请核对逻辑库及参数后确认".into())); }
    Ok(())
}

#[cfg(test)]
mod console_tests {
    use super::*;
    fn args(s: &str)->Vec<String>{s.split_whitespace().map(str::to_string).collect()}
    #[test] fn readonly_and_confirm() {
      assert!(validate_console_command(&args("GET x"),true,false).is_ok());
      assert!(matches!(validate_console_command(&args("SET x y"),true,true),Err(AppError::ReadOnly(_))));
      assert!(matches!(validate_console_command(&args("del x"),false,false),Err(AppError::Dangerous(_))));
      assert!(validate_console_command(&args("SET x y"),false,true).is_ok());
    }
    #[test] fn reject_connection_and_admin_commands(){for s in ["SELECT 2","MULTI","AUTH password","EVAL x 0","FLUSHALL","CONFIG SET x y","SUBSCRIBE x","KEYS *"]{assert!(validate_console_command(&args(s),false,true).is_err());}}
}

#[tauri::command]
pub async fn redis_scan_keys(
    state: State<'_, AppState>,
    session_id: String,
    db: u32,
    cursor: u64,
    pattern: Option<String>,
    key_type: Option<String>,
    count: Option<u32>,
) -> AppResult<RedisScanPage> {
    let adapter = state.key_value(&session_id).await?;
    adapter
        .scan_page(
            db,
            cursor,
            pattern.as_deref().unwrap_or("*"),
            key_type.as_deref(),
            count.unwrap_or(200),
        )
        .await
}

#[tauri::command]
pub async fn redis_key_preview(
    state: State<'_, AppState>,
    session_id: String,
    db: u32,
    key: String,
    limit: Option<u32>,
    cursor: Option<String>,
) -> AppResult<RedisKeyPreview> {
    let adapter = state.key_value(&session_id).await?;
    adapter
        .key_preview(db, &key, limit.unwrap_or(100), cursor.as_deref())
        .await
}

#[tauri::command]
pub async fn redis_edit(
    state: State<'_, AppState>,
    session_id: String,
    db: u32,
    key: String,
    edit: RedisEditOp,
    create: Option<bool>,
) -> AppResult<()> {
    ensure_writable(&state, &session_id).await?;
    let adapter = state.key_value(&session_id).await?;
    if create.unwrap_or(false) {
        adapter.create_key(db, &key, &edit).await
    } else {
        adapter.edit_key(db, &key, &edit).await
    }
}

#[tauri::command]
pub async fn redis_delete_key(
    state: State<'_, AppState>,
    session_id: String,
    db: u32,
    key: String,
) -> AppResult<u64> {
    ensure_writable(&state, &session_id).await?;
    let adapter = state.key_value(&session_id).await?;
    adapter.delete_key(db, &key).await
}

#[tauri::command]
pub async fn redis_delete_keys(
    state: State<'_, AppState>,
    session_id: String,
    db: u32,
    keys: Vec<String>,
) -> AppResult<u64> {
    ensure_writable(&state, &session_id).await?;
    let adapter = state.key_value(&session_id).await?;
    adapter.delete_keys(db, &keys).await
}

#[tauri::command]
pub async fn redis_rename_key(
    state: State<'_, AppState>,
    session_id: String,
    db: u32,
    key: String,
    new_key: String,
) -> AppResult<()> {
    ensure_writable(&state, &session_id).await?;
    let adapter = state.key_value(&session_id).await?;
    adapter.rename_key(db, &key, &new_key).await
}

#[tauri::command]
pub async fn redis_key_ttl(
    state: State<'_, AppState>,
    session_id: String,
    db: u32,
    key: String,
    ttl_ms: Option<i64>,
) -> AppResult<i64> {
    ensure_writable(&state, &session_id).await?;
    let adapter = state.key_value(&session_id).await?;
    adapter.set_ttl(db, &key, ttl_ms).await
}
