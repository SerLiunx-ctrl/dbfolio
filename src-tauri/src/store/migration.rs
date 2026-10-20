//! Versioned, credential-free configuration transfer. Planning and applying share
//! one transaction snapshot; no remote database or credential store is modified.
use super::local::{row_to_session, validate_input, LocalStore, SessionInput, SessionRecord};
use crate::error::{AppError, AppResult};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{Row, SqliteConnection};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

pub const MAX_BYTES: usize = 16 * 1024 * 1024;
const PREFS: &[&str] = &[
    "ui_theme",
    "ui_interface_style",
    "ui_accent",
    "ui_density",
    "ui_motion",
    "ui_sidebar_width",
    "ui_right_sidebar_width",
    "ui_sidebar_split",
    "ui_sidebar_collapsed",
    "ui_max_tabs",
    "ui_zoom",
    "ui_wrap_tabs",
    "ui_redis_tree_width",
    "ui_redis_preview_width",
    "query_page_size",
    "history_limit_per_session",
    "workspace_panel_dock_v1",
    "workspace_layout_presets_v1",
];
const LIBRARY: &str = "productivity_library_v1";
const ANALYSES: &str = "analysis_plans_v1";
const RELATIONS: &str = "business_relations_v1";
const OBJECTS: &str = "object_preferences_v1";
const FOLDERS: &str = "session_folders";

