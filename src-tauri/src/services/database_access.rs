//! Client-side MySQL scope guard. This is not a replacement for server grants:
//! views, triggers and functions can have dependencies invisible in submitted SQL.
use crate::{
    error::{AppError, AppResult},
    meta::Engine,
};
use std::collections::HashSet;

fn denied(message: &str) -> AppError {
    AppError::InvalidInput(format!("数据库访问范围限制：{message}"))
}
pub fn validate(
    engine: Engine,
    allowed: Option<&[String]>,
    default: Option<&str>,
) -> AppResult<()> {
    if let Some(names) = allowed {
        if engine != Engine::Mysql {
            return Err(denied("目前仅 MySQL 会话支持数据库白名单"));
        }
        if names.is_empty()
            || names.len() > 500
            || names
                .iter()
                .any(|n| n.trim() != n || n.is_empty() || n.contains('\0'))
        {
            return Err(denied(
                "请填写至少一个完整数据库名（每行一个，最多 500 个）",
            ));
        }
        if let Some(db) = default.filter(|s| !s.trim().is_empty()) {
            check(allowed, db.trim())?;
        }
    }
    Ok(())
}
pub fn check(allowed: Option<&[String]>, database: &str) -> AppResult<()> {
    if let Some(names) = allowed {
        if !names.iter().any(|name| name == database) {
            return Err(denied(&format!("数据库「{database}」未在本会话允许列表中")));
        }
    }
    Ok(())
}

