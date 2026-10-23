//! 更新包校验、便携目录交换与独立进程恢复。不会删除旧版或修改用户数据库。
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
    process::Command,
    time::{Duration, Instant},
};

pub const MAX_PACKAGE: u64 = 256 * 1024 * 1024;
const MAX_EXPANDED: u64 = 768 * 1024 * 1024;
pub const PUBLIC_KEY: &str = include_str!("../updater.pub");
pub type Result<T> = std::result::Result<T, String>;
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

pub fn verify_signature(bytes: &[u8], signature: &str) -> Result<()> {
    let key = base64::engine::general_purpose::STANDARD
        .decode(PUBLIC_KEY.trim())
        .map_err(err)?;
    let signature = base64::engine::general_purpose::STANDARD
        .decode(signature.trim())
        .map_err(err)?;
    let key =
        minisign_verify::PublicKey::decode(std::str::from_utf8(&key).map_err(err)?).map_err(err)?;
    let signature =
        minisign_verify::Signature::decode(std::str::from_utf8(&signature).map_err(err)?)
            .map_err(err)?;
    key.verify(bytes, &signature, false)
        .map_err(|_| "更新包签名无效，请重新下载；不会安装此文件".into())
}

/// 同时绑定版本、下载地址、包签名和说明，防止把旧的合法签名包冒充为新版。
pub fn verify_release_metadata(raw: &serde_json::Value) -> Result<()> {
    let encoded = raw["signedMetadata"]
        .as_str()
        .ok_or("更新索引缺少签名元数据")?;
    if encoded.len() > 2 * 1024 * 1024 {
        return Err("更新索引超限".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(err)?;
    verify_signature(
        &bytes,
        raw["metadataSignature"]
            .as_str()
            .ok_or("更新索引缺少元数据签名")?,
    )?;
    let signed: serde_json::Value = serde_json::from_slice(&bytes).map_err(err)?;
    for field in ["version", "notes", "pub_date", "platforms"] {
        if signed.get(field).is_none() || signed[field] != raw[field] {
            return Err("更新索引内容与签名元数据不一致".into());
        }
    }
    Ok(())
}

#[derive(Deserialize)]
pub struct Distribution {
    pub version: String,
    pub target: String,
    pub profile: String,
    pub kind: String,
    pub files: BTreeMap<String, String>,
}

pub fn safe_relative(name: &str) -> bool {
    !name.is_empty()
        && !name.contains(['\\', ':', '\0'])
        && name.split('/').all(|s| {
            !s.is_empty()
                && !s.ends_with(['.', ' '])
                && !s.starts_with('.')
                && !matches!(
                    s.split('.')
                        .next()
                        .unwrap_or("")
                        .to_ascii_uppercase()
                        .as_str(),
                    "CON"
                        | "PRN"
                        | "AUX"
                        | "NUL"
                        | "COM1"
                        | "COM2"
                        | "COM3"
                        | "COM4"
                        | "COM5"
                        | "COM6"
                        | "COM7"
                        | "COM8"
                        | "COM9"
                        | "LPT1"
                        | "LPT2"
                        | "LPT3"
                        | "LPT4"
                        | "LPT5"
                        | "LPT6"
                        | "LPT7"
                        | "LPT8"
                        | "LPT9"
                )
        })
        && Path::new(name)
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
}

/// 仅接受构建脚本生成的单根目录 ZIP；逐项展开，拒绝路径穿越、链接、重复和解压炸弹。
pub fn extract(bytes: &[u8], output: &Path, version: &str) -> Result<()> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(err)?;
    if zip.len() > 10000 {
        return Err("更新包文件数超限".into());
    }
    let mut names = BTreeSet::new();
    let mut expanded = 0u64;
    let root = format!("DBFolio_{version}_windows_x64_portable/");
    for i in 0..zip.len() {
        let mut file = zip.by_index(i).map_err(err)?;
        // Windows .NET 压缩工具可能写入反斜杠；统一后仍逐段检查 ..、盘符和重复路径。
        let normalized = file.name().replace('\\', "/");
        let name = normalized
            .strip_prefix(&root)
            .ok_or("更新包目录与版本不匹配")?
            .to_owned();
        if name.is_empty() && file.is_dir() {
            continue;
        }
        let path = name.trim_end_matches('/');
        if !safe_relative(path) || !names.insert(path.to_ascii_lowercase()) || file.is_symlink() {
            return Err("更新包包含不安全或重复的路径".into());
        }
        expanded = expanded.checked_add(file.size()).ok_or("更新包大小超限")?;
        if expanded > MAX_EXPANDED {
            return Err("更新包解压大小超限".into());
        }
        let destination = output.join(path);
        if file.is_dir() {
            fs::create_dir_all(destination).map_err(err)?;
            continue;
        }
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(err)?;
        }
        let mut target = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(destination)
            .map_err(err)?;
        std::io::copy(&mut file, &mut target).map_err(err)?;
        target.sync_all().map_err(err)?;
    }
    validate_distribution(output, version)
}