fn invalid(message: impl Into<String>) -> AppError {
    AppError::InvalidInput(message.into())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfigBundle {
    pub format: String,
    pub version: u32,
    pub app_version: String,
    pub exported_at: String,
    pub sessions: Vec<SessionRecord>,
    pub folders: Vec<String>,
    pub preferences: BTreeMap<String, String>,
    pub favorites: Vec<Value>,
    pub filters: Vec<Value>,
    pub analyses: Vec<Value>,
    pub relations: Vec<Value>,
    pub environments: BTreeMap<String, String>,
    pub object_favorites: Vec<Value>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportOptions {
    pub session_ids: Vec<String>,
    pub folders: Vec<String>,
    pub preferences: bool,
    pub favorites: bool,
    pub filters: bool,
    pub analyses: bool,
    pub relations: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ImportMode {
    Copy,
    Merge,
    Skip,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportOptions {
    pub mode: ImportMode,
    pub preferences: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDecision {
    pub name: String,
    pub engine: String,
    pub action: String,
    pub target_name: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub fingerprint: String,
    pub sessions: Vec<SessionDecision>,
    pub added: BTreeMap<String, usize>,
    pub skipped: BTreeMap<String, usize>,
    pub preferences: usize,
    pub folders: usize,
    pub warnings: Vec<String>,
}

fn text<'a>(v: &'a Value, key: &str) -> AppResult<&'a str> {
    v.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| invalid(format!("配置字段 {key} 必须为文本")))
}
fn strings(v: &Value) -> bool {
    v.as_array().is_some_and(|a| a.iter().all(Value::is_string))
}
fn optional_schema(v: &Value) -> AppResult<()> {
    if v.get("schema")
        .is_some_and(|s| !s.is_null() && !s.is_string())
    {
        return Err(invalid("对象 schema 必须为文本或空值"));
    }
    Ok(())
}
fn scope(v: &Value) -> AppResult<Vec<Value>> {
    let a: Vec<Value> =
        serde_json::from_str(text(v, "scope")?).map_err(|_| invalid("筛选方案的对象范围无效"))?;
    if a.len() != 4
        || !a[0].is_string()
        || !a[1].is_string()
        || !(a[2].is_null() || a[2].is_string())
        || !a[3].is_string()
    {
        return Err(invalid("筛选方案的对象范围无效"));
    }
    Ok(a)
}
fn session_input(s: &SessionRecord) -> AppResult<SessionInput> {
    let mut value = serde_json::to_value(s)?;
    for key in ["password", "sshPassword", "sshKeyPassphrase"] {
        value[key] = Value::Null;
    }
    Ok(serde_json::from_value(value)?)
}

impl ConfigBundle {
    pub fn validate(&self) -> AppResult<()> {
        if self.format != "dbfolio-config" || self.version != 1 {
            return Err(invalid("不支持的配置文件格式或版本"));
        }
        if serde_json::to_vec(self)?.len() > MAX_BYTES || self.sessions.len() > 2000 {
            return Err(invalid("配置文件超过 16 MiB 或 2000 个会话限制"));
        }
        let mut ids = BTreeSet::new();
        for s in &self.sessions {
            if s.id.is_empty() || !ids.insert(s.id.as_str()) || s.has_password {
                return Err(invalid("会话 ID 重复、为空或包含凭据标记"));
            }
            validate_input(&session_input(s)?)?;
            // URI secrets are prohibited even if supplied by an edited package.
            if s.host.as_deref().is_some_and(|h| h.contains('@')) {
                return Err(invalid("连接地址不能包含内嵌凭据"));
            }
        }
        if self.folders.len() > 2000
            || [
                &self.favorites,
                &self.filters,
                &self.relations,
                &self.object_favorites,
            ]
            .iter()
            .any(|items| items.len() > 10000)
        {
            return Err(invalid("分组最多 2000 个，每类收藏或关联最多 10000 项"));
        }
        if self.folders.iter().any(|s| s.trim().is_empty()) {
            return Err(invalid("分组名称不能为空"));
        }
        for (k, v) in &self.preferences {
            validate_preference(k, v)?;
        }
        let reference = |id: &str| {
            if ids.contains(id) {
                Ok(())
            } else {
                Err(invalid("方案引用了未包含在配置文件中的会话"))
            }
        };
        for (id, env) in &self.environments {
            reference(id)?;
            if !["none", "development", "testing", "production"].contains(&env.as_str()) {
                return Err(invalid("环境标记无效"));
            }
        }
        for v in &self.object_favorites {
            optional_schema(v)?;
            reference(text(v, "sessionId")?)?;
            for key in ["database", "name", "kind"] {
                text(v, key)?;
            }
            if !["table", "redis", "mongo"].contains(&text(v, "kind")?) {
                return Err(invalid("对象收藏类型无效"));
            }
        }
        for v in &self.favorites {
            let h: super::local::HistoryEntry =
                serde_json::from_value(v.clone()).map_err(|_| invalid("收藏 SQL 格式无效"))?;
            reference(&h.session_id)?;
        }
        for v in &self.filters {
            text(v, "id")?;
            text(v, "name")?;
            reference(scope(v)?[0].as_str().unwrap())?;
            if !["and", "or"].contains(&text(v, "conjunction")?) {
                return Err(invalid("筛选连接方式无效"));
            }
            let _: Vec<crate::services::query::FilterCondition> =
                serde_json::from_value(v["filters"].clone())
                    .map_err(|_| invalid("筛选条件格式无效"))?;
        }
        if self.analyses.len() > 100 || serde_json::to_vec(&self.analyses)?.len() > 2 * 1024 * 1024
        {
            return Err(invalid("分析方案最多 100 个、总大小不超过 2 MiB"));
        }
        for v in &self.analyses {
            for key in [
                "id",
                "name",
                "sessionId",
                "database",
                "source",
                "collection",
                "query",
            ] {
                text(v, key)?;
            }
            reference(text(v, "sessionId")?)?;
            if v["version"] != 1
                || text(v, "name")?.trim().is_empty()
                || text(v, "name")?.encode_utf16().count() > 120
                || text(v, "query")?.encode_utf16().count() > 200000
                || !["sql", "mongo"].contains(&text(v, "source")?)
            {
                return Err(invalid("分析方案格式无效"));
            }
            let c = &v["chart"];
            if ![
                "bar",
                "horizontal",
                "line",
                "area",
                "pie",
                "donut",
                "scatter",
                "histogram",
                "kpi",
            ]
            .contains(&text(c, "kind")?)
                || !["sum", "avg", "count", "min", "max"].contains(&text(c, "aggregate")?)
                || !["source", "asc", "desc"].contains(&text(c, "sort")?)
                || !c["top"].as_u64().is_some_and(|n| (1..=200).contains(&n))
                || !c["bins"].as_u64().is_some_and(|n| (2..=100).contains(&n))
            {
                return Err(invalid("分析图表设置无效"));
            }
            for key in ["x", "y", "series"] {
                text(c, key)?;
            }
            let p = v["parameters"]
                .as_object()
                .ok_or_else(|| invalid("分析参数无效"))?;
            if p.len() > 100 {
                return Err(invalid("分析参数过多"));
            }
            for p in p.values() {
                text(p, "value")?;
                if !["text", "number", "date", "null"].contains(&text(p, "type")?) {
                    return Err(invalid("分析参数类型无效"));
                }
            }
            for key in ["metadataSource", "lookup"] {
                if let Some(t) = v.get(key).filter(|t| !t.is_null()) {
                    for field in ["table", "schema"] {
                        if text(t, field)?.encode_utf16().count() > 512 {
                            return Err(invalid("分析关联表名称过长"));
                        }
                    }
                    if key == "lookup" {
                        for k in ["field", "key", "label"] {
                            if text(t, k)?.encode_utf16().count() > 2048 {
                                return Err(invalid("分析名称关联字段过长"));
                            }
                        }
                    }
                }
            }
        }
        for v in &self.relations {
            text(v, "id")?;
            reference(text(&v["source"], "sessionId")?)?;
            for t in [&v["source"], &v["target"]] {
                optional_schema(t)?;
                text(t, "database")?;
                text(t, "table")?;
            }
            if !strings(&v["columns"])
                || !strings(&v["keys"])
                || v["columns"].as_array().unwrap().is_empty()
                || v["columns"].as_array().unwrap().len() != v["keys"].as_array().unwrap().len()
            {
                return Err(invalid("业务关联字段不匹配"));
            }
        }
        Ok(())
    }
}

fn validate_preference(key: &str, value: &str) -> AppResult<()> {
    let number = |min: f64, max: f64, integer: bool| {
        value
            .parse::<f64>()
            .is_ok_and(|n| n.is_finite() && n >= min && n <= max && (!integer || n.fract() == 0.0))
    };
    let valid = match key {
        "ui_theme" => ["system", "light", "dark", "oled"].contains(&value),
        "ui_interface_style" => [
            "classic", "aurora", "studio", "ocean", "forest", "sand", "lavender", "slate", "rose",
        ]
        .contains(&value),
        "ui_density" => ["compact", "comfortable"].contains(&value),
        "ui_motion" => ["system", "full", "reduced", "off"].contains(&value),
        "ui_accent" => {
            value == "system"
                || (value.len() == 7
                    && value.starts_with('#')
                    && value[1..].bytes().all(|c| c.is_ascii_hexdigit()))
        }
        "ui_sidebar_collapsed" | "ui_wrap_tabs" => ["0", "1"].contains(&value),
        "ui_sidebar_width" | "ui_right_sidebar_width" => number(200.0, 460.0, false),
        "ui_sidebar_split" => number(0.2, 0.8, false),
        "ui_zoom" => number(0.6, 2.0, false),
        "ui_max_tabs" => number(0.0, 500.0, true),
        "ui_redis_tree_width" => number(160.0, 480.0, false),
        "ui_redis_preview_width" => number(240.0, 720.0, false),
        "query_page_size" => number(1.0, 5000.0, true),
        "history_limit_per_session" => number(0.0, 100000.0, true),
        "workspace_panel_dock_v1" => {
            serde_json::from_str::<Value>(value).is_ok_and(|v| valid_dock(&v))
        }
        "workspace_layout_presets_v1" => serde_json::from_str::<Value>(value).is_ok_and(|v| {
            v.as_array().is_some_and(|a| {
                a.len() <= 12
                    && a.iter().all(|p| {
                        p["name"]
                            .as_str()
                            .is_some_and(|s| !s.trim().is_empty() && s.chars().count() <= 40)
                            && valid_dock(&p["layout"]["dock"])
                            && p["layout"]["sidebarWidth"].is_number()
                            && p["layout"]["rightSidebarWidth"].is_number()
                            && p["layout"]["sidebarSplit"].is_number()
                            && p["layout"]["sidebarCollapsed"].is_boolean()
                    })
            })
        }),
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(invalid(format!("不支持或无效的首选项：{key}")))
    }
}
fn valid_dock(v: &Value) -> bool {
    ["sessions", "explorer"].iter().all(|k| {
        v[*k]
            .as_str()
            .is_some_and(|s| ["left", "right"].contains(&s))
    }) && v["first"]
        .as_str()
        .is_some_and(|s| ["sessions", "explorer"].contains(&s))
}

struct Snapshot {
    sessions: Vec<SessionRecord>,
    settings: BTreeMap<String, String>,
}
async fn snapshot(conn: &mut SqliteConnection) -> AppResult<Snapshot> {
    let sessions = sqlx::query("SELECT * FROM sessions ORDER BY id")
        .fetch_all(&mut *conn)
        .await?
        .iter()
        .map(row_to_session)
        .collect::<AppResult<Vec<_>>>()?;
    let mut query =
        sqlx::QueryBuilder::<sqlx::Sqlite>::new("SELECT key,value FROM settings WHERE key IN (");
    let mut list = query.separated(",");
    for key in PREFS
        .iter()
        .copied()
        .chain([LIBRARY, ANALYSES, RELATIONS, OBJECTS, FOLDERS])
    {
        list.push_bind(key);
    }
    query.push(") ORDER BY key");
    let rows = query.build().fetch_all(&mut *conn).await?;
    let settings = rows
        .into_iter()
        .map(|r| (r.get("key"), r.get("value")))
        .collect();
    Ok(Snapshot { sessions, settings })
}
fn setting(s: &Snapshot, key: &str, default: Value) -> AppResult<Value> {
    s.settings
        .get(key)
        .map(|v| {
            serde_json::from_str(v)
                .map_err(|_| invalid(format!("本地配置 {key} 格式损坏，请先修复")))
        })
        .unwrap_or(Ok(default))
}
fn array(v: &Value) -> AppResult<Vec<Value>> {
    v.as_array()
        .cloned()
        .ok_or_else(|| invalid("配置列表格式无效"))
}

impl LocalStore {
    pub async fn config_export(&self, options: &ExportOptions) -> AppResult<ConfigBundle> {
        let mut tx = self.pool.begin().await?;
        let s = snapshot(&mut tx).await?;
        tx.rollback().await?;
        let selected: BTreeSet<_> = options.session_ids.iter().cloned().collect();
        if selected
            .iter()
            .any(|id| !s.sessions.iter().any(|s| &s.id == id))
        {
            return Err(invalid("选中的会话已被删除，请刷新后重试"));
        }
        let mut sessions: Vec<_> = s
            .sessions
            .into_iter()
            .filter(|s| selected.contains(&s.id))
            .collect();
        for s in &mut sessions {
            s.has_password = false;
        }
        let s = Snapshot {
            sessions: vec![],
            settings: s.settings,
        };
        let library = setting(&s, LIBRARY, json!({"history":[],"filters":[]}))?;
        let objects = setting(&s, OBJECTS, json!({"environments":{},"favorites":[]}))?;
        let mut folders: BTreeSet<String> = options.folders.iter().cloned().collect();
        folders.extend(sessions.iter().filter_map(|s| s.group_name.clone()));
        let mut bundle = ConfigBundle {
            format: "dbfolio-config".into(),
            version: 1,
            app_version: env!("CARGO_PKG_VERSION").into(),
            exported_at: Utc::now().to_rfc3339(),
            sessions,
            folders: folders.into_iter().collect(),
            preferences: BTreeMap::new(),
            favorites: vec![],
            filters: vec![],
            analyses: vec![],
            relations: vec![],
            environments: BTreeMap::new(),
            object_favorites: vec![],
        };
        if options.preferences {
            bundle.preferences = s
                .settings
                .iter()
                .filter(|(k, _)| PREFS.contains(&k.as_str()))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect();
        }
        if options.favorites {
            bundle.favorites = array(&library["history"])?
                .into_iter()
                .filter(|v| {
                    v["sessionId"]
                        .as_str()
                        .is_some_and(|id| selected.contains(id))
                })
                .collect();
        }
        if options.filters {
            for v in array(&library["filters"])? {
                if selected.contains(scope(&v)?[0].as_str().unwrap()) {
                    bundle.filters.push(v);
                }
            }
        }
        if options.analyses {
            bundle.analyses = array(&setting(&s, ANALYSES, json!([]))?)?
                .into_iter()
                .filter(|v| {
                    v["sessionId"]
                        .as_str()
                        .is_some_and(|id| selected.contains(id))
                })
                .collect();
        }
        if options.relations {
            bundle.relations = array(&setting(&s, RELATIONS, json!([]))?)?
                .into_iter()
                .filter(|v| {
                    v["source"]["sessionId"]
                        .as_str()
                        .is_some_and(|id| selected.contains(id))
                })
                .collect();
        }
        for (id, env) in objects["environments"]
            .as_object()
            .ok_or_else(|| invalid("环境标记格式无效"))?
        {
            if selected.contains(id) {
                bundle.environments.insert(
                    id.clone(),
                    env.as_str()
                        .ok_or_else(|| invalid("环境标记格式无效"))?
                        .into(),
                );
            }
        }
        bundle.object_favorites = array(&objects["favorites"])?
            .into_iter()
            .filter(|v| {
                v["sessionId"]
                    .as_str()
                    .is_some_and(|id| selected.contains(id))
            })
            .collect();
        bundle.validate()?;
        Ok(bundle)
    }

    pub async fn config_import(
        &self,
        bundle: &ConfigBundle,
        options: &ImportOptions,
        expected: Option<&str>,
    ) -> AppResult<ImportPreview> {
        bundle.validate()?;
        let mut tx = self.pool.begin().await?;
        let s = snapshot(&mut tx).await?;
        let fingerprint = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(
                bundle,
                options,
                &s.sessions,
                &s.settings
            ))?)
        );
        if expected.is_some_and(|v| v != fingerprint) {
            return Err(invalid("配置文件或本机配置已变化，请重新预览后导入"));
        }
        let mut preview = ImportPreview {
            fingerprint,
            sessions: vec![],
            added: BTreeMap::new(),
            skipped: BTreeMap::new(),
            preferences: 0,
            folders: 0,
            warnings: vec![
                "密码、SSH 口令、私钥内容和证书文件不迁移；本地文件路径需在新电脑上检查。".into(),
            ],
        };
        let mut mapping = BTreeMap::new();
        let mut inserts = vec![];
        let mut names: BTreeSet<_> = s.sessions.iter().map(|s| s.name.clone()).collect();
        for source in &bundle.sessions {
            let candidates: Vec<_> = s
                .sessions
                .iter()
                .filter(|t| {
                    t.id == source.id
                        || (t.name == source.name
                            && t.group_name == source.group_name
                            && t.engine == source.engine)
                })
                .collect();
            if options.mode != ImportMode::Copy && candidates.len() > 1 {
                return Err(invalid(format!(
                    "会话「{}」有多个重复目标，请使用新建副本",
                    source.name
                )));
            }
            let duplicate = candidates.first().copied();
            let (action, target_name) =
                if let Some(existing) = duplicate.filter(|_| options.mode != ImportMode::Copy) {
                    if options.mode == ImportMode::Skip {
                        ("跳过", existing.name.clone())
                    } else {
                        if endpoint(existing)? != endpoint(source)? {
                            return Err(invalid(format!(
                                "会话「{}」连接目标不同，无法合并，请使用新建副本",
                                source.name
                            )));
                        }
                        mapping.insert(source.id.clone(), existing.id.clone());
                        ("合并（保留本机会话）", existing.name.clone())
                    }
                } else {
                    let mut target = source.clone();
                    target.id = Uuid::new_v4().to_string();
                    target.has_password = false;
                    let base = source.name.clone();
                    let mut n = 1;
                    while names.contains(&target.name) {
                        target.name = format!("{base}（导入 {n}）");
                        n += 1;
                    }
                    names.insert(target.name.clone());
                    mapping.insert(source.id.clone(), target.id.clone());
                    let name = target.name.clone();
                    inserts.push(target);
                    ("新建", name)
                };
            preview.sessions.push(SessionDecision {
                name: source.name.clone(),
                engine: source.engine.as_str().into(),
                action: action.into(),
                target_name,
            });
        }
        let mut writes = BTreeMap::new();
        let old_folders = setting(&s, FOLDERS, json!([]))?;
        let mut folders: BTreeSet<String> = serde_json::from_value(old_folders)?;
        let before = folders.len();
        folders.extend(bundle.folders.iter().cloned());
        preview.folders = folders.len() - before;
        writes.insert(FOLDERS.to_string(), serde_json::to_string(&folders)?);
        let mut library = setting(&s, LIBRARY, json!({"history":[],"filters":[],"files":[]}))?;
        let mut analyses = setting(&s, ANALYSES, json!([]))?;
        let mut relations = setting(&s, RELATIONS, json!([]))?;
        let mut objects = setting(&s, OBJECTS, json!({"environments":{},"favorites":[]}))?;
        if !library.is_object() || !objects.is_object() {
            return Err(invalid("本机收藏配置格式无效"));
        }
        let envs = objects["environments"]
            .as_object_mut()
            .ok_or_else(|| invalid("本机环境标记无效"))?;
        for (id, env) in &bundle.environments {
            if let Some(target) = mapping.get(id) {
                envs.entry(target.clone()).or_insert(json!(env));
            }
        }
        merge_items(
            &bundle.favorites,
            &mut library["history"],
            "收藏 SQL",
            &mapping,
            options.mode,
            &mut preview,
        )?;
        merge_items(
            &bundle.filters,
            &mut library["filters"],
            "筛选方案",
            &mapping,
            options.mode,
            &mut preview,
        )?;
        merge_items(
            &bundle.analyses,
            &mut analyses,
            "分析方案",
            &mapping,
            options.mode,
            &mut preview,
        )?;
        merge_items(
            &bundle.relations,
            &mut relations,
            "业务关联",
            &mapping,
            options.mode,
            &mut preview,
        )?;
        merge_items(
            &bundle.object_favorites,
            &mut objects["favorites"],
            "对象收藏",
            &mapping,
            options.mode,
            &mut preview,
        )?;
        if analyses.as_array().unwrap().len() > 100
            || serde_json::to_vec(&analyses)?.len() > 2 * 1024 * 1024
        {
            return Err(invalid(
                "导入后分析方案将超过 100 个或 2 MiB，请减少所选方案",
            ));
        }
        for (k, v) in [
            (LIBRARY, library),
            (ANALYSES, analyses),
            (RELATIONS, relations),
            (OBJECTS, objects),
        ] {
            writes.insert(k.into(), serde_json::to_string(&v)?);
        }
        if options.preferences {
            preview.preferences = bundle.preferences.len();
            writes.extend(bundle.preferences.clone());
            if preview.preferences > 0 {
                preview.warnings.push(
                    "已勾选首选项：文件中的外观、布局和查询页大小将覆盖本机对应设置。".into(),
                );
            }
        }
        if options.mode == ImportMode::Merge {
            preview.warnings.push(
                "合并保留本机已有连接参数、只读/数据库范围、环境标记及同名方案；仅补充缺失项。"
                    .into(),
            );
        }
        if expected.is_some() {
            for session in &inserts {
                insert_session(&mut tx, session).await?;
            }
            for (k, v) in writes {
                sqlx::query("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(k).bind(v).execute(&mut *tx).await?;
            }
            tx.commit().await?;
        } else {
            tx.rollback().await?;
        }
        Ok(preview)
    }
}

