use super::{invalid, Plan, Target};
use crate::{
    adapters::{
        build_change_statements,
        key_value::KeyValueAdapter,
        mongodb::{parse_document, DocumentAdapter},
        render_literal, CellValue, DbAdapter, QueryContext, RowChange, SqlParams,
    },
    error::{AppError, AppResult},
    meta::{value::DbValue, CanonicalType as C, ColumnMeta, Engine, TableKind, TableMeta},
    state::AppState,
};
use async_trait::async_trait;
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationField {
    pub name: String,
    pub raw_type: String,
    pub kind: String,
    pub nullable: bool,
    pub generated: bool,
    pub unique: bool,
    pub default_value: Option<String>,
    pub comment: Option<String>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetDescription {
    pub engine: Engine,
    pub fields: Vec<GenerationField>,
    pub fingerprint: String,
    pub warnings: Vec<String>,
    pub write_supported: bool,
    #[serde(skip)]
    pub meta: Option<TableMeta>,
}
#[async_trait]
pub trait DataGenerationAdapter: Send + Sync {
    async fn describe(&self) -> AppResult<TargetDescription>;
    fn validate_plan(&self, p: &Plan, d: &TargetDescription) -> AppResult<()>;
    fn validate_row(&self, row: &Value, d: &TargetDescription) -> AppResult<()>;
    fn normalize(&self, row: Value) -> AppResult<Value> {
        Ok(row)
    }
    fn check_unique(
        &self,
        row: &Value,
        d: &TargetDescription,
        seen: &mut HashMap<String, HashSet<String>>,
    ) -> AppResult<()>;
    fn batch_size(&self) -> usize;
    async fn write_batch(&self, rows: &[Value], d: &TargetDescription) -> AppResult<u64>;
}
pub async fn resolve(state: &AppState, t: &Target) -> AppResult<Box<dyn DataGenerationAdapter>> {
    let c = state.connected(&t.session_id).await?;
    match c.adapter.engine() {
        Engine::Redis => {
            let db = t
                .database
                .trim_start_matches("db")
                .parse::<u32>()
                .map_err(|_| invalid("Redis 数据库编号无效"))?;
            if !matches!(t.redis_kind.as_deref(), Some("string" | "hash"))
                || t.ttl_seconds.is_some_and(|v| v == 0 || v > 315360000)
            {
                return Err(invalid(
                    "Redis 支持 String/Hash，TTL 为 1–315360000 秒或留空",
                ));
            }
            Ok(Box::new(RedisGenerationAdapter {
                a: c.key_value.clone().ok_or_else(|| invalid("Redis 未连接"))?,
                t: t.clone(),
                db,
            }))
        }
        Engine::Mongodb => Ok(Box::new(MongoGenerationAdapter {
            a: c.mongo.clone().ok_or_else(|| invalid("MongoDB 未连接"))?,
            t: t.clone(),
        })),
        _ => Ok(Box::new(SqlGenerationAdapter {
            a: c.adapter.clone(),
            t: t.clone(),
        })),
    }
}
fn unique_value(
    seen: &mut HashMap<String, HashSet<String>>,
    name: String,
    values: Vec<Value>,
) -> AppResult<()> {
    if values.iter().any(Value::is_null) {
        return Ok(());
    }
    if !seen
        .entry(format!("constraint:{name}"))
        .or_default()
        .insert(serde_json::to_string(&values)?)
    {
        return Err(invalid(format!("生成数据违反唯一约束 {name}，请调整规则")));
    }
    Ok(())
}
fn field(name: &str, raw: &str, nullable: bool) -> GenerationField {
    GenerationField {
        name: name.into(),
        raw_type: raw.into(),
        kind: raw.into(),
        nullable,
        generated: false,
        unique: false,
        default_value: None,
        comment: None,
    }
}
pub struct SqlGenerationAdapter {
    pub a: Arc<dyn DbAdapter>,
    pub t: Target,
}
impl SqlGenerationAdapter {
    async fn generated(&self) -> AppResult<HashSet<String>> {
        let e = self.a.engine();
        let lit = |s: &str| render_literal(e, &DbValue::Text(s.into()));
        let t = &self.t;
        let sql=match e{Engine::Mysql=>format!("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA={} AND TABLE_NAME={} AND (EXTRA LIKE '%VIRTUAL GENERATED%' OR EXTRA LIKE '%STORED GENERATED%' OR EXTRA LIKE '%auto_increment%')",lit(&t.database),lit(&t.object)),Engine::Postgres=>format!("SELECT column_name FROM information_schema.columns WHERE table_schema={} AND table_name={} AND (is_generated='ALWAYS' OR is_identity='YES')",lit(t.schema.as_deref().unwrap_or("public")),lit(&t.object)),_=>format!("PRAGMA {}.table_xinfo({})",self.a.quote_ident(t.schema.as_deref().unwrap_or("main")),self.a.quote_ident(&t.object))};
        let q = self
            .a
            .query_page(&t.database, &sql, 0, 1000, &QueryContext::new())
            .await?;
        let mut out = HashSet::new();
        for row in q.rows {
            let index = if e == Engine::Sqlite {
                if row
                    .get(6)
                    .is_none_or(|v| matches!(v, DbValue::Int(0) | DbValue::UInt(0)))
                {
                    continue;
                }
                1
            } else {
                0
            };
            if let Some(DbValue::Text(s)) = row.get(index) {
                out.insert(s.clone());
            }
        }
        Ok(out)
    }
}
#[async_trait]
impl DataGenerationAdapter for SqlGenerationAdapter {
    async fn describe(&self) -> AppResult<TargetDescription> {
        let t = &self.t;
        let m = self
            .a
            .introspect_table(&t.database, t.schema.as_deref(), &t.object)
            .await?;
        if m.kind != TableKind::Table {
            return Err(invalid("数据生成仅支持实体表"));
        }
        let generated = self.generated().await?;
        let mut warnings = vec![
            "本地校验不替代数据库约束；唯一索引、排序规则、外键与 CHECK 由写入时再次校验。".into(),
        ];
        let mut writable = true;
        if self.a.engine() == Engine::Mysql {
            let x = self
                .a
                .table_extra_info(&t.database, t.schema.as_deref(), &t.object)
                .await?;
            if x.engine
                .as_deref()
                .is_none_or(|e| !e.eq_ignore_ascii_case("InnoDB"))
            {
                writable = false;
                warnings
                    .push("当前 MySQL 表不是 InnoDB，仅支持生成预览与导出，暂不批量写入。".into());
            }
        }
        if !m.foreign_keys.is_empty() {
            warnings.push(
                "此表有外键：请用固定值或候选值指定有效引用；当前不自动读取已有业务数据。".into(),
            );
        }
        let fields = m
            .columns
            .iter()
            .map(|c| GenerationField {
                name: c.name.clone(),
                raw_type: c.raw_type.clone(),
                kind: serde_json::to_value(&c.canonical).unwrap()["kind"]
                    .as_str()
                    .unwrap()
                    .into(),
                nullable: c.nullable,
                generated: generated.contains(&c.name)
                    || (c.auto_increment
                        && (self.a.engine() != Engine::Sqlite
                            || (m.primary_key.len() == 1
                                && !m
                                    .raw_ddl
                                    .as_deref()
                                    .unwrap_or("")
                                    .to_ascii_uppercase()
                                    .contains("WITHOUT ROWID")))),
                unique: m.primary_key.len() == 1 && m.primary_key.contains(&c.name)
                    || m.indexes
                        .iter()
                        .any(|i| i.unique && i.columns.len() == 1 && i.columns[0].name == c.name),
                default_value: c.default_value.clone(),
                comment: c.comment.clone(),
            })
            .collect::<Vec<_>>();
        let fingerprint = serde_json::to_string(&json!([
            m.columns,
            m.primary_key,
            m.indexes,
            m.foreign_keys,
            fields,
            writable
        ]))?;
        Ok(TargetDescription {
            engine: self.a.engine(),
            fields,
            fingerprint,
            warnings,
            write_supported: writable,
            meta: Some(m),
        })
    }
    fn validate_plan(&self, p: &Plan, d: &TargetDescription) -> AppResult<()> {
        for f in &p.fields {
            let c = d
                .fields
                .iter()
                .find(|c| c.name == f.name)
                .ok_or_else(|| invalid(format!("字段 {} 不存在", f.name)))?;
            if c.generated && f.kind != "omit" {
                return Err(invalid(format!(
                    "{} 由数据库生成，请使用默认值规则",
                    f.name
                )));
            }
            if !c.nullable && (f.kind == "null" || f.null_percent > 0) {
                return Err(invalid(format!("{} 不允许 NULL", f.name)));
            }
        }
        for c in &d.fields {
            if !c.generated
                && !c.nullable
                && c.default_value.is_none()
                && p.fields
                    .iter()
                    .find(|f| f.name == c.name)
                    .is_none_or(|f| f.kind == "omit")
            {
                return Err(invalid(format!("必填字段 {} 缺少生成规则", c.name)));
            }
        }
        Ok(())
    }
    fn validate_row(&self, row: &Value, d: &TargetDescription) -> AppResult<()> {
        for (k, v) in row.as_object().ok_or_else(|| invalid("数据必须为对象"))? {
            let c = d
                .meta
                .as_ref()
                .unwrap()
                .columns
                .iter()
                .find(|c| &c.name == k)
                .ok_or_else(|| invalid("未知字段"))?;
            sql_value(c, v).map_err(|e| invalid(format!("{k}：{e}")))?;
        }
        Ok(())
    }
    fn normalize(&self, mut row: Value) -> AppResult<Value> {
        for value in row
            .as_object_mut()
            .ok_or_else(|| invalid("数据必须为对象"))?
            .values_mut()
        {
            if let Some(n) = value.as_i64() {
                if n.unsigned_abs() > 9007199254740991 {
                    *value = json!(n.to_string());
                }
            } else if let Some(n) = value.as_u64() {
                if n > 9007199254740991 {
                    *value = json!(n.to_string());
                }
            }
        }
        Ok(row)
    }
    fn check_unique(
        &self,
        row: &Value,
        d: &TargetDescription,
        seen: &mut HashMap<String, HashSet<String>>,
    ) -> AppResult<()> {
        let m = d.meta.as_ref().unwrap();
        for idx in m.indexes.iter().filter(|i| i.unique && !i.primary) {
            let values = idx
                .columns
                .iter()
                .map(|c| row.get(&c.name).cloned().unwrap_or(Value::Null))
                .collect();
            unique_value(
                seen,
                format!(
                    "{}（字段：{}）",
                    idx.name,
                    idx.columns
                        .iter()
                        .map(|c| c.name.as_str())
                        .collect::<Vec<_>>()
                        .join("、")
                ),
                values,
            )?;
        }
        if !m.primary_key.is_empty() {
            unique_value(
                seen,
                "PRIMARY".into(),
                m.primary_key
                    .iter()
                    .map(|n| row.get(n).cloned().unwrap_or(Value::Null))
                    .collect(),
            )?;
        }
        Ok(())
    }
    fn batch_size(&self) -> usize {
        100
    }
    async fn write_batch(&self, rows: &[Value], d: &TargetDescription) -> AppResult<u64> {
        if !d.write_supported {
            return Err(invalid("当前目标仅支持预览与导出"));
        }
        let meta = d.meta.as_ref().unwrap();
        let types = meta
            .columns
            .iter()
            .map(|c| (c.name.clone(), c.raw_type.clone()))
            .collect();
        let mut sql = vec![];
        for row in rows {
            let mut values = vec![];
            for (k, v) in row.as_object().unwrap() {
                let c = meta
                    .columns
                    .iter()
                    .find(|c| &c.name == k)
                    .ok_or_else(|| invalid("字段结构变化"))?;
                values.push(CellValue {
                    column: k.clone(),
                    value: sql_value(c, v)?,
                });
            }
            if values.is_empty() {
                let schema =
                    self.t
                        .schema
                        .as_deref()
                        .unwrap_or(if self.a.engine() == Engine::Mysql {
                            &self.t.database
                        } else if self.a.engine() == Engine::Postgres {
                            "public"
                        } else {
                            "main"
                        });
                sql.push(SqlParams {
                    sql: format!(
                        "INSERT INTO {}.{} {}",
                        self.a.quote_ident(schema),
                        self.a.quote_ident(&self.t.object),
                        if self.a.engine() == Engine::Mysql {
                            "() VALUES ()"
                        } else {
                            "DEFAULT VALUES"
                        }
                    ),
                    params: vec![],
                });
            } else {
                sql.extend(build_change_statements(
                    self.a.as_ref(),
                    &self.t.database,
                    self.t.schema.as_deref(),
                    &self.t.object,
                    &[RowChange::Insert { values }],
                    &types,
                )?);
            }
        }
        self.a
            .execute_transaction(&self.t.database, &sql)
            .await
            .map_err(|e| match e {
                AppError::Database(s) => invalid(format!("本批次事务已拒绝：{s}")),
                other => other,
            })
    }
}
pub fn sql_value(c: &ColumnMeta, v: &Value) -> AppResult<DbValue> {
    if v.is_null() {
        return if c.nullable {
            Ok(DbValue::Null)
        } else {
            Err(invalid("不允许 NULL"))
        };
    }
    let text = v
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| v.to_string());
    Ok(match &c.canonical {
        C::Bool => DbValue::Bool(
            v.as_bool()
                .ok_or_else(|| invalid("需要布尔值 true/false"))?,
        ),
        C::Int { bits, unsigned } => {
            let n = text.parse::<i128>().map_err(|_| invalid("需要整数"))?;
            let b = (*bits).min(64);
            let (min, max) = if *unsigned {
                (0, (1i128 << b) - 1)
            } else {
                (-(1i128 << (b - 1)), (1i128 << (b - 1)) - 1)
            };
            if n < min || n > max {
                return Err(invalid("整数超出目标类型范围"));
            }
            if *unsigned {
                DbValue::UInt(n as u64)
            } else {
                DbValue::Int(n as i64)
            }
        }
        C::Decimal { precision, scale } => {
            let s = text.strip_prefix('-').unwrap_or(&text);
            let parts: Vec<_> = s.split('.').collect();
            if parts.len() > 2
                || parts[0].is_empty()
                || !parts.iter().all(|s| s.bytes().all(|b| b.is_ascii_digit()))
            {
                return Err(invalid("需要十进制数字"));
            }
            let whole = parts[0].trim_start_matches('0').len();
            let frac = parts.get(1).map_or(0, |s| s.len());
            if scale.is_some_and(|s| frac > s as usize)
                || precision.is_some_and(|p| {
                    whole + frac > p as usize
                        || scale.is_some_and(|s| whole > (p.saturating_sub(s)) as usize)
                })
            {
                return Err(invalid("小数超出精度/小数位限制"));
            }
            DbValue::Decimal(text)
        }
        C::Float { .. } => {
            let f = text.parse::<f64>().map_err(|_| invalid("需要数字"))?;
            if !f.is_finite() {
                return Err(invalid("需要有限数值"));
            }
            DbValue::Float(f)
        }
        C::String { len } => {
            let s = v.as_str().ok_or_else(|| invalid("需要文本值"))?;
            if len.is_some_and(|n| s.chars().count() > n as usize) {
                return Err(invalid("文本超过字段长度"));
            }
            DbValue::Text(s.into())
        }
        C::Enum { values } => {
            if !values.contains(&text) {
                return Err(invalid("枚举值无效"));
            }
            DbValue::Text(text)
        }
        C::Date => {
            chrono::NaiveDate::parse_from_str(&text, "%Y-%m-%d")
                .map_err(|_| invalid("日期应为 YYYY-MM-DD"))?;
            DbValue::Date(text)
        }
        C::Time { tz, .. } => {
            if *tz {
                chrono::DateTime::parse_from_rfc3339(&format!("1970-01-01T{text}"))
                    .map_err(|_| invalid("时间应包含时区，如 12:00:00+08:00"))?;
            } else {
                chrono::NaiveTime::parse_from_str(&text, "%H:%M:%S%.f")
                    .map_err(|_| invalid("时间应为 HH:mm:ss"))?;
            }
            DbValue::Time(text)
        }
        C::DateTime { tz, .. } => {
            // MySQL TIMESTAMP 的 tz 表示服务器存储语义，输入仍采用会话本地时间。
            if *tz
                && (c.raw_type.to_ascii_lowercase().contains("with time zone")
                    || c.raw_type.to_ascii_lowercase().contains("timestamptz"))
            {
                chrono::DateTime::parse_from_rfc3339(&text)
                    .map_err(|_| invalid("时间戳应包含时区，如 2026-01-01T00:00:00Z"))?;
            } else {
                chrono::NaiveDateTime::parse_from_str(
                    &text.replace('T', " "),
                    "%Y-%m-%d %H:%M:%S%.f",
                )
                .map_err(|_| invalid("日期时间应为 YYYY-MM-DD HH:mm:ss"))?;
            }
            DbValue::DateTime(text)
        }
        C::Json => {
            guard_json_numbers(v)?;
            DbValue::Json(v.to_string())
        }
        C::Uuid => {
            uuid::Uuid::parse_str(&text).map_err(|_| invalid("UUID 格式无效"))?;
            DbValue::Uuid(text)
        }
        C::Binary { .. } | C::Unknown { .. } => {
            return Err(invalid(
                "此类型暂不支持自动写入；可省略以使用默认值/NULL，或通过专用编辑器处理",
            ))
        }
    })
}

