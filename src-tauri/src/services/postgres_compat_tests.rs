//! 仅连接显式指定的隔离 PG 服务，配置和对象均在临时目录/随机 schema 内。
use super::ddl::{self, DdlSpec};
use crate::{adapters::DbAdapter, state::AppState};
use std::sync::Arc;

#[test]
fn ddl_contract_uses_camel_case_and_accepts_legacy_fields() {
    for (kind, extra) in [("replaceIndex", serde_json::json!({"oldName":"old_idx","unique":false})), ("addForeignKey",serde_json::json!({"refTable":"parent","refSchema":"refs","refColumns":["id"],"onDelete":"CASCADE","onUpdate":"NO ACTION"})), ("replaceForeignKey",serde_json::json!({"oldName":"old_fk","refTable":"parent","refSchema":"refs","refColumns":["id"],"onDelete":"CASCADE","onUpdate":"NO ACTION"}))] {
        let mut value=serde_json::json!({"type":kind,"table":"items","schema":"public","name":"new_name","columns":if kind=="replaceIndex" {serde_json::json!([{"name":"id"}])} else {serde_json::json!(["id"])}});
        value.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        let parsed:DdlSpec=serde_json::from_value(value.clone()).unwrap();
        let output=serde_json::to_value(parsed).unwrap();
        for key in extra.as_object().unwrap().keys() {assert_eq!(output[key],value[key],"{kind}/{key}");}
        for (camel,snake) in [("oldName","old_name"),("refTable","ref_table"),("refSchema","ref_schema"),("refColumns","ref_columns"),("onDelete","on_delete"),("onUpdate","on_update")] {
            if let Some(field)=value.as_object_mut().unwrap().remove(camel) {value[snake]=field;}
            assert!(output.get(snake).is_none());
        }
        serde_json::from_value::<DdlSpec>(value).unwrap();
    }
}

struct Fixture {
    _dir: tempfile::TempDir,
    state: AppState,
    session: String,
    adapter: Arc<dyn DbAdapter>,
    schema: String,
}
impl Fixture {
    async fn new() -> Self {
        let port: u16 = std::env::var("DBFOLIO_TEST_PG_PORT").expect("须显式设置隔离 PG 端口").parse().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::with_local(crate::store::LocalStore::initialize_in(dir.path().join("config")).await.unwrap());
        let input = serde_json::from_value(serde_json::json!({"name":"PG 隔离验收","engine":"postgres","host":"127.0.0.1","port":port,"username":"postgres","database":"postgres","sslMode":"disable","readOnly":false})).unwrap();
        let session = state.local.create_session(&input).await.unwrap();
        super::session::connect(&state, &session.id).await.unwrap();
        let adapter = state.connected(&session.id).await.unwrap().adapter.clone();
        let schema = format!("qa.pg_{}", uuid::Uuid::new_v4().simple());
        adapter.execute_affected("postgres", &format!("CREATE SCHEMA {}", adapter.quote_ident(&schema))).await.unwrap();
        Self { _dir: dir, state, session: session.id, adapter, schema }
    }
    fn target(&self, table: &str) -> String { format!("{}.{}", self.adapter.quote_ident(&self.schema), self.adapter.quote_ident(table)) }
    async fn sql(&self, sql: &str) { self.adapter.execute_affected("postgres", sql).await.unwrap(); }
    fn spec(&self, mut value: serde_json::Value) -> DdlSpec { value["schema"] = self.schema.clone().into(); serde_json::from_value(value).unwrap() }
    async fn apply(&self, spec: &DdlSpec) -> crate::error::AppResult<Vec<String>> { ddl::apply(&self.state, &self.session, "postgres", spec, true).await }
    async fn meta(&self, table: &str) -> crate::meta::TableMeta { self.adapter.introspect_table("postgres", Some(&self.schema), table).await.unwrap() }
    async fn cleanup(self) { self.sql(&format!("DROP SCHEMA {} CASCADE", self.adapter.quote_ident(&self.schema))).await; self.state.disconnect(&self.session).await; }
}

