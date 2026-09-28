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
    pub steps: Vec<DiagnosticStep>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticStep {
    pub key: String,
    pub label: String,
    pub status: String,
    pub message: String,
    pub duration_ms: u128,
}
fn report() -> TestResult {
    TestResult {
        ok: false,
        server_version: String::new(),
        steps: [
            ("address", "地址解析"),
            ("network", "网络连通"),
            ("ssh", "SSH 与转发"),
            ("tls", "TLS / 证书"),
            ("authentication", "数据库认证"),
            ("database", "库访问权限"),
        ]
        .into_iter()
        .map(|(key, label)| DiagnosticStep {
            key: key.into(),
            label: label.into(),
            status: "pending".into(),
            message: String::new(),
            duration_ms: 0,
        })
        .collect(),
    }
}
fn mark(r: &mut TestResult, key: &str, status: &str, message: impl Into<String>) {
    if let Some(s) = r.steps.iter_mut().find(|s| s.key == key) {
        s.status = status.into();
        s.message = message.into();
    }
}
async fn step<T>(
    r: &mut TestResult,
    key: &str,
    work: impl std::future::Future<Output = AppResult<T>>,
) -> AppResult<T> {
    mark(r, key, "running", "");
    let start = std::time::Instant::now();
    let result = work.await;
    if let Some(s) = r.steps.iter_mut().find(|s| s.key == key) {
        s.duration_ms = start.elapsed().as_millis();
        s.status = if result.is_ok() { "ok" } else { "failed" }.into();
        s.message = result
            .as_ref()
            .err()
            .map(ToString::to_string)
            .unwrap_or_else(|| "通过".into());
    }
    result
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
        connect_timeout_secs: Some(input.network.connect_timeout()),
        network: input.network.clone(),
        tunneled: false,
        tls_terminated: false,
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
            connect_new(state, session_id).await
        })
        .await
}

