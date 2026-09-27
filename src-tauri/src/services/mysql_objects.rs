use super::mysql_script::words;
use crate::{
    adapters::{ColumnInfo, QueryOutcome},
    error::{AppError, AppResult},
    state::AppState,
};
use futures_util::TryStreamExt;
use serde::{Deserialize, Serialize};
use sqlx::{Column, Connection, Executor, MySqlConnection, Row, TypeInfo};
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    View,
    Procedure,
    Function,
    Trigger,
    Event,
}
impl Kind {
    pub fn sql(&self) -> &'static str {
        match self {
            Self::View => "VIEW",
            Self::Procedure => "PROCEDURE",
            Self::Function => "FUNCTION",
            Self::Trigger => "TRIGGER",
            Self::Event => "EVENT",
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Object {
    pub kind: Kind,
    pub name: String,
    pub parent: Option<String>,
    pub detail: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub objects: Vec<Object>,
    pub scheduler: String,
    pub version: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Parameter {
    pub name: String,
    pub mode: String,
    pub data_type: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Definition {
    pub sql: String,
    pub dependencies: Vec<String>,
    pub parameters: Vec<Parameter>,
    pub sql_mode: String,
    pub charset: String,
    pub collation: String,
}
pub fn ident(s: &str) -> String {
    format!("`{}`", s.replace('`', "``"))
}
pub fn text(row: &sqlx::mysql::MySqlRow, col: &str) -> String {
    row.try_get::<String, _>(col)
        .or_else(|_| {
            row.try_get::<Vec<u8>, _>(col)
                .map(|b| String::from_utf8_lossy(&b).into_owned())
        })
        .unwrap_or_default()
}
pub async fn catalog(conn: &mut MySqlConnection, db: &str) -> AppResult<Catalog> {
    let mut objects = vec![];
    for row in sqlx::query(
        "SELECT TABLE_NAME FROM information_schema.VIEWS WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME",
    )
    .bind(db)
    .fetch_all(&mut *conn)
    .await?
    {
        objects.push(Object {
            kind: Kind::View,
            name: text(&row, "TABLE_NAME"),
            parent: None,
            detail: "视图".into(),
        });
    }
    for row in sqlx::query("SELECT ROUTINE_NAME,ROUTINE_TYPE,SQL_DATA_ACCESS,SECURITY_TYPE FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=? ORDER BY ROUTINE_NAME").bind(db).fetch_all(&mut *conn).await? {objects.push(Object{kind:if text(&row,"ROUTINE_TYPE")=="PROCEDURE"{Kind::Procedure}else{Kind::Function},name:text(&row,"ROUTINE_NAME"),parent:None,detail:format!("{} · {}",text(&row,"SQL_DATA_ACCESS"),text(&row,"SECURITY_TYPE"))});}
    for row in sqlx::query("SELECT TRIGGER_NAME,EVENT_OBJECT_TABLE,ACTION_TIMING,EVENT_MANIPULATION FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=? ORDER BY EVENT_OBJECT_TABLE,ACTION_ORDER").bind(db).fetch_all(&mut *conn).await? {objects.push(Object{kind:Kind::Trigger,name:text(&row,"TRIGGER_NAME"),parent:Some(text(&row,"EVENT_OBJECT_TABLE")),detail:format!("{} {}",text(&row,"ACTION_TIMING"),text(&row,"EVENT_MANIPULATION"))});}
    for row in sqlx::query("SELECT EVENT_NAME,STATUS,EVENT_TYPE,CAST(EXECUTE_AT AS CHAR) AT_TIME,INTERVAL_VALUE,INTERVAL_FIELD FROM information_schema.EVENTS WHERE EVENT_SCHEMA=? ORDER BY EVENT_NAME").bind(db).fetch_all(&mut *conn).await? {objects.push(Object{kind:Kind::Event,name:text(&row,"EVENT_NAME"),parent:None,detail:format!("{} · {} {} {} {}",text(&row,"STATUS"),text(&row,"EVENT_TYPE"),text(&row,"AT_TIME"),text(&row,"INTERVAL_VALUE"),text(&row,"INTERVAL_FIELD"))});}
    let scheduler: String = sqlx::query_scalar("SELECT @@GLOBAL.event_scheduler")
        .fetch_one(&mut *conn)
        .await?;
    let version: String = sqlx::query_scalar("SELECT VERSION()")
        .fetch_one(&mut *conn)
        .await?;
    Ok(Catalog {
        objects,
        scheduler,
        version,
    })
}
pub async fn definition(
    conn: &mut MySqlConnection,
    db: &str,
    kind: &Kind,
    name: &str,
) -> AppResult<Definition> {
    let query = format!("SHOW CREATE {} {}.{}", kind.sql(), ident(db), ident(name));
    let row = conn.fetch_one(query.as_str()).await?;
    let key = match kind {
        Kind::View => "Create View",
        Kind::Procedure => "Create Procedure",
        Kind::Function => "Create Function",
        Kind::Trigger => "SQL Original Statement",
        Kind::Event => "Create Event",
    };
    let sql = text(&row, key);
    if sql.is_empty() {
        return Err(AppError::InvalidInput(format!("{} {}：服务器未返回定义；请检查 SHOW_ROUTINE / SHOW VIEW / TRIGGER / EVENT 权限（返回列：{}）",kind.sql(),name,row.columns().iter().map(|c|c.name()).collect::<Vec<_>>().join(", "))));
    }
    let tokens = words(&sql);
    let mut dependencies = vec![];
    for (i, w) in tokens.iter().enumerate() {
        if ["FROM", "JOIN", "REFERENCES", "CALL", "UPDATE", "INTO"]
            .contains(&w.to_ascii_uppercase().as_str())
        {
            if let Some(name) = tokens.get(i + 1) {
                let mut v = name.clone();
                if tokens.get(i + 2).is_some_and(|x| x == ".") {
                    if let Some(n) = tokens.get(i + 3) {
                        v = format!("{v}.{n}");
                    }
                }
                if !dependencies.contains(&v) {
                    dependencies.push(v);
                }
            }
        }
    }
    let parameters = if matches!(kind, Kind::Procedure | Kind::Function) {
        sqlx::query("SELECT PARAMETER_NAME,PARAMETER_MODE,DTD_IDENTIFIER FROM information_schema.PARAMETERS WHERE SPECIFIC_SCHEMA=? AND SPECIFIC_NAME=? AND ORDINAL_POSITION>0 ORDER BY ORDINAL_POSITION").bind(db).bind(name).fetch_all(&mut *conn).await?.iter().map(|r|Parameter{name:text(r,"PARAMETER_NAME"),mode:text(r,"PARAMETER_MODE"),data_type:text(r,"DTD_IDENTIFIER")}).collect()
    } else {
        vec![]
    };
    Ok(Definition {
        sql,
        dependencies,
        parameters,
        sql_mode: text(&row, "sql_mode"),
        charset: text(&row, "character_set_client"),
        collation: text(&row, "collation_connection"),
    })
}
pub async fn connect(
    state: &AppState,
    id: &str,
    db: &str,
    write: bool,
) -> AppResult<MySqlConnection> {
    let record = state.local.get_session(id).await?;
    super::database_access::check(record.allowed_databases.as_deref(), db)?;
    if write {
        super::readonly::writable(state, id).await?;
    }
    state
        .connected(id)
        .await?
        .adapter
        .mysql_connection(db, write)
        .await
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub session_id: String,
    pub database: String,
    pub kind: Kind,
    pub name: String,
    pub sql: Option<String>,
    pub original: Option<String>,
    pub confirmed: bool,
}
fn validate_create(sql: &str, db: &str, kind: &Kind, name: &str) -> AppResult<()> {
    single_definition(sql)?;
    let w = words(sql);
    if !w.first().is_some_and(|v| v.eq_ignore_ascii_case("CREATE")) {
        return Err(AppError::InvalidInput(
            "请输入单条 CREATE 对象定义，不要包含 DELIMITER 或 DROP".into(),
        ));
    }
    let i = w
        .iter()
        .position(|s| s.eq_ignore_ascii_case(kind.sql()))
        .ok_or_else(|| AppError::InvalidInput("对象类型与定义不匹配".into()))?;
    let valid = if w.get(i + 2).is_some_and(|s| s == ".") {
        w.get(i + 1).is_some_and(|s| s == db) && w.get(i + 3).is_some_and(|s| s == name)
    } else {
        w.get(i + 1).is_some_and(|s| s == name)
    };
    if !valid {
        return Err(AppError::InvalidInput(
            "定义中的对象名称/数据库与编辑目标不一致".into(),
        ));
    }
    Ok(())
}
fn single_definition(sql: &str) -> AppResult<()> {
    use sqlparser::{
        dialect::MySqlDialect,
        tokenizer::{Token, Tokenizer, Whitespace},
    };
    let raw_tokens = Tokenizer::new(&MySqlDialect {}, sql)
        .tokenize()
        .map_err(|e| AppError::InvalidInput(format!("定义词法错误：{e}")))?;
    if raw_tokens.iter().any(
        |t| matches!(t,Token::Whitespace(Whitespace::MultiLineComment(s)) if s.starts_with('!')),
    ) {
        return Err(AppError::InvalidInput(
            "对象定义编辑暂不支持可执行注释，请展开为明确的 SQL 后再编辑".into(),
        ));
    }
    let tokens = raw_tokens
        .into_iter()
        .filter(|t| {
            !matches!(
                t,
                Token::Whitespace(
                    Whitespace::Space
                        | Whitespace::Newline
                        | Whitespace::Tab
                        | Whitespace::SingleLineComment { .. }
                        | Whitespace::MultiLineComment(_)
                )
            )
        })
        .collect::<Vec<_>>();
    let word = |i: usize| match tokens.get(i) {
        Some(Token::Word(w)) if w.quote_style.is_none() => w.value.to_ascii_uppercase(),
        _ => String::new(),
    };
    let mut depth = 0usize;
    let mut after_end = false;
    for (i, t) in tokens.iter().enumerate() {
        let w = word(i);
        if w == "DELIMITER" {
            return Err(AppError::InvalidInput(
                "对象编辑器只接受定义，不接受 DELIMITER 指令".into(),
            ));
        }
        if w == "END" {
            depth = depth.saturating_sub(1);
            after_end = true;
            continue;
        }
        if after_end && ["IF", "CASE", "LOOP", "WHILE", "REPEAT"].contains(&w.as_str()) {
            after_end = false;
            continue;
        }
        after_end = false;
        let control_if = w == "IF"
            && tokens
                .iter()
                .enumerate()
                .skip(i + 1)
                .take_while(|(_, t)| !matches!(t, Token::SemiColon))
                .any(|(j, _)| word(j) == "THEN");
        if w == "BEGIN"
            || w == "CASE"
            || w == "LOOP"
            || w == "WHILE"
            || (w == "REPEAT" && !matches!(tokens.get(i + 1), Some(Token::LParen)))
            || control_if
        {
            depth += 1;
        }
        if matches!(t, Token::SemiColon) && depth == 0 && i + 1 < tokens.len() {
            return Err(AppError::InvalidInput("对象定义后不能附带其他语句".into()));
        }
    }
    if depth != 0 {
        return Err(AppError::InvalidInput(
            "对象的 BEGIN / END 或控制块未闭合".into(),
        ));
    }
    Ok(())
}
pub async fn apply(state: &AppState, req: Change) -> AppResult<()> {
    let _lock = state.session_lock(&req.session_id).await;
    if !req.confirmed {
        return Err(AppError::Dangerous(
            "请预览差异并确认执行；对象 DDL 不能整体回滚".into(),
        ));
    }
    let record = state.local.get_session(&req.session_id).await?;
    let mut conn = connect(state, &req.session_id, &req.database, true).await?;
    let mode: String = sqlx::query_scalar("SELECT @@SQL_MODE")
        .fetch_one(&mut conn)
        .await?;
    if req.sql.is_some() && super::mysql_script::nonstandard_quotes(&mode) {
        return Err(AppError::InvalidInput(
            "暂不支持 NO_BACKSLASH_ESCAPES / ANSI_QUOTES 模式下的对象编辑".into(),
        ));
    }
    let drop_sql = format!(
        "DROP {} {}.{}",
        req.kind.sql(),
        ident(&req.database),
        ident(&req.name)
    );
    super::database_access::sql(
        record.allowed_databases.as_deref(),
        &req.database,
        req.sql.as_deref().unwrap_or(&drop_sql),
    )?;
    if let Some(sql) = &req.sql {
        validate_create(sql, &req.database, &req.kind, &req.name)?;
        let tokens = words(sql);
        if req.original.is_none() && tokens.get(1).is_some_and(|w| w.eq_ignore_ascii_case("OR")) {
            return Err(AppError::InvalidInput(
                "替换对象前必须先读取原定义，不能从新建入口使用 CREATE OR REPLACE".into(),
            ));
        }
    }
    if let Some(expected) = &req.original {
        let latest = definition(&mut conn, &req.database, &req.kind, &req.name).await?;
        if latest.sql != *expected {
            return Err(AppError::InvalidInput(
                "服务器定义已变化，请刷新后重新编辑".into(),
            ));
        }
        if req.sql.is_some() && super::mysql_script::nonstandard_quotes(&latest.sql_mode) {
            return Err(AppError::InvalidInput(
                "当前定义使用 NO_BACKSLASH_ESCAPES / ANSI_QUOTES，暂不支持该模式下的对象替换；原对象未修改"
                    .into(),
            ));
        }
        for (variable, value) in [
            ("SQL_MODE", &latest.sql_mode),
            ("CHARACTER_SET_CLIENT", &latest.charset),
            ("COLLATION_CONNECTION", &latest.collation),
        ] {
            if !value.is_empty() {
                sqlx::query(&format!("SET {variable}=?"))
                    .bind(value)
                    .execute(&mut conn)
                    .await?;
            }
        }
        // MySQL does not support preparing all stored-program DDL (1295). Other errors stop before DROP.
        if let Some(sql) = &req.sql {
            if let Err(e) = conn.prepare(sql).await {
                if !matches!(&e,sqlx::Error::Database(d) if d.try_downcast_ref::<sqlx::mysql::MySqlDatabaseError>().is_some_and(|d|d.number()==1295))
                {
                    return Err(e.into());
                }
            }
        }
        conn.execute(drop_sql.as_str()).await?;
    } else if req.sql.is_none() {
        return Err(AppError::InvalidInput("删除对象前必须读取原定义".into()));
    }
    if let Some(sql) = &req.sql {
        if let Err(e) = conn.execute(sql.as_str()).await {
            return Err(AppError::Message(format!("创建失败：{e}。DDL 非原子操作；若已删除旧对象，原定义仍保留在编辑器中，请核对后恢复，程序不会自动重试。")));
        }
    }
    conn.close().await?;
    Ok(())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Call {
    pub session_id: String,
    pub database: String,
    pub name: String,
    pub values: Vec<Option<String>>,
    pub confirmed: bool,
}
#[derive(Serialize)]
pub struct CallResult {
    pub results: Vec<QueryOutcome>,
    pub truncated: bool,
}
pub async fn call(state: &AppState, req: Call) -> AppResult<CallResult> {
    let _lock = state.session_lock(&req.session_id).await;
    if !req.confirmed {
        return Err(AppError::Dangerous(
            "过程调用可能写入数据或操作其他数据库，请先确认".into(),
        ));
    }
    let record = state.local.get_session(&req.session_id).await?;
    let mut conn = connect(state, &req.session_id, &req.database, true).await?;
    let base = format!("CALL {}.{}", ident(&req.database), ident(&req.name));
    super::database_access::sql(record.allowed_databases.as_deref(), &req.database, &base)?;
    let def = definition(&mut conn, &req.database, &Kind::Procedure, &req.name).await?;
    if def.parameters.len() != req.values.len() {
        return Err(AppError::InvalidInput(
            "过程参数已变化，请重新读取定义".into(),
        ));
    }
    let mut args = vec![];
    let mut outputs = vec![];
    for (i, (p, v)) in def.parameters.iter().zip(&req.values).enumerate() {
        let var = format!("@dbfolio_p{i}");
        sqlx::query(&format!("SET {var}=?"))
            .bind(v)
            .execute(&mut conn)
            .await?;
        args.push(var.clone());
        if p.mode != "IN" {
            outputs.push(format!("{var} AS {}", ident(&p.name)));
        }
    }
    crate::tasks::checkpoint()?;
    let sql = format!("{base}({})", args.join(","));
    let mut results = vec![];
    let mut current = QueryOutcome::default();
    let mut truncated = false;
    let mut bytes = 0usize;
    let started = std::time::Instant::now();
    let mut stream = sqlx::raw_sql(&sql).fetch_many(&mut conn);
    loop {
        if crate::tasks::cancelled() || started.elapsed() > std::time::Duration::from_secs(300) {
            return Err(AppError::WriteUncertain(
                "过程调用已中断，可能已产生写入；请核对服务器结果，不会自动重试".into(),
            ));
        }
        let item = tokio::select! {r=stream.try_next()=>r.map_err(|e|AppError::WriteUncertain(format!("过程执行失败：{e}；过程可能部分写入，请核对结果")))?,_=tokio::time::sleep(std::time::Duration::from_millis(200))=>continue};
        let Some(item) = item else { break };
        match item {
            sqlx::Either::Left(result) => {
                current.affected = Some(result.rows_affected());
                if results.len() < 20 {
                    results.push(std::mem::take(&mut current));
                } else {
                    truncated = true;
                    current = QueryOutcome::default();
                }
            }
            sqlx::Either::Right(row) => {
                if current.columns.is_empty() {
                    current.columns = row
                        .columns()
                        .iter()
                        .map(|c| ColumnInfo {
                            name: c.name().into(),
                            raw_type: c.type_info().name().into(),
                        })
                        .collect();
                }
                if current.rows.len() < 200 && results.len() < 20 && bytes < 8 * 1024 * 1024 {
                    let values: Vec<_> = (0..row.len())
                        .map(|i| crate::adapters::mysql::decode_cell(&row, i))
                        .collect();
                    bytes += serde_json::to_vec(&values).map(|b| b.len()).unwrap_or(0);
                    if bytes <= 8 * 1024 * 1024 {
                        current.rows.push(values);
                    } else {
                        truncated = true;
                    }
                } else {
                    truncated = true;
                }
            }
        }
    }
    drop(stream);
    if !outputs.is_empty() {
        let row = sqlx::query(&format!("SELECT {}", outputs.join(",")))
            .fetch_one(&mut conn)
            .await?;
        results.push(QueryOutcome {
            columns: row
                .columns()
                .iter()
                .map(|c| ColumnInfo {
                    name: c.name().into(),
                    raw_type: c.type_info().name().into(),
                })
                .collect(),
            rows: vec![(0..row.len())
                .map(|i| crate::adapters::mysql::decode_cell(&row, i))
                .collect()],
            affected: None,
        });
    }
    conn.close().await?;
    Ok(CallResult { results, truncated })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_identity() {
        assert!(validate_create(
            "CREATE DEFINER=`root`@`localhost` PROCEDURE `db`.`p`() BEGIN SELECT 1; END",
            "db",
            &Kind::Procedure,
            "p"
        )
        .is_ok());
        assert!(
            validate_create("CREATE VIEW other.v AS SELECT 1", "db", &Kind::View, "v").is_err()
        );
    }
    #[test]
    fn rejects_extra_commands() {
        for sql in [
            "CREATE VIEW v AS SELECT 1; DROP TABLE t",
            "CREATE PROCEDURE p() BEGIN SELECT 1; END; DROP DATABASE x",
        ] {
            assert!(single_definition(sql).is_err());
        }
        assert!(single_definition("CREATE PROCEDURE p() BEGIN IF (1=1) THEN SELECT IF(1,2,3); END IF; SELECT CASE WHEN 1 THEN 2 END; END;").is_ok());
    }
}
