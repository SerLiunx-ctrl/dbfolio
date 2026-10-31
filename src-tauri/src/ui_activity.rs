use std::sync::atomic::{AtomicBool, Ordering};
static INACTIVE: AtomicBool = AtomicBool::new(false);
#[tauri::command]
pub fn ui_inactive() -> bool { INACTIVE.load(Ordering::Relaxed) }

#[cfg(windows)]
fn desktop_inactive() -> Option<bool> {
    use std::ffi::c_void;
    #[link(name="user32")]
    unsafe extern "system" {
        fn OpenInputDesktop(flags:u32, inherit:i32, access:u32)->*mut c_void;
        fn GetUserObjectInformationW(handle:*mut c_void,index:i32,info:*mut c_void,len:u32,needed:*mut u32)->i32;
        fn CloseDesktop(handle:*mut c_void)->i32;
        fn GetThreadDesktop(thread:u32)->*mut c_void;
    }
    #[link(name="kernel32")]
    unsafe extern "system" { fn GetLastError()->u32; fn GetCurrentThreadId()->u32; }
    unsafe {
        let handle=OpenInputDesktop(0,0,1);
        if handle.is_null(){return if GetLastError()==5 {Some(true)} else {None};}
        let mut name=[0u16;256];let mut needed=0;
        let ok=GetUserObjectInformationW(handle,2,name.as_mut_ptr().cast(),512,&mut needed);
        CloseDesktop(handle);
        if ok==0{return None;}
        let end=name.iter().position(|v|*v==0).unwrap_or(name.len());
        // 比较应用所属桌面，而非硬编码 Default，兼容自定义交互桌面。
        let own=GetThreadDesktop(GetCurrentThreadId());
        let mut own_name=[0u16;256];
        if own.is_null()||GetUserObjectInformationW(own,2,own_name.as_mut_ptr().cast(),512,&mut needed)==0{return None;}
        let own_end=own_name.iter().position(|v|*v==0).unwrap_or(own_name.len());
        Some(!String::from_utf16_lossy(&name[..end]).eq_ignore_ascii_case(&String::from_utf16_lossy(&own_name[..own_end])))
    }
}

#[cfg(windows)]
pub fn start(window:&tauri::WebviewWindow) {
    use std::sync::Arc;
    use tauri::Emitter;
    let initial=desktop_inactive();
    tracing::info!(?initial,"原生交互桌面监测启动");
    if let Some(value)=initial { INACTIVE.store(value,Ordering::Relaxed); }
    let stopped=Arc::new(AtomicBool::new(false));let stop=stopped.clone();
    window.on_window_event(move|event|if matches!(event,tauri::WindowEvent::Destroyed){stop.store(true,Ordering::Relaxed)});
    let window=window.clone();
    std::thread::spawn(move||while !stopped.load(Ordering::Relaxed){
        if let Some(inactive)=desktop_inactive(){
            if INACTIVE.swap(inactive,Ordering::Relaxed)!=inactive {
                tracing::info!(inactive,version=env!("CARGO_PKG_VERSION"),"交互桌面状态变化");
                let _=window.emit("dw:ui-activity",inactive);
                let _=window.with_webview(move|webview|unsafe{
                    use windows_core::Interface;
                    use webview2_com::Microsoft::Web::WebView2::Win32::*;
                    if let Ok(core)=webview.controller().CoreWebView2(){
                        if let Ok(memory)=core.cast::<ICoreWebView2_19>(){
                            let level=if inactive{COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW}else{COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL};
                            if let Err(error)=memory.SetMemoryUsageTargetLevel(level){tracing::warn!(%error,"设置 WebView 内存目标失败");}
                        }
                    }
                });
            }
        }
        std::thread::sleep(std::time::Duration::from_secs(2));
    });
}

#[cfg(windows)]
pub fn diagnose(window:&tauri::WebviewWindow)->tauri::Result<()> {
    use windows_core::Interface;
    use webview2_com::{ProcessFailedEventHandler,Microsoft::Web::WebView2::Win32::*};
    let recovery=window.clone();
    window.with_webview(move|webview|unsafe{
        let result=(||->windows_core::Result<()>{
            let core=webview.controller().CoreWebView2()?;
            let handler=ProcessFailedEventHandler::create(Box::new(move|_,args|{
                if let Some(args)=args {
                    let mut kind=COREWEBVIEW2_PROCESS_FAILED_KIND(0);args.ProcessFailedKind(&mut kind)?;
                    let mut reason=COREWEBVIEW2_PROCESS_FAILED_REASON(0);let mut exit=0;
                    if let Ok(info)=args.cast::<ICoreWebView2ProcessFailedEventArgs2>(){let _=info.Reason(&mut reason);let _=info.ExitCode(&mut exit);}
                    tracing::error!(kind=kind.0,reason=reason.0,exit,inactive=ui_inactive(),version=env!("CARGO_PKG_VERSION"),"WebView 进程异常");
                    if kind==COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED {
                        let window=recovery.clone();
                        // 原生对话框不依赖已崩溃的 JS；不静默重载或重复数据库操作。
                        std::thread::spawn(move||{
                            use tauri_plugin_dialog::{DialogExt,MessageDialogButtons};
                            let reload=window.dialog().message("界面渲染进程已退出。重新加载可能丢失未提交的数据修改；已执行的数据库操作不会自动重做。若有手动事务或后台任务，请先核对其状态。是否重新加载界面？")
                                .title("DBFolio 界面异常").buttons(MessageDialogButtons::OkCancelCustom("重新加载".into(),"暂不处理".into())).blocking_show();
                            if reload {if let Err(error)=window.reload(){tracing::error!(%error,"重新加载 WebView 失败");}}
                        });
                    }
                }
                Ok(())
            }));
            let mut token=0;core.add_ProcessFailed(&handler,&mut token)?;Ok(())
        })();
        if let Err(error)=result{tracing::error!(%error,"注册 WebView 异常诊断失败");}
    })
}
