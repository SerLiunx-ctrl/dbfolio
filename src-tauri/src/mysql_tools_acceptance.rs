//! Opt-in integration suite. Only loopback sessions and freshly generated databases are used.
use crate::{
    adapters::QueryContext,
    error::AppResult,
    meta::Engine,
    services::{mysql_objects as objects, sql_export, sql_import},
    state::{AppState, ConnectedSession},
};
use futures_util::FutureExt;
use serde_json::json;
use sqlx::{Connection, Executor, Row};
use std::{io::Write, sync::Arc, time::Duration};

#[tokio::test]
#[ignore = "需要本机 MySQL 会话；仅创建当前连接的随机临时表"]
async fn mysql_text_binary_decoding() {
    use crate::meta::value::DbValue;
    let state = AppState::initialize().await.unwrap();
    let sessions = state.local.list_sessions().await.unwrap();
    let session = sessions.iter().find(|s| s.engine == Engine::Mysql
        && s.host.as_deref() == Some("127.0.0.1") && !s.read_only && s.allowed_databases.is_none())
        .expect("没有本机可写 MySQL 会话");
    crate::services::session::connect(&state, &session.id).await.unwrap();
    let adapter = state.connected(&session.id).await.unwrap().adapter.clone();
    let mut conn = adapter.mysql_connection("mysql", true).await.unwrap();
    let table = format!("dbfolio_decode_{}", uuid::Uuid::new_v4().simple());
    conn.execute(format!("CREATE TEMPORARY TABLE `{table}` (c CHAR(64) COLLATE utf8mb4_bin,
        v VARCHAR(64) COLLATE utf8mb4_bin, t TEXT COLLATE utf8mb4_bin,
        normal CHAR(64) COLLATE utf8mb4_general_ci, b BINARY(4), vb VARBINARY(8), bl BLOB,
        empty_value CHAR(4), null_value CHAR(4), long_value LONGTEXT COLLATE utf8mb4_bin)
        DEFAULT CHARSET=utf8mb4").as_str()).await.unwrap();
    conn.execute(format!("INSERT INTO `{table}` VALUES ('数据库','user_中文','文本😀','普通文本',
        X'41424344',X'00FF4142',X'41424344','',NULL,REPEAT('长',100000))").as_str()).await.unwrap();
    let sql = format!("SELECT * FROM `{table}`");
    // Prepared statements and text protocol must use the same text/binary distinction.
    let prepared = sqlx::query(&sql).fetch_one(&mut conn).await.unwrap();
    let text = sqlx::raw_sql(&sql).fetch_one(&mut conn).await.unwrap();
    for row in [prepared, text] {
        let values: Vec<_> = (0..row.len()).map(|i| crate::adapters::mysql::decode_cell(&row, i)).collect();
        assert_eq!(&values[..9], &[
            DbValue::Text("数据库".into()), DbValue::Text("user_中文".into()),
            DbValue::Text("文本😀".into()), DbValue::Text("普通文本".into()),
            DbValue::Bytes(b"ABCD".to_vec()), DbValue::Bytes(vec![0,255,65,66]),
            DbValue::Bytes(b"ABCD".to_vec()), DbValue::Text(String::new()), DbValue::Null,
        ]);
        assert!(matches!(&values[9], DbValue::Truncated(v) if v.starts_with('长')));
        assert_eq!(row.try_get::<String,_>(9).unwrap(), "长".repeat(100000));
    }
    // Full-value and ordinary SQL query paths also receive correctly typed text.
    let sql = "SELECT _utf8mb4'字段文本' COLLATE utf8mb4_bin AS c";
    assert_eq!(adapter.query_page("mysql", sql, 0, 1, &QueryContext::new()).await.unwrap().rows[0][0],
        DbValue::Text("字段文本".into()));
    assert_eq!(adapter.fetch_full_value("mysql", sql).await.unwrap(), Some(DbValue::Text("字段文本".into())));
    assert_eq!(adapter.fetch_full_value("mysql", "SELECT X'41424344'").await.unwrap(), Some(DbValue::Bytes(b"ABCD".to_vec())));
    conn.close().await.unwrap(); // Temporary table is removed even on disconnect/panic.
}

async fn import(
    state: &AppState,
    id: &str,
    db: &str,
    dir: &std::path::Path,
    sql: &str,
    keep: bool,
) -> AppResult<sql_import::Report> {
    let mut file = tempfile::NamedTempFile::new_in(dir)?;
    file.write_all(sql.as_bytes())?;
    let p = sql_import::preview(
        state,
        sql_import::Request {
            session_id: id.into(),
            database: db.into(),
            path: file.path().to_string_lossy().into(),
            encoding: "utf-8".into(),
            continue_on_error: keep,
        },
    )
    .await?;
    sql_import::execute(state, id, &p.id, true, dir.to_str().unwrap()).await
}
#[tokio::test]
#[ignore = "需要本机已保存的可写、无限制 MySQL 会话；仅操作随机 dbfolio_qa_ 测试库"]
async fn mysql_r01_r03_roundtrip() {
    let state = AppState::initialize().await.unwrap();
    let sessions = state.local.list_sessions().await.unwrap();
    let session = sessions
        .iter()
        .find(|s| {
            s.engine == Engine::Mysql
                && s.host.as_deref() == Some("127.0.0.1")
                && !s.read_only
                && s.allowed_databases.is_none()
        })
        .expect("没有本机可写 MySQL 会话");
    crate::services::session::connect(&state, &session.id)
        .await
        .unwrap();
    let adapter = state.connected(&session.id).await.unwrap().adapter.clone();
    let prefix = format!("dbfolio_qa_{}", uuid::Uuid::new_v4().simple());
    let source = format!("{prefix}_s");
    let target = format!("{prefix}_t");
    let split_target = format!("{prefix}_z");
    let dir = tempfile::tempdir().unwrap();
    let test_user = format!("dbfqa_{}", &uuid::Uuid::new_v4().simple().to_string()[..16]);
    for db in [&source, &target, &split_target] {
        adapter
            .execute_statements(
                "mysql",
                &[format!(
                    "CREATE DATABASE `{db}` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
                )],
            )
            .await
            .unwrap();
    }
    let outcome=std::panic::AssertUnwindSafe(Box::pin(async {
        let report=import(&state,&session.id,&source,dir.path(),"/* header */\nCREATE TABLE items(id BIGINT UNSIGNED PRIMARY KEY, amount DECIMAL(38,9), txt LONGTEXT, bytes VARBINARY(32), stamp DATETIME(6), doubled DECIMAL(39,9) GENERATED ALWAYS AS (amount*2) STORED);\nCREATE TABLE audit(id BIGINT UNSIGNED, note VARCHAR(80));\nINSERT INTO items(id,amount,txt,bytes,stamp) VALUES(18446744073709551614,12345678901234567890123456789.123456789,'中文; quote\\\' backslash\\\\',X'00FF0102','2026-09-26 12:34:56.123456');",false).await?;
        assert_eq!(report.failed,0,"{:?}",report.error);assert_eq!(report.executed,3);
        let mut conn=adapter.mysql_connection(&source,true).await?;
        println!("MySQL {}：隔离库 {}",sqlx::query_scalar::<_,String>("SELECT VERSION()").fetch_one(&mut conn).await?,source);
        let defs=[
            (objects::Kind::Function,"f","CREATE FUNCTION f(n INT) RETURNS INT DETERMINISTIC NO SQL RETURN n+1"),
            (objects::Kind::Procedure,"p","CREATE PROCEDURE p(IN n INT, OUT answer INT) BEGIN SELECT n AS first_result; SELECT n+1 AS second_result; SET answer=n+2; END"),
            (objects::Kind::View,"v","CREATE VIEW v AS SELECT id,amount,f(1) AS calculated FROM items"),
            (objects::Kind::View,"v_child","CREATE VIEW v_child AS SELECT * FROM v"),
            (objects::Kind::Trigger,"tr","CREATE TRIGGER tr AFTER INSERT ON items FOR EACH ROW BEGIN INSERT INTO audit VALUES(NEW.id,'trigger'); END"),
            (objects::Kind::Event,"ev","CREATE EVENT ev ON SCHEDULE EVERY 1 DAY DISABLE DO INSERT INTO audit VALUES(0,'event')"),
        ];
        for (kind,name,sql) in &defs { println!("CRUD {:?} {}",kind,name);
            objects::apply(&state,objects::Change{session_id:session.id.clone(),database:source.clone(),kind:kind.clone(),name:(*name).into(),sql:Some((*sql).into()),original:None,confirmed:true}).await?;
            let d=objects::definition(&mut conn,&source,kind,name).await?;
            objects::apply(&state,objects::Change{session_id:session.id.clone(),database:source.clone(),kind:kind.clone(),name:(*name).into(),sql:Some(d.sql.clone()),original:Some(d.sql),confirmed:true}).await?;
        }
        assert_eq!(objects::catalog(&mut conn,&source).await?.objects.len(),6);
        println!("调用过程与多结果"); let call=objects::call(&state,objects::Call{session_id:session.id.clone(),database:source.clone(),name:"p".into(),values:vec![Some("7".into()),None],confirmed:true}).await?;
        assert_eq!(call.results.iter().filter(|r|!r.rows.is_empty()).count(),3);assert_eq!(serde_json::to_value(&call.results.last().unwrap().rows[0][0]).unwrap(),json!(["int",9]));
        println!("定义语法失败保护"); let bad=objects::apply(&state,objects::Change{session_id:session.id.clone(),database:source.clone(),kind:objects::Kind::View,name:"v_child".into(),sql:Some("CREATE VIEW v_child AS SELECT FROM".into()),original:Some(objects::definition(&mut conn,&source,&objects::Kind::View,"v_child").await?.sql),confirmed:true}).await;assert!(bad.is_err());assert!(objects::definition(&mut conn,&source,&objects::Kind::View,"v_child").await.is_ok());
        let stale=objects::definition(&mut conn,&source,&objects::Kind::View,"v_child").await?.sql;
        conn.execute("CREATE OR REPLACE VIEW v_child AS SELECT * FROM v WHERE 1=1").await?;
        assert!(objects::apply(&state,objects::Change{session_id:session.id.clone(),database:source.clone(),kind:objects::Kind::View,name:"v_child".into(),sql:Some(stale.clone()),original:Some(stale),confirmed:true}).await.is_err());
        // More than the SQL editor's 2 MiB limit, without retaining an entire file in the importer.
        println!("大文件与导入策略"); let large=format!("INSERT INTO items(id,txt) VALUES(1,'{}');", "x".repeat(2*1024*1024+100));
        let r=import(&state,&session.id,&source,dir.path(),&large,false).await?;assert!(r.error.is_none(),"{:?}",r.error);
        // A frozen plan is immune to edits of the original input file.
        let file=dir.path().join("frozen.sql");std::fs::write(&file,"INSERT INTO audit VALUES(100,'snapshot');")?;
        let request=sql_import::Request{session_id:session.id.clone(),database:source.clone(),path:file.to_string_lossy().into(),encoding:"utf-8".into(),continue_on_error:false};let preview=sql_import::preview(&state,request.clone()).await?;
        std::fs::write(&file,"DROP TABLE items;")?;let r=sql_import::execute(&state,&session.id,&preview.id,true,dir.path().to_str().unwrap()).await?;assert!(r.error.is_none());assert!(sql_import::execute(&state,&session.id,&preview.id,true,dir.path().to_str().unwrap()).await.is_err());
        let r=import(&state,&session.id,&source,dir.path(),"INSERT INTO audit VALUES(101,'before');\nINSERT INTO missing VALUES(1);\nINSERT INTO audit VALUES(102,'after');",false).await?;assert_eq!(r.executed,1);assert_eq!(r.failed,1);assert_eq!(r.entries[1].line,2);
        let r=import(&state,&session.id,&source,dir.path(),"INSERT INTO missing VALUES(1);\nINSERT INTO audit VALUES(103,'continue');",true).await?;assert_eq!((r.executed,r.failed),(1,1));
        let (gbk,_,_)=encoding_rs::GBK.encode("INSERT INTO audit VALUES(104,'编码');");std::fs::write(&file,gbk)?;let mut request=request.clone();request.encoding="gbk".into();let p=sql_import::preview(&state,request).await?;assert!(sql_import::execute(&state,&session.id,&p.id,true,dir.path().to_str().unwrap()).await?.error.is_none());
        std::fs::write(&file,"SELECT SLEEP(0.3);INSERT INTO audit VALUES(999,'cancelled');")?;let p=sql_import::preview(&state,sql_import::Request{session_id:session.id.clone(),database:source.clone(),path:file.to_string_lossy().into(),encoding:"utf-8".into(),continue_on_error:false}).await?;
        let task=uuid::Uuid::new_v4().to_string();state.tasks.begin(task.clone())?;
        let (cancel_result,_)=tokio::join!(state.tasks.scope(Some(task.clone()),sql_import::execute(&state,&session.id,&p.id,true,dir.path().to_str().unwrap())),async {tokio::time::sleep(Duration::from_millis(100)).await;state.tasks.cancel(&task).unwrap();});
        assert!(cancel_result?.cancelled);let count:i64=sqlx::query_scalar("SELECT COUNT(*) FROM audit WHERE id=999").fetch_one(&mut conn).await?;assert_eq!(count,0);
        // Interrupt exactly the importer's connection in this newly-created database.
        println!("断线结果与事务停止策略");
        std::fs::write(&file,"SELECT SLEEP(5);INSERT INTO audit VALUES(998,'must not run');")?;
        let p=sql_import::preview(&state,sql_import::Request{session_id:session.id.clone(),database:source.clone(),path:file.to_string_lossy().into(),encoding:"utf-8".into(),continue_on_error:true}).await?;
        let (interrupted,killed)=tokio::join!(sql_import::execute(&state,&session.id,&p.id,true,dir.path().to_str().unwrap()),async {
            for _ in 0..100 {let rows=sqlx::query("SELECT ID FROM information_schema.PROCESSLIST WHERE DB=? AND INFO='SELECT SLEEP(5)'").bind(&source).fetch_all(&mut conn).await?;if let Some(row)=rows.first(){let id:u64=row.try_get("ID")?;conn.execute(format!("KILL CONNECTION {id}").as_str()).await?;return Ok::<bool,crate::error::AppError>(true);}tokio::time::sleep(Duration::from_millis(20)).await;}Ok(false)
        });assert!(killed?);let interrupted=interrupted?;assert!(interrupted.uncertain);assert_eq!(interrupted.executed,0);assert!(std::fs::read_to_string(interrupted.report_path)?.contains("pending"));
        let r=import(&state,&session.id,&source,dir.path(),"START TRANSACTION; INSERT INTO audit VALUES(997,'rollback'); INSERT INTO missing VALUES(1); COMMIT;",true).await?;assert_eq!(r.executed,2);assert_eq!(r.failed,1);let count:i64=sqlx::query_scalar("SELECT COUNT(*) FROM audit WHERE id=997").fetch_one(&mut conn).await?;assert_eq!(count,0);
        println!("开始完整导出"); let request:sql_export::SqlExportRequest=serde_json::from_value(json!({"sessionId":session.id,"database":source,"tables":[],"allTables":true,"mode":"both","path":dir.path().join("complete.sql"),"splitFiles":false,"includeDatabase":true,"dropTables":false,"consistentSnapshot":true,"batchRows":500,"batchBytes":1048576,"filters":{},"objectKinds":["view","procedure","function","trigger","event"],"targetDatabase":target,"omitDefiner":true})).unwrap();
        let export=sql_export::export(&state,&request).await?;assert_eq!(export.objects,6);
        let p=sql_import::preview(&state,sql_import::Request{session_id:session.id.clone(),database:target.clone(),path:export.path.clone(),encoding:"utf-8".into(),continue_on_error:false}).await?;
        let r=sql_import::execute(&state,&session.id,&p.id,true,dir.path().to_str().unwrap()).await?;assert!(r.error.is_none(),"{:?}",r.error);
        let mut target_conn=adapter.mysql_connection(&target,true).await?;
        assert_eq!(objects::catalog(&mut target_conn,&target).await?.objects.len(),6);
        for table in ["items","audit"]{let sql=format!("SELECT * FROM `{table}` ORDER BY id");let a=adapter.query_page(&source,&sql,0,100,&QueryContext::new()).await?;let b=adapter.query_page(&target,&sql,0,100,&QueryContext::new()).await?;assert_eq!(serde_json::to_value(a.rows).unwrap(),serde_json::to_value(b.rows).unwrap());}
        for table in ["items","audit"] { let metadata="SELECT COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,EXTRA,COLUMN_KEY,COLUMN_COMMENT,CHARACTER_SET_NAME,COLLATION_NAME,GENERATION_EXPRESSION FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION"; let a=sqlx::query(metadata).bind(&source).bind(table).fetch_all(&mut conn).await?;let b=sqlx::query(metadata).bind(&target).bind(table).fetch_all(&mut target_conn).await?;let values=|rows:Vec<sqlx::mysql::MySqlRow>|rows.iter().map(|r|(0..r.len()).map(|i|crate::adapters::mysql::decode_cell(r,i)).collect::<Vec<_>>()).collect::<Vec<_>>();assert_eq!(serde_json::to_value(values(a)).unwrap(),serde_json::to_value(values(b)).unwrap());}
        let hashes="SELECT id,SHA2(txt,256) AS digest FROM items ORDER BY id";
        let a=conn.fetch_all(hashes).await?;let b=target_conn.fetch_all(hashes).await?;assert_eq!(a.iter().map(|r|objects::text(r,"digest")).collect::<Vec<_>>(),b.iter().map(|r|objects::text(r,"digest")).collect::<Vec<_>>());
        let value:i32=sqlx::query_scalar("SELECT calculated FROM v_child LIMIT 1").fetch_one(&mut target_conn).await?;assert_eq!(value,2);
        sqlx::query("INSERT INTO items(id,txt) VALUES(123,'trigger test')").execute(&mut target_conn).await?;let count:i64=sqlx::query_scalar("SELECT COUNT(*) FROM audit WHERE id=123").fetch_one(&mut target_conn).await?;assert_eq!(count,1);
        let mut zipped=request.clone();zipped.compressed=true;zipped.split_files=true;zipped.target_database=split_target.clone();zipped.path=dir.path().join("complete.zip").to_string_lossy().into();
        let zipped=sql_export::export(&state,&zipped).await?;let mut archive=zip::ZipArchive::new(std::fs::File::open(&zipped.path)?).unwrap();let extracted=dir.path().join("unzip");archive.extract(&extracted).unwrap();
        let mut files=std::fs::read_dir(&extracted)?.map(|e|e.unwrap().path()).filter(|p|p.extension().is_some_and(|e|e=="sql")).collect::<Vec<_>>();files.sort();
        for file in files{let p=sql_import::preview(&state,sql_import::Request{session_id:session.id.clone(),database:split_target.clone(),path:file.to_string_lossy().into(),encoding:"utf-8".into(),continue_on_error:false}).await?;let r=sql_import::execute(&state,&session.id,&p.id,true,dir.path().to_str().unwrap()).await?;assert!(r.error.is_none(),"{:?}",r.error);}
        // Cancellation cannot overwrite a previous export.
        let protected=dir.path().join("protected.sql");std::fs::write(&protected,"original")?;let mut cancelled=request.clone();cancelled.path=protected.to_string_lossy().into();let task=uuid::Uuid::new_v4().to_string();state.tasks.begin(task.clone())?;state.tasks.cancel(&task)?;assert!(state.tasks.scope(Some(task),sql_export::export(&state,&cancelled)).await.is_err());assert_eq!(std::fs::read_to_string(&protected)?,"original");
        let task=uuid::Uuid::new_v4().to_string();state.tasks.begin(task.clone())?;
        let (interrupted_export,_)=tokio::join!(state.tasks.scope(Some(task.clone()),sql_export::export(&state,&cancelled)),async {for _ in 0..1000{if state.tasks.snapshot(&task).is_some_and(|p|!p.message.is_empty()){state.tasks.cancel(&task).unwrap();break;}tokio::time::sleep(Duration::from_millis(1)).await;}});
        assert!(interrupted_export.is_err());assert_eq!(std::fs::read_to_string(&protected)?,"original");
        // Service-level read-only and allowlist checks use fresh local records, not only adapter state.
        let guarded=AppState::with_local(crate::store::LocalStore::initialize_in(dir.path().join("guard-store")).await?);
        for readonly in [true,false]{let input=serde_json::from_value(json!({"name":"验收隔离","engine":"mysql","host":"127.0.0.1","readOnly":readonly,"allowedDatabases":[source]})).unwrap();let record=guarded.local.create_session(&input).await?;guarded.connections.lock().await.insert(record.id.clone(),Arc::new(ConnectedSession{adapter:adapter.clone(),key_value:None,mongo:None,server_version:"test".into()}));
            std::fs::write(&file,format!("USE `{target}`;"))?;assert!(sql_import::preview(&guarded,sql_import::Request{session_id:record.id.clone(),database:source.clone(),path:file.to_string_lossy().into(),encoding:"utf-8".into(),continue_on_error:false}).await.is_err());
            assert!(objects::apply(&guarded,objects::Change{session_id:record.id.clone(),database:source.clone(),kind:objects::Kind::Procedure,name:"blocked".into(),sql:Some("CREATE PROCEDURE blocked() SELECT 1".into()),original:None,confirmed:true}).await.is_err());
        }
        println!("服务器权限不足与依赖错误");
        let password=uuid::Uuid::new_v4().simple().to_string();
        conn.execute(format!("CREATE USER '{test_user}'@'localhost' IDENTIFIED BY '{password}'").as_str()).await?;
        conn.execute(format!("GRANT SELECT ON `{source}`.* TO '{test_user}'@'localhost'").as_str()).await?;
        let input=serde_json::from_value(json!({"name":"权限验收","engine":"mysql","host":"127.0.0.1","readOnly":false})).unwrap();let limited=guarded.local.create_session(&input).await?;
        let params=serde_json::from_value(json!({"engine":"mysql","host":"127.0.0.1","port":session.port,"username":test_user,"password":password,"database":source})).unwrap();
        let restricted=crate::adapters::mysql::MySqlAdapter::connect(&params).await?;guarded.connections.lock().await.insert(limited.id.clone(),Arc::new(ConnectedSession{adapter:Arc::new(restricted),key_value:None,mongo:None,server_version:"test".into()}));
        assert!(objects::apply(&guarded,objects::Change{session_id:limited.id.clone(),database:source.clone(),kind:objects::Kind::View,name:"denied".into(),sql:Some("CREATE VIEW denied AS SELECT 1".into()),original:None,confirmed:true}).await.is_err());
        assert!(objects::apply(&state,objects::Change{session_id:session.id.clone(),database:source.clone(),kind:objects::Kind::View,name:"bad_dep".into(),sql:Some("CREATE VIEW bad_dep AS SELECT * FROM missing_table".into()),original:None,confirmed:true}).await.is_err());
        guarded.disconnect(&limited.id).await;
        // Deletion of all supported types, in reverse dependency order.
        for (kind,name,_) in defs.iter().rev(){let old=objects::definition(&mut target_conn,&target,kind,name).await?;objects::apply(&state,objects::Change{session_id:session.id.clone(),database:target.clone(),kind:kind.clone(),name:(*name).into(),sql:None,original:Some(old.sql),confirmed:true}).await?;}
        assert!(objects::catalog(&mut target_conn,&target).await?.objects.is_empty());
        target_conn.close().await?;conn.close().await?;Ok::<(),crate::error::AppError>(())
    })).catch_unwind().await;
    for db in [&source, &target, &split_target] {
        adapter
            .execute_statements("mysql", &[format!("DROP DATABASE `{db}`")])
            .await
            .unwrap();
    }
    adapter
        .execute_statements(
            "mysql",
            &[format!("DROP USER IF EXISTS '{test_user}'@'localhost'")],
        )
        .await
        .unwrap();
    state.disconnect(&session.id).await;
    outcome.unwrap().unwrap();
    println!("R01–R03：大文件、编码、错误、取消、冻结计划、五类对象、过程多结果、单文件/ZIP 拆分往返、精度与触发器行为、只读/范围、删除及原文件保护通过；隔离库已清理");
}
