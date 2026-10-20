//! A bounded migration-script runner. Dynamic expressions are interpreted locally;
//! only validated SQL and parameterized metadata probes reach the dedicated connection.
use super::{database_access, mysql_script, query, readonly, sql_risk};
use crate::{
    adapters::{DbAdapter, QueryContext, QueryOutcome},
    error::{AppError, AppResult},
    meta::Engine,
};
use futures_util::TryStreamExt;
use sqlparser::{
    dialect::MySqlDialect,
    tokenizer::{Token, Tokenizer},
};
use sqlx::{Connection, Executor};
use std::{collections::HashMap, io::Cursor};

fn invalid(message: impl Into<String>) -> AppError {
    AppError::InvalidInput(message.into())
}

#[derive(Clone, Debug)]
struct Probe {
    table: String,
    filters: Vec<(String, String)>,
}
#[derive(Clone, Debug)]
enum Expression {
    Literal(String),
    IfExists(Probe, String, String),
}
impl Expression {
    fn candidates(&self) -> Vec<String> {
        match self {
            Self::Literal(s) => vec![s.clone()],
            Self::IfExists(_, a, b) => vec![a.clone(), b.clone()],
        }
    }
    async fn evaluate(
        &self,
        conn: &mut sqlx::MySqlConnection,
        database: &str,
    ) -> AppResult<String> {
        match self {
            Self::Literal(s) => Ok(s.clone()),
            Self::IfExists(probe, a, b) => {
                // The table and field names originate from fixed allowlists, never SQL input.
                let mut text = format!(
                    "SELECT EXISTS(SELECT 1 FROM information_schema.{} WHERE TABLE_SCHEMA=?",
                    probe.table
                );
                for (column, _) in &probe.filters {
                    text.push_str(&format!(" AND {column}=?"));
                }
                text.push(')');
                let mut q = sqlx::query_scalar::<_, i64>(&text).bind(database);
                for (_, value) in &probe.filters {
                    q = q.bind(value);
                }
                Ok(if q.fetch_one(&mut *conn).await? != 0 {
                    a.clone()
                } else {
                    b.clone()
                })
            }
        }
    }
}
#[derive(Debug)]
enum Step {
    Set(String, Expression),
    Prepare(String, String),
    Execute(String),
    Deallocate(String),
    Sql(String),
}
#[derive(Debug)]
pub struct Plan {
    steps: Vec<(u64, Step)>,
}

