use super::ddl::ColumnFlags;
use crate::{
    adapters::DbAdapter,
    error::{AppError, AppResult},
    meta::TableMeta,
};
use sqlparser::{
    ast::{ColumnOption, ColumnOptionDef, CreateTable, Statement},
    dialect::{Dialect, PostgreSqlDialect, SQLiteDialect},
    parser::Parser,
};

pub fn invalid(message: impl Into<String>) -> AppError {
    AppError::InvalidInput(message.into())
}
pub fn ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}
pub fn literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}
fn pg_literal(value: &str) -> String {
    format!("E'{}'", value.replace('\\', "\\\\").replace('\'', "''"))
}

pub fn parse_create(dialect: &dyn Dialect, sql: &str) -> AppResult<CreateTable> {
    let mut parsed = Parser::parse_sql(dialect, sql)
        .map_err(|e| invalid(format!("无法安全解析列定义，请通过 SQL 管理此结构：{e}")))?;
    if parsed.len() != 1 {
        return Err(invalid("列定义包含额外语句"));
    }
    match parsed.remove(0) {
        Statement::CreateTable(t) if !t.columns.is_empty() && t.query.is_none() => Ok(t),
        _ => Err(invalid("仅支持普通表的列定义")),
    }
}
pub fn parse_sqlite_create(sql: &str) -> AppResult<CreateTable> {
    // sqlparser 0.59 不识别 SQLite 两个表选项之间的逗号，仅规范化最末尾的选项。
    if let Some(pos) = sql.rfind(')') {
        let tail = sql[pos + 1..]
            .trim()
            .trim_end_matches(';')
            .replace(',', " ")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .to_uppercase();
        if tail == "STRICT WITHOUT ROWID" || tail == "WITHOUT ROWID STRICT" {
            return parse_create(
                &SQLiteDialect {},
                &format!("{} WITHOUT ROWID STRICT", &sql[..pos + 1]),
            );
        }
    }
    parse_create(&SQLiteDialect {}, sql)
}
pub fn render_sqlite_create(create: &CreateTable) -> String {
    let mut create = create.clone();
    let strict = create.strict;
    create.strict = false;
    format!(
        "{}{}",
        create,
        if strict {
            if create.without_rowid {
                ", STRICT"
            } else {
                " STRICT"
            }
        } else {
            ""
        }
    )
}
pub fn data_type(dialect: &dyn Dialect, text: &str) -> AppResult<sqlparser::ast::DataType> {
    if text.trim().is_empty() {
        return Err(invalid("字段类型不能为空"));
    }
    let t = parse_create(dialect, &format!("CREATE TABLE x (c {text})"))?;
    if t.columns.len() != 1
        || !t.columns[0].options.is_empty()
        || !t.constraints.is_empty()
        || t.without_rowid
        || t.strict
    {
        return Err(invalid("字段类型/长度只能包含类型定义"));
    }
    Ok(t.columns[0].data_type.clone())
}
pub fn default_sql(change: &ColumnFlags) -> AppResult<Option<String>> {
    match change.default_mode.as_deref() {
        None | Some("none") => Ok(None),
        Some("null") if change.nullable => Ok(Some("NULL".into())),
        Some("null") => Err(invalid("不可空列不能使用 NULL 默认值")),
        Some("literal") => Ok(Some(literal(change.default_value.as_deref().unwrap_or("")))),
        Some("timestamp") => Ok(Some("CURRENT_TIMESTAMP".into())),
        _ => Err(invalid("默认值模式无效")),
    }
}
pub fn validate_changes(meta: &TableMeta, changes: &[ColumnFlags]) -> AppResult<()> {
    if changes.is_empty() {
        return Err(invalid("没有列属性修改"));
    }
    let mut touched = std::collections::HashSet::new();
    let mut names: Vec<String> = meta.columns.iter().map(|c| c.name.clone()).collect();
    for c in changes {
        if !touched.insert(&c.name) {
            return Err(invalid("重复的字段修改"));
        }
        let pos = meta
            .columns
            .iter()
            .position(|col| col.name == c.name)
            .ok_or_else(|| invalid("字段已不存在，请刷新结构"))?;
        if c.nullable
            && !meta.columns[pos].nullable
            && (meta.primary_key.contains(&c.name) || meta.columns[pos].auto_increment)
        {
            return Err(invalid("主键或自动增长列不能设为可空"));
        }
        if let Some(name) = &c.new_name {
            if name.trim().is_empty() || name.contains('\0') {
                return Err(invalid("字段名不能为空或包含空字符"));
            }
            if meta
                .columns
                .iter()
                .any(|col| col.name.eq_ignore_ascii_case(name) && col.name != c.name)
            {
                return Err(invalid("目标字段名已存在；交换字段名请分步保存"));
            }
            names[pos] = name.clone();
        }
    }
    let mut unique = std::collections::HashSet::new();
    if names.iter().any(|name| !unique.insert(name.to_lowercase())) {
        return Err(invalid("修改后的字段名重复"));
    }
    Ok(())
}