fn endpoint(s: &SessionRecord) -> AppResult<Value> {
    Ok(json!([
        s.engine,
        s.host,
        s.port,
        s.username,
        s.database,
        s.file_path,
        s.redis_db,
        s.auth_source,
        s.ssl_mode,
        s.tls,
        s.network
    ]))
}
fn item_key(v: &Value, kind: &str) -> Value {
    match kind {
        "收藏 SQL" => json!([v["sessionId"], v["database"], v["sql"]]),
        "筛选方案" => json!([v["scope"], v["name"]]),
        "分析方案" => json!([v["sessionId"], v["database"], v["name"]]),
        "业务关联" => json!([v["source"], v["columns"], v["target"], v["keys"]]),
        _ => json!([
            v["sessionId"],
            v["database"],
            v["schema"],
            v["kind"],
            v["name"]
        ]),
    }
}
fn merge_items(
    source: &[Value],
    target: &mut Value,
    kind: &str,
    mapping: &BTreeMap<String, String>,
    mode: ImportMode,
    preview: &mut ImportPreview,
) -> AppResult<()> {
    let target = target
        .as_array_mut()
        .ok_or_else(|| invalid(format!("本机{kind}格式无效")))?;
    let mut added = 0;
    let mut skipped = 0;
    for original in source {
        let mut v = original.clone();
        let old = match kind {
            "筛选方案" => scope(&v)?[0].as_str().unwrap().to_string(),
            "业务关联" => text(&v["source"], "sessionId")?.into(),
            _ => text(&v, "sessionId")?.into(),
        };
        let Some(id) = mapping.get(&old) else {
            skipped += 1;
            continue;
        };
        match kind {
            "筛选方案" => {
                let mut a = scope(&v)?;
                a[0] = json!(id);
                v["scope"] = json!(serde_json::to_string(&a)?);
            }
            "业务关联" => v["source"]["sessionId"] = json!(id),
            _ => v["sessionId"] = json!(id),
        }
        if mode != ImportMode::Copy
            && target
                .iter()
                .any(|t| item_key(t, kind) == item_key(&v, kind))
        {
            skipped += 1;
            continue;
        }
        if mode == ImportMode::Copy && ["筛选方案", "分析方案"].contains(&kind) {
            let base = text(&v, "name")?.to_string();
            let mut n = 1;
            while target
                .iter()
                .any(|t| item_key(t, kind) == item_key(&v, kind))
            {
                v["name"] = json!(format!(
                    "{}（导入 {n}）",
                    base.chars()
                        .scan(0, |units, ch| {
                            *units += ch.len_utf16();
                            (*units <= 100).then_some(ch)
                        })
                        .collect::<String>()
                ));
                n += 1;
            }
        }
        if kind == "收藏 SQL" {
            let min = target
                .iter()
                .filter_map(|v| v["id"].as_i64())
                .min()
                .unwrap_or(0)
                .min(0);
            v["id"] = json!(min
                .checked_sub(1)
                .ok_or_else(|| invalid("收藏 SQL 编号超出范围"))?);
        } else if kind != "对象收藏" {
            v["id"] = json!(Uuid::new_v4().to_string());
        }
        target.push(v);
        added += 1;
    }
    preview.added.insert(kind.into(), added);
    preview.skipped.insert(kind.into(), skipped);
    Ok(())
}

#[cfg(test)]
#[path = "migration_tests.rs"]
mod tests;
async fn insert_session(conn: &mut SqliteConnection, s: &SessionRecord) -> AppResult<()> {
    let now = Utc::now().to_rfc3339();
    sqlx::query("INSERT INTO sessions(id,name,engine,host,port,username,database,file_path,ssl_mode,redis_db,tls,auth_source,read_only,group_name,color,allowed_databases,network_config,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .bind(&s.id).bind(&s.name).bind(s.engine.as_str()).bind(&s.host).bind(s.port.map(i64::from)).bind(&s.username).bind(&s.database).bind(&s.file_path).bind(&s.ssl_mode).bind(s.redis_db.map(i64::from)).bind(s.tls.map(i64::from)).bind(&s.auth_source).bind(i64::from(s.read_only)).bind(&s.group_name).bind(&s.color).bind(s.allowed_databases.as_ref().map(serde_json::to_string).transpose()?).bind(serde_json::to_string(&s.network)?).bind(&now).bind(&now).execute(conn).await?;
    Ok(())
}
