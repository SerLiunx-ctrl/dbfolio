use super::{
    column_edit::*,
    ddl::{ColumnFlags, ColumnPosition, DdlSpec},
};
use crate::adapters::{sqlite::SqliteAdapter, DbAdapter};
use sqlx::{sqlite::SqlitePoolOptions, Row};

async fn setup(sql: &str) -> (tempfile::TempDir, SqliteAdapter, sqlx::SqlitePool) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("test.db");
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            sqlx::sqlite::SqliteConnectOptions::new()
                .filename(&path)
                .create_if_missing(true)
                .foreign_keys(true),
        )
        .await
        .unwrap();
    sqlx::raw_sql(sql).execute(&pool).await.unwrap();
    let params =
        serde_json::from_value(serde_json::json!({"engine":"sqlite","filePath":path})).unwrap();
    let adapter = SqliteAdapter::connect(&params).await.unwrap();
    (dir, adapter, pool)
}
fn edit(table: &str, changes: serde_json::Value) -> DdlSpec {
    serde_json::from_value(
        serde_json::json!({"type":"columnFlags","table":table,"changes":changes}),
    )
    .unwrap()
}

#[tokio::test]
async fn sqlite_inline_preserves_dependencies_and_sequence() {
    let (_dir,adapter,pool)=setup("CREATE TABLE t(id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT COLLATE NOCASE UNIQUE CHECK(length(label)>0), n INT DEFAULT 3, twice INT GENERATED ALWAYS AS (n*2) STORED); CREATE TABLE child(tid INTEGER REFERENCES t(id) ON DELETE CASCADE); CREATE TABLE audit(value TEXT); CREATE INDEX idx_partial ON t(lower(label)) WHERE n>0; CREATE TRIGGER tr AFTER UPDATE OF label ON t BEGIN INSERT INTO audit VALUES(new.label); END; CREATE VIEW v AS SELECT label,twice FROM t; INSERT INTO t(id,label,n) VALUES(1,'one',2),(90,'removed',3); DELETE FROM t WHERE id=90; INSERT INTO child VALUES(1);").await;
    let spec = edit(
        "t",
        serde_json::json!([{"name":"label","newName":"title","dataType":"VARCHAR(40)","nullable":false,"defaultMode":"literal","defaultValue":"it's ok"},{"name":"n","nullable":true,"defaultMode":"null"}]),
    );
    let before: String = sqlx::query_scalar("SELECT sql FROM sqlite_schema WHERE name='t'")
        .fetch_one(&pool)
        .await
        .unwrap();
    let plan = adapter
        .sqlite_schema_edit("main", &spec, false)
        .await
        .unwrap();
    assert!(plan.iter().any(|s| s.contains("CREATE TRIGGER")));
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT sql FROM sqlite_schema WHERE name='t'")
            .fetch_one(&pool)
            .await
            .unwrap(),
        before,
        "预览不写数据库"
    );
    adapter
        .sqlite_schema_edit("main", &spec, true)
        .await
        .unwrap();
    let row = sqlx::query("SELECT id,title,n,twice FROM t")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(row.get::<String, _>("title"), "one");
    assert_eq!(row.get::<i64, _>("twice"), 4);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM child")
            .fetch_one(&pool)
            .await
            .unwrap(),
        1
    );
    sqlx::query("UPDATE t SET title='changed'")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT value FROM audit")
            .fetch_one(&pool)
            .await
            .unwrap(),
        "changed"
    );
    assert!(sqlx::query("INSERT INTO t(title) VALUES('CHANGED')")
        .execute(&pool)
        .await
        .is_err());
    assert!(sqlx::query("INSERT INTO t(title) VALUES('')")
        .execute(&pool)
        .await
        .is_err());
    sqlx::query("INSERT INTO t DEFAULT VALUES")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT MAX(id) FROM t")
            .fetch_one(&pool)
            .await
            .unwrap(),
        91
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM v")
            .fetch_one(&pool)
            .await
            .unwrap(),
        2
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("PRAGMA foreign_keys")
            .fetch_one(&pool)
            .await
            .unwrap(),
        1
    );
}

