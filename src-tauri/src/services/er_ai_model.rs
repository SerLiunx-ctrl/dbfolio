//! AI 只提供候选；采用前仍以服务器结构为准，不生成或执行 DDL。
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Field {
    pub name: String,
    pub raw_type: String,
    pub kind: String,
    pub nullable: bool,
    pub comment: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SchemaTable {
    pub key: String,
    pub name: String,
    pub schema: Option<String>,
    pub comment: String,
    pub columns: Vec<Field>,
    pub unique_keys: Vec<Vec<String>>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Link {
    pub from: String,
    pub to: String,
    pub columns: Vec<String>,
    pub ref_columns: Vec<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Candidate {
    pub name: String,
    pub from: String,
    pub to: String,
    pub columns: Vec<String>,
    pub ref_columns: Vec<String>,
    pub confidence: String,
    pub reason: String,
    #[serde(default)]
    pub warnings: Vec<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Checked {
    pub candidates: Vec<Candidate>,
    pub rejected: usize,
    pub duplicates: usize,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Output {
    pub relations: Vec<serde_json::Value>,
}
pub fn fingerprint(tables: &[SchemaTable], links: &[Link]) -> String {
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&(tables, links)).unwrap())
    )
}
// 保留字段配对，统一反向关联和复合列的排列；不能分别排序两端字段。
pub fn signature(link: &Link) -> String {
    fn ordered(from: &str, to: &str, a: &[String], b: &[String]) -> String {
        let mut pairs: Vec<_> = a.iter().zip(b).collect();
        pairs.sort();
        serde_json::to_string(&(from, to, pairs)).unwrap()
    }
    let a = ordered(&link.from, &link.to, &link.columns, &link.ref_columns);
    a.min(ordered(
        &link.to,
        &link.from,
        &link.ref_columns,
        &link.columns,
    ))
}
impl Candidate {
    pub fn link(&self) -> Link {
        Link {
            from: self.from.clone(),
            to: self.to.clone(),
            columns: self.columns.clone(),
            ref_columns: self.ref_columns.clone(),
        }
    }
}
pub fn check(
    values: Vec<serde_json::Value>,
    tables: &[SchemaTable],
    existing: &[Link],
    opaque: bool,
) -> Result<Checked, String> {
    if values.len() > 100 {
        return Err("候选超过 100 条，请缩小范围后重试".into());
    }
    let mut seen: HashSet<_> = existing.iter().map(signature).collect();
    let mut result = Checked {
        candidates: vec![],
        rejected: 0,
        duplicates: 0,
    };
    for value in values {
        let Ok(mut c) = serde_json::from_value::<Candidate>(value) else {
            result.rejected += 1;
            continue;
        };
        if opaque {
            for endpoint in [&mut c.from, &mut c.to] {
                if let Some(t) = endpoint
                    .strip_prefix('t')
                    .and_then(|i| i.parse::<usize>().ok())
                    .and_then(|i| tables.get(i))
                {
                    *endpoint = t.key.clone();
                } else {
                    endpoint.clear();
                }
            }
        }
        let a = tables.iter().find(|t| t.key == c.from);
        let b = tables.iter().find(|t| t.key == c.to);
        let valid = c.name.chars().count() <= 60
            && !c.name.trim().is_empty()
            && !c.reason.trim().is_empty()
            && c.reason.chars().count() <= 1000
            && ["high", "medium", "low"].contains(&c.confidence.as_str())
            && !c.columns.is_empty()
            && c.columns.len() <= 32
            && c.columns.len() == c.ref_columns.len()
            && HashSet::<_>::from_iter(&c.columns).len() == c.columns.len()
            && HashSet::<_>::from_iter(&c.ref_columns).len() == c.ref_columns.len();
        let (Some(a), Some(b)) = (a, b) else {
            result.rejected += 1;
            continue;
        };
        if !valid
            || c.columns
                .iter()
                .any(|n| !a.columns.iter().any(|f| &f.name == n))
            || c.ref_columns
                .iter()
                .any(|n| !b.columns.iter().any(|f| &f.name == n))
            || (c.from == c.to && c.columns == c.ref_columns)
        {
            result.rejected += 1;
            continue;
        }
        if !seen.insert(signature(&c.link())) {
            result.duplicates += 1;
            continue;
        }
        c.warnings.clear();
        if !b
            .unique_keys
            .iter()
            .any(|k| k.len() == c.ref_columns.len() && k.iter().all(|n| c.ref_columns.contains(n)))
        {
            c.warnings
                .push("目标字段不是已识别的完整主键或唯一键，仅建议作为业务关联".into());
        }
        if c.columns.iter().zip(&c.ref_columns).any(|(x, y)| {
            a.columns.iter().find(|f| &f.name == x).unwrap().kind
                != b.columns.iter().find(|f| &f.name == y).unwrap().kind
        }) {
            c.warnings
                .push("两端字段类型类别不同，请人工核对业务含义".into());
        }
        c.warnings
            .push("未检查数据值、基数与引用完整性，不代表可直接建立外键".into());
        result.candidates.push(c);
    }
    Ok(result)
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn tables() -> Vec<SchemaTable> {
        (0..2)
            .map(|i| SchemaTable {
                key: format!("table{i}"),
                name: format!("same{i}"),
                schema: Some(format!("schema{i}")),
                comment: "中文注释，不执行".into(),
                columns: ["tenant", "id", "user_id"]
                    .iter()
                    .map(|n| Field {
                        name: n.to_string(),
                        raw_type: "bigint".into(),
                        kind: "int".into(),
                        nullable: true,
                        comment: "".into(),
                    })
                    .collect(),
                unique_keys: vec![vec!["tenant".into(), "id".into()]],
            })
            .collect()
    }
    fn candidate() -> serde_json::Value {
        json!({"name":"关联","from":"t1","to":"t0","columns":["tenant","user_id"],"refColumns":["tenant","id"],"confidence":"medium","reason":"同一租户的用户引用"})
    }
    #[test]
    fn validates_real_columns_and_preserves_composite_pairs() {
        let ts = tables();
        let valid = check(vec![candidate()], &ts, &[], true).unwrap();
        assert_eq!(valid.candidates.len(), 1);
        let link = valid.candidates[0].link();
        assert_eq!(link.from, "table1");
        let mut reverse = link.clone();
        std::mem::swap(&mut reverse.from, &mut reverse.to);
        std::mem::swap(&mut reverse.columns, &mut reverse.ref_columns);
        reverse.columns.reverse();
        reverse.ref_columns.reverse();
        assert_eq!(signature(&link), signature(&reverse));
        reverse.ref_columns.reverse();
        assert_ne!(signature(&link), signature(&reverse));
        assert_eq!(
            check(vec![candidate(), candidate()], &ts, &[link], true)
                .unwrap()
                .duplicates,
            2
        );
        let mut invalid = vec![];
        for (field, value) in [
            ("from", json!("t9")),
            ("columns", json!(["missing", "id"])),
            ("refColumns", json!(["id"])),
            ("confidence", json!("certain")),
            ("columns", json!(["id", "id"])),
            ("reason", json!("")),
            ("sql", json!("DROP TABLE x")),
        ] {
            let mut c = candidate();
            c[field] = value;
            invalid.push(c);
        }
        assert_eq!(check(invalid, &ts, &[], true).unwrap().rejected, 7);
        let mut self_ref = candidate();
        self_ref["from"] = json!("t0");
        assert_eq!(
            check(vec![self_ref.clone()], &ts, &[], true)
                .unwrap()
                .candidates
                .len(),
            1
        );
        self_ref["columns"] = self_ref["refColumns"].clone();
        assert_eq!(check(vec![self_ref], &ts, &[], true).unwrap().rejected, 1);
    }
    #[test]
    fn warnings_fingerprint_and_strict_response() {
        let mut ts = tables();
        let before = fingerprint(&ts, &[]);
        ts[0].columns[0].raw_type = "text".into();
        ts[0].columns[0].kind = "string".into();
        assert_ne!(before, fingerprint(&ts, &[]));
        ts[0].unique_keys.clear();
        let checked = check(vec![candidate()], &ts, &[], true).unwrap();
        assert_eq!(checked.candidates[0].warnings.len(), 3);
        assert!(check(vec![candidate(); 101], &ts, &[], true).is_err());
        assert!(
            serde_json::from_value::<Output>(json!({"relations":[],"sql":"select 1"})).is_err()
        );
        assert!(check(vec![], &ts, &[], true).unwrap().candidates.is_empty());
    }
}
