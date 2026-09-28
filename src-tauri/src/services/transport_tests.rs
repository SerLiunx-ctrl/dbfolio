use super::connection_config::{NetworkConfig, SshConfig};
use super::transport::*;
use crate::adapters::ConnectionParams;
use russh::{
    keys::{key::safe_rng, Algorithm, HashAlg, PrivateKey, PublicKey},
    server,
};
use std::{sync::Arc, time::Duration};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

#[derive(Clone)]
struct SshServer {
    public: PublicKey,
}
impl server::Server for SshServer {
    type Handler = Self;
    fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> Self {
        self.clone()
    }
}
impl server::Handler for SshServer {
    type Error = russh::Error;
    async fn auth_password(
        &mut self,
        user: &str,
        password: &str,
    ) -> Result<server::Auth, Self::Error> {
        Ok(if user == "qa" && password == "test-only" {
            server::Auth::Accept
        } else {
            server::Auth::reject()
        })
    }
    async fn auth_publickey(
        &mut self,
        user: &str,
        key: &PublicKey,
    ) -> Result<server::Auth, Self::Error> {
        Ok(if user == "qa" && key == &self.public {
            server::Auth::Accept
        } else {
            server::Auth::reject()
        })
    }
    async fn channel_open_direct_tcpip(
        &mut self,
        channel: russh::Channel<server::Msg>,
        host: &str,
        port: u32,
        _: &str,
        _: u32,
        reply: server::ChannelOpenHandle,
        _: &mut server::Session,
    ) -> Result<(), Self::Error> {
        if host != "127.0.0.1" {
            return Ok(());
        }
        if let Ok(mut remote) = TcpStream::connect((host, port as u16)).await {
            reply.accept().await;
            tokio::spawn(async move {
                let _ =
                    tokio::io::copy_bidirectional(&mut channel.into_stream(), &mut remote).await;
            });
        }
        Ok(())
    }
}
async fn ssh_server() -> (SshConfig, PrivateKey, tokio::task::JoinHandle<()>) {
    use server::Server;
    let host = PrivateKey::random(&mut safe_rng(), Algorithm::Ed25519).unwrap();
    let key = PrivateKey::random(&mut safe_rng(), Algorithm::Ed25519).unwrap();
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let ssh = SshConfig {
        host: "127.0.0.1".into(),
        port: listener.local_addr().unwrap().port(),
        username: "qa".into(),
        auth: "password".into(),
        private_key: None,
        fingerprint: host.public_key().fingerprint(HashAlg::Sha256).to_string(),
    };
    let config = Arc::new(server::Config {
        keys: vec![host],
        auth_rejection_time: Duration::from_millis(1),
        ..Default::default()
    });
    let mut server = SshServer {
        public: key.public_key().clone(),
    };
    let task = tokio::spawn(async move {
        server.run_on_socket(config, &listener).await.unwrap();
    });
    (ssh, key, task)
}
async fn echo() -> (u16, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let task = tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                let (mut r, mut w) = stream.into_split();
                let _ = tokio::io::copy(&mut r, &mut w).await;
            });
        }
    });
    (port, task)
}
fn params(port: u16) -> ConnectionParams {
    serde_json::from_value(serde_json::json!({"engine":"mysql","host":"127.0.0.1","port":port}))
        .unwrap()
}
#[tokio::test]
async fn ssh_password_key_fingerprint_and_cleanup() {
    let (ssh, key, server) = ssh_server().await;
    let (port, echo) = echo().await;
    assert_eq!(fingerprint(&ssh, 5).await.unwrap(), ssh.fingerprint);
    let mut p = params(port);
    p.network.ssh = Some(ssh.clone());
    assert!(prepare(&mut p.clone(), Some("wrong"), None)
        .await
        .unwrap_err()
        .to_string()
        .contains("认证失败"));
    let mut wrong = p.clone();
    wrong.network.ssh.as_mut().unwrap().fingerprint = "SHA256:wrong".into();
    assert!(prepare(&mut wrong, Some("test-only"), None)
        .await
        .unwrap_err()
        .to_string()
        .contains("指纹不匹配"));
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("id_ed25519");
    let encrypted = key.encrypt(&mut safe_rng(), "passphrase").unwrap();
    std::fs::write(
        &path,
        encrypted.to_openssh(Default::default()).unwrap().as_bytes(),
    )
    .unwrap();
    for private in [false, true] {
        let mut p = p.clone();
        if private {
            let ssh = p.network.ssh.as_mut().unwrap();
            ssh.auth = "key".into();
            ssh.private_key = Some(path.to_string_lossy().into());
        }
        let guard = prepare(&mut p, Some("test-only"), Some("passphrase"))
            .await
            .unwrap()
            .unwrap();
        let addr = ("127.0.0.1", p.port.unwrap());
        let mut stream = TcpStream::connect(addr).await.unwrap();
        stream.write_all(b"hello").await.unwrap();
        let mut bytes = [0; 5];
        stream.read_exact(&mut bytes).await.unwrap();
        assert_eq!(&bytes, b"hello");
        drop(guard);
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(TcpStream::connect(addr).await.is_err());
        let closed = tokio::time::timeout(Duration::from_secs(1), stream.read(&mut bytes))
            .await
            .unwrap();
        assert!(closed.is_err() || closed.unwrap() == 0);
    }
    let mut p = p;
    p.network.ssh.as_mut().unwrap().auth = "key".into();
    p.network.ssh.as_mut().unwrap().private_key = Some(path.to_string_lossy().into());
    assert!(prepare(&mut p, None, Some("wrong")).await.is_err());
    server.abort();
    echo.abort();
}

