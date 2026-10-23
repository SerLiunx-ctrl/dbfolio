use crate::{
    error::{AppError, AppResult},
    state::AppState,
    update_package as package,
};
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, time::Duration};
use tauri::State;
use tauri_plugin_updater::UpdaterExt;

#[derive(Default)]
pub struct UpdateState {
    pub operation: tokio::sync::Mutex<()>,
    inner: tokio::sync::Mutex<Session>,
}
#[derive(Default)]
struct Session {
    checked: Option<tauri_plugin_updater::Update>,
    ready: Option<Ready>,
}
struct Ready {
    update: tauri_plugin_updater::Update,
    cache: PathBuf,
    portable: bool,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Preferences {
    pub automatic: bool,
    pub channel: String,
    pub skipped: String,
    pub last_check: i64,
    pub proxy: String,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            automatic: crate::startup_check::profile().is_none(),
            channel: if env!("CARGO_PKG_VERSION").contains('-') {
                "preview"
            } else {
                "stable"
            }
            .into(),
            skipped: String::new(),
            last_check: 0,
            proxy: String::new(),
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    version: &'static str,
    distribution: &'static str,
    preferences: Preferences,
    log_path: String,
    ready_version: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Available {
    version: String,
    notes: String,
    date: Option<String>,
    skipped: bool,
    size: Option<u64>,
}
const KEY: &str = "updater_preferences_v1";
#[tauri::command]
pub fn updater_ready() -> AppResult<()> {
    crate::startup_check::frontend_ready()?;
    package::mark_ready().map_err(failure)
}
fn failure(error: impl std::fmt::Display) -> AppError {
    AppError::Message(format!("更新失败：{error}"))
}
async fn preferences(state: &AppState) -> AppResult<Preferences> {
    Ok(state
        .local
        .get_setting(KEY)
        .await?
        .and_then(|v| serde_json::from_str(&v).ok())
        .unwrap_or_default())
}
fn portable() -> AppResult<bool> {
    let exe = std::env::current_exe()?;
    let marker = exe
        .parent()
        .ok_or_else(|| failure("无法确定程序目录"))?
        .join("distribution.json");
    if !marker.exists() {
        return Ok(false);
    }
    let text = std::fs::read_to_string(marker)?;
    let value: serde_json::Value = serde_json::from_str(text.trim_start_matches('\u{feff}'))?;
    if value["kind"] != "portable" || value["profile"] != "release" {
        return Err(failure(
            "开发测试包不支持在线更新，请使用正式安装版或便携版",
        ));
    }
    Ok(true)
}
fn client(prefs: &Preferences) -> AppResult<reqwest::Client> {
    let mut builder = reqwest::Client::builder()
        .https_only(true)
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(600))
        .user_agent(concat!("DBFolio/", env!("CARGO_PKG_VERSION")));
    if !prefs.proxy.is_empty() {
        builder = builder.proxy(reqwest::Proxy::all(&prefs.proxy).map_err(failure)?);
    }
    builder.build().map_err(failure)
}
fn validate_preferences(p: &Preferences) -> AppResult<()> {
    if !matches!(p.channel.as_str(), "stable" | "preview") {
        return Err(failure("无效的更新通道"));
    }
    if !p.proxy.is_empty() {
        let url = reqwest::Url::parse(&p.proxy).map_err(failure)?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err(failure("更新代理仅支持不含认证的 HTTP/HTTPS 地址"));
        }
    }
    Ok(())
}
fn ensure_version(current: &str, next: &str, channel: &str) -> AppResult<()> {
    let current = semver::Version::parse(current).map_err(failure)?;
    let next = semver::Version::parse(next).map_err(failure)?;
    if next <= current || (channel == "stable" && !next.pre.is_empty()) {
        return Err(failure("更新版本不符合所选通道，禁止自动降级"));
    }
    Ok(())
}
#[tauri::command]
pub async fn updater_status(
    state: State<'_, AppState>,
    updates: State<'_, UpdateState>,
) -> AppResult<Status> {
    let ready_version = updates
        .inner
        .lock()
        .await
        .ready
        .as_ref()
        .map(|r| r.update.version.clone());
    Ok(Status {
        version: env!("CARGO_PKG_VERSION"),
        distribution: if cfg!(debug_assertions) {
            "development"
        } else if portable()? {
            "portable"
        } else {
            "installed"
        },
        preferences: preferences(&state).await?,
        log_path: crate::store::local::app_data_dir()
            .join("updates")
            .to_string_lossy()
            .into(),
        ready_version,
    })
}
#[tauri::command]
pub async fn updater_preferences(
    state: State<'_, AppState>,
    updates: State<'_, UpdateState>,
    mut value: Preferences,
) -> AppResult<()> {
    let _guard = updates
        .operation
        .try_lock()
        .map_err(|_| failure("更新操作正在进行，请稍后修改设置"))?;
    value.proxy = value.proxy.trim().into();
    validate_preferences(&value)?;
    // 调整通道或代理后必须重新检查，不能安装之前通道的缓存包。
    let old = preferences(&state).await?;
    value.last_check = old.last_check;
    if old.channel != value.channel || old.proxy != value.proxy {
        *updates.inner.lock().await = Session::default();
    }
    state
        .local
        .set_setting(KEY, &serde_json::to_string(&value)?)
        .await
}
#[tauri::command]
pub async fn updater_check(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    updates: State<'_, UpdateState>,
) -> AppResult<Option<Available>> {
    let _guard = updates
        .operation
        .try_lock()
        .map_err(|_| failure("已有更新操作正在进行"))?;
    let mut prefs = preferences(&state).await?;
    validate_preferences(&prefs)?;
    let config: serde_json::Value = serde_json::from_str(include_str!("../../update-config.json"))?;
    let endpoint = config[&prefs.channel]
        .as_str()
        .ok_or_else(|| failure("更新地址未配置"))?;
    let target = if portable()? {
        "windows-x86_64-portable"
    } else {
        "windows-x86_64"
    };
    prefs.last_check = chrono::Utc::now().timestamp();
    state
        .local
        .set_setting(KEY, &serde_json::to_string(&prefs)?)
        .await?;
    let mut builder = app
        .updater_builder()
        .pubkey(package::PUBLIC_KEY.trim())
        .target(target)
        .endpoints(vec![endpoint.parse().map_err(failure)?])
        .map_err(failure)?
        .timeout(Duration::from_secs(25));
    if !prefs.proxy.is_empty() {
        builder = builder.proxy(prefs.proxy.parse().map_err(failure)?);
    }
    let update = builder
        .build()
        .map_err(failure)?
        .check()
        .await
        .map_err(|e| {
            failure(format!(
                "无法读取版本信息；首次发布更新索引前不可用，可稍后重试或检查代理。{e}"
            ))
        })?;
    let info = if let Some(update) = &update {
        package::verify_release_metadata(&update.raw_json).map_err(failure)?;
        ensure_version(env!("CARGO_PKG_VERSION"), &update.version, &prefs.channel)?;
        if update.download_url.scheme() != "https" {
            return Err(failure("更新包必须使用 HTTPS 地址"));
        }
        Some(Available {
            version: update.version.clone(),
            notes: update.body.clone().unwrap_or_default(),
            date: update.date.map(|v| v.to_string()),
            skipped: prefs.skipped == update.version,
            size: update.raw_json["platforms"][target]["size"].as_u64(),
        })
    } else {
        None
    };
    let mut inner = updates.inner.lock().await;
    if inner.ready.as_ref().map(|r| &r.update.version) != update.as_ref().map(|u| &u.version) {
        inner.ready = None;
    }
    inner.checked = update;
    tracing::info!(channel=%prefs.channel,available=?info.as_ref().map(|i|&i.version),"更新检查完成");
    Ok(info)
}
#[tauri::command]
pub async fn updater_download(
    state: State<'_, AppState>,
    updates: State<'_, UpdateState>,
    task_id: Option<String>,
) -> AppResult<String> {
    let _guard = updates
        .operation
        .try_lock()
        .map_err(|_| failure("已有更新操作正在进行"))?;
    state
        .tasks
        .scope(task_id, async {
            updates.inner.lock().await.ready = None;
            let update = updates
                .inner
                .lock()
                .await
                .checked
                .clone()
                .ok_or_else(|| failure("请先检查更新"))?;
            let prefs = preferences(&state).await?;
            ensure_version(env!("CARGO_PKG_VERSION"), &update.version, &prefs.channel)?;
            let mut response = client(&prefs)?
                .get(update.download_url.clone())
                .send()
                .await
                .map_err(failure)?
                .error_for_status()
                .map_err(failure)?;
            let total = response.content_length();
            if total.is_some_and(|n| n > package::MAX_PACKAGE) {
                return Err(failure("更新包超过 256 MiB 限制"));
            }
            let mut bytes = Vec::new();
            loop {
                crate::tasks::checkpoint()?;
                let chunk = tokio::select! {
                    chunk=response.chunk()=>chunk.map_err(failure)?,
                    _=tokio::time::sleep(Duration::from_millis(200))=>continue,
                };
                let Some(chunk) = chunk else { break };
                if bytes.len() as u64 + chunk.len() as u64 > package::MAX_PACKAGE {
                    return Err(failure("更新包超过大小限制"));
                }
                bytes.extend_from_slice(&chunk);
                crate::tasks::progress(bytes.len() as u64, total, "正在下载更新包");
            }
            crate::tasks::checkpoint()?;
            package::verify_signature(&bytes, &update.signature).map_err(failure)?;
            let is_portable = portable()?;
            let cache = crate::store::local::app_data_dir()
                .join("updates")
                .join(uuid::Uuid::new_v4().to_string());
            std::fs::create_dir_all(&cache)?;
            let path = cache.join(if is_portable {
                "package.zip"
            } else {
                "setup.exe"
            });
            let mut file = std::fs::File::create(&path)?;
            use std::io::Write;
            file.write_all(&bytes)?;
            file.sync_all()?;
            if is_portable {
                crate::tasks::progress(bytes.len() as u64, total, "正在校验完整便携目录");
                let preflight = cache.join("preflight");
                std::fs::create_dir(&preflight)?;
                package::extract(&bytes, &preflight, &update.version).map_err(failure)?;
            }
            crate::tasks::checkpoint()?;
            use sha2::Digest;
            let hash = format!("{:x}", sha2::Sha256::digest(&bytes));
            package::write_json(
                &cache.join("download.json"),
                &serde_json::json!({"version":update.version,"portable":is_portable,"sha256":hash}),
            )
            .map_err(failure)?;
            // 下载不执行新程序。便携包在退出后由独立进程再次验签、展开、自检。
            updates.inner.lock().await.ready = Some(Ready {
                update: update.clone(),
                cache,
                portable: is_portable,
            });
            crate::tasks::progress(
                bytes.len() as u64,
                total,
                "下载完成，签名验证通过；等待重启更新",
            );
            Ok(update.version)
        })
        .await
}
async fn ensure_idle(state: &AppState) -> AppResult<()> {
    if !state.tasks.0.lock().unwrap().is_empty() || !state.running_queries.lock().await.is_empty() {
        return Err(failure("仍有运行中的任务或查询，请等待结束后再更新"));
    }
    if !state.transactions.0.lock().await.is_empty() {
        return Err(failure("请先提交或回滚所有手动事务"));
    }
    Ok(())
}
#[tauri::command]
pub async fn updater_install(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    updates: State<'_, UpdateState>,
) -> AppResult<()> {
    if cfg!(debug_assertions) {
        return Err(failure("开发模式不能安装更新，请使用正式包验证"));
    }
    let _guard = updates
        .operation
        .try_lock()
        .map_err(|_| failure("已有更新操作正在进行"))?;
    ensure_idle(&state).await?;
    let inner = updates.inner.lock().await;
    let ready = inner
        .ready
        .as_ref()
        .ok_or_else(|| failure("请先下载更新"))?;
    let prefs = preferences(&state).await?;
    ensure_version(
        env!("CARGO_PKG_VERSION"),
        &ready.update.version,
        &prefs.channel,
    )?;
    let bytes = std::fs::read(ready.cache.join(if ready.portable {
        "package.zip"
    } else {
        "setup.exe"
    }))?;
    package::verify_signature(&bytes, &ready.update.signature).map_err(failure)?;
    // SQLite 自带的一致性快照，包含历史与全部本地配置，不复制打开中的 app.db 文件。
    let mut snapshot = ready.cache.join("app-before-update.db");
    if snapshot.exists() {
        snapshot = ready
            .cache
            .join(format!("app-before-update-{}.db", uuid::Uuid::new_v4()));
    }
    state.local.backup_for_update(&snapshot).await?;
    ensure_idle(&state).await?;
    tracing::info!(version=%ready.update.version,portable=ready.portable,cache=%ready.cache.display(),"开始安装更新，已备份本地配置");
    if ready.portable {
        let exe = std::env::current_exe()?;
        let target = exe
            .parent()
            .ok_or_else(|| failure("无法确定程序目录"))?
            .canonicalize()?;
        package::reject_links(&target).map_err(failure)?;
        let plan = package::InstallPlan {
            id: ready.cache.file_name().unwrap().to_string_lossy().into(),
            target,
            executable: exe.file_name().unwrap().to_string_lossy().into(),
            old_version: env!("CARGO_PKG_VERSION").into(),
            version: ready.update.version.clone(),
            signature: ready.update.signature.clone(),
            parent_pid: std::process::id(),
        };
        plan.validate().map_err(failure)?;
        // 先确认父目录可写；独立进程在退出后校验所有旧文件是否可替换。
        let probe = plan
            .target
            .parent()
            .unwrap()
            .join(format!(".dbfolio-probe-{}", plan.id));
        std::fs::File::create(&probe)?;
        std::fs::remove_file(probe)?;
        let helper = ready.cache.join("DBFolio-update.exe");
        std::fs::copy(&exe, &helper)?;
        let plan_path = ready.cache.join("plan.json");
        package::write_json(&plan_path, &plan).map_err(failure)?;
        let mut command = std::process::Command::new(&helper);
        command.arg("--apply-update").arg(&plan_path);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        command.spawn()?;
        app.exit(0);
        Ok(())
    } else {
        #[cfg(feature = "custom-protocol")]
        {
            let backup = ready
                .cache
                .join(format!("installed-before-{}", uuid::Uuid::new_v4()));
            crate::web_assets::DiskAssets::packaged()
                .backup_to(&backup.join("web"))
                .map_err(failure)?;
            std::fs::copy(std::env::current_exe()?, backup.join("DBFolio.exe"))?;
            package::verify_resources(&backup).map_err(failure)?;
            package::write_json(&backup.join("recovery.json"),&serde_json::json!({"version":env!("CARGO_PKG_VERSION"),"originalExecutable":std::env::current_exe()?,"databaseSnapshot":snapshot,"note":"完整退出后恢复 EXE 与 web；先核对本地数据库兼容性，安装登记可用原版安装包修复"})).map_err(failure)?;
        }
        // 已在下载后和此处分别验签；官方插件启动 NSIS 安装器后退出。
        ready.update.install(bytes).map_err(failure)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn channel_and_numeric_prerelease_order() {
        assert!(ensure_version("1.0.0-alpha.9", "1.0.0-alpha.10", "preview").is_ok());
        assert!(ensure_version("1.0.0-alpha.15", "1.0.0-alpha.14", "preview").is_err());
        assert!(ensure_version("1.0.0-alpha.15", "1.0.0-beta.1", "stable").is_err());
        assert!(ensure_version("1.0.0-alpha.15", "1.0.0", "stable").is_ok());
    }
    #[tokio::test]
    async fn backup_includes_committed_local_data() {
        let dir = tempfile::tempdir().unwrap();
        let store = crate::store::LocalStore::initialize_in(dir.path().join("data"))
            .await
            .unwrap();
        store.set_setting("check", "原值").await.unwrap();
        let path = dir.path().join("backup.db");
        store.backup_for_update(&path).await.unwrap();
        store.set_setting("check", "新值").await.unwrap();
        let connection = sqlx::SqlitePool::connect_with(
            sqlx::sqlite::SqliteConnectOptions::new()
                .filename(path)
                .read_only(true),
        )
        .await
        .unwrap();
        let value: String = sqlx::query_scalar("SELECT value FROM settings WHERE key='check'")
            .fetch_one(&connection)
            .await
            .unwrap();
        assert_eq!(value, "原值");
    }
}
