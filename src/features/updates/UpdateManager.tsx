import {useEffect} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {Button,Dialog,DialogActions,DialogBody,DialogContent,DialogSurface,DialogTitle,ProgressBar,tokens} from '@fluentui/react-components';
import {UpdatePanel} from './UpdatePanel';
import {checkUpdate,loadUpdateStatus,useUpdateStore} from './updateStore';
export function UpdateManager(){
  const {open,notice,available,busy}=useUpdateStore();
  useEffect(()=>{
    const frame=requestAnimationFrame(()=>{void invoke('updater_ready').catch(()=>{});});
    const show=()=>{useUpdateStore.setState({open:true,notice:false});void checkUpdate();};
    window.addEventListener('dw:updates',show);
    const timer=window.setTimeout(()=>{void loadUpdateStatus().then(()=>{
      const prefs=useUpdateStore.getState().status?.preferences;
      if(prefs?.automatic&&Date.now()/1000-prefs.lastCheck>=86400)void checkUpdate(true);
    }).catch(()=>{});},20000);
    return()=>{cancelAnimationFrame(frame);clearTimeout(timer);window.removeEventListener('dw:updates',show);};
  },[]);
  return <>
    {notice&&available&&!open&&<aside role="status" style={{position:'fixed',bottom:38,right:16,zIndex:1000,padding:'6px 10px',display:'flex',alignItems:'center',gap:8,border:`1px solid ${tokens.colorBrandStroke1}`,borderRadius:6,background:tokens.colorNeutralBackground1,color:tokens.colorNeutralForeground1}}>
      <span>DBFolio {available.version} 可更新</span><Button size="small" onClick={()=>useUpdateStore.setState({open:true,notice:false})}>查看</Button><Button size="small" onClick={()=>useUpdateStore.setState({notice:false})}>稍后</Button>
    </aside>}
    <Dialog open={open} onOpenChange={(_,d)=>{if(busy!=='install')useUpdateStore.setState({open:d.open});}}>
      <DialogSurface style={{width:'min(700px,94vw)'}}><DialogBody><DialogTitle>软件更新</DialogTitle><DialogContent><UpdatePanel/></DialogContent><DialogActions><Button size="small" disabled={busy==='install'} onClick={()=>useUpdateStore.setState({open:false})}>关闭</Button></DialogActions></DialogBody></DialogSurface>
    </Dialog>
    <Dialog open={busy==='install'} modalType="alert"><DialogSurface><DialogBody><DialogTitle>正在准备更新</DialogTitle><DialogContent><p>正在保存工作区、备份本地配置并启动更新程序，请稍候。</p><ProgressBar aria-label="准备更新"/></DialogContent></DialogBody></DialogSurface></Dialog>
  </>;
}
