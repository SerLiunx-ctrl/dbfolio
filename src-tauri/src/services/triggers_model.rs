//! 触发器结构化草稿：标识符统一引用，主体不能逃出唯一的 BEGIN / END 块。
use serde::{Deserialize, Serialize};
use sqlparser::{
    dialect::{Dialect, MySqlDialect, PostgreSqlDialect, SQLiteDialect},
    tokenizer::{Token, TokenWithSpan, Tokenizer, Whitespace},
};
use std::collections::HashSet;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TriggerDraft {
    pub timing: String,
    pub events: Vec<String>,
    pub orientation: String,
    pub body: String,
    pub function_schema: Option<String>,
    pub function_name: Option<String>,
}

fn dialect(engine: &str) -> Result<Box<dyn Dialect>, String> {
    match engine {
        "mysql" => Ok(Box::new(MySqlDialect {})),
        "postgres" => Ok(Box::new(PostgreSqlDialect {})),
        "sqlite" => Ok(Box::new(SQLiteDialect {})),
        _ => Err("触发器管理仅支持关系型数据库".into()),
    }
}
fn ident(value: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.contains('\0') || value.len() > 1024 {
        Err("对象名称不能为空、包含空字符或过长".into())
    } else {
        Ok(())
    }
}
pub fn quote(engine: &str, value: &str) -> String {
    if engine == "mysql" {
        format!("`{}`", value.replace('`', "``"))
    } else {
        format!("\"{}\"", value.replace('"', "\"\""))
    }
}
pub fn validate_target(
    engine: &str,
    database: &str,
    schema: Option<&str>,
    table: &str,
    name: &str,
) -> Result<(), String> {
    dialect(engine)?;
    for value in [database, table, name] {
        ident(value)?;
    }
    if let Some(schema) = schema {
        ident(schema)?;
    }
    match engine {
        "mysql" if schema.is_some_and(|s| s != database) => {
            Err("MySQL 触发器的 schema 必须与当前数据库一致".into())
        }
        "sqlite" if database != "main" || schema.is_some_and(|s| s != "main") => {
            Err("SQLite 触发器管理仅支持当前 main 数据库".into())
        }
        _ => Ok(()),
    }
}
fn tokens(engine: &str, value: &str) -> Result<Vec<TokenWithSpan>, String> {
    let dialect = dialect(engine)?;
    let parsed = Tokenizer::new(dialect.as_ref(), value)
        .tokenize_with_location()
        .map_err(|e| format!("触发器 SQL 词法错误：{e}"))?;
    if engine == "mysql" && parsed.iter().any(|t| matches!(&t.token, Token::Whitespace(Whitespace::MultiLineComment(s)) if s.starts_with('!') || s.to_ascii_uppercase().starts_with("M!"))) {
        return Err("触发器主体不接受 MySQL / MariaDB 可执行注释，请展开为明确 SQL".into());
    }
    Ok(parsed
        .into_iter()
        .filter(|t| !matches!(t.token, Token::Whitespace(_) | Token::EOF))
        .collect())
}
fn word(tokens: &[TokenWithSpan], i: usize) -> String {
    // NEW.end / OLD.case 等限定字段可以使用关键字，不能视作块边界。
    if i > 0 && matches!(tokens[i - 1].token, Token::Period) {
        return String::new();
    }
    match tokens.get(i).map(|t| &t.token) {
        Some(Token::Word(w)) if w.quote_style.is_none() => w.value.to_ascii_uppercase(),
        _ => String::new(),
    }
}
fn is_identifier(token: Option<&TokenWithSpan>) -> bool {
    matches!(
        token.map(|t| &t.token),
        Some(Token::Word(_) | Token::SingleQuotedString(_))
    )
}
fn skip_name(tokens: &[TokenWithSpan], i: &mut usize) -> bool {
    if !is_identifier(tokens.get(*i)) {
        return false;
    }
    *i += 1;
    if matches!(tokens.get(*i).map(|t| &t.token), Some(Token::Period)) {
        *i += 1;
        if !is_identifier(tokens.get(*i)) {
            return false;
        }
        *i += 1;
    }
    true
}

