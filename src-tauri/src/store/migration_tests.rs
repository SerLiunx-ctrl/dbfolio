use super::*;
use crate::meta::Engine;

async fn store() -> (tempfile::TempDir, LocalStore) {
    let dir = tempfile::tempdir().unwrap();
    let store = LocalStore::initialize_in(dir.path().into()).await.unwrap();
    (dir, store)
}
fn sample() -> ConfigBundle {
    let mut sessions = vec![];
    for (n, engine) in [
        Engine::Mysql,
        Engine::Postgres,
        Engine::Sqlite,
        Engine::Redis,
        Engine::Mongodb,
    ]
    .into_iter()
    .enumerate()
    {
        sessions.push(SessionRecord {
            id: format!("source-{n}"),
            name: format!("会话 {n}"),
            engine,
            host: Some("127.0.0.1".into()),
            port: Some(3306),
            username: Some("demo".into()),
            database: None,
            file_path: (engine == Engine::Sqlite).then(|| "C:\\测试\\演示.db".into()),
            ssl_mode: None,
            network: Default::default(),
            redis_db: None,
            tls: None,
            auth_source: None,
            read_only: true,
            allowed_databases: None,
            group_name: Some("开发".into()),
            color: None,
            has_password: false,
            created_at: "2026-10-18".into(),
            updated_at: "2026-10-18".into(),
        });
    }
    let plan = json!({"version":1,"id":"analysis-old","name":"统计","sessionId":"source-0","database":"demo","source":"sql","collection":"","query":"SELECT :n","parameters":{"n":{"type":"number","value":"9007199254740993"}},"chart":{"kind":"bar","x":"","y":"","series":"","aggregate":"sum","sort":"source","top":30,"bins":10}});
    ConfigBundle {
        format: "dbfolio-config".into(),
        version: 1,
        app_version: "1.0.0-alpha.10".into(),
        exported_at: "2026-10-18".into(),
        sessions,
        folders: vec!["开发".into(), "空分组".into()],
        preferences: BTreeMap::from([("ui_theme".into(), "dark".into())]),
        favorites: vec![
            json!({"id":1,"sessionId":"source-0","database":"demo","sql":"SELECT '中文', 9007199254740993","success":true,"rowsAffected":1,"durationMs":1,"errorCode":null,"executedAt":"2026-10-18"}),
        ],
        filters: vec![
            json!({"id":"filter-old","name":"设备","scope":"[\"source-0\",\"demo\",null,\"devices\"]","conjunction":"and","filters":[{"column":"id","operator":"eq","value":"9007199254740993"},{"column":"status","operator":"eq","value":"draft","enabled":false}]}),
        ],
        analyses: vec![plan],
        relations: vec![
            json!({"id":"relation-old","source":{"sessionId":"source-0","database":"demo","schema":null,"table":"devices"},"columns":["id"],"target":{"database":"demo","schema":null,"table":"events"},"keys":["device_id"]}),
        ],
        environments: BTreeMap::from([("source-0".into(), "development".into())]),
        object_favorites: vec![
            json!({"sessionId":"source-0","database":"demo","schema":null,"kind":"table","name":"devices"}),
        ],
    }
}
async fn apply(s: &LocalStore, b: &ConfigBundle, mode: ImportMode) -> ImportPreview {
    let o = ImportOptions {
        mode,
        preferences: true,
    };
    let p = s.config_import(b, &o, None).await.unwrap();
    s.config_import(b, &o, Some(&p.fingerprint)).await.unwrap()
}
async fn value(s: &LocalStore, key: &str) -> Value {
    serde_json::from_str(&s.get_setting(key).await.unwrap().unwrap()).unwrap()
}

