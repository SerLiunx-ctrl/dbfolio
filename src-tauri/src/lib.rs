#![allow(dead_code)]

mod browser_guards;
mod adapters;
mod commands;
mod error;
mod meta;
mod services;
mod state;
mod tasks;
mod store;
#[cfg(any(feature = "custom-protocol", test))]
mod web_assets;
#[cfg(test)]
mod acceptance_tests;
#[cfg(test)]
mod mysql_tools_acceptance;

use std::sync::OnceLock;
use tauri::Manager;
use tracing_subscriber::EnvFilter;

static LOG_GUARD: OnceLock<tracing_appender::non_blocking::WorkerGuard> = OnceLock::new();

fn init_tracing() {
    let dir = store::local::app_data_dir().join("logs");
    let _ = std::fs::create_dir_all(&dir);
    let appender = tracing_appender::rolling::daily(dir, "app.log");
    let (writer, guard) = tracing_appender::non_blocking(appender);
    let _ = LOG_GUARD.set(guard);

    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,sqlx=warn,tao=warn,wry=warn"));

    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(writer)
        .with_ansi(false)
        .try_init();
}

#[cfg(feature = "custom-protocol")]
pub fn verify_resources() -> Result<(), String> {
    web_assets::DiskAssets::packaged().validate()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_tracing();

    #[cfg(feature = "custom-protocol")]
    let context = tauri::generate_context!(assets = web_assets::DiskAssets::packaged());
    #[cfg(not(feature = "custom-protocol"))]
    let context = tauri::generate_context!();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            #[cfg(feature = "custom-protocol")]
            if let Err(message) = verify_resources() {
                use tauri_plugin_dialog::DialogExt;
                app.dialog().message(format!("{message}\n\n请完整解压 DBFolio 便携包或重新运行安装程序。"))
                    .title("DBFolio 资源不完整").blocking_show();
                return Err(std::io::Error::other(message).into());
            }
            let state = tauri::async_runtime::block_on(state::AppState::initialize())?;
            app.manage(state);
            #[cfg(windows)]
            if let Some(window) = app.get_webview_window("main") { browser_guards::configure(&window)?; }
            tracing::info!("DBFolio 启动");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::mysql_tools::sql_import_preview,
            commands::mysql_tools::sql_import_execute,
            commands::mysql_tools::mysql_objects,
            commands::mysql_tools::mysql_object_definition,
            commands::mysql_tools::mysql_object_apply,
            commands::mysql_tools::mysql_procedure_call,
            commands::query_ai::query_ai,
            commands::query_ai::query_validate_sql,
            commands::generation::ai_providers,
            commands::generation::ai_save,
            commands::generation::ai_remove,
            commands::generation::ai_models,
            commands::generation::ai_test,
            commands::generation::generation_describe,
            commands::generation::generation_generate,
            commands::generation::generation_preview,
            commands::generation::generation_release,
            commands::generation::generation_write,
            commands::generation::generation_export,
            commands::generation::generation_suggest,
            commands::generation::generation_template_read,
            commands::generation::generation_template_write,
            tasks::task_begin, tasks::task_cancel, tasks::task_progress, tasks::task_release,
            commands::session::session_health,
            commands::session::session_list,
            commands::session::session_create,
            commands::session::session_duplicate,
            commands::session::session_update,
            commands::session::session_delete,
            commands::session::session_test,
            commands::session::session_connect,
            commands::session::session_disconnect,
            commands::session::session_set_group,
            commands::session::session_statuses,
            commands::meta::meta_databases,
            commands::meta::meta_tables,
            commands::meta::meta_server_info,
            commands::meta::meta_database_info,
            commands::meta::meta_charsets,
            commands::meta::meta_storage_engines,
            commands::meta::meta_collations,
            commands::meta::meta_table_detail,
            commands::meta::meta_table_info,
            commands::manual_transaction::transaction_begin,
            commands::manual_transaction::transaction_status,
            commands::manual_transaction::transaction_execute,
            commands::manual_transaction::transaction_finish,
            commands::query::query_execute,
            commands::query::query_fetch_page,
            commands::query::query_cancel,
            commands::query::query_history_list,
            commands::query::query_history_search,
            commands::query::query_parameter_literals,
            commands::query::build_filter_clause,
            commands::query::query_explain,
            commands::analysis::analysis_query,
            commands::analysis::analysis_export,
            commands::query::cell_full_value,
            commands::query::update_cell,
            commands::query::grid_preview_changes,
            commands::query::grid_commit,
            commands::ddl::ddl_preview,
            commands::ddl::ddl_apply,
            commands::ddl::ddl_create_database,
            commands::ddl::ddl_drop_database,
            commands::app::settings_get,
            commands::app::local_data_stats,
            commands::app::local_data_set_retention,
            commands::app::local_data_clear_history,
            commands::app::local_data_compact,
            commands::sql_file::sql_file_read,
            commands::sql_file::sql_file_write,
            commands::app::settings_set,
            commands::app::settings_set_many,
            commands::app::system_accent_color,
            commands::app::clipboard_read_text,
            commands::app::clipboard_write_text,
            commands::transfer::export_data,
            commands::transfer::export_sql,
            commands::transfer::import_preview,
            commands::transfer::import_csv,
            commands::sync::sync_compare_schema,
            commands::sync::sync_preview_schema,
            commands::sync::sync_execute_schema,
            commands::sync::sync_compare_data,
            commands::sync::sync_execute_data,
            commands::mongodb::mongo_collections,
            commands::mongodb::mongo_find,
            commands::mongodb::mongo_next,
            commands::mongodb::mongo_release,
            commands::mongodb::mongo_document,
            commands::mongodb::mongo_write,
            commands::mongodb::mongo_inspect,
            commands::mongodb::mongo_create_index,
            commands::mongodb::mongo_transfer,
            commands::redis::redis_server_info,
            commands::redis::redis_databases,
            commands::redis::redis_command,
            commands::redis::redis_scan_keys,
            commands::redis::redis_key_preview,
            commands::redis::redis_edit,
            commands::redis::redis_delete_key,
            commands::redis::redis_delete_keys,
            commands::redis::redis_rename_key,
            commands::redis::redis_key_ttl,
        ])
        .run(context)
        .expect("error while running tauri application");
}
