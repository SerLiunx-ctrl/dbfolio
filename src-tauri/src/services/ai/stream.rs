//! Incremental SSE decoding. Network chunks may split lines or UTF-8 characters.
use super::{invalid, json, AppResult, Value};

#[derive(Default)]
pub(super) struct Decoder {
    pending: Vec<u8>,
    data: Vec<String>,
    data_bytes: usize,
    content: String,
    finish: Option<String>,
    usage: Value,
    done: bool,
    pub truncated: bool,
    pub diagnostic: String,
}
impl Decoder {
    pub fn content(&self) -> &str {
        &self.content
    }
    pub fn is_done(&self) -> bool {
        self.done
    }
    pub fn push(&mut self, bytes: &[u8], output: &mut (dyn FnMut(&str) + Send)) -> AppResult<()> {
        self.pending.extend_from_slice(bytes);
        while let Some(end) = self.pending.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = self.pending.drain(..=end).collect();
            let line = std::str::from_utf8(&line)
                .map_err(|_| invalid("AI 流式响应包含无效 UTF-8"))?
                .trim_end_matches(['\r', '\n']);
            if line.is_empty() {
                self.event(output)?;
            } else if let Some(value) = line.strip_prefix("data:") {
                self.data_bytes += value.len();
                if self.data_bytes > super::CONTENT_LIMIT {
                    self.truncated = true;
                    self.diagnostic = value.chars().take(32768).collect();
                    return Err(invalid(
                        "AI 单个流事件超过 2 MiB，已停止接收；可查看已收到的 AI 响应",
                    ));
                }
                self.data
                    .push(value.strip_prefix(' ').unwrap_or(value).into());
            }
        }
        if self.pending.len() > super::CONTENT_LIMIT {
            self.truncated = true;
            self.diagnostic = String::from_utf8_lossy(&self.pending[..32768]).into_owned();
            return Err(invalid(
                "AI 单行流事件超过 2 MiB，已停止接收；可查看已收到的 AI 响应",
            ));
        }
        Ok(())
    }
    fn event(&mut self, output: &mut (dyn FnMut(&str) + Send)) -> AppResult<()> {
        if self.data.is_empty() {
            return Ok(());
        }
        let text = std::mem::take(&mut self.data).join("\n");
        self.data_bytes = 0;
        if self.done {
            return Err(invalid("AI 流结束后仍收到内容，结果未采用"));
        }
        if text == "[DONE]" {
            self.done = true;
            return Ok(());
        }
        let event: Value = serde_json::from_str(&text).map_err(|_| {
            self.diagnostic = text.chars().take(32768).collect();
            invalid("AI 流式事件不是合法 JSON，结果未采用")
        })?;
        if event.get("error").is_some() {
            self.diagnostic = text.chars().take(32768).collect();
            return Err(invalid(
                "AI 服务在生成途中返回错误，已保留收到的内容；请检查模型、额度或服务日志",
            ));
        }
        if !event["usage"].is_null() {
            self.usage = event["usage"].clone();
        }
        for choice in event["choices"].as_array().into_iter().flatten() {
            if choice["index"].as_u64().unwrap_or(0) != 0 {
                continue;
            }
            if !choice["delta"]["refusal"].is_null() {
                self.diagnostic = choice["delta"]["refusal"]
                    .to_string()
                    .chars()
                    .take(32768)
                    .collect();
                return Err(invalid("模型拒绝了本次请求"));
            }
            if let Some(delta) = choice["delta"]["content"]
                .as_str()
                .filter(|s| !s.is_empty())
            {
                if self.finish.is_some() {
                    return Err(invalid("AI 结束标记后仍返回内容，结果未采用"));
                }
                let mut length = (super::CONTENT_LIMIT - self.content.len()).min(delta.len());
                while !delta.is_char_boundary(length) {
                    length -= 1;
                }
                self.content.push_str(&delta[..length]);
                output(&delta[..length]);
                if length < delta.len() {
                    self.truncated = true;
                    return Err(invalid("AI 正文超过 2 MiB（不含流式协议开销），已停止接收；请查看已收到的响应，并缩短单条内容或减少模型输出上限"));
                }
            }
            if let Some(reason) = choice["finish_reason"].as_str() {
                self.finish = Some(reason.into());
            }
        }
        Ok(())
    }
    pub fn finish(&mut self, output: &mut (dyn FnMut(&str) + Send)) -> AppResult<Value> {
        // Accept a final event without a trailing blank line, but never accept an unfinished completion.
        self.push(b"\n\n", output)?;
        let reason = self
            .finish
            .as_ref()
            .ok_or_else(|| invalid("AI 流式连接提前结束，未收到完成标记；已保留内容但不会写入"))?;
        Ok(
            json!({"choices":[{"finish_reason":reason,"message":{"content":self.content}}],"usage":self.usage}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn content_limit_retains_received_prefix() {
        let frame = format!(
            "data: {}\n\n",
            json!({"choices":[{"delta":{"content":"a".repeat(1024)},"finish_reason":null}]})
        );
        let mut decoder = Decoder::default();
        let mut shown = 0;
        for _ in 0..super::super::CONTENT_LIMIT / 1024 {
            decoder
                .push(frame.as_bytes(), &mut |s| shown += s.len())
                .unwrap();
        }
        let error = decoder
            .push(frame.as_bytes(), &mut |s| shown += s.len())
            .err()
            .unwrap()
            .to_string();
        assert!(error.contains("AI 正文超过"));
        assert!(decoder.truncated);
        assert_eq!(shown, super::super::CONTENT_LIMIT);
        assert_eq!(decoder.content().len(), shown);
    }
    #[test]
    fn split_utf8_crlf_usage_and_completion() {
        let source = concat!(": keepalive\r\n\r\n", "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"{\\\"名称\\\":\\\"中文\\\"}\"},\"finish_reason\":null}]}\r\n\r\n", "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n", "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":6}}\n\n", "data: [DONE]\n\n");
        let mut d = Decoder::default();
        let mut output = String::new();
        for b in source.as_bytes() {
            d.push(&[*b], &mut |s| output.push_str(s)).unwrap();
        }
        let result = super::super::parse_completion(&d.finish(&mut |_| {}).unwrap()).unwrap();
        assert_eq!(result.value["名称"], "中文");
        assert_eq!(output, "{\"名称\":\"中文\"}");
        assert_eq!(result.usage.output_tokens, Some(6));
    }
    #[test]
    fn incomplete_malformed_and_truncated_streams_fail() {
        let mut d = Decoder::default();
        d.push(
            b"data: {\"choices\":[{\"delta\":{\"content\":\"{}\"}}]}\n\n",
            &mut |_| {},
        )
        .unwrap();
        assert!(d.finish(&mut |_| {}).is_err());
        assert!(Decoder::default()
            .push(b"data: invalid\n\n", &mut |_| {})
            .is_err());
        let mut d = Decoder::default();
        d.push(b"data: {\"choices\":[{\"delta\":{\"content\":\"{}\"},\"finish_reason\":\"length\"}]}\n\n", &mut |_|{}).unwrap();
        assert!(super::super::parse_completion(&d.finish(&mut |_| {}).unwrap()).is_err());
    }
}
