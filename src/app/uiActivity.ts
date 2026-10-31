import {useEffect} from 'react';
import {create} from 'zustand';
import {listen} from '@tauri-apps/api/event';
import {invoke} from '@tauri-apps/api/core';
export const useUiActivity=create<{inactive:boolean}>(()=>({inactive:false}));
export function useUiActivityLifecycle(){
  useEffect(()=>{
    let alive=true,native=false,revision=0,unlisten:(()=>void)|undefined;
    const apply=()=>{if(alive)useUiActivity.setState({inactive:native||document.hidden});};
    document.addEventListener('visibilitychange',apply);
    void listen<boolean>('dw:ui-activity',event=>{revision++;native=event.payload;apply();}).then(async stop=>{
      if(!alive){stop();return;}unlisten=stop;const at=revision;
      const initial=await invoke<boolean>('ui_inactive');if(alive&&revision===at){native=initial;apply();}
    }).catch(error=>console.warn('界面活动状态监听不可用',error));
    apply();return()=>{alive=false;unlisten?.();document.removeEventListener('visibilitychange',apply);};
  },[]);
}
