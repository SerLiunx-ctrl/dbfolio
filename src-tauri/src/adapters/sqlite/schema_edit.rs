use crate::{
    error::AppResult,
    meta::TableMeta,
    services::{column_edit::*, ddl::DdlSpec},
};
use sqlparser::ast::{ColumnOption, Ident, ObjectName};
use sqlx::{sqlite::SqliteConnectOptions, Connection, Row, SqliteConnection};

pub fn target(spec: &DdlSpec) -> Option<&str> {
    match spec {
        DdlSpec::ColumnFlags { table, .. }
        | DdlSpec::MoveColumn { table, .. }
        | DdlSpec::DropColumn { table, .. } => Some(table),
        _ => None,
    }
}

pub async fn run(
    path: &str,
    meta: &TableMeta,
    spec: &DdlSpec,
    apply: bool,
) -> AppResult<Vec<String>> {
    let table = target(spec).ok_or_else(|| invalid("不支持的 SQLite 结构操作"))?;
    // 独立连接上的 PRAGMA 不污染查询连接；事务错误/取消时由 Transaction 自动回滚。
    let options = SqliteConnectOptions::new()
        .filename(path)
        .read_only(!apply)
        .foreign_keys(false)
        .busy_timeout(std::time::Duration::from_secs(5));
    let mut conn = SqliteConnection::connect_with(&options).await?;
    let mut tx = conn.begin().await?;
    let raw: String =
        sqlx::query_scalar("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?")
            .bind(table)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| invalid("表不存在或为视图"))?;
    if meta.raw_ddl.as_deref() != Some(raw.as_str()) {
        return Err(invalid("表结构已变化，请刷新后重试"));
    }
    let mut statements = Vec::new();
    let mut renames = Vec::new();
    match spec {
        DdlSpec::DropColumn { column, .. } => {
            // 原生 DROP 会检查依赖，不重建或静默丢弃其他约束。
            statements.push(format!(
                "ALTER TABLE {} DROP COLUMN {}",
                ident(table),
                ident(column)
            ));
        }
        _ => {
            let mut create = parse_sqlite_create(&raw)?;
            let original = create.clone();
            match spec {
                DdlSpec::ColumnFlags { changes, .. } => {
                    validate_changes(meta, changes)?;
                    change_sqlite_columns(&mut create, changes)?;
                    for c in changes {
                        if let Some(new) = c.new_name.as_ref().filter(|new| *new != &c.name) {
                            renames.push(format!(
                                "ALTER TABLE {} RENAME COLUMN {} TO {}",
                                ident(table),
                                ident(&c.name),
                                ident(new)
                            ));
                        }
                    }
                }
                DdlSpec::MoveColumn {
                    column, position, ..
                } => {
                    let pos = create
                        .columns
                        .iter()
                        .position(|c| c.name.value == *column)
                        .ok_or_else(|| invalid("字段不存在"))?;
                    let item = create.columns.remove(pos);
                    let index = if position.first {
                        0
                    } else if let Some(after) = &position.after {
                        create
                            .columns
                            .iter()
                            .position(|c| &c.name.value == after)
                            .ok_or_else(|| invalid("目标位置不存在"))?
                            + 1
                    } else {
                        create.columns.len()
                    };
                    create.columns.insert(index, item);
                }
                _ => unreachable!(),
            }
            if create != original {
                let temp = format!("_dbfolio_{}", uuid::Uuid::new_v4().simple());
                create.name = ObjectName::from(vec![Ident::with_quote('"', &temp)]);
                // 原 SQL 的 UNIQUE/CHECK/COLLATE/外键/生成列/STRICT/WITHOUT ROWID 保留在 AST 中。
                let mut columns: Vec<String> = create
                    .columns
                    .iter()
                    .filter(|c| {
                        !c.options
                            .iter()
                            .any(|o| matches!(o.option, ColumnOption::Generated { .. }))
                    })
                    .map(|c| ident(&c.name.value))
                    .collect();
                let integer_pk = meta.primary_key.len() == 1
                    && create.columns.iter().any(|c| {
                        c.name.value == meta.primary_key[0] && c.data_type.to_string() == "INTEGER"
                    });
                if !create.without_rowid && !integer_pk {
                    let rowid = ["rowid", "_rowid_", "oid"]
                        .into_iter()
                        .find(|alias| {
                            !create
                                .columns
                                .iter()
                                .any(|c| c.name.value.eq_ignore_ascii_case(alias))
                        })
                        .ok_or_else(|| {
                            invalid("所有隐藏 rowid 别名均被占用，无法保留行标识，请通过 SQL 管理")
                        })?;
                    columns.insert(0, ident(rowid));
                }
                let objects:Vec<String>=sqlx::query_scalar("SELECT sql FROM sqlite_schema WHERE tbl_name=? AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name").bind(table).fetch_all(&mut *tx).await?;
                let had_sequence: bool = sqlx::query_scalar(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='sqlite_sequence')",
                )
                .fetch_one(&mut *tx)
                .await?;
                let sequence: Option<i64> = if had_sequence {
                    sqlx::query_scalar("SELECT seq FROM sqlite_sequence WHERE name=?")
                        .bind(table)
                        .fetch_optional(&mut *tx)
                        .await?
                } else {
                    None
                };
                let has_auto = create
                    .columns
                    .iter()
                    .any(|c| c.options.iter().any(|o| is_auto(&o.option)));
                let names = columns.join(", ");
                statements.extend([
                    "PRAGMA legacy_alter_table=ON".into(),
                    render_sqlite_create(&create),
                    format!(
                        "INSERT INTO {} ({names}) SELECT {names} FROM {}",
                        ident(&temp),
                        ident(table)
                    ),
                    format!("DROP TABLE {}", ident(table)),
                    format!("ALTER TABLE {} RENAME TO {}", ident(&temp), ident(table)),
                ]);
                statements.extend(objects);
                if let Some(seq) = sequence.filter(|_| has_auto) {
                    statements.push(format!(
                        "UPDATE sqlite_sequence SET seq=MAX(seq,{seq}) WHERE name={}",
                        literal(table)
                    ));
                    statements.push(format!("INSERT INTO sqlite_sequence(name,seq) SELECT {},{seq} WHERE NOT EXISTS(SELECT 1 FROM sqlite_sequence WHERE name={})",literal(table),literal(table)));
                }
                statements.push("PRAGMA legacy_alter_table=OFF".into());
            }
            // 使用原生列重命名更新索引、触发器、视图和外键中的引用。
            statements.extend(renames);
        }
    }
    if statements.is_empty() {
        return Err(invalid("没有需要保存的列修改"));
    }
    if apply {
        for sql in &statements {
            sqlx::query(sql).execute(&mut *tx).await?;
        }
        let violations = sqlx::query("PRAGMA foreign_key_check")
            .fetch_all(&mut *tx)
            .await?;
        if let Some(row) = violations.first() {
            let name: String = row.try_get(0)?;
            return Err(invalid(format!(
                "外键检查未通过（{name}），本次全部修改已回滚"
            )));
        }
        tx.commit().await?;
    } else {
        tx.rollback().await?;
    }
    let mut preview = vec!["PRAGMA foreign_keys=OFF".into(), "BEGIN TRANSACTION".into()];
    preview.extend(statements);
    preview.extend([
        "PRAGMA foreign_key_check".into(),
        "COMMIT".into(),
        "PRAGMA foreign_keys=ON".into(),
    ]);
    Ok(preview)
}
