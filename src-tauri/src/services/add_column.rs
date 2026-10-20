use super::{
    column_edit::{ident, invalid},
    create_table::{render_column, DraftColumn},
    ddl::ColumnPosition,
};
use crate::{
    error::AppResult,
    meta::{Engine, TableKind, TableMeta},
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ColumnKey {
    None,
    Primary,
    Index,
    Unique,
}

pub fn render(
    engine: Engine,
    target: &str,
    meta: &TableMeta,
    column: &DraftColumn,
    key: ColumnKey,
    position: Option<&ColumnPosition>,
) -> AppResult<Vec<String>> {
    if meta.kind != TableKind::Table {
        return Err(invalid("仅普通表支持添加列"));
    }
    if !matches!(engine, Engine::Mysql | Engine::Postgres | Engine::Sqlite) {
        return Err(invalid("仅关系型数据库支持添加列"));
    }
    if meta.columns.iter().any(|c| {
        if engine == Engine::Postgres {
            c.name == column.name
        } else {
            c.name.eq_ignore_ascii_case(&column.name)
        }
    }) {
        return Err(invalid("字段名已存在"));
    }
    if column.primary_key != (key == ColumnKey::Primary) {
        return Err(invalid("主键设置不一致"));
    }
    if key == ColumnKey::Primary && !meta.primary_key.is_empty() {
        return Err(invalid("表已有主键，请通过索引页管理复合主键"));
    }
    if column.auto_increment
        && engine == Engine::Mysql
        && meta.columns.iter().any(|c| c.auto_increment)
    {
        return Err(invalid("MySQL 每张表只能有一个自动增长字段"));
    }
    if engine == Engine::Sqlite {
        if key == ColumnKey::Primary || column.auto_increment {
            return Err(invalid("SQLite 追加列不能设置主键或自动增长；需要重建表"));
        }
        if column.default_mode == "timestamp" {
            return Err(invalid(
                "SQLite 追加列只支持常量默认值，CURRENT_TIMESTAMP 需要重建表",
            ));
        }
        if !column.nullable && column.default_mode != "literal" {
            return Err(invalid("SQLite 追加不可空列需要非 NULL 的常量默认值"));
        }
    }
    if engine != Engine::Mysql && position.is_some_and(|p| p.first || p.after.is_some()) {
        return Err(invalid("此数据库添加列仅支持追加到末尾"));
    }
    let q = |name: &str| {
        if engine == Engine::Mysql {
            format!("`{}`", name.replace('`', "``"))
        } else {
            ident(name)
        }
    };
    let (definition, comments) = render_column(
        engine,
        target,
        column,
        usize::from(key == ColumnKey::Primary),
        key != ColumnKey::None,
    )?;
    let mut add = format!("ALTER TABLE {target} ADD COLUMN {definition}");
    if let Some(pos) = position.filter(|_| engine == Engine::Mysql) {
        if pos.first {
            add.push_str(" FIRST");
        } else if let Some(after) = &pos.after {
            if !meta.columns.iter().any(|c| &c.name == after) {
                return Err(invalid("插入位置的字段已不存在，请刷新结构"));
            }
            add.push_str(&format!(" AFTER {}", q(after)));
        }
    }
    let mut trailing = Vec::new();
    if key == ColumnKey::Primary {
        add.push_str(&format!(", ADD PRIMARY KEY ({})", q(&column.name)));
    }
    if matches!(key, ColumnKey::Index | ColumnKey::Unique) {
        // 稳定名称保证预览和执行一致；包含表标识以避免跨表重名。
        use sha2::{Digest, Sha256};
        let hash = format!("{:x}", Sha256::digest(format!("{target}\0{}", column.name)));
        let base = format!("idx_{}", &hash[..24]);
        let mut name = base.clone();
        let mut suffix = 1;
        while meta
            .indexes
            .iter()
            .any(|i| i.name.eq_ignore_ascii_case(&name))
        {
            name = format!("{base}_{suffix}");
            suffix += 1;
        }
        if engine == Engine::Mysql {
            add.push_str(&format!(
                ", ADD {}INDEX {} ({})",
                if key == ColumnKey::Unique {
                    "UNIQUE "
                } else {
                    ""
                },
                q(&name),
                q(&column.name)
            ));
        } else {
            trailing.push(format!(
                "CREATE {}INDEX {} ON {target} ({})",
                if key == ColumnKey::Unique {
                    "UNIQUE "
                } else {
                    ""
                },
                q(&name),
                q(&column.name)
            ));
        }
    }
    let mut statements = vec![add];
    statements.extend(comments);
    statements.extend(trailing);
    Ok(statements)
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn meta() -> TableMeta {
        serde_json::from_value(json!({"name":"t","kind":"table","columns":[],"primaryKey":[],"indexes":[],"foreignKeys":[]})).unwrap()
    }
    fn col(ty: &str) -> DraftColumn {
        serde_json::from_value(
            json!({"name":"value","dataType":ty,"nullable":true,"primaryKey":false}),
        )
        .unwrap()
    }
    #[test]
    fn full_attributes_and_stable_preview() {
        let m = meta();
        let mut c = col("decimal(18,6)");
        c.unsigned = true;
        c.default_mode = "literal".into();
        c.default_value = "12.345678".into();
        c.comment = "金额 C:\\it's".into();
        let first = render(Engine::Mysql, "`d`.`t`", &m, &c, ColumnKey::Unique, None).unwrap();
        assert_eq!(
            first,
            render(Engine::Mysql, "`d`.`t`", &m, &c, ColumnKey::Unique, None).unwrap()
        );
        let sql = &first[0];
        assert!(sql.contains("decimal(18,6) UNSIGNED"));
        assert!(sql.contains("DEFAULT '12.345678'"));
        assert!(sql.contains("ADD UNIQUE INDEX"));
        assert!(sql.contains("COMMENT '金额 C:\\\\it''s'"));
        c = col("datetime(3)");
        c.default_mode = "timestamp".into();
        c.on_update = "CURRENT_TIMESTAMP".into();
        let sql = render(Engine::Mysql, "t", &m, &c, ColumnKey::None, None)
            .unwrap()
            .join(";");
        assert!(sql.contains("DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)"));
        c.data_type = "date".into();
        assert!(render(Engine::Mysql, "t", &m, &c, ColumnKey::None, None).is_err());
        c.data_type = "datetime(7)".into();
        assert!(render(Engine::Mysql, "t", &m, &c, ColumnKey::None, None).is_err());
        c = col("ENUM('Active','Paused')");
        c.default_mode = "literal".into();
        c.default_value = "Active".into();
        assert!(
            render(Engine::Mysql, "t", &m, &c, ColumnKey::None, None).unwrap()[0]
                .contains("ENUM('Active','Paused') DEFAULT 'Active'")
        );
    }
    #[test]
    fn identity_keys_defaults_and_engine_capabilities() {
        let m = meta();
        let mut c = col("bigint");
        c.auto_increment = true;
        c.nullable = false;
        assert!(render(Engine::Mysql, "t", &m, &c, ColumnKey::None, None).is_err());
        assert!(
            render(Engine::Mysql, "t", &m, &c, ColumnKey::Index, None).unwrap()[0]
                .contains("AUTO_INCREMENT, ADD INDEX")
        );
        assert!(render(
            Engine::Postgres,
            "\"public\".\"t\"",
            &m,
            &c,
            ColumnKey::None,
            None
        )
        .unwrap()[0]
            .contains("GENERATED BY DEFAULT AS IDENTITY"));
        assert!(render(Engine::Sqlite, "t", &m, &c, ColumnKey::None, None).is_err());
        c = col("varchar(20)");
        c.comment = "备注 C:\\it's".into();
        assert_eq!(
            render(Engine::Postgres, "t", &m, &c, ColumnKey::Unique, None)
                .unwrap()
                .len(),
            3
        );
        assert!(render(Engine::Sqlite, "t", &m, &c, ColumnKey::None, None).is_err());
        c.comment.clear();
        for (mode, value, expected) in [
            ("none", "", "varchar(20)"),
            ("null", "", "DEFAULT NULL"),
            ("literal", "", "DEFAULT ''"),
            ("literal", "NULL", "DEFAULT 'NULL'"),
        ] {
            c.default_mode = mode.into();
            c.default_value = value.into();
            assert!(
                render(Engine::Sqlite, "t", &m, &c, ColumnKey::None, None).unwrap()[0]
                    .ends_with(expected)
            );
        }
        c.default_mode = "timestamp".into();
        assert!(render(Engine::Sqlite, "t", &m, &c, ColumnKey::None, None).is_err());
        c.default_mode = "none".into();
        c.nullable = false;
        assert!(render(Engine::Sqlite, "t", &m, &c, ColumnKey::None, None).is_err());
        c = col("int); DROP TABLE t; --");
        assert!(render(Engine::Mysql, "t", &m, &c, ColumnKey::None, None).is_err());
    }
    #[tokio::test]
    async fn sqlite_add_is_atomic_and_preserves_existing_rows() {
        use crate::{
            services::{ddl, session},
            state::AppState,
            store::LocalStore,
        };
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data.sqlite");
        std::fs::File::create(&path).unwrap();
        let state = AppState::with_local(
            LocalStore::initialize_in(dir.path().join("config"))
                .await
                .unwrap(),
        );
        let input = serde_json::from_value(
            json!({"name":"test","engine":"sqlite","filePath":path,"readOnly":false}),
        )
        .unwrap();
        let s = state.local.create_session(&input).await.unwrap();
        session::connect(&state, &s.id).await.unwrap();
        let adapter = state.connected(&s.id).await.unwrap().adapter.clone();
        adapter
            .execute_statements(
                "main",
                &[
                    "CREATE TABLE t(id INTEGER)".into(),
                    "INSERT INTO t VALUES(1),(2)".into(),
                ],
            )
            .await
            .unwrap();
        let mut c = col("TEXT");
        c.default_mode = "literal".into();
        c.default_value = "same".into();
        let mut spec = ddl::DdlSpec::AddColumnDraft {
            schema: None,
            table: "t".into(),
            column: c,
            key: ColumnKey::Unique,
            position: None,
        };
        assert_eq!(
            ddl::preview(&state, &s.id, "main", &spec)
                .await
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            adapter
                .introspect_table("main", None, "t")
                .await
                .unwrap()
                .columns
                .len(),
            1
        );
        assert!(ddl::apply(&state, &s.id, "main", &spec, true)
            .await
            .is_err());
        assert_eq!(
            adapter
                .introspect_table("main", None, "t")
                .await
                .unwrap()
                .columns
                .len(),
            1,
            "索引失败应回滚添加列"
        );
        if let ddl::DdlSpec::AddColumnDraft { column, key, .. } = &mut spec {
            *key = ColumnKey::Index;
            column.default_value = "".into();
        }
        ddl::apply(&state, &s.id, "main", &spec, true)
            .await
            .unwrap();
        let meta = adapter.introspect_table("main", None, "t").await.unwrap();
        assert_eq!(meta.columns.len(), 2);
        assert_eq!(meta.indexes.len(), 1);
        let pool = sqlx::SqlitePool::connect(&format!("sqlite:{}", path.display()))
            .await
            .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM t WHERE value='' AND id IN (1,2)")
                .fetch_one(&pool)
                .await
                .unwrap(),
            2
        );
        pool.close().await;
        state.disconnect(&s.id).await;
    }
}