fn stored_input(record: &SessionRecord) -> AppResult<SessionInput> {
    let mut value = serde_json::to_value(record)?;
    value
        .as_object_mut()
        .unwrap()
        .insert("password".into(), serde_json::Value::Null);
    Ok(serde_json::from_value(value)?)
}
async fn ssh_secret(
    id: Option<&str>,
    provided: &Option<String>,
    suffix: &str,
) -> AppResult<Option<String>> {
    match provided {
        Some(v) => Ok(Some(v.clone())),
        None => match id {
            Some(id) => secrets::load_password(&format!("{id}:{suffix}")),
            None => Ok(None),
        },
    }
}
async fn establish(
    input: &SessionInput,
    mut params: ConnectionParams,
    ssh_password: Option<String>,
    ssh_passphrase: Option<String>,
    r: &mut TestResult,
) -> AppResult<ConnectedSession> {
    input
        .network
        .validate(input.engine, input.host.as_deref())?;
    if let Some(mode) = &input.ssl_mode {
        if ![
            "disable",
            "disabled",
            "prefer",
            "require",
            "verify-ca",
            "verify-full",
            "verify-identity",
        ]
        .contains(&mode.as_str())
        {
            return Err(crate::error::AppError::InvalidInput("TLS 模式无效".into()));
        }
    }
    let has_cert = input.network.ca_file.is_some()
        || input.network.client_cert.is_some()
        || input.network.server_name.is_some();
    let sql_engine = matches!(input.engine, Engine::Mysql | Engine::Postgres);
    if has_cert
        && (sql_engine && input.ssl_mode.as_deref() == Some("disable")
            || matches!(input.engine, Engine::Redis | Engine::Mongodb) && input.tls != Some(true))
    {
        return Err(crate::error::AppError::InvalidInput(
            "已配置 TLS 证书或服务器名，请先启用 TLS".into(),
        ));
    }
    let host = params.host.clone().unwrap_or_else(|| "127.0.0.1".into());
    if input.engine == Engine::Sqlite || host.starts_with("mongodb") {
        mark(
            r,
            "address",
            "skipped",
            if input.engine == Engine::Sqlite {
                "本地文件"
            } else {
                "URI/SRV 由 MongoDB 驱动解析"
            },
        );
        mark(r, "network", "skipped", "由驱动连接阶段检查");
    } else {
        let (host, port) = input
            .network
            .ssh
            .as_ref()
            .map(|s| (s.host.clone(), s.port))
            .unwrap_or((
                host,
                params.port.unwrap_or(match input.engine {
                    Engine::Mysql => 3306,
                    Engine::Postgres => 5432,
                    Engine::Redis => 6379,
                    _ => 27017,
                }),
            ));
        let addresses = step(r, "address", async {
            tokio::net::lookup_host((host.as_str(), port))
                .await
                .map(|a| a.collect::<Vec<_>>())
                .map_err(super::transport::err)
        })
        .await?;
        let socket = step(r, "network", async {
            tokio::net::TcpStream::connect(addresses.as_slice())
                .await
                .map_err(super::transport::err)
        })
        .await?;
        drop(socket);
    }
    let tls_bridge = matches!(input.engine, Engine::Redis | Engine::Mongodb)
        && input.tls == Some(true)
        && !params.host.as_deref().unwrap_or("").starts_with("mongodb");
    let transport = if input.network.ssh.is_some() || tls_bridge {
        let key = if input.network.ssh.is_some() {
            "ssh"
        } else {
            "tls"
        };
        let result = step(
            r,
            key,
            super::transport::prepare(
                &mut params,
                ssh_password.as_deref(),
                ssh_passphrase.as_deref(),
            ),
        )
        .await;
        if let Err(e) = &result {
            if e.to_string().contains("TLS") {
                if input.network.ssh.is_some() {
                    mark(r, "ssh", "ok", "SSH 认证通过");
                }
                mark(r, "tls", "failed", e.to_string());
            }
        }
        result?
    } else {
        None
    };
    if input.network.ssh.is_none() {
        mark(r, "ssh", "skipped", "直连");
    }
    if tls_bridge {
        mark(r, "tls", "ok", "证书链与数据库服务器名校验通过");
    }
    let result = step(r, "authentication", async {
        let mongo = if input.engine == Engine::Mongodb {
            Some(Arc::new(
                crate::adapters::mongodb::MongoAdapter::connect(&params).await?,
            ))
        } else {
            None
        };
        let (adapter, key_value): (Arc<dyn DbAdapter>, Option<Arc<dyn KeyValueAdapter>>) =
            if input.engine == Engine::Redis {
                let redis = Arc::new(crate::adapters::redis::RedisAdapter::connect(&params).await?);
                (redis.clone(), Some(redis))
            } else if let Some(m) = &mongo {
                (m.clone(), None)
            } else {
                (adapters::connect(&params).await?, None)
            };
        adapter.ping().await?;
        Ok((adapter, key_value, mongo))
    })
    .await;
    if let Err(e) = &result {
        let text = e.to_string();
        let lower = text.to_lowercase();
        if lower.contains("tls") || lower.contains("ssl") || lower.contains("certificate") {
            mark(r, "tls", "failed", &text);
            mark(
                r,
                "authentication",
                "skipped",
                "TLS 未通过，未完成数据库认证",
            );
        } else if lower.contains("unknown database")
            || lower.contains("1044")
            || lower.contains("permission denied for database")
            || lower.contains("access denied") && lower.contains("to database")
        {
            mark(r, "database", "failed", &text);
        }
        if let Some(t) = &transport {
            if let Some(error) = t.failure.lock().unwrap().as_ref() {
                mark(
                    r,
                    if error.contains("TLS") {
                        "tls"
                    } else if input.network.ssh.is_some() {
                        "ssh"
                    } else {
                        "network"
                    },
                    "failed",
                    error,
                );
            }
        }
    }
    let (adapter, key_value, mongo) = result?;
    if !tls_bridge {
        if input.engine == Engine::Sqlite
            || sql_engine && input.ssl_mode.as_deref() == Some("disable")
            || !sql_engine && input.tls != Some(true)
        {
            mark(
                r,
                "tls",
                "skipped",
                "未启用 TLS（MongoDB URI 以 URI 配置为准）",
            );
        } else {
            mark(
                r,
                "tls",
                "ok",
                if sql_engine && input.ssl_mode.as_deref().unwrap_or("prefer") == "prefer" {
                    "驱动协商完成：prefer 允许回退明文"
                } else {
                    "驱动按所选模式完成 TLS 协商"
                },
            );
        }
    }
    if let Some(database) = input.database.as_deref().filter(|s| !s.is_empty()) {
        step(r, "database", adapter.database_info(database)).await?;
        mark(r, "database", "ok", "默认库可访问；不代表所有表的读写权限");
    } else {
        mark(
            r,
            "database",
            "skipped",
            "未指定默认库；后续操作由服务器校验对象权限",
        );
    }
    let server_version = adapter
        .server_version()
        .await
        .unwrap_or_else(|_| "unknown".into());
    r.ok = true;
    r.server_version = server_version.clone();
    Ok(ConnectedSession {
        adapter,
        key_value,
        mongo: mongo.map(|m| m as Arc<dyn crate::adapters::mongodb::DocumentAdapter>),
        server_version,
        transport,
    })
}
async fn attempt(
    state: &AppState,
    id: Option<&str>,
    input: &SessionInput,
) -> AppResult<(TestResult, Option<ConnectedSession>)> {
    super::database_access::validate(
        input.engine,
        input.allowed_databases.as_deref(),
        input.database.as_deref(),
    )?;
    let password = resolve_password(id, input).await?;
    let ssh_password = ssh_secret(id, &input.ssh_password, "ssh-password").await?;
    let ssh_passphrase = ssh_secret(id, &input.ssh_key_passphrase, "ssh-key-passphrase").await?;
    let params = params_from_input(input, password);
    let mut r = report();
    let outcome = tokio::time::timeout(
        std::time::Duration::from_secs(input.network.connect_timeout().clamp(1, 120)),
        establish(input, params, ssh_password, ssh_passphrase, &mut r),
    )
    .await;
    let connection = match outcome {
        Ok(Ok(c)) => Some(c),
        Ok(Err(e)) => {
            if !r.steps.iter().any(|s| s.status == "failed") {
                mark(&mut r, "address", "failed", e.to_string());
            }
            None
        }
        Err(_) => {
            let key = r
                .steps
                .iter()
                .find(|s| s.status == "running")
                .map(|s| s.key.clone())
                .unwrap_or_else(|| "authentication".into());
            mark(
                &mut r,
                &key,
                "failed",
                format!("连接超时（{} 秒）", input.network.connect_timeout()),
            );
            None
        }
    };
    for s in &mut r.steps {
        if s.status == "pending" {
            s.status = "skipped".into();
            s.message = "前序阶段未完成".into();
        }
    }
    let _ = state;
    Ok((r, connection))
}
async fn connect_new(state: &AppState, session_id: &str) -> AppResult<ConnectionStatus> {
    let record = state.local.get_session(session_id).await?;
    let input = stored_input(&record)?;
    let (report, connection) = attempt(state, Some(session_id), &input).await?;
    let connection = connection.ok_or_else(|| {
        crate::error::AppError::Connection(
            report
                .steps
                .iter()
                .filter(|s| s.status == "failed")
                .map(|s| format!("{}：{}", s.label, s.message))
                .collect::<Vec<_>>()
                .join("；"),
        )
    })?;
    let server_version = Some(connection.server_version.clone());
    state
        .connections
        .lock()
        .await
        .insert(session_id.into(), Arc::new(connection));
    Ok(ConnectionStatus {
        session_id: session_id.into(),
        connected: true,
        server_version,
    })
}
pub async fn test(
    state: &AppState,
    session_id: Option<&str>,
    input: &SessionInput,
) -> AppResult<TestResult> {
    let (report, connection) = attempt(state, session_id, input).await?;
    if let Some(c) = connection {
        if let Some(t) = &c.transport {
            t.stop();
        }
        if let Some(m) = &c.mongo {
            m.close().await;
        }
    }
    Ok(report)
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
pub async fn duplicate(
    state: &AppState,
    source_id: &str,
    mut input: SessionInput,
) -> AppResult<SessionRecord> {
    let _guard = state.session_lock(source_id).await;
    state.local.get_session(source_id).await?;
    if input.password.is_none() {
        input.password = secrets::load_password(source_id)?;
    }
    if input.ssh_password.is_none() {
        input.ssh_password = secrets::load_password(&format!("{source_id}:ssh-password"))?;
    }
    if input.ssh_key_passphrase.is_none() {
        input.ssh_key_passphrase =
            secrets::load_password(&format!("{source_id}:ssh-key-passphrase"))?;
    }
    state.local.create_session(&input).await
}

#[cfg(test)]
mod duplicate_tests {
    use super::*;
    #[tokio::test]
    async fn duplicate_has_new_identity_without_mutating_source() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::with_local(
            crate::store::LocalStore::initialize_in(dir.path().into())
                .await
                .unwrap(),
        );
        let input:SessionInput=serde_json::from_value(serde_json::json!({"name":"测试库","engine":"mysql","host":"127.0.0.1","readOnly":false,"allowedDatabases":["test_db"],"groupName":"测试"})).unwrap();
        let source = state.local.create_session(&input).await.unwrap();
        let mut draft = input.clone();
        draft.name += "-副本";
        draft.read_only = true;
        draft.password = Some(String::new());
        let copy = duplicate(&state, &source.id, draft).await.unwrap();
        assert_ne!(source.id, copy.id);
        assert_eq!(copy.name, "测试库-副本");
        assert!(copy.read_only);
        assert_eq!(copy.allowed_databases, source.allowed_databases);
        assert_eq!(copy.group_name, source.group_name);
        let original = state.local.get_session(&source.id).await.unwrap();
        assert!(!original.read_only);
        assert_eq!(original.name, "测试库");
        assert_eq!(state.local.list_sessions().await.unwrap().len(), 2);
        assert!(state.connections.lock().await.is_empty());
        assert!(duplicate(&state, "missing", input).await.is_err());
    }
}
