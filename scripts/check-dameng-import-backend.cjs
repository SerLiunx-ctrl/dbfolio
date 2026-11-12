// 直接引入生产 DM 解析、导入和适配器，仅替换桌面会话存储/任务调度外壳。
// --prepare-only 只生成隔离 harness；默认运行轻量 Cargo 测试，不构建 Tauri。
// 真库验收需 DBFOLIO_TEST_DM_PASSWORD 和 DBFOLIO_TEST_DM_SQL，原始 SQL 永不修改。
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { prepareSource } = require('./check-dameng-import-native.cjs');

const root = process.cwd();
const dest = path.resolve('.qa/dm59-import-backend-check');
const out = path.join(dest, 'runs', String(Date.now()));
const schema = 'DBFOLIO_DM59_' + Date.now();
const read = name => fs.readFileSync(path.join(root, name), 'utf8').replace(/\r\n/g, '\n');
const write = (name, content) => fs.writeFileSync(path.join(dest, 'src', name), content);
const production = name => path.join(root, 'src-tauri/src', name).replace(/\\/g, '/');
const beforeTests = source => source.split('#[cfg(test)]')[0];
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
fs.mkdirSync(path.join(dest, 'src/services'), { recursive: true });
fs.mkdirSync(out, { recursive: true });

let sample;
if (process.env.DBFOLIO_TEST_DM_SQL) {
  const source = path.resolve(process.env.DBFOLIO_TEST_DM_SQL);
  const bytes = fs.readFileSync(source);
  const checked = prepareSource(bytes.toString('utf8').replace(/^\uFEFF/, ''), schema);
  sample = { source, sha256: sha256(bytes), file: path.join(out, 'user-sample-isolated.sql'), ...checked };
  fs.writeFileSync(sample.file, sample.copy);
}
if (process.env.DBFOLIO_TEST_DM_PASSWORD) assert(sample, '真库验收必须提供 DBFOLIO_TEST_DM_SQL 并通过原文件安全检查');

fs.writeFileSync(path.join(dest, 'Cargo.toml'), `[package]
name="dbfolio-dm59-import-check"
version="0.1.0"
edition="2021"
[dependencies]
async-trait="0.1"
thiserror="2"
serde={version="1",features=["derive"]}
serde_json="1"
tokio={version="1",features=["rt-multi-thread","macros","time","sync"]}
dm-rust={version="=0.1.1",features=["pool"]}
chrono="0.4"
sqlparser="0.59"
uuid={version="1",features=["v4"]}
tempfile="3"
encoding_rs="0.8"
futures-util="0.3"
[profile.dev]
debug=0
incremental=false
`);

// Reuse the real SQL adapter trait without pulling sqlx/Tauri or unrelated adapters.
let adapter = read('src-tauri/src/adapters/mod.rs');
adapter = adapter.slice(adapter.indexOf('use async_trait'), adapter.indexOf('pub async fn connect('))
  + adapter.slice(adapter.indexOf('pub fn connect_timeout'), adapter.indexOf('#[cfg(test)]'));
assert(adapter.includes('async fn mysql_connection'), '适配器抽取边界已变化');
adapter = adapter.replace(/    async fn mysql_connection[\s\S]*?\n    }\n/, '');
write('adapters.rs', `pub mod message_queue {pub struct MessageQueueAdapter;}\n#[path=${JSON.stringify(production('adapters/dameng.rs'))}] pub mod dameng;\n` + adapter);
const error = read('src-tauri/src/error.rs');
write('error.rs', error.split('impl From<sqlx::Error>')[0]
  + error.slice(error.indexOf('impl From<std::io::Error>'), error.indexOf('impl From<keyring::Error>')));