#[tokio::test]
async fn roundtrip_all_engines_remaps_dependencies_and_excludes_unselected_secrets() {
    let (_dir, s) = store().await;
    let b = sample();
    b.validate().unwrap();
    let p = apply(&s, &b, ImportMode::Copy).await;
    assert_eq!(p.sessions.len(), 5);
    assert_eq!(p.added["收藏 SQL"], 1);
    let sessions = s.list_sessions().await.unwrap();
    assert_eq!(sessions.len(), 5);
    let id = &sessions
        .iter()
        .find(|s| s.engine == Engine::Mysql)
        .unwrap()
        .id;
    assert_ne!(id, "source-0");
    assert!(sessions.iter().all(|s| s.read_only && !s.has_password));
    let lib = value(&s, LIBRARY).await;
    assert_eq!(lib["history"][0]["sessionId"], *id);
    assert_eq!(lib["history"][0]["id"], -1);
    assert_eq!(scope(&lib["filters"][0]).unwrap()[0], *id);
    assert_eq!(value(&s, ANALYSES).await[0]["sessionId"], *id);
    assert_eq!(
        value(&s, ANALYSES).await[0]["parameters"]["n"]["value"],
        "9007199254740993"
    );
    assert_eq!(value(&s, RELATIONS).await[0]["source"]["sessionId"], *id);
    assert_eq!(value(&s, OBJECTS).await["environments"][id], "development");
    assert_eq!(value(&s, OBJECTS).await["favorites"][0]["sessionId"], *id);
    s.set_setting("ai_providers_v1", "SECRET_MUST_NOT_EXPORT")
        .await
        .unwrap();
    s.set_setting("workspace_v1", "PRIVATE_DRAFT_MUST_NOT_EXPORT")
        .await
        .unwrap();
    let options = ExportOptions {
        session_ids: vec![id.clone()],
        folders: vec!["空分组".into()],
        preferences: true,
        favorites: true,
        filters: true,
        analyses: true,
        relations: true,
    };
    let exported = s.config_export(&options).await.unwrap();
    assert_eq!(exported.sessions.len(), 1);
    assert_eq!(exported.filters.len(), 1);
    assert_eq!(exported.filters[0]["filters"][1]["enabled"], false);
    assert_eq!(exported.filters[0]["filters"][1]["value"], "draft");
    assert!(exported.folders.contains(&"空分组".into()));
    let raw = serde_json::to_string(&exported).unwrap();
    assert!(!raw.contains("SECRET_MUST_NOT_EXPORT"));
    assert!(!raw.contains("PRIVATE_DRAFT"));
    assert!(!raw.contains("\"password\""));
    let (_d, target) = store().await;
    apply(&target, &exported, ImportMode::Copy).await;
    assert_eq!(target.list_sessions().await.unwrap().len(), 1);
    let restored = value(&target, LIBRARY).await;
    assert_eq!(restored["filters"][0]["filters"][1]["enabled"], false);
    assert_eq!(restored["filters"][0]["filters"][1]["value"], "draft");
}

