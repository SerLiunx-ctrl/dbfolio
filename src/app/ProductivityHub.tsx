import {InfoHint} from '../common/InfoHint';
import { toggleFocusMode } from "../stores/useFocusMode";
import { useObjectNavigation } from "../stores/useObjectNavigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions, Input, Spinner } from "@fluentui/react-components";
import { SearchRegular, HistoryRegular } from "@fluentui/react-icons";
import { HistoryCenter } from "../features/query/HistoryCenter";
import { useSessionStore } from "../stores/useSessionStore";
import { useTabStore } from "../stores/useTabStore";
import { useWorkspace } from "../stores/useWorkspace";
import { useObjectPreferences } from "../stores/useObjectPreferences";
import { loadLibrary, useLibrary } from "../stores/useLibrary";
import { api } from "../ipc";
import { openSql } from "../features/query/openSql";
import { useNotify } from "./toast";
import type { TableRef } from "../ipc/types";
interface IndexedTable { sessionId:string; database:string; table:TableRef }
interface Item { command?:boolean; id:string; label:string; detail:string; open:()=>Promise<void>|void }
export function ProductivityHub(){
  const sessions=useSessionStore(s=>s.sessions),tabs=useTabStore(s=>s.tabs),drafts=useWorkspace(s=>s.drafts),favorites=useObjectPreferences(s=>s.favorites),library=useLibrary();
  const [history,setHistory]=useState(false),[quick,setQuick]=useState(false),[text,setText]=useState(""),[selected,setSelected]=useState(0),[index,setIndex]=useState<IndexedTable[]>([]),[loading,setLoading]=useState(false),[opening,setOpening]=useState(false),[scope,setScope]=useState(""),[error,setError]=useState("");
  const notify=useNotify(),version=useRef(0);
  const cache=useRef(new Map<string,{at:number;tables:IndexedTable[];error:string}>());
  const [refreshIndex,setRefreshIndex]=useState(0);
  const connectionKey=useSessionStore(s=>JSON.stringify(Object.keys(s.statuses).filter(id=>s.statuses[id]).sort()));
  const commandMode=text.trimStart().startsWith(">");
  const searchObjects=Boolean(text.trim())&&!commandMode;
  useEffect(()=>{void loadLibrary().catch(e=>notify.error(e));const showHistory=()=>{setQuick(false);setHistory(true);};const key=(e:KeyboardEvent)=>{if(e.ctrlKey&&e.key.toLowerCase()==="p"){e.preventDefault();e.stopImmediatePropagation();setHistory(false);setQuick(true);setText("");setScope(useSessionStore.getState().activeSessionId??"");}};window.addEventListener("keydown",key,true);window.addEventListener("dw:history",showHistory);return()=>{window.removeEventListener("keydown",key,true);window.removeEventListener("dw:history",showHistory);};},[notify]);
  useEffect(()=>{
    if(!quick||!searchObjects){setIndex([]);setLoading(false);setError("");return;}
    const key=scope+connectionKey,hit=cache.current.get(key);
    if(hit&&Date.now()-hit.at<60000){setIndex(hit.tables);setError(hit.error);setLoading(false);return;}
    const id=++version.current;setIndex([]);setLoading(true);setError("");
    void (async()=>{const found:IndexedTable[]=[],errors:string[]=[];const state=useSessionStore.getState();
      for(const session of state.sessions.filter(s=>s.engine!=="redis"&&s.engine!=="mongodb"&&state.statuses[s.id]&&(!scope||scope===s.id))){
        if(id!==version.current)return;
        try{const dbs=await api.listDatabases(session.id);for(let i=0;i<dbs.length;i+=2){if(id!==version.current)return;await Promise.all(dbs.slice(i,i+2).map(async db=>{try{const tables=await api.listTables(session.id,db.name);found.push(...tables.map(table=>({sessionId:session.id,database:db.name,table})));}catch{errors.push(`${session.name}/${db.name}`);}}));}}
        catch{errors.push(session.name);}
      }
      if(id===version.current){const error=errors.length?`部分对象加载失败：${errors.join("、")}`:"";if(!error){if(cache.current.size>=8)cache.current.clear();cache.current.set(key,{at:Date.now(),tables:found,error});}setIndex(found);setError(error);setLoading(false);}
    })();return()=>{version.current++;};
  },[quick,scope,searchObjects,connectionKey,refreshIndex]);
  const activate=async(sessionId:string,action:()=>void)=>{const state=useSessionStore.getState();if(!state.statuses[sessionId])await state.connect(sessionId);state.setActiveSession(sessionId);action();window.dispatchEvent(new Event("dw:show-workspace"));};
  const items=useMemo(()=>{
    const commands:Item[]=[
      ["generation","数据生成","批量模板、规则生成与 AI 协助"],
      ["settings","打开首选项","外观、密度、缩放与快捷键"],
      ["layouts","工作区布局","保存当前布局、切换布局预设"],
      ["focus","切换专注模式","临时隐藏面板 · Ctrl+Shift+J"],
      ["reopen-tab","重新打开关闭的页签","恢复最近关闭的页签 · Ctrl+Shift+T"],
      ["tasks","打开任务中心","进度、失败详情与来源页签"],
      ["history","打开历史中心","查询历史与收藏"],
      ["about","关于与快捷键","版本、更新说明与诊断信息"],
    ].map(([id,label,detail])=>({id:"command:"+id,label,detail:"应用命令 · "+detail,command:true,open:()=>{requestAnimationFrame(()=>{if(id==="focus")toggleFocusMode();else window.dispatchEvent(new Event("dw:"+id));});}}));
    if(commandMode){const terms=text.trimStart().slice(1).toLowerCase().trim().split(/\s+/).filter(Boolean);return commands.filter(i=>terms.every(t=>(i.label+" "+i.detail).toLowerCase().includes(t)));}
    const result:Item[]=[];const name=(id:string)=>sessions.find(s=>s.id===id)?.name??"已删除连接";
    tabs.forEach(t=>result.push({id:`tab:${t.id}`,label:t.title,detail:(t.kind==="sync"||t.kind==="sqlExport")?"全局工具页签":`已打开页签 · ${name(t.sessionId)} / ${t.database}`,open:()=>(t.kind==="sync"||t.kind==="sqlExport")?(useTabStore.getState().setActive(t.id),void window.dispatchEvent(new Event("dw:show-workspace"))):activate(t.sessionId,()=>useTabStore.getState().setActive(t.id))}));
    const files=new Map(library.files.map(f=>[f.path,f]));Object.values(drafts).forEach(d=>{if(d.filePath)files.set(d.filePath,{path:d.filePath,sessionId:d.sessionId,database:d.database});});
    files.forEach(f=>result.push({id:`file:${f.path}`,label:f.path.split(/[\\/]/).pop()!,detail:`SQL 文件 · ${f.path}`,open:async()=>{const existing=tabs.find(t=>drafts[t.id]?.filePath===f.path);if(existing)return activate(existing.sessionId,()=>useTabStore.getState().setActive(existing.id));const sql=await api.sqlFileRead(f.path);if(sql===null)throw Error("SQL 文件已移动或删除");await openSql(f.sessionId,f.database,sql,f.path);}}));
    library.history.forEach(e=>result.push({id:`sql:${e.id}`,label:e.sql.replace(/\s+/g," ").slice(0,150),detail:`收藏 SQL · ${name(e.sessionId)} / ${e.database}`,open:()=>openSql(e.sessionId,e.database??"",e.sql)}));
    favorites.filter(f=>f.kind==="redis").forEach(f=>result.push({id:"redis:"+JSON.stringify(f),label:f.name,detail:"收藏 Redis 键 · "+name(f.sessionId)+" / "+f.database,open:()=>activate(f.sessionId,()=>{useTabStore.getState().openRedis(f.sessionId,f.database,name(f.sessionId)+" · "+f.database);useObjectNavigation.setState({request:{tabId:useTabStore.getState().activeId!,key:f.name}});})}));
    favorites.filter(f=>f.kind==="mongo").forEach(f=>result.push({id:`fav:${JSON.stringify(f)}`,label:f.name,detail:`收藏集合 · ${name(f.sessionId)} / ${f.database}`,open:()=>activate(f.sessionId,()=>useTabStore.getState().openMongo(f.sessionId,f.database,f.name))}));
    favorites.filter(f=>f.kind==="table").forEach(f=>result.push({id:`fav:${JSON.stringify(f)}`,label:f.name,detail:`收藏对象 · ${name(f.sessionId)} / ${f.database} / ${f.schema??""}`,open:()=>activate(f.sessionId,()=>useTabStore.getState().openTable({...f,table:f.name}))}));
    index.forEach(t=>result.push({id:`object:${t.sessionId}/${t.database}/${t.table.schema}/${t.table.name}`,label:t.table.name,detail:`${t.table.kind} · ${name(t.sessionId)} / ${t.database} / ${t.table.schema??""} · ${t.table.comment??""}`,open:()=>activate(t.sessionId,()=>useTabStore.getState().openTable({sessionId:t.sessionId,database:t.database,schema:t.table.schema,table:t.table.name}))}));
    result.push(...commands);
    const terms=text.toLowerCase().split(/\s+/).filter(Boolean);return result.filter(i=>terms.every(term=>(i.label+" "+i.detail).toLowerCase().includes(term))).slice(0,100);
  },[sessions,tabs,drafts,favorites,library,index,text,commandMode]);
  useEffect(()=>setSelected(0),[text,scope,items.length]);
  useEffect(()=>{if(quick)document.getElementById("dw-quick-option-"+selected)?.scrollIntoView({block:"nearest"});},[quick,selected]);
  const choose=async(item:Item)=>{if(opening)return;setOpening(true);try{if(item.command)setQuick(false);await item.open();setQuick(false);}catch(e){notify.error(e,"打开失败");}finally{setOpening(false);}};
  return <><Button size="small" appearance="subtle" icon={<HistoryRegular/>} onClick={()=>setHistory(true)}>历史中心</Button><Button size="small" appearance="subtle" icon={<SearchRegular/>} onClick={()=>{setScope(useSessionStore.getState().activeSessionId??"");setText("");setQuick(true);}}>快速打开 Ctrl+P</Button>
    <HistoryCenter open={history} onClose={()=>setHistory(false)}/>
    <Dialog open={quick} onOpenChange={(_,d)=>{if(!d.open&&!opening)setQuick(false);}}><DialogSurface style={{maxWidth:850,width:"92vw"}}><DialogBody><DialogTitle>快速打开</DialogTitle><DialogContent>
      <Input aria-label="搜索快速打开项目" aria-controls="dw-quick-results" aria-activedescendant={items[selected]?"dw-quick-option-"+selected:undefined} autoFocus style={{width:"100%"}} placeholder="搜索表、收藏、文件、页签；输入 > 搜索应用命令" value={text} onChange={(_,d)=>setText(d.value)} onKeyDown={e=>{if(e.key==="ArrowDown"){e.preventDefault();setSelected(n=>Math.min(items.length-1,n+1));}if(e.key==="ArrowUp"){e.preventDefault();setSelected(n=>Math.max(0,n-1));}if(e.key==="Enter"&&items[selected]){e.preventDefault();void choose(items[selected]);}}}/>
      {!commandMode&&<label>对象加载范围 <select className="dw-native-select" value={scope} onChange={e=>setScope(e.target.value)}><option value="">全部已连接会话</option>{sessions.filter(s=>s.engine!=="redis"&&s.engine!=="mongodb").map(s=><option value={s.id} key={s.id}>{s.name}</option>)}</select></label>}
      {!commandMode&&searchObjects&&<Button size="small" disabled={loading} onClick={()=>{cache.current.clear();setRefreshIndex(n=>n+1);}}>刷新对象索引</Button>}
      {!text.trim()&&<InfoHint label="搜索范围说明">输入关键词后加载数据库对象；页签、收藏与文件立即可用。输入 &gt; 切换到应用命令。</InfoHint>}
      {loading&&<Spinner size="tiny" label="加载表和视图；本地页签、收藏与文件可先打开"/>}{error&&<p role="alert">{error}</p>}
      <div id="dw-quick-results" role="listbox" aria-label="快速打开结果" style={{maxHeight:"50vh",overflowY:"auto",marginTop:10}}>{items.map((item,i)=><Button id={"dw-quick-option-"+i} role="option" aria-selected={i===selected} key={item.id} appearance={i===selected?"secondary":"subtle"} style={{display:"flex",width:"100%",justifyContent:"start",textAlign:"left",marginBottom:4}} disabled={opening} onClick={()=>void choose(item)}><span style={{minWidth:0,overflowWrap:"anywhere"}}><strong>{item.label}</strong><small style={{display:"block"}}>{item.detail}</small></span></Button>)}</div>
      <InfoHint label="快捷打开说明">↑↓ 选择，Enter 打开，Esc 关闭。显示前 100 项；对象索引缓存 60 秒，可手动刷新。SQL 文件覆盖曾打开/保存的文件；打开不会执行 SQL。</InfoHint>
    </DialogContent><DialogActions><Button disabled={opening} onClick={()=>setQuick(false)}>关闭</Button></DialogActions></DialogBody></DialogSurface></Dialog>
  </>;
}
