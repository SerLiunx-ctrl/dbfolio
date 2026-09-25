use super::*;
use crate::meta::{ForeignKeyMeta, IndexMeta, TableKind};
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaPlan {
    pub id: String,
    pub statements: Vec<SyncStatement>,
    pub groups: Vec<Vec<usize>>,
    pub warnings: Vec<String>,
}
pub struct StoredPlan {
    request: SchemaSyncRequest,
    snapshot: String,
    plan: SchemaPlan,
    created: Instant,
}
#[derive(Default)]
pub struct Registry(Mutex<HashMap<String, StoredPlan>>);

pub(super) async fn read_table(
    adapter: &dyn DbAdapter,
    database: &str,
    name: &str,
) -> AppResult<Option<TableMeta>> {
    let tables = adapter.list_tables(database).await?;
    let matches: Vec<_> = tables.iter().filter(|t| t.name == name).collect();
    if matches.len() > 1 {
        return Err(AppError::InvalidInput(format!(
            "表 {name} 在多个 schema 中存在，暂不支持歧义对象同步"
        )));
    }
    match matches.first() {
        None => Ok(None),
        Some(t) => {
            if t.kind != TableKind::Table {
                return Err(AppError::InvalidInput(format!(
                    "{name} 是视图，不能按数据表同步"
                )));
            }
            let meta = adapter
                .introspect_table(database, t.schema.as_deref(), name)
                .await?;
            if meta.columns.is_empty() {
                return Err(AppError::Database(format!(
                    "无法读取 {database}.{name} 的字段，已停止同步"
                )));
            }
            Ok(Some(meta))
        }
    }
}

pub(super) fn same_index(a: &IndexMeta, b: &IndexMeta) -> bool {
    a.unique == b.unique
        && a.primary == b.primary
        && a.method
            .as_deref()
            .unwrap_or("BTREE")
            .eq_ignore_ascii_case(b.method.as_deref().unwrap_or("BTREE"))
        && a.comment.as_deref().unwrap_or("") == b.comment.as_deref().unwrap_or("")
        && a.columns.len() == b.columns.len()
        && a.columns
            .iter()
            .zip(&b.columns)
            .all(|(a, b)| a.name == b.name && a.desc == b.desc && a.prefix_len == b.prefix_len)
}
pub(super) fn same_fk(
    a: &ForeignKeyMeta,
    b: &ForeignKeyMeta,
    source_db: Option<&str>,
    target_db: Option<&str>,
) -> bool {
    let local = |fk: &ForeignKeyMeta, db: Option<&str>| {
        fk.ref_database.as_deref().is_none() || fk.ref_database.as_deref() == db
    };
    a.columns == b.columns
        && a.ref_table == b.ref_table
        && a.ref_columns == b.ref_columns
        && a.ref_schema == b.ref_schema
        && ((local(a, source_db) && local(b, target_db)) || a.ref_database == b.ref_database)
        && a.on_delete.eq_ignore_ascii_case(&b.on_delete)
        && a.on_update.eq_ignore_ascii_case(&b.on_update)
}
pub(super) fn table_details(a: &TableMeta, b: &TableMeta) -> Vec<String> {
    let mut out = Vec::new();
    if primary_changed(a, b) {
        out.push(format!(
            "主键：目标 ({}) → 源 ({})",
            b.primary_key.join(", "),
            a.primary_key.join(", ")
        ));
    }
    if a.comment.as_deref().unwrap_or("") != b.comment.as_deref().unwrap_or("") {
        out.push("表注释不同".into());
    }
    out
}

// SHOW CREATE TABLE emits each column on its own line. Preserve the complete
// definition, including generated expressions and ON UPDATE, instead of losing it.
pub(super) fn mysql_columns(meta: &TableMeta) -> AppResult<HashMap<String, String>> {
    let ddl = meta.raw_ddl.as_deref().ok_or_else(|| {
        AppError::Database(format!(
            "无法读取 {} 的完整建表语句，不能保证无损结构同步",
            meta.name
        ))
    })?;
    let mut out = HashMap::new();
    for line in ddl.lines() {
        let line = line.trim();
        if !line.starts_with('`') {
            continue;
        }
        let mut chars = line.char_indices().peekable();
        chars.next();
        let mut name = String::new();
        let mut end = None;
        while let Some((i, c)) = chars.next() {
            if c == '`' {
                if chars.peek().map(|(_, c)| *c == '`').unwrap_or(false) {
                    chars.next();
                    name.push('`');
                } else {
                    end = Some(i + 1);
                    break;
                }
            } else {
                name.push(c);
            }
        }
        if let Some(end) = end {
            let rest = line[end..].trim().trim_end_matches(',').trim();
            if !rest.is_empty() {
                out.insert(name, rest.to_string());
            }
        }
    }
    if meta.columns.iter().any(|c| !out.contains_key(&c.name)) {
        return Err(AppError::InvalidInput(format!(
            "无法完整解析 {} 的字段定义，请手动处理",
            meta.name
        )));
    }
    Ok(out)
}
fn primary_sql(adapter: &dyn DbAdapter, meta: &TableMeta) -> String {
    if let Some(index) = meta.indexes.iter().find(|i| i.primary) {
        format!(
            "PRIMARY KEY ({})",
            index
                .columns
                .iter()
                .map(|c| format!(
                    "{}{}{}",
                    quote(adapter, &c.name),
                    c.prefix_len.map(|n| format!("({n})")).unwrap_or_default(),
                    if c.desc { " DESC" } else { "" }
                ))
                .collect::<Vec<_>>()
                .join(", ")
        )
    } else {
        format!(
            "PRIMARY KEY ({})",
            meta.primary_key
                .iter()
                .map(|c| quote(adapter, c))
                .collect::<Vec<_>>()
                .join(", ")
        )
    }
}
pub(super) fn primary_changed(a: &TableMeta, b: &TableMeta) -> bool {
    a.primary_key != b.primary_key
        || match (
            a.indexes.iter().find(|i| i.primary),
            b.indexes.iter().find(|i| i.primary),
        ) {
            (Some(a), Some(b)) => !same_index(a, b),
            _ => false,
        }
}