#[tokio::test] #[ignore="需要显式指定 DBFOLIO_TEST_PG_PORT 的隔离 PostgreSQL"]
async fn pg_compat_create_and_case_sensitive_columns() {
    let f=Fixture::new().await;
    let draft=serde_json::json!({"type":"createTableDraft","draft":{"schema":f.schema,"table":"items","columns":[
        {"name":"id","dataType":"bigint","nullable":false,"primaryKey":true,"autoIncrement":true},
        {"name":"Code","dataType":"varchar(20)","nullable":true,"primaryKey":false,"comment":"路径 C:\\it's"},
        {"name":"code","dataType":"numeric(18,6)","nullable":true,"primaryKey":false,"defaultMode":"literal","defaultValue":"1.25"},
        {"name":"created","dataType":"timestamp(3) with time zone","nullable":false,"primaryKey":false,"defaultMode":"timestamp"}
    ],"indexes":[{"name":"Idx_Code","columns":[{"name":"Code"}],"unique":false},{"name":"idx_code","columns":[{"name":"code"}],"unique":false}],"foreignKeys":[],"options":{"comment":"建表验收"}}});
    f.apply(&serde_json::from_value(draft).unwrap()).await.unwrap();
    let m=f.meta("items").await; assert!(m.columns[0].auto_increment); assert_eq!(m.columns[1].comment.as_deref(),Some("路径 C:\\it's")); assert!(m.indexes.iter().any(|i|i.name=="Idx_Code")); assert!(m.indexes.iter().any(|i|i.name=="idx_code"));
    let spec=f.spec(serde_json::json!({"type":"columnFlags","table":"items","changes":[{"name":"Code","newName":"CODE","dataType":"varchar(40)","defaultMode":"literal","defaultValue":"回退值","nullable":true,"comment":"改名后"}]}));
    let result=f.apply(&spec).await;
    if result.is_ok() {let after=f.meta("items").await;let c=after.columns.iter().find(|c|c.name=="CODE").unwrap();assert_eq!(c.raw_type,"character varying(40)");assert_eq!(c.comment.as_deref(),Some("改名后"));assert!(c.default_value.as_deref().unwrap().contains("回退值"));}
    let message=result.as_ref().err().map(ToString::to_string); f.cleanup().await;
    assert!(result.is_ok(),"PG 引号名称应区分大小写：{message:?}");
}

#[tokio::test] #[ignore="需要显式指定 DBFOLIO_TEST_PG_PORT 的隔离 PostgreSQL"]
async fn pg_compat_cross_schema_foreign_key() {
    let f=Fixture::new().await;
    let refs=format!("{}_ref",f.schema);
    let ref_target=format!("{}.\"parent\"",f.adapter.quote_ident(&refs));
    f.sql(&format!("CREATE SCHEMA {}",f.adapter.quote_ident(&refs))).await;
    f.sql(&format!("CREATE TABLE {ref_target} (id int PRIMARY KEY)")).await;
    f.sql(&format!("CREATE TABLE {} (pid int)",f.target("child"))).await;
    let spec=f.spec(serde_json::json!({"type":"addForeignKey","table":"child","name":"fk_parent","columns":["pid"],"refSchema":refs,"refTable":"parent","refColumns":["id"],"onDelete":"CASCADE","onUpdate":"NO ACTION"}));
    let result=f.apply(&spec).await;
    if result.is_ok() { assert_eq!(f.meta("child").await.foreign_keys[0].ref_schema.as_deref(),Some(refs.as_str())); }
    let message=result.as_ref().err().map(ToString::to_string); f.sql(&format!("DROP SCHEMA {} CASCADE",f.adapter.quote_ident(&refs))).await; f.cleanup().await;
    assert!(result.is_ok(),"外键引用 Schema 必须独立引用：{message:?}");
}

#[tokio::test] #[ignore="需要显式指定 DBFOLIO_TEST_PG_PORT 的隔离 PostgreSQL"]
async fn pg_compat_replace_index_rollback() {
    let f=Fixture::new().await;
    f.sql(&format!("CREATE TABLE {} (id int)",f.target("items"))).await;
    f.sql(&format!("CREATE INDEX old_idx ON {} (id)",f.target("items"))).await;
    let valid=f.spec(serde_json::json!({"type":"replaceIndex","table":"items","oldName":"old_idx","name":"new_idx","columns":[{"name":"id","desc":true}],"unique":false}));
    f.apply(&valid).await.unwrap();assert!(f.meta("items").await.indexes.iter().find(|i|i.name=="new_idx").unwrap().columns[0].desc);
    let spec=f.spec(serde_json::json!({"type":"replaceIndex","table":"items","oldName":"new_idx","name":"bad_idx","columns":[{"name":"missing"}],"unique":false}));
    assert!(f.apply(&spec).await.is_err());
    let retained=f.meta("items").await.indexes.iter().any(|i|i.name=="new_idx"); f.cleanup().await;
    assert!(retained,"新索引失败必须回滚，保留旧索引");
}

