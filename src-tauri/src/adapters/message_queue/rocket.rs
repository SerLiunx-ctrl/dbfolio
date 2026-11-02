use super::{http::Http, model::*};
use crate::error::AppResult;
use reqwest::Method;
use serde_json::{json, Value};
pub async fn cluster(h: &Http) -> AppResult<Value> {
    h.request(Method::GET, &["cluster", "list.query"], &[], None)
        .await
}
pub async fn objects(h: &Http) -> AppResult<Vec<Object>> {
    let value = h
        .request(Method::GET, &["topic", "list.query"], &[], None)
        .await?;
    let list = value
        .get("topicList")
        .or_else(|| value.get("topicNameList"))
        .and_then(Value::as_array)
        .or_else(|| value.as_array())
        .ok_or_else(|| invalid("RocketMQ Dashboard Topic 列表格式无效，需要兼容的 2.x 接口"))?;
    Ok(list
        .iter()
        .filter_map(|v| v.as_str())
        .map(|name| Object {
            name: name.into(),
            kind: "topic".into(),
            count: None,
            partitions: vec![],
            state: None,
        })
        .collect())
}
pub async fn inspect(h: &Http, name: &str) -> AppResult<Value> {
    let q = [("topic", name.into())];
    let route = h
        .request(Method::GET, &["topic", "route.query"], &q, None)
        .await?;
    let stats = h
        .request(Method::GET, &["topic", "stats.query"], &q, None)
        .await?;
    let consumers = h
        .request(
            Method::GET,
            &["topic", "queryConsumerByTopic.query"],
            &q,
            None,
        )
        .await?;
    Ok(json!({"route":route,"stats":stats,"consumers":consumers}))
}
pub async fn read(h: &Http, r: &Read) -> AppResult<Page> {
    let now = chrono::Utc::now().timestamp_millis();
    let begin = r.timestamp.unwrap_or(now - 3600000);
    let end = r.end_timestamp.unwrap_or(now);
    if begin < 0 || begin > end || end - begin > 24 * 3600000 {
        return Err(invalid(
            "消息查询时间范围最多 24 小时，开始时间不能晚于结束时间",
        ));
    }
    let values = if let Some(id) = r.message_id.as_ref().filter(|s| !s.is_empty()) {
        let v = h
            .request(
                Method::GET,
                &["message", "viewMessage.query"],
                &[("topic", r.name.clone()), ("msgId", id.clone())],
                None,
            )
            .await?;
        vec![v.get("messageView").cloned().unwrap_or(v)]
    } else if let Some(key) = r.key.as_ref().filter(|s| !s.is_empty()) {
        let v = h
            .request(
                Method::GET,
                &["message", "queryMessageByTopicAndKey.query"],
                &[("topic", r.name.clone()), ("key", key.clone())],
                None,
            )
            .await?;
        v.as_array()
            .cloned()
            .ok_or_else(|| invalid("消息 Key 查询格式无效"))?
    } else {
        let v=h.request(Method::POST,&["message","queryMessagePageByTopic.query"],&[],Some(json!({"taskId":"","pageNum":1,"pageSize":r.limit,"topic":r.name,"begin":begin,"end":end}))).await?;
        v.get("page")
            .and_then(|p| p.get("content"))
            .or_else(|| v.get("messageList"))
            .or_else(|| v.get("list"))
            .or_else(|| v.get("data"))
            .and_then(Value::as_array)
            .cloned()
            .or_else(|| v.as_array().cloned())
            .ok_or_else(|| {
                invalid(format!(
                    "Dashboard 消息分页响应格式不支持：{}",
                    v.to_string().chars().take(120).collect::<String>()
                ))
            })?
    };
    let mut messages = Vec::new();
    for v in values {
        let id = v["msgId"]
            .as_str()
            .or_else(|| v["offsetMsgId"].as_str())
            .unwrap_or("");
        let body = v["messageBody"]
            .as_str()
            .or_else(|| v["body"].as_str())
            .map(str::as_bytes);
        let mut m = Message::new(
            id.into(),
            body,
            v["keys"]
                .as_str()
                .or_else(|| v["properties"]["KEYS"].as_str())
                .map(str::as_bytes),
            json!({"properties":v["properties"],"brokerName":v["brokerName"],"storeHost":v["storeHost"],"tags":v.get("tags").filter(|v|!v.is_null()).unwrap_or(&v["properties"]["TAGS"])}),
        );
        m.timestamp = v["bornTimestamp"]
            .as_i64()
            .and_then(chrono::DateTime::from_timestamp_millis)
            .map(|t| t.to_rfc3339());
        m.partition = v["queueId"].as_i64().map(|v| v as i32);
        m.offset = v["queueOffset"].as_i64().map(|v| v.to_string());
        messages.push(m);
    }
    let (messages, limited) = bound(messages, r.limit);
    Ok(Page{messages,next_offset:None,earliest_offset:None,latest_offset:None,limited,notice:"Dashboard 管理查询，不调用业务消费者直接消费或重置位点；时间范围内最多显示所选条数，并非完整消息扫描。二进制展示取决于 Dashboard 返回形式。".into()})
}
pub async fn mutate(h: &Http, m: &Mutation) -> AppResult<Value> {
    match m.action.as_str() {
        "create" => {
            let cluster = cluster(h).await?;
            let names = cluster
                .get("clusterInfo")
                .and_then(|v| v.get("clusterAddrTable"))
                .or_else(|| cluster.get("clusterAddrTable"))
                .and_then(Value::as_object)
                .map(|v| v.keys().cloned().collect::<Vec<_>>())
                .filter(|v| !v.is_empty())
                .ok_or_else(|| {
                    invalid("未发现 Broker 集群，请检查 NameServer 与 Dashboard 配置")
                })?;
            let selected = m
                .cluster_name
                .as_ref()
                .or_else(|| names.first())
                .ok_or_else(|| invalid("请选择集群"))?;
            if !names.contains(selected) {
                return Err(invalid("选择的集群已不存在，请刷新目录"));
            }
            let n = m.partitions.unwrap_or(4);
            if !(1..=64).contains(&n) {
                return Err(invalid("读写队列数范围为 1～64"));
            }
            h.request(Method::POST,&["topic","createOrUpdate.do"],&[],Some(json!({"clusterNameList":[selected],"brokerNameList":[],"topicName":m.name,"writeQueueNums":n,"readQueueNums":n,"perm":6,"order":false,"messageType":"NORMAL"}))).await
        }
        "delete" => {
            h.request(
                Method::POST,
                &["topic", "deleteTopic.do"],
                &[("topic", m.name.clone())],
                None,
            )
            .await
        }
        "publish" => {
            if m.encoding.as_deref().unwrap_or("text") != "text" {
                return Err(invalid("RocketMQ Dashboard 测试发送仅支持 UTF-8 文本"));
            }
            let body = m
                .body
                .as_deref()
                .ok_or_else(|| invalid("RocketMQ 消息不支持 NULL"))?;
            decode(body, Some("text"))?;
            let result=h.request(Method::POST,&["topic","sendTopicMessage.do"],&[],Some(json!({"topic":m.name,"key":m.key,"tag":m.tag,"messageBody":body,"traceEnabled":false}))).await?;
            if result["sendStatus"].as_str() != Some("SEND_OK") {
                return Err(crate::error::AppError::WriteUncertain(
                    "Broker 未返回 SEND_OK，消息可能已写入，请先核对消息 ID 再决定是否重发".into(),
                ));
            }
            Ok(result)
        }
        _ => Err(invalid("RocketMQ 不支持此操作")),
    }
}
