use crate::{error::{AppError,AppResult},meta::Engine,state::AppState};
pub async fn writable(state:&AppState,id:&str)->AppResult<()> {if state.local.get_session(id).await?.read_only {return Err(AppError::ReadOnly("当前会话为只读模式，已阻止写入".into()));} Ok(())}
pub fn sql(engine:Engine,text:&str)->AppResult<()> {
 let (_,words)=super::explain::scan_sql(engine,text).map_err(|e|AppError::ReadOnly(format!("只读模式拒绝该语句：{e}")))?;
 let words:Vec<_>=words.split_whitespace().map(str::to_ascii_uppercase).collect();
 let first=words.first().map(String::as_str).unwrap_or("");
 let denied=words.iter().any(|w|["INSERT","UPDATE","DELETE","MERGE","INTO","CREATE","DROP","ALTER","TRUNCATE","COPY","CALL","EXEC","SET","LOCK","FOR","ATTACH","DETACH","LOAD","REPLACE","GRANT","REVOKE","SET_CONFIG","DBLINK_EXEC","LOAD_EXTENSION","LO_IMPORT","LO_EXPORT","LO_UNLINK","NEXTVAL","SETVAL"].contains(&w.as_str()));
 let allowed=matches!(first,"SELECT"|"WITH"|"SHOW"|"DESCRIBE"|"DESC"|"VALUES"|"TABLE");
 if denied||!allowed {return Err(AppError::ReadOnly("只读模式仅允许明确的读取语句；不支持写入、锁定、多语句、PRAGMA 或未知命令".into()));} Ok(())
}
#[cfg(test)] mod tests {use super::*;
 #[test] fn readonly_statements(){for engine in [Engine::Mysql,Engine::Postgres,Engine::Sqlite]{for text in ["SELECT 1","SELECT 'DELETE' AS x","WITH x AS (SELECT 1) SELECT * FROM x","SHOW TABLES"]{assert!(sql(engine,text).is_ok(),"{text}");}for text in ["ATTACH 'x' AS y","PRAGMA journal_mode=WAL","SELECT 1; DELETE FROM t","WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x","SELECT * FROM t FOR UPDATE","SELECT set_config('default_transaction_read_only','off',false)","/*! DELETE FROM t */ SELECT 1","UNKNOWN foo"]{assert!(sql(engine,text).is_err(),"{text}");}}}
}

#[cfg(test)] mod integration {
 use super::*;use serde_json::json;
 #[tokio::test] async fn readonly_sqlite_and_sync(){
 let dir=tempfile::tempdir().unwrap();let path=dir.path().join("data.sqlite");std::fs::File::create(&path).unwrap();
 let state=AppState::with_local(crate::store::LocalStore::initialize_in(dir.path().join("config")).await.unwrap());
 let input:crate::store::SessionInput=serde_json::from_value(json!({"name":"只读测试","engine":"sqlite","filePath":path.to_str().unwrap(),"readOnly":true})).unwrap();
 let session=state.local.create_session(&input).await.unwrap();super::super::session::connect(&state,&session.id).await.unwrap();

 for force in [false,true] {
  assert!(matches!(super::super::ddl::apply(&state,&session.id,"main",&super::super::ddl::DdlSpec::DropTable{schema:None,table:"blocked".into()},force).await,Err(AppError::ReadOnly(_))));
  assert!(matches!(super::super::ddl::drop_database(&state,&session.id,"main",force).await,Err(AppError::ReadOnly(_))));
 }
 assert!(matches!(super::super::ddl::create_database(&state,&session.id,"blocked",None,None).await,Err(AppError::ReadOnly(_))));
 let adapter=state.connected(&session.id).await.unwrap().adapter.clone();assert!(adapter.execute_affected("main","CREATE TABLE blocked(id INT)").await.is_err());
 let request=json!({"source":{"sessionId":"unused","database":"main"},"target":{"sessionId":session.id,"database":"main"},"tables":[]});
 // Structure-plan read-only rejection is covered by sync::schema::tests::real_sqlite_plan_and_readonly.
 assert!(matches!(super::super::sync::execute_data(&state,&serde_json::from_value(request).unwrap()).await,Err(AppError::ReadOnly(_))));
 assert!(matches!(super::super::query::fetch_page(&state,&session.id,"main","SELECT 1; DELETE FROM t",0,10,&[]).await,Err(AppError::ReadOnly(_))));
 assert!(super::super::query::fetch_page(&state,&session.id,"main","SELECT 1",0,10,&[]).await.is_ok());
 state.disconnect(&session.id).await;
 }
}