#[tokio::test] #[ignore="需要显式指定 DBFOLIO_TEST_PG_PORT 的隔离 PostgreSQL"]
async fn pg_compat_replace_foreign_key_rollback() {
    let f=Fixture::new().await;
    f.sql(&format!("CREATE TABLE {} (id int PRIMARY KEY)",f.target("parent"))).await;
    f.sql(&format!("CREATE TABLE {} (pid int CONSTRAINT old_fk REFERENCES {}(id))",f.target("child"),f.target("parent"))).await;
    let valid=f.spec(serde_json::json!({"type":"replaceForeignKey","table":"child","oldName":"old_fk","name":"new_fk","columns":["pid"],"refSchema":f.schema,"refTable":"parent","refColumns":["id"],"onDelete":"CASCADE","onUpdate":"RESTRICT"}));
    f.apply(&valid).await.unwrap();assert_eq!(f.meta("child").await.foreign_keys[0].on_delete,"CASCADE");
    let spec=f.spec(serde_json::json!({"type":"replaceForeignKey","table":"child","oldName":"new_fk","name":"bad_fk","columns":["pid"],"refSchema":f.schema,"refTable":"missing","refColumns":["id"],"onDelete":"NO ACTION","onUpdate":"NO ACTION"}));
    assert!(f.apply(&spec).await.is_err());
    let retained=f.meta("child").await.foreign_keys.iter().any(|i|i.name=="new_fk"); f.cleanup().await;
    assert!(retained,"新外键失败必须回滚，保留旧外键");
}

#[tokio::test] #[ignore="需要显式指定 DBFOLIO_TEST_PG_PORT 的隔离 PostgreSQL"]
async fn pg_compat_index_metadata() {
    let f=Fixture::new().await;
    f.sql(&format!("CREATE TABLE {} (id int, label text, payload jsonb)",f.target("items"))).await;
    f.sql(&format!("CREATE INDEX idx_desc ON {} (id DESC) INCLUDE (label) WHERE id > 0",f.target("items"))).await;
    f.sql(&format!("CREATE INDEX idx_gin ON {} USING gin (payload)",f.target("items"))).await;
    let m=f.meta("items").await;
    let protected=f.spec(serde_json::json!({"type":"replaceIndex","table":"items","oldName":"idx_desc","name":"idx_desc","columns":[{"name":"id"}],"unique":false}));
    let protected_result=f.apply(&protected).await;
    f.cleanup().await;
    let desc=m.indexes.iter().find(|i|i.name=="idx_desc").unwrap();
    assert_eq!(desc.method.as_deref(),Some("btree")); assert!(desc.columns[0].desc); assert_eq!(desc.columns.len(),1,"INCLUDE 列不能当作索引键");
    assert_eq!(m.indexes.iter().find(|i|i.name=="idx_gin").unwrap().method.as_deref(),Some("gin"));
    assert!(desc.definition.as_deref().unwrap().contains("INCLUDE")); assert!(desc.edit_unsupported_reason.is_some());
    assert!(protected_result.is_err(),"简易表单不能抹掉复杂索引的定义");
}

#[tokio::test] #[ignore="需要显式指定 DBFOLIO_TEST_PG_PORT 的隔离 PostgreSQL"]
async fn pg_compat_append_field_types_defaults_and_comments() {
    let f=Fixture::new().await;f.sql(&format!("CREATE TABLE {} (id bigint PRIMARY KEY)",f.target("items"))).await;
    for (name,ty,mode,value,key) in [("amount","numeric(18,6)","literal","12.345678","index"),("enabled","boolean","literal","false","none"),("changed","timestamp(3) with time zone","timestamp","","none"),("payload","jsonb","literal","{\"ok\":true}","none"),("uid","uuid","literal","123e4567-e89b-12d3-a456-426614174000","unique"),("empty","varchar(20)","literal","","none")] {
        let spec=f.spec(serde_json::json!({"type":"addColumnDraft","table":"items","key":key,"column":{"name":name,"dataType":ty,"nullable":true,"primaryKey":false,"defaultMode":mode,"defaultValue":value,"comment":"追加 C:\\it's"}}));
        let preview=ddl::preview(&f.state,&f.session,"postgres",&spec).await.unwrap();let applied=f.apply(&spec).await.unwrap();assert_eq!(preview,applied);
        let meta=f.meta("items").await;let c=meta.columns.iter().find(|c|c.name==name).unwrap();assert_eq!(c.comment.as_deref(),Some("追加 C:\\it's"));assert!(c.default_value.is_some());
        if name=="amount" {assert_eq!(c.raw_type,"numeric(18,6)");}
        if key!="none" {assert!(meta.indexes.iter().any(|i|i.columns.iter().any(|col|col.name==name)));}
    }
    f.cleanup().await;
}

