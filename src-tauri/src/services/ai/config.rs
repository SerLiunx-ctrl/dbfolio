//! AI 模型配置、兼容默认值与参数边界。
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
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
    pub reasoning_effort: Option<String>,
    #[serde(default)]
    pub temperature: Option<f64>,
    #[serde(default)]
    pub top_p: Option<f64>,
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
        || !(128..=128000).contains(&p.max_tokens)
    {
        return Err(invalid("输出格式、超时或输出上限无效"));
    }
    if p.reasoning_effort.as_deref().is_some_and(|v| {
        !matches!(
            v,
            "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
        )
    }) || p
        .temperature
        .is_some_and(|v| !v.is_finite() || !(0.0..=2.0).contains(&v))
        || p.top_p
            .is_some_and(|v| !v.is_finite() || !(0.0..=1.0).contains(&v))
    {
        return Err(invalid("思考等级、温度或 Top P 无效"));
    }
    Ok(())
}
impl Provider {
    pub fn apply_options(&self, body: &mut Value) {
        body[&self.token_parameter] = json!(self.max_tokens);
        if let Some(effort) = &self.reasoning_effort {
            body["reasoning_effort"] = json!(effort);
        }
        if let Some(temperature) = self.temperature {
            body["temperature"] = json!(temperature);
        }
        if let Some(top_p) = self.top_p {
            body["top_p"] = json!(top_p);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn legacy() -> Provider {
        serde_json::from_value(json!({"id":uuid::Uuid::new_v4().to_string(),"name":"旧配置","baseUrl":"http://127.0.0.1:1234/v1","model":"legacy","outputFormat":"json","timeoutSeconds":60,"maxTokens":4096})).unwrap()
    }
    #[test]
    fn legacy_config_omits_new_options() {
        let p = legacy();
        assert!(validate(&p).is_ok());
        let mut body = json!({});
        p.apply_options(&mut body);
        assert_eq!(body, json!({"max_tokens":4096}));
        let restored: Provider = serde_json::from_value(serde_json::to_value(p).unwrap()).unwrap();
        assert!(restored.reasoning_effort.is_none());
        assert!(restored.temperature.is_none());
        assert!(restored.top_p.is_none());
    }
    #[test]
    fn request_options_and_boundaries() {
        let mut p = legacy();
        p.max_tokens = 128000;
        p.token_parameter = "max_completion_tokens".into();
        for effort in ["none", "minimal", "low", "medium", "high", "xhigh", "max"] {
            p.reasoning_effort = Some(effort.into());
            p.temperature = Some(0.0);
            p.top_p = Some(1.0);
            assert!(validate(&p).is_ok());
            let mut body = json!({});
            p.apply_options(&mut body);
            assert_eq!(
                body,
                json!({"max_completion_tokens":128000,"reasoning_effort":effort,"temperature":0.0,"top_p":1.0})
            );
        }
        p.max_tokens = 128001;
        assert!(validate(&p).is_err());
        p.max_tokens = 127;
        assert!(validate(&p).is_err());
        p.max_tokens = 128;
        p.reasoning_effort = Some("invalid".into());
        assert!(validate(&p).is_err());
        p.reasoning_effort = None;
        for value in [-0.1, 2.1, f64::NAN, f64::INFINITY] {
            p.temperature = Some(value);
            assert!(validate(&p).is_err());
        }
        p.temperature = None;
        for value in [-0.1, 1.1, f64::NAN] {
            p.top_p = Some(value);
            assert!(validate(&p).is_err());
        }
        p.top_p = None;
        assert!(validate(&p).is_ok());
    }
}