#[tokio::test]
async fn tls_certificates_hostname_and_ssh_tls() {
    use tokio_rustls::{rustls, TlsAcceptor};
    let identity = rcgen::generate_simple_self_signed(vec!["db.test".into()]).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let ca = dir.path().join("ca.pem");
    std::fs::write(&ca, identity.cert.pem()).unwrap();
    let key = rustls::pki_types::PrivatePkcs8KeyDer::from(identity.signing_key.serialize_der());
    let config = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_no_client_auth()
    .with_single_cert(vec![identity.cert.der().clone()], key.into())
    .unwrap();
    let acceptor = TlsAcceptor::from(Arc::new(config));
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let a = acceptor.clone();
            tokio::spawn(async move {
                if let Ok(stream) = a.accept(stream).await {
                    let (mut r, mut w) = tokio::io::split(stream);
                    let _ = tokio::io::copy(&mut r, &mut w).await;
                }
            });
        }
    });
    let (ssh, _, ssh_server) = ssh_server().await;
    let mut p = params(port);
    p.engine = crate::meta::Engine::Redis;
    p.tls = Some(true);
    p.network.ca_file = Some(ca.to_string_lossy().into());
    p.network.server_name = Some("db.test".into());
    for tunnel in [false, true] {
        let mut p = p.clone();
        if tunnel {
            p.network.ssh = Some(ssh.clone());
        }
        let guard = prepare(&mut p, Some("test-only"), None)
            .await
            .unwrap()
            .unwrap();
        let mut stream = TcpStream::connect(("127.0.0.1", p.port.unwrap()))
            .await
            .unwrap();
        stream.write_all(b"tls").await.unwrap();
        let mut bytes = [0; 3];
        stream.read_exact(&mut bytes).await.unwrap();
        assert_eq!(&bytes, b"tls");
        drop(guard);
    }
    let mut bad = p.clone();
    bad.network.server_name = Some("wrong.test".into());
    assert!(prepare(&mut bad, None, None).await.is_err());
    let mut bad = p;
    bad.network.ca_file = None;
    assert!(prepare(&mut bad, None, None).await.is_err());
    server.abort();
    ssh_server.abort();
}

