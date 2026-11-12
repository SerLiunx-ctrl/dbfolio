//! Preserve server-generated DM definitions instead of reconstructing special SQL.
use super::{field, ident, DamengAdapter};
use crate::{
    adapters::DbAdapter,
    meta::{ColumnMeta, IndexMeta},
};
use dm_rust::Connection;
use sqlparser::{
    dialect::GenericDialect,
    tokenizer::{Token, Tokenizer},
};
use std::collections::HashSet;

pub(super) struct Definition {
    pub sql: Option<String>,
    pub warnings: Vec<String>,
}

fn tokens(sql: &str) -> Result<Vec<Token>, String> {
    Tokenizer::new(&GenericDialect {}, sql)
        .tokenize()
        .map(|tokens| {
            tokens
                .into_iter()
                .filter(|token| !matches!(token, Token::Whitespace(_)))
                .collect()
        })
        .map_err(|error| error.to_string())
}

fn word(token: &Token, name: &str) -> bool {
    matches!(token, Token::Word(word) if word.quote_style.is_none() && word.value.eq_ignore_ascii_case(name))
}

fn key(token: &Token) -> String {
    match token {
        Token::Word(word) if word.quote_style.is_none() => word.value.to_ascii_uppercase(),
        Token::Word(word) => format!("\"{}\"", word.value),
        _ => token.to_string(),
    }
}

fn constraint_names(tokens: &[Token]) -> HashSet<String> {
    tokens
        .windows(2)
        .filter_map(|pair| {
            if word(&pair[0], "CONSTRAINT") {
                if let Token::Word(name) = &pair[1] {
                    return Some(name.value.clone());
                }
            }
            None
        })
        .collect()
}

fn constraint_clause(tokens: &[Token]) -> Option<Vec<String>> {
    let add = tokens.iter().position(|token| word(token, "ADD"))? + 1;
    let mut start = add;
    if tokens
        .get(start)
        .is_some_and(|token| word(token, "CONSTRAINT"))
    {
        start += 2;
    }
    let mut end = tokens
        .iter()
        .rposition(|token| !matches!(token, Token::SemiColon))?
        + 1;
    // GET_DDL(CONSTRAINT) emits the default ENABLE even when TABLE DDL omits it.
    // Ignore that default only when comparing, never rewrite the native output.
    if end > start && word(&tokens[end - 1], "ENABLE") {
        end -= 1;
    }
    (start < end).then(|| tokens[start..end].iter().map(key).collect())
}

fn already_has_clause(main: &[Token], definition: &[Token]) -> bool {
    let Some(clause) = constraint_clause(definition) else {
        return false;
    };
    let main = main.iter().map(key).collect::<Vec<_>>();
    !clause.is_empty() && main.windows(clause.len()).any(|window| window == clause)
}

fn append(parts: &mut Vec<String>, sql: &str) {
    let sql = sql.trim();
    if sql.is_empty() {
        return;
    }
    // Keep all native clauses intact. Only add a delimiter between API results.
    parts.push(if sql.ends_with(';') {
        sql.to_string()
    } else {
        format!("{sql}\n;")
    });
}

async fn native(
    conn: &mut Connection,
    kind: &str,
    name: &str,
    owner: &str,
) -> Result<String, String> {
    let result = conn
        .query(
            "SELECT DBMS_METADATA.GET_DDL(?,?,?) AS DDL FROM DUAL",
            &[kind.into(), name.into(), owner.into()],
        )
        .await
        .map_err(|error| error.to_string())?;
    result
        .rows
        .first()
        .and_then(|row| field(row, "DDL"))
        .filter(|sql| !sql.trim().is_empty())
        .ok_or_else(|| format!("GET_DDL({kind}) 未返回可读取的文本"))
}

fn comment_statements(
    owner: &str,
    table: &str,
    view: bool,
    columns: &[ColumnMeta],
    comment: Option<&str>,
) -> Vec<String> {
    let target = format!("{}.{}", ident(owner), ident(table));
    let literal = |value: &str| format!("'{}'", value.replace('\'', "''"));
    let mut statements = vec![];
    if let Some(comment) = comment.filter(|value| !value.is_empty()) {
        statements.push(format!(
            "COMMENT ON {} {target} IS {};",
            if view { "VIEW" } else { "TABLE" },
            literal(comment)
        ));
    }
    for column in columns {
        if let Some(comment) = column.comment.as_deref().filter(|value| !value.is_empty()) {
            statements.push(format!(
                "COMMENT ON COLUMN {target}.{} IS {};",
                ident(&column.name),
                literal(comment)
            ));
        }
    }
    statements
}