#[derive(Debug)]
struct Token {
    text: String,
    quoted: bool,
}
impl Token {
    fn is(&self, word: &str) -> bool {
        !self.quoted && self.text.eq_ignore_ascii_case(word)
    }
    fn ident(&self) -> bool {
        self.quoted
            || self
                .text
                .chars()
                .next()
                .is_some_and(|c| c.is_alphabetic() || c == '_' || c == '$')
    }
}
fn tokens(sql: &str) -> AppResult<Vec<Token>> {
    let c: Vec<char> = sql.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < c.len() {
        if c[i].is_whitespace() {
            i += 1;
            continue;
        }
        if c[i] == '#'
            || (c[i] == '-'
                && c.get(i + 1) == Some(&'-')
                && c.get(i + 2).is_none_or(|x| x.is_whitespace()))
        {
            while i < c.len() && c[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if c[i] == '/' && c.get(i + 1) == Some(&'*') {
            if matches!(c.get(i + 2), Some('!' | '+' | 'M' | 'm')) {
                return Err(denied("受限会话不接受可执行注释或优化器提示"));
            }
            i += 2;
            let mut closed = false;
            while i + 1 < c.len() {
                if c[i] == '/' && c[i + 1] == '*' {
                    return Err(denied("不接受嵌套注释"));
                }
                if c[i] == '*' && c[i + 1] == '/' {
                    i += 2;
                    closed = true;
                    break;
                }
                i += 1;
            }
            if !closed {
                return Err(denied("SQL 注释未闭合"));
            }
            continue;
        }
        if matches!(c[i], '\'' | '"' | '`') {
            let quote = c[i];
            i += 1;
            let mut value = String::new();
            let mut closed = false;
            while i < c.len() {
                if c[i] == '\\' {
                    return Err(denied(
                        "受限会话不接受含反斜杠转义的 SQL，请使用绑定参数或双写引号",
                    ));
                }
                if c[i] == quote {
                    if c.get(i + 1) == Some(&quote) {
                        value.push(quote);
                        i += 2;
                        continue;
                    }
                    i += 1;
                    closed = true;
                    break;
                }
                value.push(c[i]);
                i += 1;
            }
            if !closed {
                return Err(denied("SQL 引号未闭合"));
            }
            out.push(Token {
                text: if quote == '\'' { String::new() } else { value },
                quoted: quote != '\'',
            });
            continue;
        }
        if c[i].is_alphanumeric() || c[i] == '_' || c[i] == '$' {
            let start = i;
            while i < c.len() && (c[i].is_alphanumeric() || c[i] == '_' || c[i] == '$') {
                i += 1;
            }
            out.push(Token {
                text: c[start..i].iter().collect(),
                quoted: false,
            });
            continue;
        }
        out.push(Token {
            text: c[i].to_string(),
            quoted: false,
        });
        i += 1;
    }
    while out.last().is_some_and(|t| t.is(";")) {
        out.pop();
    }
    if out.iter().any(|t| t.is(";")) {
        return Err(denied("请逐条执行 SQL，不能通过多语句切换数据库"));
    }
    Ok(out)
}

pub fn sql(allowed: Option<&[String]>, database: &str, text: &str) -> AppResult<()> {
    let Some(_) = allowed else {
        return Ok(());
    };
    check(allowed, database)?;
    let t = tokens(text)?;
    let first = t.first().ok_or_else(|| denied("SQL 为空"))?;
    let ddl = first.is("CREATE") || first.is("ALTER") || first.is("DROP");
    if ddl {
        let object = t.iter().skip(1).find(|x| {
            !x.is("TEMPORARY") && !x.is("UNIQUE") && !x.is("FULLTEXT") && !x.is("SPATIAL")
        });
        if !object.is_some_and(|x| x.is("TABLE") || x.is("INDEX")) {
            return Err(denied(
                "受限会话仅支持表及索引 DDL，不能执行数据库或服务器级命令",
            ));
        }
    } else if ![
        "SELECT", "WITH", "INSERT", "REPLACE", "UPDATE", "DELETE", "EXPLAIN", "DESCRIBE", "DESC",
        "TRUNCATE", "RENAME",
    ]
    .iter()
    .any(|w| first.is(w))
    {
        return Err(denied("该命令无法限定数据库范围；请使用数据库选择器，不执行 USE、SHOW、动态 SQL 或服务器管理命令"));
    }
    if t.iter().any(|x| {
        [
            "PREPARE",
            "EXECUTE",
            "CALL",
            "PROCEDURE",
            "TRIGGER",
            "EVENT",
            "FUNCTION",
            "OUTFILE",
            "DUMPFILE",
            "LOAD_FILE",
            "FEDERATED",
            "MRG_MYISAM",
        ]
        .iter()
        .any(|w| x.is(w))
    }) {
        return Err(denied("不允许动态 SQL、存储程序、文件访问或远程表"));
    }
    if t.iter().any(|x| x.is("{") || x.is("}"))
        || t.windows(2)
            .any(|w| w[0].is("FOR") && w[1].is("CONNECTION"))
    {
        return Err(denied("无法验证该扩展语法的数据库范围"));
    }
    let mut aliases = HashSet::new();
    let mut relation_list = false;
    let mut stack = Vec::new();
    for i in 0..t.len() {
        let x = &t[i];
        let group_start = x.is("(")
            && relation_list
            && i > 0
            && ["FROM", "JOIN", "STRAIGHT_JOIN", ",", "("]
                .iter()
                .any(|w| t[i - 1].is(w))
            && !t.get(i + 1).is_some_and(|w| w.is("SELECT") || w.is("WITH"));
        if x.is("(") {
            stack.push(relation_list);
            relation_list = group_start;
        }
        if x.is(")") {
            relation_list = stack.pop().unwrap_or(false);
        }
        if [
            "WHERE",
            "SET",
            "GROUP",
            "ORDER",
            "HAVING",
            "LIMIT",
            "UNION",
            "VALUES",
            "RETURNING",
        ]
        .iter()
        .any(|w| x.is(w))
        {
            relation_list = false;
        }
        if x.is("FROM")
            || x.is("JOIN")
            || x.is("STRAIGHT_JOIN")
            || x.is("UPDATE")
            || (x.is("TABLE") && (first.is("DROP") || first.is("RENAME")))
        {
            relation_list = true;
        }
        let relation = group_start
            || [
                "FROM",
                "JOIN",
                "STRAIGHT_JOIN",
                "UPDATE",
                "INTO",
                "REFERENCES",
                "TABLE",
            ]
            .iter()
            .any(|w| x.is(w))
            || (x.is(",") && relation_list)
            || (x.is("USING") && first.is("DELETE"))
            || (x.is("ON") && ddl && t.iter().take(i).any(|w| w.is("INDEX")))
            || (x.is("TO") && t.iter().take(i).any(|w| w.is("RENAME")))
            || (x.is("LIKE") && first.is("CREATE"))
            || (x.is("RENAME") && first.is("ALTER"))
            || (i == 0 && (first.is("INSERT") || first.is("REPLACE")))
            || (i == 0 && (first.is("DESC") || first.is("DESCRIBE") || first.is("TRUNCATE")));
        if relation {
            let mut j = i + 1;
            while t.get(j).is_some_and(|w| {
                [
                    "IF",
                    "NOT",
                    "EXISTS",
                    "ONLY",
                    "LOW_PRIORITY",
                    "DELAYED",
                    "HIGH_PRIORITY",
                    "IGNORE",
                    "TABLE",
                    "INTO",
                    "TO",
                ]
                .iter()
                .any(|k| w.is(k))
            }) {
                j += 1;
            }
            if t.get(j).is_some_and(Token::ident) {
                if t.get(j + 1).is_some_and(|w| w.is(".")) {
                    check(allowed, &t[j].text)?;
                    j += 2;
                }
                if let Some(name) = t.get(j).filter(|w| w.ident()) {
                    aliases.insert(name.text.clone());
                }
                j += 1;
                if t.get(j).is_some_and(|w| w.is("AS")) {
                    j += 1;
                }
                if let Some(alias) = t.get(j).filter(|w| w.ident()) {
                    aliases.insert(alias.text.clone());
                }
            }
        }
        // CTE / derived-table aliases; explicit table positions are independently checked above.
        if x.is("AS") && t.get(i + 1).is_some_and(Token::ident) {
            aliases.insert(t[i + 1].text.clone());
        }
        if x.is(")") && t.get(i + 1).is_some_and(Token::ident) {
            aliases.insert(t[i + 1].text.clone());
        }
    }
    for i in 0..t.len() {
        if t[i].ident() && t.get(i + 1).is_some_and(|x| x.is(".")) {
            let three = t.get(i + 3).is_some_and(|x| x.is("."));
            let routine = t.get(i + 3).is_some_and(|x| x.is("("));
            let preceding_dot = i > 0 && t[i - 1].is(".");
            if !preceding_dot && (three || routine || !aliases.contains(&t[i].text)) {
                check(allowed, &t[i].text)?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn allowlist_sql_and_bypasses() {
        let allow = vec!["test_db".into(), "test_two".into()];
        for q in [
            "SELECT 1",
            "SELECT a.id FROM test_db.t a JOIN test_two.u AS b ON a.id=b.id",
            "SELECT t.id FROM t",
            "WITH x AS (SELECT id FROM test_db.t) SELECT x.id FROM x",
            "SELECT 'prod.t' AS text",
            "UPDATE test_db.t SET value=? WHERE id=?",
            "CREATE TABLE test_db.t(id BIGINT)",
            "ALTER TABLE test_db.t ADD FOREIGN KEY(id) REFERENCES test_two.u(id)",
            "CREATE INDEX idx ON test_db.t(id)",
        ] {
            assert!(sql(Some(&allow), "test_db", q).is_ok(), "{q}");
        }
        for q in [
            "SELECT * FROM test_db.t prod STRAIGHT_JOIN prod.secret ON 1=1",
            "SELECT * FROM test_db.t prod JOIN (prod.secret) p ON 1=1",
            "SELECT * FROM test_db.t prod JOIN (test_db.t a, prod.secret) p ON 1=1",
            "INSERT prod.t SELECT 1 AS prod",
            "DROP TABLE test_db.prod, prod.t",
            "ALTER TABLE test_db.prod RENAME prod.t",
            "SELECT prod.fn() FROM test_db.t prod",
            "SELECT * FROM prod.t",
            "SELECT * FROM `prod`.`t`",
            "SELECT * FROM \"prod\".t",
            "SELECT test_db.t.id, prod.t.id FROM test_db.t",
            "SELECT * FROM test_db.t prod, prod.secret",
            "UPDATE prod.t SET a=1",
            "INSERT INTO test_db.t SELECT * FROM prod.t",
            "SELECT * FROM (SELECT * FROM prod.t) p",
            "ALTER TABLE test_db.t ADD FOREIGN KEY(id) REFERENCES prod.t(id)",
            "RENAME TABLE test_db.t TO prod.t",
            "CREATE TABLE t LIKE prod.t",
            "USE prod",
            "SHOW DATABASES",
            "CREATE DATABASE prod",
            "CALL test_db.proc()",
            "PREPARE stmt FROM 'SELECT * FROM prod.t'",
            "SELECT 1; SELECT * FROM prod.t",
            "SELECT 1 /*! INTO OUTFILE '/tmp/x' */",
            "SELECT * FROM information_schema.tables",
            "SELECT * FROM t WHERE x='a\\'",
            "SELECT * FROM t /* unclosed",
        ] {
            assert!(sql(Some(&allow), "test_db", q).is_err(), "{q}");
        }
        assert!(sql(Some(&allow), "prod", "SELECT 1").is_err());
        assert!(sql(None, "prod", "SHOW DATABASES").is_ok());
        assert!(check(Some(&[]), "test_db").is_err());
        assert!(check(Some(&allow), "TEST_DB").is_err());
    }
    #[tokio::test]
    async fn saved_scope_roundtrip_and_default_validation() {
        let dir = tempfile::tempdir().unwrap();
        let store = crate::store::LocalStore::initialize_in(dir.path().into())
            .await
            .unwrap();
        let mut input:crate::store::SessionInput=serde_json::from_value(serde_json::json!({"name":"范围测试","engine":"mysql","host":"127.0.0.1","readOnly":false,"allowedDatabases":["test_db"],"database":"test_db"})).unwrap();
        let record = store.create_session(&input).await.unwrap();
        assert_eq!(record.allowed_databases, Some(vec!["test_db".into()]));
        input.database = Some("prod".into());
        assert!(store.update_session(&record.id, &input).await.is_err());
        input.database = None;
        input.allowed_databases = Some(vec![]);
        assert!(store.update_session(&record.id, &input).await.is_err());
        input.allowed_databases = None;
        assert!(store
            .update_session(&record.id, &input)
            .await
            .unwrap()
            .allowed_databases
            .is_none());
    }
}
