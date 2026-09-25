use serde::Serialize;
use std::sync::Arc;

use crate::adapters::key_value::KeyValueAdapter;
use crate::adapters::{self, ConnectionParams, DbAdapter};
use crate::error::AppResult;
use crate::meta::Engine;
use crate::state::{AppState, ConnectedSession};
use crate::store::{secrets, SessionInput, SessionRecord};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionStatus {
    pub session_id: String,
    pub connected: bool,
    pub server_version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub ok: bool,
    pub server_version: String,
}

fn params_from_input(input: &SessionInput, password: Option<String>) -> ConnectionParams {
    ConnectionParams {
        engine: input.engine,
        read_only: input.read_only,
        allowed_databases: input.allowed_databases.clone(),
        host: input.host.clone(),
        port: input.port,
        username: input.username.clone(),
        password,
        database: input.database.clone(),
        file_path: input.file_path.clone(),
        ssl_mode: input.ssl_mode.clone(),
        connect_timeout_secs: None,
        redis_db: input.redis_db,
        tls: input.tls,
        auth_source: input.auth_source.clone(),
    }
}

async fn resolve_password(
    session_id: Option<&str>,
    input: &SessionInput,
) -> AppResult<Option<String>> {
    match input.password.as_deref() {
        Some(password) if !password.is_empty() => Ok(Some(password.to_string())),
        Some(_) => Ok(None),
        None => match session_id {
            Some(id) => secrets::load_password(id),
            None => Ok(None),
        },
    }
}

/// 所有调用者共享同一次尝试的成功或失败；不同会话互不阻塞。
#[derive(Default)]
pub struct ConnectionAttempts {
    pending: tokio::sync::Mutex<
        std::collections::HashMap<String, Arc<tokio::sync::OnceCell<AppResult<ConnectionStatus>>>>,
    >,
}
impl ConnectionAttempts {
    async fn run<F, Fut>(&self, id: &str, create: F) -> AppResult<ConnectionStatus>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = AppResult<ConnectionStatus>>,
    {
        let attempt = self
            .pending
            .lock()
            .await
            .entry(id.to_owned())
            .or_default()
            .clone();
        let result = attempt.get_or_init(create).await.clone();
        let mut pending = self.pending.lock().await;
        if pending
            .get(id)
            .is_some_and(|current| Arc::ptr_eq(current, &attempt))
        {
            pending.remove(id);
        }
        result
    }
}

pub async fn connect(state: &AppState, session_id: &str) -> AppResult<ConnectionStatus> {
    state
        .connection_attempts
        .run(session_id, || async {
            let _guard = state.session_lock(session_id).await;
            if let Ok(existing) = state.connected(session_id).await {
                return Ok(ConnectionStatus {
                    session_id: session_id.into(),
                    connected: true,
                    server_version: Some(existing.server_version.clone()),
                });
            }
            tokio::time::timeout(
                std::time::Duration::from_secs(30),
                connect_new(state, session_id),
            )
            .await
            .map_err(|_| {
                crate::error::AppError::Connection(
                    "连接超时（30 秒），请检查地址和网络后重试".into(),
                )
            })?
        })
        .await
}

async fn connect_new(state: &AppState, session_id: &str) -> AppResult<ConnectionStatus> {
    let record: SessionRecord = state.local.get_session(session_id).await?;
    let password = secrets::load_password(session_id)?;

    let params = ConnectionParams {
        engine: record.engine,
        read_only: record.read_only,
        allowed_databases: record.allowed_databases.clone(),
        host: record.host.clone(),
        port: record.port,
        username: record.username.clone(),
        password,
        database: record.database.clone(),
        file_path: record.file_path.clone(),
        ssl_mode: record.ssl_mode.clone(),
        connect_timeout_secs: None,
        redis_db: record.redis_db,
        tls: record.tls,
        auth_source: record.auth_source.clone(),
    };

    let mongo = if record.engine == Engine::Mongodb { Some(Arc::new(crate::adapters::mongodb::MongoAdapter::connect(&params).await?)) } else { None };
    let (adapter, key_value): (Arc<dyn DbAdapter>, Option<Arc<dyn KeyValueAdapter>>) =
        if record.engine == Engine::Redis {
            let redis_adapter =
                Arc::new(crate::adapters::redis::RedisAdapter::connect(&params).await?);
            let key_value: Arc<dyn KeyValueAdapter> = redis_adapter.clone();
            let adapter: Arc<dyn DbAdapter> = redis_adapter;
            (adapter, Some(key_value))
        } else if let Some(mongo) = &mongo {
            (mongo.clone(), None)
        } else {
            (adapters::connect(&params).await?, None)
        };

    adapter.ping().await?;
    let server_version = adapter
        .server_version()
        .await
        .unwrap_or_else(|_| "unknown".into());

    let mut connections = state.connections.lock().await;
    connections.insert(
        session_id.to_string(),
        Arc::new(ConnectedSession {
            adapter,
            key_value,
            mongo: mongo.map(|m|m as Arc<dyn crate::adapters::mongodb::DocumentAdapter>),
            server_version: server_version.clone(),
        }),
    );

    tracing::info!(session = %record.name, version = %server_version, "连接成功");

    Ok(ConnectionStatus {
        session_id: session_id.to_string(),
        connected: true,
        server_version: Some(server_version),
    })
}

