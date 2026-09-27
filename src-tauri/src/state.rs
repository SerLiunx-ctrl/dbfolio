use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::adapters::key_value::KeyValueAdapter;
use crate::adapters::{DbAdapter, QueryContext};
use crate::error::{AppError, AppResult};
use crate::store::LocalStore;

pub struct ConnectedSession {
    pub adapter: Arc<dyn DbAdapter>,
    /// 键值引擎（Redis）适配器；SQL 会话为 None
    pub key_value: Option<Arc<dyn KeyValueAdapter>>,
    pub mongo: Option<Arc<dyn crate::adapters::mongodb::DocumentAdapter>>,
    pub server_version: String,
}

pub struct AppState {
    pub sql_imports: crate::services::sql_import::Registry,
    pub schema_plans: crate::services::sync::SchemaRegistry,
    pub transactions: crate::services::manual_transaction::Registry,
    pub connection_attempts: crate::services::session::ConnectionAttempts,
    session_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    pub local: LocalStore,
    pub tasks: crate::tasks::TaskRegistry,
    pub generation: crate::services::generation::GenerationRegistry,
    pub connections: Mutex<HashMap<String, Arc<ConnectedSession>>>,
    pub running_queries: Mutex<HashMap<String, QueryContext>>,
}

impl AppState {
    pub async fn initialize() -> AppResult<Self> {
        let local = LocalStore::initialize().await?;
        Ok(Self::with_local(local))
    }
    pub(crate) fn with_local(local:LocalStore)->Self{
        Self {
            sql_imports: Default::default(),
            schema_plans: Default::default(),
            transactions: Default::default(),
            local,
            connection_attempts: Default::default(),
            session_locks: Default::default(),
            tasks: Default::default(),
            generation: Default::default(),
            connections: Mutex::new(HashMap::new()),
            running_queries: Mutex::new(HashMap::new()),
        }
    }

    pub async fn connected(&self, session_id: &str) -> AppResult<Arc<ConnectedSession>> {
        let connections = self.connections.lock().await;
        connections
            .get(session_id)
            .cloned()
            .ok_or_else(|| AppError::Connection(format!("会话未连接: {session_id}")))
    }

    /// 取键值引擎适配器（Redis 等）
    pub async fn key_value(&self, session_id: &str) -> AppResult<Arc<dyn KeyValueAdapter>> {
        let connected = self.connected(session_id).await?;
        connected
            .key_value
            .clone()
            .ok_or_else(|| AppError::InvalidInput("当前会话不是键值型数据库".into()))
    }

    pub async fn session_lock(&self, session_id: &str) -> tokio::sync::OwnedMutexGuard<()> {
        let lock = self
            .session_locks
            .lock()
            .await
            .entry(session_id.to_owned())
            .or_default()
            .clone();
        lock.lock_owned().await
    }

    pub async fn disconnect(&self, session_id: &str) {
        let _guard = self.session_lock(session_id).await;
        self.disconnect_locked(session_id).await;
    }

    pub async fn disconnect_locked(&self, session_id: &str) {
        let entries:Vec<_>=self.transactions.0.lock().await.values().cloned().collect();
        for entry in entries {
            let mut e=entry.lock().await;
            if e.info.session_id==session_id {
                self.transactions.0.lock().await.remove(&e.info.id);
                if let Some(tx)=e.tx.take(){let _=tokio::time::timeout(std::time::Duration::from_secs(10),tx.finish(false)).await;}
            }
        }
        let mut connections = self.connections.lock().await;
        if let Some(old) = connections.remove(session_id) { if let Some(mongo) = &old.mongo { mongo.close().await; } }
        let mut running = self.running_queries.lock().await;
        running.remove(session_id);
    }

    pub async fn set_running(&self, session_id: &str, ctx: QueryContext) {
        let mut running = self.running_queries.lock().await;
        running.insert(session_id.to_string(), ctx);
    }

    pub async fn clear_running(&self, session_id: &str) {
        let mut running = self.running_queries.lock().await;
        running.remove(session_id);
    }

    pub async fn take_running_conn_id(&self, session_id: &str) -> Option<u64> {
        let mut running = self.running_queries.lock().await;
        match running.remove(session_id) {
            Some(ctx) => *ctx.conn_id.lock().await,
            None => None,
        }
    }
}