#[tokio::test]
async fn merge_and_skip_are_idempotent_and_preserve_local_connection_safety() {
    let (_d, s) = store().await;
    let b = sample();
    apply(&s, &b, ImportMode::Copy).await;
    let id = s
        .list_sessions()
        .await
        .unwrap()
        .into_iter()
        .find(|s| s.engine == Engine::Mysql)
        .unwrap()
        .id;
    sqlx::query("UPDATE sessions SET read_only=1,allowed_databases='[\"local_only\"]' WHERE id=?")
        .bind(&id)
        .execute(&s.pool)
        .await
        .unwrap();
    let p = apply(&s, &b, ImportMode::Merge).await;
    assert!(p.added.values().all(|n| *n == 0));
    assert_eq!(s.list_sessions().await.unwrap().len(), 5);
    let existing = s.get_session(&id).await.unwrap();
    assert!(existing.read_only);
    assert_eq!(existing.allowed_databases.unwrap(), vec!["local_only"]);
    let p = apply(&s, &b, ImportMode::Skip).await;
    assert!(p.added.values().all(|n| *n == 0));
    assert!(p.sessions.iter().all(|s| s.action == "跳过"));
    apply(&s, &b, ImportMode::Copy).await;
    assert_eq!(s.list_sessions().await.unwrap().len(), 10);
    assert_eq!(value(&s, ANALYSES).await.as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn stale_preview_and_different_endpoint_are_rejected_without_changes() {
    let (_d, s) = store().await;
    let b = sample();
    let o = ImportOptions {
        mode: ImportMode::Copy,
        preferences: true,
    };
    let preview = s.config_import(&b, &o, None).await.unwrap();
    assert!(s.list_sessions().await.unwrap().is_empty());
    s.set_setting("ui_theme", "light").await.unwrap();
    assert!(s
        .config_import(&b, &o, Some(&preview.fingerprint))
        .await
        .is_err());
    assert!(s.list_sessions().await.unwrap().is_empty());
    apply(&s, &b, ImportMode::Copy).await;
    let mut changed = b.clone();
    changed.sessions[0].host = Some("other-server".into());
    assert!(s
        .config_import(
            &changed,
            &ImportOptions {
                mode: ImportMode::Merge,
                preferences: false
            },
            None
        )
        .await
        .is_err());
    assert_eq!(s.list_sessions().await.unwrap().len(), 5);
}

#[tokio::test]
async fn write_failure_rolls_back_sessions_and_every_setting() {
    let (_d, s) = store().await;
    let b = sample();
    let o = ImportOptions {
        mode: ImportMode::Copy,
        preferences: true,
    };
    s.set_setting("ui_theme", "light").await.unwrap();
    sqlx::query("CREATE TRIGGER fail_migration BEFORE INSERT ON settings WHEN NEW.key='productivity_library_v1' BEGIN SELECT RAISE(ABORT,'test failure'); END").execute(&s.pool).await.unwrap();
    let p = s.config_import(&b, &o, None).await.unwrap();
    assert!(s.config_import(&b, &o, Some(&p.fingerprint)).await.is_err());
    assert!(s.list_sessions().await.unwrap().is_empty());
    assert_eq!(
        s.get_setting("ui_theme").await.unwrap().as_deref(),
        Some("light")
    );
    assert!(s.get_setting(ANALYSES).await.unwrap().is_none());
    assert!(s.get_setting(FOLDERS).await.unwrap().is_none());
}

#[test]
fn rejects_invalid_versions_references_credentials_and_shapes() {
    let original = sample();
    let mut b = original.clone();
    b.analyses[0]["metadataSource"] = json!({"table":"x".repeat(513),"schema":"main"});
    assert!(b.validate().is_err());
    let mut b = original.clone();
    b.analyses[0]["name"] = json!("😀".repeat(61));
    assert!(b.validate().is_err());
    let mut b = original.clone();
    b.object_favorites[0]["schema"] = json!(42);
    assert!(b.validate().is_err());
    let mut b = original.clone();
    b.folders = vec!["group".into(); 2001];
    assert!(b.validate().is_err());

    let mut b = original.clone();
    b.version = 2;
    assert!(b.validate().is_err());
    let mut b = original.clone();
    b.sessions.push(b.sessions[0].clone());
    assert!(b.validate().is_err());
    let mut b = original.clone();
    b.sessions.remove(0);
    assert!(b.validate().is_err());
    let mut b = original.clone();
    b.sessions[4].host = Some("mongodb://user:secret@localhost".into());
    assert!(b.validate().is_err());
    let mut b = original.clone();
    b.sessions[0].has_password = true;
    assert!(b.validate().is_err());
    let mut b = original.clone();
    b.preferences.insert("ai_providers_v1".into(), "[]".into());
    assert!(b.validate().is_err());
    let mut b = original.clone();
    b.analyses[0]["chart"]["top"] = json!(0);
    assert!(b.validate().is_err());
    let mut b = original.clone();
    b.filters[0]["scope"] = json!("broken");
    assert!(b.validate().is_err());
    let mut b = original.clone();
    b.relations[0]["keys"] = json!([]);
    assert!(b.validate().is_err());
    let mut b = original.clone();
    b.preferences.insert("ui_zoom".into(), "NaN".into());
    assert!(b.validate().is_err());
}

#[tokio::test]
async fn selected_sessions_scope_all_dependent_records() {
    let (_d, s) = store().await;
    apply(&s, &sample(), ImportMode::Copy).await;
    let sqlite = s
        .list_sessions()
        .await
        .unwrap()
        .into_iter()
        .find(|s| s.engine == Engine::Sqlite)
        .unwrap();
    let b = s
        .config_export(&ExportOptions {
            session_ids: vec![sqlite.id],
            folders: vec![],
            preferences: false,
            favorites: true,
            filters: true,
            analyses: true,
            relations: true,
        })
        .await
        .unwrap();
    assert_eq!(b.sessions.len(), 1);
    assert!(
        b.preferences.is_empty()
            && b.favorites.is_empty()
            && b.filters.is_empty()
            && b.analyses.is_empty()
            && b.relations.is_empty()
            && b.environments.is_empty()
            && b.object_favorites.is_empty()
    );
}

#[tokio::test]
async fn existing_password_is_preserved_by_merge() {
    let (_d, s) = store().await;
    let b = sample();
    apply(&s, &b, ImportMode::Copy).await;
    let id = s.list_sessions().await.unwrap()[0].id.clone();
    struct Cleanup(String);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = crate::store::secrets::delete_password(&self.0);
        }
    }
    let _cleanup = Cleanup(id.clone());
    crate::store::secrets::save_password(&id, "r05-isolated-test-secret").unwrap();
    apply(&s, &b, ImportMode::Merge).await;
    assert_eq!(
        crate::store::secrets::load_password(&id)
            .unwrap()
            .as_deref(),
        Some("r05-isolated-test-secret")
    );
}