for (const name of ['connection_config', 'column_edit', 'create_table', 'dameng_schema', 'database_access', 'explain', 'readonly', 'sql_risk']) {
  write('services/' + name + '.rs', beforeTests(read('src-tauri/src/services/' + name + '.rs')));
}
const ddl = read('src-tauri/src/services/ddl.rs');
write('services/ddl.rs', 'use serde::{Serialize,Deserialize};\n'
  + ddl.slice(ddl.indexOf('#[derive(Debug'), ddl.indexOf('fn option_word'))
  + '\n#[derive(Clone,Debug,Serialize,Deserialize)]\n#[serde(rename_all="camelCase")]\n'
  + ddl.match(/pub struct ColumnFlags \{[^\n]+/)[0] + '\npub struct DdlSpec;\n');
const imports = read('src-tauri/src/services/sql_import.rs');
write('services/sql_import.rs', 'use serde::{Deserialize,Serialize};use std::{collections::HashMap,time::Instant};use tokio::sync::Mutex;use super::mysql_script::Statement;\n'
  + imports.slice(imports.indexOf('#[derive(Clone, Deserialize)]'), imports.indexOf('fn invalid(')));

// Compile production pure migration validation, including the legal-identifier regression.
let queryScript = read('src-tauri/src/services/query_script.rs');
const pure = queryScript.slice(0, queryScript.indexOf('async fn run_sql('))
  .replace('use futures_util::TryStreamExt;\n', '').replace('use sqlx::{Connection, Executor};\n', '')
  .replace(/    async fn evaluate\([\s\S]*?\n    }\n/, '');
assert(!pure.includes('sqlx::'), '查询纯函数抽取仍包含 sqlx，需更新边界');
const queryTests = queryScript.slice(queryScript.indexOf('#[cfg(test)]'), queryScript.indexOf('    #[tokio::test]')) + '}\n';
assert(queryTests.includes('program_detection_only_uses_statement_headers'), '缺少合法名称回归测试');
write('services/query_script.rs', pure + queryTests);
const query = read('src-tauri/src/services/query.rs');
write('services/query.rs', query.slice(query.indexOf('pub fn first_keyword'), query.indexOf('pub fn classify')));

write('services/mod.rs', `pub mod connection_config;pub mod ddl;pub mod column_edit;pub mod create_table;pub mod dameng_schema;
pub mod sql_import;pub mod database_access;pub mod explain;pub mod readonly;pub mod sql_risk;pub mod query;pub mod query_script;
#[path=${JSON.stringify(production('services/mysql_script.rs'))}]pub mod mysql_script;
#[path=${JSON.stringify(production('services/dameng_script.rs'))}]pub mod dameng_script;
#[path=${JSON.stringify(production('services/dameng_import.rs'))}]pub mod dameng_import;
pub mod sql_export {pub struct SqlExportRequest;pub struct SqlExportResult;}
pub mod manual_transaction {use crate::{adapters::{QueryContext,QueryOutcome},error::AppResult};#[async_trait::async_trait]pub trait ManualTransaction:Send {async fn run(&mut self,sql:&str,rows:bool,ctx:&QueryContext)->AppResult<QueryOutcome>;async fn finish(self:Box<Self>,commit:bool)->AppResult<()>;}}
`);
write('state.rs', `use std::{collections::HashMap,sync::Arc};use tokio::sync::Mutex;use crate::{adapters::DbAdapter,error::{AppError,AppResult},services::sql_import::Registry};
#[derive(Clone)]pub struct Session{pub read_only:bool,pub allowed_databases:Option<Vec<String>>}
pub struct LocalStore(pub HashMap<String,Session>);impl LocalStore {pub async fn get_session(&self,id:&str)->AppResult<Session>{self.0.get(id).cloned().ok_or_else(||AppError::NotFound("测试会话不存在".into()))}}
pub struct ConnectedSession{pub adapter:Arc<dyn DbAdapter>}
pub struct AppState{pub local:LocalStore,pub sql_imports:Registry,pub connections:HashMap<String,Arc<ConnectedSession>>,locks:Mutex<HashMap<String,Arc<Mutex<()>>>>}
impl AppState{pub fn new(adapter:Arc<dyn DbAdapter>)->Self{let connected=Arc::new(ConnectedSession{adapter});Self{local:LocalStore(HashMap::from([("rw".into(),Session{read_only:false,allowed_databases:None}),("ro".into(),Session{read_only:true,allowed_databases:None})])),sql_imports:Default::default(),connections:HashMap::from([("rw".into(),connected.clone()),("ro".into(),connected)]),locks:Default::default()}}
pub async fn connected(&self,id:&str)->AppResult<Arc<ConnectedSession>>{self.connections.get(id).cloned().ok_or_else(||AppError::Connection("测试会话未连接".into()))}
pub async fn session_lock(&self,id:&str)->tokio::sync::OwnedMutexGuard<()>{self.locks.lock().await.entry(id.into()).or_default().clone().lock_owned().await}}
`);
write('tasks.rs', `pub fn checkpoint()->crate::error::AppResult<()>{Ok(())}pub fn cancelled()->bool{false}pub fn progress(_current:u64,_total:Option<u64>,_message:impl Into<String>){}\n`);
write('lib.rs', `#![allow(dead_code,unused_imports)]\n#[path=${JSON.stringify(production('meta/mod.rs'))}]pub mod meta;\npub mod adapters;pub mod services;pub mod error;pub mod state;pub mod tasks;\n#[cfg(test)]mod acceptance;\n`);
write('acceptance.rs', String.raw`
use std::{sync::Arc,path::{Path,PathBuf}};
use futures_util::FutureExt;
use crate::{adapters::{dameng::DamengAdapter,ConnectionParams,DbAdapter,QueryContext,QueryOutcome},error::{AppError,AppResult},meta::value::DbValue,services::{dameng_import as import,dameng_script as script,sql_import::{Request,Preview,Report}},state::AppState};
fn ident(s:&str)->String{format!("\"{}\"",s.replace('"',"\"\""))}
fn scalar(r:&QueryOutcome)->i64{match &r.rows[0][0]{DbValue::Int(n)=>*n,DbValue::Decimal(n)=>n.parse().unwrap(),v=>panic!("非数值结果 {v:?}")}}
async fn count(a:&dyn DbAdapter,db:&str,sql:&str)->AppResult<i64>{Ok(scalar(&a.query_page(db,sql,0,100,&QueryContext::new()).await?))}
async fn plan(s:&AppState,db:&str,file:&Path,keep_going:bool)->AppResult<Preview>{import::preview(s,Request{session_id:"rw".into(),database:db.into(),path:file.to_string_lossy().into(),encoding:"utf-8".into(),continue_on_error:keep_going}).await}
async fn execute(s:&AppState,p:&Preview,out:&Path)->AppResult<Report>{import::execute(s,"rw",&p.id,true,&out.to_string_lossy()).await}
fn fixture(out:&Path,name:&str,sql:&str)->AppResult<PathBuf>{let p=out.join(format!("{name}.sql"));std::fs::write(&p,sql)?;Ok(p)}
fn report(r:&Report){let lines=std::fs::read_to_string(&r.report_path).unwrap().lines().map(|l|serde_json::from_str::<serde_json::Value>(l).unwrap()).collect::<Vec<_>>();assert_eq!(lines[0]["status"],"running");assert_eq!(lines.last().unwrap()["status"],"finished");for e in &r.entries{let pending=lines.iter().position(|v|v["number"]==e.number&&v["status"]=="pending").unwrap();let end=lines.iter().position(|v|v["number"]==e.number&&v["status"]==e.status).unwrap();assert!(end>pending);}}

#[tokio::test]
#[ignore="需显式环境凭据；只操作新建随机 DBFOLIO_DM59 模式"]
async fn dm59_import_real(){
 let password=std::env::var("DBFOLIO_TEST_DM_PASSWORD").expect("环境密码");
 let schema=std::env::var("DBFOLIO_TEST_DM_SCHEMA").unwrap();assert!(schema.starts_with("DBFOLIO_DM59_")&&schema[13..].chars().all(|c|c.is_ascii_digit()));
 let out=PathBuf::from(std::env::var("DBFOLIO_TEST_DM_OUTPUT").unwrap());let file=PathBuf::from(std::env::var("DBFOLIO_TEST_DM_PREPARED_SQL").unwrap());
 let params:ConnectionParams=serde_json::from_value(serde_json::json!({"engine":"dameng","host":"127.0.0.1","port":std::env::var("DBFOLIO_TEST_DM_PORT").ok().and_then(|p|p.parse::<u16>().ok()).unwrap_or(15236),"username":std::env::var("DBFOLIO_TEST_DM_USER").unwrap_or_else(|_|"SYSDBA".into()),"password":password,"readOnly":false})).unwrap();
 let adapter:Arc<dyn DbAdapter>=Arc::new(DamengAdapter::connect(&params).await.unwrap());
 assert!(!adapter.list_databases().await.unwrap().iter().any(|d|d.name==schema));
 adapter.execute_affected("SYSDBA",&format!("CREATE SCHEMA {}",ident(&schema))).await.unwrap();
 let state=AppState::new(adapter.clone());
 let work=std::panic::AssertUnwindSafe(async{
  let p=plan(&state,&schema,&file,false).await?;let warnings=p.warnings.join("\n");for word in ["WHENEVER","DEFINE","ECHO","PROMPT"]{assert!(warnings.contains(word));}assert!(import::execute(&state,"rw",&p.id,false,&out.to_string_lossy()).await.is_err());
  let r=execute(&state,&p,&out).await?;assert_eq!(r.failed,0,"{:?}",r.error);assert_eq!(r.executed,p.statements);assert!(!r.uncertain);report(&r);
  let tables=adapter.list_tables(&schema).await?;assert_eq!(tables.len(),20);let first=adapter.introspect_table(&schema,Some(&schema),"CHAT_AGENT_RUN").await?;assert!(first.comment.as_ref().is_some_and(|s|!s.is_empty()));assert!(first.columns.iter().any(|c|c.name=="ID"&&c.auto_increment&&c.comment.as_ref().is_some_and(|s|!s.is_empty())));assert!(!first.indexes.is_empty());
  assert_eq!(count(adapter.as_ref(),&schema,&format!("SELECT COUNT(*) FROM ALL_TRIGGERS WHERE OWNER='{}'",schema)).await?,20);
  adapter.execute_affected(&schema,"CREATE TABLE QA_EVENTS(ID INT PRIMARY KEY,NOTE VARCHAR(80))").await?;
  let changed=fixture(&out,"snapshot","INSERT INTO QA_EVENTS VALUES(50,'快照');\n")?;let fixed=plan(&state,&schema,&changed,false).await?;std::fs::write(&changed,"INSERT INTO QA_EVENTS VALUES(51,'后改');\n")?;let r=execute(&state,&fixed,&out).await?;assert_eq!(r.executed,1);assert_eq!(count(adapter.as_ref(),&schema,"SELECT COUNT(*) FROM QA_EVENTS WHERE ID=50").await?,1);assert_eq!(count(adapter.as_ref(),&schema,"SELECT COUNT(*) FROM QA_EVENTS WHERE ID=51").await?,0);report(&r);
  for (name,before,after,keep,whenever,expected) in [("stop",10,11,false,false,1),("continue",20,21,true,false,2),("whenever",30,31,true,true,1)]{let prefix=if whenever{"WHENEVER SQLERROR EXIT 1\n"}else{""};let f=fixture(&out,name,&format!("{prefix}-- 行号\nINSERT INTO QA_EVENTS VALUES({before},'before;inside');\nINSERT INTO QA_MISSING59 VALUES(1);\nINSERT INTO QA_EVENTS VALUES({after},'after');\n"))?;let r=execute(&state,&plan(&state,&schema,&f,keep).await?,&out).await?;assert_eq!(r.executed,expected);assert_eq!(r.failed,1);assert!(!r.uncertain);assert_eq!(r.entries.iter().find(|e|e.status=="failed").unwrap().line,if whenever{4}else{3});assert_eq!(count(adapter.as_ref(),&schema,&format!("SELECT COUNT(*) FROM QA_EVENTS WHERE ID IN ({before},{after})")).await?,expected as i64);report(&r);}
  let f=fixture(&out,"rollback","SET AUTOCOMMIT OFF;\nINSERT INTO QA_EVENTS VALUES(40,'回滚');\n")?;let r=execute(&state,&plan(&state,&schema,&f,false).await?,&out).await?;assert_eq!(r.failed,0);assert!(!r.uncertain);assert_eq!(count(adapter.as_ref(),&schema,"SELECT COUNT(*) FROM QA_EVENTS WHERE ID=40").await?,0);report(&r);
  let ro=Request{session_id:"ro".into(),database:schema.clone(),path:file.to_string_lossy().into(),encoding:"utf-8".into(),continue_on_error:false};assert!(matches!(import::preview(&state,ro).await,Err(AppError::ReadOnly(_))));
  let f=fixture(&out,"readonly-plan","SELECT 1 FROM DUAL;")?;let p=plan(&state,&schema,&f,false).await?;assert!(matches!(import::execute(&state,"ro",&p.id,true,&out.to_string_lossy()).await,Err(AppError::ReadOnly(_))));
  let batch="SET DEFINE OFF\nCREATE TABLE QA_QUERY(ID INT PRIMARY KEY,\"function\" INT,\"event\" INT,\"trigger\" INT);\nCREATE OR REPLACE TRIGGER TRG_QA_QUERY BEFORE INSERT ON QA_QUERY FOR EACH ROW\nBEGIN\n IF :NEW.ID<0 THEN RAISE_APPLICATION_ERROR(-20010,'QA_RANGE_REJECT'); END IF;\nEND;\n/\nINSERT INTO QA_QUERY VALUES(1,7,8,9);\nCOMMIT;\nPROMPT DM59_QUERY_OK\nSELECT \"function\",\"event\",\"trigger\" FROM QA_QUERY;";
  let p=script::plan(batch)?.unwrap();script::preflight(&p,&schema,false,true)?;let r=script::execute_query(adapter.as_ref(),&p,&schema,false,100,&QueryContext::new()).await?;assert_eq!(r.rows.len(),1);assert_eq!(r.rows[0],vec![DbValue::Int(7),DbValue::Int(8),DbValue::Int(9)]);assert!(r.script_statements.unwrap()>1);
  let trigger_error=adapter.execute_affected(&schema,"INSERT INTO QA_QUERY VALUES(-1,0,0,0)").await.unwrap_err().to_string();assert!(trigger_error.contains("20010")||trigger_error.contains("QA_RANGE_REJECT"),"无 CHECK 约束的触发器未按预期拒绝：{trigger_error}");
  // Original identity trigger: use a valid row, then verify its BEFORE trigger rejects a negative ID.
  adapter.execute_affected(&schema,"INSERT INTO CHAT_AGENT_RUN(SESSION_ID,APP_ID,OWNER_USER_ID,REQUEST_MESSAGE_ID,RUN_STATUS,IS_STREAM,CONFIG_SOURCE,PREFIX_MESSAGES_HASH,TOOL_RESULT_DISPLAY_POLICY,STARTED_AT,DEADLINE_AT,CREATE_ID) VALUES(1,1,'qa',1,'COMPLETED',0,'DRAFT','qa','HIDE',TIMESTAMP '2026-11-12 00:00:00',TIMESTAMP '2026-11-12 00:00:00','qa')").await?;
  let p=script::plan("SET IDENTITY_INSERT CHAT_AGENT_RUN ON;\nINSERT INTO CHAT_AGENT_RUN(ID,SESSION_ID,APP_ID,OWNER_USER_ID,REQUEST_MESSAGE_ID,RUN_STATUS,IS_STREAM,CONFIG_SOURCE,PREFIX_MESSAGES_HASH,TOOL_RESULT_DISPLAY_POLICY,STARTED_AT,DEADLINE_AT,CREATE_ID) VALUES(-1,1,1,'qa',2,'COMPLETED',0,'DRAFT','qa','HIDE',TIMESTAMP '2026-11-12 00:00:00',TIMESTAMP '2026-11-12 00:00:00','qa');\nSET IDENTITY_INSERT CHAT_AGENT_RUN OFF;")?.unwrap();
  let error=script::execute_query(adapter.as_ref(),&p,&schema,false,100,&QueryContext::new()).await.unwrap_err().to_string();
  let trigger_rejected=error.contains("20010")||error.contains("Unsigned identity");let lower=error.to_ascii_lowercase();let check_rejected=lower.contains("check")&&(lower.contains("constraint")||error.contains("约束"));assert!(trigger_rejected||check_rejected,"原始 IDENTITY 范围样例未按预期拒绝：{error}");assert_eq!(count(adapter.as_ref(),&schema,"SELECT COUNT(*) FROM CHAT_AGENT_RUN WHERE ID<0 OR REQUEST_MESSAGE_ID=2").await?,0);
  Ok::<_,AppError>(serde_json::json!({"passed":true,"schema":schema,"statements":r.script_statements,"tables":tables.len(),"identityRangeRejectedBy":if trigger_rejected{"original-trigger"}else{"original-check; independent trigger verified"},"cases":["真实样例导入/元数据/触发器","固定快照","错误行号及默认停止/继续/WHENEVER优先","末尾事务回滚","只读","查询多语句与完整触发器块及合法名称"]}))
 }).catch_unwind().await;
 let cleanup=adapter.execute_affected("SYSDBA",&format!("DROP SCHEMA {} CASCADE",ident(&schema))).await;
 assert!(cleanup.is_ok(),"专用模式清理失败，须清理 {}: {:?}",schema,cleanup.err());
 match work {Ok(Ok(result))=>{std::fs::write(out.join("result.json"),serde_json::to_vec_pretty(&result).unwrap()).unwrap();println!("{}",result);},Ok(Err(error))=>panic!("{error}"),Err(panic)=>std::panic::resume_unwind(panic)}
}
`);

const summary = { manifest: path.join(dest, 'Cargo.toml'), output: out, schema, sourceChecked: !!sample, preparedOnly: process.argv.includes('--prepare-only') };
if (summary.preparedOnly) {
  console.log(JSON.stringify(summary));
} else {
  const args = ['test', '--manifest-path', summary.manifest, '--offline', '--', ...(process.env.DBFOLIO_TEST_DM_PASSWORD ? ['--include-ignored'] : []), '--test-threads=1', '--nocapture'];
  const child = spawnSync('cargo', args, { stdio: 'inherit', windowsHide: true, env: { ...process.env, DBFOLIO_TEST_DM_SCHEMA: schema, DBFOLIO_TEST_DM_OUTPUT: out, ...(sample ? { DBFOLIO_TEST_DM_PREPARED_SQL: sample.file } : {}) } });
  if (child.error) throw child.error;
  if (sample) assert.equal(sha256(fs.readFileSync(sample.source)), sample.sha256, '原始 SQL 在验收期间发生变化');
  process.exitCode = child.status ?? 1;
  console.log(JSON.stringify(summary));
}