#[tokio::test]
async fn sqlite_inline_rolls_back_failed_batch_and_rename() {
    let (_dir,adapter,pool)=setup("CREATE TABLE t(id BIGINT PRIMARY KEY, value TEXT, other TEXT); INSERT INTO t VALUES(7,NULL,'hello'); CREATE INDEX idx ON t(other);").await;
    let spec = edit(
        "t",
        serde_json::json!([{"name":"other","nullable":true,"newName":"renamed"},{"name":"value","nullable":false}]),
    );
    assert!(adapter
        .sqlite_schema_edit("main", &spec, true)
        .await
        .is_err());
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT other FROM t")
            .fetch_one(&pool)
            .await
            .unwrap(),
        "hello"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM sqlite_schema WHERE name LIKE '_dbfolio_%'"
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        0
    );
    // SQLite BIGINT 主键可以保留原有可空属性，重命名不重建或丢主键。
    let spec = edit(
        "t",
        serde_json::json!([{"name":"id","newName":"key","nullable":true}]),
    );
    let plan = adapter
        .sqlite_schema_edit("main", &spec, true)
        .await
        .unwrap();
    assert!(!plan.iter().any(|s| s.starts_with("CREATE TABLE")));
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT key FROM t")
            .fetch_one(&pool)
            .await
            .unwrap(),
        7
    );
}

#[tokio::test]
async fn sqlite_inline_strict_without_rowid_and_reorder() {
    let (_dir,adapter,pool)=setup("CREATE TABLE t(id TEXT PRIMARY KEY, value INTEGER NOT NULL DEFAULT 1) STRICT, WITHOUT ROWID; INSERT INTO t VALUES('x',8);").await;
    let spec = edit(
        "t",
        serde_json::json!([{"name":"value","nullable":false,"defaultMode":"literal","defaultValue":"10"}]),
    );
    adapter
        .sqlite_schema_edit("main", &spec, true)
        .await
        .unwrap();
    let move_spec = DdlSpec::MoveColumn {
        schema: None,
        table: "t".into(),
        column: "value".into(),
        position: ColumnPosition {
            first: true,
            after: None,
        },
    };
    adapter
        .sqlite_schema_edit("main", &move_spec, true)
        .await
        .unwrap();
    let raw: String = sqlx::query_scalar("SELECT sql FROM sqlite_schema WHERE name='t'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(raw.contains("STRICT") && raw.contains("WITHOUT ROWID"));
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT value FROM t")
            .fetch_one(&pool)
            .await
            .unwrap(),
        8
    );
    let bad = edit(
        "t",
        serde_json::json!([{"name":"value","nullable":false,"dataType":"VARCHAR(10)"}]),
    );
    assert!(adapter
        .sqlite_schema_edit("main", &bad, true)
        .await
        .is_err());
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT value FROM t")
            .fetch_one(&pool)
            .await
            .unwrap(),
        8
    );
}

#[tokio::test]
async fn sqlite_inline_rowids_native_drop_and_foreign_key_rollback() {
    let (_dir,adapter,pool)=setup("CREATE TABLE t(code TEXT UNIQUE, spare TEXT); INSERT INTO t(rowid,code) VALUES(99,'8'); CREATE TABLE child(code TEXT REFERENCES t(code)); INSERT INTO child VALUES('8');").await;
    let spec = edit(
        "t",
        serde_json::json!([{"name":"spare","nullable":true,"defaultMode":"literal","defaultValue":"x"}]),
    );
    adapter
        .sqlite_schema_edit("main", &spec, true)
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT rowid FROM t")
            .fetch_one(&pool)
            .await
            .unwrap(),
        99
    );
    let drop = DdlSpec::DropColumn {
        schema: None,
        table: "t".into(),
        column: "code".into(),
    };
    assert!(adapter
        .sqlite_schema_edit("main", &drop, true)
        .await
        .is_err());
    let drop = DdlSpec::DropColumn {
        schema: None,
        table: "t".into(),
        column: "spare".into(),
    };
    adapter
        .sqlite_schema_edit("main", &drop, true)
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT rowid FROM t")
            .fetch_one(&pool)
            .await
            .unwrap(),
        99
    );
}

#[tokio::test]
async fn sqlite_explicit_autoincrement_and_empty_sequence() {
    let (_dir,adapter,pool)=setup("CREATE TABLE t(id INTEGER PRIMARY KEY, value TEXT); CREATE TABLE empty(id INTEGER PRIMARY KEY AUTOINCREMENT,value TEXT); INSERT INTO empty(id) VALUES(200); DELETE FROM empty;").await;
    assert!(
        !adapter
            .introspect_table("main", None, "t")
            .await
            .unwrap()
            .columns[0]
            .auto_increment
    );
    let spec = edit(
        "t",
        serde_json::json!([{"name":"id","nullable":false,"autoIncrement":true,"defaultMode":"none"}]),
    );
    adapter
        .sqlite_schema_edit("main", &spec, true)
        .await
        .unwrap();
    assert!(
        adapter
            .introspect_table("main", None, "t")
            .await
            .unwrap()
            .columns[0]
            .auto_increment
    );
    let spec = edit(
        "empty",
        serde_json::json!([{"name":"value","nullable":true,"dataType":"VARCHAR(20)"}]),
    );
    adapter
        .sqlite_schema_edit("main", &spec, true)
        .await
        .unwrap();
    sqlx::query("INSERT INTO empty DEFAULT VALUES")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT id FROM empty")
            .fetch_one(&pool)
            .await
            .unwrap(),
        201
    );
}

