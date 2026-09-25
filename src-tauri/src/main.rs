// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(all(not(debug_assertions), not(feature = "custom-protocol")))]
compile_error!(
    "分发构建必须启用 custom-protocol 外置资源模式，请使用 npm run app:build 或 app:build:fast。"
);

fn main() {
    // 打包检查不启动窗口，也不访问会话、凭据或本地数据库。
    if std::env::args().any(|arg| arg == "--verify-resources") {
        #[cfg(not(feature = "custom-protocol"))]
        {
            eprintln!("开发模式不支持分发资源校验，请使用便携构建。");
            std::process::exit(2);
        }
        #[cfg(feature = "custom-protocol")]
        {
            if let Err(message) = dbfolio_lib::verify_resources() {
                eprintln!("{message}");
                std::process::exit(1);
            }
            return;
        }
    }
    dbfolio_lib::run()
}