pub fn validate_distribution(root: &Path, version: &str) -> Result<()> {
    let data = fs::read(root.join("distribution.json")).map_err(err)?;
    if data.len() > 2 * 1024 * 1024 {
        return Err("分发清单超限".into());
    }
    let text = std::str::from_utf8(&data)
        .map_err(err)?
        .trim_start_matches('\u{feff}');
    let manifest: Distribution = serde_json::from_str(text).map_err(err)?;
    if manifest.version != version
        || manifest.kind != "portable"
        || manifest.profile != "release"
        || manifest.target != "x86_64-pc-windows-msvc"
        || !manifest.files.contains_key("DBFolio.exe")
        || !manifest.files.contains_key("web/index.html")
    {
        return Err("分发清单的版本、平台或类型不匹配".into());
    }
    let mut names = BTreeSet::new();
    for (name, hash) in &manifest.files {
        if !safe_relative(name) || !names.insert(name.to_ascii_lowercase()) || hash.len() != 64 {
            return Err("分发清单路径或摘要无效".into());
        }
        let path = root.join(name);
        reject_links(&path)?;
        if format!("{:x}", Sha256::digest(fs::read(&path).map_err(err)?)) != *hash {
            return Err(format!("更新文件校验失败：{name}"));
        }
    }
    fn walk(root: &Path, dir: &Path, names: &BTreeSet<String>) -> Result<()> {
        for entry in fs::read_dir(dir).map_err(err)? {
            let path = entry.map_err(err)?.path();
            reject_links(&path)?;
            if path.is_dir() {
                walk(root, &path, names)?;
            } else {
                let name = path
                    .strip_prefix(root)
                    .map_err(err)?
                    .to_string_lossy()
                    .replace('\\', "/");
                if name != "distribution.json" && !names.contains(&name.to_ascii_lowercase()) {
                    return Err("更新包存在未登记文件".into());
                }
            }
        }
        Ok(())
    }
    walk(root, root, &names)
}

pub fn reject_links(path: &Path) -> Result<()> {
    for ancestor in path.ancestors() {
        let metadata = fs::symlink_metadata(ancestor).map_err(err)?;
        if metadata.file_type().is_symlink() {
            return Err("更新路径不可包含符号链接".into());
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return Err("更新路径不可包含目录联接或重解析点".into());
            }
        }
    }
    Ok(())
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallPlan {
    pub id: String,
    pub target: PathBuf,
    pub executable: String,
    pub old_version: String,
    pub version: String,
    pub signature: String,
    pub parent_pid: u32,
}
impl InstallPlan {
    pub fn staging(&self) -> PathBuf {
        self.target
            .parent()
            .unwrap()
            .join(format!(".dbfolio-new-{}", self.id))
    }
    pub fn backup(&self) -> PathBuf {
        self.target
            .parent()
            .unwrap()
            .join(format!(".dbfolio-old-{}", self.id))
    }
    pub fn validate(&self) -> Result<()> {
        uuid::Uuid::parse_str(&self.id).map_err(err)?;
        semver::Version::parse(&self.version).map_err(err)?;
        semver::Version::parse(&self.old_version).map_err(err)?;
        if !self.target.is_absolute()
            || self.target.parent().and_then(Path::parent).is_none()
            || self
                .target
                .components()
                .any(|c| matches!(c, Component::ParentDir))
            || !matches!(self.executable.as_str(), "DBFolio.exe" | "dbfolio.exe")
        {
            return Err("更新目标目录无效".into());
        }
        reject_links(self.target.parent().ok_or("缺少更新目录")?)
    }
}