#[test]
fn column_edit_rejects_type_injection() {
    for dialect in [
        &sqlparser::dialect::SQLiteDialect {} as &dyn sqlparser::dialect::Dialect,
        &sqlparser::dialect::PostgreSqlDialect {},
    ] {
        for bad in [
            "INT); DROP TABLE t; --",
            "TEXT DEFAULT 'bad'",
            "INT, other TEXT",
            "INT PRIMARY KEY",
        ] {
            assert!(data_type(dialect, bad).is_err());
        }
        assert!(data_type(dialect, "VARCHAR(30)").is_ok());
    }
    let c:ColumnFlags=serde_json::from_value(serde_json::json!({"name":"value","nullable":true,"defaultMode":"literal","defaultValue":"'); DROP TABLE t; --"})).unwrap();
    assert_eq!(default_sql(&c).unwrap().unwrap(), "'''); DROP TABLE t; --'");
}

#[tokio::test]
async fn postgres_inline_plan_preserves_unedited_properties() {
    let (_dir, adapter, _pool) =
        setup("CREATE TABLE t(id INTEGER PRIMARY KEY, value TEXT, other TEXT);").await;
    let meta = adapter.introspect_table("main", None, "t").await.unwrap();
    let changes:Vec<ColumnFlags>=serde_json::from_value(serde_json::json!([{"name":"value","nullable":false,"newName":"new value","dataType":"VARCHAR(40)","defaultMode":"literal","defaultValue":"it's quoted","comment":"comment's text"}])).unwrap();
    let sql = postgres_columns(&adapter, "\"public\".\"t\"", &meta, &changes).unwrap();
    for statement in &sql {
        sqlparser::parser::Parser::parse_sql(&sqlparser::dialect::PostgreSqlDialect {}, statement)
            .unwrap();
    }
    assert!(sql[0].contains("ALTER COLUMN \"value\" TYPE VARCHAR(40)"));
    assert!(sql.iter().any(|s| s.contains("SET NOT NULL")));
    assert!(sql.iter().any(|s| s.contains("'it''s quoted'")));
    assert!(sql.iter().any(|s| s.starts_with("COMMENT ON COLUMN")));
    assert!(sql
        .last()
        .unwrap()
        .contains("RENAME COLUMN \"value\" TO \"new value\""));
    let only_name: Vec<ColumnFlags> = serde_json::from_value(
        serde_json::json!([{"name":"value","nullable":true,"newName":"renamed"}]),
    )
    .unwrap();
    assert_eq!(
        postgres_columns(&adapter, "t", &meta, &only_name)
            .unwrap()
            .len(),
        1
    );
    let bad: Vec<ColumnFlags> = serde_json::from_value(
        serde_json::json!([{"name":"value","nullable":true,"unsigned":true}]),
    )
    .unwrap();
    assert!(postgres_columns(&adapter, "t", &meta, &bad).is_err());
}

#[tokio::test]
async fn sqlite_foreign_check_failure_is_atomic() {
    let (_dir,adapter,pool)=setup("CREATE TABLE t(id INTEGER PRIMARY KEY, value TEXT); CREATE TABLE child(tid INTEGER REFERENCES t(id)); INSERT INTO t VALUES(1,'original');").await;
    sqlx::raw_sql("PRAGMA foreign_keys=OFF; INSERT INTO child VALUES(2); PRAGMA foreign_keys=ON;")
        .execute(&pool)
        .await
        .unwrap();
    let spec = edit(
        "t",
        serde_json::json!([{"name":"value","nullable":true,"newName":"changed","dataType":"VARCHAR(10)"}]),
    );
    assert!(adapter
        .sqlite_schema_edit("main", &spec, true)
        .await
        .unwrap_err()
        .to_string()
        .contains("外键检查"));
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT value FROM t")
            .fetch_one(&pool)
            .await
            .unwrap(),
        "original"
    );
}

