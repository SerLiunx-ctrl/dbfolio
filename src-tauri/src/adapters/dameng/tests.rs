use super::*;
use crate::adapters::{build_change_statements, CellChange, CellValue, RowChange};
use crate::services::{
    create_table::{self, DraftColumn, TableDraft},
    ddl::{ColumnFlags, TableOptions},
};

#[test]
fn exact_values_and_readonly_types() {
    assert_eq!(
        decode(&Value::BigInt(9007199254740993), false),
        DbValue::Int(9007199254740993)
    );
    let dec = "12345678901234567890.123456789";
    assert_eq!(
        decode(&parameter(&DbValue::Decimal(dec.into())).unwrap(), false),
        DbValue::Decimal(dec.into())
    );
    for value in [
        DbValue::Date("2026-11-11".into()),
        DbValue::Time("12:34:56.123456".into()),
        DbValue::DateTime("2026-11-11 12:34:56.123456".into()),
        DbValue::Bytes(vec![0, 127, 128, 255]),
    ] {
        assert_eq!(decode(&parameter(&value).unwrap(), false), value);
    }
    assert!(parameter(&DbValue::Float(f64::NAN)).is_err());
    assert!(parameter(&DbValue::Truncated("…".into())).is_err());
    assert!(matches!(
        decode(&Value::Double(f64::INFINITY), false),
        DbValue::ReadOnly(_)
    ));
    assert_eq!(ident("A\"B"), "\"A\"\"B\"");
}

fn params(password: String) -> ConnectionParams {
    serde_json::from_value(serde_json::json!({"engine":"dameng","host":"127.0.0.1","port":15236,"username":"SYSDBA","password":password,"database":null,"filePath":null,"sslMode":null,"connectTimeoutSecs":10,"redisDb":null,"tls":null,"authSource":null})).unwrap()
}
fn col(name: &str, ty: &str) -> DraftColumn {
    DraftColumn {
        name: name.into(),
        data_type: ty.into(),
        nullable: true,
        primary_key: false,
        auto_increment: false,
        unsigned: false,
        default_mode: "none".into(),
        default_value: String::new(),
        comment: String::new(),
        on_update: String::new(),
    }
}
async fn scalar(a: &DamengAdapter, schema: &str, sql: &str) -> AppResult<DbValue> {
    a.fetch_full_value(schema, sql)
        .await?
        .ok_or_else(|| AppError::Internal("缺少测试结果".into()))
}

