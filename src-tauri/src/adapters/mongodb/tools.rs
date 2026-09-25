use super::*;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferRequest {
    pub database: String,
    pub collection: String,
    pub path: String,
    pub direction: String,
    pub format: String,
    pub filter: String,
}

// An allowlist also prevents output stages hidden inside a nested pipeline.
pub fn pipeline(text: &str) -> AppResult<Vec<Document>> {
    let value: Value = serde_json::from_str(text)
        .map_err(|_| AppError::InvalidInput("聚合管道必须是 JSON 数组".into()))?;
    let array = value
        .as_array()
        .ok_or_else(|| AppError::InvalidInput("聚合管道必须是数组".into()))?;
    if array.len() > 100 {
        return Err(AppError::InvalidInput("最多 100 个聚合阶段".into()));
    }
    let mut stages = Vec::new();
    for value in array {
        let d = parse_document(&value.to_string())?;
        let name = d.keys().next().map(String::as_str).unwrap_or("");
        if d.len() != 1
            || !matches!(
                name,
                "$match"
                    | "$project"
                    | "$group"
                    | "$sort"
                    | "$limit"
                    | "$skip"
                    | "$unwind"
                    | "$addFields"
                    | "$set"
                    | "$unset"
                    | "$replaceRoot"
                    | "$replaceWith"
                    | "$count"
                    | "$sortByCount"
                    | "$bucket"
                    | "$bucketAuto"
                    | "$sample"
                    | "$lookup"
                    | "$facet"
                    | "$unionWith"
            )
        {
            return Err(AppError::InvalidInput(format!(
                "此只读管道不支持阶段 {name}"
            )));
        }
        reject_scripts(&Bson::Document(d.clone()))?;
        if name == "$facet" {
            let facets = value
                .get(name)
                .and_then(Value::as_object)
                .ok_or_else(|| AppError::InvalidInput("$facet 必须为对象".into()))?;
            for nested in facets.values() {
                pipeline(&nested.to_string())?;
            }
        }
        if matches!(name, "$lookup" | "$unionWith") {
            if let Some(nested) = value.get(name).and_then(|v| v.get("pipeline")) {
                pipeline(&nested.to_string())?;
            }
        }
        stages.push(d);
    }
    Ok(stages)
}