/// 这里只校验主体边界，实际语法及触发器语义仍由目标服务器预检/事务执行验证。
pub fn validate_body(engine: &str, body: &str) -> Result<(), String> {
    if !matches!(engine, "mysql" | "sqlite") {
        return Err("当前引擎不使用 SQL 主体创建触发器".into());
    }
    if body.contains('\0') {
        return Err("触发器主体不能包含空字符".into());
    }
    let ts = tokens(engine, body)?;
    if word(&ts, 0) != "BEGIN" {
        return Err("触发器主体应填写完整的 BEGIN … END 块".into());
    }
    let mut stack: Vec<String> = vec![];
    let mut i = 0;
    while i < ts.len() {
        let w = word(&ts, i);
        if w == "DELIMITER" {
            return Err("不要填写 DELIMITER 指令，只填写触发器主体".into());
        }
        if w == "END" {
            let previous = stack.pop().ok_or("触发器主体有多余的 END")?;
            let suffix = word(&ts, i + 1);
            if ["IF", "CASE", "LOOP", "WHILE", "REPEAT"].contains(&suffix.as_str()) {
                if previous != suffix {
                    return Err("触发器主体的控制块结束类型不匹配".into());
                }
                i += 1;
            } else if previous != "BEGIN" && previous != "CASE" {
                return Err("触发器主体的控制块未正确闭合".into());
            }
            if stack.is_empty() {
                let tail = &ts[i + 1..];
                return if tail.is_empty()
                    || (tail.len() == 1 && matches!(tail[0].token, Token::SemiColon))
                {
                    Ok(())
                } else {
                    Err("END 后不能夹带其他 SQL 或额外分隔符".into())
                };
            }
            i += 1;
            continue;
        }
        let control_if = if w == "IF" {
            if matches!(ts.get(i + 1).map(|t| &t.token), Some(Token::LParen)) {
                let mut depth = 0usize;
                let mut end = None;
                for (n, t) in ts.iter().enumerate().skip(i + 1) {
                    match t.token {
                        Token::LParen => depth += 1,
                        Token::RParen => {
                            depth = depth.saturating_sub(1);
                            if depth == 0 {
                                end = Some(n);
                                break;
                            }
                        }
                        _ => {}
                    }
                }
                end.is_some_and(|n| word(&ts, n + 1) == "THEN")
            } else {
                (i + 1..ts.len())
                    .take_while(|n| !matches!(ts[*n].token, Token::SemiColon))
                    .any(|n| word(&ts, n) == "THEN")
            }
        } else {
            false
        };
        if w == "BEGIN"
            || w == "CASE"
            || w == "LOOP"
            || w == "WHILE"
            || (w == "REPEAT" && !matches!(ts.get(i + 1).map(|t| &t.token), Some(Token::LParen)))
            || control_if
        {
            stack.push(w);
        }
        i += 1;
    }
    Err("触发器主体的 BEGIN / END 或控制块未闭合".into())
}

