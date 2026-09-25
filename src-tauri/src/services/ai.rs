//! OpenAI 兼容服务。密钥只在后端读取；元数据/提示词仅在显式操作时发送。
use crate::{
    error::{AppError, AppResult},
    state::AppState,
    tasks,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{sync::LazyLock, time::Duration};

mod stream;
pub const CONTENT_LIMIT: usize = 2 * 1024 * 1024;
const STREAM_WIRE_LIMIT: usize = 32 * 1024 * 1024;
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponseSnapshot {
    pub text: String,
    pub diagnostic: String,
    pub format: String,
    pub status: u16,
    pub received_bytes: usize,
    pub content_bytes: usize,
    pub truncated: bool,
}

const KEY: &str = "ai_providers_v1";
static CONFIG_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static REQUESTS: LazyLock<tokio::sync::Semaphore> =
    LazyLock::new(|| tokio::sync::Semaphore::new(2));
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Provider {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub model: String,
    #[serde(default = "token_parameter")]
    pub token_parameter: String,
    pub output_format: String,
    pub timeout_seconds: u64,
    pub max_tokens: u32,
    #[serde(default)]
    pub is_default: bool,
    #[serde(default)]
    pub has_key: bool,
}
fn token_parameter() -> String {
    "max_tokens".into()
}
fn invalid(message: &str) -> AppError {
    AppError::InvalidInput(message.into())
}
pub fn validate(p: &Provider) -> AppResult<()> {
    uuid::Uuid::parse_str(&p.id).map_err(|_| invalid("AI 服务 ID 无效"))?;
    if p.name.trim().is_empty() || p.name.len() > 120 || p.model.len() > 200 {
        return Err(invalid("服务名称或模型 ID 无效"));
    }
    let url = reqwest::Url::parse(&p.base_url).map_err(|_| invalid("请输入完整的 API Base URL"))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid(
            "API 地址仅支持 HTTP/HTTPS，不得包含账号、密码、查询参数或片段",
        ));
    }
    if p.base_url.len() > 2000
        || p.base_url
            .trim_end_matches('/')
            .ends_with("/chat/completions")
        || p.base_url.trim_end_matches('/').ends_with("/models")
    {
        return Err(invalid(
            "请填写基础地址（通常以 /v1 结尾），不要包含 /models 或 /chat/completions",
        ));
    }
    if !matches!(
        p.token_parameter.as_str(),
        "max_tokens" | "max_completion_tokens"
    ) || !matches!(p.output_format.as_str(), "schema" | "json" | "text")
        || !(5..=300).contains(&p.timeout_seconds)
        || !(128..=32768).contains(&p.max_tokens)
    {
        return Err(invalid("输出格式、超时或输出上限无效"));
    }
    Ok(())
}
fn secret(id: &str) -> AppResult<keyring::Entry> {
    Ok(keyring::Entry::new("data-workbench-ai", id)?)
}
fn read_key(id: &str) -> AppResult<Option<String>> {
    match secret(id)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}