pub fn postgres_columns(
    adapter: &dyn DbAdapter,
    target: &str,
    meta: &TableMeta,
    changes: &[ColumnFlags],
) -> AppResult<Vec<String>> {
    validate_changes(meta, changes)?;
    let mut sql = Vec::new();
    for c in changes {
        let old = meta.columns.iter().find(|old| old.name == c.name).unwrap();
        if c.unsigned.is_some() || c.on_update.is_some() {
            return Err(invalid("PostgreSQL 不支持 UNSIGNED / ON UPDATE 列属性"));
        }
        if c.auto_increment.is_some() {
            return Err(invalid("PostgreSQL 序列/IDENTITY 属性请通过 SQL 管理"));
        }
        let name = adapter.quote_ident(&c.name);
        if let Some(ty) = &c.data_type {
            let ty = data_type(&PostgreSqlDialect {}, ty)?;
            // 由服务器判断是否可以隐式转换；不自动加入可能丢失数据的 USING 强制转换。
            sql.push(format!(
                "ALTER TABLE {target} ALTER COLUMN {name} TYPE {ty}"
            ));
        }
        if old.nullable != c.nullable {
            sql.push(format!(
                "ALTER TABLE {target} ALTER COLUMN {name} {} NOT NULL",
                if c.nullable { "DROP" } else { "SET" }
            ));
        }
        if c.default_mode.is_some() {
            if old.auto_increment {
                return Err(invalid("自动增长列的默认值由序列/IDENTITY 管理"));
            }
            let value = if c.default_mode.as_deref() == Some("literal") {
                Some(pg_literal(c.default_value.as_deref().unwrap_or("")))
            } else {
                default_sql(c)?
            };
            sql.push(format!(
                "ALTER TABLE {target} ALTER COLUMN {name} {}",
                match value {
                    Some(v) => format!("SET DEFAULT {v}"),
                    None => "DROP DEFAULT".into(),
                }
            ));
        }
        if let Some(comment) = &c.comment {
            sql.push(format!(
                "COMMENT ON COLUMN {target}.{name} IS {}",
                pg_literal(comment)
            ));
        }
    }
    for c in changes {
        if let Some(name) = c.new_name.as_ref().filter(|name| *name != &c.name) {
            sql.push(format!(
                "ALTER TABLE {target} RENAME COLUMN {} TO {}",
                adapter.quote_ident(&c.name),
                adapter.quote_ident(name)
            ));
        }
    }
    Ok(sql)
}

pub fn is_auto(option: &ColumnOption) -> bool {
    matches!(option,ColumnOption::DialectSpecific(t) if t.iter().any(|t|t.to_string().eq_ignore_ascii_case("AUTOINCREMENT")))
}
pub fn sqlite_auto_columns(raw: Option<&str>) -> Vec<String> {
    raw.and_then(|raw| parse_create(&SQLiteDialect {}, raw).ok())
        .map(|t| {
            t.columns
                .into_iter()
                .filter(|c| c.options.iter().any(|o| is_auto(&o.option)))
                .map(|c| c.name.value)
                .collect()
        })
        .unwrap_or_default()
}
pub fn change_sqlite_columns(create: &mut CreateTable, changes: &[ColumnFlags]) -> AppResult<()> {
    for c in changes {
        if c.unsigned.is_some() || c.on_update.is_some() || c.comment.is_some() {
            return Err(invalid("SQLite 不支持 UNSIGNED、ON UPDATE 或列注释"));
        }
        let col = create
            .columns
            .iter_mut()
            .find(|col| col.name.value == c.name)
            .ok_or_else(|| invalid("字段不存在"))?;
        if col
            .options
            .iter()
            .any(|o| matches!(o.option, ColumnOption::Generated { .. }))
        {
            return Err(invalid("生成列请通过 SQL 管理，普通列可以行内修改"));
        }
        if let Some(ty) = &c.data_type {
            col.data_type = data_type(&SQLiteDialect {}, ty)?;
        }
        let was_nullable = !col
            .options
            .iter()
            .any(|o| matches!(o.option, ColumnOption::NotNull));
        if was_nullable != c.nullable {
            let mut after_null = false;
            col.options.retain(|o| {
                if matches!(o.option, ColumnOption::Null | ColumnOption::NotNull) {
                    after_null = true;
                    return false;
                }
                let remove = after_null && matches!(o.option, ColumnOption::OnConflict(_));
                after_null = false;
                !remove
            });
            if !c.nullable {
                col.options.push(ColumnOptionDef {
                    name: None,
                    option: ColumnOption::NotNull,
                });
            }
        }
        if c.default_mode.is_some() {
            col.options
                .retain(|o| !matches!(o.option, ColumnOption::Default(_)));
            if let Some(value) = default_sql(c)? {
                let parsed = parse_create(
                    &SQLiteDialect {},
                    &format!("CREATE TABLE x (c TEXT DEFAULT {value})"),
                )?;
                col.options.extend(parsed.columns[0].options.clone());
            }
        }
        if let Some(enabled) = c.auto_increment {
            if enabled
                && (create.without_rowid
                    || col.data_type.to_string() != "INTEGER"
                    || !col.options.iter().any(|o| {
                        matches!(
                            o.option,
                            ColumnOption::Unique {
                                is_primary: true,
                                ..
                            }
                        )
                    }))
            {
                return Err(invalid(
                    "AUTOINCREMENT 需要普通表中内联声明的单列 INTEGER PRIMARY KEY",
                ));
            }
            col.options.retain(|o| !is_auto(&o.option));
            if enabled {
                let parsed = parse_create(
                    &SQLiteDialect {},
                    "CREATE TABLE x (c INTEGER PRIMARY KEY AUTOINCREMENT)",
                )?;
                let index = col
                    .options
                    .iter()
                    .position(|o| {
                        matches!(
                            o.option,
                            ColumnOption::Unique {
                                is_primary: true,
                                ..
                            }
                        )
                    })
                    .unwrap()
                    + 1;
                for option in parsed.columns[0]
                    .options
                    .iter()
                    .filter(|o| is_auto(&o.option))
                {
                    col.options.insert(index, option.clone());
                }
            }
        }
    }
    Ok(())
}
