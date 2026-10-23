// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(all(not(debug_assertions), not(feature = "custom-protocol")))]
compile_error!(
    "分发构建必须启用 custom-protocol 外置资源模式，请使用 npm run app:build 或 app:build:fast。"
);

fn main() {
    let args: Vec<_> = std::env::args_os().collect();
    if args.len()==3 && (args[1]=="--apply-update" || args[1]=="--recover-update") {
        if let Err(message)=dbfolio_lib::update_package::helper(std::path::Path::new(&args[2]), args[1]=="--recover-update") {
            eprintln!("{message}");
            #[cfg(windows)] unsafe {
                #[link(name="user32")] unsafe extern "system" {fn MessageBoxW(hwnd:*mut std::ffi::c_void,text:*const u16,caption:*const u16,flags:u32)->i32;}
                let text:Vec<u16>=format!("更新未完成：{message}\n\n旧版及恢复材料已保留。请查看更新缓存目录的 error.json 和 journal.json。\n不要手动混用不同版本的 EXE 和 web 目录。").encode_utf16().chain(Some(0)).collect();
                let title:Vec<u16>="DBFolio 更新".encode_utf16().chain(Some(0)).collect();
                MessageBoxW(std::ptr::null_mut(),text.as_ptr(),title.as_ptr(),0x10);
            }
            std::process::exit(1);
        }
        return;
    }
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
