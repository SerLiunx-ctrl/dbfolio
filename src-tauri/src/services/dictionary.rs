//! 数据字典导出：仅使用已采集结构和本地说明，不读取业务数据。
use crate::{
    error::{AppError, AppResult},
    meta::{Engine, TableMeta},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    io::Write,
    path::Path,
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Entry {
    pub meta: TableMeta,
    pub group: String,
    pub note: String,
    pub column_notes: BTreeMap<String, String>,
    #[serde(default)]
    pub definition: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Document {
    pub version: u32,
    pub engine: Engine,
    pub database: String,
    pub server_version: String,
    pub collected_at: String,
    pub entries: Vec<Entry>,
}
fn invalid(s: &str) -> AppError {
    AppError::InvalidInput(s.into())
}
fn validate(d: &Document) -> AppResult<()> {
    if d.version != 1
        || !d.engine.is_sql()
        || d.database.is_empty()
        || d.entries.is_empty()
        || d.entries.len() > 300
        || serde_json::to_vec(d)?.len() > 20 * 1024 * 1024
    {
        return Err(invalid("字典范围或大小无效"));
    }
    let mut seen = HashSet::new();
    let mut count = 0;
    for e in &d.entries {
        count += e.meta.columns.len();
        if !seen.insert((&e.meta.schema, &e.meta.name))
            || e.group.chars().count() > 100
            || e.column_notes
                .keys()
                .any(|k| !e.meta.columns.iter().any(|c| &c.name == k))
        {
            return Err(invalid("字典对象重复或本地说明字段无效"));
        }
    }
    if count > 30000 {
        return Err(invalid("字典字段过多，请缩小范围"));
    }
    Ok(())
}
fn html(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}
fn md(s: &str) -> String {
    html(s)
        .replace('\\', "\\\\")
        .replace('|', "\\|")
        .replace('*', "\\*")
        .replace('_', "\\_")
        .replace('[', "\\[")
        .replace(']', "\\]")
        .replace('#', "\\#")
        .replace('`', "\\`")
        .replace('\r', "")
        .replace('\n', "<br>")
}
fn opt(v: &Option<String>) -> String {
    v.clone().unwrap_or_default()
}
fn full(e: &Entry) -> String {
    format!(
        "{}{}",
        e.meta
            .schema
            .as_ref()
            .map(|s| format!("{s}."))
            .unwrap_or_default(),
        e.meta.name
    )
}
fn sections(e: &Entry) -> Vec<(&'static str, Vec<&'static str>, Vec<Vec<String>>)> {
    let columns = e
        .meta
        .columns
        .iter()
        .map(|c| {
            vec![
                c.ordinal.to_string(),
                c.name.clone(),
                c.raw_type.clone(),
                if c.nullable { "是" } else { "否" }.into(),
                opt(&c.default_value),
                if e.meta.primary_key.contains(&c.name) {
                    "主键"
                } else {
                    ""
                }
                .into(),
                if c.auto_increment { "是" } else { "否" }.into(),
                if c.unsigned { "是" } else { "否" }.into(),
                opt(&c.charset),
                opt(&c.collation),
                opt(&c.comment),
                e.column_notes.get(&c.name).cloned().unwrap_or_default(),
            ]
        })
        .collect();
    let indexes = e
        .meta
        .indexes
        .iter()
        .map(|i| {
            vec![
                i.name.clone(),
                if i.primary {
                    "主键"
                } else if i.unique {
                    "唯一"
                } else {
                    "普通"
                }
                .into(),
                i.columns
                    .iter()
                    .map(|c| {
                        format!(
                            "{}{}{}",
                            c.name,
                            c.prefix_len.map(|n| format!("({n})")).unwrap_or_default(),
                            if c.desc { " DESC" } else { "" }
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(", "),
                opt(&i.method),
                opt(&i.comment),
                opt(&i.definition),
            ]
        })
        .collect();
    let foreign = e
        .meta
        .foreign_keys
        .iter()
        .map(|f| {
            vec![
                f.name.clone(),
                f.columns.join(", "),
                format!(
                    "{}{}{}",
                    f.ref_database
                        .as_ref()
                        .map(|s| format!("{s}."))
                        .unwrap_or_default(),
                    f.ref_schema
                        .as_ref()
                        .map(|s| format!("{s}."))
                        .unwrap_or_default(),
                    f.ref_table
                ),
                f.ref_columns
                    .iter()
                    .map(|c| {
                        if c.is_empty() {
                            "隐式主键"
                        } else {
                            c.as_str()
                        }
                    })
                    .collect::<Vec<_>>()
                    .join(", "),
                f.on_delete.clone(),
                f.on_update.clone(),
            ]
        })
        .collect();
    vec![
        (
            "字段",
            vec![
                "序号",
                "名称",
                "类型",
                "可空",
                "默认值",
                "键",
                "自动增长",
                "无符号",
                "字符集",
                "排序规则",
                "数据库注释",
                "本地说明",
            ],
            columns,
        ),
        (
            "索引",
            vec!["名称", "类型", "列", "方法", "注释", "定义"],
            indexes,
        ),
        (
            "外键",
            vec!["名称", "列", "引用对象", "引用列", "删除规则", "更新规则"],
            foreign,
        ),
    ]
}
pub fn markdown(d: &Document) -> String {
    let mut out=format!("# 数据字典：{}\n\n引擎：{} · 服务器版本：{} · 采集时间：{}\n\n共 {} 个对象。分组与本地说明不修改数据库。\n\n",md(&d.database),d.engine.as_str(),md(&d.server_version),md(&d.collected_at),d.entries.len());
    for e in &d.entries {
        out += &format!(
            "## {}\n\n类型：{} · 分组：{}\n\n数据库注释：{}\n\n本地说明：{}\n\n",
            md(&full(e)),
            if e.meta.kind == crate::meta::TableKind::View {
                "视图"
            } else {
                "表"
            },
            md(&e.group),
            md(&opt(&e.meta.comment)),
            md(&e.note)
        );
        for (title, heads, rows) in sections(e) {
            out += &format!("### {title}\n\n");
            if rows.is_empty() {
                out += "无。\n\n";
                continue;
            }
            out += &format!(
                "| {} |\n| {} |\n",
                heads.join(" | "),
                vec!["---"; heads.len()].join(" | ")
            );
            for row in rows {
                out += &format!(
                    "| {} |\n",
                    row.iter().map(|s| md(s)).collect::<Vec<_>>().join(" | ")
                );
            }
            out += "\n";
        }
        out += "### 对象定义\n\n";
        if let Some(ddl) = e.definition.as_ref().or(e.meta.raw_ddl.as_ref()) {
            for line in ddl.split('\n') {
                out += "    ";
                out += line;
                out += "\n";
            }
        } else {
            out += "当前适配器未提供对象定义。\n";
        }
        out += "\n";
    }
    out
}
pub fn html_document(d: &Document) -> String {
    let mut out=format!("<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>数据字典：{}</title><style>body{{font:14px/1.6 system-ui,'Microsoft YaHei',sans-serif;margin:24px;color:#1e293b}}table{{border-collapse:collapse;width:100%;font-size:12px}}td,th{{border:1px solid #cbd5e1;padding:5px 8px;white-space:pre-wrap;overflow-wrap:anywhere;text-align:left}}th{{background:#edf2f7}}pre{{white-space:pre-wrap;overflow-wrap:anywhere;background:#f1f5f9;padding:12px}}section{{margin-block:28px}}.text{{white-space:pre-wrap}}nav a{{margin-right:16px}}@media print{{section{{break-before:page}}}}</style></head><body><h1>数据字典：{}</h1><p>引擎：{} · 服务器版本：{} · 采集时间：{} · {} 个对象</p><p>分组与本地说明不修改数据库。</p><nav>",html(&d.database),html(&d.database),d.engine.as_str(),html(&d.server_version),html(&d.collected_at),d.entries.len());
    for (i, e) in d.entries.iter().enumerate() {
        out += &format!("<a href=\"#object-{i}\">{}</a>", html(&full(e)));
    }
    out += "</nav>";
    for (i, e) in d.entries.iter().enumerate() {
        out+=&format!("<section id=\"object-{i}\"><h2>{}</h2><p>类型：{} · 分组：{}</p><p class=\"text\">数据库注释：{}</p><p class=\"text\">本地说明：{}</p>",html(&full(e)),if e.meta.kind==crate::meta::TableKind::View{"视图"}else{"表"},html(&e.group),html(&opt(&e.meta.comment)),html(&e.note));
        for (title, heads, rows) in sections(e) {
            out += &format!("<h3>{title}</h3>");
            if rows.is_empty() {
                out += "<p>无。</p>";
                continue;
            }
            out += "<table><thead><tr>";
            for h in heads {
                out += &format!("<th>{}</th>", html(h));
            }
            out += "</tr></thead><tbody>";
            for row in rows {
                out += "<tr>";
                for cell in row {
                    out += &format!("<td>{}</td>", html(&cell));
                }
                out += "</tr>";
            }
            out += "</tbody></table>";
        }
        out += &format!(
            "<h3>对象定义</h3><pre>{}</pre></section>",
            html(
                e.definition
                    .as_deref()
                    .or(e.meta.raw_ddl.as_deref())
                    .unwrap_or("当前适配器未提供对象定义。")
            )
        );
    }
    out += "</body></html>";
    out
}
// Excel cells are plain strings (never formulas); split long UTF-16 values without truncation.
fn chunks(s: &str) -> Vec<String> {
    let mut result = vec![];
    let mut current = String::new();
    let mut count = 0;
    for c in s.chars() {
        if count + c.len_utf16() > 32000 {
            result.push(std::mem::take(&mut current));
            count = 0;
        }
        current.push(c);
        count += c.len_utf16();
    }
    result.push(current);
    result
}
fn excel(d: &Document) -> AppResult<Vec<u8>> {
    use rust_xlsxwriter::{Format, Workbook};
    let mut workbook = Workbook::new();
    let headings = Format::new().set_bold().set_background_color("#E8EFF5");
    let text = Format::new().set_text_wrap();
    let mut sheets: Vec<(&str, Vec<String>, Vec<Vec<String>>)> = vec![
        (
            "对象总览",
            vec!["对象", "类型", "业务分组", "数据库注释", "本地说明"]
                .into_iter()
                .map(String::from)
                .collect(),
            vec![],
        ),
        ("字段", vec![], vec![]),
        ("索引", vec![], vec![]),
        ("外键", vec![], vec![]),
        ("对象定义", vec!["对象".into(), "定义".into()], vec![]),
    ];
    for e in &d.entries {
        sheets[0].2.push(vec![
            full(e),
            if e.meta.kind == crate::meta::TableKind::View {
                "视图"
            } else {
                "表"
            }
            .into(),
            e.group.clone(),
            opt(&e.meta.comment),
            e.note.clone(),
        ]);
        for (i, (_, heads, rows)) in sections(e).into_iter().enumerate() {
            sheets[i + 1].1 = std::iter::once("对象".into())
                .chain(heads.into_iter().map(String::from))
                .collect();
            for row in rows {
                sheets[i + 1]
                    .2
                    .push(std::iter::once(full(e)).chain(row).collect());
            }
        }
        sheets[4].2.push(vec![
            full(e),
            e.definition
                .clone()
                .or(e.meta.raw_ddl.clone())
                .unwrap_or_else(|| "当前适配器未提供对象定义。".into()),
        ]);
    }
    for (name, heads, rows) in sheets {
        let sheet = workbook.add_worksheet();
        sheet.set_name(name).map_err(|e| invalid(&e.to_string()))?;
        sheet
            .set_freeze_panes(1, 1)
            .map_err(|e| invalid(&e.to_string()))?;
        sheet
            .set_column_range_width(0, heads.len() as u16, 24.0)
            .map_err(|e| invalid(&e.to_string()))?;
        for (i, h) in heads
            .iter()
            .chain(std::iter::once(&"续行".to_string()))
            .enumerate()
        {
            sheet
                .write_string_with_format(0, i as u16, h, &headings)
                .map_err(|e| invalid(&e.to_string()))?;
        }
        let mut index = 1u32;
        for row in rows {
            let parts: Vec<_> = row.iter().map(|s| chunks(s)).collect();
            let lines = parts.iter().map(Vec::len).max().unwrap_or(1);
            for line in 0..lines {
                for (i, part) in parts.iter().enumerate() {
                    let value = if part.len() == 1 {
                        &part[0]
                    } else {
                        part.get(line).map(String::as_str).unwrap_or("")
                    };
                    sheet
                        .write_string_with_format(index, i as u16, value, &text)
                        .map_err(|e| invalid(&e.to_string()))?;
                }
                sheet
                    .write_string(index, heads.len() as u16, format!("{}/{}", line + 1, lines))
                    .map_err(|e| invalid(&e.to_string()))?;
                index += 1;
            }
        }
    }
    workbook
        .save_to_buffer()
        .map_err(|e| invalid(&e.to_string()))
}
pub fn validate_path(path: &str, format: &str) -> AppResult<()> {
    let path = Path::new(path);
    if !path.is_absolute()
        || !matches!(format, "md" | "html" | "xlsx")
        || path
            .extension()
            .and_then(|v| v.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
            != format
    {
        return Err(invalid(
            "请选择与导出格式一致的 Markdown、HTML 或 Excel 绝对路径",
        ));
    }
    Ok(())
}
pub fn render(d: &Document, format: &str) -> AppResult<Vec<u8>> {
    validate(d)?;
    let bytes = match format {
        "md" => markdown(d).into_bytes(),
        "html" => html_document(d).into_bytes(),
        "xlsx" => excel(d)?,
        _ => return Err(invalid("字典格式无效")),
    };
    if bytes.len() > 64 * 1024 * 1024 {
        return Err(invalid("导出文件超过 64 MiB，请缩小范围"));
    }
    Ok(bytes)
}
pub fn write(path: &str, bytes: &[u8], format: &str) -> AppResult<usize> {
    validate_path(path, format)?;
    if bytes.len() > 64 * 1024 * 1024 {
        return Err(invalid("导出文件超过 64 MiB，请缩小范围"));
    }
    let path = Path::new(path);
    let parent = path.parent().ok_or_else(|| invalid("导出路径无效"))?;
    let mut temp =
        tempfile::NamedTempFile::new_in(parent).map_err(|e| AppError::Message(e.to_string()))?;
    temp.write_all(bytes)
        .and_then(|_| temp.as_file().sync_all())
        .map_err(|e| AppError::Message(e.to_string()))?;
    temp.persist(path)
        .map_err(|e| AppError::Message(format!("导出失败，原文件未修改：{e}")))?;
    Ok(bytes.len())
}
#[cfg(test)]
fn export(path: &str, d: &Document, format: &str) -> AppResult<usize> {
    validate_path(path, format)?;
    write(path, &render(d, format)?, format)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn document(engine: Engine) -> Document {
        let meta:TableMeta=serde_json::from_value(serde_json::json!({"name":"表<&_中文","schema":"业务","kind":"table","columns":[{"name":"列|<&","ordinal":1,"rawType":"varchar(255)","canonical":{"kind":"string","len":255},"nullable":false,"defaultValue":"=1+2","autoIncrement":false,"unsigned":false,"charset":"utf8mb4","collation":"utf8mb4_bin","comment":"<script>window.pwn=1</script>\n中文 | ` ![x](https://bad.example)"}],"primaryKey":["列|<&"],"indexes":[{"name":"复合索引","columns":[{"name":"列|<&","desc":true,"prefixLen":10}],"unique":true,"primary":false,"method":"btree","comment":"索引注释"}],"foreignKeys":[{"name":"fk","columns":["列|<&","二"],"refDatabase":"库","refSchema":"schema","refTable":"父表","refColumns":["id","二"],"onDelete":"CASCADE","onUpdate":"NO ACTION"}],"comment":"表注释","rowEstimate":null,"rawDdl":"CREATE TABLE \"<img src=x onerror=alert(1)>\" ();\n-- ```"})).unwrap();
        Document {
            version: 1,
            engine,
            database: "库<>&".into(),
            server_version: "测试1".into(),
            collected_at: "2026-11-01T00:00:00Z".into(),
            entries: vec![Entry {
                meta,
                group: "业务分组".into(),
                note: "本地说明".into(),
                column_notes: BTreeMap::from([(
                    "列|<&".into(),
                    "=HYPERLINK(\"https://bad.example\")".into(),
                )]),
                definition: None,
            }],
        }
    }
    #[test]
    fn safe_exports_preserve_metadata_and_atomic_files() {
        let directory = tempfile::tempdir().unwrap();
        for engine in [Engine::Mysql, Engine::Postgres, Engine::Sqlite] {
            let d = document(engine);
            validate(&d).unwrap();
            let markdown = markdown(&d);
            assert!(markdown.contains("列\\|&lt;&amp;"));
            assert!(!markdown.contains("<script>"));
            assert!(markdown.contains("=1+2"));
            assert!(markdown.contains("CASCADE"));
            assert!(markdown.contains("=HYPERLINK"));
            let html = html_document(&d);
            assert!(!html.contains("<script>"));
            assert!(!html.contains("<img"));
            assert!(html.contains("&lt;script&gt;"));
            assert!(html.contains("default-src 'none'"));
            assert!(html.contains("复合索引"));
            for format in ["md", "html", "xlsx"] {
                let path = directory
                    .path()
                    .join(format!("中文_{}.{}", engine.as_str(), format));
                let bytes = export(path.to_str().unwrap(), &d, format).unwrap();
                assert!(bytes > 0);
                assert_eq!(std::fs::metadata(&path).unwrap().len(), bytes as u64);
            }
        }
        let mut d = document(Engine::Mysql);
        let path = directory.path().join("保留.md");
        std::fs::write(&path, "旧内容").unwrap();
        d.entries.push(d.entries[0].clone());
        assert!(export(path.to_str().unwrap(), &d, "md").is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "旧内容");
        assert!(export("relative.md", &document(Engine::Mysql), "md").is_err());
        assert!(export(
            directory.path().join("bad.exe").to_str().unwrap(),
            &document(Engine::Mysql),
            "md"
        )
        .is_err());
    }
    #[test]
    fn long_excel_values_are_complete_plain_strings() {
        use std::io::{Cursor, Read};
        let mut d = document(Engine::Sqlite);
        let original = "中文🦀\n".repeat(13000);
        d.entries[0].note = original.clone();
        let split = chunks(&original);
        assert!(split.len() > 1);
        assert_eq!(split.concat(), original);
        assert!(split.iter().all(|s| s.encode_utf16().count() <= 32000));
        let bytes = excel(&d).unwrap();
        let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        let mut strings = String::new();
        zip.by_name("xl/sharedStrings.xml")
            .unwrap()
            .read_to_string(&mut strings)
            .unwrap();
        assert!(strings.contains("=HYPERLINK"));
        assert!(strings.contains("=1+2"));
        // Shared strings deduplicate identical continuation chunks; resolve worksheet indices.
        let shared: Vec<_> = strings
            .split("<si>")
            .skip(1)
            .map(|v| {
                v.split_once("</t>")
                    .unwrap()
                    .0
                    .split_once('>')
                    .unwrap()
                    .1
                    .to_string()
            })
            .collect();
        let mut overview = String::new();
        zip.by_name("xl/worksheets/sheet1.xml")
            .unwrap()
            .read_to_string(&mut overview)
            .unwrap();
        let restored: String = overview
            .split("<c ")
            .skip(1)
            .filter(|v| v.starts_with("r=\"E") && !v.starts_with("r=\"E1\""))
            .map(|v| {
                let i: usize = v
                    .split_once("<v>")
                    .unwrap()
                    .1
                    .split_once("</v>")
                    .unwrap()
                    .0
                    .parse()
                    .unwrap();
                shared[i].clone()
            })
            .collect();
        assert_eq!(restored, original);
        for i in 1..=5 {
            let mut xml = String::new();
            zip.by_name(&format!("xl/worksheets/sheet{i}.xml"))
                .unwrap()
                .read_to_string(&mut xml)
                .unwrap();
            assert!(!xml.contains("<f>"));
        }
    }
}