pub fn build(
    engine: &str,
    version: &str,
    database: &str,
    schema: Option<&str>,
    table: &str,
    name: &str,
    draft: &TriggerDraft,
) -> Result<String, String> {
    validate_target(engine, database, schema, table, name)?;
    let timing = draft.timing.trim().to_ascii_uppercase();
    let orientation = draft.orientation.trim().to_ascii_uppercase();
    let events: Vec<_> = draft
        .events
        .iter()
        .map(|v| v.trim().to_ascii_uppercase())
        .collect();
    if events.is_empty()
        || events.iter().collect::<HashSet<_>>().len() != events.len()
        || events
            .iter()
            .any(|v| !["INSERT", "UPDATE", "DELETE", "TRUNCATE"].contains(&v.as_str()))
    {
        return Err("请选择有效且不重复的触发事件".into());
    }
    if !["BEFORE", "AFTER", "INSTEAD OF"].contains(&timing.as_str())
        || !["ROW", "STATEMENT"].contains(&orientation.as_str())
    {
        return Err("触发时机或执行粒度无效".into());
    }
    if engine == "postgres" {
        if !draft.body.trim().is_empty() {
            return Err("PostgreSQL 触发器通过已有触发器函数执行，不填写 SQL 主体".into());
        }
        if timing == "INSTEAD OF" && orientation != "ROW" {
            return Err("INSTEAD OF 触发器必须逐行执行".into());
        }
        if events.iter().any(|v| v == "TRUNCATE") && orientation != "STATEMENT" {
            return Err("TRUNCATE 触发器必须按语句执行".into());
        }
        let function_schema = draft
            .function_schema
            .as_deref()
            .ok_or("请选择触发器函数的 schema")?;
        let function_name = draft
            .function_name
            .as_deref()
            .ok_or("请选择已有触发器函数")?;
        ident(function_schema)?;
        ident(function_name)?;
        let major = version
            .split(|c: char| !c.is_ascii_digit())
            .find(|s| !s.is_empty())
            .and_then(|s| s.parse::<u32>().ok())
            .filter(|v| *v > 0)
            .ok_or("无法识别 PostgreSQL 版本，请刷新会话后重试")?;
        let execute = if major >= 11 { "FUNCTION" } else { "PROCEDURE" };
        return Ok(format!(
            "CREATE TRIGGER {} {} {} ON {}.{}\nFOR EACH {} EXECUTE {} {}.{}()",
            quote(engine, name),
            timing,
            events.join(" OR "),
            quote(engine, schema.unwrap_or("public")),
            quote(engine, table),
            orientation,
            execute,
            quote(engine, function_schema),
            quote(engine, function_name)
        ));
    }
    if events.len() != 1 || events[0] == "TRUNCATE" || orientation != "ROW" {
        return Err(
            "MySQL / SQLite 触发器仅支持单个 INSERT / UPDATE / DELETE 事件并逐行执行".into(),
        );
    }
    if engine == "mysql" && timing == "INSTEAD OF" {
        return Err("MySQL 不支持 INSTEAD OF 触发器".into());
    }
    if draft
        .function_name
        .as_deref()
        .is_some_and(|s| !s.trim().is_empty())
        || draft
            .function_schema
            .as_deref()
            .is_some_and(|s| !s.trim().is_empty())
    {
        return Err("该引擎使用 SQL 主体，不使用 PostgreSQL 触发器函数".into());
    }
    validate_body(engine, &draft.body)?;
    let trigger = format!("{}.{}", quote(engine, database), quote(engine, name));
    let target = if engine == "mysql" {
        format!("{}.{}", quote(engine, database), quote(engine, table))
    } else {
        quote(engine, table)
    };
    Ok(format!(
        "CREATE TRIGGER {trigger} {timing} {} ON {target}\nFOR EACH ROW\n{}",
        events[0],
        draft.body.trim()
    ))
}

fn offset(text: &str, line: u64, column: u64) -> usize {
    let start = text
        .split_inclusive('\n')
        .take(line.saturating_sub(1) as usize)
        .map(str::len)
        .sum::<usize>();
    start
        + text[start..]
            .char_indices()
            .nth(column.saturating_sub(1) as usize)
            .map(|(i, _)| i)
            .unwrap_or(text.len() - start)
}
struct SqliteHeader {
    timing: String,
    event: String,
    body: usize,
    simple: bool,
}
fn sqlite_header(sql: &str) -> Option<SqliteHeader> {
    let ts = tokens("sqlite", sql).ok()?;
    if word(&ts, 0) != "CREATE" {
        return None;
    }
    let mut i = 1;
    let mut simple = true;
    if ["TEMP", "TEMPORARY"].contains(&word(&ts, i).as_str()) {
        simple = false;
        i += 1;
    }
    if word(&ts, i) != "TRIGGER" {
        return None;
    }
    i += 1;
    if word(&ts, i) == "IF" {
        if word(&ts, i + 1) != "NOT" || word(&ts, i + 2) != "EXISTS" {
            return None;
        }
        i += 3;
    }
    if !skip_name(&ts, &mut i) {
        return None;
    }
    let timing = match word(&ts, i).as_str() {
        "BEFORE" => {
            i += 1;
            "BEFORE"
        }
        "AFTER" => {
            i += 1;
            "AFTER"
        }
        "INSTEAD" if word(&ts, i + 1) == "OF" => {
            i += 2;
            "INSTEAD OF"
        }
        _ => "BEFORE",
    }
    .to_owned();
    let event = word(&ts, i);
    if !["INSERT", "UPDATE", "DELETE"].contains(&event.as_str()) {
        return None;
    }
    i += 1;
    if event == "UPDATE" && word(&ts, i) == "OF" {
        simple = false;
        while i < ts.len() && word(&ts, i) != "ON" {
            i += 1;
        }
    }
    if word(&ts, i) != "ON" {
        return None;
    }
    i += 1;
    if !skip_name(&ts, &mut i) {
        return None;
    }
    if word(&ts, i) == "FOR" && word(&ts, i + 1) == "EACH" && word(&ts, i + 2) == "ROW" {
        i += 3;
    }
    if word(&ts, i) != "BEGIN" {
        simple = false;
    }
    let body = (i..ts.len()).find(|n| word(&ts, *n) == "BEGIN")?;
    Some(SqliteHeader {
        timing,
        event,
        body: offset(sql, ts[body].span.start.line, ts[body].span.start.column),
        simple,
    })
}
pub fn sqlite_summary(sql: &str) -> (String, String) {
    sqlite_header(sql)
        .map(|h| (h.timing, h.event))
        .unwrap_or_else(|| ("未知".into(), "未知".into()))
}
pub fn sqlite_draft(sql: &str) -> Option<TriggerDraft> {
    let h = sqlite_header(sql)?;
    if !h.simple {
        return None;
    }
    let body = sql[h.body..].trim().to_owned();
    validate_body("sqlite", &body).ok()?;
    Some(TriggerDraft {
        timing: h.timing,
        events: vec![h.event],
        orientation: "ROW".into(),
        body,
        function_schema: None,
        function_name: None,
    })
}

