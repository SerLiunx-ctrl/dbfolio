use super::{invalid, FieldRule};
use crate::error::AppResult;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};

pub fn catalog() -> Value {
    json!({
     "omit":{},"null":{},"constant":{"value":"任意 JSON 值"},"sequence":{"start":"1","step":"1"},
     "integer":{"min":"1","max":"100"},"decimal":{"min":"0","max":"100","scale":2},
     "boolean":{},"choice":{"values":["A","B"]},"text":{"pattern":"样本-{n:6}-{uuid}","help":"支持 ${参数}、{n}、{n:6}、{uuid}、{uuid32}、{seeded_uuid}、{run_id}、{timestamp}、{timestamp_ms}、{date:yyyyMMdd}、{hex:8}、{alnum:12}、{int:1:100}；日期为 UTC"},
     "uuid":{},"random_uuid":{},"objectId":{},"date":{"start":"2026-01-01","end":"2026-12-31"},
     "name":{},"email":{},"company":{},"ai":{"prompt":"生成要求"},
     "compute":{"op":"concat","fields":["first","last"],"separator":" "}
    })
}
fn number(args: &Value, key: &str, default: &str) -> AppResult<i128> {
    let v = args.get(key).cloned().unwrap_or(json!(default));
    v.as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| v.to_string())
        .parse()
        .map_err(|_| invalid(format!("{key} 必须是整数（大整数请使用字符串）")))
}
fn range(f: &FieldRule) -> AppResult<(i128, i128)> {
    let a = number(&f.args, "min", "1")?;
    let b = number(&f.args, "max", "100")?;
    if a > b || a < i64::MIN as i128 || b > u64::MAX as i128 {
        return Err(invalid("整数范围无效"));
    }
    Ok((a, b))
}
pub fn validate_rule(f: &FieldRule) -> AppResult<()> {
    if !f.args.is_object() || !catalog().as_object().unwrap().contains_key(&f.kind) {
        return Err(invalid(format!("字段 {} 的规则不受支持", f.name)));
    }
    if matches!(f.kind.as_str(), "ai" | "compute" | "omit") && f.null_percent != 0 {
        return Err(invalid("AI、计算、默认值规则不支持随机空值比例"));
    }
    match f.kind.as_str() {
        "constant" if !f.args.as_object().unwrap().contains_key("value") => {
            return Err(invalid("固定值需要 value"))
        }
        "sequence" => {
            number(&f.args, "start", "1")?;
            number(&f.args, "step", "1")?;
        }
        "integer" => {
            range(f)?;
        }
        "decimal" => {
            decimal_bounds(&f.args)?;
        }
        "choice" => {
            let a = f.args["values"]
                .as_array()
                .ok_or_else(|| invalid("候选值必须是数组"))?;
            if a.is_empty() || a.len() > 10000 {
                return Err(invalid("候选值数量应为 1–10000"));
            }
        }
        "text" => {
            if f.args["pattern"].as_str().is_none() {
                return Err(invalid("文本规则需要 pattern"));
            }
            super::text_template::parse(f.args["pattern"].as_str().unwrap())?;
        }
        "date" => {
            dates(&f.args)?;
        }
        "compute" => {
            if !matches!(f.args["op"].as_str(), Some("concat" | "add" | "multiply")) {
                return Err(invalid("计算仅支持 concat/add/multiply，不执行脚本"));
            }
            if f.args["fields"].as_array().is_none_or(|a| {
                a.is_empty() || a.len() > 200 || a.iter().any(|v| v.as_str().is_none())
            }) {
                return Err(invalid("计算规则需要 fields 数组"));
            }
        }
        _ => {}
    }
    Ok(())
}
fn dates(a: &Value) -> AppResult<(chrono::NaiveDate, chrono::NaiveDate)> {
    let parse = |k: &str| {
        chrono::NaiveDate::parse_from_str(a[k].as_str().unwrap_or(""), "%Y-%m-%d")
            .map_err(|_| invalid("日期范围格式为 YYYY-MM-DD"))
    };
    let x = parse("start")?;
    let y = parse("end")?;
    if x > y {
        return Err(invalid("开始日期不能晚于结束日期"));
    }
    Ok((x, y))
}
// 定点整数运算，避免金额通过浮点数丢失精度。
pub fn scaled(s: &str, scale: u32) -> AppResult<i128> {
    let negative = s.starts_with('-');
    let s = s.strip_prefix('-').unwrap_or(s);
    let mut p = s.split('.');
    let whole = p.next().unwrap_or("");
    let fraction = p.next().unwrap_or("");
    if p.next().is_some()
        || whole.is_empty()
        || !whole.bytes().all(|c| c.is_ascii_digit())
        || !fraction.bytes().all(|c| c.is_ascii_digit())
        || fraction.len() > scale as usize
        || scale > 12
    {
        return Err(invalid("小数格式或精度无效（最多 12 位小数）"));
    }
    let w = whole.parse::<i128>().map_err(|_| invalid("数值过大"))?;
    let f = format!("{fraction:0<width$}", width = scale as usize)
        .parse::<i128>()
        .unwrap_or(0);
    let v = w
        .checked_mul(10i128.pow(scale))
        .and_then(|v| v.checked_add(f))
        .ok_or_else(|| invalid("数值过大"))?;
    Ok(if negative { -v } else { v })
}
fn decimal_bounds(a: &Value) -> AppResult<(i128, i128, u32)> {
    let s = a["scale"].as_u64().unwrap_or(2);
    if s > 12 {
        return Err(invalid("小数位应为 0–12"));
    }
    let get = |key: &str, default: &str| {
        let v = a.get(key).cloned().unwrap_or(json!(default));
        scaled(
            &v.as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| v.to_string()),
            s as u32,
        )
    };
    let x = get("min", "0")?;
    let y = get("max", "100")?;
    if x > y || y.checked_sub(x).is_none_or(|d| d > u64::MAX as i128) {
        return Err(invalid("小数取值范围过大或顺序错误"));
    }
    Ok((x, y, s as u32))
}
fn decimal_text(v: i128, s: u32) -> String {
    if s == 0 {
        return v.to_string();
    }
    let sign = if v < 0 { "-" } else { "" };
    let v = v.unsigned_abs();
    let base = 10u128.pow(s);
    format!(
        "{sign}{}.{:0width$}",
        v / base,
        v % base,
        width = s as usize
    )
}
pub fn ordered_fields(fields: &[FieldRule]) -> AppResult<Vec<&FieldRule>> {
    let names: HashMap<_, _> = fields.iter().map(|f| (f.name.as_str(), f)).collect();
    let mut visiting = HashSet::new();
    let mut done = HashSet::new();
    let mut out = vec![];
    fn visit<'a>(
        f: &'a FieldRule,
        names: &HashMap<&str, &'a FieldRule>,
        visiting: &mut HashSet<String>,
        done: &mut HashSet<String>,
        out: &mut Vec<&'a FieldRule>,
    ) -> AppResult<()> {
        if done.contains(&f.name) {
            return Ok(());
        }
        if !visiting.insert(f.name.clone()) {
            return Err(invalid("计算字段存在循环引用"));
        }
        if f.kind == "compute" {
            for dep in f.args["fields"]
                .as_array()
                .ok_or_else(|| invalid("缺少依赖字段"))?
            {
                let other = names
                    .get(dep.as_str().unwrap_or(""))
                    .ok_or_else(|| invalid("计算引用了不存在的字段"))?;
                if other.kind == "omit" {
                    return Err(invalid("不能引用数据库自动生成的字段"));
                }
                visit(other, names, visiting, done, out)?;
            }
        }
        visiting.remove(&f.name);
        done.insert(f.name.clone());
        out.push(f);
        Ok(())
    }
    for f in fields {
        visit(f, &names, &mut visiting, &mut done, &mut out)?;
    }
    Ok(out)
}
pub struct Generator {
    state: u64,
    pub(super) run_id: String,
    pub(super) started_at: chrono::DateTime<chrono::Utc>,
}
impl Generator {
    pub fn new(seed: &str) -> Self {
        let mut h = 14695981039346656037u64;
        for b in seed.bytes() {
            h = (h ^ b as u64).wrapping_mul(1099511628211);
        }
        Self {
            state: h,
            run_id: uuid::Uuid::new_v4().simple().to_string(),
            started_at: chrono::Utc::now(),
        }
    }
    pub(super) fn next(&mut self) -> u64 {
        self.state = self.state.wrapping_add(0x9e3779b97f4a7c15);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d049bb133111eb);
        z ^ (z >> 31)
    }
    pub(super) fn seeded_uuid(&mut self) -> String {
        let mut b = [0u8; 16];
        b[..8].copy_from_slice(&self.next().to_be_bytes());
        b[8..].copy_from_slice(&self.next().to_be_bytes());
        b[6] = (b[6] & 15) | 64;
        b[8] = (b[8] & 63) | 128;
        uuid::Uuid::from_bytes(b).to_string()
    }
    pub fn row(
        &mut self,
        fields: &[&FieldRule],
        n: u32,
        parameters: &HashMap<String, String>,
        _: bool,
    ) -> AppResult<Value> {
        let mut row = Map::new();
        let mut template_values = HashMap::new();
        for f in fields {
            if matches!(f.kind.as_str(), "omit" | "ai" | "compute") {
                continue;
            }
            let value = if f.null_percent > 0 && self.next() % 100 < (f.null_percent as u64) {
                Value::Null
            } else {
                match f.kind.as_str() {
                    "null" => Value::Null,
                    "constant" => f.args["value"].clone(),
                    "sequence" => {
                        let start = number(&f.args, "start", "1")?;
                        let step = number(&f.args, "step", "1")?;
                        json!(step
                            .checked_mul(n as i128)
                            .and_then(|x| start.checked_add(x))
                            .ok_or_else(|| invalid("序列溢出"))?
                            .to_string())
                    }
                    "integer" => {
                        let (a, b) = range(f)?;
                        json!(
                            (a + (self.next() as u128 % ((b - a) as u128 + 1)) as i128).to_string()
                        )
                    }
                    "decimal" => {
                        let (a, b, s) = decimal_bounds(&f.args)?;
                        json!(decimal_text(
                            a + (self.next() as u128 % ((b - a) as u128 + 1)) as i128,
                            s
                        ))
                    }
                    "boolean" => json!(self.next() % 2 == 0),
                    "choice" => {
                        let a = f.args["values"].as_array().unwrap();
                        a[self.next() as usize % a.len()].clone()
                    }
                    "text" => {
                        json!(super::text_template::render(
                            f.args["pattern"].as_str().unwrap(),
                            n,
                            parameters,
                            self,
                            &mut template_values
                        )?)
                    }
                    "uuid" => json!(self.seeded_uuid()),
                    "random_uuid" => json!(uuid::Uuid::new_v4().to_string()),
                    "objectId" => {
                        json!({"$oid":format!("{:016x}{:08x}",self.next(),self.next()as u32)})
                    }
                    "date" => {
                        let (a, b) = dates(&f.args)?;
                        json!((a + chrono::Duration::days(
                            (self.next() % ((b - a).num_days() as u64 + 1)) as i64
                        ))
                        .to_string())
                    }
                    "name" => {
                        let a = ["陈", "林", "王", "李", "赵", "周"];
                        let b = ["明", "晓雨", "晨", "思远", "嘉宁", "清禾"];
                        json!(format!(
                            "{}{}",
                            a[self.next() as usize % a.len()],
                            b[self.next() as usize % b.len()]
                        ))
                    }
                    "email" => json!(format!(
                        "sample{}-{:x}@example.invalid",
                        n + 1,
                        self.next() % 65536
                    )),
                    "company" => {
                        let a = ["星河", "远山", "青禾", "云帆", "知行"];
                        json!(format!(
                            "{}测试科技有限公司",
                            a[self.next() as usize % a.len()]
                        ))
                    }
                    _ => return Err(invalid("未知规则")),
                }
            };
            row.insert(f.name.clone(), value);
        }
        Ok(Value::Object(row))
    }
}
pub fn finish_computed(
    fields: &[&FieldRule],
    row: &mut Value,
    _: &HashMap<String, String>,
) -> AppResult<()> {
    for f in fields.iter().filter(|f| f.kind == "compute") {
        let values: Vec<&Value> = f.args["fields"]
            .as_array()
            .unwrap()
            .iter()
            .map(|name| {
                row.get(name.as_str().unwrap())
                    .ok_or_else(|| invalid("计算依赖字段尚未生成"))
            })
            .collect::<AppResult<_>>()?;
        let v = if f.args["op"] == "concat" {
            let sep = f.args["separator"].as_str().unwrap_or("");
            let mut text = String::new();
            for (i, value) in values.iter().enumerate() {
                let value = value
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| value.to_string());
                if text.len() + value.len() + sep.len() > 1024 * 1024 {
                    return Err(invalid("计算结果超过 1 MiB"));
                }
                if i > 0 {
                    text.push_str(sep);
                }
                text.push_str(&value);
            }
            json!(text)
        } else {
            let mut acc = if f.args["op"] == "multiply" { 1i128 } else { 0 };
            for v in values {
                let n = v
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| v.to_string())
                    .parse::<i128>()
                    .map_err(|_| invalid("add/multiply 仅支持整数；金额请使用定点规则"))?;
                acc = if f.args["op"] == "multiply" {
                    acc.checked_mul(n)
                } else {
                    acc.checked_add(n)
                }
                .ok_or_else(|| invalid("计算结果溢出"))?;
            }
            json!(acc.to_string())
        };
        row.as_object_mut().unwrap().insert(f.name.clone(), v);
    }
    Ok(())
}

#[cfg(test)]
pub fn expand_text(
    pattern: &str,
    n: u32,
    parameters: &HashMap<String, String>,
) -> AppResult<String> {
    super::text_template::render(
        pattern,
        n,
        parameters,
        &mut Generator::new("test"),
        &mut HashMap::new(),
    )
}
