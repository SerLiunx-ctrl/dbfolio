use super::{ConnectionParams, DbAdapter, QueryContext, QueryOutcome, SqlParams};
use crate::{
    error::{AppError, AppResult},
    meta::value::DbValue,
    meta::{DatabaseMeta, Engine, InfoEntry, TableMeta, TableRef},
};
use async_trait::async_trait;
use futures_util::TryStreamExt;
use mongodb::{
    bson::{self, doc, Bson, Document},
    options::{ClientOptions, Collation, Credential, Tls, TlsOptions},
    Client, Cursor,
};
use serde::{Deserialize, Serialize};
use std::future::IntoFuture;
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;
mod tools;
pub use tools::TransferRequest;

pub fn validate_address(address: &str) -> AppResult<()> {
    if address.is_empty() {
        return Err(AppError::InvalidInput("MongoDB 地址不能为空".into()));
    }
    if address.contains('@') {
        return Err(AppError::InvalidInput(
            "请从 URI 中移除账号密码，填入下方账号/密码字段；凭据会保存到 Windows 凭据管理器"
                .into(),
        ));
    }
    if address.contains("://")
        && !address.starts_with("mongodb://")
        && !address.starts_with("mongodb+srv://")
    {
        return Err(AppError::InvalidInput(
            "仅支持 mongodb:// 或 mongodb+srv://".into(),
        ));
    }
    if let Some(query) = address.split_once('?').map(|(_, q)| q) {
        for pair in query.split('&') {
            let key = pair.split('=').next().unwrap_or("").to_ascii_lowercase();
            if key.contains('%')
                || key.contains("password")
                || key.contains("token")
                || key.contains("secret")
                || key == "authmechanismproperties"
            {
                return Err(AppError::InvalidInput(
                    "URI 中不能保存密码或令牌选项，请使用独立凭据字段".into(),
                ));
            }
        }
    }
    Ok(())
}
fn mongo_error(e: mongodb::error::Error) -> AppError {
    // 连接信息和用户文档可能出现在驱动原始错误里；不直接回显完整错误。
    use mongodb::error::ErrorKind;
    let message=match e.kind.as_ref() {
        ErrorKind::Authentication{..}=>"MongoDB 认证失败，请检查账号、密码和认证库",
        ErrorKind::ServerSelection{..}|ErrorKind::Io(_)=>"MongoDB 网络或服务器选择失败，请检查地址、TLS 和网络",
        ErrorKind::Command(c) if c.code==13=>"MongoDB 权限不足",
        ErrorKind::Write(_)=>"MongoDB 写入失败：请检查重复 _id / 唯一索引、验证规则及写入权限；网络异常时请刷新确认结果",
        _=>"MongoDB 操作失败，请检查查询语法、权限及服务器状态；写操作请刷新确认结果后再重试",
    };
    AppError::Database(message.into())
}
fn write_error(e: mongodb::error::Error) -> AppError {
    match e.kind.as_ref() {
        mongodb::error::ErrorKind::Write(mongodb::error::WriteFailure::WriteError(_))
        | mongodb::error::ErrorKind::Command(_)
        | mongodb::error::ErrorKind::Authentication { .. } => mongo_error(e),
        _ => AppError::WriteUncertain(
            "MongoDB 写入结果待确认，请先刷新查询核对，禁止直接重复提交".into(),
        ),
    }
}
pub fn parse_document(text: &str) -> AppResult<Document> {
    if text.len() > 48 * 1024 * 1024 {
        return Err(AppError::InvalidInput("文档文本过大".into()));
    }
    let json: serde_json::Value = serde_json::from_str(text)
        .map_err(|_| AppError::InvalidInput("请输入有效的 Extended JSON 对象".into()))?;
    match Bson::try_from(json)
        .map_err(|_| AppError::InvalidInput("BSON 类型标记或数值无效".into()))?
    {
        Bson::Document(d) => Ok(d),
        _ => Err(AppError::InvalidInput("顶层必须是文档对象".into())),
    }
}
pub fn canonical(d: Document) -> String {
    Bson::Document(d).into_canonical_extjson().to_string()
}
// MongoDB stores _id first, including when the caller appends it or omits it.
fn id_first(mut d: Document) -> Document {
    let id = d
        .remove("_id")
        .unwrap_or_else(|| Bson::ObjectId(bson::oid::ObjectId::new()));
    let mut ordered = doc! { "_id": id };
    ordered.extend(d);
    ordered
}
pub fn validate_find_options(projection: &Document, sort: &Document) -> AppResult<()> {
    for value in projection.values() {
        if !matches!(
            value,
            Bson::Int32(0 | 1) | Bson::Int64(0 | 1) | Bson::Boolean(_)
        ) {
            return Err(AppError::InvalidInput(
                "Projection 首版仅支持字段 0/1（排除/包含）".into(),
            ));
        }
    }
    for value in sort.values() {
        if !matches!(value, Bson::Int32(1 | -1) | Bson::Int64(1 | -1)) {
            return Err(AppError::InvalidInput(
                "Sort 请使用 1（升序）或 -1（降序）".into(),
            ));
        }
    }
    Ok(())
}
pub fn snapshot_filter(old: Document) -> AppResult<Document> {
    let id = old
        .get("_id")
        .cloned()
        .ok_or_else(|| AppError::InvalidInput("文档缺少 _id".into()))?;
    Ok(doc! {"_id":{"$eq":id},"$expr":{"$eq":["$$ROOT",{"$literal":old}]}})
}
fn unsupported<T>() -> AppResult<T> {
    Err(AppError::InvalidInput(
        "MongoDB 请使用文档工作区，此 SQL 操作不适用".into(),
    ))
}
fn reject_scripts(value: &Bson) -> AppResult<()> {
    match value {
        Bson::Document(d) => {
            for (k, v) in d {
                if matches!(k.as_str(), "$where" | "$function" | "$accumulator") {
                    return Err(AppError::InvalidInput(
                        "此工作区不执行服务端 JavaScript".into(),
                    ));
                }
                reject_scripts(v)?;
            }
        }
        Bson::Array(a) => {
            for v in a {
                reject_scripts(v)?;
            }
        }
        _ => {}
    };
    Ok(())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindRequest {
    pub database: String,
    pub collection: String,
    pub filter: String,
    pub projection: String,
    pub sort: String,
    pub limit: u32,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoRow {
    pub id: Option<String>,
    pub json: String,
    pub truncated: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoPage {
    pub rows: Vec<MongoRow>,
    pub cursor: Option<String>,
}
#[async_trait]
pub trait DocumentAdapter: Send + Sync {
    fn query_timeout_secs(&self)->u64 {60}
    async fn inspect(
        &self,
        database: &str,
        collection: &str,
        operation: &str,
        text: &str,
    ) -> AppResult<serde_json::Value>;
    async fn create_index(
        &self,
        database: &str,
        collection: &str,
        text: &str,
    ) -> AppResult<serde_json::Value>;
    async fn transfer(&self, request: TransferRequest) -> AppResult<serde_json::Value>;
    async fn close(&self);
    async fn release(&self, id: &str);
    async fn collections(&self, database: &str) -> AppResult<Vec<String>>;
    async fn find(&self, r: FindRequest) -> AppResult<MongoPage>;
    async fn next(&self, id: &str) -> AppResult<MongoPage>;
    async fn document(&self, database: &str, collection: &str, id: &str) -> AppResult<String>;
    async fn write(
        &self,
        database: &str,
        collection: &str,
        operation: &str,
        original: Option<&str>,
        text: &str,
    ) -> AppResult<String>;
}
struct Scan {
    cursor: Cursor<Document>,
    pending: Option<Document>,
    touched: Instant,
}
struct ScanCleanup {
    scans: Arc<Mutex<HashMap<String, Scan>>>,
    id: String,
    armed: bool,
}
impl Drop for ScanCleanup {
    fn drop(&mut self) {
        if self.armed {
            let scans = self.scans.clone();
            let id = self.id.clone();
            tokio::spawn(async move {
                scans.lock().await.remove(&id);
            });
        }
    }
}
pub struct MongoAdapter {
    query_timeout_secs: u64,
    pub client: Client,
    default_database: Option<String>,
    scans: Arc<Mutex<HashMap<String, Scan>>>,
}
impl MongoAdapter {
    pub async fn connect(p: &ConnectionParams) -> AppResult<Self> {
        let address = p.host.as_deref().unwrap_or("");
        validate_address(address)?;
        let uri = if address.starts_with("mongodb") {
            address.to_owned()
        } else {
            format!("mongodb://{}:{}", address, p.port.unwrap_or(27017))
        };
        let mut options = ClientOptions::parse(&uri)
            .await
            .map_err(|_| AppError::InvalidInput("MongoDB URI 格式或 DNS 解析失败".into()))?;
        if let Some(user) = p.username.as_ref().filter(|u| !u.is_empty()) {
            let mut credential = options
                .credential
                .take()
                .unwrap_or_else(|| Credential::builder().build());
            credential.username = Some(user.clone());
            credential.password = p.password.clone();
            credential.source = p
                .auth_source
                .clone()
                .or(credential.source)
                .or_else(|| options.default_database.clone())
                .or(Some("admin".into()));
            options.credential = Some(credential);
        }
        if p.tls == Some(true) && !matches!(options.tls.as_ref(), Some(Tls::Enabled(_))) {
            options.tls = Some(Tls::Enabled(TlsOptions::default()));
        }
        if p.tunneled {options.direct_connection=Some(true);}
        if p.tls_terminated {options.tls=Some(Tls::Disabled);}
        else if let Some(Tls::Enabled(tls))=&mut options.tls {
            if p.tls==Some(true){tls.allow_invalid_certificates=Some(false);}
            if let Some(path)=&p.network.ca_file {tls.ca_file_path=Some(path.into());}
            if let Some(path)=&p.network.client_cert {tls.cert_key_file_path=Some(path.into());}
        }
        options.server_selection_timeout = Some(Duration::from_secs(p.network.connect_timeout()));
        options.connect_timeout = Some(Duration::from_secs(p.network.connect_timeout()));
        options.max_pool_size = Some(8);
        options.retry_writes = Some(false);
        options.app_name = Some("DBFolio".into());
        let default_database = p
            .database
            .clone()
            .filter(|s| !s.is_empty())
            .or(options.default_database.clone());
        let client = Client::with_options(options).map_err(mongo_error)?;
        client
            .database(default_database.as_deref().unwrap_or("admin"))
            .run_command(doc! {"ping":1})
            .await
            .map_err(mongo_error)?;
        let scans = Arc::new(Mutex::new(HashMap::<String, Scan>::new()));
        let weak = Arc::downgrade(&scans);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(30)).await;
                let Some(map) = weak.upgrade() else { break };
                map.lock()
                    .await
                    .retain(|_, scan| scan.touched.elapsed() < Duration::from_secs(120));
            }
        });
        Ok(Self {
            query_timeout_secs:p.network.query_timeout(),
            client,
            default_database,
            scans,
        })
    }
}
#[async_trait]
impl DocumentAdapter for MongoAdapter {
    fn query_timeout_secs(&self)->u64 {self.query_timeout_secs}
    async fn inspect(
        &self,
        database: &str,
        collection: &str,
        operation: &str,
        text: &str,
    ) -> AppResult<serde_json::Value> {
        self.inspect_collection(database, collection, operation, text)
            .await
    }
    async fn create_index(
        &self,
        database: &str,
        collection: &str,
        text: &str,
    ) -> AppResult<serde_json::Value> {
        self.add_index(database, collection, text).await
    }
    async fn transfer(&self, request: TransferRequest) -> AppResult<serde_json::Value> {
        self.transfer_file(request).await
    }
    async fn close(&self) {
        self.scans.lock().await.clear();
        self.client.clone().shutdown().immediate(true).await;
    }
    async fn release(&self, id: &str) {
        self.scans.lock().await.remove(id);
    }
    async fn collections(&self, database: &str) -> AppResult<Vec<String>> {
        self.client
            .database(database)
            .list_collection_names()
            .authorized_collections(true)
            .await
            .map_err(mongo_error)
    }
    async fn find(&self, r: FindRequest) -> AppResult<MongoPage> {
        let filter = parse_document(&r.filter)?;
        reject_scripts(&Bson::Document(filter.clone()))?;
        let projection = parse_document(&r.projection)?;
        let sort = parse_document(&r.sort)?;
        validate_find_options(&projection, &sort)?;
        let cursor = self
            .client
            .database(&r.database)
            .collection::<Document>(&r.collection)
            .find(filter)
            .projection(projection)
            .sort(sort)
            .limit(i64::from(r.limit.clamp(1, 10000)))
            .batch_size(50)
            .max_time(Duration::from_secs(20))
            .await
            .map_err(mongo_error)?;
        let id = uuid::Uuid::new_v4().to_string();
        {
            let mut scans = self.scans.lock().await;
            if scans.len() >= 16 {
                return Err(AppError::InvalidInput(
                    "浏览游标过多，请关闭其他查询或等待空闲游标释放".into(),
                ));
            }
            scans.insert(
                id.clone(),
                Scan {
                    cursor,
                    pending: None,
                    touched: Instant::now(),
                },
            );
        }
        let mut cleanup = ScanCleanup {
            scans: self.scans.clone(),
            id: id.clone(),
            armed: true,
        };
        let result = self.next(&id).await;
        if result.is_ok() {
            cleanup.armed = false;
        }
        result
    }
    async fn next(&self, id: &str) -> AppResult<MongoPage> {
        let mut scans = self.scans.lock().await;
        let scan = scans
            .get_mut(id)
            .ok_or_else(|| AppError::NotFound("查询已过期，请重新查询".into()))?;
        scan.touched = Instant::now();
        let mut rows = vec![];
        let mut bytes = 0;
        let mut done = false;
        let result: AppResult<()> = async {
            for _ in 0..50 {
                let document = if let Some(d) = scan.pending.take() {
                    Some(d)
                } else {
                    scan.cursor.try_next().await.map_err(mongo_error)?
                };
                let Some(document) = document else {
                    done = true;
                    break;
                };
                let id = document
                    .get("_id")
                    .cloned()
                    .map(|v| v.into_canonical_extjson().to_string());
                let text = canonical(document.clone());
                if !rows.is_empty() && bytes + text.len().min(128 * 1024) > 2 * 1024 * 1024 {
                    scan.pending = Some(document);
                    break;
                }
                let truncated = text.len() > 128 * 1024;
                let json = if truncated { "{}".into() } else { text };
                bytes += json.len();
                rows.push(MongoRow {
                    id,
                    json,
                    truncated,
                });
            }
            Ok(())
        }
        .await;
        if result.is_err() || done {
            scans.remove(id);
        }
        result?;
        Ok(MongoPage {
            rows,
            cursor: if done { None } else { Some(id.into()) },
        })
    }
    async fn document(&self, database: &str, collection: &str, id: &str) -> AppResult<String> {
        let value = parse_document(&format!("{{\"_id\":{id}}}"))?;
        let id_value = value
            .get("_id")
            .cloned()
            .ok_or_else(|| AppError::InvalidInput("缺少 _id".into()))?;
        let d = self
            .client
            .database(database)
            .collection::<Document>(collection)
            .find_one(doc! {"_id":{"$eq":id_value}})
            .await
            .map_err(mongo_error)?
            .ok_or_else(|| AppError::NotFound("文档已不存在".into()))?;
        Ok(canonical(d))
    }
    async fn write(
        &self,
        database: &str,
        collection: &str,
        operation: &str,
        original: Option<&str>,
        text: &str,
    ) -> AppResult<String> {
        let c = self
            .client
            .database(database)
            .collection::<Document>(collection);
        if operation == "insert" {
            let d = id_first(parse_document(text)?);
            let full = canonical(d.clone());
            c.insert_one(d).await.map_err(write_error)?;
            return Ok(full);
        }
        let old = parse_document(
            original.ok_or_else(|| AppError::InvalidInput("缺少完整原始文档".into()))?,
        )?;
        let id = old
            .get("_id")
            .cloned()
            .ok_or_else(|| AppError::InvalidInput("文档缺少 _id".into()))?;
        let condition = snapshot_filter(old)?;
        let (count, result) = match operation {
            "replace" => {
                let d = parse_document(text)?;
                if d.get("_id") != Some(&id) {
                    return Err(AppError::InvalidInput("不能修改或删除 _id".into()));
                }
                let d = id_first(d);
                let result = canonical(d.clone());
                (
                    c.replace_one(condition, d)
                        .collation(Collation::builder().locale("simple").build())
                        .await
                        .map_err(write_error)?
                        .matched_count,
                    result,
                )
            }
            "delete" => (
                c.delete_one(condition)
                    .collation(Collation::builder().locale("simple").build())
                    .await
                    .map_err(write_error)?
                    .deleted_count,
                String::new(),
            ),
            _ => return Err(AppError::InvalidInput("未知文档操作".into())),
        };
        if count == 0 {
            return Err(AppError::Message(
                "文档已被修改或删除，本次未写入。请保留草稿并重新读取原文后合并".into(),
            ));
        }
        Ok(result)
    }
}
#[async_trait]
impl DbAdapter for MongoAdapter {
    fn query_timeout_secs(&self)->u64 {self.query_timeout_secs}
    fn engine(&self) -> Engine {
        Engine::Mongodb
    }
    fn quote_ident(&self, _: &str) -> String {
        String::new()
    }
    fn placeholder(&self, _: usize) -> String {
        String::new()
    }
    fn null_safe_eq(&self, _: &str, _: &str) -> String {
        String::new()
    }
    async fn ping(&self) -> AppResult<()> {
        self.client
            .database(self.default_database.as_deref().unwrap_or("admin"))
            .run_command(doc! {"ping":1})
            .await
            .map_err(mongo_error)?;
        Ok(())
    }
    async fn server_version(&self) -> AppResult<String> {
        let d = tokio::time::timeout(
            Duration::from_secs(10),
            self.client
                .database("admin")
                .run_command(doc! {"buildInfo":1})
                .into_future(),
        )
        .await
        .map_err(|_| AppError::Message("读取版本超时".into()))?
        .map_err(mongo_error)?;
        Ok(d.get_str("version").unwrap_or("unknown").into())
    }
    async fn server_info(&self) -> AppResult<Vec<InfoEntry>> {
        Ok(vec![
            InfoEntry {
                section: "MongoDB".into(),
                key: "版本".into(),
                value: self.server_version().await.unwrap_or("无权限读取".into()),
            },
            InfoEntry {
                section: "MongoDB".into(),
                key: "连接池上限（每台服务器）".into(),
                value: "8".into(),
            },
        ])
    }
    async fn database_info(&self, _: &str) -> AppResult<Vec<InfoEntry>> {
        Ok(vec![])
    }
    async fn list_databases(&self) -> AppResult<Vec<DatabaseMeta>> {
        let mut names = match self
            .client
            .list_database_names()
            .authorized_databases(true)
            .await
        {
            Ok(n) => n,
            Err(e) => {
                if let Some(db) = &self.default_database {
                    vec![db.clone()]
                } else {
                    return Err(mongo_error(e));
                }
            }
        };
        if let Some(db) = &self.default_database {
            if !names.contains(db) {
                names.push(db.clone());
            }
        }
        names.sort();
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
        unsupported()
    }
    async fn introspect_table(&self, _: &str, _: Option<&str>, _: &str) -> AppResult<TableMeta> {
        unsupported()
    }
    async fn query_page(
        &self,
        _: &str,
        _: &str,
        _: u64,
        _: u32,
        _: &QueryContext,
    ) -> AppResult<QueryOutcome> {
        unsupported()
    }
    async fn execute_affected(&self, _: &str, _: &str) -> AppResult<QueryOutcome> {
        unsupported()
    }
    async fn execute_statements(&self, _: &str, _: &[String]) -> AppResult<()> {
        unsupported()
    }
    async fn execute_transaction(&self, _: &str, _: &[SqlParams]) -> AppResult<u64> {
        unsupported()
    }
    async fn cancel(&self, _: u64) -> AppResult<()> {
        unsupported()
    }
    async fn fetch_full_value(&self, _: &str, _: &str) -> AppResult<Option<DbValue>> {
        unsupported()
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bson_roundtrip_preserves_types() {
        let d = doc! {"_id":bson::oid::ObjectId::new(),"long":i64::MAX,"date":bson::DateTime::from_millis(1234),"null":Bson::Null,"array":[doc!{"n":1}],"decimal":bson::Decimal128::from_bytes([0;16])};
        assert_eq!(parse_document(&canonical(d.clone())).unwrap(), d);
        assert!(!d.contains_key("missing"));
        assert!(parse_document("[]").is_err());
        assert!(parse_document(r#"{"x":{"$oid":"bad"}}"#).is_err());
    }
    #[test]
    fn order_projection_and_snapshot_filter() {
        let original = doc! {"_id":1,"z":2,"a":3,"nil":Bson::Null};
        let parsed = parse_document(&canonical(original.clone())).unwrap();
        assert_eq!(
            original.keys().collect::<Vec<_>>(),
            parsed.keys().collect::<Vec<_>>()
        );
        let filter = snapshot_filter(parsed).unwrap();
        assert_eq!(
            filter.get_document("_id").unwrap().get_i32("$eq").unwrap(),
            1
        );
        assert!(filter.contains_key("$expr"));
        assert_eq!(
            filter
                .get_document("$expr")
                .unwrap()
                .get_array("$eq")
                .unwrap()[0],
            Bson::String("$$ROOT".into())
        );
        assert!(snapshot_filter(doc! {}).is_err());
        assert!(validate_find_options(&doc! {"name":1,"_id":0}, &doc! {"_id":-1}).is_ok());
        assert!(validate_find_options(&doc! {"_id":{"$literal":9}}, &doc! {}).is_err());
        assert!(reject_scripts(&Bson::Document(doc! {"$expr":{"$function":{}}})).is_err());
    }
    #[test]
    fn credentials_are_not_saved_in_host() {
        assert!(validate_address("mongodb://u:secret@localhost").is_err());
        assert!(
            validate_address("mongodb://localhost/?tlsCertificateKeyFilePassword=secret").is_err()
        );
        assert!(validate_address("mongodb+srv://cluster.example/?authSource=admin").is_ok());
    }
}
#[cfg(test)]
mod integration_tests {
    use super::*;
    #[tokio::test]
    #[ignore = "需要 DW_MONGO_TEST_URI 指向专用测试 MongoDB；仅创建并清理随机 dw_acceptance_ 数据库"]
    async fn document_crud_cursor_projection_and_conflicts() {
        let uri = std::env::var("DW_MONGO_TEST_URI").expect("设置专用测试 URI（不含账号密码）");
        let db = format!("dw_acceptance_{}", uuid::Uuid::new_v4().simple());
        let a = MongoAdapter::connect(&ConnectionParams {
            network: Default::default(), tunneled:false, tls_terminated:false,
            allowed_databases: None,
            read_only: false,
            engine: Engine::Mongodb,
            host: Some(uri),
            port: None,
            username: std::env::var("DW_MONGO_TEST_USER").ok(),
            password: std::env::var("DW_MONGO_TEST_PASSWORD").ok(),
            database: Some(db.clone()),
            file_path: None,
            ssl_mode: None,
            connect_timeout_secs: None,
            redis_db: None,
            tls: None,
            auth_source: Some("admin".into()),
        })
        .await
        .unwrap();
        let result: AppResult<()> = async {
            let generated = a.write(&db, "types", "insert", None, &canonical(doc! {"date":bson::DateTime::from_millis(1234), "binary":Bson::Binary(bson::Binary { subtype:bson::spec::BinarySubtype::Generic, bytes:vec![1,2,3] }), "nested":{"values":[1,2,3]}})).await?;
            let generated_doc = parse_document(&generated)?;
            let generated_id = generated_doc.get("_id").unwrap().clone().into_canonical_extjson().to_string();
            assert_eq!(generated, a.document(&db, "types", &generated_id).await?);
            let mut reordered = generated_doc.clone();
            let id = reordered.remove("_id").unwrap();
            reordered.insert("changed", true);
            reordered.insert("_id", id);
            let saved = a.write(&db, "types", "replace", Some(&generated), &canonical(reordered)).await?;
            assert_eq!(saved, a.document(&db, "types", &generated_id).await?);
            a.write(&db, "types", "delete", Some(&saved), "{}").await?;
            let first = a
                .write(
                    &db,
                    "docs",
                    "insert",
                    None,
                    &canonical(doc! {"_id":1,"z":i64::MAX,"a":Bson::Null}),
                )
                .await?;
            for id in 2..54 {
                a.write(
                    &db,
                    "docs",
                    "insert",
                    None,
                    &canonical(doc! {"_id":id,"z":id}),
                )
                .await?;
            }
            let page = a
                .find(FindRequest {
                    database: db.clone(),
                    collection: "docs".into(),
                    filter: "{}".into(),
                    projection: "{}".into(),
                    sort: r#"{"_id":1}"#.into(),
                    limit: 100,
                })
                .await?;
            assert_eq!(page.rows.len(), 50);
            let next = a.next(page.cursor.as_ref().unwrap()).await?;
            assert_eq!(next.rows.len(), 3);
            assert!(next.cursor.is_none());
            let full = a.document(&db, "docs", "{\"$numberInt\":\"1\"}").await?;
            assert_eq!(parse_document(&full)?.get_i64("z").unwrap(), i64::MAX);
            assert_eq!(first, full, "插入结果必须与服务器原文一致");
            let updated = canonical(doc! {"_id":1,"z":2,"new":"value"});
            a.write(&db, "docs", "replace", Some(&first), &updated)
                .await.map_err(|e| AppError::Message(format!("首次替换失败: {e}")))?;
            assert!(a
                .write(&db, "docs", "replace", Some(&first), &updated)
                .await
                .is_err());
            assert!(a
                .write(&db, "docs", "replace", Some(&updated), r#"{"_id":2}"#)
                .await
                .is_err());
            assert!(a
                .write(&db, "docs", "insert", None, &updated)
                .await
                .is_err());
            a.write(&db, "docs", "delete", Some(&updated), "{}").await.map_err(|e| AppError::Message(format!("删除更新文档失败: {e}")))?;
            assert!(a.document(&db, "docs", "1").await.is_err());
            let projected = a
                .find(FindRequest {
                    database: db.clone(),
                    collection: "docs".into(),
                    filter: "{}".into(),
                    projection: r#"{"_id":0,"z":1}"#.into(),
                    sort: "{}".into(),
                    limit: 1,
                })
                .await?;
            assert!(projected.rows[0].id.is_none());
            if let Some(id) = projected.cursor {
                a.release(&id).await;
            }
            let stats=a.inspect(&db,"docs","stats","{}").await?;
            assert_eq!(stats["count"],52);
            let sample=a.inspect(&db,"docs","sample","{}").await?;
            assert_eq!(sample["sampled"],52);
            a.create_index(&db,"docs",r#"{"keys":{"z":1},"options":{"name":"z_unique","unique":true}}"#).await?;
            let indexes=a.inspect(&db,"docs","indexes","{}").await?;
            assert!(indexes["indexes"].as_array().unwrap().iter().any(|v|v["name"]=="z_unique"));
            let aggregation=a.inspect(&db,"docs","aggregate",r#"[{"$match":{"z":{"$gte":10}}},{"$count":"count"}]"#).await?;
            assert_eq!(aggregation["rows"][0]["count"]["$numberInt"],"44");
            assert!(a.inspect(&db,"docs","aggregate",r#"[{"$out":"forbidden"}]"#).await.is_err());
            let dir=tempfile::tempdir()?;
            let typed=a.write(&db,"typed","insert",None,&canonical(doc!{
                "_id":bson::oid::ObjectId::new(),"long":i64::MAX,
                "date":bson::DateTime::from_millis(1234),
                "decimal":"123.45".parse::<bson::Decimal128>().unwrap(),
                "binary":Bson::Binary(bson::Binary{subtype:bson::spec::BinarySubtype::Generic,bytes:vec![0,1,255]}),
                "nested":{"items":[1,Bson::Null]} })).await?;
            for format in ["jsonl","json"] {
                let path=dir.path().join(format!("transfer.{format}")).to_string_lossy().into_owned();
                let request=|direction:&str,collection:&str| TransferRequest {database:db.clone(),collection:collection.into(),path:path.clone(),direction:direction.into(),format:format.into(),filter:"{}".into()};
                let exported=a.transfer(request("export","docs")).await?;
                assert_eq!(exported["rows"],52);
                let imported=a.transfer(request("import",format)).await?;
                assert_eq!(imported["inserted"],52); assert_eq!(imported["skipped"],0);
                let duplicate=a.transfer(request("import",format)).await?;
                assert_eq!(duplicate["inserted"],0); assert_eq!(duplicate["skipped"],52);
                assert!(std::path::Path::new(duplicate["report"].as_str().unwrap()).exists());
                // Cancellation must leave an existing export file intact.
                std::fs::write(&path,"original")?;
                let registry=crate::tasks::TaskRegistry::default();registry.begin("cancel-transfer".into())?;
                let cancelled=registry.scope(Some("cancel-transfer".into()),async {
                    registry.cancel("cancel-transfer")?;
                    a.transfer(request("export","docs")).await
                }).await;
                assert!(matches!(cancelled,Err(AppError::Cancelled(_))));
                assert_eq!(std::fs::read_to_string(&path)?,"original");
                a.transfer(request("export","typed")).await?;
                let target=format!("typed_{format}");
                let copy=a.transfer(request("import",&target)).await?;
                assert_eq!(copy["inserted"],1);
                let id=parse_document(&typed)?.get("_id").unwrap().clone().into_canonical_extjson().to_string();
                assert_eq!(a.document(&db,&target,&id).await?,typed);
            }
            Ok(())
        }
        .await;
        a.client.database(&db).drop().await.unwrap();
        a.close().await;
        result.unwrap();
    }
}