#[tokio::test]
async fn no_preference_overwrite_without_opt_in_and_malformed_local_data_does_not_panic() {
    let (_d, s) = store().await;
    let b = sample();
    s.set_setting("ui_theme", "light").await.unwrap();
    let o = ImportOptions {
        mode: ImportMode::Copy,
        preferences: false,
    };
    let p = s.config_import(&b, &o, None).await.unwrap();
    s.config_import(&b, &o, Some(&p.fingerprint)).await.unwrap();
    assert_eq!(
        s.get_setting("ui_theme").await.unwrap().as_deref(),
        Some("light")
    );
    s.set_setting(LIBRARY, "false").await.unwrap();
    assert!(s.config_import(&b, &o, None).await.is_err());
}

#[tokio::test]
async fn network_paths_permissions_and_empty_group_survive_transfer() {
    let (_d, s) = store().await;
    let mut b = sample();
    b.sessions[0].allowed_databases = Some(vec!["demo".into()]);
    b.sessions[0].network = serde_json::from_value(json!({
        "ssh":{"host":"jump.local","port":22,"username":"developer","auth":"key","privateKey":"C:/keys/demo.key","fingerprint":"SHA256:abcdefghijklmnopqrstuvwxyz1234567890"},
        "caFile":"C:/certs/ca.pem","clientCert":"C:/certs/client.pem","clientKey":"C:/keys/client.key","serverName":"db.internal","connectTimeoutSecs":20,"queryTimeoutSecs":120
    })).unwrap();
    b.preferences.insert("ui_max_tabs".into(), "0".into());
    b.preferences
        .insert("history_limit_per_session".into(), "0".into());
    apply(&s, &b, ImportMode::Copy).await;
    let mysql = s
        .list_sessions()
        .await
        .unwrap()
        .into_iter()
        .find(|s| s.engine == Engine::Mysql)
        .unwrap();
    assert_eq!(mysql.allowed_databases, Some(vec!["demo".into()]));
    assert_eq!(
        serde_json::to_value(mysql.network).unwrap(),
        serde_json::to_value(&b.sessions[0].network).unwrap()
    );
    assert!(value(&s, FOLDERS)
        .await
        .as_array()
        .unwrap()
        .contains(&json!("空分组")));
    assert_eq!(s.history_limit().await.unwrap(), 0);
}