pub fn write_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let temp = path.with_extension("tmp");
    let mut file = fs::File::create(&temp).map_err(err)?;
    file.write_all(&serde_json::to_vec_pretty(value).map_err(err)?)
        .map_err(err)?;
    file.sync_all().map_err(err)?;
    drop(file);
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn MoveFileExW(from: *const u16, to: *const u16, flags: u32) -> i32;
        }
        let from: Vec<u16> = temp.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 9) } == 0 {
            return Err(err(std::io::Error::last_os_error()));
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        fs::rename(temp, path).map_err(err)
    }
}
fn hidden_command(path: &Path) -> Command {
    let mut command = Command::new(path);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
}
pub fn verify_resources(root: &Path) -> Result<()> {
    let status = hidden_command(&root.join("DBFolio.exe"))
        .arg("--verify-resources")
        .current_dir(root)
        .status()
        .map_err(err)?;
    if !status.success() {
        return Err("新版前端资源自检失败".into());
    }
    Ok(())
}
pub fn ensure_unlocked(root: &Path) -> Result<()> {
    reject_links(root)?;
    for entry in fs::read_dir(root).map_err(err)? {
        let path = entry.map_err(err)?.path();
        reject_links(&path)?;
        if path.is_dir() {
            ensure_unlocked(&path)?;
        } else {
            let mut options = fs::OpenOptions::new();
            options.read(true).write(true);
            #[cfg(windows)]
            {
                use std::os::windows::fs::OpenOptionsExt;
                options.share_mode(0);
            }
            options.open(&path).map_err(|_| {
                format!(
                    "文件正被占用或不可写，请退出其他实例后重试：{}",
                    path.display()
                )
            })?;
        }
    }
    Ok(())
}

fn rename_retry(from: &Path, to: &Path) -> std::io::Result<()> {
    // Windows 在进程结束后，映像解除映射或安全扫描仍可能短暂占用刚校验的 EXE。
    for attempt in 0..40 {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(error) if matches!(error.raw_os_error(), Some(5 | 32 | 33)) && attempt < 39 => {
                std::thread::sleep(Duration::from_millis(250))
            }
            Err(error) => return Err(error),
        }
    }
    unreachable!()
}

/// 两步重命名之间若中断，外置 journal 与原目录均保留，恢复程序可再次运行。
pub fn swap(plan: &InstallPlan, journal: &Path) -> Result<()> {
    plan.validate()?;
    if plan.backup().exists() {
        return Err("旧版备份目录已存在，请先恢复上次更新".into());
    }
    ensure_unlocked(&plan.target)?;
    write_json(
        journal,
        &serde_json::json!({"phase":"prepared","plan":plan}),
    )?;
    fs::rename(&plan.target, plan.backup()).map_err(err)?;
    if let Err(error) = rename_retry(&plan.staging(), &plan.target) {
        rename_retry(&plan.backup(), &plan.target).map_err(|e| {
            format!(
                "新版移入失败：{error}；恢复失败：{e}，旧版保留于 {}",
                plan.backup().display()
            )
        })?;
        return Err(format!("新版移入失败，已恢复旧目录：{error}"));
    }
    write_json(journal, &serde_json::json!({"phase":"swapped","plan":plan}))
}

pub fn recover(plan: &InstallPlan) -> Result<()> {
    plan.validate()?;
    if !plan.backup().exists() {
        return Ok(());
    }
    reject_links(&plan.backup())?;
    if plan.target.exists() {
        ensure_unlocked(&plan.target)?;
        let failed = plan
            .target
            .parent()
            .unwrap()
            .join(format!(".dbfolio-failed-{}", plan.id));
        if failed.exists() {
            return Err("失败版本保留目录已存在，请手动核对更新日志".into());
        }
        fs::rename(&plan.target, failed).map_err(err)?;
    }
    fs::rename(plan.backup(), &plan.target).map_err(err)
}

#[cfg(windows)]
fn wait_parent(pid: u32) -> Result<()> {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut std::ffi::c_void;
        fn WaitForSingleObject(handle: *mut std::ffi::c_void, millis: u32) -> u32;
        fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
    }
    unsafe {
        let handle = OpenProcess(0x00100000, 0, pid);
        if handle.is_null() {
            return Ok(());
        }
        let result = WaitForSingleObject(handle, 120000);
        CloseHandle(handle);
        if result != 0 {
            return Err("等待 DBFolio 退出超时，旧版未被修改".into());
        }
    }
    Ok(())
}