#[tokio::test] #[ignore="需要 DBFOLIO_TEST_PG_PORT 的隔离 PG，且服务器预装 pgvector 文件；测试自行在临时数据库启用"]
async fn pg_types_discovery_is_database_scoped_and_vector_roundtrips(){
    let f=Fixture::new().await;let base=format!("types_{}",uuid::Uuid::new_v4().simple());let with_ext=format!("{base}_with");let without_ext=format!("{base}_without");
    f.sql(&format!("CREATE DATABASE {}",f.adapter.quote_ident(&with_ext))).await;
    f.sql(&format!("CREATE DATABASE {}",f.adapter.quote_ident(&without_ext))).await;
    f.adapter.execute_affected(&without_ext,"CREATE TYPE public.\"Mood\" AS ENUM ('On','Off')").await.unwrap();
    f.adapter.execute_affected(&without_ext,"CREATE DOMAIN public.positive AS integer CHECK (VALUE > 0)").await.unwrap();
    let ext_schema="vectors.qa";let qschema=f.adapter.quote_ident(ext_schema);
    f.adapter.execute_affected(&with_ext,&format!("CREATE SCHEMA {qschema}")).await.unwrap();
    f.adapter.execute_affected(&with_ext,&format!("CREATE EXTENSION vector WITH SCHEMA {qschema}")).await.unwrap();
    let catalog=f.adapter.column_types(&with_ext).await.unwrap();let plain=f.adapter.column_types(&without_ext).await.unwrap();
    if let Ok(dir)=std::env::var("DBFOLIO_TYPE_FIXTURE_DIR"){
        let dir=std::path::Path::new(&dir);std::fs::create_dir_all(dir).unwrap();
        for (file,data) in [("pg-vector.json",catalog.clone()),("pg-plain.json",plain.clone()),("mysql57.json",crate::meta::data_types::builtin(crate::meta::Engine::Mysql,"5.7.7")),("mysql84.json",crate::meta::data_types::builtin(crate::meta::Engine::Mysql,"8.4.6")),("mysql90.json",crate::meta::data_types::builtin(crate::meta::Engine::Mysql,"9.0.0"))]{std::fs::write(dir.join(file),serde_json::to_vec(&data).unwrap()).unwrap();}
    }
    assert!(!plain.types.iter().any(|t|t.category=="向量"));assert!(plain.types.iter().any(|t|t.name=="jsonb"));
    assert!(plain.types.iter().any(|t|t.name=="\"public\".\"Mood\""&&t.description.contains("枚举")));
    assert!(plain.types.iter().any(|t|t.name=="\"public\".\"positive\""&&t.description.contains("域类型")));
    for name in ["vector","halfvec","sparsevec"]{
        let ty=catalog.types.iter().find(|t|t.name==format!("{qschema}.{}",f.adapter.quote_ident(name))).unwrap();assert_eq!(ty.arguments,"dimensions");assert!(ty.description.contains("vector 扩展"));
        let spec: DdlSpec=serde_json::from_value(serde_json::json!({"type":"createTableDraft","draft":{"schema":"public","table":name,"columns":[{"name":"id","dataType":"bigint","nullable":false,"primaryKey":true,"autoIncrement":true},{"name":"embedding","dataType":format!("{}(3)",ty.name),"nullable":true,"primaryKey":false}],"indexes":[],"foreignKeys":[],"options":{}}})).unwrap();
        ddl::apply(&f.state,&f.session,&with_ext,&spec,true).await.unwrap();let meta=f.adapter.introspect_table(&with_ext,Some("public"),name).await.unwrap();assert!(meta.columns[1].raw_type.contains("(3)"));
    }
    f.adapter.execute_affected(&with_ext,"DROP EXTENSION vector CASCADE").await.unwrap();
    assert!(!f.adapter.column_types(&with_ext).await.unwrap().types.iter().any(|t|t.category=="向量"));
    for db in [with_ext,without_ext]{f.sql(&format!("DROP DATABASE {} WITH (FORCE)",f.adapter.quote_ident(&db))).await;}
    f.cleanup().await;
}
