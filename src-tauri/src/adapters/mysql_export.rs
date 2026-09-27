use super::*;
use crate::services::sql_export::{SqlExportRequest, SqlExportResult};
use futures_util::TryStreamExt;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

fn ident(s: &str) -> String {
    format!("`{}`", s.replace('`', "``"))
}
// Export expressions return executable literals, without JS/f64 conversion or preview truncation.
fn expression(name: &str, kind: &str) -> String {
    let c = ident(name);
    let k = kind.to_ascii_lowercase();
    let body = if [
        "tinyint",
        "smallint",
        "mediumint",
        "int",
        "bigint",
        "decimal",
        "numeric",
        "float",
        "double",
        "real",
        "year",
    ]
    .contains(&k.as_str())
    {
        format!("CAST({c} AS CHAR)")
    } else if [
        "binary",
        "varbinary",
        "tinyblob",
        "blob",
        "mediumblob",
        "longblob",
        "bit",
    ]
    .contains(&k.as_str())
    {
        format!("CONCAT('X',CHAR(39),HEX({c}),CHAR(39))")
    } else if [
        "geometry",
        "point",
        "linestring",
        "polygon",
        "multipoint",
        "multilinestring",
        "multipolygon",
        "geometrycollection",
    ]
    .contains(&k.as_str())
    {
        format!(
            "CONCAT('ST_GeomFromWKB(X',CHAR(39),HEX(ST_AsWKB({c})),CHAR(39),',',ST_SRID({c}),')')"
        )
    } else {
        format!("CONCAT('CONVERT(X',CHAR(39),HEX(CONVERT({c} USING utf8mb4)),CHAR(39),' USING utf8mb4)')")
    };
    format!("IF({c} IS NULL,'NULL',{body})")
}
fn header(database: &str, mode: &str, include: bool, sql_mode: &str) -> String {
    let mut s=format!("-- DBFolio · MySQL SQL export\n-- 内容：{mode}；对象范围见导出选项。字符串内的动态 SQL 与外部库引用保持原样。\nSET @DW_OLD_SQL_MODE=@@SQL_MODE;\nSET SQL_MODE='{sql_mode}';\nSET @DW_OLD_FK=@@FOREIGN_KEY_CHECKS;\nSET FOREIGN_KEY_CHECKS=0;\nSET @DW_OLD_TIME_ZONE=@@TIME_ZONE;\nSET TIME_ZONE='+00:00';\nSET @DW_OLD_CLIENT=@@CHARACTER_SET_CLIENT;\nSET @DW_OLD_RESULTS=@@CHARACTER_SET_RESULTS;\nSET @DW_OLD_CONNECTION=@@COLLATION_CONNECTION;\nSET NAMES utf8mb4;\n");
    if include {
        s.push_str(&format!(
            "CREATE DATABASE IF NOT EXISTS {};\nUSE {};\n",
            ident(database),
            ident(database)
        ));
    }
    s
}
const FOOTER:&str="\nSET FOREIGN_KEY_CHECKS=@DW_OLD_FK;\nSET TIME_ZONE=@DW_OLD_TIME_ZONE;\nSET CHARACTER_SET_CLIENT=@DW_OLD_CLIENT;\nSET CHARACTER_SET_RESULTS=@DW_OLD_RESULTS;\nSET COLLATION_CONNECTION=@DW_OLD_CONNECTION;\nSET SQL_MODE=@DW_OLD_SQL_MODE;\n-- 导出完成\n";
struct Output {
    writer: BufWriter<std::fs::File>,
    file: tempfile::NamedTempFile,
    bytes: u64,
}
impl Output {
    fn new(parent: &Path) -> AppResult<Self> {
        let file = tempfile::NamedTempFile::new_in(parent)?;
        let writer = BufWriter::new(file.reopen()?);
        Ok(Self {
            file,
            writer,
            bytes: 0,
        })
    }
    fn write(&mut self, text: &str) -> AppResult<()> {
        self.writer.write_all(text.as_bytes())?;
        self.bytes += text.len() as u64;
        Ok(())
    }
    fn finish(mut self, path: &Path) -> AppResult<u64> {
        self.writer.flush()?;
        self.writer.get_ref().sync_all()?;
        drop(self.writer);
        crate::tasks::checkpoint()?;
        self.file
            .persist(path)
            .map_err(|e| AppError::Internal(format!("完成文件写入失败：{}", e.error)))?;
        Ok(self.bytes)
    }
}
struct Batch {
    prefix: String,
    values: Vec<String>,
    bytes: usize,
    rows: usize,
    max_bytes: usize,
}
impl Batch {
    fn new(prefix: String, rows: usize, max_bytes: usize) -> Self {
        Self {
            prefix,
            values: vec![],
            bytes: 0,
            rows,
            max_bytes,
        }
    }
    fn push(&mut self, row: String, out: &mut Output) -> AppResult<()> {
        if row.len() > 64 * 1024 * 1024 {
            return Err(AppError::InvalidInput(
                "单行导出 SQL 超过 64 MiB，请缩小大字段后重试".into(),
            ));
        }
        if !self.values.is_empty()
            && (self.values.len() >= self.rows
                || self.bytes + row.len() + self.prefix.len() + 4 > self.max_bytes)
        {
            self.flush(out)?;
        }
        self.bytes += row.len() + 2;
        self.values.push(row);
        Ok(())
    }
    fn flush(&mut self, out: &mut Output) -> AppResult<()> {
        if self.values.is_empty() {
            return Ok(());
        }
        out.write(&self.prefix)?;
        out.write(&self.values.join(",\n"))?;
        out.write(";\n")?;
        self.values.clear();
        self.bytes = 0;
        Ok(())
    }
}
fn ddl_signature(ddl: &str) -> String {
    let mut s = ddl.to_string();
    if let Some(start) = s.rfind(" AUTO_INCREMENT=") {
        let at = start + 16;
        let end = at + s[at..].bytes().take_while(u8::is_ascii_digit).count();
        s.replace_range(start..end, "");
    }
    s
}
async fn ddl(conn: &mut sqlx::MySqlConnection, db: &str, table: &str) -> AppResult<String> {
    let query=format!("SHOW CREATE TABLE {}.{}", ident(db), ident(table));
    let row=conn.fetch_one(query.as_str()).await?;
    if let Ok(value)=row.try_get::<String,_>(1){return Ok(value);}
    String::from_utf8(row.try_get::<Vec<u8>,_>(1)?).map_err(|_|AppError::InvalidInput("建表定义不是有效 UTF-8".into()))
}

