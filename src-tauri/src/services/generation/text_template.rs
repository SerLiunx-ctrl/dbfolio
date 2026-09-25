use super::{invalid, rules::Generator};
use crate::error::AppResult;
use std::collections::HashMap;

#[derive(Clone, Debug)]
pub enum Part {
    Literal(String),
    Parameter(String),
    Number(usize),
    Uuid(bool),
    SeededUuid,
    RunId,
    Timestamp(bool),
    Date(&'static str),
    Random(&'static [u8], usize),
    Integer(i64, i64),
}
const HEX: &[u8] = b"0123456789abcdef";
const ALNUM: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
fn width(s: &str, max: usize) -> AppResult<usize> {
    s.parse::<usize>()
        .ok()
        .filter(|n| (1..=max).contains(n))
        .ok_or_else(|| invalid(format!("模板长度应为 1–{max} 的整数")))
}
fn token(s: &str) -> AppResult<Option<Part>> {
    let args: Vec<_> = s.split(':').collect();
    let part = match args.as_slice() {
        ["n"] => Part::Number(0),
        ["n", n] => Part::Number(width(n, 20)?),
        ["uuid"] => Part::Uuid(false),
        ["uuid32"] => Part::Uuid(true),
        ["seeded_uuid"] => Part::SeededUuid,
        ["run_id"] => Part::RunId,
        ["timestamp"] => Part::Timestamp(false),
        ["timestamp_ms"] => Part::Timestamp(true),
        ["date"] => Part::Date("%Y-%m-%d"),
        ["date", format] => Part::Date(match *format {
            "yyyyMMdd" => "%Y%m%d",
            "yyyy-MM-dd" => "%Y-%m-%d",
            "HHmmss" => "%H%M%S",
            "yyyyMMddHHmmss" => "%Y%m%d%H%M%S",
            _ => {
                return Err(invalid(
                    "日期模板支持 yyyyMMdd、yyyy-MM-dd、HHmmss、yyyyMMddHHmmss（UTC）",
                ))
            }
        }),
        ["hex", n] => Part::Random(HEX, width(n, 128)?),
        ["alnum", n] => Part::Random(ALNUM, width(n, 128)?),
        ["int", min, max] => {
            let min = min
                .parse::<i64>()
                .map_err(|_| invalid("随机整数下限必须是 64 位整数"))?;
            let max = max
                .parse::<i64>()
                .map_err(|_| invalid("随机整数上限必须是 64 位整数"))?;
            if min > max {
                return Err(invalid("随机整数下限不能大于上限"));
            }
            Part::Integer(min, max)
        }
        ["n" | "uuid" | "uuid32" | "seeded_uuid" | "run_id" | "timestamp" | "timestamp_ms"
        | "date" | "hex" | "alnum" | "int", ..] => {
            return Err(invalid(format!("模板变量 {{{s}}} 的参数格式不正确")))
        }
        _ => return Ok(None),
    };
    Ok(Some(part))
}
pub fn parse(pattern: &str) -> AppResult<Vec<Part>> {
    let mut rest = pattern;
    let mut literal = String::new();
    let mut parts = Vec::new();
    while !rest.is_empty() {
        let parsed = if let Some(tail) = rest.strip_prefix("${") {
            let end = tail
                .find('}')
                .ok_or_else(|| invalid("模板参数引用缺少 }"))?;
            Some((Part::Parameter(tail[..end].into()), end + 3))
        } else if let Some(tail) = rest.strip_prefix('{') {
            if let Some(end) = tail.find(['{', '}']) {
                if tail.as_bytes()[end] == b'}' {
                    token(&tail[..end])?.map(|part| (part, end + 2))
                } else {
                    None
                }
            } else {
                let name = tail.split(':').next().unwrap_or("");
                if matches!(
                    name,
                    "n" | "uuid"
                        | "uuid32"
                        | "seeded_uuid"
                        | "run_id"
                        | "timestamp"
                        | "timestamp_ms"
                        | "date"
                        | "hex"
                        | "alnum"
                        | "int"
                ) {
                    return Err(invalid("模板变量缺少 }"));
                }
                None
            }
        } else {
            None
        };
        if let Some((part, len)) = parsed {
            if !literal.is_empty() {
                parts.push(Part::Literal(std::mem::take(&mut literal)));
            }
            parts.push(part);
            rest = &rest[len..];
        } else {
            let ch = rest.chars().next().unwrap();
            literal.push(ch);
            rest = &rest[ch.len_utf8()..];
        }
    }
    if !literal.is_empty() {
        parts.push(Part::Literal(literal));
    }
    Ok(parts)
}
pub fn render(
    pattern: &str,
    n: u32,
    parameters: &HashMap<String, String>,
    generator: &mut Generator,
    cache: &mut HashMap<String, String>,
) -> AppResult<String> {
    let mut out = String::new();
    for part in parse(pattern)? {
        let value = match part {
            Part::Literal(value) => value,
            Part::Parameter(name) => parameters
                .get(&name)
                .cloned()
                .ok_or_else(|| invalid(format!("模板参数 {name} 未设置")))?,
            Part::Number(width) => format!("{:0width$}", u64::from(n) + 1),
            Part::Uuid(compact) => {
                let value = cache
                    .entry("uuid".into())
                    .or_insert_with(|| uuid::Uuid::new_v4().to_string());
                if compact {
                    value.replace('-', "")
                } else {
                    value.clone()
                }
            }
            Part::SeededUuid => {
                if let Some(value) = cache.get("seeded_uuid") {
                    value.clone()
                } else {
                    let value = generator.seeded_uuid();
                    cache.insert("seeded_uuid".into(), value.clone());
                    value
                }
            }
            Part::RunId => generator.run_id.clone(),
            Part::Timestamp(ms) => if ms {
                generator.started_at.timestamp_millis()
            } else {
                generator.started_at.timestamp()
            }
            .to_string(),
            Part::Date(format) => generator.started_at.format(format).to_string(),
            Part::Random(alphabet, length) => (0..length)
                .map(|_| alphabet[(generator.next() % alphabet.len() as u64) as usize] as char)
                .collect(),
            Part::Integer(min, max) => (min as i128
                + (generator.next() as u128 % (max as i128 - min as i128 + 1) as u128) as i128)
                .to_string(),
        };
        if out.len() + value.len() > 1024 * 1024 {
            return Err(invalid("文本展开超过 1 MiB"));
        }
        out.push_str(&value);
    }
    Ok(out)
}