/// Requires an explicitly supplied local test password; creates and cleans only a unique owned schema.
#[tokio::test]
#[ignore = "设置 DBFOLIO_TEST_DM_PASSWORD 后在本机 DM8 执行"]
async fn local_dm8_roundtrip() -> AppResult<()> {
    let password = std::env::var("DBFOLIO_TEST_DM_PASSWORD")
        .map_err(|_| AppError::InvalidInput("缺少本机验收密码环境变量".into()))?;
    let a = DamengAdapter::connect(&params(password)).await?;
    let schema = format!(
        "DBFOLIO_DM58_{}",
        &uuid::Uuid::new_v4().simple().to_string()[..12]
    );
    a.execute_statements("", &[format!("CREATE SCHEMA {}", ident(&schema))])
        .await?;
    let target = format!("{}.\"items\"", ident(&schema));
    let result:AppResult<()>=async {
        let mut id=col("id","bigint");id.primary_key=true;id.auto_increment=true;id.nullable=false;id.comment="自增主键".into();
        let mut title=col("title","varchar(128)");title.comment="中文标题".into();
        let draft=TableDraft{schema:Some(schema.clone()),table:"items".into(),columns:vec![id,title,col("precise","decimal(38,9)"),col("large_id","bigint"),col("flag","bit"),col("day","date"),col("clock","time(6)"),col("stamp","timestamp(6)"),col("binary_data","blob"),col("content","clob")],indexes:vec![],foreign_keys:vec![],options:TableOptions{comment:Some("达梦验收表".into()),..Default::default()}};
        let rendered=create_table::render(Engine::Dameng,&schema,&draft)?;a.execute_statements(&schema,&rendered).await?;
        let meta=a.introspect_table(&schema,Some(&schema),"items").await?;
        if !meta.columns[0].auto_increment||meta.primary_key!=["id"]||meta.comment.as_deref()!=Some("达梦验收表")||meta.columns[1].comment.as_deref()!=Some("中文标题") {return Err(AppError::Internal(format!("表元数据不一致：{meta:?}")));}
        println!("PASS create / identity / primary key / comments / DDL={}",meta.raw_ddl.is_some());
        let values=vec![("title",DbValue::Text("中文 ' 引号".into())),("precise",DbValue::Decimal("12345678901234567890.123456789".into())),("large_id",DbValue::Int(9007199254740993)),("flag",DbValue::Bool(true)),("day",DbValue::Date("2026-11-11".into())),("clock",DbValue::Time("12:34:56.123456".into())),("stamp",DbValue::DateTime("2026-11-11 12:34:56.123456".into())),("binary_data",DbValue::Bytes(vec![0,127,128,255])),("content",DbValue::Text("完整大文本".repeat(1000)))];
        let insert=RowChange::Insert{values:values.iter().map(|(n,v)|CellValue{column:(*n).into(),value:v.clone()}).collect()};
        let types=std::collections::HashMap::new();
        a.execute_grid_transaction(&schema,&build_change_statements(&a,&schema,None,"items",&[insert],&types)?).await?;
        for (name,value) in &values {let actual=scalar(&a,&schema,&format!("SELECT {} FROM {target}",ident(name))).await?;if &actual!=value && !(*name=="flag"&&actual==DbValue::Int(1)){return Err(AppError::Internal(format!("字段 {name} 往返不一致：{actual:?}")));}}
        println!("PASS parameterized insert / exact integer+decimal / BIT / date+time / binary / CLOB");
        a.execute_transaction(&schema,&[SqlParams{sql:format!("UPDATE {target} SET \"day\"=?,\"clock\"=?,\"stamp\"=? WHERE \"id\"=1"),params:values[4..7].iter().map(|(_,v)|match v{DbValue::Date(s)|DbValue::Time(s)|DbValue::DateTime(s)=>DbValue::Text(s.clone()),_=>unreachable!()}).collect()}]).await?;
        for (name,value) in &values[4..7] {if scalar(&a,&schema,&format!("SELECT {} FROM {target}",ident(name))).await?!=*value{return Err(AppError::Internal("文本输入的时间类型未保真".into()));}}
        println!("PASS CSV-style temporal text uses server parameter metadata");
        let preview=a.query_page(&schema,&format!("SELECT DBMS_LOB.SUBSTR(\"binary_data\",257,1) AS B,SUBSTR(\"content\",1,1025) AS C FROM {target}"),0,1,&QueryContext::new()).await?;
        if preview.rows[0][0]!=values[7].1||!matches!(&preview.rows[0][1],DbValue::Truncated(_)){return Err(AppError::Internal("BLOB/CLOB 数据页预览不保真".into()));}
        println!("PASS binary-safe BLOB preview / truncated CLOB preview");
        let full=a.query_export_page(&schema,&format!("SELECT \"binary_data\",\"content\" FROM {target}"),0,1,&QueryContext::new()).await?;
        if full.rows[0]!=vec![values[7].1.clone(),values[8].1.clone()]{return Err(AppError::Internal("完整导出复用了截断预览".into()));}
        println!("PASS export reads full CLOB and binary values");
        let keys=vec![CellValue{column:"id".into(),value:DbValue::Int(1)}];
        let update=|old:DbValue,new:DbValue|RowChange::Update{keys:keys.clone(),changes:vec![CellChange{column:"title".into(),old_value:old,new_value:new}]};
        for change in [update(values[0].1.clone(),DbValue::Null),update(DbValue::Null,DbValue::Text("已修改".into()))]{a.execute_grid_transaction(&schema,&build_change_statements(&a,&schema,None,"items",&[change],&types)?).await?;}
        let conflict=vec![update(DbValue::Text("已修改".into()),DbValue::Text("必须回滚".into())),update(DbValue::Text("过期值".into()),DbValue::Null)];
        if a.execute_grid_transaction(&schema,&build_change_statements(&a,&schema,None,"items",&conflict,&types)?).await.is_ok()||scalar(&a,&schema,&format!("SELECT \"title\" FROM {target}")).await?!=DbValue::Text("已修改".into()){return Err(AppError::Internal("乐观锁冲突未回滚".into()));}
        println!("PASS NULL-safe update / conflict rollback");
        let change=ColumnFlags{name:"title".into(),new_name:Some("renamed".into()),data_type:Some("varchar(256)".into()),nullable:false,comment:Some("修改后的注释".into()),default_mode:Some("literal".into()),default_value:Some("默认中文".into()),unsigned:None,auto_increment:None,on_update:None};
        a.execute_statements(&schema,&crate::services::dameng_schema::columns(&a,&target,&meta,&[change])?).await?;
        a.execute_statements(&schema,&[format!("ALTER TABLE {target} ADD COLUMN \"added\" INT DEFAULT 7"),format!("CREATE INDEX \"idx_dm58\" ON {target}(\"renamed\" DESC)")]).await?;
        let changed=a.introspect_table(&schema,None,"items").await?;
        if changed.columns.iter().find(|c|c.name=="renamed").and_then(|c|c.comment.as_deref())!=Some("修改后的注释")||!changed.indexes.iter().any(|i|i.name=="idx_dm58"&&i.columns[0].desc){return Err(AppError::Internal("字段修改或索引元数据不一致".into()));}
        println!("PASS rename / modify type / NOT NULL / default / comment / add column / index");
        a.execute_statements(&schema,&[format!("CREATE TABLE {}.\"child\"(\"id\" BIGINT PRIMARY KEY,\"item_id\" BIGINT, CONSTRAINT \"fk_dm58\" FOREIGN KEY(\"item_id\") REFERENCES {target}(\"id\") ON DELETE CASCADE ON UPDATE CASCADE)",ident(&schema)),format!("CREATE VIEW {}.\"items_view\" AS SELECT \"id\",\"renamed\" FROM {target}",ident(&schema))]).await?;
        let child=a.introspect_table(&schema,None,"child").await?;
        if child.foreign_keys.len()!=1||child.foreign_keys[0].on_delete!="CASCADE"||child.foreign_keys[0].on_update!="CASCADE"{return Err(AppError::Internal(format!("外键元数据不一致：{:?}",child.foreign_keys)));}
        if !a.list_tables(&schema).await?.iter().any(|t|t.name=="items_view"&&t.kind==TableKind::View){return Err(AppError::Internal("未识别视图".into()));}
        println!("PASS foreign key / rules / view");
        let mut tx=a.begin_manual(&schema).await?;tx.run(&format!("UPDATE {target} SET \"added\"=8"),false,&QueryContext::new()).await?;tx.finish(false).await?;
        if scalar(&a,&schema,&format!("SELECT \"added\" FROM {target}")).await?!=DbValue::Int(7){return Err(AppError::Internal("手动回滚失败".into()));}
        let mut tx=a.begin_manual(&schema).await?;tx.run(&format!("UPDATE {target} SET \"added\"=9"),false,&QueryContext::new()).await?;tx.finish(true).await?;
        if scalar(&a,&schema,&format!("SELECT \"added\" FROM {target}")).await?!=DbValue::Int(9){return Err(AppError::Internal("手动提交失败".into()));}
        let ctx=QueryContext::new();let rows=a.query_page(&schema,&format!("SELECT * FROM (SELECT * FROM {target}) AS _dw_sub LIMIT 1 OFFSET 0"),0,1,&ctx).await?;if rows.rows.len()!=1||ctx.conn_id.lock().await.is_none(){return Err(AppError::Internal("分页或取消上下文缺失".into()));}
        let cancelled=QueryContext::new();cancelled.cancel();if !matches!(a.query_page(&schema,"SELECT 1 FROM DUAL",0,1,&cancelled).await,Err(AppError::Cancelled(_))){return Err(AppError::Internal("取消未生效".into()));}a.ping().await?;
        let running=QueryContext::new();let stop=running.clone();let trigger=tokio::spawn(async move{tokio::time::sleep(Duration::from_millis(100)).await;stop.cancel();});
        let cancelled=tokio::time::timeout(Duration::from_secs(3),a.query_page(&schema,"SELECT SUM(SIN(LEVEL)) FROM DUAL CONNECT BY LEVEL<=100000000",0,1,&running)).await;
        trigger.await.unwrap();if !matches!(cancelled,Ok(Err(AppError::Cancelled(_)))) {return Err(AppError::Internal(format!("运行中查询取消失败：{cancelled:?}")));}a.ping().await?;
        let mut readonly_params=params(a.options.password.clone());readonly_params.read_only=true;let ro=DamengAdapter::connect(&readonly_params).await?;
        if !matches!(ro.execute_affected(&schema,&format!("DELETE FROM {target}")).await,Err(AppError::ReadOnly(_)))||!matches!(ro.execute_statements(&schema,&[format!("DROP TABLE {target}")]).await,Err(AppError::ReadOnly(_))){return Err(AppError::Internal("只读保护失败".into()));}
        a.execute_grid_transaction(&schema,&build_change_statements(&a,&schema,None,"items",&[RowChange::Delete{keys}],&types)?).await?;
        if scalar(&a,&schema,&format!("SELECT COUNT(*) FROM {target}")).await?!=DbValue::Int(0){return Err(AppError::Internal("删除未生效".into()));}
        println!("PASS manual commit+rollback / pagination / cancel / delete");Ok(())
    }.await;
    // The generated identifier is local and owned by this test, never supplied by the user.
    assert!(schema.starts_with("DBFOLIO_DM58_") && schema.len() < 40);
    let cleanup = a
        .execute_statements("", &[format!("DROP SCHEMA {} CASCADE", ident(&schema))])
        .await;
    println!("CLEANUP {}", if cleanup.is_ok() { "PASS" } else { "FAIL" });
    result?;
    cleanup
}
