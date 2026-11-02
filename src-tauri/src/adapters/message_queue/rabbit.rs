use super::{http::Http, model::*};
use crate::error::AppResult;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use reqwest::Method;
use serde_json::{json, Value};
pub async fn scopes(h: &Http) -> AppResult<Vec<String>> {
    let v = h
        .request(Method::GET, &["api", "vhosts"], &[], None)
        .await?;
    Ok(v.as_array()
        .ok_or_else(|| invalid("RabbitMQ vhosts 响应格式无效"))?
        .iter()
        .filter_map(|x| x["name"].as_str().map(str::to_owned))
        .collect())
}
pub async fn objects(h: &Http, scope: &str) -> AppResult<Vec<Object>> {
    let mut out = Vec::new();
    for (path, kind) in [("queues", "queue"), ("exchanges", "exchange")] {
        let v = h
            .request(
                Method::GET,
                &["api", path, scope],
                &[
                    ("disable_stats", "true".into()),
                    ("enable_queue_totals", "true".into()),
                    ("columns", "name,messages,state,type".into()),
                ],
                None,
            )
            .await?;
        for v in v
            .as_array()
            .ok_or_else(|| invalid("RabbitMQ 对象列表格式无效"))?
        {
            out.push(Object {
                name: if kind == "exchange" && v["name"].as_str() == Some("") {
                    "amq.default".into()
                } else {
                    v["name"].as_str().unwrap_or("").into()
                },
                kind: kind.into(),
                count: v
                    .get("messages")
                    .filter(|v| v.is_number())
                    .map(Value::to_string),
                partitions: vec![],
                state: v
                    .get("state")
                    .or_else(|| v.get("type"))
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            });
        }
    }
    Ok(out)
}
pub async fn inspect(h: &Http, scope: &str, name: &str, kind: &str) -> AppResult<Value> {
    let path = if kind == "exchange" {
        "exchanges"
    } else {
        "queues"
    };
    let info = h
        .request(Method::GET, &["api", path, scope, name], &[], None)
        .await?;
    let bindings = h
        .request(
            Method::GET,
            if kind == "exchange" {
                vec!["api", path, scope, name, "bindings", "source"]
            } else {
                vec!["api", path, scope, name, "bindings"]
            }
            .as_slice(),
            &[],
            None,
        )
        .await?;
    let consumers = h
        .request(Method::GET, &["api", "consumers", scope], &[], None)
        .await?;
    let consumers = consumers
        .as_array()
        .map(|v| {
            v.iter()
                .filter(|v| kind != "queue" || v["queue"]["name"].as_str() == Some(name))
                .cloned()
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(json!({"object":info,"bindings":bindings,"consumers":consumers}))
}
pub async fn read(h: &Http, r: &Read) -> AppResult<Page> {
    if r.kind != "queue" {
        return Err(invalid("RabbitMQ 仅从队列诊断取样；交换机没有存储消息"));
    }
    let values=h.request(Method::POST,&["api","queues",&r.scope,&r.name,"get"],&[],Some(json!({"count":r.limit,"ackmode":"ack_requeue_true","encoding":"base64","truncate":MAX_BODY}))).await?;
    let mut messages = Vec::new();
    for (i, v) in values
        .as_array()
        .ok_or_else(|| invalid("RabbitMQ 消息响应格式无效"))?
        .iter()
        .enumerate()
    {
        let data = STANDARD
            .decode(v["payload"].as_str().unwrap_or(""))
            .map_err(|_| invalid("RabbitMQ 返回无效 Base64"))?;
        let mut m = Message::new(
            format!("sample-{}-{i}", chrono::Utc::now().timestamp_millis()),
            Some(&data),
            None,
            json!({"properties":v["properties"],"exchange":v["exchange"],"routingKey":v["routing_key"],"redelivered":v["redelivered"]}),
        );
        m.bytes = v["payload_bytes"]
            .as_u64()
            .map(|v| v as usize)
            .unwrap_or(data.len());
        m.truncated = m.bytes > data.len();
        m.timestamp = v["properties"]["timestamp"]
            .as_i64()
            .and_then(|t| chrono::DateTime::from_timestamp(t, 0))
            .map(|t| t.to_rfc3339());
        messages.push(m);
    }
    let (messages, limited) = bound(messages, r.limit);
    Ok(Page{messages,next_offset:None,earliest_offset:None,latest_offset:None,limited,notice:"消息已取出并重新入队；数量通常保持，但队列顺序及 redelivered 标记可能变化。这不是无副作用的只读查看，不进行自动轮询。".into()})
}
pub async fn mutate(h: &Http, m: &Mutation) -> AppResult<Value> {
    match m.action.as_str() {
        "publish" => {
            let data = decode(m.body.as_deref().unwrap_or(""), m.encoding.as_deref())?;
            let properties = match &m.properties_json {
                Some(s) => serde_json::from_str::<Value>(s)
                    .map_err(|_| invalid("Properties 需为 JSON 对象"))?,
                None => json!({}),
            };
            if !properties.is_object() {
                return Err(invalid("Properties 需为 JSON 对象"));
            }
            let exchange = if m.kind == "queue" {
                "amq.default"
            } else {
                &m.name
            };
            let routing = if m.kind == "queue" {
                m.name.clone()
            } else {
                m.routing_key.clone().unwrap_or_default()
            };
            let v=h.request(Method::POST,&["api","exchanges",&m.scope,exchange,"publish"],&[],Some(json!({"properties":properties,"routing_key":routing,"payload":STANDARD.encode(data),"payload_encoding":"base64"}))).await?;
            if v["routed"].as_bool() != Some(true) {
                return Err(invalid(
                    "消息未路由至队列；请检查交换机、Routing Key 与绑定，未按成功发送处理",
                ));
            }
            Ok(v)
        }
        "create" => {
            let path = if m.kind == "exchange" {
                "exchanges"
            } else if m.kind == "queue" {
                "queues"
            } else {
                return Err(invalid("RabbitMQ 对象类型需为 queue 或 exchange"));
            };
            let mut body = json!({"durable":m.durable.unwrap_or(true),"auto_delete":false,"arguments":match &m.properties_json{Some(s)=>serde_json::from_str::<Value>(s).map_err(|_|invalid("对象参数需为 JSON 对象"))?,None=>json!({})}});
            if !body["arguments"].is_object() {
                return Err(invalid("对象参数需为 JSON 对象"));
            }
            if m.kind == "exchange" {
                let t = m.exchange_type.as_deref().unwrap_or("direct");
                if !["direct", "fanout", "topic", "headers"].contains(&t) {
                    return Err(invalid("交换机类型无效"));
                }
                body["type"] = json!(t);
                body["internal"] = json!(false);
            }
            h.request(
                Method::PUT,
                &["api", path, &m.scope, &m.name],
                &[],
                Some(body),
            )
            .await
        }
        "delete" => {
            let path = if m.kind == "queue" {
                "queues"
            } else if m.kind == "exchange" {
                "exchanges"
            } else {
                return Err(invalid("RabbitMQ 对象类型无效"));
            };
            h.request(
                Method::DELETE,
                &["api", path, &m.scope, &m.name],
                &[("if-unused", "true".into()), ("if-empty", "true".into())],
                None,
            )
            .await
        }
        "purge" => {
            h.request(
                Method::DELETE,
                &["api", "queues", &m.scope, &m.name, "contents"],
                &[],
                None,
            )
            .await
        }
        "bind" => {
            let exchange = m
                .exchange
                .as_deref()
                .ok_or_else(|| invalid("请选择交换机"))?;
            h.request(
                Method::POST,
                &["api", "bindings", &m.scope, "e", exchange, "q", &m.name],
                &[],
                Some(json!({"routing_key":m.routing_key.as_deref().unwrap_or(""),"arguments":{}})),
            )
            .await
        }
        _ => Err(invalid("RabbitMQ 不支持此操作")),
    }
}