fn stable_meta(mut meta: TableMeta) -> serde_json::Value {
    meta.row_estimate = None;
    // MySQL SHOW CREATE includes a counter that changes with data, not schema.
    if let Some(ddl) = meta.raw_ddl.as_mut() {
        if let Some(start) = ddl.find(" AUTO_INCREMENT=") {
            let end = start
                + 16
                + ddl[start + 16..]
                    .bytes()
                    .take_while(u8::is_ascii_digit)
                    .count();
            ddl.replace_range(start..end, "");
        }
    }
    serde_json::to_value(meta).expect("metadata is serializable")
}
async fn fingerprint(pair: &AdapterPair, request: &SchemaSyncRequest) -> AppResult<String> {
    let mut values = Vec::new();
    // Include all target tables: incoming foreign keys outside the chosen scope matter too.
    for (adapter, database, names) in [
        (
            pair.source.as_ref(),
            request.source.database.as_str(),
            request.tables.clone(),
        ),
        (
            pair.target.as_ref(),
            request.target.database.as_str(),
            pair.target
                .list_tables(&request.target.database)
                .await?
                .into_iter()
                .filter(|t| t.kind == TableKind::Table)
                .map(|t| t.name)
                .chain(request.tables.clone())
                .collect(),
        ),
    ] {
        let mut names = names;
        names.sort();
        names.dedup();
        for name in names {
            crate::tasks::checkpoint()?;
            let meta = read_table(adapter, database, &name).await?;
            let extra = if meta.is_some() && pair.engine == Engine::Mysql {
                let e = adapter.table_extra_info(database, None, &name).await?;
                serde_json::json!([e.engine, e.charset, e.collation])
            } else {
                serde_json::Value::Null
            };
            values.push(serde_json::json!([
                database,
                name,
                meta.map(stable_meta),
                extra
            ]));
        }
    }
    Ok(serde_json::to_string(&values).expect("snapshot is serializable"))
}
fn warning(table: &str, text: impl Into<String>) -> SyncStatement {
    SyncStatement {
        table: table.into(),
        kind: "warning".into(),
        description: text.into(),
        sql: String::new(),
    }
}
fn statement(
    table: &str,
    kind: &str,
    description: impl Into<String>,
    sql: String,
) -> SyncStatement {
    SyncStatement {
        table: table.into(),
        kind: kind.into(),
        description: description.into(),
        sql,
    }
}
fn index_sql(adapter: &dyn DbAdapter, index: &IndexMeta) -> AppResult<String> {
    if index.columns.is_empty() || index.columns.iter().any(|c| c.name.is_empty()) {
        return Err(AppError::InvalidInput(format!(
            "索引 {} 含表达式或不可识别字段，需手动处理",
            index.name
        )));
    }
    let method = index
        .method
        .as_deref()
        .unwrap_or("BTREE")
        .to_ascii_uppercase();
    if !["BTREE", "HASH", "FULLTEXT", "SPATIAL"].contains(&method.as_str()) {
        return Err(AppError::InvalidInput(format!("暂不支持索引方法 {method}")));
    }
    let prefix = if method == "FULLTEXT" || method == "SPATIAL" {
        format!("{method} ")
    } else if index.unique {
        "UNIQUE ".into()
    } else {
        String::new()
    };
    let using = if method == "BTREE" || method == "HASH" {
        format!(" USING {method}")
    } else {
        String::new()
    };
    let columns = index
        .columns
        .iter()
        .map(|c| {
            format!(
                "{}{}{}",
                quote(adapter, &c.name),
                c.prefix_len.map(|v| format!("({v})")).unwrap_or_default(),
                if c.desc { " DESC" } else { "" }
            )
        })
        .collect::<Vec<_>>()
        .join(", ");
    Ok(format!(
        "{prefix}INDEX {}{using} ({columns}){}",
        quote(adapter, &index.name),
        index
            .comment
            .as_ref()
            .map(|c| format!(" COMMENT {}", literal(c)))
            .unwrap_or_default()
    ))
}
fn literal(value: &str) -> String {
    format!("'{}'", value.replace('\\', "\\\\").replace('\'', "''"))
}
fn fk_clause(
    adapter: &dyn DbAdapter,
    source_db: &str,
    target_db: &str,
    fk: &ForeignKeyMeta,
) -> AppResult<String> {
    let reference_db = match fk.ref_database.as_deref() {
        Some(db) if db != source_db => db,
        _ => target_db,
    };
    let action = |v: &str| -> AppResult<String> {
        let v = v.to_ascii_uppercase();
        if [
            "CASCADE",
            "RESTRICT",
            "NO ACTION",
            "SET NULL",
            "SET DEFAULT",
        ]
        .contains(&v.as_str())
        {
            Ok(v)
        } else {
            Err(AppError::InvalidInput("无法识别外键动作".into()))
        }
    };
    Ok(format!(
        "CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {} ({}) ON DELETE {} ON UPDATE {}",
        quote(adapter, &fk.name),
        fk.columns
            .iter()
            .map(|c| quote(adapter, c))
            .collect::<Vec<_>>()
            .join(", "),
        table_ref(adapter, reference_db, None, &fk.ref_table),
        fk.ref_columns
            .iter()
            .map(|c| quote(adapter, c))
            .collect::<Vec<_>>()
            .join(", "),
        action(&fk.on_delete)?,
        action(&fk.on_update)?
    ))
}