#[tokio::test]
async fn tls_client_certificate_authentication() {
    use tokio_rustls::{rustls, TlsAcceptor};
    let server_id = rcgen::generate_simple_self_signed(vec!["db.test".into()]).unwrap();
    let client_id = rcgen::generate_simple_self_signed(vec!["client.test".into()]).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let ca = dir.path().join("ca.pem");
    let cert = dir.path().join("client.pem");
    let key = dir.path().join("client.key");
    std::fs::write(&ca, server_id.cert.pem()).unwrap();
    std::fs::write(&cert, client_id.cert.pem()).unwrap();
    std::fs::write(&key, client_id.signing_key.serialize_pem()).unwrap();
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut roots = rustls::RootCertStore::empty();
    roots.add(client_id.cert.der().clone()).unwrap();
    let verifier = rustls::server::WebPkiClientVerifier::builder_with_provider(
        Arc::new(roots),
        provider.clone(),
    )
    .build()
    .unwrap();
    let config = rustls::ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_client_cert_verifier(verifier)
        .with_single_cert(
            vec![server_id.cert.der().clone()],
            rustls::pki_types::PrivatePkcs8KeyDer::from(server_id.signing_key.serialize_der())
                .into(),
        )
        .unwrap();
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let acceptor = TlsAcceptor::from(Arc::new(config));
    let server = tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let a = acceptor.clone();
            tokio::spawn(async move {
                if let Ok(mut stream) = a.accept(stream).await {
                    let _ = stream.write_all(b"authenticated").await;
                }
            });
        }
    });
    let n = NetworkConfig {
        ca_file: Some(ca.to_string_lossy().into()),
        client_cert: Some(cert.to_string_lossy().into()),
        client_key: Some(key.to_string_lossy().into()),
        ..Default::default()
    };
    let connector = tokio_rustls::TlsConnector::from(tls_config(&n).unwrap());
    let mut stream = connector
        .connect(
            "db.test".try_into().unwrap(),
            TcpStream::connect(("127.0.0.1", port)).await.unwrap(),
        )
        .await
        .unwrap();
    let mut bytes = [0; 13];
    stream.read_exact(&mut bytes).await.unwrap();
    assert_eq!(&bytes, b"authenticated");
    let n = NetworkConfig {
        client_cert: None,
        client_key: None,
        ..n
    };
    let connector = tokio_rustls::TlsConnector::from(tls_config(&n).unwrap());
    if let Ok(mut stream) = connector
        .connect(
            "db.test".try_into().unwrap(),
            TcpStream::connect(("127.0.0.1", port)).await.unwrap(),
        )
        .await
    {
        assert!(stream.read_exact(&mut bytes).await.is_err());
    }
    server.abort();
}

