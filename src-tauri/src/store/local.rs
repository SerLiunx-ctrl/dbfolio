use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions, SqliteRow};
use sqlx::Row;
use std::path::PathBuf;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::meta::Engine;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecord {
    pub id: String,
    pub name: String,
    pub engine: Engine,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub username: Option<String>,
    pub database: Option<String>,
    pub file_path: Option<String>,
    pub ssl_mode: Option<String>,
    pub redis_db: Option<u16>,
    pub tls: Option<bool>,
    pub auth_source: Option<String>,
    pub read_only: bool,
    #[serde(default)]
    pub allowed_databases: Option<Vec<String>>,
    pub group_name: Option<String>,
    pub color: Option<String>,
    pub has_password: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInput {
    pub name: String,
    pub engine: Engine,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub username: Option<String>,
    /// None 表示不修改已保存密码；Some("") 表示删除密码；Some(pw) 表示保存
    pub password: Option<String>,
    pub database: Option<String>,
    pub file_path: Option<String>,
    pub ssl_mode: Option<String>,
    pub redis_db: Option<u16>,
    pub tls: Option<bool>,
    pub auth_source: Option<String>,
    pub read_only: bool,
    #[serde(default)]
    pub allowed_databases: Option<Vec<String>>,
    pub group_name: Option<String>,
    pub color: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: i64,
    pub session_id: String,
    pub database: Option<String>,
    pub sql: String,
    pub success: bool,
    pub rows_affected: Option<i64>,
    pub duration_ms: Option<i64>,
    pub error_code: Option<String>,
    pub executed_at: String,
}

pub struct LocalStore {
    pool: SqlitePool,
}

pub fn app_data_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("data-workbench")
}