#[tokio::test]
async fn sqlite_inline_readonly_guard() {
    let (dir, _adapter, pool) = setup(
        "CREATE TABLE t(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO t VALUES(1,'original');",
    )
    .await;
    let state = crate::state::AppState::with_local(
        crate::store::LocalStore::initialize_in(dir.path().join("config"))
            .await
            .unwrap(),
    );
    let input=serde_json::from_value(serde_json::json!({"name":"readonly","engine":"sqlite","filePath":dir.path().join("test.db"),"readOnly":true})).unwrap();
    let session = state.local.create_session(&input).await.unwrap();
    crate::services::session::connect(&state, &session.id)
        .await
        .unwrap();
    let spec = edit(
        "t",
        serde_json::json!([{"name":"value","nullable":true,"newName":"changed"}]),
    );
    assert!(super::ddl::preview(&state, &session.id, "main", &spec)
        .await
        .is_ok());
    assert!(super::ddl::apply(&state, &session.id, "main", &spec, true)
        .await
        .is_err());
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT value FROM t")
            .fetch_one(&pool)
            .await
            .unwrap(),
        "original"
    );
    state.disconnect(&session.id).await;
}

#[tokio::test]
#[ignore = "需要已保存的本机 PostgreSQL 会话；只操作随机验收 schema"]
async fn local_postgres_inline_acceptance() {
    use crate::{adapters::QueryContext, meta::Engine, state::AppState};
    let state = AppState::initialize().await.unwrap();
    let sessions = state.local.list_sessions().await.unwrap();
    let session = sessions
        .iter()
        .find(|s| {
            s.engine == Engine::Postgres && s.host.as_deref() == Some("127.0.0.1") && !s.read_only
        })
        .expect("缺少本机 PostgreSQL 会话");
    crate::services::session::connect(&state, &session.id)
        .await
        .unwrap();
    let connected = state.connected(&session.id).await.unwrap();
    let adapter = connected.adapter.as_ref();
    let schema = format!("dw_qa_{}", uuid::Uuid::new_v4().simple());
    let target = format!("\"{schema}\".items");
    adapter
        .execute_statements("postgres", &[format!("CREATE SCHEMA \"{schema}\"")])
        .await
        .unwrap();
    let outcome:crate::error::AppResult<()> = async {
        adapter.execute_statements("postgres",&[format!("CREATE TABLE {target}(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, value TEXT, optional TEXT)"),format!("INSERT INTO {target}(value) VALUES('original')")]).await?;
        let spec:DdlSpec=serde_json::from_value(serde_json::json!({"type":"columnFlags","schema":schema,"table":"items","changes":[{"name":"value","nullable":false,"newName":"title","dataType":"VARCHAR(40)","defaultMode":"literal","defaultValue":"C:\\it's","comment":"备注 C:\\it's"}]})).unwrap();
        super::ddl::preview(&state,&session.id,"postgres",&spec).await?;
        assert!(adapter.introspect_table("postgres",Some(&schema),"items").await?.columns.iter().any(|c|c.name=="value"));
        super::ddl::apply(&state,&session.id,"postgres",&spec,true).await?;
        let meta=adapter.introspect_table("postgres",Some(&schema),"items").await?;
        let title=meta.columns.iter().find(|c|c.name=="title").unwrap();
        assert!(!title.nullable);assert_eq!(title.comment.as_deref(),Some("备注 C:\\it's"));assert!(title.raw_type.contains("40"));
        adapter.execute_statements("postgres",&[format!("INSERT INTO {target} DEFAULT VALUES")]).await?;
        let rows=adapter.query_page("postgres",&format!("SELECT title FROM {target} ORDER BY id"),0,10,&QueryContext::new()).await?;
        assert_eq!(serde_json::to_value(&rows.rows[1][0]).unwrap(),serde_json::json!(["text","C:\\it's"]));
        let bad:DdlSpec=serde_json::from_value(serde_json::json!({"type":"columnFlags","schema":schema,"table":"items","changes":[{"name":"title","nullable":false,"comment":"不应保存"},{"name":"optional","nullable":false}]})).unwrap();
        assert!(super::ddl::apply(&state,&session.id,"postgres",&bad,true).await.is_err());
        let meta=adapter.introspect_table("postgres",Some(&schema),"items").await?;
        assert_eq!(meta.columns.iter().find(|c|c.name=="title").unwrap().comment.as_deref(),Some("备注 C:\\it's"));
        Ok(())
    }.await;
    adapter
        .execute_statements("postgres", &[format!("DROP SCHEMA \"{schema}\" CASCADE")])
        .await
        .unwrap();
    state.disconnect(&session.id).await;
    outcome.unwrap();
    println!(
        "PASS 本机 PostgreSQL 行内批量修改、默认值转义、预览只读、失败事务回滚和测试 schema 清理"
    );
}