#[tokio::test]
async fn network_settings_roundtrip_and_no_plaintext_credentials() {
    let dir = tempfile::tempdir().unwrap();
    let store = crate::store::LocalStore::initialize_in(dir.path().into())
        .await
        .unwrap();
    let input=serde_json::from_value(serde_json::json!({"name":"网络测试","engine":"mysql","readOnly":false,"host":"127.0.0.1","network":{"connectTimeoutSecs":7,"queryTimeoutSecs":12,"caFile":"ca.pem"}})).unwrap();
    let saved = store.create_session(&input).await.unwrap();
    assert_eq!(saved.network.connect_timeout(), 7);
    assert_eq!(saved.network.query_timeout(), 12);
    assert!(serde_json::from_str::<NetworkConfig>(r#"{"sshPassword":"secret"}"#).is_err());
    let bad = NetworkConfig {
        connect_timeout_secs: Some(0),
        ..Default::default()
    };
    assert!(bad
        .validate(crate::meta::Engine::Mysql, Some("localhost"))
        .is_err());
}

#[tokio::test]
async fn diagnostic_network_failure_and_connection_timeout() {
    let dir = tempfile::tempdir().unwrap();
    let state = crate::state::AppState::with_local(
        crate::store::LocalStore::initialize_in(dir.path().into())
            .await
            .unwrap(),
    );
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let input=serde_json::from_value(serde_json::json!({"name":"test","engine":"mysql","readOnly":false,"host":"127.0.0.1","port":port,"password":"","network":{"connectTimeoutSecs":1}})).unwrap();
    let r = super::session::test(&state, None, &input).await.unwrap();
    assert!(!r.ok);
    assert!(r
        .steps
        .iter()
        .any(|s| s.key == "network" && s.status == "failed"));
    let listener = TcpListener::bind(("127.0.0.1", port)).await.unwrap();
    let server = tokio::spawn(async move {
        let mut streams = Vec::new();
        while let Ok((stream, _)) = listener.accept().await {
            streams.push(stream);
        }
    });
    let r = super::session::test(&state, None, &input).await.unwrap();
    assert!(!r.ok);
    assert!(r.steps.iter().any(|s| s.message.contains("连接超时")));
    server.abort();
}

#[tokio::test]
#[ignore = "需要本机已保存 MySQL 凭据；SSH 为进程内隔离服务，仅读取服务器信息"]
async fn r04_mysql_connection_diagnostics() {
    let state = crate::state::AppState::initialize().await.unwrap();
    let sessions = state.local.list_sessions().await.unwrap();
    let saved = sessions
        .iter()
        .find(|s| {
            s.engine == crate::meta::Engine::Mysql
                && s.host.as_deref() == Some("127.0.0.1")
                && s.allowed_databases.is_none()
        })
        .unwrap();
    let mut input: crate::store::SessionInput =
        serde_json::from_value(serde_json::to_value(saved).unwrap()).unwrap();
    input.network = NetworkConfig::default();
    input.database = Some("mysql".into());
    input.ssl_mode = Some("require".into());
    let r = super::session::test(&state, Some(&saved.id), &input)
        .await
        .unwrap();
    assert!(r.ok, "{:?}", r.steps);
    let (ssh, _, server) = ssh_server().await;
    input.network.ssh = Some(ssh);
    input.ssh_password = Some("test-only".into());
    let r = super::session::test(&state, Some(&saved.id), &input)
        .await
        .unwrap();
    assert!(r.ok, "{:?}", r.steps);
    input.password = Some(uuid::Uuid::new_v4().to_string());
    let r = super::session::test(&state, Some(&saved.id), &input)
        .await
        .unwrap();
    assert!(!r.ok);
    assert!(r
        .steps
        .iter()
        .any(|s| s.key == "authentication" && s.status == "failed"));
    input.password = None;
    input.database = Some(format!("dbfolio_missing_{}", uuid::Uuid::new_v4().simple()));
    let r = super::session::test(&state, Some(&saved.id), &input)
        .await
        .unwrap();
    assert!(!r.ok);
    assert!(
        r.steps
            .iter()
            .any(|s| s.key == "database" && s.status == "failed"),
        "{:?}",
        r.steps
    );
    input.database = Some("mysql".into());
    input.ssl_mode = Some("verify-full".into());
    input.network.server_name = Some("dbfolio.invalid".into());
    let r = super::session::test(&state, Some(&saved.id), &input)
        .await
        .unwrap();
    assert!(!r.ok);
    assert!(
        r.steps
            .iter()
            .any(|s| s.key == "tls" && s.status == "failed"),
        "{:?}",
        r.steps
    );
    server.abort();
}

async fn other_engine_direct_and_ssh(engine: crate::meta::Engine) {
    let state = crate::state::AppState::initialize().await.unwrap();
    let sessions = state.local.list_sessions().await.unwrap();
    let (ssh, _, server) = ssh_server().await;
    {
        let saved = sessions
            .iter()
            .find(|s| s.engine == engine && s.host.as_deref() == Some("127.0.0.1"))
            .expect("缺少本机验收会话");
        let mut input: crate::store::SessionInput =
            serde_json::from_value(serde_json::to_value(saved).unwrap()).unwrap();
        input.network = Default::default();
        for tunnel in [false, true] {
            if tunnel {
                input.network.ssh = Some(ssh.clone());
                input.ssh_password = Some("test-only".into());
            }
            let r = super::session::test(&state, Some(&saved.id), &input)
                .await
                .unwrap();
            assert!(r.ok, "{engine:?} SSH={tunnel} {:?}", r.steps);
        }
        println!("{engine:?} 直连与 SSH 通过");
    }
    server.abort();
}

#[tokio::test]
#[ignore = "需要本机 PostgreSQL 服务和保存凭据"]
async fn r04_postgres_direct_and_ssh() {
    other_engine_direct_and_ssh(crate::meta::Engine::Postgres).await;
}
#[tokio::test]
#[ignore = "需要本机 Redis 服务和保存凭据"]
async fn r04_redis_direct_and_ssh() {
    other_engine_direct_and_ssh(crate::meta::Engine::Redis).await;
}
#[tokio::test]
#[ignore = "需要本机 MongoDB 服务和保存凭据"]
async fn r04_mongodb_direct_and_ssh() {
    other_engine_direct_and_ssh(crate::meta::Engine::Mongodb).await;
}

#[tokio::test]
#[ignore = "需要 Windows 凭据管理器；仅创建并清理随机测试会话凭据"]
async fn r04_ssh_credentials_copy_clear_delete() {
    use crate::store::secrets;
    struct Cleanup(Vec<String>);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            for id in &self.0 {
                for suffix in ["ssh-password", "ssh-key-passphrase"] {
                    let _ = secrets::delete_password(&format!("{id}:{suffix}"));
                }
            }
        }
    }
    let mut cleanup = Cleanup(vec![]);
    let dir = tempfile::tempdir().unwrap();
    let state = crate::state::AppState::with_local(
        crate::store::LocalStore::initialize_in(dir.path().into())
            .await
            .unwrap(),
    );
    let mut input:crate::store::SessionInput=serde_json::from_value(serde_json::json!({"name":"凭据测试","engine":"mysql","readOnly":false,"host":"127.0.0.1","password":"","sshPassword":"temporary-ssh-password","sshKeyPassphrase":"temporary-key-passphrase"})).unwrap();
    let saved = state.local.create_session(&input).await.unwrap();
    cleanup.0.push(saved.id.clone());
    assert_eq!(
        secrets::load_password(&format!("{}:ssh-password", saved.id))
            .unwrap()
            .as_deref(),
        Some("temporary-ssh-password")
    );
    assert!(!serde_json::to_string(&saved)
        .unwrap()
        .contains("temporary-"));
    input.ssh_password = None;
    input.ssh_key_passphrase = None;
    let copy = super::session::duplicate(&state, &saved.id, input.clone())
        .await
        .unwrap();
    cleanup.0.push(copy.id.clone());
    assert_eq!(
        secrets::load_password(&format!("{}:ssh-key-passphrase", copy.id))
            .unwrap()
            .as_deref(),
        Some("temporary-key-passphrase")
    );
    input.ssh_password = Some(String::new());
    state.local.update_session(&saved.id, &input).await.unwrap();
    assert!(
        secrets::load_password(&format!("{}:ssh-password", saved.id))
            .unwrap()
            .is_none()
    );
    state.local.delete_session(&copy.id).await.unwrap();
    assert!(
        secrets::load_password(&format!("{}:ssh-key-passphrase", copy.id))
            .unwrap()
            .is_none()
    );
    state.local.delete_session(&saved.id).await.unwrap();
}

