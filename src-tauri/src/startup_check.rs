//! 打包启动验收使用独立的新目录，仍走完整 Tauri、插件和前端启动链路。
use std::{path::{Path, PathBuf}, sync::OnceLock};

static PROFILE: OnceLock<PathBuf> = OnceLock::new();

pub fn prepare() -> std::io::Result<()> {
    let args: Vec<_> = std::env::args_os().collect();
    if args.get(1).is_none_or(|arg| arg != "--startup-check") {
        return Ok(());
    }
    if args.len() != 3 {
        return Err(std::io::Error::other("启动验收需要指定独立的新目录"));
    }
    let path = PathBuf::from(&args[2]);
    if !path.is_absolute() {
        return Err(std::io::Error::other("启动验收目录必须为绝对路径"));
    }
    // create_dir 拒绝已有目录，防止验收误用用户配置。
    std::fs::create_dir(&path)?;
    let path = path.canonicalize()?;
    PROFILE.set(path).map_err(|_| std::io::Error::other("启动验收重复初始化"))
}

pub fn profile() -> Option<&'static Path> {
    PROFILE.get().map(PathBuf::as_path)
}

pub fn frontend_ready() -> std::io::Result<()> {
    if let Some(path) = profile() {
        std::fs::write(path.join("frontend-ready.json"), serde_json::to_vec(&serde_json::json!({
            "version": env!("CARGO_PKG_VERSION"), "pid": std::process::id()
        }))?)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn runtime_updater_config_is_present_and_matches_signing_key() {
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let updater: tauri_plugin_updater::Config = serde_json::from_value(config["plugins"]["updater"].clone())
            .expect("正常启动前必须能解析更新插件配置，不能依赖打包时临时注入");
        assert_eq!(updater.pubkey.trim(), crate::update_package::PUBLIC_KEY.trim());
        assert!(!updater.dangerous_accept_invalid_certs);
        assert!(!updater.dangerous_insecure_transport_protocol);
        assert!(!updater.allow_downgrades);
    }
}
