use super::ddl::{IndexColumnSpec, TableOptions};
use crate::{
    error::{AppError, AppResult},
    meta::Engine,
};
use serde::{Deserialize, Serialize};
use sqlparser::dialect::{Dialect, MySqlDialect, PostgreSqlDialect, SQLiteDialect};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftColumn {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub primary_key: bool,
    #[serde(default)]
    pub auto_increment: bool,
    #[serde(default)]
    pub unsigned: bool,
    #[serde(default)]
    pub default_mode: String,
    #[serde(default)]
    pub default_value: String,
    #[serde(default)]
    pub comment: String,
    #[serde(default)]
    pub on_update: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftIndex {
    pub name: String,
    pub columns: Vec<IndexColumnSpec>,
    pub unique: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftForeignKey {
    pub name: String,
    pub columns: Vec<String>,
    pub ref_table: String,
    pub ref_schema: Option<String>,
    pub ref_columns: Vec<String>,
    pub on_delete: String,
    pub on_update: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableDraft {
    pub schema: Option<String>,
    pub table: String,
    pub columns: Vec<DraftColumn>,
    pub indexes: Vec<DraftIndex>,
    pub foreign_keys: Vec<DraftForeignKey>,
    pub options: TableOptions,
}
fn fail(text: &str) -> AppError {
    AppError::InvalidInput(text.into())
}
fn identifier(name: &str) -> AppResult<()> {
    if name.trim().is_empty() || name.contains('\0') {
        Err(fail("名称不能为空或包含空字符"))
    } else {
        Ok(())
    }
}
fn word(s: &str) -> AppResult<&str> {
    if s.is_empty() || !s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_') {
        Err(fail("表选项包含无效字符"))
    } else {
        Ok(s)
    }
}

pub fn render(engine: Engine, database: &str, d: &TableDraft) -> AppResult<Vec<String>> {
    if !matches!(engine, Engine::Mysql | Engine::Postgres | Engine::Sqlite) {
        return Err(fail("仅关系型数据库支持建表"));
    }
    identifier(&d.table)?;
    if d.columns.is_empty() {
        return Err(fail("至少添加一个字段"));
    }
    let q = |s: &str| {
        if engine == Engine::Mysql {
            format!("`{}`", s.replace('`', "``"))
        } else {
            format!("\"{}\"", s.replace('"', "\"\""))
        }
    };
    let literal = |s: &str| {
        if engine == Engine::Postgres {
            format!("E'{}'", s.replace('\\', "\\\\").replace('\'', "''"))
        } else {
            format!(
                "'{}'",
                if engine == Engine::Mysql {
                    s.replace('\\', "\\\\").replace('\'', "''")
                } else {
                    s.replace('\'', "''")
                }
            )
        }
    };
    let schema =
        d.schema
            .as_deref()
            .filter(|s| !s.is_empty())
            .unwrap_or(if engine == Engine::Mysql {
                database
            } else if engine == Engine::Postgres {
                "public"
            } else {
                "main"
            });
    identifier(schema)?;
    if engine == Engine::Mysql && schema != database {
        return Err(fail("新表必须属于当前数据库"));
    }
    if engine == Engine::Sqlite && schema != "main" {
        return Err(fail("SQLite 新表仅支持 main"));
    }
    let target = format!("{}.{}", q(schema), q(&d.table));
    let dialect: Box<dyn Dialect> = match engine {
        Engine::Mysql => Box::new(MySqlDialect {}),
        Engine::Postgres => Box::new(PostgreSqlDialect {}),
        _ => Box::new(SQLiteDialect {}),
    };
    let mut names = std::collections::HashSet::new();
    for c in &d.columns {
        identifier(&c.name)?;
        if !names.insert(if engine == Engine::Postgres {
            c.name.clone()
        } else {
            c.name.to_lowercase()
        }) {
            return Err(fail("字段名重复"));
        }
    }
    let pk = d
        .columns
        .iter()
        .filter(|c| c.primary_key)
        .collect::<Vec<_>>();
    let sqlite_auto = engine == Engine::Sqlite && d.columns.iter().any(|c| c.auto_increment);
    if engine != Engine::Postgres && d.columns.iter().filter(|c| c.auto_increment).count() > 1 {
        return Err(fail("此数据库只能有一个自动增长字段"));
    }
    let mut defs = Vec::new();
    let mut trailing = Vec::new();
    for c in &d.columns {
        super::column_edit::data_type(dialect.as_ref(), &c.data_type)?;
        let ty = c.data_type.to_lowercase();
        let integer = [
            "tinyint",
            "smallint",
            "mediumint",
            "int",
            "integer",
            "bigint",
        ]
        .contains(&ty.as_str());
        if c.auto_increment
            && (!integer
                || (engine == Engine::Postgres
                    && !matches!(ty.as_str(), "smallint" | "int" | "integer" | "bigint")))
        {
            return Err(fail("自动增长需要整数类型"));
        }
        if c.auto_increment
            && engine == Engine::Sqlite
            && (ty != "integer" || !c.primary_key || pk.len() != 1)
        {
            return Err(fail("SQLite 自动增长需要单列 INTEGER 主键"));
        }
        if c.auto_increment
            && engine == Engine::Mysql
            && !pk.first().is_some_and(|p| p.name == c.name)
            && !d
                .indexes
                .iter()
                .any(|i| i.columns.first().is_some_and(|p| p.name == c.name))
        {
            return Err(fail("MySQL 自动增长列必须位于主键或索引的首列"));
        }
        let mut text = format!("{} {}", q(&c.name), c.data_type);
        if c.unsigned {
            if engine != Engine::Mysql
                || !matches!(
                    ty.split('(').next().unwrap_or(""),
                    "tinyint"
                        | "smallint"
                        | "mediumint"
                        | "int"
                        | "integer"
                        | "bigint"
                        | "decimal"
                        | "numeric"
                        | "float"
                        | "double"
                        | "real"
                )
            {
                return Err(fail("无符号仅适用于 MySQL 数值类型"));
            }
            text.push_str(" UNSIGNED");
        }
        if !c.nullable || c.primary_key || c.auto_increment {
            text.push_str(" NOT NULL");
        }
        if c.auto_increment {
            if !matches!(c.default_mode.as_str(), "" | "none") {
                return Err(fail("自动增长列不能设置默认值"));
            }
            text.push_str(match engine {
                Engine::Mysql => " AUTO_INCREMENT",
                Engine::Postgres => " GENERATED BY DEFAULT AS IDENTITY",
                _ => " PRIMARY KEY AUTOINCREMENT",
            });
        } else {
            match c.default_mode.as_str() {
                "" | "none" => {}
                "null" if c.nullable && !c.primary_key => text.push_str(" DEFAULT NULL"),
                "literal" => text.push_str(&format!(" DEFAULT {}", literal(&c.default_value))),
                "timestamp" => text.push_str(" DEFAULT CURRENT_TIMESTAMP"),
                _ => return Err(fail("默认值模式无效或不可空字段使用了 NULL")),
            }
        }
        if !c.on_update.is_empty() {
            if engine != Engine::Mysql
                || c.on_update != "CURRENT_TIMESTAMP"
                || !(ty.starts_with("timestamp") || ty.starts_with("datetime"))
            {
                return Err(fail("ON UPDATE 仅支持 MySQL 时间戳/日期时间字段"));
            }
            text.push_str(" ON UPDATE CURRENT_TIMESTAMP");
        }
        if !c.comment.is_empty() {
            match engine {
                Engine::Mysql => text.push_str(&format!(" COMMENT {}", literal(&c.comment))),
                Engine::Postgres => trailing.push(format!(
                    "COMMENT ON COLUMN {}.{} IS {}",
                    target,
                    q(&c.name),
                    literal(&c.comment)
                )),
                _ => return Err(fail("SQLite 不支持字段注释")),
            }
        }
        defs.push(text);
    }
    if !pk.is_empty() && !sqlite_auto {
        defs.push(format!(
            "PRIMARY KEY ({})",
            pk.iter().map(|c| q(&c.name)).collect::<Vec<_>>().join(", ")
        ));
    }
    let check_columns = |columns: &[String]| -> AppResult<()> {
        let mut seen = std::collections::HashSet::new();
        if columns.is_empty()
            || columns
                .iter()
                .any(|s| !d.columns.iter().any(|c| &c.name == s) || !seen.insert(s))
        {
            return Err(fail("索引/外键必须选择有效且不重复的字段"));
        }
        Ok(())
    };
    let mut index_names = std::collections::HashSet::new();
    for i in &d.indexes {
        identifier(&i.name)?;
        if i.name.eq_ignore_ascii_case("PRIMARY") || !index_names.insert(i.name.to_lowercase()) {
            return Err(fail("索引名重复或使用了 PRIMARY 保留名"));
        }
        check_columns(&i.columns.iter().map(|c| c.name.clone()).collect::<Vec<_>>())?;
        let cols = i
            .columns
            .iter()
            .map(|c| format!("{}{}", q(&c.name), if c.desc { " DESC" } else { "" }))
            .collect::<Vec<_>>()
            .join(", ");
        if engine == Engine::Mysql {
            defs.push(format!(
                "{}KEY {} ({})",
                if i.unique { "UNIQUE " } else { "" },
                q(&i.name),
                cols
            ));
        } else {
            trailing.push(format!(
                "CREATE {}INDEX {} ON {} ({})",
                if i.unique { "UNIQUE " } else { "" },
                if engine == Engine::Sqlite {
                    format!("{}.{}", q(schema), q(&i.name))
                } else {
                    q(&i.name)
                },
                if engine == Engine::Sqlite {
                    q(&d.table)
                } else {
                    target.clone()
                },
                cols
            ));
        }
    }
    let mut fk_names = std::collections::HashSet::new();
    for f in &d.foreign_keys {
        identifier(&f.name)?;
        identifier(&f.ref_table)?;
        if !fk_names.insert(f.name.to_lowercase()) {
            return Err(fail("外键名重复"));
        }
        check_columns(&f.columns)?;
        if f.columns.len() != f.ref_columns.len() {
            return Err(fail("外键两端字段数量不一致"));
        }
        let mut refs = std::collections::HashSet::new();
        for c in &f.ref_columns {
            identifier(c)?;
            if !refs.insert(c) {
                return Err(fail("引用字段重复"));
            }
        }
        for action in [&f.on_delete, &f.on_update] {
            if ![
                "NO ACTION",
                "RESTRICT",
                "CASCADE",
                "SET NULL",
                "SET DEFAULT",
            ]
            .contains(&action.as_str())
                || engine == Engine::Mysql && action == "SET DEFAULT"
            {
                return Err(fail("外键规则不受支持"));
            }
            if action == "SET NULL"
                && d.columns
                    .iter()
                    .any(|c| f.columns.contains(&c.name) && (!c.nullable || c.primary_key))
            {
                return Err(fail("SET NULL 需要可空的本地字段"));
            }
        }
        let ref_schema = f
            .ref_schema
            .as_deref()
            .filter(|s| !s.is_empty())
            .unwrap_or(schema);
        identifier(ref_schema)?;
        if engine == Engine::Sqlite && ref_schema != schema {
            return Err(fail("SQLite 不支持跨库外键"));
        }
        if f.ref_table == d.table && ref_schema == schema {
            check_columns(&f.ref_columns)?;
        }
        defs.push(format!(
            "CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {} ({}) ON DELETE {} ON UPDATE {}",
            q(&f.name),
            f.columns
                .iter()
                .map(|s| q(s))
                .collect::<Vec<_>>()
                .join(", "),
            if engine == Engine::Sqlite {
                q(&f.ref_table)
            } else {
                format!("{}.{}", q(ref_schema), q(&f.ref_table))
            },
            f.ref_columns
                .iter()
                .map(|s| q(s))
                .collect::<Vec<_>>()
                .join(", "),
            f.on_delete,
            f.on_update
        ));
    }
    let o = &d.options;
    if engine == Engine::Mysql
        && !d.foreign_keys.is_empty()
        && !o
            .engine
            .as_deref()
            .is_some_and(|e| e.eq_ignore_ascii_case("InnoDB"))
    {
        return Err(fail(
            "包含外键的新表请明确选择 InnoDB 引擎，避免外键被存储引擎忽略",
        ));
    }
    let mut sql = format!("CREATE TABLE {} (\n  {}\n)", target, defs.join(",\n  "));
    if o.name.is_some() {
        return Err(fail("建表选项不支持重命名"));
    }
    if engine != Engine::Mysql
        && (o.engine.is_some()
            || o.charset.is_some()
            || o.collation.is_some()
            || o.row_format.is_some()
            || o.auto_increment.is_some())
    {
        return Err(fail("当前引擎不支持 MySQL 表选项"));
    }
    if let Some(comment) = &o.comment {
        if engine == Engine::Mysql {
            sql.push_str(&format!(" COMMENT={}", literal(comment)));
        } else if engine == Engine::Postgres {
            trailing.push(format!(
                "COMMENT ON TABLE {} IS {}",
                target,
                literal(comment)
            ));
        } else if !comment.is_empty() {
            return Err(fail("SQLite 不支持表注释"));
        }
    }
    for (key, value) in [
        ("ENGINE", &o.engine),
        ("DEFAULT CHARACTER SET", &o.charset),
        ("COLLATE", &o.collation),
    ] {
        if let Some(v) = value {
            sql.push_str(&format!(" {key}={}", word(v)?));
        }
    }
    if let Some(v) = &o.row_format {
        if ![
            "DEFAULT",
            "DYNAMIC",
            "COMPACT",
            "REDUNDANT",
            "COMPRESSED",
            "FIXED",
        ]
        .contains(&v.as_str())
        {
            return Err(fail("记录行格式无效"));
        }
        sql.push_str(&format!(" ROW_FORMAT={v}"));
    }
    if let Some(v) = &o.auto_increment {
        let n = v
            .parse::<u64>()
            .map_err(|_| fail("自增起始值必须是正整数"))?;
        if n == 0 || !d.columns.iter().any(|c| c.auto_increment) {
            return Err(fail("自增起始值必须为正整数且存在自动增长列"));
        }
        sql.push_str(&format!(" AUTO_INCREMENT={n}"));
    }
    let mut result = vec![sql];
    result.extend(trailing);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::{sqlite::SqliteAdapter, DbAdapter, SqlParams};
    use sqlx::Row;
    fn draft() -> TableDraft {
        serde_json::from_value(serde_json::json!({
        "schema":null,"table":"children","columns":[
            {"name":"id","dataType":"integer","nullable":false,"primaryKey":true,"autoIncrement":true,"defaultMode":"none"},
            {"name":"parent_id","dataType":"integer","nullable":true,"primaryKey":false,"defaultMode":"null"},
            {"name":"label","dataType":"varchar(100)","nullable":false,"primaryKey":false,"defaultMode":"literal","defaultValue":"O'Reilly; --"}],
        "indexes":[{"name":"idx_children_label","unique":true,"columns":[{"name":"label","desc":true}]}],
        "foreignKeys":[{"name":"fk_children_parent","columns":["parent_id"],"refTable":"parents","refSchema":null,"refColumns":["id"],"onDelete":"SET NULL","onUpdate":"CASCADE"}],"options":{}})).unwrap()
    }
    #[test]
    fn create_draft_three_dialects_and_validation() {
        for engine in [Engine::Mysql, Engine::Postgres, Engine::Sqlite] {
            let mut d = draft();
            if engine == Engine::Mysql {
                d.options.engine = Some("InnoDB".into());
            }
            if engine != Engine::Sqlite {
                d.options.comment = Some("备注 ' \\".into());
                d.columns[2].comment = "字段备注".into();
            }
            let sql = render(engine, "demo", &d).unwrap();
            let dialect: Box<dyn Dialect> = match engine {
                Engine::Mysql => Box::new(MySqlDialect {}),
                Engine::Postgres => Box::new(PostgreSqlDialect {}),
                _ => Box::new(SQLiteDialect {}),
            };
            for statement in &sql {
                assert_eq!(
                    sqlparser::parser::Parser::parse_sql(dialect.as_ref(), statement)
                        .unwrap()
                        .len(),
                    1
                );
            }
            if engine == Engine::Mysql {
                assert_eq!(sql.len(), 1);
                assert!(sql[0].contains("UNIQUE KEY"));
            } else {
                assert!(sql.iter().any(|s| s.starts_with("CREATE UNIQUE INDEX")));
            }
            d.columns[1].name = "id".into();
            assert!(render(engine, "demo", &d).is_err());
            d = draft();
            d.columns[1].data_type = "INT); DROP TABLE parents; --".into();
            assert!(render(engine, "demo", &d).is_err());
            d = draft();
            d.foreign_keys[0].on_delete = "CASCADE; DROP TABLE parents".into();
            assert!(render(engine, "demo", &d).is_err());
            d = draft();
            d.columns[1].nullable = false;
            assert!(render(engine, "demo", &d).is_err());
            d = draft();
            d.indexes[0].columns[0].name = "missing".into();
            assert!(render(engine, "demo", &d).is_err());
        }
        let mut d = draft();
        assert!(render(Engine::Mysql, "demo", &d).is_err());
        d.options.engine = Some("MyISAM".into());
        assert!(render(Engine::Mysql, "demo", &d).is_err());
        d.columns[0].data_type = "bigint".into();
        assert!(render(Engine::Sqlite, "main", &d).is_err());
        d = draft();
        d.options.engine = Some("InnoDB; DROP TABLE parents".into());
        assert!(render(Engine::Mysql, "demo", &d).is_err());
    }
    #[tokio::test]
    async fn create_draft_sqlite_roundtrip_and_atomic_failure() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("draft.db");
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                sqlx::sqlite::SqliteConnectOptions::new()
                    .filename(&path)
                    .create_if_missing(true)
                    .foreign_keys(true),
            )
            .await
            .unwrap();
        sqlx::raw_sql(
            "CREATE TABLE parents(id INTEGER PRIMARY KEY); INSERT INTO parents VALUES(1);",
        )
        .execute(&pool)
        .await
        .unwrap();
        let params =
            serde_json::from_value(serde_json::json!({"engine":"sqlite","filePath":path})).unwrap();
        let adapter = SqliteAdapter::connect(&params).await.unwrap();
        let execute = |sql: Vec<String>| {
            sql.into_iter()
                .map(|sql| SqlParams {
                    sql,
                    params: vec![],
                })
                .collect::<Vec<_>>()
        };
        let d = draft();
        adapter
            .execute_transaction(
                "main",
                &execute(render(Engine::Sqlite, "main", &d).unwrap()),
            )
            .await
            .unwrap();
        sqlx::query("INSERT INTO children(parent_id) VALUES(1)")
            .execute(&pool)
            .await
            .unwrap();
        let row = sqlx::query("SELECT id,label FROM children")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(row.get::<i64, _>(0), 1);
        assert_eq!(row.get::<String, _>(1), "O'Reilly; --");
        assert!(
            sqlx::query("INSERT INTO children(parent_id,label) VALUES(99,'bad')")
                .execute(&pool)
                .await
                .is_err()
        );
        sqlx::query("DELETE FROM parents WHERE id=1")
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, Option<i64>>("SELECT parent_id FROM children")
                .fetch_one(&pool)
                .await
                .unwrap(),
            None
        );
        let meta = adapter
            .introspect_table("main", None, "children")
            .await
            .unwrap();
        assert_eq!(meta.columns.len(), 3);
        assert_eq!(meta.foreign_keys.len(), 1);
        assert!(meta.indexes.iter().any(|i| i.name == "idx_children_label"));
        let mut failed = draft();
        failed.table = "must_rollback".into();
        assert!(adapter
            .execute_transaction(
                "main",
                &execute(render(Engine::Sqlite, "main", &failed).unwrap())
            )
            .await
            .is_err());
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM sqlite_schema WHERE name='must_rollback'"
            )
            .fetch_one(&pool)
            .await
            .unwrap(),
            0
        );
        // 已存在表的失败不能覆盖原表或数据。
        assert!(adapter
            .execute_transaction(
                "main",
                &execute(render(Engine::Sqlite, "main", &d).unwrap())
            )
            .await
            .is_err());
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM children")
                .fetch_one(&pool)
                .await
                .unwrap(),
            1
        );
    }
}
