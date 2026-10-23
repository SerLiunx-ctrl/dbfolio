// 仅用于独立更新进程验收，不连接数据库、不启动 Tauri、不访问用户配置。
fn main() {
    let args:Vec<_>=std::env::args_os().collect();
    if args.iter().any(|a|a=="--verify-resources"){return;}
    let i=args.iter().position(|a|a=="--update-health").unwrap();
    let cache=std::path::Path::new(&args[i+1]);
    let mode=std::fs::read_to_string(cache.join("probe-mode")).unwrap_or_default();
    if mode=="before"{std::process::exit(5);}
    if mode=="after"{std::fs::write(cache.join("data-opened.json"),"{}").unwrap();std::process::exit(6);}
    std::fs::write(cache.join("healthy.json"),"{}").unwrap();
}