impl MongoAdapter {
    pub(super) async fn inspect_collection(
        &self,
        database: &str,
        collection: &str,
        operation: &str,
        text: &str,
    ) -> AppResult<Value> {
        let db = self.client.database(database);
        let c = db.collection::<Document>(collection);
        match operation {
            "generationSchema" => {
                let mut cursor=db.list_collections().filter(doc!{"name":collection}).await.map_err(mongo_error)?;
                let spec=cursor.try_next().await.map_err(mongo_error)?.ok_or_else(||AppError::InvalidInput("目标集合不存在，请先创建集合".into()))?;
                let indexes=c.list_indexes().await.map_err(mongo_error)?.try_collect::<Vec<_>>().await.map_err(mongo_error)?;
                Ok(json!({"options":spec.options,"indexes":indexes}))
            },
            "stats" => {
                let d = db
                    .run_command(doc! {"collStats":collection,"scale":1})
                    .await
                    .map_err(mongo_error)?;
                let mut result = Document::new();
                for key in [
                    "ns",
                    "count",
                    "size",
                    "avgObjSize",
                    "storageSize",
                    "totalIndexSize",
                    "nindexes",
                    "capped",
                ] {
                    if let Some(v) = d.get(key) {
                        result.insert(key, v.clone());
                    }
                }
                Ok(Bson::Document(result).into_relaxed_extjson())
            }
            "indexes" => {
                let mut cursor = c.list_indexes().await.map_err(mongo_error)?;
                let mut rows = Vec::new();
                while let Some(index) = cursor.try_next().await.map_err(mongo_error)? {
                    crate::tasks::checkpoint()?;
                    rows.push(serde_json::to_value(index)?);
                }
                Ok(json!({"indexes":rows}))
            }
            "sample" => {
                let mut cursor = c
                    .find(doc! {})
                    .limit(100)
                    .batch_size(25)
                    .max_time(Duration::from_secs(20))
                    .await
                    .map_err(mongo_error)?;
                let mut fields: std::collections::BTreeMap<
                    String,
                    std::collections::BTreeMap<String, u32>,
                > = Default::default();
                let mut count = 0;
                while let Some(d) = cursor.try_next().await.map_err(mongo_error)? {
                    crate::tasks::checkpoint()?;
                    count += 1;
                    for (name, value) in d {
                        *fields
                            .entry(name)
                            .or_default()
                            .entry(format!("{:?}", value.element_type()))
                            .or_default() += 1;
                    }
                }
                Ok(
                    json!({"sampled":count,"fields":fields,"note":"自然顺序前 100 条顶层字段抽样，不代表完整结构；未出现次数 = 抽样数 - 各类型次数之和"}),
                )
            }
            "aggregate" => {
                let mut stages = pipeline(text)?;
                stages.push(doc! {"$limit":501});
                let mut cursor = c
                    .aggregate(stages)
                    .batch_size(25)
                    .max_time(Duration::from_secs(20))
                    .allow_disk_use(false)
                    .await
                    .map_err(mongo_error)?;
                let mut rows = Vec::new();
                let mut bytes = 0;
                let mut limited = false;
                while let Some(d) = cursor.try_next().await.map_err(mongo_error)? {
                    crate::tasks::checkpoint()?;
                    let value = canonical(d);
                    bytes += value.len();
                    if rows.len() >= 500 || bytes > 8 * 1024 * 1024 {
                        limited = true;
                        break;
                    }
                    rows.push(serde_json::from_str::<Value>(&value)?);
                }
                Ok(
                    json!({"rows":rows,"limited":limited,"note":"只读聚合，最多 500 条 / 8 MiB；不支持 $out、$merge 或服务端 JavaScript"}),
                )
            }
            _ => Err(AppError::InvalidInput("未知集合工具".into())),
        }
    }
    pub(super) async fn add_index(
        &self,
        database: &str,
        collection: &str,
        text: &str,
    ) -> AppResult<Value> {
        let spec = parse_document(text)?;
        let keys = spec
            .get_document("keys")
            .map_err(|_| AppError::InvalidInput("请输入 keys 索引键对象".into()))?
            .clone();
        if keys.is_empty() {
            return Err(AppError::InvalidInput("索引键不能为空".into()));
        }
        let options = match spec.get("options") {
            None => Document::new(),
            Some(Bson::Document(d)) => d.clone(),
            _ => return Err(AppError::InvalidInput("options 必须为对象".into())),
        };
        for key in options.keys() {
            if !matches!(
                key.as_str(),
                "name"
                    | "unique"
                    | "sparse"
                    | "expireAfterSeconds"
                    | "partialFilterExpression"
                    | "collation"
                    | "hidden"
                    | "weights"
                    | "default_language"
                    | "language_override"
                    | "wildcardProjection"
            ) {
                return Err(AppError::InvalidInput(format!("不支持的索引选项：{key}")));
            }
        }
        let options: mongodb::options::IndexOptions = bson::from_document(options)
            .map_err(|_| AppError::InvalidInput("索引选项无效".into()))?;
        let model = mongodb::IndexModel::builder()
            .keys(keys)
            .options(options)
            .build();
        let result = self
            .client
            .database(database)
            .collection::<Document>(collection)
            .create_index(model)
            .await
            .map_err(write_error)?;
        Ok(json!({"index":result.index_name}))
    }