struct Reader {
    tokens: Vec<Token>,
    at: usize,
}
impl Reader {
    fn new(sql: &str) -> AppResult<Self> {
        let tokens = Tokenizer::new(&MySqlDialect {}, sql)
            .tokenize()
            .map_err(|e| invalid(format!("脚本解析失败：{e}")))?;
        Ok(Self {
            tokens: tokens
                .into_iter()
                .filter(|t| !matches!(t, Token::Whitespace(_)))
                .collect(),
            at: 0,
        })
    }
    fn take(&mut self) -> AppResult<Token> {
        let t = self
            .tokens
            .get(self.at)
            .cloned()
            .ok_or_else(|| invalid("脚本语句不完整"))?;
        self.at += 1;
        Ok(t)
    }
    fn word(&mut self) -> AppResult<String> {
        match self.take()? {
            Token::Word(w) => Ok(w.value.to_ascii_lowercase()),
            _ => Err(invalid("脚本此处需要名称")),
        }
    }
    fn keyword(&mut self, word: &str) -> AppResult<()> {
        if self.word()? == word {
            Ok(())
        } else {
            Err(invalid(format!("脚本此处需要 {word}")))
        }
    }
    fn token(&mut self, token: Token) -> AppResult<()> {
        if self.take()? == token {
            Ok(())
        } else {
            Err(invalid("脚本表达式格式不支持"))
        }
    }
    fn literal(&mut self) -> AppResult<String> {
        match self.take()? {
            Token::SingleQuotedString(s) => Ok(s),
            _ => Err(invalid(
                "动态 SQL 目前需要单引号字符串；支持固定 SQL 或 IF(EXISTS(...), SQL, SQL)",
            )),
        }
    }
    fn variable(&mut self) -> AppResult<String> {
        let token = self.take()?;
        let value = match token {
            Token::Word(w) if w.quote_style.is_none() => w.value,
            Token::AtSign => format!("@{}", self.word()?),
            _ => return Err(invalid("脚本需要 @变量名；不支持系统变量或服务器设置")),
        };
        let name = value
            .strip_prefix('@')
            .filter(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'))
            .ok_or_else(|| {
                invalid("脚本变量名仅支持 @ 后接字母、数字和下划线，不支持 @@ 系统变量")
            })?;
        Ok(name.to_ascii_lowercase())
    }
    fn end(&self) -> AppResult<()> {
        if self.at == self.tokens.len() {
            Ok(())
        } else {
            Err(invalid(
                "脚本包含不支持的附加表达式；不会忽略或直接执行该内容",
            ))
        }
    }
    fn expression(&mut self, database: &str) -> AppResult<Expression> {
        if matches!(self.tokens.get(self.at), Some(Token::SingleQuotedString(_))) {
            return Ok(Expression::Literal(self.literal()?));
        }
        self.keyword("if")?;
        self.token(Token::LParen)?;
        self.keyword("exists")?;
        self.token(Token::LParen)?;
        self.keyword("select")?;
        self.token(Token::Number("1".into(), false))?;
        self.keyword("from")?;
        self.keyword("information_schema")?;
        self.token(Token::Period)?;
        let table = self.word()?;
        if !["columns", "statistics", "tables"].contains(&table.as_str()) {
            return Err(invalid(
                "迁移条件仅支持当前数据库的 columns/statistics/tables 元数据存在性检查",
            ));
        }
        self.keyword("where")?;
        let mut schema = false;
        let mut filters = Vec::new();
        loop {
            let column = self.word()?;
            self.token(Token::Eq)?;
            if column == "table_schema" {
                if schema {
                    return Err(invalid("元数据条件重复指定 table_schema"));
                }
                schema = true;
                if matches!(self.tokens.get(self.at), Some(Token::SingleQuotedString(_))) {
                    if self.literal()? != database {
                        return Err(invalid("迁移元数据检查必须限定当前选中的数据库"));
                    }
                } else {
                    self.keyword("database")?;
                    self.token(Token::LParen)?;
                    self.token(Token::RParen)?;
                }
            } else {
                let permitted = column == "table_name"
                    || table == "columns" && column == "column_name"
                    || table == "statistics" && column == "index_name";
                if !permitted || filters.iter().any(|(c, _)| c == &column) {
                    return Err(invalid(
                        "迁移元数据条件仅支持 table_name、column_name 或 index_name 的等值匹配",
                    ));
                }
                filters.push((column, self.literal()?));
            }
            if matches!(self.tokens.get(self.at), Some(Token::RParen)) {
                break;
            }
            self.keyword("and")?;
        }
        if !schema || !filters.iter().any(|(c, _)| c == "table_name") {
            return Err(invalid(
                "迁移元数据检查必须包含 table_schema=DATABASE() 和 table_name 条件",
            ));
        }
        self.token(Token::RParen)?;
        self.token(Token::Comma)?;
        let a = self.literal()?;
        self.token(Token::Comma)?;
        let b = self.literal()?;
        self.token(Token::RParen)?;
        Ok(Expression::IfExists(Probe { table, filters }, a, b))
    }
}

fn validate_sql(
    sql: &str,
    database: &str,
    allowed: Option<&[String]>,
    read_only: bool,
    force: bool,
) -> AppResult<()> {
    let mut script = mysql_script::Script::new(Cursor::new(sql.as_bytes()));
    let statement = script.next()?.ok_or_else(|| invalid("动态 SQL 不能为空"))?;
    if script.next()?.is_some() {
        return Err(invalid("每个动态 SQL 分支只允许一条语句"));
    }
    // No client directives, connection-state changes or nested dynamic evaluation.
    if ![
        "SELECT", "WITH", "INSERT", "REPLACE", "UPDATE", "DELETE", "CREATE", "ALTER", "DROP",
        "TRUNCATE", "RENAME", "EXPLAIN", "DESCRIBE", "DESC",
    ]
    .contains(&query::first_keyword(&statement.sql).as_str())
    {
        return Err(invalid("查询脚本仅支持查询、数据及表结构语句；事务控制、USE、服务器设置和存储程序请使用对应入口"));
    }
    if mysql_script::words(&statement.sql).iter().any(|w| {
        [
            "PROCEDURE",
            "FUNCTION",
            "TRIGGER",
            "EVENT",
            "PREPARE",
            "EXECUTE",
        ]
        .iter()
        .any(|k| w.eq_ignore_ascii_case(k))
    }) {
        return Err(invalid(
            "查询脚本不支持存储程序定义或嵌套动态执行，请使用数据库对象管理或 SQL 文件导入",
        ));
    }
    database_access::sql(allowed, database, &statement.sql)?;
    if read_only {
        readonly::sql(Engine::Mysql, &statement.sql)?;
    }
    if !force {
        if let Some(reason) = sql_risk::danger_reason(Engine::Mysql, &statement.sql) {
            return Err(AppError::Dangerous(reason));
        }
    }
    Ok(())
}

pub fn plan(
    engine: Engine,
    text: &str,
    database: &str,
    allowed: Option<&[String]>,
    read_only: bool,
    force: bool,
) -> AppResult<Option<Plan>> {
    if engine != Engine::Mysql {
        return Ok(None);
    }
    if text.len() > 16 * 1024 * 1024 {
        return Err(invalid("查询脚本超过 16 MiB，请使用 SQL 文件导入"));
    }
    let mut parser = mysql_script::Script::new(Cursor::new(text.as_bytes()));
    let mut statements = Vec::new();
    while let Some(s) = parser.next()? {
        if statements.len() >= 1000 {
            return Err(invalid("查询脚本最多 1000 条语句，请使用 SQL 文件导入"));
        }
        statements.push(s);
    }
    let dynamic = statements.first().is_some_and(|s| {
        matches!(
            query::first_keyword(&s.sql).as_str(),
            "SET" | "PREPARE" | "EXECUTE" | "DEALLOCATE"
        )
    });
    if statements.len() < 2 && !dynamic {
        return Ok(None);
    }
    database_access::check(allowed, database)?;
    let mut variables: HashMap<String, Vec<String>> = HashMap::new();
    let mut prepared: HashMap<String, Vec<String>> = HashMap::new();
    let mut steps = Vec::new();
    for s in statements {
        let step = (|| -> AppResult<Step> {
            let mut r = Reader::new(&s.sql)?;
            let first = r.word()?;
            let step = match first.as_str() {
                "set" => {
                    let name = r.variable()?;
                    r.token(Token::Eq)?;
                    let expr = r.expression(database)?;
                    r.end()?;
                    let candidates = expr.candidates();
                    for sql in &candidates {
                        validate_sql(sql, database, allowed, read_only, force)?;
                    }
                    variables.insert(name.clone(), candidates);
                    Step::Set(name, expr)
                }
                "prepare" => {
                    let name = r.word()?;
                    r.keyword("from")?;
                    let variable = r.variable()?;
                    r.end()?;
                    let candidates = variables
                        .get(&variable)
                        .ok_or_else(|| {
                            invalid("PREPARE 引用的变量未在本段脚本 SET；请选中完整脚本执行")
                        })?
                        .clone();
                    prepared.insert(name.clone(), candidates);
                    Step::Prepare(name, variable)
                }
                "execute" => {
                    let name = r.word()?;
                    r.end()?;
                    if !prepared.contains_key(&name) {
                        return Err(invalid("EXECUTE 未在本段脚本 PREPARE；请选中完整脚本执行"));
                    }
                    Step::Execute(name)
                }
                "deallocate" => {
                    r.keyword("prepare")?;
                    let name = r.word()?;
                    r.end()?;
                    if prepared.remove(&name).is_none() {
                        return Err(invalid("DEALLOCATE 引用了未准备的语句"));
                    }
                    Step::Deallocate(name)
                }
                _ => {
                    validate_sql(&s.sql, database, allowed, read_only, force)?;
                    Step::Sql(s.sql.clone())
                }
            };
            Ok(step)
        })()
        .map_err(|e| match e {
            AppError::Dangerous(reason) => {
                AppError::Dangerous(format!("脚本第 {} 行：{reason}；确认前整段未执行", s.line))
            }
            other => invalid(format!("脚本第 {} 行预检失败：{other}；整段未执行", s.line)),
        })?;
        steps.push((s.line, step));
    }
    Ok(Some(Plan { steps }))
}

async fn run_sql(
    conn: &mut sqlx::MySqlConnection,
    sql: &str,
    limit: u32,
) -> AppResult<QueryOutcome> {
    if query::classify(sql) == query::StatementKind::Rows {
        let described = conn
            .describe(sql)
            .await
            .map(|d| {
                d.columns
                    .iter()
                    .map(|c| {
                        use sqlx::Column;
                        crate::adapters::ColumnInfo {
                            name: c.name().into(),
                            raw_type: sqlx::TypeInfo::name(c.type_info()).into(),
                        }
                    })
                    .collect()
            })
            .unwrap_or_default();
        let mut rows = Vec::new();
        let mut stream = sqlx::query(sql).fetch(&mut *conn);
        while let Some(row) = stream.try_next().await? {
            rows.push(row);
            if rows.len() >= limit as usize {
                break;
            }
        }
        Ok(crate::adapters::mysql::rows_to_outcome(rows, described))
    } else {
        let result = sqlx::query(sql).execute(&mut *conn).await?;
        Ok(QueryOutcome {
            affected: Some(result.rows_affected()),
            ..Default::default()
        })
    }
}

pub async fn execute(
    adapter: &dyn DbAdapter,
    plan: &Plan,
    database: &str,
    allowed: Option<&[String]>,
    read_only: bool,
    limit: u32,
    ctx: &QueryContext,
) -> AppResult<QueryOutcome> {
    let mut conn = adapter.mysql_connection(database, !read_only).await?;
    let (mode, autocommit): (String, i64) = sqlx::query_as("SELECT @@SQL_MODE,@@autocommit")
        .fetch_one(&mut conn)
        .await?;
    if mysql_script::nonstandard_quotes(&mode) {
        return Err(invalid(
            "查询脚本暂不支持 ANSI_QUOTES 或 NO_BACKSLASH_ESCAPES；整段未执行",
        ));
    }
    if autocommit != 1 {
        return Err(invalid(
            "查询脚本需要默认自动提交连接；整段未执行，请使用手动事务入口管理事务",
        ));
    }
    *ctx.conn_id.lock().await = Some(
        sqlx::query_scalar("SELECT CONNECTION_ID()")
            .fetch_one(&mut conn)
            .await?,
    );
    let result=async {
        let mut variables=HashMap::new();let mut prepared=HashMap::new();let mut affected=0u64;let mut outcome=QueryOutcome::default();
        for (index,(line,step)) in plan.steps.iter().enumerate(){
            let result=async {
                crate::tasks::checkpoint()?;
                if ctx.is_cancelled() {return Err(AppError::Cancelled("脚本已取消".into()));}
                let sql=match step {
                    Step::Set(name,expr)=>{variables.insert(name.clone(),expr.evaluate(&mut conn,database).await?);None},
                    Step::Prepare(name,variable)=>{prepared.insert(name.clone(),variables.get(variable).cloned().ok_or_else(||invalid("脚本变量不存在"))?);None},
                    Step::Deallocate(name)=>{prepared.remove(name);None},
                    Step::Execute(name)=>Some(prepared.get(name).cloned().ok_or_else(||invalid("脚本准备语句不存在"))?),
                    Step::Sql(sql)=>Some(sql.clone()),
                };
                if let Some(sql)=sql {
                    validate_sql(&sql,database,allowed,read_only,true)?;
                    let next=run_sql(&mut conn,&sql,limit).await?;affected=affected.saturating_add(next.affected.unwrap_or(0));outcome=next;
                }
                // KILL QUERY may make MySQL SLEEP return a value instead of an error.
                if ctx.is_cancelled() {return Err(AppError::Cancelled("脚本已取消，后续语句未执行".into()));}
                Ok::<_,AppError>(())
            }.await;
            if let Err(e)=result {return Err(AppError::Database(format!("脚本第 {} 条（第 {line} 行）失败：{e}。此前 {index} 条已处理，后续未执行；已完成的写入或 DDL 不会自动回滚，请核对后再操作",index+1)));}
        }
        outcome.affected=Some(affected);outcome.script_statements=Some(plan.steps.len());Ok(outcome)
    }.await;
    *ctx.conn_id.lock().await = None;
    // Never return script session state to a pooled connection, even on failure.
    let _ = conn.close().await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn migration(table: &str, field: &str, sql: &str) -> String {
        format!("SET @ddl = IF(EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='{table}' AND column_name='{field}'), 'SELECT 1', '{}'); PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;",sql.replace('\'',"''"))
    }
    fn checked(text: &str, read_only: bool, force: bool) -> AppResult<Option<Plan>> {
        plan(
            Engine::Mysql,
            text,
            "test_db",
            Some(&["test_db".into()]),
            read_only,
            force,
        )
    }
    #[test]
    fn migration_preflight() {
        let script=migration("knowledge_base","chunk_count","ALTER TABLE knowledge_base ADD chunk_count BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '供应商切片总数'");
        assert_eq!(
            checked(&script, false, false).unwrap().unwrap().steps.len(),
            4
        );
        let index = script
            .replace(
                "information_schema.columns",
                "information_schema.statistics",
            )
            .replace("column_name=", "index_name=");
        assert!(checked(&index, false, false).is_ok());
        assert!(checked("SELECT 1; SELECT 'semicolon ; in string'", false, false).is_ok());
        assert!(checked("SELECT 1", false, false).unwrap().is_none());
        assert!(plan(
            Engine::Sqlite,
            "SELECT 1; SELECT 2",
            "main",
            None,
            false,
            false
        )
        .unwrap()
        .is_none());
        assert!(plan(
            Engine::Postgres,
            "SELECT 1; SELECT 2",
            "public",
            None,
            false,
            false
        )
        .unwrap()
        .is_none());
    }
    #[test]
    fn blocks_scope_bypasses_and_unsupported_expressions() {
        for sql in [
            "ALTER TABLE forbidden.t ADD n INT",
            "SELECT 1; DROP TABLE test_db.t",
            "SET GLOBAL sql_mode=''",
            "CALL unsafe()",
            "SELECT forbidden.f()",
        ] {
            assert!(
                checked(&migration("t", "n", sql), false, true).is_err(),
                "{sql}"
            );
        }
        let valid = migration("t", "n", "ALTER TABLE t ADD n INT");
        for invalid in [
            valid.replace("table_schema=DATABASE()", "table_schema='forbidden'"),
            valid.replace("table_schema=DATABASE() AND ", ""),
            valid.replace(" AND column_name=", " OR column_name="),
            valid.replace(
                "SELECT 1 FROM information_schema.columns",
                "SELECT SLEEP(3) FROM information_schema.columns",
            ),
            valid.replace("information_schema.columns", "forbidden.columns"),
            valid.replace("'SELECT 1'", "'SELECT * FROM forbidden.t'"),
            valid.replace("'SELECT 1'", "CONCAT('SELECT ',1)"),
            "PREPARE x FROM @old; EXECUTE x".into(),
            "EXECUTE x".into(),
            "SET @@sql_mode=''; SELECT 1".into(),
            "USE test_db; SELECT 1".into(),
            "BEGIN; UPDATE t SET n=1".into(),
            "SET @x='SELECT 1' garbage; PREPARE x FROM @x; EXECUTE x".into(),
        ] {
            assert!(checked(&invalid, false, true).is_err(), "{invalid}");
        }
        assert!(checked(&valid, true, true).is_err());
        let danger = migration("t", "n", "DELETE FROM t");
        assert!(matches!(
            checked(&danger, false, false),
            Err(AppError::Dangerous(_))
        ));
        assert!(checked(&danger, false, true).is_ok());
        assert!(checked("SELECT 1; DELETE FROM t", false, false).is_err());
    }
    #[tokio::test]
    #[ignore = "需要本机 MySQL 管理会话；仅创建并清理随机测试数据库"]
    async fn mysql_migration_real() {
        use futures_util::FutureExt;
        let state = crate::state::AppState::initialize().await.unwrap();
        let sessions = state.local.list_sessions().await.unwrap();
        let saved = sessions
            .iter()
            .find(|s| {
                s.engine == Engine::Mysql
                    && s.host.as_deref() == Some("127.0.0.1")
                    && !s.read_only
                    && s.allowed_databases.is_none()
            })
            .expect("本机 MySQL 管理会话");
        super::super::session::connect(&state, &saved.id)
            .await
            .unwrap();
        let adapter = state.connected(&saved.id).await.unwrap().adapter.clone();
        let mut admin = adapter.mysql_connection("mysql", true).await.unwrap();
        let db = format!("dbfolio_script_{}", uuid::Uuid::new_v4().simple());
        admin
            .execute(format!("CREATE DATABASE `{db}`").as_str())
            .await
            .unwrap();
        let outcome=std::panic::AssertUnwindSafe(async {
            let allow=vec![db.clone()];
            let make=|text:&str,force|plan(Engine::Mysql,text,&db,Some(&allow),false,force);
            let script=format!("CREATE TABLE IF NOT EXISTS knowledge_base(id BIGINT PRIMARY KEY); {} {} SET @idx=IF(EXISTS(SELECT 1 FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='knowledge_base' AND index_name='idx_chunks'),'SELECT 1','ALTER TABLE knowledge_base ADD INDEX idx_chunks(chunk_count)'); PREPARE s FROM @idx; EXECUTE s; DEALLOCATE PREPARE s; SELECT chunk_count FROM knowledge_base;",migration("knowledge_base","chunk_count","ALTER TABLE knowledge_base ADD chunk_count BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '供应商切片总数'"),migration("knowledge_base","last_chunk_count_sync_time","ALTER TABLE knowledge_base ADD last_chunk_count_sync_time DATETIME(3) NULL"));
            let p=make(&script,false).unwrap().unwrap();
            for _ in 0..2 {
                let result=execute(adapter.as_ref(),&p,&db,Some(&allow),false,2,&QueryContext::new()).await.unwrap();
                assert_eq!(result.script_statements,Some(14));assert_eq!(result.columns[0].name,"chunk_count");
            }
            let count:i64=sqlx::query_scalar("SELECT COUNT(*) FROM information_schema.statistics WHERE TABLE_SCHEMA=? AND INDEX_NAME='idx_chunks'").bind(&db).fetch_one(&mut admin).await.unwrap();assert_eq!(count,1);
            // All failures found during preflight leave even earlier CREATE statements unapplied.
            let bad="CREATE TABLE should_not_exist(id INT); SET @x='ALTER TABLE forbidden.t ADD c INT'; PREPARE s FROM @x; EXECUTE s";
            assert!(make(bad,true).is_err());
            let count:i64=sqlx::query_scalar("SELECT COUNT(*) FROM information_schema.tables WHERE TABLE_SCHEMA=? AND TABLE_NAME='should_not_exist'").bind(&db).fetch_one(&mut admin).await.unwrap();assert_eq!(count,0);
            let p=make("CREATE TABLE partial_result(id INT); INSERT INTO missing_table VALUES(1); CREATE TABLE should_not_exist(id INT)",false).unwrap().unwrap();
            let error=execute(adapter.as_ref(),&p,&db,Some(&allow),false,2,&QueryContext::new()).await.unwrap_err().to_string();assert!(error.contains("第 2 条"));assert!(error.contains("后续未执行"));
            let p=make("INSERT INTO knowledge_base(id) VALUES(1),(2),(3); SELECT * FROM knowledge_base",false).unwrap().unwrap();
            let r=execute(adapter.as_ref(),&p,&db,Some(&allow),false,2,&QueryContext::new()).await.unwrap();assert_eq!(r.rows.len(),2);assert_eq!(r.affected,Some(3));
            // Prepared statements and variables are local to the script, never pooled/server state.
            let p=make("SET @dbfolio_script_private='SELECT 1'; PREPARE private_stmt FROM @dbfolio_script_private; EXECUTE private_stmt",false).unwrap().unwrap();
            execute(adapter.as_ref(),&p,&db,Some(&allow),false,2,&QueryContext::new()).await.unwrap();
            let value:Option<String>=sqlx::query_scalar("SELECT @dbfolio_script_private").fetch_one(&mut admin).await.unwrap();assert!(value.is_none());
            let p=make("CREATE TABLE connection_ids(id BIGINT); INSERT INTO connection_ids VALUES(CONNECTION_ID()); SELECT * FROM knowledge_base; INSERT INTO connection_ids VALUES(CONNECTION_ID()); SELECT COUNT(DISTINCT id) AS count FROM connection_ids",false).unwrap().unwrap();
            let r=execute(adapter.as_ref(),&p,&db,Some(&allow),false,2,&QueryContext::new()).await.unwrap();assert_eq!(r.rows[0][0],crate::meta::value::DbValue::Int(1));
            // Cancel a live statement; the next DDL must not run, and the running id is cleared.
            let p=make("CREATE TABLE before_cancel(id INT); SELECT SLEEP(15); CREATE TABLE after_cancel(id INT)",false).unwrap().unwrap();
            let ctx=QueryContext::new();
            let cancel=async {
                tokio::time::timeout(std::time::Duration::from_secs(5),async {
                    loop {
                        if let Some(id)=*ctx.conn_id.lock().await {
                            let info:Option<String>=sqlx::query_scalar("SELECT INFO FROM information_schema.processlist WHERE ID=?").bind(id).fetch_optional(&mut admin).await.unwrap().flatten();
                            if info.is_some_and(|s|s.starts_with("SELECT SLEEP")){ctx.cancel();adapter.cancel(id).await.unwrap();break;}
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                    }
                }).await.unwrap();
            };
            let (r,_)=tokio::join!(execute(adapter.as_ref(),&p,&db,Some(&allow),false,2,&ctx),cancel);
            assert!(r.unwrap_err().to_string().contains("第 2 条"));assert!(ctx.conn_id.lock().await.is_none());
            let count:i64=sqlx::query_scalar("SELECT COUNT(*) FROM information_schema.tables WHERE TABLE_SCHEMA=? AND TABLE_NAME='after_cancel'").bind(&db).fetch_one(&mut admin).await.unwrap();assert_eq!(count,0);
        }).catch_unwind().await;
        admin
            .execute(format!("DROP DATABASE `{db}`").as_str())
            .await
            .unwrap();
        if let Err(error) = outcome {
            std::panic::resume_unwind(error);
        }
    }
}