pub struct MongoGenerationAdapter {
    pub a: Arc<dyn DocumentAdapter>,
    pub t: Target,
}
#[async_trait]
impl DataGenerationAdapter for MongoGenerationAdapter {
    async fn describe(&self) -> AppResult<TargetDescription> {
        let v = self
            .a
            .inspect(&self.t.database, &self.t.object, "generationSchema", "")
            .await?;
        let mut fields = vec![field("_id", "objectId", false)];
        fields[0].default_value = Some("自动生成 ObjectId".into());
        let schema = &v["options"]["validator"]["$jsonSchema"];
        if let Some(properties) = schema["properties"].as_object() {
            for (k, v) in properties {
                if k == "_id" {
                    continue;
                }
                let required = schema["required"]
                    .as_array()
                    .is_some_and(|a| a.contains(&json!(k)));
                fields.push(field(
                    k,
                    v["bsonType"].as_str().unwrap_or("json"),
                    !required,
                ));
            }
        }
        Ok(TargetDescription{engine:Engine::Mongodb,fields,fingerprint:v.to_string(),warnings:vec!["仅读取集合验证规则与索引，不读取已有文档。可添加嵌套路径（例如 profile.name）；日期和大整数使用 Extended JSON。完整验证规则由 MongoDB 写入时校验。".into()],write_supported:true,meta:None})
    }
    fn validate_plan(&self, p: &Plan, d: &TargetDescription) -> AppResult<()> {
        let names: Vec<_> = p
            .fields
            .iter()
            .filter(|f| f.kind != "omit")
            .map(|f| f.name.as_str())
            .collect();
        for n in &names {
            if n.split('.')
                .any(|s| s.is_empty() || s.starts_with('$') || s.contains('\0'))
                || names
                    .iter()
                    .any(|other| other != n && other.starts_with(&format!("{n}.")))
            {
                return Err(invalid("MongoDB 字段路径非法或父子路径冲突"));
            }
        }
        for c in &d.fields {
            if !c.nullable
                && c.default_value.is_none()
                && !names.contains(&c.name.as_str())
                && !names.iter().any(|n| n.starts_with(&format!("{}.", c.name)))
            {
                return Err(invalid(format!("必填字段 {} 未配置", c.name)));
            }
        }
        Ok(())
    }
    fn validate_row(&self, row: &Value, _: &TargetDescription) -> AppResult<()> {
        self.normalize(row.clone())?;
        Ok(())
    }
    fn normalize(&self, row: Value) -> AppResult<Value> {
        let mut nested = json!({});
        for (k, v) in row.as_object().ok_or_else(|| invalid("文档必须为对象"))? {
            insert_path(&mut nested, &k.split('.').collect::<Vec<_>>(), v.clone())?;
        }
        let mut doc = parse_document(&nested.to_string())?;
        if !doc.contains_key("_id") {
            doc.insert("_id", mongodb::bson::oid::ObjectId::new());
        }
        Ok(mongodb::bson::Bson::Document(doc).into_canonical_extjson())
    }
    fn check_unique(
        &self,
        row: &Value,
        _: &TargetDescription,
        seen: &mut HashMap<String, HashSet<String>>,
    ) -> AppResult<()> {
        if let Some(id) = row.get("_id") {
            unique_value(seen, "_id".into(), vec![id.clone()])?;
        }
        Ok(())
    }
    fn batch_size(&self) -> usize {
        1
    }
    async fn write_batch(&self, rows: &[Value], _: &TargetDescription) -> AppResult<u64> {
        self.a
            .write(
                &self.t.database,
                &self.t.object,
                "insert",
                None,
                &rows[0].to_string(),
            )
            .await
            .map_err(|e| match e {
                AppError::Database(m) => invalid(m),
                e => e,
            })?;
        Ok(1)
    }
}
pub fn insert_path(root: &mut Value, path: &[&str], v: Value) -> AppResult<()> {
    let m = root
        .as_object_mut()
        .ok_or_else(|| invalid("嵌套路径冲突"))?;
    if path.len() == 1 {
        m.insert(path[0].into(), v);
    } else {
        insert_path(m.entry(path[0]).or_insert(json!({})), &path[1..], v)?;
    }
    Ok(())
}
pub struct RedisGenerationAdapter {
    pub a: Arc<dyn KeyValueAdapter>,
    pub t: Target,
    pub db: u32,
}
#[async_trait]
impl DataGenerationAdapter for RedisGenerationAdapter {
    async fn describe(&self) -> AppResult<TargetDescription> {
        Ok(TargetDescription {
            engine: Engine::Redis,
            fields: vec![
                field("key", "string", false),
                field(
                    "value",
                    if self.t.redis_kind.as_deref() == Some("hash") {
                        "json"
                    } else {
                        "string"
                    },
                    false,
                ),
            ],
            fingerprint: serde_json::to_string(&self.t)?,
            warnings: vec![
                "只创建新键，不覆盖已有键。每个键连同 TTL 原子提交，取消只停止后续键。".into(),
            ],
            write_supported: true,
            meta: None,
        })
    }
    fn validate_plan(&self, p: &Plan, _: &TargetDescription) -> AppResult<()> {
        if p.fields.len() != 2
            || ["key", "value"].iter().any(|n| {
                p.fields.iter().find(|f| &f.name == n).is_none_or(|f| {
                    matches!(f.kind.as_str(), "omit" | "null") || f.null_percent > 0
                })
            })
        {
            return Err(invalid("Redis 必须配置 key 和 value 两个非空字段"));
        }
        Ok(())
    }
    fn validate_row(&self, row: &Value, _: &TargetDescription) -> AppResult<()> {
        if row["key"]
            .as_str()
            .is_none_or(|s| s.is_empty() || s.len() > 1024)
        {
            return Err(invalid("Redis 键名应为 1–1024 字节文本"));
        }
        if self.t.redis_kind.as_deref() == Some("hash") {
            if row["value"].as_object().is_none_or(|m| {
                m.is_empty() || m.len() > 1000 || m.values().any(|v| !v.is_string())
            }) {
                return Err(invalid(
                    "Hash value 应为非空对象，字段值使用字符串，最多 1000 个字段",
                ));
            }
        } else if !row["value"].is_string() {
            return Err(invalid("String value 应为字符串"));
        }
        Ok(())
    }
    fn check_unique(
        &self,
        row: &Value,
        _: &TargetDescription,
        seen: &mut HashMap<String, HashSet<String>>,
    ) -> AppResult<()> {
        unique_value(seen, "key".into(), vec![row["key"].clone()])
    }
    fn batch_size(&self) -> usize {
        1
    }
    async fn write_batch(&self, rows: &[Value], _: &TargetDescription) -> AppResult<u64> {
        let r = &rows[0];
        let hash = self.t.redis_kind.as_deref() == Some("hash");
        let script = if hash {
            "if redis.call('EXISTS',KEYS[1])==1 then return 0 end; redis.call('HSET',KEYS[1],unpack(ARGV,2)); if tonumber(ARGV[1])>0 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return 1"
        } else {
            "if redis.call('EXISTS',KEYS[1])==1 then return 0 end; if tonumber(ARGV[1])>0 then redis.call('SET',KEYS[1],ARGV[2],'EX',ARGV[1]) else redis.call('SET',KEYS[1],ARGV[2]) end; return 1"
        };
        let mut args = vec![
            "EVAL".into(),
            script.into(),
            "1".into(),
            r["key"].as_str().unwrap().into(),
            self.t.ttl_seconds.unwrap_or(0).to_string(),
        ];
        if hash {
            for (k, v) in r["value"].as_object().unwrap() {
                args.push(k.clone());
                args.push(v.as_str().unwrap().into());
            }
        } else {
            args.push(r["value"].as_str().unwrap().into());
        }
        let result = self.a.command(self.db, &args).await?;
        if result == json!(0) {
            return Err(invalid("目标键已存在，未覆盖；本批次已停止"));
        }
        if result != json!(1) {
            return Err(AppError::WriteUncertain(
                "Redis 返回未识别结果，请核对数据".into(),
            ));
        }
        Ok(1)
    }
}

