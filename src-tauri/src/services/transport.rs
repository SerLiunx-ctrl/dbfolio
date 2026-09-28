use super::connection_config::{NetworkConfig, SshConfig};
use crate::{
    adapters::ConnectionParams,
    error::{AppError, AppResult},
    meta::Engine,
};
use russh::{
    client,
    keys::{HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate},
};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncWrite},
    net::{TcpListener, TcpStream},
    task::{JoinHandle, JoinSet},
};

pub fn err(e: impl std::fmt::Display) -> AppError {
    AppError::Connection(e.to_string())
}
pub struct HostCheck {
    pub expected: String,
    pub observed: Arc<Mutex<Option<String>>>,
}
impl client::Handler for HostCheck {
    type Error = russh::Error;
    async fn check_server_key(
        &mut self,
        key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let fingerprint = key.public_key().fingerprint(HashAlg::Sha256).to_string();
        *self.observed.lock().unwrap() = Some(fingerprint.clone());
        Ok(!self.expected.is_empty() && self.expected == fingerprint)
    }
}
pub async fn fingerprint(ssh: &SshConfig, seconds: u64) -> AppResult<String> {
    if ssh.host.trim().is_empty() || ssh.port == 0 {
        return Err(err("请填写 SSH 地址和端口"));
    }
    let observed = Arc::new(Mutex::new(None));
    let result = tokio::time::timeout(
        Duration::from_secs(seconds.clamp(1, 120)),
        client::connect(
            Arc::new(client::Config::default()),
            (ssh.host.as_str(), ssh.port),
            HostCheck {
                expected: String::new(),
                observed: observed.clone(),
            },
        ),
    )
    .await;
    let value = observed.lock().unwrap().clone();
    value.ok_or_else(|| {
        err(match result {
            Ok(Err(e)) => format!("SSH 握手失败：{e}"),
            _ => "获取 SSH 指纹超时或失败".into(),
        })
    })
}
pub struct Transport {
    task: JoinHandle<()>,
    pub failure: Arc<Mutex<Option<String>>>,
}
impl Transport {
    pub fn stop(&self) {
        self.task.abort();
    }
}
impl Drop for Transport {
    fn drop(&mut self) {
        self.stop();
    }
}
impl std::fmt::Debug for Transport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Transport")
    }
}
trait Stream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Stream for T {}
type BoxStream = Box<dyn Stream>;
type SshHandle = client::Handle<HostCheck>;