fn row_to_session(row: &SqliteRow) -> AppResult<SessionRecord> {
    let engine_raw: String = row.try_get("engine")?;
    let engine = Engine::parse(&engine_raw)
        .ok_or_else(|| AppError::Internal(format!("未知引擎类型: {engine_raw}")))?;

    Ok(SessionRecord {
        id: row.try_get("id")?,
        name: row.try_get("name")?,
        engine,
        host: row.try_get("host")?,
        port: row.try_get::<Option<i64>, _>("port")?.map(|v| v as u16),
        username: row.try_get("username")?,
        database: row.try_get("database")?,
        file_path: row.try_get("file_path")?,
        ssl_mode: row.try_get("ssl_mode")?,
        redis_db: row
            .try_get::<Option<i64>, _>("redis_db")?
            .map(|value| value.max(0) as u16),
        tls: row.try_get::<Option<i64>, _>("tls")?.map(|value| value != 0),
        auth_source: row.try_get("auth_source")?,
        read_only: row.try_get::<i64, _>("read_only")? != 0,
        allowed_databases: row.try_get::<Option<String>, _>("allowed_databases")?.map(|s| serde_json::from_str(&s)).transpose()?,
        group_name: row.try_get("group_name")?,
        color: row.try_get("color")?,
        has_password: crate::store::secrets::load_password(&row.try_get::<String, _>("id")?)
            .ok()
            .flatten()
            .is_some(),
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

impl LocalStore {
    pub async fn initialize() -> AppResult<Self> {
        Self::initialize_in(app_data_dir()).await
    }

    pub(crate) async fn initialize_in(dir:PathBuf)->AppResult<Self>{
        std::fs::create_dir_all(&dir)?;
        let db_path = dir.join("app.db");

        let opts = SqliteConnectOptions::new()
            .filename(&db_path)
            .create_if_missing(true)
            .busy_timeout(std::time::Duration::from_secs(5));

        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .acquire_timeout(std::time::Duration::from_secs(10))
            .connect_with(opts)
            .await?;

        sqlx::query(
            "CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                engine TEXT NOT NULL,
                host TEXT,
                port INTEGER,
                username TEXT,
                database TEXT,
                file_path TEXT,
                ssl_mode TEXT,
                redis_db INTEGER,
                tls INTEGER,
                read_only INTEGER NOT NULL DEFAULT 0,
                group_name TEXT,
                color TEXT,
                options_json TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )",
        )
        .execute(&pool)
        .await?;

        let _ = sqlx::query("ALTER TABLE sessions ADD COLUMN allowed_databases TEXT").execute(&pool).await;

        // 兼容旧版本数据库：补充 Redis 相关列（已存在时报错忽略）
        let _ = sqlx::query("ALTER TABLE sessions ADD COLUMN auth_source TEXT").execute(&pool).await;
        let _ = sqlx::query("ALTER TABLE sessions ADD COLUMN redis_db INTEGER")
            .execute(&pool)
            .await;
        let _ = sqlx::query("ALTER TABLE sessions ADD COLUMN tls INTEGER")
            .execute(&pool)
            .await;

        sqlx::query(
            "CREATE TABLE IF NOT EXISTS query_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                database TEXT,
                sql TEXT NOT NULL,
                success INTEGER NOT NULL,
                rows_affected INTEGER,
                duration_ms INTEGER,
                error_code TEXT,
                executed_at TEXT NOT NULL
            )",
        )
        .execute(&pool)
        .await?;

        sqlx::query(
            "CREATE INDEX IF NOT EXISTS idx_history_session_time
             ON query_history(session_id, executed_at DESC)",
        )
        .execute(&pool)
        .await?;

        sqlx::query(
            "CREATE TABLE IF NOT EXISTS sync_profiles (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                source_json TEXT NOT NULL,
                target_json TEXT NOT NULL,
                options_json TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )",
        )
        .execute(&pool)
        .await?;

        sqlx::query(
            "CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )",
        )
        .execute(&pool)
        .await?;

        migrate_production_readonly(&pool).await?;
        tracing::info!(path = %db_path.display(), "本地存储初始化完成");
        Ok(Self { pool })
    }

    pub async fn list_sessions(&self) -> AppResult<Vec<SessionRecord>> {
        let rows = sqlx::query("SELECT * FROM sessions ORDER BY name COLLATE NOCASE")
            .fetch_all(&self.pool)
            .await?;
        rows.iter().map(row_to_session).collect()
    }

    pub async fn get_session(&self, id: &str) -> AppResult<SessionRecord> {
        let row = sqlx::query("SELECT * FROM sessions WHERE id = ?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("会话不存在: {id}")))?;
        row_to_session(&row)
    }

    pub async fn create_session(&self, input: &SessionInput) -> AppResult<SessionRecord> {
        validate_input(input)?;
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();

        sqlx::query(
            "INSERT INTO sessions
             (id, name, engine, host, port, username, database, file_path, ssl_mode,
              redis_db, tls, auth_source, read_only, group_name, color, allowed_databases, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(input.name.trim())
        .bind(input.engine.as_str())
        .bind(clean(&input.host))
        .bind(input.port.map(i64::from))
        .bind(clean(&input.username))
        .bind(clean(&input.database))
        .bind(clean(&input.file_path))
        .bind(clean(&input.ssl_mode))
        .bind(input.redis_db.map(i64::from))
        .bind(input.tls.map(|value| if value { 1i64 } else { 0i64 }))
        .bind(clean(&input.auth_source))
        .bind(if input.read_only { 1 } else { 0 })
        .bind(clean(&input.group_name))
        .bind(clean(&input.color))
        .bind(input.allowed_databases.as_ref().map(serde_json::to_string).transpose()?)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await?;

        if let Some(password) = input.password.as_deref().filter(|p| !p.is_empty()) {
            crate::store::secrets::save_password(&id, password)?;
        }

        self.get_session(&id).await
    }

    pub async fn update_session(&self, id: &str, input: &SessionInput) -> AppResult<SessionRecord> {
        validate_input(input)?;
        self.get_session(id).await?;
        let now = Utc::now().to_rfc3339();

        let affected = sqlx::query(
            "UPDATE sessions SET
                name = ?, engine = ?, host = ?, port = ?, username = ?, database = ?,
                file_path = ?, ssl_mode = ?, redis_db = ?, tls = ?, auth_source = ?, read_only = ?,
                group_name = ?, color = ?, allowed_databases = ?, updated_at = ?
             WHERE id = ?",
        )
        .bind(input.name.trim())
        .bind(input.engine.as_str())
        .bind(clean(&input.host))
        .bind(input.port.map(i64::from))
        .bind(clean(&input.username))
        .bind(clean(&input.database))
        .bind(clean(&input.file_path))
        .bind(clean(&input.ssl_mode))
        .bind(input.redis_db.map(i64::from))
        .bind(input.tls.map(|value| if value { 1i64 } else { 0i64 }))
        .bind(clean(&input.auth_source))
        .bind(if input.read_only { 1 } else { 0 })
        .bind(clean(&input.group_name))
        .bind(clean(&input.color))
        .bind(input.allowed_databases.as_ref().map(serde_json::to_string).transpose()?)
        .bind(&now)
        .bind(id)
        .execute(&self.pool)
        .await?
        .rows_affected();

        if affected == 0 {
            return Err(AppError::NotFound(format!("会话不存在: {id}")));
        }

        match input.password.as_deref() {
            None => {}
            Some("") => crate::store::secrets::delete_password(id)?,
            Some(password) => crate::store::secrets::save_password(id, password)?,
        }

        self.get_session(id).await
    }

    pub async fn delete_session(&self, id: &str) -> AppResult<()> {
        let affected = sqlx::query("DELETE FROM sessions WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await?
            .rows_affected();
        if affected == 0 {
            return Err(AppError::NotFound(format!("会话不存在: {id}")));
        }
        let _ = crate::store::secrets::delete_password(id);
        Ok(())
    }

    pub async fn update_session_group(&self, id: &str, group: Option<&str>) -> AppResult<()> {
        let now = Utc::now().to_rfc3339();
        let affected = sqlx::query("UPDATE sessions SET group_name = ?, updated_at = ? WHERE id = ?")
            .bind(group)
            .bind(&now)
            .bind(id)
            .execute(&self.pool)
            .await?
            .rows_affected();
        if affected == 0 {
            return Err(AppError::NotFound(format!("会话不存在: {id}")));
        }
        Ok(())
    }

    pub async fn get_setting(&self, key: &str) -> AppResult<Option<String>> {
        let row = sqlx::query("SELECT value FROM settings WHERE key = ?")
            .bind(key)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.map(|row| row.try_get("value").unwrap_or_default()))
    }

    pub async fn set_setting(&self, key: &str, value: &str) -> AppResult<()> {
        sqlx::query(
            "INSERT INTO settings (key, value) VALUES (?, ?) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .bind(key)
        .bind(value)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn set_settings(&self, values: &std::collections::BTreeMap<String, String>) -> AppResult<()> {
        let mut tx = self.pool.begin().await?;
        for (key, value) in values {
            sqlx::query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
                .bind(key).bind(value).execute(&mut *tx).await?;
        }
        tx.commit().await?;
        Ok(())
    }

    pub async fn insert_history(
        &self,
        session_id: &str,
        database: Option<&str>,
        sql: &str,
        success: bool,
        rows_affected: Option<i64>,
        duration_ms: i64,
        error_code: Option<&str>,
    ) -> AppResult<()> {
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            "INSERT INTO query_history
             (session_id, database, sql, success, rows_affected, duration_ms, error_code, executed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(session_id)
        .bind(database)
        .bind(sql)
        .bind(if success { 1 } else { 0 })
        .bind(rows_affected)
        .bind(duration_ms)
        .bind(error_code)
        .bind(&now)
        .execute(&self.pool)
        .await?;

        // 按首选项保留每会话最近的记录；0 表示不自动清理。
        let limit = self.history_limit().await?;
        if limit > 0 {
        sqlx::query(
            "DELETE FROM query_history WHERE session_id = ? AND id NOT IN (
                SELECT id FROM query_history WHERE session_id = ? ORDER BY id DESC LIMIT ?
             )",
        )
        .bind(session_id)
        .bind(session_id)
        .bind(limit as i64)
        .execute(&self.pool)
        .await?;
        }
        Ok(())
    }

    pub async fn list_history(
        &self,
        session_id: Option<&str>,
        limit: u32,
    ) -> AppResult<Vec<HistoryEntry>> {        let limit = limit.clamp(1, 500) as i64;
        let rows = match session_id {
            Some(id) => {
                sqlx::query(
                    "SELECT * FROM query_history WHERE session_id = ? ORDER BY id DESC LIMIT ?",
                )
                .bind(id)
                .bind(limit)
                .fetch_all(&self.pool)
                .await?
            }
            None => {
                sqlx::query("SELECT * FROM query_history ORDER BY id DESC LIMIT ?")
                    .bind(limit)
                    .fetch_all(&self.pool)
                    .await?
            }
        };

        Ok(rows
            .iter()
            .map(|row| HistoryEntry {
                id: row.try_get("id").unwrap_or_default(),
                session_id: row.try_get("session_id").unwrap_or_default(),
                database: row.try_get("database").unwrap_or_default(),
                sql: row.try_get("sql").unwrap_or_default(),
                success: row.try_get::<i64, _>("success").unwrap_or(1) != 0,
                rows_affected: row.try_get("rows_affected").unwrap_or_default(),
                duration_ms: row.try_get("duration_ms").unwrap_or_default(),
                error_code: row.try_get("error_code").unwrap_or_default(),
                executed_at: row.try_get("executed_at").unwrap_or_default(),
            })
            .collect())
    }
    pub async fn search_history(&self, session_id: Option<String>, database: Option<String>, text: String, from: Option<String>, to: Option<String>, success: Option<bool>, offset: u32) -> AppResult<Vec<HistoryEntry>> {
        let mut q = sqlx::QueryBuilder::<sqlx::Sqlite>::new("SELECT * FROM query_history WHERE 1=1");
        if let Some(id)=session_id.filter(|v| !v.is_empty()) { q.push(" AND session_id = ").push_bind(id); }
        if let Some(db)=database.filter(|v| !v.is_empty()) { q.push(" AND database = ").push_bind(db); }
        if !text.is_empty() { q.push(" AND instr(lower(sql), lower(").push_bind(text).push(")) > 0"); }
        if let Some(date)=from.filter(|v| !v.is_empty()) { q.push(" AND substr(executed_at,1,10) >= ").push_bind(date); }
        if let Some(date)=to.filter(|v| !v.is_empty()) { q.push(" AND substr(executed_at,1,10) <= ").push_bind(date); }
        if let Some(ok)=success { q.push(" AND success = ").push_bind(i64::from(ok)); }
        q.push(" ORDER BY id DESC LIMIT 101 OFFSET ").push_bind(i64::from(offset));
        let rows=q.build().fetch_all(&self.pool).await?;
        Ok(rows
            .iter()
            .map(|row| HistoryEntry {
                id: row.try_get("id").unwrap_or_default(),
                session_id: row.try_get("session_id").unwrap_or_default(),
                database: row.try_get("database").unwrap_or_default(),
                sql: row.try_get("sql").unwrap_or_default(),
                success: row.try_get::<i64, _>("success").unwrap_or(1) != 0,
                rows_affected: row.try_get("rows_affected").unwrap_or_default(),
                duration_ms: row.try_get("duration_ms").unwrap_or_default(),
                error_code: row.try_get("error_code").unwrap_or_default(),
                executed_at: row.try_get("executed_at").unwrap_or_default(),
            })
            .collect())
    }

}

fn clean(value: &Option<String>) -> Option<String> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod history_search_tests {
    use super::*;
    #[tokio::test]
    async fn settings_batch_is_atomic_on_failure() {
        let pool = SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL CHECK(value <> 'fail'))").execute(&pool).await.unwrap();
        let store = LocalStore { pool };
        store.set_setting("a", "old").await.unwrap();
        store.set_setting("b", "old").await.unwrap();
        let mut values = std::collections::BTreeMap::new();
        values.insert("a".into(), "new".into());
        values.insert("b".into(), "fail".into());
        assert!(store.set_settings(&values).await.is_err());
        assert_eq!(store.get_setting("a").await.unwrap().as_deref(), Some("old"));
        assert_eq!(store.get_setting("b").await.unwrap().as_deref(), Some("old"));
        values.insert("b".into(), "new".into());
        store.set_settings(&values).await.unwrap();
        assert_eq!(store.get_setting("a").await.unwrap().as_deref(), Some("new"));
        assert_eq!(store.get_setting("b").await.unwrap().as_deref(), Some("new"));
    }
    #[tokio::test]
    async fn filters_run_before_pagination_and_remain_bound() {
        let pool=SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE query_history(id INTEGER PRIMARY KEY, session_id TEXT, database TEXT, sql TEXT, success INTEGER, rows_affected INTEGER, duration_ms INTEGER, error_code TEXT, executed_at TEXT)").execute(&pool).await.unwrap();
        for i in 1..=205 {
            sqlx::query("INSERT INTO query_history VALUES(?, 's1','db','SELECT 1',1,0,2,NULL,'2026-09-16T00:00:00Z')").bind(i).execute(&pool).await.unwrap();
        }
        sqlx::query("INSERT INTO query_history VALUES(0, 's2','archive','SELECT needle',0,0,3,'E_SQL_EXEC','2026-09-15T00:00:00Z')").execute(&pool).await.unwrap();
        let store=LocalStore{pool};
        let found=store.search_history(Some("s2".into()),Some("archive".into()),"needle".into(),Some("2026-09-15".into()),Some("2026-09-15".into()),Some(false),0).await.unwrap();
        assert_eq!(found.len(),1);assert_eq!(found[0].id,0);
        let page=store.search_history(None,None,String::new(),None,None,None,100).await.unwrap();
        assert_eq!(page.len(),101);assert_eq!(page[0].id,105);
        let injection=store.search_history(Some("' OR 1=1 --".into()),None,String::new(),None,None,None,0).await.unwrap();
        assert!(injection.is_empty());
    }
}

fn validate_input(input: &SessionInput) -> AppResult<()> {
    crate::services::database_access::validate(input.engine, input.allowed_databases.as_deref(), input.database.as_deref())?;
    if input.name.trim().is_empty() {
        return Err(AppError::InvalidInput("会话名称不能为空".into()));
    }
    if input.engine == Engine::Mongodb { crate::adapters::mongodb::validate_address(input.host.as_deref().unwrap_or(""))?; }
    match input.engine {
        Engine::Sqlite => {
            if clean(&input.file_path).is_none() {
                return Err(AppError::InvalidInput("请选择 SQLite 数据库文件".into()));
            }
        }
        _ => {
            if clean(&input.host).is_none() {
                return Err(AppError::InvalidInput("主机地址不能为空".into()));
            }
        }
    }
    Ok(())
}

// 一次性升级默认值，后续保留用户明确关闭只读的选择。
async fn migrate_production_readonly(pool:&SqlitePool)->AppResult<()> {
 let mut tx=pool.begin().await?;
 let done:Option<String>=sqlx::query_scalar("SELECT value FROM settings WHERE key='production_readonly_v1'").fetch_optional(&mut *tx).await?;
 if done.is_none(){
  let raw:Option<String>=sqlx::query_scalar("SELECT value FROM settings WHERE key='object_preferences_v1'").fetch_optional(&mut *tx).await?;
  if let Some(raw)=raw {let value:serde_json::Value=serde_json::from_str(&raw)?;if let Some(envs)=value.get("environments").and_then(|v|v.as_object()){for (id,env) in envs {if env.as_str()==Some("production"){sqlx::query("UPDATE sessions SET read_only=1 WHERE id=?").bind(id).execute(&mut *tx).await?;}}}}
  sqlx::query("INSERT INTO settings(key,value) VALUES('production_readonly_v1','done')").execute(&mut *tx).await?;
 }
 tx.commit().await?;Ok(())
}

#[cfg(test)] mod production_tests {
 use super::*;
 #[tokio::test] async fn production_defaults_only_once(){
 let pool=sqlx::sqlite::SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
 sqlx::query("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE sessions(id TEXT PRIMARY KEY,read_only INTEGER)").execute(&pool).await.unwrap();
 sqlx::query("INSERT INTO sessions VALUES('p',0),('d',0)").execute(&pool).await.unwrap();
 sqlx::query("INSERT INTO settings VALUES('object_preferences_v1',?)").bind(r#"{"environments":{"p":"production","d":"development"}}"#).execute(&pool).await.unwrap();
 migrate_production_readonly(&pool).await.unwrap();
 let rows:Vec<i64>=sqlx::query_scalar("SELECT read_only FROM sessions ORDER BY id").fetch_all(&pool).await.unwrap();assert_eq!(rows,vec![0,1]);
 sqlx::query("UPDATE sessions SET read_only=0 WHERE id='p'").execute(&pool).await.unwrap();migrate_production_readonly(&pool).await.unwrap();let v:i64=sqlx::query_scalar("SELECT read_only FROM sessions WHERE id='p'").fetch_one(&pool).await.unwrap();assert_eq!(v,0);
 }
}


#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalDataStats {
    pub database_path: String,
    pub database_bytes: u64,
    pub auxiliary_bytes: u64,
    pub session_count: i64,
    pub history_count: i64,
    pub history_limit: u32,
}

impl LocalStore {
    pub async fn history_limit(&self) -> AppResult<u32> {
        Ok(self.get_setting("history_limit_per_session").await?
            .and_then(|v| v.parse::<u32>().ok()).filter(|v| *v <= 100000).unwrap_or(500))
    }

    pub async fn set_history_limit(&self, limit: u32) -> AppResult<()> {
        if limit > 100000 { return Err(AppError::InvalidInput("保留上限不能超过 100000 条".into())); }
        self.set_setting("history_limit_per_session", &limit.to_string()).await
    }

    pub async fn local_data_stats(&self) -> AppResult<LocalDataStats> {
        let row = sqlx::query("PRAGMA database_list").fetch_one(&self.pool).await?;
        let path: String = row.try_get("file")?;
        let size = |p: &str| -> AppResult<u64> {
            match std::fs::metadata(p) {
                Ok(m) => Ok(m.len()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(0),
                Err(e) => Err(e.into()),
            }
        };
        Ok(LocalDataStats {
            database_bytes: size(&path)?,
            auxiliary_bytes: size(&format!("{path}-wal"))? + size(&format!("{path}-shm"))? + size(&format!("{path}-journal"))?,
            database_path: path,
            session_count: sqlx::query_scalar("SELECT COUNT(*) FROM sessions").fetch_one(&self.pool).await?,
            history_count: sqlx::query_scalar("SELECT COUNT(*) FROM query_history").fetch_one(&self.pool).await?,
            history_limit: self.history_limit().await?,
        })
    }

    pub async fn clear_query_history(&self, older_than_days: Option<u32>) -> AppResult<u64> {
        if let Some(days) = older_than_days {
            if ![7, 30, 90, 180, 365].contains(&days) {
                return Err(AppError::InvalidInput("不支持的清理时间范围".into()));
            }
            let cutoff = (Utc::now() - chrono::Duration::days(days as i64)).to_rfc3339();
            Ok(sqlx::query("DELETE FROM query_history WHERE julianday(executed_at) < julianday(?)")
                .bind(cutoff).execute(&self.pool).await?.rows_affected())
        } else {
            Ok(sqlx::query("DELETE FROM query_history").execute(&self.pool).await?.rows_affected())
        }
    }

    pub async fn compact_local_data(&self) -> AppResult<()> {
        sqlx::query("VACUUM").execute(&self.pool).await?;
        Ok(())
    }
}

#[cfg(test)]
mod local_data_tests {
    use super::*;
    #[tokio::test]
    async fn retention_cleanup_and_stats_preserve_other_data() {
        let dir = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize_in(dir.path().to_path_buf()).await.unwrap();
        assert_eq!(store.history_limit().await.unwrap(), 500);
        store.set_history_limit(2).await.unwrap();
        assert!(store.set_history_limit(100001).await.is_err());
        for s in ["a", "b"] {
            for _ in 0..4 { store.insert_history(s, None, "SELECT 1", true, None, 1, None).await.unwrap(); }
        }
        assert_eq!(store.local_data_stats().await.unwrap().history_count, 4);
        store.set_history_limit(0).await.unwrap();
        store.insert_history("a", None, "SELECT 2", true, None, 1, None).await.unwrap();
        assert_eq!(store.local_data_stats().await.unwrap().history_count, 5);
        store.set_setting("favorite_sql", "SELECT 1").await.unwrap();
        sqlx::query("UPDATE query_history SET executed_at='2000-01-01T00:00:00Z' WHERE id=(SELECT MIN(id) FROM query_history)").execute(&store.pool).await.unwrap();
        assert!(store.clear_query_history(Some(0)).await.is_err());
        assert_eq!(store.clear_query_history(Some(30)).await.unwrap(), 1);
        assert_eq!(store.clear_query_history(None).await.unwrap(), 4);
        assert_eq!(store.get_setting("favorite_sql").await.unwrap().as_deref(), Some("SELECT 1"));
        store.compact_local_data().await.unwrap();
        let stats=store.local_data_stats().await.unwrap();
        assert_eq!(stats.history_count, 0);
        assert!(stats.database_bytes > 0);
        assert_eq!(PathBuf::from(stats.database_path), dir.path().join("app.db"));
    }
}