/// SHOW CREATE 的前缀只用于恢复原 DEFINER，OR REPLACE 不保留，避免覆盖并发新建对象。
pub fn mysql_prefix(sql: &str) -> Option<String> {
    let ts = tokens("mysql", sql).ok()?;
    if word(&ts, 0) != "CREATE" {
        return None;
    }
    let mut i = 1;
    if word(&ts, i) == "OR" && word(&ts, i + 1) == "REPLACE" {
        i += 2;
    }
    if word(&ts, i) == "TRIGGER" {
        return Some("CREATE ".into());
    }
    if word(&ts, i) != "DEFINER" || !matches!(ts.get(i + 1).map(|t| &t.token), Some(Token::Eq)) {
        return None;
    }
    let start = offset(sql, ts[i].span.start.line, ts[i].span.start.column);
    i += 2;
    if !is_identifier(ts.get(i)) {
        return None;
    }
    i += 1;
    if !matches!(ts.get(i).map(|t| &t.token), Some(Token::AtSign)) {
        return None;
    }
    i += 1;
    if !is_identifier(ts.get(i)) {
        return None;
    }
    i += 1;
    if word(&ts, i) != "TRIGGER" {
        return None;
    }
    let end = offset(sql, ts[i].span.start.line, ts[i].span.start.column);
    Some(format!("CREATE {} ", sql[start..end].trim()))
}
pub fn pg_complex(sql: &str) -> bool {
    let Ok(ts) = tokens("postgres", sql) else {
        return true;
    };
    if word(&ts, 0) != "CREATE" {
        return true;
    }
    (0..ts.len()).any(|i| {
        ["CONSTRAINT", "REFERENCING", "WHEN"].contains(&word(&ts, i).as_str())
            || (word(&ts, i) == "UPDATE" && word(&ts, i + 1) == "OF")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn draft(body: &str) -> TriggerDraft {
        TriggerDraft {
            timing: "AFTER".into(),
            events: vec!["INSERT".into()],
            orientation: "ROW".into(),
            body: body.into(),
            function_schema: None,
            function_name: None,
        }
    }
    #[test]
    fn blocks_keep_strings_comments_and_control_blocks_inside() {
        for (engine, body) in [
            ("sqlite", "BEGIN INSERT INTO audit VALUES ('END; DROP TABLE t;'); -- END\n SELECT CASE WHEN 1=1 THEN '中文' ELSE 'x' END; END; /*末尾说明*/"),
            ("mysql", "BEGIN IF (NEW.x > 0) THEN SET NEW.x = IF(NEW.x > 2, CASE WHEN 1 THEN 2 ELSE 1 END, 0); ELSE SET NEW.x=REPEAT('END;',2); END IF; END"),
            ("mysql", "BEGIN label1: WHILE NEW.x<10 DO SET NEW.x=NEW.x+1; END WHILE label1; label2: LOOP LEAVE label2; END LOOP label2; REPEAT SET NEW.x=NEW.x+1; UNTIL NEW.x>20 END REPEAT; CASE NEW.x WHEN 20 THEN SET NEW.x=21; END CASE; END"),
            ("mysql", "BEGIN SET NEW.end=1, NEW.case=CASE WHEN OLD.begin>0 THEN 1 ELSE 0 END, NEW.delimiter='x'; END"),
        ] { assert!(validate_body(engine, body).is_ok(), "{engine}: {body}"); }
    }
    #[test]
    fn trailing_sql_and_executable_comments_are_rejected() {
        for body in [
            "SELECT 1",
            "BEGIN SELECT 1; END; DROP TABLE victims",
            "BEGIN SELECT 1; END END",
            "BEGIN SELECT 1; END;;",
            "BEGIN SELECT 'x';",
            "BEGIN IF NEW.x THEN SET NEW.x=1; END;",
            "BEGIN SELECT 1; END IF;",
            "BEGIN SELECT 1; END; DELIMITER $$",
        ] {
            assert!(validate_body("mysql", body).is_err(), "{body}");
        }
        for body in [
            "BEGIN /*!50000 DROP TABLE victims */ SELECT 1; END",
            "BEGIN /*M!100100 SET NEW.x=1 */ SELECT 1; END",
        ] {
            assert!(validate_body("mysql", body).is_err());
        }
        assert!(validate_body("sqlite", "BEGIN SELECT 'BEGIN\0END'; END").is_err());
    }
    #[test]
    fn quotes_all_targets_and_enforces_engine_scopes() {
        let d = draft("BEGIN SELECT 1; END");
        let sql = build("sqlite", "3.46", "main", None, "表\"名", "触发\"器", &d).unwrap();
        assert!(
            sql.starts_with("CREATE TRIGGER \"main\".\"触发\"\"器\" AFTER INSERT ON \"表\"\"名\"")
        );
        let sql = build("mysql", "8.4", "a`b", None, "x`y", "z`q", &d).unwrap();
        assert!(sql.starts_with("CREATE TRIGGER `a``b`.`z``q` AFTER INSERT ON `a``b`.`x``y`"));
        for (e, db, schema) in [
            ("sqlite", "other", None),
            ("sqlite", "main", Some("temp")),
            ("mysql", "db", Some("other")),
            ("redis", "db", None),
        ] {
            assert!(build(e, "16", db, schema, "t", "tr", &d).is_err());
        }
        for name in ["", "  ", "x\0y"] {
            assert!(build("sqlite", "3", "main", None, "t", name, &d).is_err());
        }
    }
    #[test]
    fn rejects_unsupported_events_and_granularity() {
        let mut d = draft("BEGIN SELECT 1; END");
        d.events = vec!["INSERT".into(), "insert".into()];
        assert!(build("mysql", "8", "db", None, "t", "tr", &d).is_err());
        d.events = vec!["DELETE".into(), "UPDATE".into()];
        assert!(build("sqlite", "3", "main", None, "t", "tr", &d).is_err());
        d.events = vec!["TRUNCATE".into()];
        assert!(build("sqlite", "3", "main", None, "t", "tr", &d).is_err());
        d.events = vec!["INSERT".into()];
        d.orientation = "STATEMENT".into();
        assert!(build("mysql", "8", "db", None, "t", "tr", &d).is_err());
        d.orientation = "ROW".into();
        d.timing = "INSTEAD OF".into();
        assert!(build("mysql", "8", "db", None, "t", "tr", &d).is_err());
        assert!(build("sqlite", "3", "main", None, "v", "tr", &d).is_ok());
    }
    #[test]
    fn postgres_versions_and_functions_are_preserved() {
        let mut d = draft("");
        d.function_schema = Some("fn\"schema".into());
        d.function_name = Some("fn\"name".into());
        d.events = vec!["INSERT".into(), "UPDATE".into()];
        let sql = build(
            "postgres",
            "PostgreSQL 16.3",
            "db",
            Some("Case.Schema"),
            "items",
            "tr",
            &d,
        )
        .unwrap();
        assert!(sql.contains("AFTER INSERT OR UPDATE ON \"Case.Schema\".\"items\""));
        assert!(sql.ends_with("EXECUTE FUNCTION \"fn\"\"schema\".\"fn\"\"name\"()"));
        assert!(build(
            "postgres",
            "PostgreSQL 9.6.24",
            "db",
            None,
            "items",
            "tr",
            &d
        )
        .unwrap()
        .contains("EXECUTE PROCEDURE"));
        assert!(build("postgres", "unknown", "db", None, "items", "tr", &d).is_err());
        d.events = vec!["TRUNCATE".into()];
        assert!(build("postgres", "16", "db", None, "items", "tr", &d).is_err());
        d.orientation = "STATEMENT".into();
        assert!(build("postgres", "16", "db", None, "items", "tr", &d).is_ok());
        d.timing = "INSTEAD OF".into();
        assert!(build("postgres", "16", "db", None, "items", "tr", &d).is_err());
        d.events = vec!["UPDATE".into()];
        d.orientation = "ROW".into();
        assert!(build("postgres", "16", "db", None, "v", "tr", &d).is_ok());
        d.body = "SELECT 1".into();
        assert!(build("postgres", "16", "db", None, "v", "tr", &d).is_err());
    }
    #[test]
    fn sqlite_readback_keeps_body_and_marks_complex_definitions() {
        let sql="CREATE TRIGGER \"AFTER\" AFTER INSERT ON \"BEGIN\" FOR EACH ROW\nBEGIN INSERT INTO audit VALUES ('中文 END;'); END";
        let d = sqlite_draft(sql).unwrap();
        assert_eq!(d.timing, "AFTER");
        assert_eq!(d.body, "BEGIN INSERT INTO audit VALUES ('中文 END;'); END");
        for sql in [
            "CREATE TRIGGER tr UPDATE OF a,b ON t BEGIN SELECT 1; END",
            "CREATE TRIGGER tr INSTEAD OF DELETE ON v WHEN OLD.x>0 BEGIN SELECT 1; END",
            "CREATE TEMP TRIGGER tr AFTER INSERT ON main.t BEGIN SELECT 1; END",
        ] {
            assert!(sqlite_draft(sql).is_none());
        }
        assert_eq!(
            sqlite_summary("CREATE TRIGGER tr UPDATE OF a ON t WHEN OLD.a>0 BEGIN SELECT 1; END"),
            ("BEFORE".into(), "UPDATE".into())
        );
        assert_eq!(
            sqlite_summary(
                "CREATE TRIGGER tr INSTEAD OF DELETE ON v WHEN OLD.x>0 BEGIN SELECT 1; END"
            ),
            ("INSTEAD OF".into(), "DELETE".into())
        );
    }
    #[test]
    fn server_definer_prefix_and_postgres_complex_flags() {
        assert_eq!(mysql_prefix("CREATE DEFINER=`root`@`localhost` TRIGGER `tr` BEFORE INSERT ON `t` FOR EACH ROW BEGIN SET NEW.x=1; END").unwrap(),"CREATE DEFINER=`root`@`localhost` ");
        assert_eq!(mysql_prefix("CREATE OR REPLACE DEFINER='a'@'%' TRIGGER tr AFTER INSERT ON t FOR EACH ROW BEGIN SET @x=1; END").unwrap(),"CREATE DEFINER='a'@'%' ");
        assert_eq!(
            mysql_prefix("CREATE TRIGGER tr AFTER INSERT ON t FOR EACH ROW BEGIN SET @x=1; END")
                .unwrap(),
            "CREATE "
        );
        assert!(mysql_prefix(
            "CREATE DEFINER=`x`; DROP TABLE a; TRIGGER tr AFTER INSERT ON t FOR EACH ROW BEGIN END"
        )
        .is_none());
        assert!(!pg_complex("CREATE TRIGGER \"WHEN\" BEFORE INSERT OR UPDATE ON public.t FOR EACH ROW EXECUTE FUNCTION public.f()"));
        for sql in ["CREATE CONSTRAINT TRIGGER tr AFTER INSERT ON t DEFERRABLE FOR EACH ROW EXECUTE FUNCTION f()", "CREATE TRIGGER tr AFTER UPDATE OF a ON t FOR EACH ROW EXECUTE FUNCTION f()", "CREATE TRIGGER tr AFTER INSERT ON t REFERENCING NEW TABLE AS newrows FOR EACH STATEMENT EXECUTE FUNCTION f()", "CREATE TRIGGER tr BEFORE INSERT ON t FOR EACH ROW WHEN (NEW.x>0) EXECUTE FUNCTION f()"] { assert!(pg_complex(sql),"{sql}"); }
    }
}
