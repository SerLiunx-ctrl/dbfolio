use tauri::State;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[tauri::command]
pub async fn settings_get(state: State<'_, AppState>, key: String) -> AppResult<Option<String>> {
    state.local.get_setting(&key).await
}

#[tauri::command]
pub async fn settings_set(
    state: State<'_, AppState>,
    key: String,
    value: String,
) -> AppResult<()> {
    state.local.set_setting(&key, &value).await
}

/// 读取系统剪贴板文本
#[tauri::command]
pub async fn settings_set_many(state: State<'_, AppState>, values: std::collections::BTreeMap<String, String>) -> AppResult<()> {
    state.local.set_settings(&values).await
}

/// 读取系统剪贴板文本
#[tauri::command]
pub fn clipboard_read_text() -> AppResult<String> {
    let mut clipboard = arboard::Clipboard::new()
        .map_err(|error| AppError::Internal(format!("剪贴板不可用: {error}")))?;
    clipboard
        .get_text()
        .map_err(|error| AppError::Internal(format!("读取剪贴板失败: {error}")))
}

/// 写入系统剪贴板文本
#[tauri::command]
pub fn clipboard_write_text(text: String) -> AppResult<()> {
    let mut clipboard = arboard::Clipboard::new()
        .map_err(|error| AppError::Internal(format!("剪贴板不可用: {error}")))?;
    clipboard
        .set_text(text)
        .map_err(|error| AppError::Internal(format!("写入剪贴板失败: {error}")))
}

/// 读取 Windows 系统强调色（十六进制 #rrggbb），失败时返回 None。
#[tauri::command]
pub fn system_accent_color() -> Option<String> {
    #[cfg(windows)]
    {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        if let Ok(dwm) = hkcu.open_subkey("Software\\Microsoft\\Windows\\DWM") {
            // AccentColor 以 0xAABBGGRR 存储
            if let Ok(value) = dwm.get_value::<u32, _>("AccentColor") {
                if value != 0 {
                    let r = (value & 0xFF) as u8;
                    let g = ((value >> 8) & 0xFF) as u8;
                    let b = ((value >> 16) & 0xFF) as u8;
                    return Some(format!("#{r:02x}{g:02x}{b:02x}"));
                }
            }
            // 回退：ColorizationColor 以 0xAARRGGBB 存储
            if let Ok(value) = dwm.get_value::<u32, _>("ColorizationColor") {
                let r = ((value >> 16) & 0xFF) as u8;
                let g = ((value >> 8) & 0xFF) as u8;
                let b = (value & 0xFF) as u8;
                return Some(format!("#{r:02x}{g:02x}{b:02x}"));
            }
        }
        None
    }
    #[cfg(not(windows))]
    {
        None
    }
}


#[tauri::command]
pub async fn local_data_stats(state: State<'_, AppState>) -> AppResult<crate::store::local::LocalDataStats> {
    state.local.local_data_stats().await
}
#[tauri::command]
pub async fn local_data_set_retention(state: State<'_, AppState>, limit: u32) -> AppResult<()> {
    state.local.set_history_limit(limit).await
}
#[tauri::command]
pub async fn local_data_clear_history(state: State<'_, AppState>, older_than_days: Option<u32>) -> AppResult<u64> {
    state.local.clear_query_history(older_than_days).await
}
#[tauri::command]
pub async fn local_data_compact(state: State<'_, AppState>) -> AppResult<()> {
    state.local.compact_local_data().await
}