#[tokio::test]
#[ignore = "需要本机 MySQL 管理凭据；创建并删除随机无权限测试账号"]
async fn r04_mysql_permission_diagnostic() {
    use futures_util::FutureExt;
    use sqlx::Executor;
    let state = crate::state::AppState::initialize().await.unwrap();
    let sessions = state.local.list_sessions().await.unwrap();
    let saved = sessions
        .iter()
        .find(|s| {
            s.engine == crate::meta::Engine::Mysql
                && s.host.as_deref() == Some("127.0.0.1")
                && !s.read_only
                && s.allowed_databases.is_none()
        })
        .unwrap();
    super::session::connect(&state, &saved.id).await.unwrap();
    let adapter = state.connected(&saved.id).await.unwrap().adapter.clone();
    let mut conn = adapter.mysql_connection("mysql", true).await.unwrap();
    let user = format!(
        "dbfr04_{}",
        &uuid::Uuid::new_v4().simple().to_string()[..16]
    );
    let password = uuid::Uuid::new_v4().to_string();
    conn.execute(format!("CREATE USER '{user}'@'localhost' IDENTIFIED BY '{password}'").as_str())
        .await
        .unwrap();
    let outcome = std::panic::AssertUnwindSafe(async {
        let mut input: crate::store::SessionInput =
            serde_json::from_value(serde_json::to_value(saved).unwrap()).unwrap();
        input.username = Some(user.clone());
        input.password = Some(password);
        input.database = Some("mysql".into());
        input.network = Default::default();
        let r = super::session::test(&state, None, &input).await.unwrap();
        assert!(!r.ok);
        assert!(
            r.steps
                .iter()
                .any(|s| s.key == "database" && s.status == "failed"),
            "{:?}",
            r.steps
        );
    })
    .catch_unwind()
    .await;
    conn.execute(format!("DROP USER '{user}'@'localhost'").as_str())
        .await
        .unwrap();
    if let Err(e) = outcome {
        std::panic::resume_unwind(e);
    }
}