fn write_key(id: &str, value: Option<&str>) -> AppResult<()> {
    let entry = secret(id)?;
    if let Some(v) = value.filter(|v| !v.is_empty()) {
        entry.set_password(v)?;
    } else {
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}
pub async fn providers(state: &AppState) -> AppResult<Vec<Provider>> {
    let mut values: Vec<Provider> = match state.local.get_setting(KEY).await? {
        Some(v) => serde_json::from_str(&v)?,
        None => vec![],
    };
    for p in &mut values {
        p.has_key = read_key(&p.id)?.is_some();
    }
    Ok(values)
}
pub async fn save(
    state: &AppState,
    mut p: Provider,
    key: Option<String>,
) -> AppResult<Vec<Provider>> {
    validate(&p)?;
    let _lock = CONFIG_LOCK.lock().await;
    let mut values = providers(state).await?;
    if !values.iter().any(|v| v.id == p.id) && values.len() >= 20 {
        return Err(invalid("最多配置 20 个 AI 服务"));
    }
    let old = read_key(&p.id)?;
    if let Some(k) = &key {
        if k.len() > 8192 || k.contains(['\n', '\r']) {
            return Err(invalid("API Key 格式无效"));
        }
        write_key(&p.id, Some(k))?;
    }
    if values.is_empty() {
        p.is_default = true;
    }
    if p.is_default {
        for v in &mut values {
            v.is_default = false;
        }
    }
    p.has_key = false;
    let id = p.id.clone();
    values.retain(|v| v.id != id);
    values.push(p);
    if !values.iter().any(|v| v.is_default) {
        values[0].is_default = true;
    }
    if let Err(e) = state
        .local
        .set_setting(KEY, &serde_json::to_string(&values)?)
        .await
    {
        if key.is_some() {
            let _ = write_key(&id, old.as_deref());
        }
        return Err(e);
    }
    providers(state).await
}
pub async fn remove(state: &AppState, id: &str) -> AppResult<Vec<Provider>> {
    let _lock = CONFIG_LOCK.lock().await;
    let mut values = providers(state).await?;
    values.retain(|p| p.id != id);
    if !values.iter().any(|p| p.is_default) {
        if let Some(p) = values.first_mut() {
            p.is_default = true;
        }
    }
    state
        .local
        .set_setting(KEY, &serde_json::to_string(&values)?)
        .await?;
    write_key(id, None)?;
    Ok(values)
}
pub async fn selected(state: &AppState, id: &str, model: Option<&str>) -> AppResult<Provider> {
    let mut p = providers(state)
        .await?
        .into_iter()
        .find(|p| p.id == id)
        .ok_or_else(|| invalid("请先在设置中配置 AI 服务"))?;
    if let Some(model) = model.filter(|s| !s.trim().is_empty()) {
        p.model = model.into();
    }
    if p.model.trim().is_empty() {
        return Err(invalid("请先选择生成模型"));
    }
    validate(&p)?;
    Ok(p)
}
pub async fn cancellable<T>(work: impl std::future::Future<Output = AppResult<T>>) -> AppResult<T> {
    tokio::pin!(work);
    loop {
        tokio::select! {r=&mut work=>return r,_=tokio::time::sleep(Duration::from_millis(100))=>tasks::checkpoint()?}
    }
}
async fn request_with_key(
    p: &Provider,
    key: Option<&str>,
    path: &str,
    body: Option<Value>,
) -> AppResult<Value> {
    transport(p, key, path, body, None, None).await
}
async fn transport(
    p: &Provider,
    key: Option<&str>,
    path: &str,
    body: Option<Value>,
    mut output: Option<&mut (dyn FnMut(&str) + Send)>,
    capture: Option<&mut (dyn FnMut(ResponseSnapshot) + Send)>,
) -> AppResult<Value> {
    validate(p)?;
    let _permit = cancellable(async {
        REQUESTS
            .acquire()
            .await
            .map_err(|_| invalid("AI 请求队列已关闭"))
    })
    .await?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(p.timeout_seconds))
        .build()
        .map_err(|_| invalid("无法初始化 AI HTTP 客户端"))?;
    let url = format!("{}/{}", p.base_url.trim_end_matches('/'), path);
    let mut r = if let Some(body) = body {
        client.post(url).json(&body)
    } else {
        client.get(url)
    };
    if let Some(key) = key.filter(|s| !s.is_empty()) {
        r = r.bearer_auth(key);
    }
    let mut decoder = stream::Decoder::default();
    let mut received = 0usize;
    let mut bytes = Vec::new();
    let mut streamed = false;
    let mut code = 0u16;
    let mut limited = false;
    let result = cancellable(async {
        let mut response = r.send().await.map_err(|e| {
            invalid(if e.is_timeout() {
                "AI 请求超时；可缩短内容或增加超时"
            } else {
                "AI 服务连接失败；请检查地址、证书及网络"
            })
        })?;
        code = response.status().as_u16();
        let success = response.status().is_success();
        streamed = success
            && output.is_some()
            && response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .is_some_and(|v| v.to_ascii_lowercase().starts_with("text/event-stream"));
        let limit = if streamed {
            STREAM_WIRE_LIMIT
        } else {
            CONTENT_LIMIT
        };
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| invalid("AI 响应读取中断；可查看已接收内容"))?
        {
            let remaining = limit.saturating_sub(received);
            received += chunk.len();
            let accepted = &chunk[..remaining.min(chunk.len())];
            if streamed {
                decoder.push(accepted, output.as_deref_mut().unwrap())?;
            } else {
                bytes.extend_from_slice(accepted);
            }
            if received > limit {
                limited = true;
                return Err(invalid(if streamed {
                    "AI 流式传输超过 32 MiB（含协议开销），已停止接收；可查看已收到的响应"
                } else {
                    "AI HTTP 响应超过 2 MiB，已停止接收；可查看已收到的响应"
                }));
            }
            if streamed && decoder.is_done() {
                break;
            }
        }
        if !success {
            return Err(AppError::Message(format!(
                "AI 服务返回 HTTP {}：{}",
                code,
                match code {
                    401 | 403 => "请检查密钥与模型权限",
                    404 => "请检查基础地址、模型及接口路径",
                    429 => "请求限流或额度不足，请稍后重试",
                    400 | 422 => "请求参数或输出格式不受支持，可调整格式或关闭流式",
                    _ => "服务异常；本次不会自动重试",
                }
            )));
        }
        if streamed {
            return decoder.finish(output.as_deref_mut().unwrap());
        }
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|_| invalid("服务未返回合法 JSON；可查看 AI 响应检查内容"))?;
        if let (Some(out), Some(content)) = (
            output.as_deref_mut(),
            value["choices"][0]["message"]["content"].as_str(),
        ) {
            out(content);
        }
        Ok(value)
    })
    .await;
    if let Some(capture) = capture {
        let value = serde_json::from_slice::<Value>(&bytes).ok();
        let content = value
            .as_ref()
            .and_then(|v| v["choices"][0]["message"]["content"].as_str());
        let text = if streamed {
            decoder.content().to_owned()
        } else {
            content
                .map(str::to_owned)
                .unwrap_or_else(|| String::from_utf8_lossy(&bytes).into_owned())
        };
        let content_bytes = text.len();
        let redact = |value: String| {
            if let Some(key) = key.filter(|s| !s.is_empty()) {
                value.replace(key, "[已隐藏密钥]")
            } else {
                value
            }
        };
        capture(ResponseSnapshot {
            text: redact(text),
            diagnostic: redact(decoder.diagnostic.clone()),
            format: if streamed || content.is_some() {
                "AI 正文"
            } else {
                "HTTP 响应正文"
            }
            .into(),
            status: code,
            received_bytes: received,
            content_bytes,
            truncated: limited || decoder.truncated,
        });
    }
    result
}