fn allowed(o: &SchemaSyncOptions, table: &str, kind: &str, name: &str) -> bool {
    !o.excluded_changes
        .contains(&serde_json::to_string(&[table, kind, name]).unwrap())
}
fn final_columns(
    src: Option<&TableMeta>,
    tgt: Option<&TableMeta>,
    o: &SchemaSyncOptions,
) -> std::collections::HashSet<String> {
    let Some(src) = src else {
        return if o.drop_missing_tables {
            Default::default()
        } else {
            tgt.map(|t| t.columns.iter().map(|c| c.name.clone()).collect())
                .unwrap_or_default()
        };
    };
    let Some(tgt) = tgt else {
        return if o.create_missing_tables {
            src.columns.iter().map(|c| c.name.clone()).collect()
        } else {
            Default::default()
        };
    };
    let mut columns: std::collections::HashSet<_> =
        tgt.columns.iter().map(|c| c.name.clone()).collect();
    if o.add_missing_columns {
        for c in &src.columns {
            if allowed(o, &src.name, "column", &c.name) {
                columns.insert(c.name.clone());
            }
        }
    }
    if o.drop_extra_columns {
        columns.retain(|name| {
            src.columns.iter().any(|c| c.name == *name) || !allowed(o, &src.name, "column", name)
        });
    }
    columns
}