/// 主程序的受限命令行分支：先于 Tauri、资源和本地数据库初始化执行。
pub fn helper(plan_path: &Path, recovery: bool) -> Result<()> {
    let plan: InstallPlan =
        serde_json::from_slice(&fs::read(plan_path).map_err(err)?).map_err(err)?;
    plan.validate()?;
    let cache = plan_path.parent().ok_or("缺少更新缓存目录")?;
    if cache.file_name().and_then(|s| s.to_str()) != Some(&plan.id)
        || plan_path.file_name().and_then(|s| s.to_str()) != Some("plan.json")
    {
        return Err("更新计划路径无效".into());
    }
    reject_links(cache)?;
    let journal = cache.join("journal.json");
    let run = || -> Result<()> {
        #[cfg(windows)]
        wait_parent(plan.parent_pid)?;
        if recovery {
            recover(&plan)?;
        } else {
            let bytes = fs::read(cache.join("package.zip")).map_err(err)?;
            if bytes.len() as u64 > MAX_PACKAGE {
                return Err("更新包大小超限".into());
            }
            verify_signature(&bytes, &plan.signature)?;
            if plan.staging().exists() {
                return Err("临时更新目录已存在，请先核对上次更新".into());
            }
            fs::create_dir(&plan.staging()).map_err(err)?;
            extract(&bytes, &plan.staging(), &plan.version)?;
            verify_resources(&plan.staging())?;
            swap(&plan, &journal)?;
            // 在访问本地数据库之前完成新版的真实资源自检，失败时可安全还原程序。
            if let Err(error) = verify_resources(&plan.target) {
                recover(&plan)?;
                return Err(format!("{error}；已恢复旧版"));
            }
        }
        if recovery {
            hidden_command(&plan.target.join(&plan.executable))
                .current_dir(&plan.target)
                .spawn()
                .map_err(err)?;
            write_json(
                &journal,
                &serde_json::json!({"phase":"restored","plan":plan}),
            )?;
            return Ok(());
        }
        let mut child = match hidden_command(&plan.target.join(&plan.executable))
            .arg("--update-health")
            .arg(cache)
            .current_dir(&plan.target)
            .spawn()
        {
            Ok(child) => child,
            Err(error) => {
                recover(&plan)?;
                return Err(format!("启动失败，已恢复旧版程序：{error}"));
            }
        };
        let deadline = Instant::now() + Duration::from_secs(90);
        loop {
            if cache.join("healthy.json").exists() {
                write_json(
                    &journal,
                    &serde_json::json!({"phase":"complete","plan":plan}),
                )?;
                break;
            }
            if child.try_wait().map_err(err)?.is_some() {
                if !cache.join("data-opened.json").exists() {
                    recover(&plan)?;
                    return Err("新版在打开本地数据之前退出，已恢复旧程序目录".into());
                }
                return Err("新版打开本地数据后退出，已保留旧程序和数据库快照；请核对数据兼容性后恢复，未自动覆盖本地数据".into());
            }
            if Instant::now() > deadline {
                return Err("新版启动尚未确认就绪；进程及旧版恢复材料保留，未强制终止程序".into());
            }
            std::thread::sleep(Duration::from_millis(300));
        }
        Ok(())
    };
    let result = run();
    if let Err(message) = &result {
        let _ = write_json(
            &cache.join("error.json"),
            &serde_json::json!({"message":message,"backup":plan.backup(),"target":plan.target}),
        );
        // 目录交换中断时保留外置 journal 和所有目录；不自动覆盖任何用户数据。
    }
    result
}