pub(super) async fn read(
    adapter: &DamengAdapter,
    owner: &str,
    table: &str,
    view: bool,
    indexes: &[IndexMeta],
    columns: &[ColumnMeta],
    comment: Option<&str>,
) -> Definition {
    let mut warnings = vec![];
    let mut conn = match adapter.dameng_connection(owner, false).await {
        Ok(conn) => conn,
        Err(error) => {
            return Definition {
                sql: None,
                warnings: vec![format!("达梦原生 DDL 读取连接失败：{error}")],
            }
        }
    };
    let main = match native(&mut conn, if view { "VIEW" } else { "TABLE" }, table, owner).await {
        Ok(sql) => sql,
        Err(error) => {
            return Definition {
                sql: None,
                warnings: vec![format!(
                    "达梦{} {owner}.{table} 的原生 DDL 读取失败：{error}；未生成替代定义",
                    if view { "视图" } else { "表" }
                )],
            }
        }
    };
    let main_tokens = match tokens(&main) {
        Ok(tokens) => Some(tokens),
        Err(error) => {
            warnings.push(format!(
                "达梦原生 DDL 词法检查失败，暂不追加可能重复的约束：{error}"
            ));
            None
        }
    };
    let mut parts = vec![];
    append(&mut parts, &main);
    if !view {
        if let Some(main_tokens) = &main_tokens {
            let names = constraint_names(main_tokens);
            match conn.query("SELECT CONSTRAINT_NAME,CONSTRAINT_TYPE FROM ALL_CONSTRAINTS WHERE OWNER=? AND TABLE_NAME=? AND CONSTRAINT_TYPE IN ('P','U','R','C') ORDER BY CONSTRAINT_NAME", &[owner.into(), table.into()]).await {
                Ok(result) => for row in &result.rows {
                    let Some(name) = field(row, "CONSTRAINT_NAME") else { continue; };
                    if names.contains(&name) { continue; }
                    // An unnamed native PRIMARY KEY can have a generated catalog name.
                    if field(row, "CONSTRAINT_TYPE").as_deref() == Some("P")
                        && main_tokens.windows(2).any(|pair| word(&pair[0], "PRIMARY") && word(&pair[1], "KEY")) {
                        continue;
                    }
                    match native(&mut conn, "CONSTRAINT", &name, owner).await {
                        Ok(sql) => match tokens(&sql) {
                            Ok(definition) if already_has_clause(main_tokens, &definition) => {},
                            Ok(_) => append(&mut parts, &sql),
                            Err(error) => warnings.push(format!("达梦约束 {name} 的原生定义无法检查，未追加：{error}")),
                        },
                        Err(error) => warnings.push(format!("达梦约束 {name} 的原生 DDL 读取失败：{error}")),
                    }
                },
                Err(error) => warnings.push(format!("达梦依赖约束列表读取失败，当前 DDL 可能缺少约束：{error}")),
            }
        }
        // FLAG bit 1 is the documented system-index marker. A user-created
        // CLUSTER index must not be discarded merely because of its method/name.
        let system_indexes = match conn.query("SELECT O.NAME AS INDEX_NAME,I.FLAG AS INDEX_FLAG FROM SYS.SYSOBJECTS T JOIN SYS.SYSOBJECTS S ON S.ID=T.SCHID JOIN SYS.SYSOBJECTS O ON O.PID=T.ID AND O.SUBTYPE$='INDEX' JOIN SYS.SYSINDEXES I ON I.ID=O.ID WHERE S.NAME=? AND T.NAME=?", &[owner.into(), table.into()]).await {
            Ok(result) => result.rows.iter().filter_map(|row| {
                let flag = field(row, "INDEX_FLAG")?.parse::<u64>().ok()?;
                if flag & 1 != 0 { field(row, "INDEX_NAME") } else { None }
            }).collect::<HashSet<_>>(),
            Err(error) => {
                warnings.push(format!("达梦系统索引标识读取失败，将逐项请求原生定义并保留失败诊断：{error}"));
                HashSet::new()
            }
        };
        for index in indexes.iter().filter(|index| {
            !index.primary
                && index.edit_unsupported_reason.is_none()
                && !system_indexes.contains(&index.name)
        }) {
            match native(&mut conn, "INDEX", &index.name, owner).await {
                Ok(sql) => append(&mut parts, &sql),
                Err(error) => warnings.push(format!(
                    "达梦索引 {} 的原生 DDL 读取失败，已保留其他定义：{error}",
                    index.name
                )),
            }
        }
    }
    // DM8's GET_DEPENDENT_DDL(COMMENT) was verified to omit string quotes and
    // emit malformed column paths. Use the exact, already scoped dictionary
    // text and standard COMMENT syntax; special object definitions stay native.
    parts.extend(comment_statements(owner, table, view, columns, comment));
    Definition {
        sql: Some(parts.join("\n\n")),
        warnings,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_constraints_are_compared_without_rebuilding_them() {
        let main = tokens("CREATE TABLE \"S\".\"T\"(ID INT IDENTITY(7,2) NOT NULL, CONSTRAINT \"CK_VALUE\" CHECK(ID>0), NOT CLUSTER PRIMARY KEY(ID)) STORAGE(ON \"MAIN\",CLUSTERBTR);").unwrap();
        assert!(constraint_names(&main).contains("CK_VALUE"));
        assert!(already_has_clause(
            &main,
            &tokens("ALTER TABLE \"S\".\"T\" ADD CONSTRAINT \"PK_T\" PRIMARY KEY(ID);").unwrap()
        ));
        assert!(!already_has_clause(&main, &tokens("ALTER TABLE \"S\".\"T\" ADD CONSTRAINT \"FK_T\" FOREIGN KEY(ID) REFERENCES \"S\".\"P\"(ID);").unwrap()));
        let mut result = vec![];
        append(
            &mut result,
            "CREATE INDEX \"I\" ON \"S\".\"T\"(ID DESC) STORAGE(ON \"MAIN\");",
        );
        assert!(result[0].contains("ID DESC) STORAGE"));
    }
    #[test]
    fn comments_are_exactly_scoped_and_quoted() {
        let sql = comment_statements(
            "S\"Q",
            "T",
            false,
            &[],
            Some("中文 ' ; COMMENT ON TABLE OTHER IS 'x'"),
        );
        assert!(sql[0].contains("\"S\"\"Q\".\"T\""));
        assert!(sql[0].contains("中文 '' ;"));
        assert_eq!(
            tokens(&sql[0])
                .unwrap()
                .iter()
                .filter(|token| matches!(token, Token::SemiColon))
                .count(),
            1
        );
        let view = comment_statements("S", "V", true, &[], Some("视图注释"));
        assert!(view[0].starts_with("COMMENT ON VIEW"));
    }
}
