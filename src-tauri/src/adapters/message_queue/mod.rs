mod http;
mod kafka;
pub mod model;
mod rabbit;
mod rocket;
use crate::{
    adapters::{ConnectionParams, DbAdapter, QueryContext, QueryOutcome, SqlParams},
    error::{AppError, AppResult},
    meta::{value::DbValue, DatabaseMeta, Engine, InfoEntry, TableMeta, TableRef},
};
use async_trait::async_trait;
use model::*;
use serde_json::Value;
use std::time::Duration;
enum Client {
    Kafka(rskafka::client::Client),
    Http(http::Http),
}
pub struct MessageQueueAdapter {
    client: Client,
    engine: Engine,
    timeout: u64,
}
impl MessageQueueAdapter {
    pub async fn connect(p: &ConnectionParams) -> AppResult<Self> {
        let timeout = p.network.query_timeout();
        let client = if p.engine == Engine::Kafka {
            Client::Kafka(
                tokio::time::timeout(
                    Duration::from_secs(p.network.connect_timeout()),
                    kafka::connect(p),
                )
                .await
                .map_err(|_| invalid("Kafka 连接超时，请检查广播地址和认证"))??,
            )
        } else {
            Client::Http(http::Http::connect(p).await?)
        };
        Ok(Self {
            client,
            engine: p.engine,
            timeout,
        })
    }
    pub async fn catalog(&self, scope: Option<&str>) -> AppResult<Catalog> {
        let scopes = match &self.client {
            Client::Kafka(_) => vec!["cluster".into()],
            Client::Http(h) if self.engine == Engine::Rabbitmq => rabbit::scopes(h).await?,
            _ => vec!["cluster".into()],
        };
        let scope = scope
            .filter(|v| !v.is_empty())
            .map(str::to_owned)
            .or_else(|| scopes.first().cloned())
            .ok_or_else(|| invalid("当前账号没有可访问的命名空间"))?;
        if !scopes.contains(&scope) {
            return Err(invalid("命名空间不存在或当前账号无权访问"));
        }
        let mut objects = match &self.client {
            Client::Kafka(c) => kafka::objects(c).await?,
            Client::Http(h) if self.engine == Engine::Rabbitmq => {
                rabbit::objects(h, &scope).await?
            }
            Client::Http(h) => rocket::objects(h).await?,
        };
        objects.sort_by(|a, b| a.kind.cmp(&b.kind).then(a.name.cmp(&b.name)));
        let limited = objects.len() > 5000;
        objects.truncate(5000);
        let clusters = if let Client::Http(h) = &self.client {
            if self.engine == Engine::Rocketmq {
                let v = rocket::cluster(h).await?;
                v.get("clusterInfo")
                    .and_then(|v| v.get("clusterAddrTable"))
                    .or_else(|| v.get("clusterAddrTable"))
                    .and_then(Value::as_object)
                    .map(|v| v.keys().cloned().collect())
                    .unwrap_or_default()
            } else {
                vec![]
            }
        } else {
            vec![]
        };
        Ok(Catalog {
            engine: self.engine,
            scopes,
            scope,
            objects,
            limited,
            clusters,
            capabilities: Capabilities {
                read: true,
                read_changes_state: self.engine == Engine::Rabbitmq,
                publish: true,
                create: true,
                delete: true,
                purge: self.engine == Engine::Rabbitmq,
                bindings: self.engine == Engine::Rabbitmq,
                consumers: self.engine != Engine::Kafka,
            },
        })
    }
    pub async fn inspect(&self, scope: &str, name: &str, kind: &str) -> AppResult<String> {
        model::name(name)?;
        self.validate_scope(scope).await?;
        let value = match &self.client {
            Client::Kafka(c) => kafka::inspect(c, name).await?,
            Client::Http(h) if self.engine == Engine::Rabbitmq => {
                rabbit::inspect(h, scope, name, kind).await?
            }
            Client::Http(h) => rocket::inspect(h, name).await?,
        };
        Ok(value.to_string())
    }
    async fn validate_scope(&self, scope: &str) -> AppResult<()> {
        if self.engine == Engine::Rabbitmq {
            if let Client::Http(h) = &self.client {
                if !rabbit::scopes(h).await?.iter().any(|s| s == scope) {
                    return Err(invalid("VHost 不存在或无权访问"));
                }
            }
        } else if scope != "cluster" {
            return Err(invalid("消息引擎命名空间无效"));
        }
        Ok(())
    }
    pub async fn read(&self, r: &Read) -> AppResult<Page> {
        name(&r.name)?;
        self.validate_scope(&r.scope).await?;
        if !(1..=200).contains(&r.limit) {
            return Err(invalid("一次读取数量范围为 1～200"));
        }
        match &self.client {
            Client::Kafka(c) => kafka::read(c, r).await,
            Client::Http(h) if self.engine == Engine::Rabbitmq => rabbit::read(h, r).await,
            Client::Http(h) => rocket::read(h, r).await,
        }
    }
    pub async fn mutate(&self, m: &Mutation) -> AppResult<Value> {
        name(&m.name)?;
        self.validate_scope(&m.scope).await?;
        if !["create", "delete", "purge", "bind", "publish"].contains(&m.action.as_str()) {
            return Err(invalid("不支持的消息系统操作"));
        }
        if m.properties_json
            .as_ref()
            .is_some_and(|s| s.len() > 64 * 1024)
        {
            return Err(invalid("属性最大 64 KiB"));
        }
        match &self.client {
            Client::Kafka(c) => kafka::mutate(c, m).await,
            Client::Http(h) if self.engine == Engine::Rabbitmq => rabbit::mutate(h, m).await,
            Client::Http(h) => rocket::mutate(h, m).await,
        }
    }
    pub fn timeout(&self) -> Duration {
        Duration::from_secs(self.timeout.min(120))
    }
}
fn unsupported() -> AppError {
    invalid("消息队列使用消息工作区，不支持 SQL、表结构或数据库同步操作")
}
#[async_trait]
impl DbAdapter for MessageQueueAdapter {
    fn message_queue(&self) -> Option<&MessageQueueAdapter> {
        Some(self)
    }
    fn engine(&self) -> Engine {
        self.engine
    }
    fn quote_ident(&self, name: &str) -> String {
        name.into()
    }
    fn placeholder(&self, _: usize) -> String {
        "?".into()
    }
    fn null_safe_eq(&self, _: &str, _: &str) -> String {
        "".into()
    }
    async fn ping(&self) -> AppResult<()> {
        match &self.client {
            Client::Kafka(c) => {
                c.list_topics().await.map_err(kafka::error)?;
            }
            Client::Http(h) if self.engine == Engine::Rabbitmq => {
                h.request(reqwest::Method::GET, &["api", "overview"], &[], None)
                    .await?;
            }
            Client::Http(h) => {
                rocket::cluster(h).await?;
            }
        }
        Ok(())
    }
    async fn server_version(&self) -> AppResult<String> {
        Ok(match &self.client {
            Client::Kafka(_) => "Kafka · 原生协议".into(),
            Client::Http(h) if self.engine == Engine::Rabbitmq => h
                .request(reqwest::Method::GET, &["api", "overview"], &[], None)
                .await?["rabbitmq_version"]
                .as_str()
                .unwrap_or("RabbitMQ")
                .into(),
            _ => "RocketMQ · Dashboard 2.x".into(),
        })
    }
    async fn list_databases(&self) -> AppResult<Vec<DatabaseMeta>> {
        let names = if let Client::Http(h) = &self.client {
            if self.engine == Engine::Rabbitmq {
                rabbit::scopes(h).await?
            } else {
                vec!["cluster".into()]
            }
        } else {
            vec!["cluster".into()]
        };
        Ok(names
            .into_iter()
            .map(|name| DatabaseMeta {
                name,
                charset: None,
                collation: None,
                comment: None,
            })
            .collect())
    }
    async fn list_tables(&self, _: &str) -> AppResult<Vec<TableRef>> {
        Err(unsupported())
    }
    async fn introspect_table(&self, _: &str, _: Option<&str>, _: &str) -> AppResult<TableMeta> {
        Err(unsupported())
    }
    async fn server_info(&self) -> AppResult<Vec<InfoEntry>> {
        Ok(vec![InfoEntry {
            section: "消息系统".into(),
            key: "连接类型".into(),
            value: self.server_version().await?,
        }])
    }
    async fn database_info(&self, database: &str) -> AppResult<Vec<InfoEntry>> {
        self.validate_scope(database).await?;
        self.server_info().await
    }
    async fn query_page(
        &self,
        _: &str,
        _: &str,
        _: u64,
        _: u32,
        _: &QueryContext,
    ) -> AppResult<QueryOutcome> {
        Err(unsupported())
    }
    async fn execute_affected(&self, _: &str, _: &str) -> AppResult<QueryOutcome> {
        Err(unsupported())
    }
    async fn execute_statements(&self, _: &str, _: &[String]) -> AppResult<()> {
        Err(unsupported())
    }
    async fn execute_transaction(&self, _: &str, _: &[SqlParams]) -> AppResult<u64> {
        Err(unsupported())
    }
    async fn cancel(&self, _: u64) -> AppResult<()> {
        Ok(())
    }
    async fn fetch_full_value(&self, _: &str, _: &str) -> AppResult<Option<DbValue>> {
        Err(unsupported())
    }
}