async fn request(
    p: &Provider,
    key: Option<String>,
    path: &str,
    body: Option<Value>,
) -> AppResult<Value> {
    let stored = if key.is_none() {
        read_key(&p.id)?
    } else {
        None
    };
    request_with_key(p, key.as_deref().or(stored.as_deref()), path, body).await
}
pub async fn models(p: &Provider, key: Option<String>) -> AppResult<Vec<String>> {
    let value = request(p, key, "models", None).await?;
    let data = value
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("模型列表缺少 data 数组；可手动填写模型 ID"))?;
    let mut ids: Vec<String> = data
        .iter()
        .filter_map(|v| v["id"].as_str())
        .filter(|id| id.len() <= 200)
        .take(5000)
        .map(str::to_owned)
        .collect();
    ids.sort();
    ids.dedup();
    Ok(ids)
}
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub requests: u32,
}
impl Usage {
    pub fn add(&mut self, other: &Usage) {
        self.requests += other.requests;
        self.input_tokens = match (self.input_tokens, other.input_tokens) {
            (Some(a), Some(b)) => Some(a + b),
            (None, Some(b)) if self.requests == 1 => Some(b),
            _ => None,
        };
        self.output_tokens = match (self.output_tokens, other.output_tokens) {
            (Some(a), Some(b)) => Some(a + b),
            (None, Some(b)) if self.requests == 1 => Some(b),
            _ => None,
        };
    }
}
#[derive(Serialize)]
pub struct AiResult {
    pub value: Value,
    pub usage: Usage,
}
pub fn parse_completion(value: &Value) -> AppResult<AiResult> {
    let choice = &value["choices"][0];
    if choice["finish_reason"]
        .as_str()
        .is_some_and(|s| s != "stop")
    {
        return Err(invalid(
            "AI 输出被截断或拒绝，未采用结果；请减少内容或增加输出上限",
        ));
    }
    if !choice["message"]["refusal"].is_null() {
        return Err(invalid("模型拒绝了本次请求"));
    }
    let content = choice["message"]["content"]
        .as_str()
        .ok_or_else(|| invalid("AI 响应缺少文本内容"))?
        .trim();
    let content = content
        .strip_prefix("```json")
        .or_else(|| content.strip_prefix("```"))
        .map(|s| s.trim().trim_end_matches("```").trim())
        .unwrap_or(content);
    let result = serde_json::from_str(content)
        .map_err(|_| invalid("模型输出不是有效 JSON，结果未采用；请调整要求后重试"))?;
    Ok(AiResult {
        value: result,
        usage: Usage {
            input_tokens: value["usage"]["prompt_tokens"].as_u64(),
            output_tokens: value["usage"]["completion_tokens"].as_u64(),
            requests: 1,
        },
    })
}
pub async fn completion(
    p: &Provider,
    key: Option<String>,
    system: &str,
    prompt: &str,
    schema: Option<Value>,
) -> AppResult<AiResult> {
    let body = completion_body(p, system, prompt, schema)?;
    let value = request(p, key, "chat/completions", Some(body)).await?;
    parse_completion(&value)
}
#[cfg(test)]
pub async fn completion_streaming(
    p: &Provider,
    system: &str,
    prompt: &str,
    output: &mut (dyn FnMut(&str) + Send),
) -> AppResult<AiResult> {
    completion_captured(p, system, prompt, true, output, &mut |_| {}).await
}
pub async fn completion_captured(
    p: &Provider,
    system: &str,
    prompt: &str,
    stream: bool,
    output: &mut (dyn FnMut(&str) + Send),
    capture: &mut (dyn FnMut(ResponseSnapshot) + Send),
) -> AppResult<AiResult> {
    let mut body = completion_body(p, system, prompt, None)?;
    body["stream"] = json!(stream);
    if stream {
        body["stream_options"] = json!({"include_usage":true});
    }
    let key = read_key(&p.id)?;
    let value = transport(
        p,
        key.as_deref(),
        "chat/completions",
        Some(body),
        Some(output),
        Some(capture),
    )
    .await?;
    parse_completion(&value)
}
fn completion_body(
    p: &Provider,
    system: &str,
    prompt: &str,
    schema: Option<Value>,
) -> AppResult<Value> {
    if prompt.len() > 128 * 1024 {
        return Err(invalid("AI 输入超过 128 KiB，请减少字段或提示词"));
    }
    let mut body = json!({"model":p.model,"messages":[{"role":"system","content":system},{"role":"user","content":prompt}],"stream":false});
    body[&p.token_parameter] = json!(p.max_tokens);
    match p.output_format.as_str() {
        "schema" => {
            body["response_format"] = if let Some(schema) = schema {
                json!({"type":"json_schema","json_schema":{"name":"data_generation","strict":true,"schema":schema}})
            } else {
                json!({"type":"json_object"})
            };
        }
        "json" => body["response_format"] = json!({"type":"json_object"}),
        _ => {}
    }
    Ok(body)
}
pub async fn test(p: &Provider, key: Option<String>) -> AppResult<AiResult> {
    let result=completion(p,key,"Return only JSON.","Return {\"ok\":true}.",Some(json!({"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"],"additionalProperties":false}))).await?;
    if result.value["ok"] != true {
        return Err(invalid("模型可连接，但未返回约定的测试结果"));
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn provider() -> Provider {
        Provider {
            id: uuid::Uuid::new_v4().to_string(),
            name: "测试".into(),
            base_url: "http://127.0.0.1:1/v1".into(),
            model: "test".into(),
            token_parameter: "max_tokens".into(),
            output_format: "json".into(),
            timeout_seconds: 5,
            max_tokens: 512,
            is_default: true,
            has_key: false,
        }
    }
    #[test]
    fn urls_and_completion_validation() {
        let mut p = provider();
        assert!(validate(&p).is_ok());
        p.base_url = "https://key:secret@example.com/v1".into();
        assert!(validate(&p).is_err());
        p.base_url = "file:///tmp".into();
        assert!(validate(&p).is_err());
        let v = json!({"choices":[{"finish_reason":"stop","message":{"content":"{\"ok\":true}"}}],"usage":{"prompt_tokens":12,"completion_tokens":8}});
        assert_eq!(parse_completion(&v).unwrap().usage.input_tokens, Some(12));
        let mut bad = v;
        bad["choices"][0]["finish_reason"] = json!("length");
        assert!(parse_completion(&bad).is_err());
    }
}
#[cfg(test)]
pub(crate) mod http_tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    #[tokio::test]
    async fn stream_wire_overhead_is_separate_from_retained_content() {
        let overhead = ": heartbeat protocol padding padding padding\n\n".repeat(50000);
        assert!(overhead.len() > CONTENT_LIMIT);
        let (url, server) = mock_stream(vec![
            overhead + &chunk("{\"ok\":true}", Some("stop")) + "data: [DONE]\n\n",
        ])
        .await;
        let mut saved = None;
        let result = completion_captured(
            &p(url),
            "JSON only",
            "Return JSON",
            true,
            &mut |_| {},
            &mut |s| saved = Some(s),
        )
        .await
        .unwrap();
        assert_eq!(result.value["ok"], true);
        let saved = saved.unwrap();
        assert!(saved.received_bytes > CONTENT_LIMIT);
        assert_eq!(saved.text, "{\"ok\":true}");
        assert!(!saved.truncated);
        server.await.unwrap();
    }
    #[tokio::test]
    async fn failed_responses_are_retained_and_keys_redacted() {
        let (url, server) = mock(
            400,
            json!({"error":{"message":"detail with fake-secret-token"}}),
            0,
        )
        .await;
        let mut saved = None;
        let result = transport(
            &p(url),
            Some("fake-secret-token"),
            "chat/completions",
            Some(json!({})),
            None,
            Some(&mut |s| saved = Some(s)),
        )
        .await;
        assert!(result.is_err());
        let saved = saved.unwrap();
        assert_eq!(saved.status, 400);
        assert!(saved.text.contains("detail with"));
        assert!(!saved.text.contains("fake-secret-token"));
        server.await.unwrap();
        let (url,server)=mock(200,json!({"choices":[{"finish_reason":"stop","message":{"content":"不是 JSON，仍须保留"}}]}),0).await;
        let mut saved = None;
        assert!(completion_captured(
            &p(url),
            "JSON only",
            "Return JSON",
            false,
            &mut |_| {},
            &mut |s| saved = Some(s)
        )
        .await
        .is_err());
        assert_eq!(saved.unwrap().text, "不是 JSON，仍须保留");
        server.await.unwrap();
        let (url, server) = mock(200, json!({"oversized":"x".repeat(CONTENT_LIMIT+100)}), 0).await;
        let mut saved = None;
        assert!(completion_captured(
            &p(url),
            "JSON only",
            "Return JSON",
            false,
            &mut |_| {},
            &mut |s| saved = Some(s)
        )
        .await
        .is_err());
        let saved = saved.unwrap();
        assert!(saved.truncated);
        assert_eq!(saved.text.len(), CONTENT_LIMIT);
        server.await.unwrap();
    }
    pub(crate) async fn mock_stream(
        parts: Vec<String>,
    ) -> (String, tokio::task::JoinHandle<String>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut buf = [0; 4096];
            loop {
                let n = socket.read(&mut buf).await.unwrap();
                if n == 0 {
                    break;
                }
                request.extend_from_slice(&buf[..n]);
                if let Some(end) = request.windows(4).position(|v| v == b"\r\n\r\n") {
                    let len = String::from_utf8_lossy(&request[..end])
                        .lines()
                        .find_map(|s| {
                            s.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .and_then(|n| n.trim().parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    if request.len() >= end + 4 + len {
                        break;
                    }
                }
            }
            let length: usize = parts.iter().map(|s| s.len()).sum();
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {length}\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
            for part in parts {
                if socket.write_all(part.as_bytes()).await.is_err() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(180)).await;
            }
            String::from_utf8(request).unwrap()
        });
        (format!("http://{addr}/v1"), task)
    }
    pub(crate) fn chunk(content: &str, finish: Option<&str>) -> String {
        format!(
            "data: {}\n\n",
            json!({"choices":[{"index":0,"delta":{"content":content},"finish_reason":finish}]})
        )
    }
    #[tokio::test]
    async fn streaming_arrives_before_completion_and_can_cancel() {
        let(url,server)=mock_stream(vec![chunk("{\"ok\":",None),chunk("true}",Some("stop")),"data: {\"choices\":[],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":4}}\n\ndata: [DONE]\n\n".into()]).await;
        let mut provider = p(url);
        provider.id = uuid::Uuid::new_v4().to_string();
        let (send, mut receive) = tokio::sync::mpsc::unbounded_channel();
        let mut output = |text: &str| {
            send.send(text.to_string()).unwrap();
        };
        let request = completion_streaming(&provider, "JSON only", "Return JSON", &mut output);
        tokio::pin!(request);
        tokio::select! {r=&mut request=>panic!("请求在首段预览前完成：{}",r.is_ok()),first=receive.recv()=>assert_eq!(first.unwrap(),"{\"ok\":")}
        let result = request.await.unwrap();
        assert_eq!(result.value["ok"], true);
        assert_eq!(result.usage.output_tokens, Some(4));
        let request = server.await.unwrap();
        let body: Value = serde_json::from_str(request.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(body["stream"], true);
        assert_eq!(body["stream_options"]["include_usage"], true);
        let (url, server) =
            mock_stream(vec![chunk("{", None), chunk("\"ok\":true}", Some("stop"))]).await;
        let provider = p(url);
        let registry = tasks::TaskRegistry::default();
        registry.begin("stream".into()).unwrap();
        let mut received = String::new();
        let mut output = |s: &str| {
            received.push_str(s);
            registry.cancel("stream").unwrap();
        };
        let result = registry
            .scope(
                Some("stream".into()),
                completion_streaming(&provider, "JSON only", "Return JSON", &mut output),
            )
            .await;
        assert!(matches!(result, Err(AppError::Cancelled(_))));
        assert_eq!(received, "{");
        server.abort();
    }
    pub(crate) async fn mock(
        status: u16,
        body: Value,
        delay: u64,
    ) -> (String, tokio::task::JoinHandle<String>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut data = vec![];
            let mut buf = [0; 4096];
            loop {
                let n = socket.read(&mut buf).await.unwrap();
                if n == 0 {
                    break;
                }
                data.extend_from_slice(&buf[..n]);
                if let Some(end) = data.windows(4).position(|v| v == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&data[..end]);
                    let len = headers
                        .lines()
                        .find_map(|s| {
                            s.to_lowercase()
                                .strip_prefix("content-length:")
                                .and_then(|v| v.trim().parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    if data.len() >= end + 4 + len {
                        break;
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(delay)).await;
            let body = body.to_string();
            let output=format!("HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());
            let _ = socket.write_all(output.as_bytes()).await;
            String::from_utf8(data).unwrap()
        });
        (format!("http://{addr}/v1"), task)
    }
    fn p(url: String) -> Provider {
        Provider {
            id: uuid::Uuid::new_v4().to_string(),
            name: "模拟 AI".into(),
            base_url: url,
            model: "test-model".into(),
            output_format: "json".into(),
            token_parameter: "max_tokens".into(),
            timeout_seconds: 5,
            max_tokens: 128,
            is_default: false,
            has_key: false,
        }
    }
    #[tokio::test]
    async fn model_listing_and_completion_protocol() {
        let (url, server) = mock(200, json!({"data":[{"id":"b"},{"id":"a"},{"id":"a"}]}), 0).await;
        let ids = models(&p(url), Some("fake-test-key".into())).await.unwrap();
        assert_eq!(ids, vec!["a", "b"]);
        let request = server.await.unwrap().to_lowercase();
        assert!(request.starts_with("get /v1/models"));
        assert!(request.contains("authorization: bearer fake-test-key"));
        let(url,server)=mock(200,json!({"choices":[{"finish_reason":"stop","message":{"content":"{\"ok\":true}"}}],"usage":{"prompt_tokens":10,"completion_tokens":5}}),0).await;
        let result = test(&p(url), Some("".into())).await.unwrap();
        assert_eq!(result.usage.output_tokens, Some(5));
        let request = server.await.unwrap();
        let value: Value = serde_json::from_str(request.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(value["model"], "test-model");
        assert_eq!(value["max_tokens"], 128);
        assert!(value.get("max_completion_tokens").is_none());
        assert_eq!(value["response_format"]["type"], "json_object");
        assert!(!request.to_lowercase().contains("authorization:"));
    }
    #[tokio::test]
    async fn http_error_redaction_and_cancellation() {
        let (url, server) = mock(
            401,
            json!({"error":{"message":"sensitive-server-details"}}),
            0,
        )
        .await;
        let error = models(&p(url), Some("fake-test-key".into()))
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("401"));
        assert!(!error.contains("sensitive-server-details"));
        assert!(!error.contains("fake-test-key"));
        server.await.unwrap();
        let (url, server) = mock(200, json!({"data":[]}), 1000).await;
        let registry = crate::tasks::TaskRegistry::default();
        registry.begin("request".into()).unwrap();
        let provider = p(url);
        let request = registry.scope(Some("request".into()), models(&provider, Some("".into())));
        let cancel = async {
            tokio::time::sleep(Duration::from_millis(50)).await;
            registry.cancel("request").unwrap();
        };
        let (result, _) = tokio::join!(request, cancel);
        assert!(matches!(result, Err(AppError::Cancelled(_))));
        server.abort();
    }
}