fn health_cache() -> Result<Option<PathBuf>> {
    let args: Vec<_> = std::env::args_os().collect();
    let Some(index) = args.iter().position(|a| a == "--update-health") else {
        return Ok(None);
    };
    let cache = PathBuf::from(args.get(index + 1).ok_or("缺少更新健康检查目录")?);
    reject_links(&cache)?;
    let plan: InstallPlan =
        serde_json::from_slice(&fs::read(cache.join("plan.json")).map_err(err)?).map_err(err)?;
    plan.validate()?;
    if cache.file_name().and_then(|s| s.to_str()) != Some(plan.id.as_str())
        || plan.version != env!("CARGO_PKG_VERSION")
        || std::env::current_exe()
            .map_err(err)?
            .canonicalize()
            .map_err(err)?
            != plan
                .target
                .join(&plan.executable)
                .canonicalize()
                .map_err(err)?
    {
        return Err("更新健康检查目标不匹配".into());
    }
    Ok(Some(cache))
}
pub fn mark_data_opening() -> Result<()> {
    if let Some(cache) = health_cache()? {
        write_json(
            &cache.join("data-opened.json"),
            &serde_json::json!({"version":env!("CARGO_PKG_VERSION")}),
        )?;
    }
    Ok(())
}
pub fn mark_ready() -> Result<()> {
    if let Some(cache) = health_cache()? {
        write_json(
            &cache.join("healthy.json"),
            &serde_json::json!({"version":env!("CARGO_PKG_VERSION")}),
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unsafe_paths_rejected() {
        for name in [
            "../x",
            "C:/x",
            "a\\b",
            "a/../b",
            "a//b",
            "CON.txt",
            "web/file.",
            "web/file ",
            ".hidden",
            "NUL",
        ] {
            assert!(!safe_relative(name), "{name}");
        }
        assert!(safe_relative("web/assets/main-1.js"));
    }
    #[test]
    fn invalid_signature_rejected() {
        assert!(verify_signature(b"modified", "aW52YWxpZA==").is_err());
    }
    #[test]
    fn missing_metadata_signature_is_rejected() {
        assert!(verify_release_metadata(&serde_json::json!({"version":"9.0.0"})).is_err());
    }
    fn zip_bytes(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        for (name, bytes) in entries {
            writer
                .start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            std::io::Write::write_all(&mut writer, bytes).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }
    #[test]
    fn archive_rejects_traversal_wrong_root_duplicate_and_missing_manifest() {
        for entries in [
            vec![(
                "DBFolio_1.0.0_windows_x64_portable/../escape",
                b"x".as_slice(),
            )],
            vec![("wrong-root/file", b"x".as_slice())],
            vec![
                ("DBFolio_1.0.0_windows_x64_portable/a", b"x".as_slice()),
                ("DBFolio_1.0.0_windows_x64_portable/A", b"y".as_slice()),
            ],
            vec![(
                "DBFolio_1.0.0_windows_x64_portable/DBFolio.exe",
                b"x".as_slice(),
            )],
        ] {
            let dir = tempfile::tempdir().unwrap();
            assert!(extract(&zip_bytes(&entries), dir.path(), "1.0.0").is_err());
            assert!(!dir.path().parent().unwrap().join("escape").exists());
        }
    }
    #[test]
    fn valid_manifest_rejects_modified_and_unlisted_files() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("web")).unwrap();
        fs::write(dir.path().join("DBFolio.exe"), b"exe").unwrap();
        fs::write(dir.path().join("web/index.html"), b"html").unwrap();
        let manifest = serde_json::json!({"version":"1.0.0","kind":"portable","profile":"release","target":"x86_64-pc-windows-msvc","files":{"DBFolio.exe":format!("{:x}",Sha256::digest(b"exe")),"web/index.html":format!("{:x}",Sha256::digest(b"html"))}});
        fs::write(
            dir.path().join("distribution.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        validate_distribution(dir.path(), "1.0.0").unwrap();
        fs::write(dir.path().join("extra.exe"), b"bad").unwrap();
        assert!(validate_distribution(dir.path(), "1.0.0").is_err());
        fs::remove_file(dir.path().join("extra.exe")).unwrap();
        fs::write(dir.path().join("web/index.html"), b"modified").unwrap();
        assert!(validate_distribution(dir.path(), "1.0.0").is_err());
    }
    #[test]
    #[ignore = "需要 DBFOLIO_UPDATE_RELEASE 指向已签名正式产物目录"]
    fn signed_release_roundtrip() {
        let root = PathBuf::from(std::env::var_os("DBFOLIO_UPDATE_RELEASE").unwrap());
        let version = env!("CARGO_PKG_VERSION");
        let feed: serde_json::Value =
            serde_json::from_slice(&fs::read(root.join("preview.json")).unwrap()).unwrap();
        verify_release_metadata(&feed).unwrap();
        let mut changed = feed.clone();
        changed["version"] = serde_json::json!("99.0.0");
        assert!(verify_release_metadata(&changed).is_err());
        for suffix in ["setup.exe", "portable.zip"] {
            let path = root.join(format!("DBFolio_{version}_windows_x64_{suffix}"));
            let bytes = fs::read(&path).unwrap();
            let signature = fs::read_to_string(path.with_file_name(format!(
                "{}.sig",
                path.file_name().unwrap().to_string_lossy()
            )))
            .unwrap();
            verify_signature(&bytes, &signature).unwrap();
            let mut damaged = bytes.clone();
            damaged[0] ^= 1;
            assert!(verify_signature(&damaged, &signature).is_err());
            if suffix == "portable.zip" {
                let dir = tempfile::tempdir().unwrap();
                extract(&bytes, dir.path(), version).unwrap();
                verify_resources(dir.path()).unwrap();
            }
        }
    }
    #[test]
    #[ignore = "需要 scripts/check-update-helper.ps1 创建的隔离签名探针"]
    fn signed_helper_lifecycle() {
        let fixture = PathBuf::from(std::env::var_os("DBFOLIO_UPDATE_FIXTURE").unwrap());
        for mode in ["success", "before", "after"] {
            let dir = tempfile::tempdir().unwrap();
            let mut p = plan(dir.path());
            p.version = "0.0.0".into();
            p.signature = fs::read_to_string(fixture.join("probe.zip.sig")).unwrap();
            let cache = dir.path().join(&p.id);
            fs::create_dir(&cache).unwrap();
            fs::create_dir(&p.target).unwrap();
            fs::write(p.target.join("old.marker"), b"preserve").unwrap();
            fs::copy(fixture.join("probe.zip"), cache.join("package.zip")).unwrap();
            fs::write(cache.join("probe-mode"), mode).unwrap();
            write_json(&cache.join("plan.json"), &p).unwrap();
            let result = helper(&cache.join("plan.json"), false);
            match mode {
                "success" => {
                    result.unwrap();
                    assert!(p.target.join("DBFolio.exe").exists());
                    assert!(p.backup().join("old.marker").exists());
                    assert!(cache.join("healthy.json").exists());
                }
                "before" => {
                    assert!(result.is_err());
                    assert_eq!(fs::read(p.target.join("old.marker")).unwrap(), b"preserve");
                    assert!(!p.backup().exists());
                }
                "after" => {
                    assert!(result.is_err());
                    assert!(p.target.join("DBFolio.exe").exists());
                    assert!(p.backup().join("old.marker").exists());
                    assert!(cache.join("data-opened.json").exists());
                }
                _ => unreachable!(),
            }
        }
    }
    fn plan(root: &Path) -> InstallPlan {
        InstallPlan {
            id: uuid::Uuid::new_v4().to_string(),
            target: root.join("app"),
            executable: "DBFolio.exe".into(),
            old_version: "1.0.0-alpha.14".into(),
            version: "1.0.0-alpha.15".into(),
            signature: String::new(),
            parent_pid: 0,
        }
    }
    #[test]
    fn swap_and_recovery_preserve_all_files() {
        let dir = tempfile::tempdir().unwrap();
        let p = plan(dir.path());
        fs::create_dir(&p.target).unwrap();
        fs::write(p.target.join("old"), b"old").unwrap();
        fs::create_dir(p.staging()).unwrap();
        fs::write(p.staging().join("new"), b"new").unwrap();
        swap(&p, &dir.path().join("journal.json")).unwrap();
        assert!(p.target.join("new").exists());
        assert!(p.backup().join("old").exists());
        recover(&p).unwrap();
        assert_eq!(fs::read(p.target.join("old")).unwrap(), b"old");
    }
    #[test]
    fn failed_swap_restores_old_directory() {
        let dir = tempfile::tempdir().unwrap();
        let p = plan(dir.path());
        fs::create_dir(&p.target).unwrap();
        fs::write(p.target.join("old"), b"old").unwrap();
        assert!(swap(&p, &dir.path().join("journal.json")).is_err());
        assert!(p.target.join("old").exists());
        assert!(!p.backup().exists());
    }
    #[cfg(windows)]
    #[test]
    fn occupied_file_never_removes_old_resources() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = tempfile::tempdir().unwrap();
        let p = plan(dir.path());
        fs::create_dir(&p.target).unwrap();
        fs::write(p.target.join("old"), b"old").unwrap();
        let _lock = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(p.target.join("old"))
            .unwrap();
        assert!(swap(&p, &dir.path().join("journal.json")).is_err());
        assert!(p.target.join("old").exists());
        assert!(!p.backup().exists());
    }
}