async fn enhance_mysql(
    pair: &AdapterPair,
    request: &SchemaSyncRequest,
    base: Vec<SyncStatement>,
) -> AppResult<Vec<SyncStatement>> {
    let adapter = pair.target.as_ref();
    let o = &request.options;
    let mut out = Vec::new();
    let mut targets = HashMap::new();
    for t in pair
        .target
        .list_tables(&request.target.database)
        .await?
        .into_iter()
        .filter(|t| t.kind == TableKind::Table)
    {
        targets.insert(
            t.name.clone(),
            read_table(adapter, &request.target.database, &t.name)
                .await?
                .ok_or_else(|| AppError::Database("目标表在检查期间消失".into()))?,
        );
    }
    let mut sources = HashMap::new();
    for name in &request.tables {
        if let Some(meta) = read_table(pair.source.as_ref(), &request.source.database, name).await?
        {
            sources.insert(name.clone(), meta);
        }
    }
    let mut changed_tables = std::collections::HashSet::new();
    for name in &request.tables {
        let src = sources.get(name);
        let tgt = targets.get(name);
        let mut items: Vec<_> = base
            .iter()
            .filter(|s| {
                s.table == *name && !["createIndex", "addForeignKey"].contains(&s.kind.as_str())
            })
            .cloned()
            .collect();
        if let Some(src) = src {
            // Rebuilding incomplete metadata would erase these attributes. Fail explicitly.
            let unsupported = src
                .raw_ddl
                .as_deref()
                .into_iter()
                .chain(tgt.and_then(|t| t.raw_ddl.as_deref()))
                .any(|ddl| {
                    let u = ddl.to_ascii_uppercase();
                    [
                        "CHECK (",
                        "CHECK(",
                        "PARTITION BY",
                        " INVISIBLE",
                        " ENFORCED",
                        "WITH SYSTEM VERSIONING",
                    ]
                    .iter()
                    .any(|v| u.contains(v))
                });
            if unsupported
                && (!items.is_empty()
                    || o.sync_primary_key
                    || o.sync_table_options
                    || o.create_indexes
                    || o.create_foreign_keys)
            {
                return Err(AppError::InvalidInput(format!("表 {name} 含 CHECK、分区或不可见属性，当前无法无损同步，请取消选择该表并手动处理")));
            }
            let definitions = mysql_columns(src)?;
            let target_definitions = tgt.map(mysql_columns).transpose()?;
            let target_ref = table_ref(adapter, &request.target.database, None, name);
            let final_columns = final_columns(Some(src), tgt, o);
            if o.create_indexes {
                for index in src
                    .indexes
                    .iter()
                    .filter(|i| !i.primary && allowed(o, name, "index", &i.name))
                {
                    if index
                        .columns
                        .iter()
                        .any(|c| !final_columns.contains(&c.name))
                    {
                        return Err(AppError::InvalidInput(format!(
                            "索引 {} 依赖未同步字段，请同时选择字段变更",
                            index.name
                        )));
                    }
                }
            }
            if o.sync_primary_key
                && allowed(o, name, "primary", "")
                && src.primary_key.iter().any(|c| !final_columns.contains(c))
            {
                return Err(AppError::InvalidInput(format!(
                    "表 {name} 的主键依赖未同步字段"
                )));
            }
            let mut clauses = Vec::new();
            if let Some(tgt) = tgt {
                items.retain(|s| !s.sql.starts_with(&format!("ALTER TABLE {target_ref} ")));
                for column in &src.columns {
                    if !allowed(o, name, "column", &column.name) {
                        continue;
                    }
                    let definition = &definitions[&column.name];
                    match target_definitions
                        .as_ref()
                        .and_then(|defs| defs.get(&column.name))
                    {
                        None if o.add_missing_columns => clauses.push(format!(
                            "ADD COLUMN {} {}",
                            quote(adapter, &column.name),
                            definition
                        )),
                        Some(old) if o.alter_changed_columns && old != definition => {
                            clauses.push(format!(
                                "MODIFY COLUMN {} {}",
                                quote(adapter, &column.name),
                                definition
                            ))
                        }
                        _ => {}
                    }
                }
                if o.drop_extra_columns {
                    for column in &tgt.columns {
                        if !definitions.contains_key(&column.name)
                            && allowed(o, name, "column", &column.name)
                        {
                            clauses.push(format!("DROP COLUMN {}", quote(adapter, &column.name)));
                        }
                    }
                }
                if o.sync_primary_key
                    && allowed(o, name, "primary", "")
                    && primary_changed(src, tgt)
                {
                    if !tgt.primary_key.is_empty() {
                        clauses.push("DROP PRIMARY KEY".into());
                    }
                    if !src.primary_key.is_empty() {
                        clauses.push(format!("ADD {}", primary_sql(adapter, src)));
                    }
                }
                for index in tgt.indexes.iter().filter(|i| !i.primary) {
                    if !allowed(o, name, "index", &index.name) {
                        continue;
                    }
                    let source = src
                        .indexes
                        .iter()
                        .find(|i| !i.primary && i.name == index.name);
                    if source
                        .map(|s| o.create_indexes && !same_index(s, index))
                        .unwrap_or(o.drop_extra_indexes)
                    {
                        clauses.push(format!("DROP INDEX {}", quote(adapter, &index.name)));
                    }
                }
                if o.create_indexes {
                    for index in src
                        .indexes
                        .iter()
                        .filter(|i| !i.primary && allowed(o, name, "index", &i.name))
                    {
                        if !tgt
                            .indexes
                            .iter()
                            .any(|i| i.name == index.name && same_index(i, index))
                        {
                            clauses.push(format!("ADD {}", index_sql(adapter, index)?));
                        }
                    }
                }
                if o.sync_table_options && allowed(o, name, "tableOptions", "") {
                    if src.comment != tgt.comment {
                        clauses.push(format!(
                            "COMMENT = {}",
                            literal(src.comment.as_deref().unwrap_or(""))
                        ));
                    }
                    let a = pair
                        .source
                        .table_extra_info(&request.source.database, None, name)
                        .await?;
                    let b = pair
                        .target
                        .table_extra_info(&request.target.database, None, name)
                        .await?;
                    if a.engine != b.engine {
                        if let Some(v) = a.engine {
                            clauses.push(format!("ENGINE = {}", quote(adapter, &v)));
                        }
                    }
                    if a.charset != b.charset || a.collation != b.collation {
                        if let (Some(charset), Some(collation)) = (a.charset, a.collation) {
                            clauses.push(format!(
                                "DEFAULT CHARACTER SET {} COLLATE {}",
                                quote(adapter, &charset),
                                quote(adapter, &collation)
                            ));
                        }
                    }
                }
                if !clauses.is_empty() {
                    changed_tables.insert(name.clone());
                    items.push(statement(
                        name,
                        "alterTable",
                        format!("更新表 {name}（字段 / 主键 / 索引 / 属性）"),
                        format!("ALTER TABLE {target_ref}\n  {}", clauses.join(",\n  ")),
                    ));
                }
            } else if o.create_missing_tables {
                // Preserve table defaults on new tables, and create indexes inside CREATE TABLE.
                if let Some(create) = items.iter_mut().find(|s| s.kind == "createTable") {
                    let mut columns = src
                        .columns
                        .iter()
                        .map(|c| format!("{} {}", quote(adapter, &c.name), definitions[&c.name]))
                        .collect::<Vec<_>>();
                    if !src.primary_key.is_empty() {
                        columns.push(primary_sql(adapter, src));
                    }
                    create.sql = format!(
                        "CREATE TABLE {target_ref} (\n  {}\n)",
                        columns.join(",\n  ")
                    );

                    if o.create_indexes {
                        let defs = src
                            .indexes
                            .iter()
                            .filter(|i| !i.primary)
                            .map(|i| index_sql(adapter, i))
                            .collect::<AppResult<Vec<_>>>()?;
                        if !defs.is_empty() {
                            let end = create
                                .sql
                                .rfind(')')
                                .expect("create table closing parenthesis");
                            create
                                .sql
                                .insert_str(end, &format!(",\n  {}\n", defs.join(",\n  ")));
                        }
                    }
                    let e = pair
                        .source
                        .table_extra_info(&request.source.database, None, name)
                        .await?;
                    if let Some(v) = e.engine {
                        create
                            .sql
                            .push_str(&format!(" ENGINE = {}", quote(adapter, &v)));
                    }
                    if let Some(v) = e.charset {
                        create
                            .sql
                            .push_str(&format!(" DEFAULT CHARACTER SET {}", quote(adapter, &v)));
                    }
                    if let Some(v) = e.collation {
                        create
                            .sql
                            .push_str(&format!(" COLLATE {}", quote(adapter, &v)));
                    }
                    if let Some(v) = &src.comment {
                        create.sql.push_str(&format!(" COMMENT = {}", literal(v)));
                    }
                }
            }
        }
        if items.iter().any(|s| s.kind == "dropTable") {
            changed_tables.insert(name.clone());
        }
        out.extend(items);
    }
    // Drop affected constraints before any table change. Never modify unselected tables.
    let mut fk_drops = Vec::new();
    let mut fk_adds = Vec::new();
    for (name, tgt) in &targets {
        for fk in &tgt.foreign_keys {
            let src = sources.get(name);
            let source_fk = src.and_then(|s| s.foreign_keys.iter().find(|f| f.name == fk.name));
            let selected = request.tables.contains(name);
            let local = fk
                .ref_database
                .as_deref()
                .map(|v| v == request.target.database)
                .unwrap_or(true);
            let affected =
                changed_tables.contains(name) || (local && changed_tables.contains(&fk.ref_table));
            let replace = selected
                && allowed(o, name, "foreignKey", &fk.name)
                && source_fk
                    .map(|s| {
                        o.create_foreign_keys
                            && !same_fk(
                                s,
                                fk,
                                Some(&request.source.database),
                                Some(&request.target.database),
                            )
                    })
                    .unwrap_or(o.drop_extra_foreign_keys);
            if affected && !selected {
                return Err(AppError::InvalidInput(format!(
                    "未选表 {name} 的外键 {} 引用了待修改表 {}；请将依赖表一并选中",
                    fk.name, fk.ref_table
                )));
            }
            if affected || replace {
                fk_drops.push(statement(
                    name,
                    "dropForeignKey",
                    format!("暂时移除外键 {}", fk.name),
                    format!(
                        "ALTER TABLE {} DROP FOREIGN KEY {}",
                        table_ref(adapter, &request.target.database, None, name),
                        quote(adapter, &fk.name)
                    ),
                ));
                let dropping = src.is_none() && o.drop_missing_tables;
                if !dropping
                    && !(source_fk.is_none()
                        && o.drop_extra_foreign_keys
                        && allowed(o, name, "foreignKey", &fk.name))
                {
                    let restore = if replace { source_fk.unwrap_or(fk) } else { fk };
                    let from = if replace {
                        &request.source.database
                    } else {
                        &request.target.database
                    };
                    if local
                        && sources.get(&fk.ref_table).is_none()
                        && request.tables.contains(&fk.ref_table)
                        && o.drop_missing_tables
                    {
                        return Err(AppError::InvalidInput(format!(
                            "外键 {} 仍引用待删除表 {}，请先处理此依赖",
                            fk.name, fk.ref_table
                        )));
                    }
                    let columns = final_columns(src, Some(tgt), o);
                    if restore.columns.iter().any(|c| !columns.contains(c)) {
                        return Err(AppError::InvalidInput(format!(
                            "外键 {} 依赖将被删除的字段，请同时处理外键",
                            restore.name
                        )));
                    }
                    let ref_columns = final_columns(
                        sources.get(&restore.ref_table),
                        targets.get(&restore.ref_table),
                        o,
                    );
                    if local
                        && request.tables.contains(&restore.ref_table)
                        && restore.ref_columns.iter().any(|c| !ref_columns.contains(c))
                    {
                        return Err(AppError::InvalidInput(format!(
                            "外键 {} 依赖未同步或将被删除的引用字段",
                            restore.name
                        )));
                    }
                    fk_adds.push(statement(
                        name,
                        "addForeignKey",
                        format!("恢复外键 {}", fk.name),
                        format!(
                            "ALTER TABLE {} ADD {}",
                            table_ref(adapter, &request.target.database, None, name),
                            fk_clause(adapter, from, &request.target.database, restore)?
                        ),
                    ));
                }
            }
        }
    }
    if o.create_foreign_keys {
        for name in &request.tables {
            if let Some(src) = sources.get(name) {
                if !targets.contains_key(name) && !o.create_missing_tables {
                    continue;
                }
                for fk in &src.foreign_keys {
                    if !allowed(o, name, "foreignKey", &fk.name) {
                        continue;
                    }
                    if targets
                        .get(name)
                        .map(|t| t.foreign_keys.iter().any(|f| f.name == fk.name))
                        .unwrap_or(false)
                    {
                        continue;
                    }
                    fk_adds.push(statement(
                        name,
                        "addForeignKey",
                        format!("添加外键 {}", fk.name),
                        format!(
                            "ALTER TABLE {} ADD {}",
                            table_ref(adapter, &request.target.database, None, name),
                            fk_clause(
                                adapter,
                                &request.source.database,
                                &request.target.database,
                                fk
                            )?
                        ),
                    ));
                }
            }
        }
    }
    for name in &request.tables {
        if let Some(src) = sources.get(name) {
            if o.create_foreign_keys {
                for fk in &src.foreign_keys {
                    if !allowed(o, name, "foreignKey", &fk.name) {
                        continue;
                    }
                    let columns = final_columns(Some(src), targets.get(name), o);
                    if fk.columns.iter().any(|c| !columns.contains(c)) {
                        return Err(AppError::InvalidInput(format!(
                            "外键 {} 依赖未同步字段",
                            fk.name
                        )));
                    }
                    let local = fk
                        .ref_database
                        .as_deref()
                        .map(|db| db == request.source.database)
                        .unwrap_or(true);
                    let will_exist = targets.contains_key(&fk.ref_table)
                        || (o.create_missing_tables && sources.contains_key(&fk.ref_table));
                    if local && !will_exist {
                        return Err(AppError::InvalidInput(format!(
                            "外键 {} 引用的表 {} 在目标不存在，请一并选中创建",
                            fk.name, fk.ref_table
                        )));
                    }
                }
            }
        }
    }
    fk_drops.sort_by(|a, b| a.sql.cmp(&b.sql));
    fk_adds.sort_by(|a, b| a.sql.cmp(&b.sql));
    fk_drops.extend(out);
    fk_drops.extend(fk_adds);
    Ok(fk_drops)
}