pub(super) async fn export(
    adapter: &MySqlAdapter,
    req: &SqlExportRequest,
) -> AppResult<SqlExportResult> {
    req.validate()?;
    crate::services::database_access::check(adapter.params.allowed_databases.as_deref(),&req.database)?;
    // A dedicated owned connection is closed on cancellation/error, never returned with an open snapshot.
    let pool = connect_pool(&adapter.params, Some(&req.database)).await?;
    let mut conn = pool.acquire().await?.detach();
    conn.execute("SET SESSION time_zone='+00:00'").await?;
    let sql_mode: String = sqlx::query_scalar("SELECT @@SQL_MODE")
        .fetch_one(&mut conn)
        .await?;
    if !sql_mode
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == ',')
    {
        return Err(AppError::InvalidInput("无法识别源会话 SQL_MODE".into()));
    }
    let sql_mode = if sql_mode.split(',').any(|v| v == "NO_AUTO_VALUE_ON_ZERO") {
        sql_mode
    } else if sql_mode.is_empty() {
        "NO_AUTO_VALUE_ON_ZERO".into()
    } else {
        format!("{sql_mode},NO_AUTO_VALUE_ON_ZERO")
    };
    // Shared filter literals use MySQL backslash escaping. Only adjust this owned
    // read connection and use the same mode for SHOW CREATE and script replay.
    let sql_mode = sql_mode
        .split(',')
        .filter(|v| !crate::services::mysql_script::nonstandard_quotes(v))
        .collect::<Vec<_>>()
        .join(",");
    conn.execute(format!("SET SESSION SQL_MODE='{sql_mode}'").as_str()).await?;
    let rows=sqlx::query("SELECT TABLE_NAME, ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME").bind(&req.database).fetch_all(&mut conn).await?;
    let available: HashMap<String, String> = rows
        .iter()
        .map(|r| (text(r, "TABLE_NAME"), text(r, "ENGINE")))
        .collect();
    let mut tables = if req.all_tables {
        available.keys().cloned().collect::<Vec<_>>()
    } else {
        req.tables.clone()
    };
    tables.sort();
    tables.dedup();
    let objects = crate::services::mysql_dump::collect(&mut conn, req).await?;
    if tables.is_empty() && objects.is_empty() {
        return Err(AppError::InvalidInput("没有可导出的数据表".into()));
    }
    for t in &tables {
        if !available.contains_key(t) {
            return Err(AppError::InvalidInput(format!(
                "表 {t} 不存在、无权限或不是普通数据表"
            )));
        }
    }
    if req.filters.keys().any(|t| !tables.contains(t)) {
        return Err(AppError::InvalidInput("筛选条件包含未选择的数据表".into()));
    }
    if req.mode != "structure" && req.consistent_snapshot {
        if tables
            .iter()
            .any(|t| !available[t].eq_ignore_ascii_case("InnoDB"))
        {
            return Err(AppError::InvalidInput(
                "一致性快照仅支持 InnoDB 表；请排除其他引擎表或关闭快照选项".into(),
            ));
        }
        conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ").await?;
        conn.execute("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY").await?;
    }
    let destination = PathBuf::from(&req.path);
    let parent = if req.split_files {
        destination.as_path()
    } else {
        destination
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."))
    };
    if !parent.is_dir() {
        return Err(AppError::InvalidInput("输出目录不存在".into()));
    }
    let staging = if req.split_files {
        Some(
            tempfile::Builder::new()
                .prefix(".dw-sql-partial-")
                .tempdir_in(parent)?,
        )
    } else {
        None
    };
    let dir = staging.as_ref().map(|d| d.path()).unwrap_or(parent);
    let target_db = if req.target_database.is_empty() { &req.database } else { &req.target_database };
    let mut preamble = header(target_db, &req.mode, req.include_database, &sql_mode);
    if req.include_database {
        let options=sqlx::query("SELECT DEFAULT_CHARACTER_SET_NAME,DEFAULT_COLLATION_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?").bind(&req.database).fetch_one(&mut conn).await?;
        preamble=preamble.replace(&format!("CREATE DATABASE IF NOT EXISTS {};",ident(target_db)),&format!("CREATE DATABASE IF NOT EXISTS {} DEFAULT CHARACTER SET {} COLLATE {};",ident(target_db),ident(&text(&options,"DEFAULT_CHARACTER_SET_NAME")),ident(&text(&options,"DEFAULT_COLLATION_NAME"))));
    }
    let mut combined = if req.split_files {
        None
    } else {
        let mut o = Output::new(dir)?;
        o.write(&preamble)?;
        Some(o)
    };
    let mut count = 0u64;
    let mut bytes = 0u64;
    let mut signatures = Vec::new();
    let mut manifest = Vec::new();
    for (at, table) in tables.iter().enumerate() {
        crate::tasks::checkpoint()?;
        crate::tasks::progress(
            at as u64,
            Some(tables.len() as u64),
            format!("正在导出 {table} · {count} 行 · {bytes} 字节"),
        );
        let original = ddl(&mut conn, &req.database, table).await?;
        signatures.push((table.clone(), ddl_signature(&original)));
        let mut separate = if req.split_files {
            let mut o = Output::new(dir)?;
            o.write(&preamble)?;
            Some(o)
        } else {
            None
        };
        let output = if let Some(o) = separate.as_mut() {
            o
        } else {
            combined.as_mut().unwrap()
        };
        // Never interpolate table names into line comments: identifiers may contain newlines.
        if req.mode != "data" {
            if req.drop_tables {
                output.write(&format!("\nDROP TABLE IF EXISTS {};\n", ident(table)))?;
            }
            output.write(&crate::services::mysql_dump::remap(&original, &req.database, &req.target_database))?;
            output.write(";\n")?;
        }
        if req.mode != "structure" {
            let columns=sqlx::query("SELECT COLUMN_NAME, DATA_TYPE, EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION").bind(&req.database).bind(table).fetch_all(&mut conn).await?;
            let filter_columns: Vec<_> = columns.iter().map(|r| text(r, "COLUMN_NAME")).collect();
            let columns: Vec<_> = columns
                .iter()
                .filter(|r| {
                    let extra = text(r, "EXTRA").to_ascii_uppercase();
                    !extra.contains("VIRTUAL GENERATED") && !extra.contains("STORED GENERATED")
                })
                .map(|r| (text(r, "COLUMN_NAME"), text(r, "DATA_TYPE")))
                .collect();
            if columns.is_empty() {
                return Err(AppError::InvalidInput(format!(
                    "表 {table} 没有可写入的普通字段"
                )));
            }
            let filter = if let Some(f) = req.filters.get(table) {
                if f.conditions.len() > 50
                    || !["and", "or", ""].contains(&f.conjunction.as_str())
                    || f.conditions
                        .iter()
                        .any(|c| !filter_columns.contains(&c.column))
                {
                    return Err(AppError::InvalidInput(format!("表 {table} 的筛选条件无效")));
                }
                crate::services::query::build_where_clause(adapter, &f.conditions, &f.conjunction)?
            } else {
                String::new()
            };
            let query = format!(
                "SELECT {} FROM {}.{}{}",
                columns
                    .iter()
                    .map(|(n, t)| expression(n, t))
                    .collect::<Vec<_>>()
                    .join(","),
                ident(&req.database),
                ident(table),
                filter
            );
            let prefix = format!(
                "INSERT INTO {} ({}) VALUES\n",
                ident(table),
                columns
                    .iter()
                    .map(|(n, _)| ident(n))
                    .collect::<Vec<_>>()
                    .join(", ")
            );
            let mut batch = Batch::new(prefix, req.batch_rows, req.batch_bytes);
            let mut stream = sqlx::query(&query).fetch(&mut conn);
            loop {
                let row = tokio::select! {result=stream.try_next()=>result?,_=tokio::time::sleep(std::time::Duration::from_millis(150))=>{crate::tasks::checkpoint()?;continue;}};
                let Some(row) = row else { break };
                crate::tasks::checkpoint()?;
                let values = (0..columns.len())
                    .map(|i| row.try_get::<String, _>(i).or_else(|_|row.try_get::<Vec<u8>,_>(i).and_then(|bytes|String::from_utf8(bytes).map_err(|e|sqlx::Error::Decode(Box::new(e))))))
                    .collect::<Result<Vec<_>, _>>()?;
                batch.push(format!("({})", values.join(", ")), output)?;
                count += 1;
                if count % 200 == 0 {
                    crate::tasks::progress(
                        at as u64,
                        Some(tables.len() as u64),
                        format!(
                            "{table} · 已导出 {count} 行 · {} 字节",
                            bytes + output.bytes
                        ),
                    );
                }
            }
            drop(stream);
            batch.flush(output)?;
        }
        if let Some(mut file) = separate {
            file.write(FOOTER)?;
            let name = format!("{:04}.sql", at + 1);
            bytes += file.finish(&dir.join(&name))?;
            manifest.push(serde_json::json!({"table":table,"file":name}));
        }
    }
    // Stored programs and views precede triggers/events, which must not fire while loading table data.
    for (at,item) in objects.iter().enumerate() {
        crate::tasks::checkpoint()?;
        let sql=crate::services::mysql_dump::definition_sql(item,req)?;
        if req.split_files {
            let name=format!("{:04}.sql",tables.len()+at+1);
            let mut output=Output::new(dir)?;output.write(&preamble)?;output.write(&sql)?;output.write(FOOTER)?;
            bytes+=output.finish(&dir.join(&name))?;
            manifest.push(serde_json::json!({"kind":item.object.kind,"name":item.object.name,"file":name}));
        }else{combined.as_mut().unwrap().write(&sql)?;}
        let latest=crate::services::mysql_objects::definition(&mut conn,&req.database,&item.object.kind,&item.object.name).await?;
        if latest.sql!=item.definition.sql {return Err(AppError::InvalidInput(format!("对象 {} 在导出期间变化，未发布文件",item.object.name)));}
    }
    // Refuse to publish if DDL changed while reading data; do not replace an existing export.
    for (table, signature) in signatures {
        crate::tasks::checkpoint()?;
        if ddl_signature(&ddl(&mut conn, &req.database, &table).await?) != signature {
            return Err(AppError::InvalidInput(format!(
                "表 {table} 在导出期间结构发生变化，未生成正式文件，请重试"
            )));
        }
    }
    if req.mode != "structure" && req.consistent_snapshot {
        conn.execute("ROLLBACK").await?;
    }
    conn.close().await.ok();
    pool.close().await;
    crate::tasks::checkpoint()?;
    let path = if let Some(staging) = staging {
        let manifest=serde_json::to_vec_pretty(&serde_json::json!({"database":req.database,"targetDatabase":target_db,"mode":req.mode,"objects":manifest,"note":"按文件编号导入。先表结构和数据，再函数、过程、视图、触发器和事件；动态 SQL 字符串不重写"})).unwrap();
        std::fs::write(staging.path().join("manifest.json"), &manifest)?;
        bytes += manifest.len() as u64;
        let path = parent.join(format!(
            "mysql-export-{}-{}",
            chrono::Local::now().format("%Y%m%d-%H%M%S"),
            &uuid::Uuid::new_v4().to_string()[..8]
        ));
        crate::tasks::checkpoint()?;
        std::fs::rename(staging.path(), &path)?;
        path
    } else {
        let mut output = combined.unwrap();
        output.write(FOOTER)?;
        bytes = output.finish(&destination)?;
        destination
    };
    crate::tasks::progress(
        tables.len() as u64,
        Some(tables.len() as u64),
        format!("导出完成 · {count} 行 · {bytes} 字节"),
    );
    Ok(SqlExportResult {
        path: path.to_string_lossy().into_owned(),
        rows: count,
        bytes,
        tables: tables.len(),
        objects: objects.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn literals_preserve_type_and_precision() {
        assert!(expression("id", "bigint").contains("CAST(`id` AS CHAR)"));
        assert!(expression("amount", "decimal").contains("CAST"));
        assert!(expression("text", "text").contains("CONVERT(`text` USING utf8mb4)"));
        assert!(expression("bytes", "blob").contains("HEX(`bytes`)"));
        assert!(expression("a`b", "json").contains("`a``b`"));
        assert!(expression("point", "geometry").contains("ST_SRID"));
    }
    #[test]
    fn file_publish_and_batches() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("result.sql");
        std::fs::write(&path, "old").unwrap();
        {
            let mut out = Output::new(dir.path()).unwrap();
            out.write("partial").unwrap();
        }
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "old");
        let mut out = Output::new(dir.path()).unwrap();
        let mut batch = Batch::new("INSERT INTO t VALUES\n".into(), 2, 1024);
        for v in ["(NULL)", "(9007199254740993)", "(X'00FF')"] {
            batch.push(v.into(), &mut out).unwrap();
        }
        batch.flush(&mut out).unwrap();
        out.finish(&path).unwrap();
        let s = std::fs::read_to_string(path).unwrap();
        assert_eq!(s.matches("INSERT").count(), 2);
        assert!(s.contains("9007199254740993"));
    }
    #[test]
    fn portable_header() {
        let s = header("a`b", "both", false, "NO_AUTO_VALUE_ON_ZERO");
        assert!(!s.contains("USE "));
        assert!(!s.contains("CREATE DATABASE"));
        assert!(header("a`b", "both", true, "").contains("USE `a``b`"));
        assert_eq!(
            ddl_signature("x AUTO_INCREMENT=12 y"),
            ddl_signature("x AUTO_INCREMENT=44 y")
        );
    }
    #[tokio::test]
    async fn cancelled_export_preserves_destination_and_cleans_temp() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("result.sql");
        std::fs::write(&path, "previous export").unwrap();
        let tasks = crate::tasks::TaskRegistry::default();
        tasks.begin("export".into()).unwrap();
        let result = tasks
            .scope(Some("export".into()), async {
                let mut out = Output::new(dir.path())?;
                out.write("partial export")?;
                tasks.cancel("export")?;
                out.finish(&path)
            })
            .await;
        assert!(matches!(result, Err(AppError::Cancelled(_))));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "previous export");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }
}
