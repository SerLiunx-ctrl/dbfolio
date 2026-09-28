use crate::{
    error::{AppError, AppResult},
    meta::Engine,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct NetworkConfig {
    pub ssh: Option<SshConfig>,
    pub ca_file: Option<String>,
    pub client_cert: Option<String>,
    pub client_key: Option<String>,
    pub server_name: Option<String>,
    pub connect_timeout_secs: Option<u64>,
    pub query_timeout_secs: Option<u64>,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct SshConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: String,
    pub private_key: Option<String>,
    pub fingerprint: String,
}
impl NetworkConfig {
    pub fn connect_timeout(&self) -> u64 {
        self.connect_timeout_secs.unwrap_or(15)
    }
    pub fn query_timeout(&self) -> u64 {
        self.query_timeout_secs.unwrap_or(60)
    }
    pub fn validate(&self, engine: Engine, host: Option<&str>) -> AppResult<()> {
        let invalid = |s: &str| AppError::InvalidInput(s.into());
        if !(1..=120).contains(&self.connect_timeout())
            || !(1..=3600).contains(&self.query_timeout())
        {
            return Err(invalid("连接超时应为 1～120 秒，查询超时应为 1～3600 秒"));
        }
        if engine == Engine::Sqlite
            && (self.ssh.is_some()
                || self.ca_file.is_some()
                || self.client_cert.is_some()
                || self.client_key.is_some()
                || self.server_name.is_some())
        {
            return Err(invalid("SQLite 不使用 SSH 或 TLS"));
        }
        if let Some(ssh) = &self.ssh {
            if ssh.host.trim().is_empty() || ssh.username.trim().is_empty() || ssh.port == 0 {
                return Err(invalid("请填写 SSH 地址、端口和用户名"));
            }
            if !["password", "key"].contains(&ssh.auth.as_str()) {
                return Err(invalid("SSH 认证方式无效"));
            }
            if ssh.auth == "key" && ssh.private_key.as_deref().unwrap_or("").is_empty() {
                return Err(invalid("请选择 SSH 私钥"));
            }
            if !ssh.fingerprint.starts_with("SHA256:") || ssh.fingerprint.len() < 30 {
                return Err(invalid("请先获取并核对 SSH 主机 SHA256 指纹"));
            }
        }
        let uri = engine == Engine::Mongodb && host.is_some_and(|h| h.starts_with("mongodb"));
        if uri && self.client_key.is_some() {
            return Err(invalid(
                "MongoDB URI 请使用包含证书和私钥的单个 PEM 文件，私钥栏留空",
            ));
        }
        if uri && (self.ssh.is_some() || self.server_name.is_some()) {
            return Err(invalid(
                "SSH 或自定义 TLS 服务器名请使用单个 MongoDB 主机地址；URI/SRV 模式保持直连",
            ));
        }
        if self.client_key.is_some() != self.client_cert.is_some()
            && !(engine == Engine::Mongodb
                && uri
                && self.client_cert.is_some()
                && self.client_key.is_none())
        {
            return Err(invalid(
                "客户端证书和私钥需同时配置（MongoDB URI 可使用包含私钥的 PEM）",
            ));
        }
        for path in [&self.ca_file, &self.client_cert, &self.client_key]
            .into_iter()
            .flatten()
        {
            if path.trim().is_empty() {
                return Err(invalid("证书路径不能为空"));
            }
        }
        Ok(())
    }
}