pub async fn prepare(state: &AppState, request: &SchemaSyncRequest) -> AppResult<SchemaPlan> {
    if request.tables.is_empty() {
        return Err(AppError::InvalidInput("请选择需要同步的表".into()));
    }
    if request
        .tables
        .iter()
        .collect::<std::collections::HashSet<_>>()
        .len()
        != request.tables.len()
    {
        return Err(AppError::InvalidInput("同步表列表包含重复对象".into()));
    }
    let pair = connect_pair(state, &request.source, &request.target).await?;
    if pair.engine != Engine::Mysql && !request.options.excluded_changes.is_empty() {
        return Err(AppError::InvalidInput(
            "逐项排除结构差异目前仅支持 MySQL，请清空排除项或使用结构选项".into(),
        ));
    }
    let before = fingerprint(&pair, request).await?;
    let base = build_schema_script(
        &pair,
        &request.source,
        &request.target,
        &request.tables,
        &request.options,
    )
    .await?;
    let mut statements = if pair.engine == Engine::Mysql {
        enhance_mysql(&pair, request, base).await?
    } else {
        base
    };
    if pair.engine != Engine::Mysql {
        for name in &request.tables {
            if let (Some(a), Some(b)) = (
                read_table(pair.source.as_ref(), &request.source.database, name).await?,
                read_table(pair.target.as_ref(), &request.target.database, name).await?,
            ) {
                if a.primary_key != b.primary_key {
                    statements.push(warning(name, "主键变更目前仅支持 MySQL 自动同步"));
                }
                for i in diff_indexes(&a, &b)
                    .into_iter()
                    .chain(diff_foreign_keys(&a, &b))
                {
                    if i.status == "different" || i.status == "onlyTarget" {
                        statements
                            .push(warning(name, format!("{} 的变更或删除需手动处理", i.name)));
                    }
                }
            }
        }
        // New referenced tables must exist before constraints are added.
        statements.sort_by_key(|s| {
            if s.kind == "addForeignKey" {
                2
            } else if s.kind == "createIndex" {
                1
            } else {
                0
            }
        });
    }
    let after = fingerprint(&pair, request).await?;
    if before != after {
        return Err(AppError::InvalidInput(
            "生成计划期间表结构发生变化，请重新预览".into(),
        ));
    }
    let warnings = statements
        .iter()
        .filter(|s| s.kind == "warning")
        .map(|s| format!("{}：{}", s.table, s.description))
        .collect();
    statements.retain(|s| s.kind != "warning");
    let mut groups: Vec<Vec<usize>> = Vec::new();
    // Constraint detach/restore is indivisible; do not allow half a dependency plan.
    if statements
        .iter()
        .any(|s| s.kind == "addForeignKey" || s.kind == "dropForeignKey")
    {
        if !statements.is_empty() {
            groups.push((0..statements.len()).collect());
        }
    } else {
        for name in &request.tables {
            let ids: Vec<_> = statements
                .iter()
                .enumerate()
                .filter(|(_, s)| s.table == *name)
                .map(|(i, _)| i)
                .collect();
            if !ids.is_empty() {
                groups.push(ids);
            }
        }
    }
    let plan = SchemaPlan {
        id: uuid::Uuid::new_v4().to_string(),
        statements,
        groups,
        warnings,
    };
    let mut registry = state.schema_plans.0.lock().await;
    registry.retain(|_, p| p.created.elapsed() < Duration::from_secs(1800));
    if registry.len() >= 64 {
        if let Some(id) = registry
            .iter()
            .min_by_key(|(_, p)| p.created)
            .map(|(id, _)| id.clone())
        {
            registry.remove(&id);
        }
    }
    registry.insert(
        plan.id.clone(),
        StoredPlan {
            request: request.clone(),
            snapshot: after,
            plan: plan.clone(),
            created: Instant::now(),
        },
    );
    Ok(plan)
}