    pub(super) async fn transfer_file(&self, r: TransferRequest) -> AppResult<Value> {
        if !matches!(r.format.as_str(), "json" | "jsonl") {
            return Err(AppError::InvalidInput("格式仅支持 json / jsonl".into()));
        }
        let c = self
            .client
            .database(&r.database)
            .collection::<Document>(&r.collection);
        let path = std::path::Path::new(&r.path);
        if r.direction == "export" {
            let filter = parse_document(&r.filter)?;
            reject_scripts(&Bson::Document(filter.clone()))?;
            let mut cursor = c
                .find(filter)
                .batch_size(50)
                .max_time(Duration::from_secs(60))
                .await
                .map_err(mongo_error)?;
            let parent = path
                .parent()
                .ok_or_else(|| AppError::InvalidInput("请选择导出文件".into()))?;
            let mut file = tempfile::NamedTempFile::new_in(parent)?;
            if r.format == "json" {
                file.write_all(b"[\n")?;
            }
            let mut count = 0u64;
            loop {
                crate::tasks::checkpoint()?;
                let next = tokio::time::timeout(Duration::from_secs(30), cursor.try_next())
                    .await
                    .map_err(|_| AppError::Message("导出读取超时，目标文件未替换".into()))?
                    .map_err(mongo_error)?;
                let Some(d) = next else {
                    break;
                };
                if count > 0 && r.format == "json" {
                    file.write_all(b",\n")?;
                }
                file.write_all(canonical(d).as_bytes())?;
                if r.format == "jsonl" {
                    file.write_all(b"\n")?;
                }
                count += 1;
                crate::tasks::progress(count, None, "正在导出文档；完成后替换目标文件");
            }
            if r.format == "json" {
                file.write_all(b"\n]\n")?;
            }
            file.flush()?;
            file.as_file().sync_all()?;
            crate::tasks::checkpoint()?;
            file.persist(path)
                .map_err(|e| AppError::Message(format!("保存导出文件失败：{}", e.error)))?;
            return Ok(json!({"rows":count,"path":r.path}));
        }
        if r.direction != "import" {
            return Err(AppError::InvalidInput("未知传输方向".into()));
        }
        let file = std::fs::File::open(path)?;
        // JSON arrays are bounded in memory; JSON Lines streams one bounded document at a time.
        let mut reader = BufReader::new(file);
        let mut array = if r.format == "json" {
            let mut text = String::new();
            reader
                .by_ref()
                .take(64 * 1024 * 1024 + 1)
                .read_to_string(&mut text)?;
            if text.len() > 64 * 1024 * 1024 {
                return Err(AppError::InvalidInput(
                    "JSON 数组文件上限 64 MiB，大文件请使用 JSON Lines".into(),
                ));
            }
            let values: Vec<Value> = serde_json::from_str(text.trim_start_matches('\u{feff}'))
                .map_err(|_| AppError::InvalidInput("JSON 文件必须为文档数组".into()))?;
            Some(values.into_iter())
        } else {
            None
        };
        let report_path = path.with_file_name(format!(
            "{}.{}.errors.jsonl",
            path.file_name().unwrap_or_default().to_string_lossy(),
            uuid::Uuid::new_v4().simple()
        ));
        let mut report = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&report_path)?;
        let mut inserted = 0u64;
        let mut failed = 0u64;
        let mut line = 0u64;
        let mut details = Vec::new();
        loop {
            crate::tasks::progress(
                inserted,
                None,
                format!(
                    "已写入 {inserted}，失败 {failed}；失败记录：{}",
                    report_path.display()
                ),
            );
            crate::tasks::checkpoint()?;
            let text = if let Some(values) = array.as_mut() {
                match values.next() {
                    Some(v) => v.to_string(),
                    None => break,
                }
            } else {
                let mut bytes = Vec::new();
                reader
                    .by_ref()
                    .take(48 * 1024 * 1024 + 1)
                    .read_until(b'\n', &mut bytes)?;
                if bytes.is_empty() {
                    break;
                }
                if bytes.len() > 48 * 1024 * 1024 {
                    return Err(AppError::InvalidInput(format!(
                        "第 {} 行过大；此前已提交 {inserted} 条",
                        line + 1
                    )));
                }
                String::from_utf8(bytes).map_err(|_| {
                    AppError::InvalidInput(format!(
                        "第 {} 行不是 UTF-8；此前已提交 {inserted} 条",
                        line + 1
                    ))
                })?
            };
            line += 1;
            let text = if line == 1 {
                text.trim_start_matches('\u{feff}')
            } else {
                &text
            };
            if text.trim().is_empty() {
                continue;
            }
            let result = match parse_document(text) {
                Ok(d) => tokio::time::timeout(
                    Duration::from_secs(30),
                    c.insert_one(id_first(d)).into_future(),
                )
                .await
                .map_err(|_| {
                    AppError::WriteUncertain(format!(
                        "第 {line} 条写入超时，结果待确认；已确认写入 {inserted} 条"
                    ))
                })
                .and_then(|r| r.map(|_| ()).map_err(write_error)),
                Err(e) => Err(e),
            };
            match result {
                Ok(()) => inserted += 1,
                Err(e) => {
                    failed += 1;
                    let entry = json!({"record":line,"error":e.to_string(),"code":e.code()});
                    writeln!(report, "{entry}")?;
                    report.flush()?;
                    if details.len() < 100 {
                        details.push(entry);
                    }
                    crate::tasks::progress(
                        inserted,
                        None,
                        format!(
                            "已写入 {inserted}，失败 {failed}；失败记录：{}",
                            report_path.display()
                        ),
                    );
                    if matches!(e, AppError::WriteUncertain(_) | AppError::Connection(_)) {
                        return Err(e);
                    }
                }
            }
        }
        report.flush()?;
        drop(report);
        if failed == 0 {
            std::fs::remove_file(&report_path)?;
        }
        Ok(
            json!({"inserted":inserted,"skipped":failed,"errors":details,"report":if failed>0{Some(report_path.to_string_lossy())}else{None},"error":if failed>0{Some(format!("{failed} 条失败，已成功写入的文档保留"))}else{None}}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn readonly_pipeline_validation() {
        assert!(pipeline(
            r#"[{"$match":{"active":true}},{"$group":{"_id":"$kind","count":{"$sum":1}}}]"#
        )
        .is_ok());
        for text in [
            r#"[{"$out":"x"}]"#,
            r#"[{"$facet":{"x":[{"$merge":"x"}]}}]"#,
            r#"[{"$lookup":{"from":"x","pipeline":[{"$out":"y"}],"as":"x"}}]"#,
            r#"[{"$project":{"x":{"$function":{}}}}]"#,
        ] {
            assert!(pipeline(text).is_err());
        }
    }
}
