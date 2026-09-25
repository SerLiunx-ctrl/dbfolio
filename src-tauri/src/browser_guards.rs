#[cfg(windows)]
pub fn configure(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Settings3, ICoreWebView2Settings4, ICoreWebView2Settings5,
        ICoreWebView2Settings6,
    };
    use windows_core::Interface;
    window.with_webview(|webview| unsafe {
        let result = (|| -> windows_core::Result<()> {
            let settings = webview.controller().CoreWebView2()?.Settings()?;
            settings.SetAreDefaultContextMenusEnabled(false)?;
            settings.SetAreDevToolsEnabled(false)?;
            settings.SetIsStatusBarEnabled(false)?;
            settings.SetIsZoomControlEnabled(false)?;
            settings
                .cast::<ICoreWebView2Settings3>()?
                .SetAreBrowserAcceleratorKeysEnabled(false)?;
            if let Ok(s) = settings.cast::<ICoreWebView2Settings4>() {
                s.SetIsGeneralAutofillEnabled(false)?;
                s.SetIsPasswordAutosaveEnabled(false)?;
            }
            if let Ok(s) = settings.cast::<ICoreWebView2Settings5>() {
                s.SetIsPinchZoomEnabled(false)?;
            }
            if let Ok(s) = settings.cast::<ICoreWebView2Settings6>() {
                s.SetIsSwipeNavigationEnabled(false)?;
            }
            Ok(())
        })();
        if let Err(error) = result {
            tracing::error!(%error, "禁用 WebView 浏览器默认操作失败");
        }
    })
}