/// 文档引擎保留规则的数值/日期语义；大整数通过 EJSON 跨前端传输。
pub fn mongo_native_values(plan: &Plan, row: &mut Value) -> AppResult<()> {
    for f in &plan.fields {
        let Some(v) = row.get_mut(&f.name).filter(|v| !v.is_null()) else {
            continue;
        };
        let text = v.as_str().map(str::to_owned);
        match (f.kind.as_str(), text) {
            ("integer" | "sequence", Some(s)) => {
                s.parse::<i64>()
                    .map_err(|_| invalid("MongoDB 整数超出 BSON Int64 范围"))?;
                *v = json!({"$numberLong":s});
            }
            ("decimal", Some(s)) => {
                *v = json!({"$numberDecimal":s});
            }
            ("date", Some(s)) => {
                *v = json!({"$date":format!("{s}T00:00:00Z")});
            }
            ("compute", Some(s)) if f.args["op"] != "concat" => {
                s.parse::<i64>()
                    .map_err(|_| invalid("计算结果超出 BSON Int64 范围"))?;
                *v = json!({"$numberLong":s});
            }
            _ => {}
        }
    }
    Ok(())
}

fn guard_json_numbers(v: &Value) -> AppResult<()> {
    match v {
        Value::Number(n)
            if n.as_i64()
                .is_some_and(|n| n.unsigned_abs() > 9007199254740991)
                || n.as_u64().is_some_and(|n| n > 9007199254740991) =>
        {
            return Err(invalid("JSON 中的大整数请使用字符串，以保证预览精度"))
        }
        Value::Array(a) => {
            for v in a {
                guard_json_numbers(v)?;
            }
        }
        Value::Object(o) => {
            for v in o.values() {
                guard_json_numbers(v)?;
            }
        }
        _ => {}
    }
    Ok(())
}
