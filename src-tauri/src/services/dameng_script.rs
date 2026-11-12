//! Streaming disql-compatible splitting. Client commands never reach the server.
use crate::{
    adapters::{QueryContext, QueryOutcome},
    error::{AppError, AppResult},
};
use serde::{Deserialize, Serialize};
use sqlparser::{
    dialect::GenericDialect,
    tokenizer::{Token, Tokenizer},
};
use std::io::{BufRead, Read};

const MAX_SQL: usize = 64 * 1024 * 1024;
fn invalid(s: impl Into<String>) -> AppError {
    AppError::InvalidInput(s.into())
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Statement {
    pub line: u64,
    pub sql: String,
}
#[derive(Clone, Debug)]
pub enum Item {
    Sql(Statement),
    Client {
        line: u64,
        message: String,
        stop_on_error: bool,
    },
}
pub struct Script<R: BufRead> {
    reader: R,
    input: Vec<u8>,
    at: usize,
    line: u64,
    start: u64,
    sql: Vec<u8>,
    quote: u8,
    comment: usize,
    line_comment: bool,
    word: String,
    head: Vec<String>,
    stack: Vec<bool>,
    begun: bool,
    pending_end: bool,
    dirty: bool,
    after_block: bool,
    ended: bool,
    eof: bool,
}
impl<R: BufRead> Script<R> {
    pub fn new(reader: R) -> Self {
        Self {
            reader,
            input: vec![],
            at: 0,
            line: 0,
            start: 1,
            sql: vec![],
            quote: 0,
            comment: 0,
            line_comment: false,
            word: String::new(),
            head: vec![],
            stack: vec![],
            begun: false,
            pending_end: false,
            dirty: false,
            after_block: false,
            ended: false,
            eof: false,
        }
    }
    fn block(&self) -> bool {
        match self.head.first().map(String::as_str) {
            Some("DECLARE") => true,
            Some("BEGIN") => !self
                .head
                .get(1)
                .is_some_and(|s| matches!(s.as_str(), "TRAN" | "TRANSACTION")),
            Some("CREATE") => {
                let mut i = 1;
                if self.head.get(i).is_some_and(|s| s == "OR") {
                    i += 2;
                }
                self.head.get(i).is_some_and(|s| {
                    matches!(
                        s.as_str(),
                        "TRIGGER" | "PROCEDURE" | "FUNCTION" | "PACKAGE" | "TYPE"
                    )
                })
            }
            _ => false,
        }
    }
    fn slash_block(&self) -> bool {
        self.block()
            && self
                .head
                .first()
                .is_some_and(|w| w == "CREATE" || w == "DECLARE")
    }
    fn end_word(&mut self, next: Option<&str>) {
        if !self.pending_end {
            return;
        }
        self.pending_end = false;
        if matches!(next, Some("IF" | "LOOP")) {
            return;
        }
        self.stack.pop();
    }
    fn flush_word(&mut self) {
        if self.word.is_empty() {
            return;
        }
        let word = std::mem::take(&mut self.word).to_ascii_uppercase();
        let suffix = self.pending_end && matches!(word.as_str(), "IF" | "LOOP" | "CASE");
        self.end_word(Some(&word));
        if self.head.len() < 8 {
            self.head.push(word.clone());
        }
        if !suffix {
            match word.as_str() {
                "BEGIN" => {
                    self.stack.push(false);
                    self.begun = true;
                }
                "CASE" => self.stack.push(true),
                "END" => self.pending_end = true,
                _ => {}
            }
        }
        if self.head.first().is_some_and(|w| w == "BEGIN")
            && self
                .head
                .get(1)
                .is_some_and(|s| matches!(s.as_str(), "TRAN" | "TRANSACTION"))
        {
            self.stack.clear();
            self.begun = false;
        }
    }
    fn finish(&mut self) -> AppResult<Option<Item>> {
        if self.sql.len() > MAX_SQL {
            return Err(invalid(format!("第 {} 行 SQL 超过 64 MiB", self.start)));
        }
        self.flush_word();
        self.end_word(None);
        if !self.dirty {
            self.sql.clear();
            return Ok(None);
        }
        let sql = String::from_utf8(std::mem::take(&mut self.sql))
            .map_err(|_| invalid("SQL 文件不是有效的所选编码"))?;
        let block = self.block();
        self.head.clear();
        self.stack.clear();
        self.begun = false;
        self.dirty = false;
        self.after_block = block;
        Ok(Some(Item::Sql(Statement {
            line: self.start,
            sql: sql.trim().to_string(),
        })))
    }
    pub fn next(&mut self) -> AppResult<Option<Item>> {
        loop {
            if self.sql.len() > MAX_SQL {
                return Err(invalid(format!("第 {} 行 SQL 超过 64 MiB", self.start)));
            }
            if self.at == self.input.len() {
                if self.eof {
                    return Ok(None);
                }
                self.input.clear();
                self.at = 0;
                let mut n = (&mut self.reader)
                    .take((MAX_SQL + 1) as u64)
                    .read_until(b'\n', &mut self.input)?;
                if self.line == 0 && self.input.starts_with(&[0xef, 0xbb, 0xbf]) {
                    self.input.drain(..3);
                    n -= 3;
                }
                if n > MAX_SQL {
                    return Err(invalid("达梦 SQL 单行超过 64 MiB"));
                }
                if n == 0 {
                    self.eof = true;
                    self.flush_word();
                    self.end_word(None);
                    if self.quote != 0 || self.comment != 0 {
                        return Err(invalid(format!(
                            "第 {} 行开始的字符串或注释未闭合",
                            self.start
                        )));
                    }
                    if self.block() && !self.stack.is_empty() {
                        return Err(invalid(format!("第 {} 行开始的程序块未闭合", self.start)));
                    }
                    return self.finish();
                }
                self.line += 1;
                self.line_comment = false;
                if self.quote == 0 && self.comment == 0 {
                    let text = std::str::from_utf8(&self.input)
                        .map_err(|_| invalid("SQL 文件编码无效"))?
                        .trim();
                    if text == "/" {
                        self.at = n;
                        if self.dirty && self.block() {
                            self.flush_word();
                            self.end_word(None);
                            if !self.stack.is_empty() {
                                return Err(invalid(format!(
                                    "第 {} 行程序块尚未闭合，不能使用 / 结束",
                                    self.line
                                )));
                            }
                            return self.finish();
                        }
                        if !self.dirty && self.after_block {
                            self.after_block = false;
                            self.sql.clear();
                            continue;
                        }
                        return Err(invalid(format!(
                            "第 {} 行：/ 仅可结束程序块，不重复执行前一条 SQL",
                            self.line
                        )));
                    }
                    if !self.dirty {
                        let plain = text.trim_end_matches(';').trim();
                        let words = plain.split_whitespace().collect::<Vec<_>>();
                        if !plain.contains(';')
                            && words.first().is_some_and(|w| w.eq_ignore_ascii_case("SET"))
                            && words
                                .get(1)
                                .is_some_and(|w| w.eq_ignore_ascii_case("AUTOCOMMIT"))
                        {
                            if self.ended {
                                return Err(invalid("EXIT/QUIT 后仍有 SQL"));
                            }
                            autocommit(plain)?;
                            self.at = n;
                            self.sql.clear();
                            return Ok(Some(Item::Sql(Statement {
                                line: self.line,
                                sql: plain.into(),
                            })));
                        }
                        if let Some((message, stop)) = client(text)
                            .map_err(|e| invalid(format!("第 {} 行：{e}", self.line)))?
                        {
                            self.at = n;
                            self.sql.clear();
                            let first = text.split_whitespace().next().unwrap_or("").trim_end_matches(';');
                            if self.ended {
                                return Err(invalid("EXIT/QUIT 后存在额外客户端指令"));
                            }
                            if first.eq_ignore_ascii_case("EXIT")
                                || first.eq_ignore_ascii_case("QUIT")
                            {
                                self.ended = true;
                            }
                            return Ok(Some(Item::Client {
                                line: self.line,
                                message,
                                stop_on_error: stop,
                            }));
                        }
                    }
                }
            }
            let b = self.input[self.at];
            let next = self.input.get(self.at + 1).copied();
            if self.line_comment {
                self.sql.push(b);
                self.at += 1;
                continue;
            }
            if self.comment > 0 {
                self.sql.push(b);
                self.at += 1;
                if b == b'/' && next == Some(b'*') {
                    self.sql.push(b'*');
                    self.at += 1;
                    self.comment += 1;
                } else if b == b'*' && next == Some(b'/') {
                    self.sql.push(b'/');
                    self.at += 1;
                    self.comment -= 1;
                }
                continue;
            }
            if self.quote != 0 {
                self.sql.push(b);
                self.at += 1;
                if b == self.quote {
                    if next == Some(self.quote) {
                        self.sql.push(b);
                        self.at += 1;
                    } else {
                        self.quote = 0;
                    }
                }
                continue;
            }
            if b == b'-' && next == Some(b'-') {
                self.flush_word();
                self.sql.extend_from_slice(b"--");
                self.at += 2;
                self.line_comment = true;
                continue;
            }
            if b == b'/' && next == Some(b'*') {
                self.flush_word();
                self.sql.extend_from_slice(b"/*");
                self.at += 2;
                self.comment = 1;
                continue;
            }
            if b == b';' && !self.dirty {
                self.sql.clear();
                self.at += 1;
                continue;
            }
            if !b.is_ascii_whitespace() && !self.dirty {
                if self.ended {
                    return Err(invalid(format!(
                        "第 {} 行：EXIT/QUIT 后仍有 SQL，不会忽略后续内容",
                        self.line
                    )));
                }
                self.start = self.line;
                self.dirty = true;
                self.after_block = false;
            }
            if b == b'\'' || b == b'"' {
                self.flush_word();
                self.quote = b;
                self.sql.push(b);
                self.at += 1;
                continue;
            }
            if b.is_ascii_alphanumeric() || b == b'_' || b == b'$' {
                self.word.push(b as char);
            } else {
                self.flush_word();
            }
            if b == b';' {
                self.end_word(None);
                if !self.block() || (self.begun && self.stack.is_empty() && !self.slash_block()) {
                    if self.block() {
                        self.sql.push(b);
                    }
                    self.at += 1;
                    return self.finish();
                }
            }
            self.sql.push(b);
            self.at += 1;
            if self.sql.len() > MAX_SQL {
                return Err(invalid(format!("第 {} 行 SQL 超过 64 MiB", self.start)));
            }
        }
    }
}
fn client(text: &str) -> AppResult<Option<(String, bool)>> {
    let text = text.trim_start_matches('\u{feff}').trim();
    let words = text
        .trim_end_matches(';')
        .split_whitespace()
        .collect::<Vec<_>>();
    let upper = words
        .iter()
        .map(|s| s.to_ascii_uppercase())
        .collect::<Vec<_>>();
    let first = upper.first().map(String::as_str).unwrap_or("");
    if first == "PROMPT" {
        return Ok(Some((
            format!("PROMPT 输出：{}", text.get(6..).unwrap_or("").trim()),
            false,
        )));
    }
    if first == "WHENEVER" {
        if upper.get(1).is_some_and(|s| s == "SQLERROR")
            && upper.get(2).is_some_and(|s| s == "EXIT")
            && upper.iter().skip(3).all(|s| {
                s.parse::<i32>().is_ok() || matches!(s.as_str(), "FAILURE" | "SUCCESS" | "ROLLBACK")
            })
        {
            return Ok(Some((
                "WHENEVER SQLERROR EXIT：遇错停止，未提交事务在连接结束时回滚".into(),
                true,
            )));
        }
        return Err(invalid(
            "暂仅支持 WHENEVER SQLERROR EXIT [状态码] [ROLLBACK]",
        ));
    }
    if first == "SET" {
        let key = upper.get(1).map(String::as_str).unwrap_or("");
        if [
            "DEFINE",
            "ECHO",
            "VERIFY",
            "FEEDBACK",
            "HEADING",
            "PAGESIZE",
            "LINESIZE",
            "TIMING",
            "TERMOUT",
            "SQLBLANKLINES",
        ]
        .contains(&key)
        {
            let value = upper.get(2).map(String::as_str).unwrap_or("");
            if upper.len() != 3
                || !(matches!(value, "ON" | "OFF")
                    || matches!(key, "PAGESIZE" | "LINESIZE") && value.parse::<u32>().is_ok())
                || key == "DEFINE" && value != "OFF"
            {
                return Err(invalid(format!(
                    "不支持客户端设置 {text}；DEFINE 仅支持 OFF，不执行变量替换"
                )));
            }
            return Ok(Some((
                format!("已识别客户端设置 {} {}，不发送到服务器", words[1], words[2]),
                false,
            )));
        }
    }
    if matches!(first, "EXIT" | "QUIT") {
        if upper.iter().skip(1).all(|s| {
            s.parse::<i32>().is_ok() || matches!(s.as_str(), "SUCCESS" | "FAILURE" | "ROLLBACK")
        }) {
            return Ok(Some(("脚本结束；未提交事务回滚，不隐式提交".into(), false)));
        }
        return Err(invalid("EXIT/QUIT 不支持隐式 COMMIT，请显式提交事务"));
    }
    if first == "START"
        && upper
            .get(1)
            .is_some_and(|s| s.trim_end_matches(';') == "TRANSACTION")
    {
        return Ok(None);
    }
    if matches!(
        first,
        "SPOOL"
            | "CONNECT"
            | "CONN"
            | "HOST"
            | "SOURCE"
            | "START"
            | "DEFINE"
            | "UNDEFINE"
            | "ACCEPT"
    ) || text.starts_with('@')
        || text.starts_with('!')
    {
        return Err(invalid(
            "不支持文件包含、外部命令、交互输入或切换连接等客户端操作",
        ));
    }
    Ok(None)
}
pub fn tokens(sql: &str) -> AppResult<Vec<Token>> {
    Ok(Tokenizer::new(&GenericDialect {}, sql)
        .tokenize()
        .map_err(|e| invalid(format!("达梦脚本词法错误：{e}")))?
        .into_iter()
        .filter(|t| !matches!(t, Token::Whitespace(_)))
        .collect())
}
pub fn first(sql: &str) -> AppResult<String> {
    Ok(tokens(sql)?
        .first()
        .and_then(|t| {
            if let Token::Word(w) = t {
                Some(w.value.to_ascii_uppercase())
            } else {
                None
            }
        })
        .unwrap_or_default())
}
pub fn inspect(s: &Statement, current: &mut String) -> AppResult<()> {
    let t = tokens(&s.sql)?;
    let first = first(&s.sql)?;
    if first == "SAVEPOINT"
        || matches!(first.as_str(), "COMMIT" | "ROLLBACK")
            && !(t.len() == 1
                || t.len() == 2
                    && t.get(1).is_some_and(
                        |t| matches!(t,Token::Word(w)if w.value.eq_ignore_ascii_case("WORK")),
                    ))
    {
        return Err(invalid(format!(
            "第 {} 行：脚本暂仅支持完整 COMMIT/ROLLBACK，不支持保存点或其他事务后缀",
            s.line
        )));
    }
    if ![
        "SELECT",
        "WITH",
        "INSERT",
        "UPDATE",
        "DELETE",
        "MERGE",
        "CREATE",
        "ALTER",
        "DROP",
        "TRUNCATE",
        "COMMENT",
        "GRANT",
        "REVOKE",
        "CALL",
        "BEGIN",
        "DECLARE",
        "COMMIT",
        "ROLLBACK",
        "SAVEPOINT",
        "START",
        "SET",
        "EXPLAIN",
        "PRINT",
    ]
    .contains(&first.as_str())
    {
        return Err(invalid(format!(
            "第 {} 行：不支持 SQL/客户端指令 {first}",
            s.line
        )));
    }
    if first == "SET"
        && t.get(1)
            .is_some_and(|v| matches!(v,Token::Word(w)if w.value.eq_ignore_ascii_case("SCHEMA")))
    {
        match t.get(2) {
            Some(Token::Word(w)) if t.len() == 3 => *current = w.value.clone(),
            Some(Token::SingleQuotedString(w)) if t.len() == 3 => *current = w.clone(),
            _ => {
                return Err(invalid(format!(
                    "第 {} 行 SET SCHEMA 需要一个明确模式名",
                    s.line
                )))
            }
        }
    }
    Ok(())
}
#[derive(Debug)]
pub struct QueryPlan {
    pub statements: Vec<Statement>,
    pub notices: Vec<String>,
}
pub fn plan(sql: &str) -> AppResult<Option<QueryPlan>> {
    if sql.len() > 16 * 1024 * 1024 {
        return Err(invalid("查询脚本超过16 MiB，请使用SQL文件导入"));
    }
    let mut reader = Script::new(std::io::Cursor::new(sql.as_bytes()));
    let mut statements = vec![];
    let mut notices = vec![];
    while let Some(item) = reader.next()? {
        match item {
            Item::Sql(s) => statements.push(s),
            Item::Client { line, message, .. } => notices.push(format!("第 {line} 行：{message}")),
        }
    }
    if statements.len() == 1
        && notices.is_empty()
        && !sql.lines().any(|l| l.trim() == "/")
        && !matches!(first(&statements[0].sql)?.as_str(), "BEGIN" | "DECLARE")
        && !reader.after_block
    {
        return Ok(None);
    }
    Ok(Some(QueryPlan {
        statements,
        notices,
    }))
}
pub async fn run(
    c: &mut dm_rust::Connection,
    s: &Statement,
    limit: u32,
    ctx: &QueryContext,
) -> AppResult<QueryOutcome> {
    *ctx.conn_id.lock().await = Some(0);
    if let Some(on) = autocommit(&s.sql)? {
        if on {
            c.commit().await
        } else {
            c.begin().await
        }
        .map_err(|e| if on { AppError::WriteUncertain(format!("提交结果未确认：{e}")) } else { AppError::Database(e.to_string()) })?;
        return Ok(QueryOutcome {
            affected: Some(0),
            ..Default::default()
        });
    }
    let key = first(&s.sql)?;
    if key == "COMMIT" || key == "ROLLBACK" {
        if key == "COMMIT" {
            c.commit().await
        } else {
            c.rollback().await
        }
        .map_err(|e| AppError::WriteUncertain(e.to_string()))?;
        return Ok(QueryOutcome {
            affected: Some(0),
            ..Default::default()
        });
    }
    let rows = matches!(key.as_str(), "SELECT" | "WITH");
    let sql = if rows {
        format!(
            "SELECT * FROM ({}) AS _dw_dm_script LIMIT {}",
            s.sql.trim_end_matches(';'),
            limit.clamp(1, 5000)
        )
    } else {
        s.sql.clone()
    };
    let future = async {
        if rows {
            c.query(&sql, &[])
                .await
                .map(|r| crate::adapters::dameng::outcome(r, true))
        } else {
            c.execute(&sql, &[]).await.map(|r| QueryOutcome {
                affected: Some(r.rows_affected.max(0) as u64),
                ..Default::default()
            })
        }
    };
    tokio::pin!(future);
    loop {
        tokio::select! {r=&mut future=>return r.map_err(|e|match e{dm_rust::Error::Server{..}=>AppError::Database(format!("达梦：{e}")),_=>AppError::WriteUncertain(format!("达梦连接中断或超时，结果待核对，不会自动重试：{e}"))}),_=tokio::time::sleep(std::time::Duration::from_millis(50))=>if ctx.is_cancelled(){return Err(if rows{AppError::Cancelled("查询已取消".into())}else{AppError::WriteUncertain("已停止等待当前语句；写入结果尚未确认，请核对服务器".into())});}}
    }
}

pub fn autocommit(sql: &str) -> AppResult<Option<bool>> {
    let w = tokens(sql)?
        .iter()
        .map(|t| t.to_string().to_ascii_uppercase())
        .collect::<Vec<_>>();
    if w.as_slice() == ["BEGIN", "TRANSACTION"]
        || w.as_slice() == ["BEGIN", "TRAN"]
        || w.as_slice() == ["START", "TRANSACTION"]
    {
        return Ok(Some(false));
    }
    if w.first().is_some_and(|s| s == "SET") && w.get(1).is_some_and(|s| s == "AUTOCOMMIT") {
        let values = w.iter().skip(2).filter(|s| *s != "=").collect::<Vec<_>>();
        if values.len() == 1 {
            return match values[0].as_str() {
                "ON" | "1" => Ok(Some(true)),
                "OFF" | "0" => Ok(Some(false)),
                _ => Err(invalid("AUTOCOMMIT 仅支持 ON/OFF 或 1/0")),
            };
        }
        return Err(invalid("AUTOCOMMIT 需要一个明确的 ON/OFF 值"));
    }
    Ok(None)
}
pub fn preflight(plan: &QueryPlan, database: &str, read_only: bool, force: bool) -> AppResult<()> {
    let mut current = database.to_string();
    for s in &plan.statements {
        inspect(s, &mut current)?;
        autocommit(&s.sql)?;
        if read_only {
            super::readonly::sql(crate::meta::Engine::Dameng, &s.sql)
                .map_err(|e| invalid(format!("第 {} 行：{e}；整段未执行", s.line)))?;
        }
        if !force {
            if let Some(reason) =
                super::sql_risk::danger_reason(crate::meta::Engine::Dameng, &s.sql)
            {
                return Err(AppError::Dangerous(format!("第 {} 行：{reason}", s.line)));
            }
        }
    }
    Ok(())
}
pub async fn execute_query(
    adapter: &dyn crate::adapters::DbAdapter,
    plan: &QueryPlan,
    database: &str,
    read_only: bool,
    limit: u32,
    ctx: &QueryContext,
) -> AppResult<QueryOutcome> {
    let mut c = adapter.dameng_connection(database, !read_only).await?;
    let mut result = QueryOutcome::default();
    let mut total = 0;
    for (index, s) in plan.statements.iter().enumerate() {
        if ctx.is_cancelled() {
            return Err(AppError::Cancelled(format!(
                "已在第 {} 条前停止；已提交修改保留",
                index + 1
            )));
        }
        match run(&mut c, s, limit, ctx).await {
            Ok(r) => {
                total += r.affected.unwrap_or(0);
                result = r;
            }
            Err(e) => {
                // A cancelled in-flight request may leave unread protocol data.
                // Drop that connection instead of issuing another command on it.
                if !matches!(
                    e,
                    AppError::WriteUncertain(_) | AppError::Cancelled(_) | AppError::Connection(_)
                ) {
                    let _ = c.rollback().await;
                }
                return Err(match e {
                    AppError::Cancelled(_) => AppError::Cancelled(format!(
                        "第 {} 条（第 {} 行）已停止等待；此前已提交修改保留",
                        index + 1,
                        s.line
                    )),
                    AppError::WriteUncertain(_) => AppError::WriteUncertain(format!(
                        "第 {} 条（第 {} 行）结果待核对：{e}；此前已提交修改保留",
                        index + 1,
                        s.line
                    )),
                    _ => AppError::Database(format!(
                        "第 {} 条（第 {} 行）失败：{e}；后续未执行，此前已提交修改保留",
                        index + 1,
                        s.line
                    )),
                });
            }
        }
    }
    c.rollback()
        .await
        .map_err(|e| AppError::WriteUncertain(format!("脚本事务收尾失败：{e}")))?;
    let _ = c.close().await;
    if result.columns.is_empty() {
        result.affected = Some(total);
    }
    result.script_statements = Some(plan.statements.len());
    result.notices = Some(plan.notices.clone());
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn read(s: &str) -> AppResult<Vec<Item>> {
        let mut r = Script::new(std::io::Cursor::new(s));
        let mut v = vec![];
        while let Some(i) = r.next()? {
            v.push(i);
        }
        Ok(v)
    }
    #[test]
    fn disql_and_blocks() {
        let v=read("-- h\nWHENEVER SQLERROR EXIT 1\nSET DEFINE OFF\nSET ECHO OFF\nSET SCHEMA \"X\";\nCREATE OR REPLACE TRIGGER T BEFORE INSERT ON A FOR EACH ROW\nBEGIN\nIF :NEW.ID>0 THEN NULL; END IF;\nBEGIN NULL; END;\nEND;\n/\nCOMMIT;\nPROMPT DM8_IMPORT_OK_AGENT\n").unwrap();
        assert_eq!(v.len(), 7);
        let sql = v
            .iter()
            .filter_map(|i| if let Item::Sql(s) = i { Some(s) } else { None })
            .collect::<Vec<_>>();
        assert_eq!(sql.len(), 3);
        assert_eq!(sql[0].line, 5);
        assert!(sql[1].sql.ends_with("END;"));
        assert!(!sql[1].sql.contains("/"));
    }
    #[test]
    fn quotes_comments_and_fail_closed() {
        assert_eq!(
            read("SELECT 'it''s; -- /' FROM DUAL; /* x; */ SELECT 2 FROM DUAL;")
                .unwrap()
                .len(),
            2
        );
        for s in [
            "SET DEFINE ON\nSELECT 1 FROM DUAL;",
            "SPOOL x\n",
            "@other.sql\n",
            "BEGIN NULL;",
            "SELECT 'x",
            "SELECT 1 FROM DUAL;\n/\n",
            "EXIT\nDROP TABLE T;",
            "EXIT;\nDROP TABLE T;",
            "QUIT;\nSELECT 1 FROM DUAL;",
        ] {
            assert!(read(s).is_err(), "{s}");
        }
        assert_eq!(
            read("BEGIN IF 1=1 THEN NULL; END IF; END;\n/")
                .unwrap()
                .len(),
            1
        );
    }
    #[test]
    fn bom_case_and_local_procedures() {
        assert_eq!(read("\u{feff}SELECT 1 FROM DUAL;").unwrap().len(), 1);
        assert_eq!(
            read("BEGIN CASE WHEN 1=1 THEN NULL; END CASE; END;\n/")
                .unwrap()
                .len(),
            1
        );
        assert_eq!(read("CREATE PROCEDURE OUTER_P AS\n PROCEDURE INNER_P AS BEGIN NULL; END;\nBEGIN INNER_P(); END;\n/\nSELECT 1 FROM DUAL;").unwrap().len(),2);
    }
    #[test]
    fn case_and_transaction() {
        assert_eq!(
            read("START TRANSACTION; SELECT 2 FROM DUAL; COMMIT;")
                .unwrap()
                .len(),
            3
        );
        assert_eq!(
            read("SET AUTOCOMMIT OFF\nINSERT INTO T VALUES(1);\nROLLBACK;")
                .unwrap()
                .len(),
            3
        );
        assert_eq!(
            read("BEGIN TRANSACTION; INSERT INTO T VALUES(1); ROLLBACK;")
                .unwrap()
                .len(),
            3
        );
        assert_eq!(
            read("BEGIN x:=CASE WHEN 1=1 THEN 2 ELSE 3 END; END;\n/")
                .unwrap()
                .len(),
            1
        );
    }
}
