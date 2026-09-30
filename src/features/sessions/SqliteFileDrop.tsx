import {useEffect, useRef, useState} from 'react';
import {tokens} from '@fluentui/react-components';
import {getCurrentWebview, type DragDropEvent} from '@tauri-apps/api/webview';
import {api} from '../../ipc';
import {useNotify} from '../../app/toast';
import {useSessionStore} from '../../stores/useSessionStore';

export interface SqliteFileDraft {path:string;name:string;requestId:string}
export const sqliteDropEvents={listen:(handler:(event:DragDropEvent)=>void)=>getCurrentWebview().onDragDropEvent(event=>handler(event.payload))};
export function uniqueSessionName(name:string,names:string[]) {
  const base=name.trim()||'SQLite', existing=new Set(names.map(n=>n.toLocaleLowerCase()));
  let candidate=base, suffix=2;
  while(existing.has(candidate.toLocaleLowerCase())) candidate=`${base} (${suffix++})`;
  return candidate;
}
export function SqliteFileDrop({onFile,contextKey}:{onFile:(file:SqliteFileDraft)=>void;contextKey:string}) {
  const notify=useNotify(),callback=useRef(onFile),context=useRef({key:contextKey,version:0});
  callback.current=onFile;
  if(context.current.key!==contextKey)context.current={key:contextKey,version:context.current.version+1};
  const [hover,setHover]=useState(false),[busy,setBusy]=useState(false);
  useEffect(()=>{
    let alive=true,pending=false,unlisten:(()=>void)|undefined;
    const allowed=()=>[...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].every(el=>el.getAttribute('data-sqlite-drop-allowed')==='true');
    const handle=async(event:DragDropEvent)=>{
      if(!alive)return;
      if(event.type==='enter'||event.type==='over'){setHover(allowed());return;}
      setHover(false);
      if(event.type!=='drop')return;
      if(!allowed()){notify.error('请先完成或关闭当前对话框，再拖入数据库文件','无法填入会话');return;}
      if(pending){notify.error('正在识别文件，请稍候','文件识别中');return;}
      if(event.paths.length!==1){notify.error('请一次拖入一个 SQLite 数据库文件','无法识别文件');return;}
      pending=true;setBusy(true);const version=context.current.version;
      try{
        const file=await api.inspectSqliteFile(event.paths[0]);
        if(!alive)return;
        if(context.current.version!==version||!allowed())throw Error('会话编辑状态已变化，请重新拖入文件');
        const name=uniqueSessionName(file.name,useSessionStore.getState().sessions.map(s=>s.name));
        callback.current({...file,name,requestId:crypto.randomUUID()});
      }catch(error){if(alive)notify.error(error,'文件识别失败');}
      finally{pending=false;if(alive)setBusy(false);}
    };
    void sqliteDropEvents.listen(event=>void handle(event)).then(stop=>{if(alive)unlisten=stop;else stop();}).catch(error=>{if(alive)notify.error(error,'文件拖入初始化失败');});
    return()=>{alive=false;unlisten?.();};
  },[notify]);
  return (hover||busy)?<div role="status" style={{position:'fixed',inset:6,zIndex:100000,pointerEvents:'none',border:`2px solid ${tokens.colorBrandStroke1}`,borderRadius:6,display:'flex',justifyContent:'center',alignItems:'flex-start'}}><span style={{marginTop:10,padding:'6px 12px',fontSize:12,background:tokens.colorNeutralBackground1,color:tokens.colorBrandForeground1,border:`1px solid ${tokens.colorBrandStroke1}`,borderRadius:4}}>{busy?'正在识别 SQLite 文件…':'松开以填入 SQLite 会话'}</span></div>:null;
}
