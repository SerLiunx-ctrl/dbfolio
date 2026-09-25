//! 显式运行的本机集成验收；不会连接远程会话。
use crate::{adapters::{QueryContext, SqlParams}, meta::Engine, state::AppState};

#[tokio::test]
#[ignore = "需要本机已保存的 MySQL/PostgreSQL 会话；仅创建随机测试库/schema"]
async fn local_sql_acceptance() {
    let state=AppState::initialize().await.unwrap();
    let sessions=state.local.list_sessions().await.unwrap();
    for engine in [Engine::Mysql,Engine::Postgres] {
        if std::env::var("DW_QA_ENGINE").is_ok_and(|value| value != if engine==Engine::Mysql {"mysql"}else{"postgres"}) {continue;}
        let session=sessions.iter().find(|s|s.engine==engine && s.host.as_deref()==Some("127.0.0.1") && !s.read_only).expect("缺少本机可写会话");
        crate::services::session::connect(&state,&session.id).await.unwrap();
        let connected=state.connected(&session.id).await.unwrap();
        let adapter=connected.adapter.as_ref();
        if engine==Engine::Mysql {
            if let Ok(cleanup)=std::env::var("DW_QA_CLEANUP") {
                assert!(cleanup.starts_with("dw_qa_") && cleanup.len()==38 && cleanup[6..].chars().all(|c|c.is_ascii_hexdigit()));
                let tables=adapter.list_tables(&cleanup).await.unwrap();
                assert_eq!(tables.len(),1);assert_eq!(tables[0].name,"items");
                let rows=adapter.query_page(&cleanup,"SELECT COUNT(*) FROM items WHERE value LIKE 'row-%'",0,1,&QueryContext::new()).await.unwrap();
                assert_eq!(serde_json::to_value(&rows.rows[0][0]).unwrap(),serde_json::json!(["int",650]));
                adapter.execute_statements("mysql",&[format!("DROP DATABASE `{cleanup}`")]).await.unwrap();
                println!("已清理此前中断的验收库 {cleanup}");
            }
        }
        let name=format!("dw_qa_{}",uuid::Uuid::new_v4().simple());
        let (db,qualified,create,drop_sql,schema)=if engine==Engine::Mysql {
            ("mysql",format!("`{name}`.items"),format!("CREATE DATABASE `{name}`"),format!("DROP DATABASE `{name}`"),None)
        } else {("postgres",format!("\"{name}\".items"),format!("CREATE SCHEMA \"{name}\""),format!("DROP SCHEMA \"{name}\" CASCADE"),Some(name.as_str()))};
        adapter.execute_statements(db,&[create]).await.unwrap();
        println!("创建验收对象 {name}");
        let outcome:crate::error::AppResult<()> = async {
            adapter.execute_statements(db,&[format!("CREATE TABLE {qualified} (id BIGINT PRIMARY KEY, value TEXT)")]).await?;
            let values=(1..=650).map(|i|format!("({},'row-{i}')",i*2)).collect::<Vec<_>>().join(",");
            adapter.execute_transaction(db,&[SqlParams{sql:format!("INSERT INTO {qualified} VALUES {values}"),params:vec![]}]).await?;
            let target_db=if engine==Engine::Mysql {name.as_str()}else{db};
            let meta=adapter.introspect_table(target_db,schema,"items").await?;
            assert!(meta.columns.iter().any(|c|c.name=="id"));
            let first=crate::services::query::fetch_page(&state,&session.id,db,&format!("SELECT id,value FROM {qualified} ORDER BY id"),0,200,&[]).await?;
            let second=crate::services::query::fetch_page(&state,&session.id,db,&format!("SELECT id,value FROM {qualified} WHERE id > 400 ORDER BY id"),0,200,&[]).await?;
            assert_eq!(first.rows.len(),200);assert_eq!(second.rows.len(),200);
            assert_eq!(serde_json::to_value(&second.rows[0][0]).unwrap(),serde_json::json!(["int",402]));
            let affected=adapter.execute_transaction(db,&[SqlParams{sql:format!("UPDATE {qualified} SET value='verified' WHERE id=402 AND value='row-201'"),params:vec![]}]).await?;
            assert_eq!(affected,1);
            let stale=adapter.execute_transaction(db,&[SqlParams{sql:format!("UPDATE {qualified} SET value='wrong' WHERE id=402 AND value='row-201'"),params:vec![]}]).await?;
            assert_eq!(stale,0);
            let filtered=adapter.query_page(db,&format!("SELECT id FROM {qualified} WHERE id>=1200 ORDER BY id DESC"),0,200,&QueryContext::new()).await?;
            assert_eq!(filtered.rows.len(),51);
            Ok(())
        }.await;
        adapter.execute_statements(db,&[drop_sql]).await.unwrap();
        outcome.unwrap();
        state.disconnect(&session.id).await;
        println!("本机 {:?}：连接、内省、分页、筛选排序、写入旧值校验、测试对象清理通过",engine);
    }
}

#[tokio::test]
#[ignore = "需要本机 Redis 6379；随机键带 1 小时过期"]
async fn local_redis_acceptance() {
    use crate::adapters::{redis::RedisAdapter,key_value::KeyValueAdapter,ConnectionParams};
    let params:ConnectionParams=serde_json::from_value(serde_json::json!({"engine":"redis","host":"127.0.0.1","port":6379})).unwrap();
    let adapter=RedisAdapter::connect(&params).await.unwrap();
    let prefix=format!("qa:dw-v084:{}",uuid::Uuid::new_v4());
    let mut connection=redis::Client::open("redis://127.0.0.1:6379/0").unwrap().get_multiplexed_async_connection().await.unwrap();
    for kind in ["list","hash","set","zset","stream"] {
        let key=format!("{prefix}:{kind}");
        let mut pipe=redis::pipe();
        for i in 0..250 {
            let value=format!("item-{i:03}");
            match kind {
                "list"=>{pipe.cmd("RPUSH").arg(&key).arg(&value).ignore();},
                "hash"=>{pipe.cmd("HSET").arg(&key).arg(format!("field-{i}")).arg(&value).ignore();},
                "set"=>{pipe.cmd("SADD").arg(&key).arg(&value).ignore();},
                "zset"=>{pipe.cmd("ZADD").arg(&key).arg(i).arg(&value).ignore();},
                _=>{pipe.cmd("XADD").arg(&key).arg("*").arg("value").arg(&value).ignore();},
            }
        }
        pipe.cmd("EXPIRE").arg(&key).arg(3600).ignore();
        pipe.query_async::<()>(&mut connection).await.unwrap();
        let mut cursor=None;let mut entries=Vec::new();
        loop {
            let page=adapter.key_preview(0,&key,100,cursor.as_deref()).await.unwrap();
            entries.extend(page.entries);cursor=page.next_cursor;
            if cursor.is_none(){break;}
            assert!(entries.len()<=500,"游标没有前进");
        }
        assert_eq!(entries.len(),250,"{kind}");
        adapter.delete_key(0,&key).await.unwrap();
        println!("Redis {kind}：250 项完整续读、清理通过");
    }
}