#[tokio::test]
async fn postgres_tls_name_survives_ssh_endpoint() {
    use sqlx::Connection;
    use tokio_rustls::{rustls, TlsAcceptor};
    let identity = rcgen::generate_simple_self_signed(vec!["db.test".into()]).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let ca = dir.path().join("ca.pem");
    std::fs::write(&ca, identity.cert.pem()).unwrap();
    let config = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_no_client_auth()
    .with_single_cert(
        vec![identity.cert.der().clone()],
        rustls::pki_types::PrivatePkcs8KeyDer::from(identity.signing_key.serialize_der()).into(),
    )
    .unwrap();
    let acceptor = TlsAcceptor::from(Arc::new(config));
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    // PostgreSQL SSLRequest + StartupMessage；握手后返回可识别的认证错误，证明到达数据库协议层。
    let server = tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            let a = acceptor.clone();
            tokio::spawn(async move {
                let mut request = [0; 8];
                if stream.read_exact(&mut request).await.is_err() {
                    return;
                }
                assert_eq!(request, [0, 0, 0, 8, 4, 210, 22, 47]);
                stream.write_all(b"S").await.unwrap();
                if let Ok(mut stream) = a.accept(stream).await {
                    let Ok(len) = stream.read_u32().await else {
                        return;
                    };
                    if len > 10000 {
                        return;
                    }
                    let mut startup = vec![0; len as usize - 4];
                    if stream.read_exact(&mut startup).await.is_err() {
                        return;
                    }
                    let payload = b"SERROR\0C28000\0MDBFolio TLS verified\0\0";
                    let mut msg = vec![b'E'];
                    msg.extend_from_slice(&((payload.len() + 4) as u32).to_be_bytes());
                    msg.extend_from_slice(payload);
                    let _ = stream.write_all(&msg).await;
                }
            });
        }
    });
    let (ssh, _, jump) = ssh_server().await;
    for tunneled in [false, true] {
        let mut p = params(port);
        p.engine = crate::meta::Engine::Postgres;
        if tunneled {
            p.network.ssh = Some(ssh.clone());
        }
        let guard = prepare(&mut p, Some("test-only"), None).await.unwrap();
        let opts = sqlx::postgres::PgConnectOptions::new()
            .host("127.0.0.1")
            .port(p.port.unwrap())
            .username("qa")
            .database("qa")
            .ssl_mode(sqlx::postgres::PgSslMode::VerifyFull)
            .ssl_root_cert(&ca)
            .tls_server_name("db.test");
        let error = sqlx::PgConnection::connect_with(&opts)
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("DBFolio TLS verified"), "{error}");
        let error = sqlx::PgConnection::connect_with(&opts.tls_server_name("wrong.test"))
            .await
            .unwrap_err()
            .to_string();
        assert!(!error.contains("DBFolio TLS verified"));
        assert!(error.to_lowercase().contains("certificate"), "{error}");
        drop(guard);
    }
    server.abort();
    jump.abort();
}
