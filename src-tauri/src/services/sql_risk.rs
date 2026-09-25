use crate::meta::Engine;
use sqlparser::{ast::{Statement, Expr, Value, BinaryOperator}, dialect::{Dialect,MySqlDialect,PostgreSqlDialect,SQLiteDialect},parser::Parser};

fn always_true(expr:&Expr)->bool{
    match expr {
        Expr::Nested(inner)=>always_true(inner),
        Expr::Value(v)=>matches!(v.value,Value::Boolean(true)),
        Expr::BinaryOp{left,op:BinaryOperator::Or,right}=>always_true(left)||always_true(right),
        Expr::BinaryOp{left,op:BinaryOperator::Eq,right}=>match (&**left,&**right){
            (Expr::Value(a),Expr::Value(b))=>a.value==b.value&&!matches!(a.value,Value::Null),
            _=>false,
        },
        _=>false,
    }
}

pub fn danger_reason(engine:Engine,sql:&str)->Option<String>{
    let dialect:Box<dyn Dialect>=match engine {Engine::Mysql=>Box::new(MySqlDialect{}),Engine::Postgres=>Box::new(PostgreSqlDialect{}),_=>Box::new(SQLiteDialect{})};
    // 可执行注释中的内容不能作为普通注释忽略。
    if engine==Engine::Mysql&&sql.contains("/*!"){return Some("高风险：SQL 包含 MySQL 可执行注释，请确认其中的实际操作".into());}
    let statements=match Parser::parse_sql(dialect.as_ref(),sql){
        Ok(items)=>items,
        Err(_)=>return Some("需核对：无法完整解析该 SQL，不能可靠判断影响范围，请检查语句后确认执行".into()),
    };
    for statement in statements {
        let (action,selection)=match &statement {
            Statement::Update{selection,..}=>("UPDATE",Some(selection)),
            Statement::Delete(delete)=>("DELETE",Some(&delete.selection)),
            Statement::Drop{..}=>return Some("高风险：DROP 会删除数据库对象及其相关数据，请核对目标对象和备份".into()),
            Statement::Truncate{..}=>return Some("高风险：TRUNCATE 将清空目标表的数据".into()),
            _=>("",None),
        };
        if let Some(selection)=selection {
            match selection {
                None=>return Some(format!("高风险：{action} 的外层语句没有 WHERE 条件，可能影响整张表")),
                Some(expr) if always_true(expr)=>return Some(format!("高风险：{action} 的 WHERE 条件恒为真，可能影响整张表")),
                _=>{},
            }
        }
        // CTE 中的写入也必须提示，不能把外层 SELECT 当作普通读取。
        if matches!(statement,Statement::Query(_)) {
            let rendered=statement.to_string();
            if let Ok((_,words))=super::explain::scan_sql(engine,&rendered){
                if words.split_whitespace().any(|w|["UPDATE","DELETE","INSERT","MERGE"].contains(&w.to_ascii_uppercase().as_str())){
                    return Some("需核对：查询包含嵌套写入操作，请检查 CTE 内的修改范围".into());
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]fn write_scope(){
        for engine in [Engine::Mysql,Engine::Postgres,Engine::Sqlite] {
            for sql in ["UPDATE t SET name='WHERE'","DELETE FROM t /* WHERE id=1 */","UPDATE t SET n=(SELECT n FROM other WHERE id=1)","DELETE FROM t WHERE 1=1","DELETE FROM t WHERE id=1 OR TRUE","DROP TABLE t","TRUNCATE TABLE t"]{
                assert!(danger_reason(engine,sql).is_some(),"{sql}");
            }
            for sql in ["SELECT 'DROP TABLE t'","UPDATE t SET n=2 WHERE id=1","DELETE FROM t WHERE id IN (SELECT id FROM other WHERE n=1)"]{
                assert!(danger_reason(engine,sql).is_none(),"{sql}");
            }
        }
        assert!(danger_reason(Engine::Mysql,"SELECT 1; DELETE FROM t").is_some());
        assert!(danger_reason(Engine::Mysql,"/*!50000 DELETE FROM t */").is_some());
    }
}
#[cfg(test)]
mod integration {
    use super::*;
    use crate::{state::AppState,store::LocalStore,services::{query,session,manual_transaction},error::AppError};
    use serde_json::json;
    #[tokio::test]
    async fn risk_blocks_before_execution(){
        let dir=tempfile::tempdir().unwrap();
        let path=dir.path().join("risk.sqlite");std::fs::File::create(&path).unwrap();
        let state=AppState::with_local(LocalStore::initialize_in(dir.path().join("config")).await.unwrap());
        let input=serde_json::from_value(json!({"name":"风险测试","engine":"sqlite","filePath":path.to_str().unwrap(),"readOnly":false})).unwrap();
        let record=state.local.create_session(&input).await.unwrap();
        session::connect(&state,&record.id).await.unwrap();
        let adapter=state.connected(&record.id).await.unwrap().adapter.clone();
        adapter.execute_affected("main","CREATE TABLE t(id INTEGER PRIMARY KEY,value TEXT)").await.unwrap();
        adapter.execute_affected("main","INSERT INTO t VALUES(1,'original')").await.unwrap();
        for sql in ["UPDATE t SET value='WHERE'","DELETE FROM t /* WHERE id=1 */","UPDATE t SET value=(SELECT value FROM t WHERE id=1)","DELETE FROM t WHERE 1=1"]{
            assert!(matches!(query::execute(&state,query::ExecuteOptions{session_id:record.id.clone(),database:"main".into(),sql:sql.into(),force:false,limit:None,sort:vec![]}).await,Err(AppError::Dangerous(_))));
            assert!(matches!(manual_transaction::validate(Engine::Sqlite,sql,false),Err(AppError::Dangerous(_))));
            assert!(manual_transaction::validate(Engine::Sqlite,sql,true).is_ok());
        }
        let result=adapter.query_page("main","SELECT * FROM t",0,200,&crate::adapters::QueryContext::new()).await.unwrap();
        assert_eq!(result.rows.len(),1);
        assert!(query::execute(&state,query::ExecuteOptions{session_id:record.id.clone(),database:"main".into(),sql:"DELETE FROM t".into(),force:true,limit:None,sort:vec![]}).await.is_ok());
        let result=adapter.query_page("main","SELECT * FROM t",0,200,&crate::adapters::QueryContext::new()).await.unwrap();
        assert!(result.rows.is_empty());
        state.disconnect(&record.id).await;
    }
}