async fn ssh_connect(
    s: &SshConfig,
    password: Option<&str>,
    passphrase: Option<&str>,
    seconds: u64,
) -> AppResult<Arc<SshHandle>> {
    let observed = Arc::new(Mutex::new(None));
    let config = client::Config {
        keepalive_interval: Some(Duration::from_secs(15)),
        keepalive_max: 3,
        ..Default::default()
    };
    let mut handle = client::connect(
        Arc::new(config),
        (s.host.as_str(), s.port),
        HostCheck {
            expected: s.fingerprint.clone(),
            observed: observed.clone(),
        },
    )
    .await
    .map_err(|e| {
        if let Some(actual) = observed.lock().unwrap().as_ref() {
            if actual != &s.fingerprint {
                return err(format!(
                    "SSH 主机指纹不匹配，连接已拒绝；当前指纹：{actual}"
                ));
            }
        }
        err(format!("SSH 握手失败：{e}"))
    })?;
    let auth = if s.auth == "key" {
        let path = s.private_key.clone().unwrap_or_default();
        let pass = passphrase.map(str::to_owned);
        let key = tokio::task::spawn_blocking(move || {
            russh::keys::load_secret_key(path, pass.as_deref())
        })
        .await
        .map_err(err)?
        .map_err(|_| err("SSH 私钥读取/解密失败，请检查格式与口令"))?;
        let hash = handle
            .best_supported_rsa_hash()
            .await
            .map_err(err)?
            .flatten();
        handle
            .authenticate_publickey(&s.username, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
            .await
    } else {
        handle
            .authenticate_password(&s.username, password.unwrap_or(""))
            .await
    }
    .map_err(|_| err("SSH 认证失败"))?;
    if !auth.success() {
        return Err(err("SSH 认证失败，请检查用户名、密码或私钥"));
    }
    let _ = seconds;
    Ok(Arc::new(handle))
}
pub fn tls_config(n: &NetworkConfig) -> AppResult<Arc<tokio_rustls::rustls::ClientConfig>> {
    use tokio_rustls::rustls::{ClientConfig, RootCertStore};
    let mut roots = RootCertStore::empty();
    if let Some(path) = &n.ca_file {
        let bytes = std::fs::read(path).map_err(|_| err("无法读取 CA 文件"))?;
        let certs = rustls_pemfile::certs(&mut bytes.as_slice())
            .collect::<Result<Vec<_>, _>>()
            .map_err(err)?;
        if certs.is_empty() {
            return Err(err("CA 文件中没有 PEM 证书"));
        }
        for cert in certs {
            roots.add(cert).map_err(err)?;
        }
    } else {
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    }
    let provider = Arc::new(tokio_rustls::rustls::crypto::ring::default_provider());
    let builder = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(err)?
        .with_root_certificates(roots);
    let config = if let (Some(cert), Some(key)) = (&n.client_cert, &n.client_key) {
        let bytes = std::fs::read(cert).map_err(|_| err("无法读取客户端证书"))?;
        let certs = rustls_pemfile::certs(&mut bytes.as_slice())
            .collect::<Result<Vec<_>, _>>()
            .map_err(err)?;
        let bytes = std::fs::read(key).map_err(|_| err("无法读取客户端私钥"))?;
        let key = rustls_pemfile::private_key(&mut bytes.as_slice())
            .map_err(err)?
            .ok_or_else(|| err("客户端私钥不是可用 PEM"))?;
        builder.with_client_auth_cert(certs, key).map_err(err)?
    } else {
        builder.with_no_client_auth()
    };
    Ok(Arc::new(config))
}
async fn upstream(
    ssh: &Option<Arc<SshHandle>>,
    host: &str,
    port: u16,
    tls: &Option<Arc<tokio_rustls::rustls::ClientConfig>>,
    name: &str,
) -> AppResult<BoxStream> {
    let stream: BoxStream = if let Some(ssh) = ssh {
        Box::new(
            ssh.channel_open_direct_tcpip(host, port as u32, "127.0.0.1", 0)
                .await
                .map_err(|e| err(format!("SSH 转发失败：{e}")))?
                .into_stream(),
        )
    } else {
        Box::new(TcpStream::connect((host, port)).await.map_err(err)?)
    };
    if let Some(tls) = tls {
        let name = tokio_rustls::rustls::pki_types::ServerName::try_from(name.to_owned())
            .map_err(|_| err("TLS 服务器名无效"))?;
        Ok(Box::new(
            tokio_rustls::TlsConnector::from(tls.clone())
                .connect(name, stream)
                .await
                .map_err(|e| err(format!("TLS 握手/证书校验失败：{e}")))?,
        ))
    } else {
        Ok(stream)
    }
}
pub async fn prepare(
    p: &mut ConnectionParams,
    password: Option<&str>,
    passphrase: Option<&str>,
) -> AppResult<Option<Arc<Transport>>> {
    if p.engine == Engine::Sqlite {
        return Ok(None);
    }
    let n = &p.network;
    let host = p.host.clone().unwrap_or_else(|| "127.0.0.1".into());
    let port = p.port.unwrap_or(match p.engine {
        Engine::Mysql => 3306,
        Engine::Postgres => 5432,
        Engine::Redis => 6379,
        _ => 27017,
    });
    let tls_bridge = matches!(p.engine, Engine::Redis | Engine::Mongodb)
        && p.tls == Some(true)
        && !host.starts_with("mongodb");
    if n.ssh.is_none() && !tls_bridge {
        return Ok(None);
    }
    let seconds = n.connect_timeout();
    let ssh = if let Some(s) = &n.ssh {
        Some(ssh_connect(s, password, passphrase, seconds).await?)
    } else {
        None
    };
    let tls = if tls_bridge {
        Some(tls_config(n).map_err(|e| err(format!("TLS 配置失败：{e}")))?)
    } else {
        None
    };
    let name = n.server_name.clone().unwrap_or_else(|| host.clone());
    // 在交给驱动前实际验证远端转发和 TLS，避免只监听本地端口就报告成功。
    let probe = upstream(&ssh, &host, port, &tls, &name).await?;
    drop(probe);
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.map_err(err)?;
    p.host = Some("127.0.0.1".into());
    p.port = Some(listener.local_addr().map_err(err)?.port());
    p.network.server_name = Some(name.clone());
    if tls_bridge {
        p.tls = Some(false);
        p.tls_terminated = true;
    }
    p.tunneled = true;
    let failure = Arc::new(Mutex::new(None));
    let errors = failure.clone();
    let task = tokio::spawn(async move {
        let mut channels = JoinSet::new();
        let mut health = tokio::time::interval(Duration::from_secs(1));
        loop {
            tokio::select! {
                accepted=listener.accept()=>{
                    let Ok((mut local,_))=accepted else{break};let ssh=ssh.clone();let tls=tls.clone();let host=host.clone();let name=name.clone();let errors=errors.clone();
                    channels.spawn(async move{
                        let result=tokio::time::timeout(Duration::from_secs(seconds),upstream(&ssh,&host,port,&tls,&name)).await;
                        match result{
                            Ok(Ok(mut remote))=>{if let Err(e)=tokio::io::copy_bidirectional(&mut local,&mut remote).await{*errors.lock().unwrap()=Some(format!("{}传输失败：{e}",if tls.is_some(){"TLS "}else{"SSH "}));}},
                            Ok(Err(e))=>{*errors.lock().unwrap()=Some(e.to_string());},
                            Err(_)=>{*errors.lock().unwrap()=Some("隧道连接超时".into());}
                        }
                    });
                },
                _=channels.join_next(),if !channels.is_empty()=>{},
                _=health.tick(),if ssh.is_some()=>{if ssh.as_ref().is_some_and(|s|s.is_closed()){*errors.lock().unwrap()=Some("SSH 连接已断开，请重新连接会话".into());break;}},
            }
        }
    });
    Ok(Some(Arc::new(Transport { task, failure })))
}