pub async fn execute(
    state: &AppState,
    id: &str,
    selected: &[usize],
) -> AppResult<SchemaExecuteResult> {
    let stored = state
        .schema_plans
        .0
        .lock()
        .await
        .remove(id)
        .ok_or_else(|| AppError::InvalidInput("同步计划已使用或过期，请重新预览".into()))?;
    if stored.created.elapsed() > Duration::from_secs(1800) {
        return Err(AppError::InvalidInput("同步计划已过期，请重新预览".into()));
    }
    let mut selected = selected.to_vec();
    selected.sort_unstable();
    selected.dedup();
    if selected.is_empty() || selected.iter().any(|i| *i >= stored.plan.statements.len()) {
        return Err(AppError::InvalidInput("请选择有效同步操作".into()));
    }
    for group in &stored.plan.groups {
        let count = group.iter().filter(|i| selected.contains(i)).count();
        if count != 0 && count != group.len() {
            return Err(AppError::InvalidInput(
                "存在相互依赖的操作，请完整选择操作组".into(),
            ));
        }
    }
    let _guard = state.session_lock(&stored.request.target.session_id).await;
    super::super::readonly::writable(state, &stored.request.target.session_id).await?;
    let pair = connect_pair(state, &stored.request.source, &stored.request.target).await?;
    if fingerprint(&pair, &stored.request).await? != stored.snapshot {
        return Err(AppError::InvalidInput(
            "源或目标结构已变化，原计划未执行，请重新对比并预览".into(),
        ));
    }
    let mut result = SchemaExecuteResult {
        executed: 0,
        failed: 0,
        error: None,
    };
    for index in &selected {
        super::super::readonly::writable(state, &stored.request.target.session_id).await?;
        crate::tasks::checkpoint()?;
        let s = &stored.plan.statements[*index];
        match pair
            .target
            .execute_statements(
                &stored.request.target.database,
                std::slice::from_ref(&s.sql),
            )
            .await
        {
            Ok(()) => {
                result.executed += 1;
                crate::tasks::progress(
                    result.executed as u64,
                    Some(selected.len() as u64),
                    format!("{}；已执行语句保留", s.description),
                );
            }
            Err(e) => {
                result.failed = 1;
                result.error = Some(format!(
                    "{}：{}。已成功 {} 条；请检查目标结构后重新预览，已执行操作不会自动撤销。",
                    s.description, e, result.executed
                ));
                break;
            }
        }
    }
    Ok(result)
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::{QueryContext, QueryOutcome};
    use crate::meta::*;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    #[derive(Default)]
    struct Fake {
        tables: Mutex<HashMap<String, TableMeta>>,
        executed: Mutex<Vec<String>>,
        fail_read: AtomicBool,
        fail_write: AtomicBool,
    }
    #[async_trait::async_trait]
    impl DbAdapter for Fake {
        fn engine(&self) -> Engine {
            Engine::Mysql
        }
        fn quote_ident(&self, n: &str) -> String {
            format!("`{}`", n.replace('`', "``"))
        }
        fn placeholder(&self, _: usize) -> String {
            "?".into()
        }
        fn null_safe_eq(&self, c: &str, p: &str) -> String {
            format!("{c} <=> {p}")
        }
        async fn ping(&self) -> AppResult<()> {
            Ok(())
        }
        async fn server_version(&self) -> AppResult<String> {
            Ok("test".into())
        }
        async fn list_databases(&self) -> AppResult<Vec<DatabaseMeta>> {
            Ok(vec![])
        }
        async fn list_tables(&self, _: &str) -> AppResult<Vec<TableRef>> {
            Ok(self
                .tables
                .lock()
                .await
                .values()
                .map(|t| TableRef {
                    name: t.name.clone(),
                    schema: t.schema.clone(),
                    kind: t.kind,
                    row_estimate: None,
                    comment: None,
                    size_bytes: None,
                    engine: Some("InnoDB".into()),
                })
                .collect())
        }
        async fn introspect_table(
            &self,
            _: &str,
            _: Option<&str>,
            n: &str,
        ) -> AppResult<TableMeta> {
            if self.fail_read.load(Ordering::SeqCst) {
                return Err(AppError::Database("没有读取结构权限".into()));
            }
            self.tables
                .lock()
                .await
                .get(n)
                .cloned()
                .ok_or_else(|| AppError::NotFound(n.into()))
        }
        async fn table_extra_info(
            &self,
            _: &str,
            _: Option<&str>,
            _: &str,
        ) -> AppResult<TableExtraInfo> {
            Ok(TableExtraInfo {
                engine: Some("InnoDB".into()),
                charset: Some("utf8mb4".into()),
                collation: Some("utf8mb4_bin".into()),
                ..Default::default()
            })
        }
        async fn server_info(&self) -> AppResult<Vec<InfoEntry>> {
            Ok(vec![])
        }
        async fn database_info(&self, _: &str) -> AppResult<Vec<InfoEntry>> {
            Ok(vec![])
        }
        async fn query_page(
            &self,
            _: &str,
            _: &str,
            _: u64,
            _: u32,
            _: &QueryContext,
        ) -> AppResult<QueryOutcome> {
            unimplemented!()
        }
        async fn execute_affected(&self, _: &str, _: &str) -> AppResult<QueryOutcome> {
            unimplemented!()
        }
        async fn execute_statements(&self, _: &str, sql: &[String]) -> AppResult<()> {
            if self.fail_write.load(Ordering::SeqCst) {
                return Err(AppError::Database("模拟失败".into()));
            }
            self.executed.lock().await.extend_from_slice(sql);
            Ok(())
        }
        async fn execute_transaction(&self, _: &str, _: &[SqlParams]) -> AppResult<u64> {
            unimplemented!()
        }
        async fn cancel(&self, _: u64) -> AppResult<()> {
            Ok(())
        }
        async fn fetch_full_value(&self, _: &str, _: &str) -> AppResult<Option<DbValue>> {
            unimplemented!()
        }
    }
    fn meta(name: &str, db: &str, ty: &str) -> TableMeta {
        TableMeta{name:name.into(),schema:Some(db.into()),kind:TableKind::Table,columns:vec![ColumnMeta{name:"id".into(),ordinal:1,raw_type:ty.into(),canonical:CanonicalType::from_mysql(ty),nullable:false,default_value:None,auto_increment:false,unsigned:false,charset:None,collation:None,comment:None}],primary_key:vec!["id".into()],indexes:vec![],foreign_keys:vec![],comment:None,row_estimate:None,raw_ddl:Some(format!("CREATE TABLE `{name}` (\n  `id` {ty} NOT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB"))}
    }
    fn fk(db: &str) -> ForeignKeyMeta {
        ForeignKeyMeta {
            name: "fk_parent".into(),
            columns: vec!["id".into()],
            ref_database: Some(db.into()),
            ref_schema: None,
            ref_table: "parent".into(),
            ref_columns: vec!["id".into()],
            on_delete: "CASCADE".into(),
            on_update: "RESTRICT".into(),
        }
    }
    async fn setup() -> (
        tempfile::TempDir,
        AppState,
        Arc<Fake>,
        Arc<Fake>,
        SchemaSyncRequest,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::with_local(
            crate::store::LocalStore::initialize_in(dir.path().join("config"))
                .await
                .unwrap(),
        );
        let a = Arc::new(Fake::default());
        let b = Arc::new(Fake::default());
        let mut ids = Vec::new();
        for (name, adapter) in [("a", a.clone()), ("b", b.clone())] {
            let input=serde_json::from_value(serde_json::json!({"name":name,"engine":"mysql","host":"unused","port":3306,"username":"test","readOnly":false})).unwrap();
            let session = state.local.create_session(&input).await.unwrap();
            ids.push(session.id.clone());
            state.connections.lock().await.insert(
                session.id,
                Arc::new(crate::state::ConnectedSession {
                    adapter,
                    key_value: None,
                    mongo: None,
                    server_version: "fake".into(),
                }),
            );
        }
        let request = SchemaSyncRequest {
            source: Endpoint {
                session_id: ids[0].clone(),
                database: "a".into(),
            },
            target: Endpoint {
                session_id: ids[1].clone(),
                database: "b".into(),
            },
            tables: vec!["items".into()],
            options: Default::default(),
        };
        (dir, state, a, b, request)
    }
    #[tokio::test]
    async fn fixed_plan_drift_replay_and_read_failure() {
        let (_dir, state, a, b, r) = setup().await;
        a.tables
            .lock()
            .await
            .insert("items".into(), meta("items", "a", "bigint"));
        b.tables
            .lock()
            .await
            .insert("items".into(), meta("items", "b", "int"));
        let p = prepare(&state, &r).await.unwrap();
        assert!(p.statements[0]
            .sql
            .contains("MODIFY COLUMN `id` bigint NOT NULL"));
        b.tables.lock().await.get_mut("items").unwrap().comment = Some("drift".into());
        assert!(execute(&state, &p.id, &[0])
            .await
            .unwrap_err()
            .to_string()
            .contains("结构已变化"));
        assert!(b.executed.lock().await.is_empty());
        let p = prepare(&state, &r).await.unwrap();
        let expected = p
            .statements
            .iter()
            .map(|s| s.sql.clone())
            .collect::<Vec<_>>();
        assert_eq!(execute(&state, &p.id, &[0]).await.unwrap().executed, 1);
        assert_eq!(*b.executed.lock().await, expected);
        assert!(execute(&state, &p.id, &[0]).await.is_err());
        a.fail_read.store(true, Ordering::SeqCst);
        assert!(prepare(&state, &r)
            .await
            .unwrap_err()
            .to_string()
            .contains("权限"));
        assert!(compare_schema(&state, &r.source, &r.target, &r.tables)
            .await
            .is_err());
    }
    #[tokio::test]
    async fn foreign_keys_order_scope_and_groups() {
        let (_dir, state, a, b, mut r) = setup().await;
        let mut child = meta("child", "a", "int");
        child.foreign_keys.push(fk("a"));
        a.tables.lock().await.extend([
            ("child".into(), child.clone()),
            ("parent".into(), meta("parent", "a", "int")),
        ]);
        r.tables = vec!["child".into(), "parent".into()];
        let p = prepare(&state, &r).await.unwrap();
        assert_eq!(p.statements.last().unwrap().kind, "addForeignKey");
        let sql = &p.statements.last().unwrap().sql;
        assert!(sql.contains("REFERENCES `b`.`parent`"));
        assert!(sql.contains("ON DELETE CASCADE ON UPDATE RESTRICT"));
        assert!(execute(&state, &p.id, &[0]).await.is_err());
        assert!(b.executed.lock().await.is_empty());
        child.schema = Some("b".into());
        child.foreign_keys[0].ref_database = Some("b".into());
        b.tables.lock().await.extend([
            ("child".into(), child),
            ("parent".into(), meta("parent", "b", "bigint")),
        ]);
        r.tables = vec!["parent".into()];
        assert!(prepare(&state, &r)
            .await
            .unwrap_err()
            .to_string()
            .contains("未选表 child"));
        r.tables.push("child".into());
        let p = prepare(&state, &r).await.unwrap();
        assert_eq!(p.statements.first().unwrap().kind, "dropForeignKey");
        assert_eq!(p.statements.last().unwrap().kind, "addForeignKey");
    }
    #[tokio::test]
    async fn indexes_primary_exclusion_and_fail_stop() {
        let (_dir, state, a, b, mut r) = setup().await;
        let mut src = meta("items", "a", "bigint");
        let mut tgt = meta("items", "b", "int");
        tgt.primary_key.clear();
        let idx = IndexMeta {
            name: "idx".into(),
            columns: vec![IndexColumn {
                name: "id".into(),
                desc: true,
                prefix_len: None,
            }],
            unique: true,
            primary: false,
            method: Some("BTREE".into()),
            comment: None,
        };
        src.indexes.push(idx.clone());
        let mut old = idx;
        old.unique = false;
        old.columns[0].desc = false;
        tgt.indexes.push(old);
        a.tables.lock().await.insert("items".into(), src);
        b.tables.lock().await.insert("items".into(), tgt);
        r.options.sync_primary_key = true;
        r.options
            .excluded_changes
            .push(serde_json::to_string(&["items", "column", "id"]).unwrap());
        let p = prepare(&state, &r).await.unwrap();
        let sql = &p.statements[0].sql;
        assert!(!sql.contains("MODIFY"));
        assert!(sql.contains("ADD PRIMARY KEY"));
        assert!(sql.contains("DROP INDEX `idx`"));
        assert!(sql.contains("ADD UNIQUE INDEX `idx` USING BTREE (`id` DESC)"));
        b.fail_write.store(true, Ordering::SeqCst);
        let result = execute(&state, &p.id, &[0]).await.unwrap();
        assert_eq!(result.failed, 1);
        assert_eq!(result.executed, 0);
    }
    #[test]
    fn full_columns_defaults_and_counter() {
        let mut m = meta("items", "a", "int");
        m.raw_ddl=Some("CREATE TABLE `items` (\n `id` int GENERATED ALWAYS AS ((1 + 2)) STORED\n) ENGINE=InnoDB AUTO_INCREMENT=123".into());
        assert_eq!(
            mysql_columns(&m).unwrap()["id"],
            "int GENERATED ALWAYS AS ((1 + 2)) STORED"
        );
        let mut n = m.clone();
        n.raw_ddl = Some(n.raw_ddl.unwrap().replace("123", "456"));
        assert_eq!(stable_meta(m), stable_meta(n));
        let mut index = IndexMeta {
            name: "i".into(),
            columns: vec![IndexColumn {
                name: "name".into(),
                desc: true,
                prefix_len: Some(12),
            }],
            unique: false,
            primary: false,
            method: Some("BTREE".into()),
            comment: None,
        };
        let adapter = Fake::default();
        assert!(index_sql(&adapter, &index)
            .unwrap()
            .contains("`name`(12) DESC"));
        let other = index.clone();
        index.columns[0].prefix_len = Some(10);
        assert!(!same_index(&index, &other));
    }
    #[tokio::test]
    async fn real_sqlite_plan_and_readonly() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::with_local(
            crate::store::LocalStore::initialize_in(dir.path().join("config"))
                .await
                .unwrap(),
        );
        let mut endpoints = Vec::new();
        for name in ["source", "target"] {
            let path = dir.path().join(format!("{name}.sqlite"));
            std::fs::File::create(&path).unwrap();
            let input=serde_json::from_value(serde_json::json!({"name":name,"engine":"sqlite","filePath":path.to_str().unwrap(),"readOnly":false})).unwrap();
            let session = state.local.create_session(&input).await.unwrap();
            crate::services::session::connect(&state, &session.id)
                .await
                .unwrap();
            endpoints.push(Endpoint {
                session_id: session.id,
                database: "main".into(),
            });
        }
        let source = state.connected(&endpoints[0].session_id).await.unwrap();
        source
            .adapter
            .execute_affected(
                "main",
                "CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT)",
            )
            .await
            .unwrap();
        let r = SchemaSyncRequest {
            source: endpoints[0].clone(),
            target: endpoints[1].clone(),
            tables: vec!["items".into()],
            options: Default::default(),
        };
        let p = prepare(&state, &r).await.unwrap();
        let result = execute(&state, &p.id, &[0]).await.unwrap();
        assert_eq!(result.executed, 1);
        assert!(prepare(&state, &r).await.unwrap().statements.is_empty());
        source
            .adapter
            .execute_affected("main", "ALTER TABLE items ADD COLUMN extra TEXT")
            .await
            .unwrap();
        let p = prepare(&state, &r).await.unwrap();
        // Toggle the stored target flag without opening any user database.
        let mut session = state.local.get_session(&r.target.session_id).await.unwrap();
        session.read_only = true;
        let input: crate::store::SessionInput =
            serde_json::from_value(serde_json::to_value(&session).unwrap()).unwrap();
        state
            .local
            .update_session(&session.id, &input)
            .await
            .unwrap();
        assert!(matches!(
            execute(&state, &p.id, &[0]).await,
            Err(AppError::ReadOnly(_))
        ));
        for e in endpoints {
            state.disconnect(&e.session_id).await;
        }
    }
}
