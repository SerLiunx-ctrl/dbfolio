use super::model::*;
use crate::{
    adapters::ConnectionParams,
    error::{AppError, AppResult},
};
use chrono::{DateTime, Utc};
use rskafka::{
    client::{
        partition::{Compression, OffsetAt, UnknownTopicHandling},
        Client, ClientBuilder, Credentials, SaslConfig,
    },
    record::Record,
};
use serde_json::{json, Value};
use std::collections::BTreeMap;
pub fn error(e: impl std::fmt::Display) -> AppError {
    AppError::Database(format!("Kafka：{e}"))
}
pub async fn connect(p: &ConnectionParams) -> AppResult<Client> {
    let host = p.host.as_deref().unwrap_or("");
    if host.contains(['/', '@', '?', '#', ',']) {
        return Err(invalid(
            "Kafka 主机请填写单个 bootstrap 主机；后续按服务器广播地址发现 Broker",
        ));
    }
    let addr = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]:{}", p.port.unwrap_or(9092))
    } else {
        format!("{host}:{}", p.port.unwrap_or(9092))
    };
    let mut builder = ClientBuilder::new(vec![addr])
        .client_id("DBFolio-preview")
        .max_message_size(8 * 1024 * 1024)
        .backoff_config(rskafka::BackoffConfig {
            deadline: Some(std::time::Duration::ZERO),
            ..Default::default()
        });
    if p.tls == Some(true) {
        builder = builder.tls_config(crate::services::transport::tls_config(&p.network)?);
    }
    let mode = p.network.sasl_mechanism.as_deref().unwrap_or("none");
    if mode != "none" {
        let user = p
            .username
            .clone()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| invalid("SASL 需要用户名和密码"))?;
        let password = p
            .password
            .clone()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| invalid("SASL 需要用户名和密码"))?;
        let c = Credentials::new(user, password);
        builder = builder.sasl_config(match mode {
            "plain" => SaslConfig::Plain(c),
            "scram256" => SaslConfig::ScramSha256(c),
            "scram512" => SaslConfig::ScramSha512(c),
            _ => return Err(invalid("不支持的 Kafka SASL 机制")),
        });
    }
    builder.build().await.map_err(error)
}
fn topic(name: &str) -> AppResult<()> {
    super::model::name(name)?;
    if name.len() > 249
        || name == "."
        || name == ".."
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    {
        return Err(invalid(
            "Kafka Topic 只支持字母、数字、点、下划线和短横线，最长 249 字节",
        ));
    }
    Ok(())
}
pub async fn objects(c: &Client) -> AppResult<Vec<Object>> {
    Ok(c.list_topics()
        .await
        .map_err(error)?
        .into_iter()
        .map(|t| Object {
            name: t.name,
            kind: "topic".into(),
            count: None,
            partitions: t.partitions.into_iter().collect(),
            state: None,
        })
        .collect())
}
pub async fn inspect(c: &Client, name: &str) -> AppResult<Value> {
    topic(name)?;
    let topics = c.list_topics().await.map_err(error)?;
    let t = topics
        .into_iter()
        .find(|t| t.name == name)
        .ok_or_else(|| invalid("Topic 不存在"))?;
    let mut partitions = Vec::new();
    for id in t.partitions.into_iter().take(256) {
        crate::tasks::checkpoint()?;
        let p = c
            .partition_client(name, id, UnknownTopicHandling::Error)
            .await
            .map_err(error)?;
        let earliest = p.get_offset(OffsetAt::Earliest).await.map_err(error)?;
        let latest = p.get_offset(OffsetAt::Latest).await.map_err(error)?;
        partitions.push(json!({"partition":id,"earliestOffset":earliest.to_string(),"latestOffset":latest.to_string(),"offsetSpan":(latest-earliest).to_string()}));
    }
    Ok(
        json!({"partitions":partitions,"notice":"Offset 范围不是消费者积压。预览不加入业务消费组，不提交位点；首版暂不提供消费组管理。分区最多展示 256 个。"}),
    )
}
pub async fn read(c: &Client, r: &Read) -> AppResult<Page> {
    topic(&r.name)?;
    if r.partition < 0 {
        return Err(invalid("分区不能小于 0"));
    }
    let p = c
        .partition_client(&r.name, r.partition, UnknownTopicHandling::Error)
        .await
        .map_err(error)?;
    let earliest = p.get_offset(OffsetAt::Earliest).await.map_err(error)?;
    let latest = p.get_offset(OffsetAt::Latest).await.map_err(error)?;
    let offset = if let Some(time) = r.timestamp {
        let t =
            DateTime::<Utc>::from_timestamp_millis(time).ok_or_else(|| invalid("时间戳无效"))?;
        let found = p.get_offset(OffsetAt::Timestamp(t)).await.map_err(error)?;
        if found < 0 {
            latest
        } else {
            found
        }
    } else {
        match r.offset.as_deref().unwrap_or("latest") {
            "earliest" => earliest,
            "latest" => (latest - r.limit as i64).max(earliest),
            v => v
                .parse::<i64>()
                .map_err(|_| invalid("Offset 需为十进制整数、earliest 或 latest"))?,
        }
    };
    if offset < 0 || offset < earliest || offset > latest {
        return Err(invalid(format!(
            "Offset 已超出保留范围 {earliest}～{latest}，请重新定位"
        )));
    }
    if offset == latest {
        return Ok(Page {
            messages: vec![],
            next_offset: Some(offset.to_string()),
            earliest_offset: Some(earliest.to_string()),
            latest_offset: Some(latest.to_string()),
            limited: false,
            notice: "当前位置暂无消息；未加入业务消费组或提交位点".into(),
        });
    }
    let (records, high) = p
        .fetch_records(offset, 1..(2 * 1024 * 1024), 1000)
        .await
        .map_err(error)?;
    let messages = records
        .into_iter()
        .map(|r| {
            let mut m = Message::new(
                r.offset.to_string(),
                r.record.value.as_deref(),
                r.record.key.as_deref(),
                json!(r
                    .record
                    .headers
                    .iter()
                    .map(|(k, v)| (
                        k.clone(),
                        base64::Engine::encode(&base64::engine::general_purpose::STANDARD, v)
                    ))
                    .collect::<BTreeMap<_, _>>()),
            );
            m.id = format!("{}:{}", r.offset, r.record.timestamp.timestamp_millis());
            m.partition = Some(p.partition());
            m.offset = Some(r.offset.to_string());
            m.timestamp = Some(r.record.timestamp.to_rfc3339());
            m
        })
        .collect();
    let (messages, limited) = bound(messages, r.limit);
    let next = messages
        .last()
        .and_then(|m| m.offset.as_ref())
        .and_then(|v| v.parse::<i64>().ok())
        .map(|v| (v + 1).to_string())
        .or_else(|| Some(offset.to_string()));
    Ok(Page{messages,next_offset:next,earliest_offset:Some(earliest.to_string()),latest_offset:Some(high.to_string()),limited,notice:"按分区位点预览；未加入业务消费组、未提交位点。压缩/保留策略可能形成位点空洞。Headers 以 Base64 展示，同名重复项保留最后一项。".into()})
}
pub async fn mutate(c: &Client, m: &Mutation) -> AppResult<Value> {
    topic(&m.name)?;
    match m.action.as_str() {
        "create" => {
            let n = m.partitions.unwrap_or(1);
            let replicas = m.replicas.unwrap_or(1);
            if !(1..=256).contains(&n) || !(1..=16).contains(&replicas) {
                return Err(invalid("分区范围 1～256，副本范围 1～16"));
            }
            c.controller_client()
                .map_err(error)?
                .create_topic(&m.name, n, replicas, 10000)
                .await
                .map_err(error)?;
            Ok(json!({"created":true}))
        }
        "delete" => {
            c.controller_client()
                .map_err(error)?
                .delete_topic(&m.name, 10000)
                .await
                .map_err(error)?;
            Ok(json!({"deleted":true}))
        }
        "publish" => {
            let value = m
                .body
                .as_deref()
                .map(|v| decode(v, m.encoding.as_deref()))
                .transpose()?;
            let key = m
                .key
                .as_deref()
                .map(|v| decode(v, m.key_encoding.as_deref()))
                .transpose()?;
            let headers = if let Some(s) = &m.properties_json {
                let h: BTreeMap<String, String> = serde_json::from_str(s)
                    .map_err(|_| invalid("Headers 需为字符串键值 JSON 对象"))?;
                if h.len() > 100 || s.len() > 16384 {
                    return Err(invalid("Headers 最多 100 项、16 KiB"));
                }
                h.into_iter().map(|(k, v)| (k, v.into_bytes())).collect()
            } else {
                BTreeMap::new()
            };
            let partition = m.partition.unwrap_or(0);
            if partition < 0 {
                return Err(invalid("分区无效"));
            }
            let p = c
                .partition_client(&m.name, partition, UnknownTopicHandling::Error)
                .await
                .map_err(error)?;
            let offsets = p
                .produce(
                    vec![Record {
                        key,
                        value,
                        headers,
                        timestamp: Utc::now(),
                    }],
                    Compression::NoCompression,
                )
                .await
                .map_err(error)?;
            Ok(
                json!({"partition":partition,"offsets":offsets.iter().map(ToString::to_string).collect::<Vec<_>>() }),
            )
        }
        _ => Err(invalid("Kafka 不支持此操作")),
    }
}
