use super::model::*;
use crate::{
    adapters::ConnectionParams,
    error::{AppError, AppResult},
    meta::Engine,
};
use reqwest::{Client, Method, Url};
use serde_json::Value;
use std::time::Duration;
use tokio::sync::RwLock;
pub struct Http {
    pub client: Client,
    pub base: Url,
    pub engine: Engine,
    username: Option<String>,
    password: Option<String>,
    cookie: RwLock<Option<String>>,
    csrf: RwLock<Option<(String, String)>>,
}
impl Http {
    pub async fn connect(p: &ConnectionParams) -> AppResult<Self> {
        let host = p.host.as_deref().unwrap_or("");
        if host.contains(['/', '?', '#', '@']) {
            return Err(invalid("管理主机只填写主机名或 IP，路径前缀请单独设置"));
        }
        let port = p.port.unwrap_or(if p.engine == Engine::Rabbitmq {
            15672
        } else {
            8082
        });
        let host = if host.contains(':') && !host.starts_with('[') {
            format!("[{host}]")
        } else {
            host.into()
        };
        let base = Url::parse(&format!(
            "{}://{host}:{port}{}/",
            if p.tls == Some(true) { "https" } else { "http" },
            p.network
                .http_path
                .as_deref()
                .unwrap_or("")
                .trim_end_matches('/')
        ))
        .map_err(|_| invalid("管理接口地址无效"))?;
        let mut builder = Client::builder()
            .retry(reqwest::retry::never())
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(p.network.connect_timeout()))
            .timeout(Duration::from_secs(p.network.query_timeout()));
        if let Some(path) = &p.network.ca_file {
            let bytes = std::fs::read(path).map_err(|_| invalid("无法读取 CA 文件"))?;
            for cert in reqwest::Certificate::from_pem_bundle(&bytes)
                .map_err(|_| invalid("CA PEM 证书无效"))?
            {
                builder = builder.add_root_certificate(cert);
            }
        }
        if let (Some(cert), Some(key)) = (&p.network.client_cert, &p.network.client_key) {
            let mut pem = std::fs::read(cert).map_err(|_| invalid("无法读取客户端证书"))?;
            pem.extend_from_slice(b"\n");
            pem.extend(std::fs::read(key).map_err(|_| invalid("无法读取客户端私钥"))?);
            builder = builder.identity(
                reqwest::Identity::from_pem(&pem)
                    .map_err(|_| invalid("客户端证书/私钥 PEM 无效"))?,
            );
        }
        let this = Self {
            client: builder
                .build()
                .map_err(|_| invalid("无法创建管理接口客户端"))?,
            base,
            engine: p.engine,
            username: p.username.clone().filter(|s| !s.is_empty()),
            password: p.password.clone(),
            cookie: RwLock::new(None),
            csrf: RwLock::new(None),
        };
        if p.engine == Engine::Rocketmq {
            this.load_csrf().await?;
            let check = this
                .request(Method::GET, &["login", "check.query"], &[], None)
                .await?;
            if check["loginRequired"].as_bool() == Some(true) {
                let username = this
                    .username
                    .as_deref()
                    .ok_or_else(|| invalid("RocketMQ Dashboard 已启用登录，请填写账号和密码"))?;
                let url = this.url(&["login", "login.do"])?;
                let body = reqwest::Url::parse_with_params(
                    "http://local",
                    [
                        ("username", username),
                        ("password", this.password.as_deref().unwrap_or("")),
                    ],
                )
                .unwrap()
                .query()
                .unwrap()
                .to_owned();
                let response = this
                    .client
                    .post(url)
                    .header("Content-Type", "application/x-www-form-urlencoded")
                    .body(body);
                let response = if let Some((header, token)) = &*this.csrf.read().await {
                    response.header(header, token)
                } else {
                    response
                };
                let response = if let Some(cookie) = &*this.cookie.read().await {
                    response.header(reqwest::header::COOKIE, cookie)
                } else {
                    response
                };
                let response = response.send().await.map_err(http_error)?;
                let cookies = response
                    .headers()
                    .get_all(reqwest::header::SET_COOKIE)
                    .iter()
                    .filter_map(|s| s.to_str().ok())
                    .filter_map(|s| s.split(';').next())
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
                    .join("; ");
                read_json(response, true).await?;
                if cookies.is_empty() {
                    return Err(invalid(
                        "Dashboard 登录未返回会话 Cookie，请检查版本与认证配置",
                    ));
                }
                this.merge_cookies(&cookies).await;
                this.load_csrf().await?;
            }
        }
        Ok(this)
    }
    async fn merge_cookies(&self, new: &str) {
        let mut guard = self.cookie.write().await;
        let mut cookies = std::collections::BTreeMap::new();
        for item in guard
            .as_deref()
            .unwrap_or("")
            .split("; ")
            .chain(new.split("; "))
        {
            if let Some((name, value)) = item.split_once('=') {
                cookies.insert(name.to_owned(), value.to_owned());
            }
        }
        *guard = Some(
            cookies
                .into_iter()
                .map(|(k, v)| format!("{k}={v}"))
                .collect::<Vec<_>>()
                .join("; "),
        );
    }
    async fn load_csrf(&self) -> AppResult<()> {
        // Dashboard 2.x Docker 安全补丁提供此端点；旧版没有端点时保持原协议，不能关闭服务器 CSRF。
        for path in [
            &["rocketmq-dashboard", "csrf-token"][..],
            &["csrf-token"][..],
        ] {
            let mut request = self.client.get(self.url(path)?);
            if let Some(cookie) = &*self.cookie.read().await {
                request = request.header(reqwest::header::COOKIE, cookie);
            }
            let response = request.send().await.map_err(http_error)?;
            if matches!(response.status().as_u16(), 404 | 405) {
                continue;
            }
            let cookies = response
                .headers()
                .get_all(reqwest::header::SET_COOKIE)
                .iter()
                .filter_map(|v| v.to_str().ok())
                .filter_map(|v| v.split(';').next())
                .collect::<Vec<_>>()
                .join("; ");
            let value = read_json(response, true).await?;
            let header = value["headerName"]
                .as_str()
                .ok_or_else(|| invalid("Dashboard CSRF 响应缺少请求头名称"))?;
            let token = value["token"]
                .as_str()
                .ok_or_else(|| invalid("Dashboard CSRF 响应缺少令牌"))?;
            if !header.eq_ignore_ascii_case("X-XSRF-TOKEN")
                && !header.eq_ignore_ascii_case("X-CSRF-TOKEN")
            {
                return Err(invalid("Dashboard 返回不支持的 CSRF 请求头"));
            }
            self.merge_cookies(&cookies).await;
            *self.csrf.write().await = Some((header.into(), token.into()));
            break;
        }
        Ok(())
    }
    pub fn url(&self, segments: &[&str]) -> AppResult<Url> {
        let mut url = self.base.clone();
        {
            let mut p = url
                .path_segments_mut()
                .map_err(|_| invalid("管理接口基础路径无效"))?;
            p.pop_if_empty();
            for segment in segments {
                p.push(segment);
            }
        }
        Ok(url)
    }
    pub async fn request(
        &self,
        method: Method,
        path: &[&str],
        query: &[(&str, String)],
        body: Option<Value>,
    ) -> AppResult<Value> {
        let mut url = self.url(path)?;
        if !query.is_empty() {
            url.query_pairs_mut()
                .extend_pairs(query.iter().map(|(k, v)| (*k, v.as_str())));
        }
        let mut req = self.client.request(method, url);
        if self.engine == Engine::Rabbitmq {
            if let Some(username) = &self.username {
                req = req.basic_auth(username, self.password.as_deref());
            }
        }
        if let Some(cookie) = &*self.cookie.read().await {
            req = req.header(reqwest::header::COOKIE, cookie);
        }
        if let Some((header, token)) = &*self.csrf.read().await {
            req = req.header(header, token);
        }
        if let Some(body) = body {
            req = req.json(&body);
        }
        read_json(
            req.send().await.map_err(http_error)?,
            self.engine == Engine::Rocketmq,
        )
        .await
    }
}
fn http_error(e: reqwest::Error) -> AppError {
    AppError::Connection(format!("管理接口请求失败：{}", e.without_url()))
}
async fn read_json(mut response: reqwest::Response, envelope: bool) -> AppResult<Value> {
    let status = response.status();
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(http_error)? {
        if bytes.len() + chunk.len() > 8 * 1024 * 1024 {
            return Err(invalid("管理接口响应超过 8 MiB，请缩小范围"));
        }
        bytes.extend_from_slice(&chunk);
    }
    if !status.is_success() {
        return Err(AppError::Connection(format!(
            "管理接口 HTTP {}；操作被拒绝，请核对对象状态、权限、地址和认证",
            status.as_u16()
        )));
    }
    if bytes.is_empty() {
        return Ok(Value::Null);
    }
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| invalid("管理接口没有返回 JSON；请核对管理端口及路径前缀"))?;
    if envelope {
        if value.get("status").is_some() {
            if value["status"].as_i64() != Some(0) {
                return Err(AppError::Database(format!(
                    "Dashboard 请求失败：{}",
                    value["errMsg"]
                        .as_str()
                        .or_else(|| value["message"].as_str())
                        .unwrap_or("服务器拒绝请求")
                        .chars()
                        .take(400)
                        .collect::<String>()
                )));
            }
            return Ok(value.get("data").cloned().unwrap_or(Value::Null));
        }
    }
    Ok(value)
}
