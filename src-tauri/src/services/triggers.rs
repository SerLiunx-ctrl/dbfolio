//! 跨关系型数据库的触发器管理：结构化生成、预览确认及原定义乐观校验。
pub use super::triggers_model::TriggerDraft;
use crate::{
    adapters::{DbAdapter, QueryContext, SqlParams},
    error::{AppError, AppResult},
    meta::{value::DbValue, Engine, TableKind},
    state::{AppState, ConnectedSession},
};
use serde::{Deserialize, Serialize};
use sqlx::{Connection, Executor, MySqlConnection};
use std::sync::Arc;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerItem {
    pub name: String,
    pub schema: Option<String>,
    pub table: String,
    pub timing: String,
    pub event: String,
    pub enabled: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerFunction {
    pub schema: String,
    pub name: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub name: String,
    pub schema: Option<String>,
    pub kind: TableKind,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub items: Vec<TriggerItem>,
    pub functions: Vec<TriggerFunction>,
    pub targets: Vec<Target>,
    pub engine: Engine,
    pub version: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Definition {
    pub sql: String,
    pub draft: Option<TriggerDraft>,
    pub warning: String,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Change {
    pub session_id: String,
    pub database: String,
    pub table: String,
    pub schema: Option<String>,
    pub name: String,
    pub draft: Option<TriggerDraft>,
    pub original: Option<String>,
    pub confirmed: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub statements: Vec<String>,
    pub warning: String,
}
fn invalid(s: impl Into<String>) -> AppError {
    AppError::InvalidInput(s.into())
}
fn quote(engine: Engine, s: &str) -> String {
    if engine == Engine::Mysql {
        super::mysql_objects::ident(s)
    } else {
        format!("\"{}\"", s.replace('"', "\"\""))
    }
}
fn literal(engine: Engine, s: &str) -> String {
    if engine == Engine::Postgres {
        format!("E'{}'", s.replace('\\', "\\\\").replace('\'', "''"))
    } else {
        crate::adapters::render_literal(engine, &DbValue::Text(s.into()))
    }
}
fn text(row: &[DbValue], i: usize) -> String {
    match row.get(i) {
        Some(
            DbValue::Text(s)
            | DbValue::ReadOnly(s)
            | DbValue::Decimal(s)
            | DbValue::DateTime(s)
            | DbValue::Uuid(s),
        ) => s.clone(),
        Some(DbValue::Bytes(b)) => String::from_utf8_lossy(b).into_owned(),
        Some(DbValue::Int(n)) => n.to_string(),
        Some(DbValue::UInt(n)) => n.to_string(),
        _ => String::new(),
    }
}
async fn rows(adapter: &dyn DbAdapter, db: &str, sql: &str) -> AppResult<Vec<Vec<DbValue>>> {
    Ok(adapter
        .query_page(db, sql, 0, u32::MAX, &QueryContext::new())
        .await?
        .rows)
}
async fn connection(state: &AppState, id: &str, db: &str) -> AppResult<Arc<ConnectedSession>> {
    if db.is_empty() || db.len() > 1024 || db.contains('\0') {
        return Err(invalid("数据库名称无效"));
    }
    let record = state.local.get_session(id).await?;
    super::database_access::check(record.allowed_databases.as_deref(), db)?;
    let c = state.connected(id).await?;
    if !c.adapter.engine().is_sql() {
        return Err(invalid("触发器仅支持 MySQL/MariaDB、PostgreSQL、SQLite"));
    }
    if c.adapter.engine() == Engine::Sqlite && db != "main" {
        return Err(invalid("SQLite 触发器管理只支持当前文件的 main 数据库"));
    }
    Ok(c)
}
async fn targets(adapter: &dyn DbAdapter, db: &str) -> AppResult<Vec<Target>> {
    match adapter.engine(){
  Engine::Mysql=>Ok(adapter.list_tables(db).await?.into_iter().filter(|t|t.kind==TableKind::Table).map(|t|Target{name:t.name,schema:None,kind:t.kind}).collect()),
  Engine::Postgres=>Ok(rows(adapter,db,"SELECT c.relname,n.nspname,CASE WHEN c.relkind='v' THEN 'view' ELSE 'table' END FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p','v') AND left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema' ORDER BY n.nspname,c.relname").await?.iter().map(|r|Target{name:text(r,0),schema:Some(text(r,1)),kind:if text(r,2)=="view"{TableKind::View}else{TableKind::Table}}).collect()),
  Engine::Sqlite=>Ok(rows(adapter,db,"SELECT s.name,s.type,s.sql FROM main.sqlite_schema s JOIN pragma_table_list l ON l.schema='main' AND l.name=s.name WHERE s.type IN ('table','view') AND l.type IN ('table','view') AND substr(s.name,1,7)<>'sqlite_' ORDER BY s.type,s.name").await?.into_iter().filter(|r|!text(r,2).to_ascii_uppercase().starts_with("CREATE VIRTUAL TABLE")).map(|r|Target{name:text(&r,0),schema:None,kind:if text(&r,1)=="view"{TableKind::View}else{TableKind::Table}}).collect()),
  _=>Err(invalid("该数据库没有触发器目录"))
 }
}
async fn mysql_items(conn: &mut MySqlConnection, db: &str) -> AppResult<Vec<TriggerItem>> {
    use sqlx::Row;
    Ok(sqlx::query("SELECT TRIGGER_NAME,EVENT_OBJECT_TABLE,ACTION_TIMING,EVENT_MANIPULATION FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=? ORDER BY EVENT_OBJECT_TABLE,TRIGGER_NAME").bind(db).fetch_all(&mut *conn).await?.iter().map(|r|TriggerItem{name:super::mysql_objects::text(r,"TRIGGER_NAME"),schema:None,table:r.try_get::<String,_>("EVENT_OBJECT_TABLE").unwrap_or_default(),timing:super::mysql_objects::text(r,"ACTION_TIMING"),event:super::mysql_objects::text(r,"EVENT_MANIPULATION"),enabled:None}).collect())
}
const PG_ITEMS:&str="SELECT t.tgname,n.nspname,c.relname,t.tgtype::text,t.tgenabled::text,pg_get_triggerdef(t.oid,true),t.tgnargs::text,t.tgconstraint::text,fn.nspname,p.proname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace fn ON fn.oid=p.pronamespace WHERE NOT t.tgisinternal AND left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema' ORDER BY n.nspname,c.relname,t.tgname";
fn pg_item(r: &[DbValue]) -> TriggerItem {
    let bits = text(r, 3).parse::<u32>().unwrap_or(0);
    TriggerItem {
        name: text(r, 0),
        schema: Some(text(r, 1)),
        table: text(r, 2),
        timing: if bits & 64 != 0 {
            "INSTEAD OF"
        } else if bits & 2 != 0 {
            "BEFORE"
        } else {
            "AFTER"
        }
        .into(),
        event: [
            (4, "INSERT"),
            (16, "UPDATE"),
            (8, "DELETE"),
            (32, "TRUNCATE"),
        ]
        .iter()
        .filter(|(b, _)| bits & b != 0)
        .map(|(_, s)| *s)
        .collect::<Vec<_>>()
        .join(" OR "),
        enabled: Some(text(r, 4)),
    }
}
async fn functions(adapter: &dyn DbAdapter, db: &str) -> AppResult<Vec<TriggerFunction>> {
    if adapter.engine() != Engine::Postgres {
        return Ok(vec![]);
    }
    Ok(rows(adapter,db,"SELECT n.nspname,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.prorettype='pg_catalog.trigger'::regtype AND p.pronargs=0 AND left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema' AND has_function_privilege(p.oid,'EXECUTE') ORDER BY n.nspname,p.proname").await?.iter().map(|r|TriggerFunction{schema:text(r,0),name:text(r,1)}).collect())
}
pub async fn catalog(state: &AppState, id: &str, db: &str) -> AppResult<Catalog> {
    let c = connection(state, id, db).await?;
    let a = c.adapter.as_ref();
    let engine = a.engine();
    let items=match engine{
  Engine::Mysql=>{let mut conn=super::mysql_objects::connect(state,id,db,false).await?;let result=mysql_items(&mut conn,db).await?;conn.close().await?;result},
  Engine::Postgres=>rows(a,db,PG_ITEMS).await?.iter().map(|r|pg_item(r)).collect(),
  Engine::Sqlite=>rows(a,db,"SELECT name,tbl_name,sql FROM main.sqlite_schema WHERE type='trigger' ORDER BY tbl_name,name").await?.iter().map(|r|{let (timing,event)=super::triggers_model::sqlite_summary(&text(r,2));TriggerItem{name:text(r,0),schema:None,table:text(r,1),timing,event,enabled:None}}).collect(),
  _=>return Err(invalid("该数据库没有触发器目录"))
 };
    Ok(Catalog {
        items,
        functions: functions(a, db).await?,
        targets: targets(a, db).await?,
        engine,
        version: c.server_version.clone(),
    })
}
async fn mysql_definition(
    conn: &mut MySqlConnection,
    db: &str,
    table: &str,
    name: &str,
) -> AppResult<(Definition, super::mysql_objects::Definition)> {
    let all = mysql_items(conn, db).await?;
    let item = all
        .iter()
        .find(|t| t.name == name && t.table == table)
        .ok_or_else(|| AppError::NotFound("目标表的触发器不存在，请刷新目录".into()))?;
    let original =
        super::mysql_objects::definition(conn, db, &super::mysql_objects::Kind::Trigger, name)
            .await?;
    let body:Option<String>=sqlx::query_scalar("SELECT ACTION_STATEMENT FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=? AND TRIGGER_NAME=? AND EVENT_OBJECT_TABLE=?").bind(db).bind(name).bind(table).fetch_optional(&mut *conn).await?.flatten();
    let mut draft = None;
    let mut warning = String::new();
    if all
        .iter()
        .filter(|t| t.table == table && t.timing == item.timing && t.event == item.event)
        .count()
        > 1
    {
        warning =
            "同一时机/事件存在多个触发器，替换可能改变执行顺序；此定义只读，可查看、复制或删除。"
                .into();
    } else if super::mysql_script::nonstandard_quotes(&original.sql_mode) {
        warning =
            "该定义使用特殊 SQL_MODE；为保留字符串与标识符语义，当前仅查看、复制或删除。".into();
    } else if !["utf8", "utf8mb3", "utf8mb4"]
        .contains(&original.charset.to_ascii_lowercase().as_str())
    {
        warning =
            "该定义使用非 UTF-8 客户端字符集，仅查看、复制或删除，避免替换时改变字符编码。".into();
    } else if let Some(mut body) = body {
        if super::triggers_model::validate_body("mysql", &body).is_err() {
            body = format!("BEGIN\n{}\n;\nEND", body.trim().trim_end_matches(';'));
        }
        let value = TriggerDraft {
            timing: item.timing.clone(),
            events: vec![item.event.clone()],
            orientation: "ROW".into(),
            body,
            function_schema: None,
            function_name: None,
        };
        if super::triggers_model::build("mysql", "", db, None, table, name, &value).is_ok() {
            draft = Some(value);
        } else {
            warning =
                "当前定义包含未适配的主体或事件语法，仅查看、复制或删除，避免丢失属性。".into();
        }
    } else {
        warning = "服务器未返回触发器主体，请检查 TRIGGER 权限；当前只读。".into();
    }
    Ok((
        Definition {
            sql: original.sql.clone(),
            draft,
            warning,
        },
        original,
    ))
}
pub async fn definition(
    state: &AppState,
    id: &str,
    db: &str,
    schema: Option<&str>,
    table: &str,
    name: &str,
) -> AppResult<Definition> {
    let c = connection(state, id, db).await?;
    let a = c.adapter.as_ref();
    super::triggers_model::validate_target(a.engine().as_str(), db, schema, table, name)
        .map_err(invalid)?;
    match a.engine() {
        Engine::Mysql => {
            let mut conn = super::mysql_objects::connect(state, id, db, false).await?;
            let (d, _) = mysql_definition(&mut conn, db, table, name).await?;
            conn.close().await?;
            Ok(d)
        }
        Engine::Sqlite => {
            let sql=rows(a,db,&format!("SELECT sql FROM main.sqlite_schema WHERE type='trigger' AND name={} AND tbl_name={}",literal(Engine::Sqlite,name),literal(Engine::Sqlite,table))).await?.first().map(|r|text(r,0)).filter(|s|!s.is_empty()).ok_or_else(||AppError::NotFound("目标表的触发器不存在，请刷新目录".into()))?;
            let draft = super::triggers_model::sqlite_draft(&sql);
            let warning = if draft.is_none() {
                "当前定义含 WHEN、UPDATE OF 等额外语法，只读展示以保留原属性；仍可复制或删除。"
            } else {
                ""
            }
            .into();
            Ok(Definition {
                sql,
                draft,
                warning,
            })
        }
        Engine::Postgres => {
            let data = rows(a, db, PG_ITEMS).await?;
            let row = data
                .iter()
                .find(|r| {
                    text(r, 0) == name
                        && text(r, 1) == schema.unwrap_or("public")
                        && text(r, 2) == table
                })
                .ok_or_else(|| {
                    AppError::NotFound("目标表/Schema 的触发器不存在，请刷新目录".into())
                })?;
            let item = pg_item(row);
            let sql = text(row, 5);
            let simple = text(row, 4) == "O"
                && text(row, 6) == "0"
                && text(row, 7) == "0"
                && !super::triggers_model::pg_complex(&sql);
            let draft = simple.then(|| TriggerDraft {
                timing: item.timing,
                events: item.event.split(" OR ").map(str::to_owned).collect(),
                orientation: if text(row, 3).parse::<u32>().unwrap_or(0) & 1 != 0 {
                    "ROW"
                } else {
                    "STATEMENT"
                }
                .into(),
                body: String::new(),
                function_schema: Some(text(row, 8)),
                function_name: Some(text(row, 9)),
            });
            let warning=if draft.is_none(){"该定义含停用/副本/始终状态、函数参数、WHEN、列过滤、约束或转换表等属性；仅查看、复制或删除，避免替换丢失属性。"}else{""}.into();
            Ok(Definition {
                sql,
                draft,
                warning,
            })
        }
        _ => Err(invalid("该数据库不支持触发器")),
    }
}
fn drop_sql(engine: Engine, r: &Change) -> String {
    if engine == Engine::Postgres {
        format!(
            "DROP TRIGGER {} ON {}.{}",
            quote(engine, &r.name),
            quote(engine, r.schema.as_deref().unwrap_or("public")),
            quote(engine, &r.table)
        )
    } else {
        format!(
            "DROP TRIGGER {}.{}",
            quote(
                engine,
                if engine == Engine::Sqlite {
                    "main"
                } else {
                    &r.database
                }
            ),
            quote(engine, &r.name)
        )
    }
}
async fn plan(state: &AppState, r: &Change) -> AppResult<Preview> {
    let c = connection(state, &r.session_id, &r.database).await?;
    let a = c.adapter.as_ref();
    let engine = a.engine();
    super::triggers_model::validate_target(
        engine.as_str(),
        &r.database,
        r.schema.as_deref(),
        &r.table,
        &r.name,
    )
    .map_err(invalid)?;
    let list = catalog(state, &r.session_id, &r.database).await?;
    let target = list
        .targets
        .iter()
        .find(|t| {
            t.name == r.table
                && (if engine == Engine::Postgres {
                    t.schema.as_deref().unwrap_or("public")
                        == r.schema.as_deref().unwrap_or("public")
                } else {
                    true
                })
        })
        .ok_or_else(|| invalid("目标不存在或不支持触发器（物化视图、虚拟表等不可用）"))?;
    let mut statements = vec![];
    let original = if let Some(expected) = &r.original {
        let d = definition(
            state,
            &r.session_id,
            &r.database,
            r.schema.as_deref(),
            &r.table,
            &r.name,
        )
        .await?;
        if d.sql != *expected {
            return Err(invalid("服务器触发器定义已变化，请刷新后重新编辑"));
        }
        if r.draft.is_some() && d.draft.is_none() {
            return Err(invalid(d.warning));
        }
        statements.push(drop_sql(engine, r));
        Some(d)
    } else {
        if r.draft.is_none() {
            return Err(invalid("删除触发器前必须读取原定义"));
        }
        if list.items.iter().any(|t| {
            t.name == r.name
                && (engine != Engine::Postgres
                    || (t.table == r.table
                        && t.schema.as_deref().unwrap_or("public")
                            == r.schema.as_deref().unwrap_or("public")))
        }) {
            return Err(invalid("同名触发器已存在，请从列表读取后编辑"));
        }
        None
    };
    if let Some(draft) = &r.draft {
        if draft.timing == "INSTEAD OF" && target.kind != TableKind::View {
            return Err(invalid("INSTEAD OF 触发器只能用于普通视图"));
        }
        if target.kind == TableKind::View
            && ((engine == Engine::Sqlite && draft.timing != "INSTEAD OF")
                || (engine == Engine::Postgres
                    && draft.orientation == "ROW"
                    && draft.timing != "INSTEAD OF"))
        {
            return Err(invalid("该视图的行级触发器必须使用 INSTEAD OF"));
        }
        if engine == Engine::Postgres
            && !list.functions.iter().any(|f| {
                Some(f.name.as_str()) == draft.function_name.as_deref()
                    && Some(f.schema.as_str()) == draft.function_schema.as_deref()
            })
        {
            return Err(invalid("请选择仍存在且可执行的无参 trigger 返回类型函数"));
        }
        let mut sql = super::triggers_model::build(
            engine.as_str(),
            &c.server_version,
            &r.database,
            r.schema.as_deref(),
            &r.table,
            &r.name,
            draft,
        )
        .map_err(invalid)?;
        if engine == Engine::Mysql {
            let mut conn =
                super::mysql_objects::connect(state, &r.session_id, &r.database, false).await?;
            let mode: String = sqlx::query_scalar("SELECT @@SQL_MODE")
                .fetch_one(&mut conn)
                .await?;
            conn.close().await?;
            if super::mysql_script::nonstandard_quotes(&mode) {
                return Err(invalid(
                    "触发器编辑暂不支持 NO_BACKSLASH_ESCAPES / ANSI_QUOTES 模式",
                ));
            }
            if let Some(original) = &original {
                let prefix = super::triggers_model::mysql_prefix(&original.sql)
                    .ok_or_else(|| invalid("无法安全保留原触发器的 DEFINER"))?;
                sql = format!(
                    "{}{}",
                    prefix,
                    sql.strip_prefix("CREATE ")
                        .ok_or_else(|| invalid("触发器生成失败"))?
                );
            }
        }
        statements.push(sql);
    }
    let record = state.local.get_session(&r.session_id).await?;
    if engine == Engine::Mysql {
        for sql in &statements {
            super::database_access::sql(record.allowed_databases.as_deref(), &r.database, sql)?;
        }
    }
    Ok(Preview{statements,warning:if engine==Engine::Mysql{"触发器 DDL 会隐式提交，先删除后创建无法整体回滚；创建失败时会尝试恢复已读取的原定义，仍需刷新核对。触发器主体可能间接读写其他表，实际权限由服务器控制。"}else{"修改触发器会影响后续数据写入；本次结构操作使用事务，提交状态不确定时需刷新核对，不会自动重试。触发器函数/主体的间接依赖由服务器权限控制。"}.into()})
}
pub async fn preview(state: &AppState, r: &Change) -> AppResult<Preview> {
    plan(state, r).await
}
pub async fn apply(state: &AppState, r: Change) -> AppResult<()> {
    let _lock = state.session_lock(&r.session_id).await;
    super::readonly::writable(state, &r.session_id).await?;
    if !r.confirmed {
        return Err(AppError::Dangerous("请预览触发器 SQL 并确认执行".into()));
    }
    let p = plan(state, &r).await?;
    let c = connection(state, &r.session_id, &r.database).await?;
    let a = c.adapter.as_ref();
    if a.engine() != Engine::Mysql {
        let items = p
            .statements
            .iter()
            .map(|sql| SqlParams {
                sql: sql.clone(),
                params: vec![],
            })
            .collect::<Vec<_>>();
        return a.execute_transaction(&r.database,&items).await.map(|_|()).map_err(|e|AppError::Message(format!("触发器操作未确认提交：{e}。普通执行错误会回滚；若连接或提交中断，请刷新核对，程序不会自动重试。")));
    }
    let mut conn = super::mysql_objects::connect(state, &r.session_id, &r.database, true).await?;
    let original = if let Some(expected) = &r.original {
        let (d, env) = mysql_definition(&mut conn, &r.database, &r.table, &r.name).await?;
        if d.sql != *expected {
            return Err(invalid("服务器触发器定义已变化，请刷新后重试"));
        }
        if r.draft.is_some() && d.draft.is_none() {
            return Err(invalid(d.warning));
        }
        Some(env)
    } else {
        None
    };
    if let Some(env) = original.as_ref().filter(|_| r.draft.is_some()) {
        for (variable, value) in [
            ("SQL_MODE", &env.sql_mode),
            ("CHARACTER_SET_CLIENT", &env.charset),
            ("COLLATION_CONNECTION", &env.collation),
        ] {
            if !value.is_empty() {
                sqlx::query(&format!("SET {variable}=?"))
                    .bind(value)
                    .execute(&mut conn)
                    .await?;
            }
        }
    }
    if r.draft.is_some() {
        let sql = p
            .statements
            .last()
            .ok_or_else(|| invalid("触发器 SQL 为空"))?;
        if let Err(e) = conn.prepare(sql).await {
            if !matches!(&e,sqlx::Error::Database(d) if d.try_downcast_ref::<sqlx::mysql::MySqlDatabaseError>().is_some_and(|d|d.number()==1295))
            {
                return Err(e.into());
            }
        }
    }
    if original.is_some() {
        conn.execute(p.statements[0].as_str()).await?;
    }
    if r.draft.is_some() {
        if let Err(error) = conn.execute(p.statements.last().unwrap().as_str()).await {
            let recovery = if let Some(old) = &original {
                match conn.execute(old.sql.as_str()).await{Ok(_)=>"已恢复原触发器定义；请刷新核对后再修改。".to_owned(),Err(e)=>format!("自动恢复也失败：{e}。原 SQL 仍保留在编辑器中，请核对服务器并手动恢复，勿重复提交。")}
            } else {
                "未确认创建成功；请刷新核对，不会自动重试。".into()
            };
            return Err(AppError::Message(format!(
                "创建触发器失败：{error}。{recovery}"
            )));
        }
    }
    conn.close().await?;
    Ok(())
}
