use super::{
    column_edit::{data_type, default_sql, invalid, literal, validate_changes},
    ddl::ColumnFlags,
};
use crate::{
    adapters::DbAdapter,
    error::AppResult,
    meta::{Engine, TableMeta},
};
/// DM DDL may commit implicitly. Render all changes first; never rebuild a table as a fallback.
pub fn columns(
    adapter: &dyn DbAdapter,
    target: &str,
    meta: &TableMeta,
    changes: &[ColumnFlags],
) -> AppResult<Vec<String>> {
    validate_changes(Engine::Dameng, meta, changes)?;
    let mut statements = Vec::new();
    for c in changes {
        let old = meta.columns.iter().find(|old| old.name == c.name).unwrap();
        if c.unsigned.is_some() || c.on_update.is_some() {
            return Err(invalid("达梦不支持 UNSIGNED / ON UPDATE 列属性"));
        }
        if c.auto_increment.is_some() {
            return Err(invalid("达梦已建表的 IDENTITY 属性请通过 SQL 管理"));
        }
        let name = adapter.quote_ident(&c.name);
        if let Some(ty) = &c.data_type {
            let ty = data_type(&sqlparser::dialect::GenericDialect {}, ty)?;
            statements.push(format!("ALTER TABLE {target} MODIFY {name} {ty}"));
        }
        if c.nullable != old.nullable {
            statements.push(format!(
                "ALTER TABLE {target} MODIFY {name} {}NULL",
                if c.nullable { "" } else { "NOT " }
            ));
        }
        if c.default_mode.is_some() {
            if old.auto_increment {
                return Err(invalid("自动增长列的默认值由 IDENTITY 管理"));
            }
            statements.push(format!(
                "ALTER TABLE {target} ALTER COLUMN {name} {}",
                match default_sql(c)? {
                    Some(v) => format!("SET DEFAULT {v}"),
                    None => "DROP DEFAULT".into(),
                }
            ));
        }
        if let Some(comment) = &c.comment {
            statements.push(format!(
                "COMMENT ON COLUMN {target}.{name} IS {}",
                literal(comment)
            ));
        }
    }
    for c in changes {
        if let Some(name) = c.new_name.as_ref().filter(|n| *n != &c.name) {
            statements.push(format!(
                "ALTER TABLE {target} RENAME COLUMN {} TO {}",
                adapter.quote_ident(&c.name),
                adapter.quote_ident(name)
            ));
        }
    }
    Ok(statements)
}
