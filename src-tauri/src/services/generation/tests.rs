use super::*;
#[test]
fn template_identifiers_are_fresh_and_shared_per_row() {
    let fields: Vec<FieldRule> = serde_json::from_value(json!([
        {"name":"key","kind":"text","args":{"pattern":"system:user:{uuid}"}},
        {"name":"id","kind":"text","args":{"pattern":"{uuid}"}},
        {"name":"compact","kind":"text","args":{"pattern":"{uuid32}"}},
        {"name":"batch","kind":"text","args":{"pattern":"{run_id}"}},
        {"name":"random","kind":"random_uuid","args":{}}
    ]))
    .unwrap();
    let order = rules::ordered_fields(&fields).unwrap();
    let mut generator = rules::Generator::new("same-seed");
    let mut seen = HashSet::new();
    let mut batch = String::new();
    for n in 0..205 {
        let row = generator.row(&order, n, &HashMap::new(), false).unwrap();
        let id = row["id"].as_str().unwrap();
        assert!(uuid::Uuid::parse_str(id).is_ok());
        assert!(uuid::Uuid::parse_str(row["random"].as_str().unwrap()).is_ok());
        assert_eq!(row["key"], format!("system:user:{id}"));
        assert_eq!(row["compact"], id.replace('-', ""));
        assert!(seen.insert(row["key"].to_string()));
        if n == 0 {
            batch = row["batch"].as_str().unwrap().into();
        }
        assert_eq!(row["batch"], batch);
    }
    let next = rules::Generator::new("same-seed")
        .row(&order, 0, &HashMap::new(), false)
        .unwrap();
    assert_ne!(next["batch"], batch);
    assert!(!seen.contains(&next["key"].to_string()));
}
#[test]
fn template_time_random_and_legacy_semantics() {
    let fields: Vec<FieldRule> = serde_json::from_value(json!([
        {"name":"x","kind":"text","args":{"pattern":"{n:6}|{date:yyyyMMdd}|{date:HHmmss}|{timestamp}|{timestamp_ms}|{int:-9:-9}|{hex:8}|{alnum:12}|{seeded_uuid}"}},
        {"name":"old","kind":"text","args":{"pattern":"${prefix}:{n}:{user}:{\"id\":\"{uuid}\"}"}}
    ])).unwrap();
    let order = rules::ordered_fields(&fields).unwrap();
    let params = HashMap::from([("prefix".into(), "中文-{uuid}".into())]);
    let mut generator = rules::Generator::new("seed");
    generator.started_at = chrono::DateTime::parse_from_rfc3339("2026-09-17T01:02:03Z")
        .unwrap()
        .to_utc();
    let row = generator.row(&order, 9, &params, false).unwrap();
    let tokens: Vec<_> = row["x"].as_str().unwrap().split('|').collect();
    assert_eq!(&tokens[..3], &["000010", "20260917", "010203"]);
    assert_eq!(
        tokens[3].parse::<i64>().unwrap() * 1000,
        tokens[4].parse::<i64>().unwrap()
    );
    assert_eq!(tokens[5], "-9");
    assert_eq!(tokens[6].len(), 8);
    assert!(tokens[6].bytes().all(|b| b.is_ascii_hexdigit()));
    assert_eq!(tokens[7].len(), 12);
    assert!(tokens[7].bytes().all(|b| b.is_ascii_alphanumeric()));
    let mut again = rules::Generator::new("seed");
    again.started_at = generator.started_at;
    assert_eq!(again.row(&order, 9, &params, false).unwrap()["x"], row["x"]);
    assert!(row["old"]
        .as_str()
        .unwrap()
        .starts_with("中文-{uuid}:10:{user}:{\"id\":\""));
    assert_eq!(
        rules::expand_text("{n:2}", 999, &HashMap::new()).unwrap(),
        "1000"
    );
}
#[test]
fn template_invalid_arguments_rejected_before_generation() {
    for pattern in [
        "{uuid:oops}",
        "{n:0}",
        "{n:21}",
        "{hex:129}",
        "{alnum:-1}",
        "{int:3:2}",
        "{int:0:9223372036854775808}",
        "{date:bad}",
        "{uuid",
        "${prefix",
    ] {
        let field: FieldRule =
            serde_json::from_value(json!({"name":"key","kind":"text","args":{"pattern":pattern}}))
                .unwrap();
        assert!(rules::validate_rule(&field).is_err(), "{pattern}");
    }
}
#[tokio::test]
async fn fresh_template_preview_is_frozen_for_write() {
    let (_dir, state, target) = sqlite_fixture().await;
    let mut plan = fixture_plan(target.clone(), 12);
    plan.fields
        .iter_mut()
        .find(|f| f.name == "code")
        .unwrap()
        .args = json!({"pattern":"item-{uuid}"});
    let first = generate(&state, plan.clone()).await.unwrap();
    assert_eq!(preview(&state, &first.id, 0).unwrap().rows, first.rows);
    let next = generate(&state, plan).await.unwrap();
    assert_ne!(first.rows[0]["code"], next.rows[0]["code"]);
    assert_eq!(write(&state, &first.id).await.unwrap().inserted, 12);
    assert_eq!(write(&state, &next.id).await.unwrap().inserted, 12);
    let adapter = state
        .connected(&target.session_id)
        .await
        .unwrap()
        .adapter
        .clone();
    let stored = adapter
        .query_page(
            "main",
            "SELECT code FROM items ORDER BY id",
            0,
            24,
            &crate::adapters::QueryContext::new(),
        )
        .await
        .unwrap();
    for (i, row) in first.rows.iter().enumerate() {
        assert!(
            matches!(&stored.rows[i][0], crate::meta::value::DbValue::Text(value) if Some(value.as_str()) == row["code"].as_str())
        );
    }
}
#[test]
fn deterministic_rules_and_cycle() {
    let fields:Vec<FieldRule>=serde_json::from_value(json!([{"name":"id","kind":"sequence","args":{"start":"9007199254740993"}},{"name":"name","kind":"name"},{"name":"money","kind":"decimal","args":{"min":"1.25","max":"1.25","scale":2}}])).unwrap();
    let order = rules::ordered_fields(&fields).unwrap();
    let a = rules::Generator::new("seed")
        .row(&order, 0, &HashMap::new(), false)
        .unwrap();
    let b = rules::Generator::new("seed")
        .row(&order, 0, &HashMap::new(), false)
        .unwrap();
    assert_eq!(a, b);
    assert_eq!(a["id"], "9007199254740993");
    assert_eq!(a["money"], "1.25");
    let cyclic:Vec<FieldRule>=serde_json::from_value(json!([{"name":"a","kind":"compute","args":{"op":"concat","fields":["b"]}},{"name":"b","kind":"compute","args":{"op":"concat","fields":["a"]}}])).unwrap();
    assert!(rules::ordered_fields(&cyclic).is_err());
}
#[test]
fn reject_invalid_rules() {
    for value in [
        json!({"name":"x","kind":"eval","args":{}}),
        json!({"name":"x","kind":"integer","args":{"min":4,"max":2}}),
        json!({"name":"x","kind":"decimal","args":{"scale":16}}),
        json!({"name":"x","kind":"choice","args":{"values":[]}}),
    ] {
        let f = serde_json::from_value(value).unwrap();
        assert!(rules::validate_rule(&f).is_err());
    }
}
async fn sqlite_fixture() -> (tempfile::TempDir, AppState, Target) {
    use crate::store::{local::SessionInput, LocalStore};
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("target.sqlite");
    std::fs::File::create(&path).unwrap();
    let state = AppState::with_local(
        LocalStore::initialize_in(dir.path().join("config"))
            .await
            .unwrap(),
    );
    let input:SessionInput=serde_json::from_value(json!({"name":"隔离生成测试","engine":"sqlite","filePath":path.to_str().unwrap(),"readOnly":false})).unwrap();
    let session = state.local.create_session(&input).await.unwrap();
    crate::services::session::connect(&state, &session.id)
        .await
        .unwrap();
    let t = Target {
        session_id: session.id,
        database: "main".into(),
        schema: None,
        object: "items".into(),
        redis_kind: None,
        ttl_seconds: None,
    };
    state.connected(&t.session_id).await.unwrap().adapter.execute_statements("main",&["CREATE TABLE items (id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, value BIGINT NOT NULL, optional TEXT DEFAULT 'default', computed TEXT GENERATED ALWAYS AS (code || '!') STORED, CHECK(value > 0))".into()]).await.unwrap();
    (dir, state, t)
}
fn fixture_plan(t: Target, count: u32) -> Plan {
    Plan{version:1,target:t,count,seed:"seed".into(),parameters:HashMap::new(),ai:None,fields:serde_json::from_value(json!([
 {"name":"id","kind":"omit"},{"name":"computed","kind":"omit"},{"name":"optional","kind":"omit"},{"name":"code","kind":"text","args":{"pattern":"item-{n}"}}, {"name":"value","kind":"sequence","args":{"start":"9007199254740993","step":"1"}}
])).unwrap()}
}
#[tokio::test]
async fn frozen_sqlite_preview_write_once_export_and_drift() {
    let (_dir, state, t) = sqlite_fixture().await;
    let plan = fixture_plan(t.clone(), 205);
    let p = generate(&state, plan).await.unwrap();
    assert_eq!(p.count, 205);
    assert_eq!(p.rows.len(), 50);
    assert_eq!(p.rows[0]["value"], "9007199254740993");
    assert!(p.rows[0].get("optional").is_none());
    assert_eq!(preview(&state, &p.id, 200).unwrap().rows.len(), 5);
    let adapter = state
        .connected(&t.session_id)
        .await
        .unwrap()
        .adapter
        .clone();
    assert_eq!(
        adapter
            .query_page(
                "main",
                "SELECT * FROM items",
                0,
                1,
                &crate::adapters::QueryContext::new()
            )
            .await
            .unwrap()
            .rows
            .len(),
        0
    );
    let export_path = _dir.path().join("data.json");
    export(&state, &p.id, export_path.to_str().unwrap(), "json")
        .await
        .unwrap();
    let all: Value = serde_json::from_str(&std::fs::read_to_string(export_path).unwrap()).unwrap();
    assert_eq!(all.as_array().unwrap().len(), 205);
    assert_eq!(all[0], p.rows[0]);
    let r = write(&state, &p.id).await.unwrap();
    assert_eq!(r.inserted, 205);
    assert_eq!(r.uncertain, 0);
    assert!(write(&state, &p.id).await.is_err());
    let rows = adapter
        .query_page(
            "main",
            "SELECT value,optional,computed FROM items ORDER BY id LIMIT 1",
            0,
            1,
            &crate::adapters::QueryContext::new(),
        )
        .await
        .unwrap();
    assert!(matches!(
        &rows.rows[0][0],
        crate::meta::value::DbValue::Int(9007199254740993)
    ));
    assert!(matches!(&rows.rows[0][1],crate::meta::value::DbValue::Text(s) if s=="default"));
    assert!(matches!(&rows.rows[0][2],crate::meta::value::DbValue::Text(s) if s=="item-1!"));
    let p2 = generate(&state, fixture_plan(t, 1)).await.unwrap();
    adapter
        .execute_statements("main", &["ALTER TABLE items ADD COLUMN extra TEXT".into()])
        .await
        .unwrap();
    assert!(write(&state, &p2.id)
        .await
        .unwrap_err()
        .to_string()
        .contains("结构已变化"));
}
#[tokio::test]
async fn sqlite_failure_rolls_back_only_current_batch() {
    let (_dir, state, t) = sqlite_fixture().await;
    let adapter = state
        .connected(&t.session_id)
        .await
        .unwrap()
        .adapter
        .clone();
    adapter
        .execute_statements(
            "main",
            &["INSERT INTO items(code,value) VALUES ('item-150',1)".into()],
        )
        .await
        .unwrap();
    let p = generate(&state, fixture_plan(t, 205)).await.unwrap();
    let r = write(&state, &p.id).await.unwrap();
    assert_eq!(
        (r.inserted, r.failed, r.uncertain, r.unattempted),
        (100, 100, 0, 5)
    );
    let q = adapter
        .query_page(
            "main",
            "SELECT COUNT(*) FROM items",
            0,
            1,
            &crate::adapters::QueryContext::new(),
        )
        .await
        .unwrap();
    assert!(matches!(
        q.rows[0][0],
        crate::meta::value::DbValue::Int(101)
    ));
}
#[tokio::test]
async fn readonly_cancel_and_duplicate_validation() {
    let (_dir, state, t) = sqlite_fixture().await;
    let mut p = fixture_plan(t.clone(), 2);
    p.fields.iter_mut().find(|f| f.name == "code").unwrap().args = json!({"pattern":"same"});
    assert!(generate(&state, p)
        .await
        .unwrap_err()
        .to_string()
        .contains("唯一约束"));
    state.tasks.begin("cancel".into()).unwrap();
    state.tasks.cancel("cancel").unwrap();
    assert!(matches!(
        state
            .tasks
            .scope(
                Some("cancel".into()),
                generate(&state, fixture_plan(t.clone(), 10))
            )
            .await,
        Err(AppError::Cancelled(_))
    ));
    let preview = generate(&state, fixture_plan(t.clone(), 2)).await.unwrap();
    let s = state.local.get_session(&t.session_id).await.unwrap();
    let input: crate::store::local::SessionInput = serde_json::from_value(
        json!({"name":s.name,"engine":"sqlite","filePath":s.file_path,"readOnly":true}),
    )
    .unwrap();
    state
        .local
        .update_session(&t.session_id, &input)
        .await
        .unwrap();
    assert!(matches!(
        write(&state, &preview.id).await,
        Err(AppError::ReadOnly(_))
    ));
    assert_eq!(
        state
            .generation
            .get(&preview.id)
            .unwrap()
            .status
            .load(Ordering::SeqCst),
        0
    );
}
#[test]
fn nested_paths_and_precision() {
    use crate::meta::{CanonicalType as C, ColumnMeta};
    let c = ColumnMeta {
        name: "n".into(),
        ordinal: 1,
        raw_type: "bigint".into(),
        canonical: C::Int {
            bits: 64,
            unsigned: false,
        },
        nullable: false,
        default_value: None,
        auto_increment: false,
        unsigned: false,
        charset: None,
        collation: None,
        comment: None,
    };
    assert!(matches!(
        adapters::sql_value(&c, &json!("9007199254740993")).unwrap(),
        crate::meta::value::DbValue::Int(9007199254740993)
    ));
    assert!(adapters::sql_value(&c, &json!("9223372036854775808")).is_err());
    assert!(adapters::sql_value(&c, &Value::Null).is_err());
    let mut c = c;
    c.canonical = C::Decimal {
        precision: Some(5),
        scale: Some(2),
    };
    assert!(adapters::sql_value(&c, &json!("999.99")).is_ok());
    assert!(adapters::sql_value(&c, &json!("1000.00")).is_err());
    assert!(adapters::sql_value(&c, &json!("1e3")).is_err());
    let mut v = json!({});
    adapters::insert_path(&mut v, &["profile", "name"], json!("测试")).unwrap();
    assert_eq!(v["profile"]["name"], "测试");
    assert!(adapters::insert_path(&mut v, &["profile", "name", "x"], json!(1)).is_err());
}
#[tokio::test]
async fn ai_fields_are_validated_frozen_and_do_not_write() {
    let (_dir, state, t) = sqlite_fixture().await;
    let(url,server)=ai::http_tests::mock(200,json!({"choices":[{"finish_reason":"stop","message":{"content":"{\"rows\":[{\"code\":\"AI-A\"},{\"code\":\"AI-B\"}]}"}}],"usage":{"prompt_tokens":40,"completion_tokens":20}}),0).await;
    let provider = ai::Provider {
        id: uuid::Uuid::new_v4().to_string(),
        name: "隔离模拟".into(),
        base_url: url,
        model: "test".into(),
        token_parameter: "max_tokens".into(),
        output_format: "json".into(),
        timeout_seconds: 5,
        max_tokens: 512,
        is_default: true,
        has_key: false,
    };
    state
        .local
        .set_setting(
            "ai_providers_v1",
            &serde_json::to_string(&vec![&provider]).unwrap(),
        )
        .await
        .unwrap();
    let mut p = fixture_plan(t, 2);
    p.fields.iter_mut().find(|f| f.name == "code").unwrap().kind = "ai".into();
    p.ai = Some(AiOptions {
        stream: true,
        provider_id: provider.id,
        model: None,
        prompt: "两个测试名称".into(),
    });
    let result = generate(&state, p).await.unwrap();
    assert_eq!(result.rows[0]["code"], "AI-A");
    assert_eq!(result.rows[1]["code"], "AI-B");
    assert_eq!(result.usage.input_tokens, Some(40));
    assert_eq!(preview(&state, &result.id, 0).unwrap().rows, result.rows);
    let request = server.await.unwrap();
    assert!(request.contains("9007199254740993"));
    assert!(!request.contains("SELECT"));
    let body: Value = serde_json::from_str(request.split("\r\n\r\n").nth(1).unwrap()).unwrap();
    let prompt: Value =
        serde_json::from_str(body["messages"][1]["content"].as_str().unwrap()).unwrap();
    assert_eq!(prompt["firstRowNumber"], 1);
    assert_eq!(prompt["totalCount"], 2);
    assert_eq!(prompt["requiredCount"], 2);
    assert_eq!(prompt["fields"][0]["name"], "code");
    assert_eq!(result.usage.requests, 1);
}
#[tokio::test]
async fn invalid_ai_content_never_falls_back_to_local_data() {
    let (_dir, state, target) = sqlite_fixture().await;
    for (content, finish) in [
        (json!({"rows":[]}), "stop"),
        (json!({"rows":[{"other":"value"}]}), "stop"),
        (json!({"rows":[{"code":[1,2]}]}), "stop"),
        (json!({"rows":[{"code":"valid-but-truncated"}]}), "length"),
    ] {
        let (url, server) = ai::http_tests::mock(
            200,
            json!({"choices":[{"finish_reason":finish,"message":{"content":content.to_string()}}]}),
            0,
        )
        .await;
        let provider = ai::Provider {
            id: uuid::Uuid::new_v4().to_string(),
            name: "隔离错误响应".into(),
            base_url: url,
            model: "test".into(),
            token_parameter: "max_tokens".into(),
            output_format: "json".into(),
            timeout_seconds: 5,
            max_tokens: 512,
            is_default: true,
            has_key: false,
        };
        state
            .local
            .set_setting(
                "ai_providers_v1",
                &serde_json::to_string(&vec![&provider]).unwrap(),
            )
            .await
            .unwrap();
        let mut plan = fixture_plan(target.clone(), 1);
        plan.fields
            .iter_mut()
            .find(|f| f.name == "code")
            .unwrap()
            .kind = "ai".into();
        plan.ai = Some(AiOptions {
            stream: true,
            provider_id: provider.id,
            model: None,
            prompt: "直接生成业务名称".into(),
        });
        assert!(generate(&state, plan).await.is_err());
        assert!(
            state.generation.entries.lock().unwrap().is_empty(),
            "错误响应不能产生可写入批次"
        );
        assert!(server
            .await
            .unwrap()
            .starts_with("POST /v1/chat/completions"));
    }
    let rows = state
        .connected(&target.session_id)
        .await
        .unwrap()
        .adapter
        .query_page(
            "main",
            "SELECT * FROM items",
            0,
            10,
            &crate::adapters::QueryContext::new(),
        )
        .await
        .unwrap();
    assert!(rows.rows.is_empty(), "生成错误不得写入数据库");
}
#[tokio::test]
async fn cancellation_stops_future_sql_batches() {
    let (_dir, state, t) = sqlite_fixture().await;
    let p = generate(&state, fixture_plan(t, 5000)).await.unwrap();
    state.tasks.begin("write".into()).unwrap();
    let writer = state
        .tasks
        .scope(Some("write".into()), write(&state, &p.id));
    let cancel = async {
        for _ in 0..1000 {
            if state.tasks.snapshot("write").unwrap().processed >= 100 {
                state.tasks.cancel("write").unwrap();
                return;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        panic!("未收到写入进度");
    };
    let (r, _) = tokio::join!(writer, cancel);
    let r = r.unwrap();
    assert!(r.cancelled);
    assert!(r.inserted >= 100 && r.inserted < 5000);
    assert_eq!(r.inserted % 100, 0);
    assert_eq!(r.unattempted, 5000 - r.inserted);
    assert_eq!(r.uncertain, 0);
}

#[tokio::test]
async fn streamed_generation_keeps_failed_row_and_validated_sample() {
    let (_dir, state, target) = sqlite_fixture().await;
    let first = ai::http_tests::chunk("{\"rows\":[{\"code\":\"重复\"},", None);
    let second = ai::http_tests::chunk("{\"code\":\"重复\"}]}", Some("stop"));
    let (url, server) =
        ai::http_tests::mock_stream(vec![first, second, "data: [DONE]\n\n".into()]).await;
    let provider = ai::Provider {
        id: uuid::Uuid::new_v4().to_string(),
        name: "流式生成测试".into(),
        base_url: url,
        model: "test".into(),
        token_parameter: "max_tokens".into(),
        output_format: "json".into(),
        timeout_seconds: 5,
        max_tokens: 512,
        is_default: true,
        has_key: false,
    };
    state
        .local
        .set_setting(
            "ai_providers_v1",
            &serde_json::to_string(&vec![&provider]).unwrap(),
        )
        .await
        .unwrap();
    let mut plan = fixture_plan(target, 2);
    plan.fields
        .iter_mut()
        .find(|f| f.name == "code")
        .unwrap()
        .kind = "ai".into();
    plan.ai = Some(AiOptions {
        stream: true,
        provider_id: provider.id,
        model: None,
        prompt: "生成不重复名称".into(),
    });
    let events = Arc::new(Mutex::new(Vec::new()));
    let captured = events.clone();
    let observer: Observer = Arc::new(move |e| captured.lock().unwrap().push(e));
    let error = generate_observed(&state, plan, Some(observer))
        .await
        .unwrap_err()
        .to_string();
    assert!(error.contains("第 2 条") && error.contains("code"));
    let events = events.lock().unwrap();
    assert!(events
        .iter()
        .any(|e| matches!(e,GenerationEvent::Delta{text} if text.contains("重复"))));
    assert!(events
        .iter()
        .any(|e| matches!(e, GenerationEvent::Validated { number: 1, .. })));
    assert!(events
        .iter()
        .any(|e| matches!(e,GenerationEvent::Rejected{number:2,row,..} if row["code"]=="重复")));
    assert!(state.generation.entries.lock().unwrap().is_empty());
    drop(events);
    server.await.unwrap();
}
#[test]
fn template_substitutions_are_literal_and_bson_types_are_preserved() {
    let params = HashMap::from([
        ("prefix".into(), "${other}".into()),
        ("other".into(), "unexpected".into()),
    ]);
    assert_eq!(
        rules::expand_text("测试:${prefix}:{n}", 4, &params).unwrap(),
        "测试:${other}:5"
    );
    assert!(rules::expand_text("${missing}", 0, &params).is_err());
    let t = Target {
        session_id: "s".into(),
        database: "db".into(),
        schema: None,
        object: "c".into(),
        redis_kind: None,
        ttl_seconds: None,
    };
    let p = fixture_plan(t, 1);
    let mut row = json!({"value":"9007199254740993"});
    adapters::mongo_native_values(&p, &mut row).unwrap();
    let doc = crate::adapters::mongodb::parse_document(&row.to_string()).unwrap();
    assert_eq!(doc.get_i64("value").unwrap(), 9007199254740993);
}
#[tokio::test]
#[ignore = "显式本机服务测试：仅新建随机测试对象，结束后清理，不操作业务数据"]
async fn local_generation_acceptance() {
    use crate::{adapters::QueryContext, meta::Engine, services::session};
    let state = AppState::initialize().await.unwrap();
    let sessions = state.local.list_sessions().await.unwrap();
    let only = std::env::var("DW_GEN_QA_ENGINE").unwrap_or_default();
    for engine in [
        Engine::Mysql,
        Engine::Postgres,
        Engine::Mongodb,
        Engine::Redis,
    ] {
        if !only.is_empty() && only != engine.as_str() {
            continue;
        }
        let s = sessions
            .iter()
            .find(|s| s.engine == engine && s.host.as_deref() == Some("127.0.0.1") && !s.read_only)
            .expect("缺少已保存的本机可写会话");
        session::connect(&state, &s.id).await.unwrap();
        let c = state.connected(&s.id).await.unwrap();
        let name = format!("dw_gen_qa_{}", uuid::Uuid::new_v4().simple());
        if engine.is_sql() {
            let (db, schema, qualified, create, drop_sql) = if engine == Engine::Mysql {
                (
                    name.clone(),
                    None,
                    format!("`{name}`.items"),
                    format!("CREATE DATABASE `{name}`"),
                    format!("DROP DATABASE `{name}`"),
                )
            } else {
                (
                    "postgres".into(),
                    Some(name.clone()),
                    format!("\"{name}\".items"),
                    format!("CREATE SCHEMA \"{name}\""),
                    format!("DROP SCHEMA \"{name}\" CASCADE"),
                )
            };
            let admin_db = if engine == Engine::Mysql {
                "mysql"
            } else {
                "postgres"
            };
            c.adapter
                .execute_statements(admin_db, &[create])
                .await
                .unwrap();
            let result:crate::error::AppResult<()>=async{
    c.adapter.execute_statements(&db,&[format!("CREATE TABLE {qualified} (id BIGINT PRIMARY KEY, code VARCHAR(60) NOT NULL UNIQUE, amount DECIMAL(10,2), created DATE, updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP, payload JSON)")]).await?;
    let p=Plan{version:1,target:Target{session_id:s.id.clone(),database:db.clone(),schema,object:"items".into(),redis_kind:None,ttl_seconds:None},count:205,seed:"local".into(),parameters:HashMap::new(),ai:None,fields:serde_json::from_value(json!([
      {"name":"id","kind":"sequence","args":{"start":"9007199254740993"}},{"name":"code","kind":"text","args":{"pattern":"sample-{n}"}},{"name":"amount","kind":"decimal","args":{"min":"10.50","max":"10.50","scale":2}},{"name":"created","kind":"date","args":{"start":"2026-01-01","end":"2026-01-31"}},{"name":"updated","kind":"constant","args":{"value":"2026-02-03 12:00:00"}},{"name":"payload","kind":"constant","args":{"value":"hello"}}
    ]))?};let preview=generate(&state,p).await?;let report=write(&state,&preview.id).await?;if report.inserted!=205||report.error.is_some(){return Err(invalid(format!("写入结果不符：{report:?}")));}
    let q=c.adapter.query_page(&db,&format!("SELECT id FROM {qualified} ORDER BY id LIMIT 1"),0,1,&QueryContext::new()).await?;if !matches!(q.rows[0][0],crate::meta::value::DbValue::Int(9007199254740993)|crate::meta::value::DbValue::UInt(9007199254740993)){return Err(invalid("大整数写入精度不符"));}Ok(())
   }.await;
            c.adapter
                .execute_statements(admin_db, &[drop_sql])
                .await
                .unwrap();
            result.unwrap();
        } else if engine == Engine::Mongodb {
            use mongodb::{
                bson::{doc, Bson, Document},
                options::{ClientOptions, Credential},
                Client,
            };
            let mut opts =
                ClientOptions::parse(format!("mongodb://127.0.0.1:{}", s.port.unwrap_or(27017)))
                    .await
                    .unwrap();
            if s.username.as_deref().is_some_and(|x| !x.is_empty()) {
                opts.credential = Some(
                    Credential::builder()
                        .username(s.username.clone())
                        .password(crate::store::secrets::load_password(&s.id).unwrap())
                        .source(s.auth_source.clone().unwrap_or_else(|| "admin".into()))
                        .build(),
                );
            }
            let client = Client::with_options(opts).unwrap();
            let database = client.database(&name);
            database.create_collection("items").validator(doc!{"$jsonSchema":{"bsonType":"object","required":["counter","amount","created"],"properties":{"counter":{"bsonType":"long"},"amount":{"bsonType":"decimal"},"created":{"bsonType":"date"}}}}).await.unwrap();
            let result:crate::error::AppResult<()>=async{
    let p=Plan{version:1,target:Target{session_id:s.id.clone(),database:name.clone(),schema:None,object:"items".into(),redis_kind:None,ttl_seconds:None},count:12,seed:"local".into(),parameters:HashMap::new(),ai:None,fields:serde_json::from_value(json!([
    {"name":"_id","kind":"objectId"},{"name":"profile.name","kind":"name"},{"name":"counter","kind":"sequence","args":{"start":"9007199254740993"}},{"name":"amount","kind":"decimal","args":{"min":"1.23","max":"1.23","scale":2}},{"name":"created","kind":"date","args":{"start":"2026-01-01","end":"2026-01-02"}}
    ]))?};let preview=generate(&state,p).await?;let report=write(&state,&preview.id).await?;if report.inserted!=12{return Err(invalid(format!("MongoDB 写入结果不符：{report:?}")));}let rows=database.collection::<Document>("items");let actual=rows.find_one(doc!{"counter":9007199254740993i64}).await.map_err(|_|invalid("MongoDB 读取验收失败"))?.ok_or_else(||invalid("未找到完整精度数据"))?;if !matches!(actual.get("amount"),Some(Bson::Decimal128(_)))||!matches!(actual.get("created"),Some(Bson::DateTime(_))){return Err(invalid("BSON 类型未保留"));}Ok(())
   }.await;
            database.drop().await.unwrap();
            result.unwrap();
        } else {
            let a = c.key_value.as_ref().unwrap();
            let prefix = format!("qa:{name}");
            let mut keys = vec![];
            let result:crate::error::AppResult<()>=async{for kind in ["string","hash"]{let target=Target{session_id:s.id.clone(),database:"db0".into(),schema:None,object:"keys".into(),redis_kind:Some(kind.into()),ttl_seconds:Some(60)};let desc=adapters::resolve(&state,&target).await?.describe().await?;let key=format!("{prefix}:{kind}");keys.push(key.clone());let p=Plan{version:1,target:target.clone(),count:1,seed:"local".into(),parameters:HashMap::new(),ai:None,fields:serde_json::from_value(json!([{"name":"key","kind":"constant","args":{"value":key}},{"name":"value","kind":"constant","args":{"value":if kind=="hash"{json!({"name":"测试"})}else{json!("测试")}}}]))?};let batch=generate(&state,p.clone()).await?;let r=write(&state,&batch.id).await?;if r.inserted!=1{return Err(invalid(format!("Redis 写入失败：{r:?}")));}let ttl=a.command(0,&["TTL".into(),key.clone()]).await?;if ttl.as_i64().is_none_or(|v|v<=0||v>60){return Err(invalid("Redis TTL 未生效"));}let again=generate(&state,p).await?;let r=write(&state,&again.id).await?;if r.failed!=1||r.inserted!=0{return Err(invalid("已有键未被保护"));}let _=desc;}Ok(())}.await;
            for key in keys {
                a.delete_key(0, &key).await.unwrap();
            }
            result.unwrap();
        }
        state.disconnect(&s.id).await;
        println!("本机 {} 数据生成/校验/写入/清理通过", engine.as_str());
    }
}
#[test]
fn expansion_and_computed_limits() {
    let parameters = HashMap::from([("x".into(), "a".repeat(1024))]);
    assert!(rules::expand_text(&"${x}".repeat(1100), 0, &parameters).is_err());
    let fields:Vec<FieldRule>=serde_json::from_value(json!([{"name":"x","kind":"constant","args":{"value":"sample"}},{"name":"result","kind":"compute","args":{"op":"concat","fields":["x","x","x"]}}])).unwrap();
    let ordered = rules::ordered_fields(&fields).unwrap();
    let mut row = json!({"x":"x".repeat(512*1024)});
    assert!(rules::finish_computed(&ordered, &mut row, &HashMap::new()).is_err());
}
#[tokio::test]
async fn ai_rule_suggestions_validate_before_returning() {
    let (_dir, state, t) = sqlite_fixture().await;
    let expected = fixture_plan(t.clone(), 1).fields;
    let(url,server)=ai::http_tests::mock(200,json!({"choices":[{"finish_reason":"stop","message":{"content":json!({"fields":expected}).to_string()}}]}),0).await;
    let provider = ai::Provider {
        id: uuid::Uuid::new_v4().to_string(),
        name: "模拟建议".into(),
        base_url: url,
        model: "test".into(),
        output_format: "json".into(),
        token_parameter: "max_tokens".into(),
        timeout_seconds: 5,
        max_tokens: 512,
        is_default: true,
        has_key: false,
    };
    state
        .local
        .set_setting(
            "ai_providers_v1",
            &serde_json::to_string(&vec![&provider]).unwrap(),
        )
        .await
        .unwrap();
    let result = suggest(
        &state,
        t.clone(),
        AiOptions {
            stream: true,
            provider_id: provider.id.clone(),
            model: None,
            prompt: "规则建议".into(),
        },
    )
    .await
    .unwrap();
    assert_eq!(result["fields"].as_array().unwrap().len(), 5);
    server.await.unwrap();
    let(url,server)=ai::http_tests::mock(200,json!({"choices":[{"finish_reason":"stop","message":{"content":"{\"fields\":[{\"name\":\"code\",\"kind\":\"eval\",\"args\":{}}]}"}}]}),0).await;
    let mut provider = provider;
    provider.base_url = url;
    state
        .local
        .set_setting(
            "ai_providers_v1",
            &serde_json::to_string(&vec![&provider]).unwrap(),
        )
        .await
        .unwrap();
    assert!(suggest(
        &state,
        t,
        AiOptions {
            stream: true,
            provider_id: provider.id,
            model: None,
            prompt: "无效规则".into()
        }
    )
    .await
    .is_err());
    server.await.unwrap();
}
#[test]
fn json_scalar_values_preserve_their_semantics() {
    use crate::meta::{CanonicalType, ColumnMeta};
    let c = ColumnMeta {
        name: "j".into(),
        ordinal: 1,
        raw_type: "json".into(),
        canonical: CanonicalType::Json,
        nullable: true,
        default_value: None,
        auto_increment: false,
        unsigned: false,
        charset: None,
        collation: None,
        comment: None,
    };
    for v in [json!("hello"), json!({"x":1}), json!(12), json!(true)] {
        let crate::meta::value::DbValue::Json(text) = adapters::sql_value(&c, &v).unwrap() else {
            panic!()
        };
        assert_eq!(serde_json::from_str::<Value>(&text).unwrap(), v);
    }
    assert!(adapters::sql_value(&c, &json!({"n":9007199254740993i64})).is_err());
}
#[tokio::test]
async fn sqlite_composite_primary_keys_are_not_auto_generated() {
    let (_dir, state, mut t) = sqlite_fixture().await;
    state.connected(&t.session_id).await.unwrap().adapter.execute_statements("main",&["CREATE TABLE composite (a INTEGER NOT NULL,b INTEGER NOT NULL,PRIMARY KEY(a,b)) WITHOUT ROWID".into()]).await.unwrap();
    t.object = "composite".into();
    let d = adapters::resolve(&state, &t)
        .await
        .unwrap()
        .describe()
        .await
        .unwrap();
    assert!(d.fields.iter().all(|f| !f.generated));
    let p = Plan {
        version: 1,
        target: t,
        count: 2,
        seed: "x".into(),
        parameters: HashMap::new(),
        ai: None,
        fields: serde_json::from_value(
            json!([{"name":"a","kind":"sequence"},{"name":"b","kind":"sequence"}]),
        )
        .unwrap(),
    };
    let batch = generate(&state, p).await.unwrap();
    assert_eq!(write(&state, &batch.id).await.unwrap().inserted, 2);
}
#[test]
fn timestamp_input_follows_database_native_semantics() {
    use crate::meta::{CanonicalType as C, ColumnMeta};
    let mut c = ColumnMeta {
        name: "t".into(),
        ordinal: 1,
        raw_type: "timestamp".into(),
        canonical: C::DateTime {
            precision: None,
            tz: true,
        },
        nullable: false,
        default_value: None,
        auto_increment: false,
        unsigned: false,
        charset: None,
        collation: None,
        comment: None,
    };
    assert!(adapters::sql_value(&c, &json!("2026-02-03 12:00:00")).is_ok());
    c.raw_type = "timestamp with time zone".into();
    assert!(adapters::sql_value(&c, &json!("2026-02-03 12:00:00")).is_err());
    assert!(adapters::sql_value(&c, &json!("2026-02-03T12:00:00+08:00")).is_ok());
    c.canonical = C::Time {
        precision: None,
        tz: true,
    };
    c.raw_type = "time with time zone".into();
    assert!(adapters::sql_value(&c, &json!("12:00:00+08:00")).is_ok());
}