pub async fn test(
    state: &AppState,
    session_id: Option<&str>,
    input: &SessionInput,
) -> AppResult<TestResult> {
    super::database_access::validate(input.engine,input.allowed_databases.as_deref(),input.database.as_deref())?;
    let password = resolve_password(session_id, input).await?;
    let params = params_from_input(input, password);

    let adapter = adapters::connect(&params).await?;
    adapter.ping().await?;
    let server_version = adapter
        .server_version()
        .await
        .unwrap_or_else(|_| "unknown".into());

    let _ = state;
    Ok(TestResult {
        ok: true,
        server_version,
    })
}

pub async fn statuses(state: &AppState) -> Vec<ConnectionStatus> {
    let connections = state.connections.lock().await;
    connections
        .iter()
        .map(|(session_id, connected)| ConnectionStatus {
            session_id: session_id.clone(),
            connected: true,
            server_version: Some(connected.server_version.clone()),
        })
        .collect()
}

#[cfg(test)]
mod connection_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test]
    async fn concurrent_calls_share_success_and_failure_then_allow_retry() {
        for fail in [false, true] {
            let attempts = ConnectionAttempts::default();
            let calls = AtomicUsize::new(0);
            let create = || async {
                calls.fetch_add(1, Ordering::SeqCst);
                tokio::task::yield_now().await;
                if fail {
                    Err(crate::error::AppError::Connection("认证失败".into()))
                } else {
                    Ok(ConnectionStatus {
                        session_id: "s".into(),
                        connected: true,
                        server_version: Some("test".into()),
                    })
                }
            };
            let (a, b, c) = tokio::join!(
                attempts.run("s", create),
                attempts.run("s", create),
                attempts.run("s", create)
            );
            assert_eq!(calls.load(Ordering::SeqCst), 1);
            assert_eq!(a.is_err(), fail);
            assert_eq!(b.is_err(), fail);
            assert_eq!(c.is_err(), fail);
            assert!(attempts.pending.lock().await.is_empty());
            let _ = attempts.run("s", create).await;
            assert_eq!(calls.load(Ordering::SeqCst), 2);
        }
    }

    #[tokio::test]
    async fn unrelated_session_is_not_blocked_by_pending_connection() {
        let attempts = ConnectionAttempts::default();
        let signal = tokio::sync::Notify::new();
        let a = attempts.run("a", || async {
            signal.notified().await;
            Err(crate::error::AppError::Connection("离线".into()))
        });
        let b = async {
            let result = attempts
                .run("b", || async {
                    Ok(ConnectionStatus {
                        session_id: "b".into(),
                        connected: true,
                        server_version: None,
                    })
                })
                .await;
            signal.notify_one();
            result
        };
        let (a, b) = tokio::time::timeout(std::time::Duration::from_secs(1), async {
            tokio::join!(a, b)
        })
        .await
        .unwrap();
        assert!(a.is_err());
        assert!(b.is_ok());
    }
}

/// Credentials stay in the backend; a copy gets its own credential-manager entry.
pub async fn duplicate(state:&AppState, source_id:&str, mut input:SessionInput)->AppResult<SessionRecord> {
    let _guard=state.session_lock(source_id).await;
    state.local.get_session(source_id).await?;
    if input.password.is_none() { input.password=secrets::load_password(source_id)?; }
    state.local.create_session(&input).await
}

#[cfg(test)]
mod duplicate_tests {
    use super::*;
    #[tokio::test]
    async fn duplicate_has_new_identity_without_mutating_source() {
        let dir=tempfile::tempdir().unwrap();
        let state=AppState::with_local(crate::store::LocalStore::initialize_in(dir.path().into()).await.unwrap());
        let input:SessionInput=serde_json::from_value(serde_json::json!({"name":"测试库","engine":"mysql","host":"127.0.0.1","readOnly":false,"allowedDatabases":["test_db"],"groupName":"测试"})).unwrap();
        let source=state.local.create_session(&input).await.unwrap();
        let mut draft=input.clone();draft.name+="-副本";draft.read_only=true;draft.password=Some(String::new());
        let copy=duplicate(&state,&source.id,draft).await.unwrap();
        assert_ne!(source.id,copy.id);assert_eq!(copy.name,"测试库-副本");assert!(copy.read_only);
        assert_eq!(copy.allowed_databases,source.allowed_databases);assert_eq!(copy.group_name,source.group_name);
        let original=state.local.get_session(&source.id).await.unwrap();assert!(!original.read_only);assert_eq!(original.name,"测试库");
        assert_eq!(state.local.list_sessions().await.unwrap().len(),2);
        assert!(state.connections.lock().await.is_empty());
        assert!(duplicate(&state,"missing",input).await.is_err());
    }
}
