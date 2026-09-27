use super::{
    mysql_objects::{self as objects, Definition, Kind, Object},
    sql_export::SqlExportRequest,
};
use crate::error::{AppError, AppResult};
pub struct DumpObject {
    pub object: Object,
    pub definition: Definition,
}
pub async fn collect(
    conn: &mut sqlx::MySqlConnection,
    req: &SqlExportRequest,
) -> AppResult<Vec<DumpObject>> {
    if req.mode == "data" || req.object_kinds.is_empty() {
        return Ok(vec![]);
    }
    let mut source = vec![];
    for object in objects::catalog(conn, &req.database).await?.objects {
        if !req.object_kinds.contains(&object.kind) {
            continue;
        }
        if object.kind == Kind::Trigger
            && !req.all_tables
            && !object
                .parent
                .as_ref()
                .is_some_and(|p| req.tables.contains(p))
        {
            continue;
        }
        crate::tasks::checkpoint()?;
        let definition =
            objects::definition(conn, &req.database, &object.kind, &object.name).await?;
        if super::mysql_script::nonstandard_quotes(&definition.sql_mode) {
            return Err(AppError::InvalidInput(format!(
                "对象 {} 使用 NO_BACKSLASH_ESCAPES / ANSI_QUOTES，当前 SQL 导入尚不支持，未发布导出文件",
                object.name
            )));
        }
        source.push(DumpObject { object, definition });
    }
    let mut ordered = vec![];
    for kind in [
        Kind::Function,
        Kind::Procedure,
        Kind::View,
        Kind::Trigger,
        Kind::Event,
    ] {
        loop {
            let candidates: Vec<_> = source
                .iter()
                .enumerate()
                .filter(|(_, o)| o.object.kind == kind)
                .collect();
            if candidates.is_empty() {
                break;
            }
            let ready = candidates
                .iter()
                .find(|(_, o)| {
                    kind != Kind::View
                        || !o.definition.dependencies.iter().any(|d| {
                            candidates.iter().any(|(_, other)| {
                                d == &other.object.name
                                    || d == &format!("{}.{}", req.database, other.object.name)
                            })
                        })
                })
                .map(|(i, _)| *i);
            let Some(i) = ready else {
                return Err(AppError::InvalidInput(
                    "视图存在循环或无法确定的相互依赖，未发布导出文件".into(),
                ));
            };
            ordered.push(source.remove(i));
        }
    }
    Ok(ordered)
}
/// Rewrite qualified identifiers only; literal data and dynamic SQL strings remain untouched.
pub fn remap(sql: &str, source: &str, target: &str) -> String {
    if target.is_empty() || source == target {
        return sql.into();
    }
    let b = sql.as_bytes();
    let mut i = 0;
    let mut out = String::new();
    let mut begin = 0;
    while i < b.len() {
        if b[i..].starts_with(b"/*") {
            if let Some(n) = sql[i + 2..].find("*/") {
                i += n + 4;
                continue;
            }
        }
        if b[i..].starts_with(b"--") && b.get(i + 2).is_none_or(u8::is_ascii_whitespace)
            || b[i] == b'#'
        {
            while i < b.len() && b[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if b[i] == b'\'' || b[i] == b'"' {
            let q = b[i];
            i += 1;
            while i < b.len() {
                if b[i] == b'\\' {
                    i = (i + 2).min(b.len());
                    continue;
                }
                if b[i] == q {
                    if b.get(i + 1) == Some(&q) {
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                i += 1;
            }
            continue;
        }
        if b[i] == b'`' {
            let start = i;
            i += 1;
            let mut name = vec![];
            while i < b.len() {
                if b[i] == b'`' {
                    if b.get(i + 1) == Some(&b'`') {
                        name.push(b'`');
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                name.push(b[i]);
                i += 1;
            }
            let mut next = i;
            while b.get(next).is_some_and(u8::is_ascii_whitespace) {
                next += 1;
            }
            if name == source.as_bytes() && b.get(next) == Some(&b'.') {
                out.push_str(&sql[begin..start]);
                out.push_str(&objects::ident(target));
                begin = i;
            }
            continue;
        }
        if b[i].is_ascii_alphabetic() || b[i] == b'_' || b[i] >= 128 {
            let start = i;
            while i < b.len()
                && (b[i].is_ascii_alphanumeric() || b[i] == b'_' || b[i] == b'$' || b[i] >= 128)
            {
                i += 1;
            }
            let mut next = i;
            while b.get(next).is_some_and(u8::is_ascii_whitespace) {
                next += 1;
            }
            if &sql[start..i] == source
                && b.get(next) == Some(&b'.')
                && !(start > 0 && b[start - 1] == b'@')
            {
                out.push_str(&sql[begin..start]);
                out.push_str(&objects::ident(target));
                begin = i;
            }
            continue;
        }
        i += 1;
    }
    out.push_str(&sql[begin..]);
    out
}
pub fn definition_sql(item: &DumpObject, req: &SqlExportRequest) -> AppResult<String> {
    if !req.target_database.is_empty() && req.target_database != req.database {
        let words = super::mysql_script::words(&item.definition.sql);
        if words
            .windows(2)
            .any(|w| w[0].eq_ignore_ascii_case("AS") && w[1] == req.database)
        {
            return Err(AppError::InvalidInput(format!(
                "对象 {} 使用与源库同名的别名，目标库映射存在歧义；请调整别名或保留原库名",
                item.object.name
            )));
        }
    }
    let mut sql = remap(&item.definition.sql, &req.database, &req.target_database);
    if req.omit_definer {
        if let Some(start) = sql.find(" DEFINER=") {
            let bytes = sql.as_bytes();
            let mut i = start + 9;
            let mut q = 0u8;
            while i < bytes.len() {
                let b = bytes[i];
                if q != 0 {
                    if b == b'\\' {
                        i += 2;
                        continue;
                    }
                    if b == q {
                        if bytes.get(i + 1) == Some(&q) {
                            i += 2;
                            continue;
                        }
                        q = 0;
                    }
                } else if b"`'\"".contains(&b) {
                    q = b;
                } else if b.is_ascii_whitespace() {
                    break;
                }
                i += 1;
            }
            sql.replace_range(start..i, " DEFINER=CURRENT_USER");
        }
    }
    let delimiter = format!("$dbfolio_{}$", uuid::Uuid::new_v4().simple());
    let mut out = String::new();
    if req.drop_tables {
        out.push_str(&format!(
            "DROP {} IF EXISTS {};\n",
            item.object.kind.sql(),
            objects::ident(&item.object.name)
        ));
    }
    for (name, value) in [
        ("SQL_MODE", &item.definition.sql_mode),
        ("CHARACTER_SET_CLIENT", &item.definition.charset),
        ("COLLATION_CONNECTION", &item.definition.collation),
    ] {
        if value.is_empty() {
            continue;
        }
        if !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b',')
        {
            return Err(AppError::InvalidInput(
                "对象创建环境包含无法识别的模式/字符集".into(),
            ));
        }
        out.push_str(&format!(
            "SET @DBF_OBJECT_{name}=@@{name};\nSET {name}='{value}';\n"
        ));
    }
    out.push_str(&format!(
        "DELIMITER {delimiter}\n{sql}{delimiter}\nDELIMITER ;\n"
    ));
    for (name, value) in [
        ("COLLATION_CONNECTION", &item.definition.collation),
        ("CHARACTER_SET_CLIENT", &item.definition.charset),
        ("SQL_MODE", &item.definition.sql_mode),
    ] {
        if !value.is_empty() {
            out.push_str(&format!("SET {name}=@DBF_OBJECT_{name};\n"));
        }
    }
    Ok(out)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mapping_does_not_change_data() {
        assert_eq!(
            remap(
                "SELECT `old`.`t`, '`old`.`t`' /* `old`.`t` */ FROM `old` . `t`",
                "old",
                "new"
            ),
            "SELECT `new`.`t`, '`old`.`t`' /* `old`.`t` */ FROM `new` . `t`"
        );
    }
}
