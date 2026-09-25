use crate::{
    error::{AppError, AppResult},
    meta::Engine,
};

pub(super) fn scan_sql(engine: Engine, sql: &str) -> AppResult<(String, String)> {
    let text = sql.trim().trim_end_matches(';').trim();
    if text.is_empty() {
        return Err(AppError::InvalidInput("SQL 不能为空".into()));
    }
    let bytes = text.as_bytes();
    let mut i = 0;
    let mut words = String::new();
    while i < bytes.len() {
        let c = bytes[i];
        if engine == Engine::Postgres && c == b'$' {
            let mut end = i + 1;
            while end < bytes.len() && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'_') {
                end += 1;
            }
            if bytes.get(end) == Some(&b'$') {
                return Err(AppError::InvalidInput(
                    "执行计划暂不接受 dollar-quoted 字符串，请改用标准单引号字符串".into(),
                ));
            }
        }
        if c == b'\'' || c == b'"' || c == 96 || (engine == Engine::Sqlite && c == b'[') {
            let quote = if c == b'[' { b']' } else { c };
            i += 1;
            let mut closed = false;
            while i < bytes.len() {
                if bytes[i] == b'\\' {
                    return Err(AppError::InvalidInput("执行计划暂不接受带反斜杠转义的字符串，请改用标准双写引号，避免不同 SQL 模式下的语句边界歧义".into()));
                }
                if bytes[i] == quote {
                    if bytes.get(i + 1) == Some(&quote) {
                        i += 2;
                        continue;
                    }
                    i += 1;
                    closed = true;
                    break;
                }
                i += 1;
            }
            if !closed {
                return Err(AppError::InvalidInput("SQL 引号未闭合".into()));
            }
            words.push(' ');
            continue;
        }
        if (bytes.get(i..i + 2) == Some(b"--")
            && (engine != Engine::Mysql
                || bytes
                    .get(i + 2)
                    .map(|b| b.is_ascii_whitespace())
                    .unwrap_or(true)))
            || (engine == Engine::Mysql && c == b'#')
        {
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            words.push(' ');
            continue;
        }
        if bytes.get(i..i + 2) == Some(b"/*") {
            if bytes.get(i + 2) == Some(&b'!') {
                return Err(AppError::InvalidInput("执行计划不接受可执行注释".into()));
            }
            i += 2;
            let mut depth = 1;
            while i < bytes.len() && depth > 0 {
                if bytes.get(i..i + 2) == Some(b"/*") {
                    if engine != Engine::Postgres {
                        return Err(AppError::InvalidInput("此引擎不接受嵌套注释".into()));
                    }
                    depth += 1;
                    i += 2;
                } else if bytes.get(i..i + 2) == Some(b"*/") {
                    depth -= 1;
                    i += 2;
                } else {
                    i += 1;
                }
            }
            if depth != 0 {
                return Err(AppError::InvalidInput("SQL 注释未闭合".into()));
            }
            words.push(' ');
            continue;
        }
        if c == b';' {
            return Err(AppError::InvalidInput(
                "执行计划一次仅接受一条语句，请选中目标语句".into(),
            ));
        }
        words.push(if c.is_ascii_alphanumeric() || c == b'_' {
            c as char
        } else {
            ' '
        });
        i += 1;
    }
    Ok((text.to_owned(), words))
}

pub fn analysis_sql(engine: Engine, sql: &str) -> AppResult<String> {
    let (text, words) = scan_sql(engine, sql)
        .map_err(|e| AppError::InvalidInput(e.to_string().replace("执行计划", "分析查询")))?;
    let words: Vec<String> = words
        .split_whitespace()
        .map(str::to_ascii_uppercase)
        .collect();
    if !matches!(words.first().map(String::as_str), Some("SELECT" | "WITH"))
        || words.iter().any(|w| {
            [
                "INSERT", "UPDATE", "DELETE", "MERGE", "INTO", "CREATE", "DROP", "ALTER",
                "TRUNCATE", "COPY", "CALL", "EXEC", "SET", "LOCK", "FOR", "ATTACH", "DETACH",
                "PRAGMA", "LOAD", "REPLACE",
            ]
            .contains(&w.as_str())
        })
    {
        return Err(AppError::InvalidInput(
            "分析只接受单条 SELECT / 只读 WITH，不支持修改、锁定或多语句".into(),
        ));
    }
    Ok(text)
}

pub fn explain_sql(engine: Engine, sql: &str) -> AppResult<String> {
    let (text, words) = scan_sql(engine, sql)?;
    let first = words
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_ascii_uppercase();
    if !matches!(
        first.as_str(),
        "SELECT" | "WITH" | "INSERT" | "UPDATE" | "DELETE"
    ) {
        return Err(AppError::InvalidInput(
            "请选择 SELECT / WITH / INSERT / UPDATE / DELETE 原始语句，不要包含 EXPLAIN 或 ANALYZE"
                .into(),
        ));
    }
    Ok(match engine {
        Engine::Mysql => format!("EXPLAIN FORMAT=JSON {text}"),
        Engine::Postgres => format!("EXPLAIN (FORMAT JSON) {text}"),
        Engine::Sqlite => format!("EXPLAIN QUERY PLAN {text}"),
        _ => return Err(AppError::InvalidInput("此引擎不支持 SQL 执行计划".into())),
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn plan_never_accepts_execution_options_or_multiple_statements() {
        assert_eq!(
            explain_sql(Engine::Postgres, "SELECT 1;").unwrap(),
            "EXPLAIN (FORMAT JSON) SELECT 1"
        );
        assert!(explain_sql(Engine::Mysql, "SELECT ';'").is_ok());
        for text in [
            "SELECT 1; DELETE FROM x",
            "ANALYZE SELECT 1",
            "EXPLAIN ANALYZE SELECT 1",
            "/* no */ ANALYZE SELECT 1",
            "SELECT 1 /*!; DELETE FROM x */",
            "SELECT 1--x ; DELETE FROM x",
            "SELECT 1 /* /* nested */ ; DELETE FROM x */",
        ] {
            assert!(explain_sql(Engine::Mysql, text).is_err());
        }
        assert!(explain_sql(Engine::Postgres, "SELECT $$'$$; DELETE FROM x; SELECT '$$").is_err());
    }
}
