import {InfoHint} from '../../common/InfoHint';
import { useEffect, useRef, useState } from "react";
import { Button, Checkbox, Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions, Input, Field, Spinner } from "@fluentui/react-components";
import { StarRegular, StarFilled, OpenRegular } from "@fluentui/react-icons";
import { api } from "../../ipc";
import type { HistoryEntry } from "../../ipc/types";
import { useSessionStore } from "../../stores/useSessionStore";
import { loadLibrary, toggleHistory, useLibrary } from "../../stores/useLibrary";
import { useNotify } from "../../app/toast";
import { openSql } from "./openSql";
export function HistoryCenter({open,onClose}:{open:boolean;onClose:()=>void}) {
  const sessions=useSessionStore(s=>s.sessions),saved=useLibrary(s=>s.history),notify=useNotify();
  const [text,setText]=useState(""),[sessionId,setSessionId]=useState(""),[database,setDatabase]=useState("");
  const [from,setFrom]=useState(""),[to,setTo]=useState(""),[result,setResult]=useState("");
  const [favorites,setFavorites]=useState(false),[rows,setRows]=useState<HistoryEntry[]>([]),[offset,setOffset]=useState(0),[more,setMore]=useState(false),[busy,setBusy]=useState(false),[opening,setOpening]=useState(false),[error,setError]=useState("");
  const version=useRef(0);
  useEffect(()=>{if(open)void loadLibrary().catch(e=>notify.error(e));},[open,notify]);
  useEffect(()=>{setOffset(0);},[text,sessionId,database,from,to,result,favorites]);
  useEffect(()=>{
    if(!open)return;const id=++version.current;setBusy(true);setError("");
    const timer=setTimeout(async()=>{try{
      if(from&&to&&from>to)throw Error("开始日期不能晚于结束日期");
      let list:HistoryEntry[];
      if(favorites){list=saved.filter(e=>(!sessionId||e.sessionId===sessionId)&&(!database||e.database===database)&&e.sql.toLowerCase().includes(text.toLowerCase())&&(!from||e.executedAt.slice(0,10)>=from)&&(!to||e.executedAt.slice(0,10)<=to)&&(!result||e.success===(result==="success"))).slice(offset,offset+101);}
      else list=await api.queryHistorySearch({text,sessionId,database,from,to,success:result?result==="success":undefined,offset});
      if(id===version.current){setRows(list.slice(0,100));setMore(list.length>100);}
    }catch(e){if(id===version.current){setRows([]);setMore(false);setError(e instanceof Error?e.message:String((e as {message?:string})?.message??e));}}
    finally{if(id===version.current)setBusy(false);}},250);
    return()=>{clearTimeout(timer);version.current++;};
  },[open,text,sessionId,database,from,to,result,favorites,offset,saved]);
  return <Dialog open={open} onOpenChange={(_,d)=>{if(!d.open&&!opening)onClose();}}><DialogSurface style={{maxWidth:1000,width:"94vw"}}><DialogBody>
    <DialogTitle>查询历史中心</DialogTitle><DialogContent style={{maxHeight:"70vh",overflowY:"auto"}}>
      <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:12}}>
        <Field label="搜索 SQL"><Input value={text} onChange={(_,d)=>setText(d.value)} /></Field>
        <Field label="连接"><select className="dw-native-select" value={sessionId} onChange={e=>setSessionId(e.target.value)}><option value="">全部连接</option>{sessions.filter(s=>s.engine!=="redis"&&s.engine!=="mongodb").map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
        <Field label="数据库（完整名称）"><Input value={database} onChange={(_,d)=>setDatabase(d.value)} /></Field>
        <Field label="开始日期（UTC）"><Input type="date" value={from} onChange={(_,d)=>setFrom(d.value)} /></Field>
        <Field label="结束日期（UTC）"><Input type="date" value={to} onChange={(_,d)=>setTo(d.value)} /></Field>
        <Field label="执行结果"><select className="dw-native-select" value={result} onChange={e=>setResult(e.target.value)}><option value="">全部结果</option><option value="success">成功</option><option value="error">失败</option></select></Field>
        <Checkbox label="仅收藏" checked={favorites} onChange={(_,d)=>setFavorites(!!d.checked)} />
      </div>
      <InfoHint label="历史保存说明">历史保留上限可在首选项的「本机数据」中调整；收藏另行保存。重新打开只填入新页签，不执行 SQL。</InfoHint>
      {busy?<Spinner size="small" label="搜索中"/>:error?<p role="alert">{error}</p>:!rows.length?<p>没有匹配记录</p>:rows.map(e=><section key={e.id} style={{borderBottom:"1px solid var(--colorNeutralStroke2)",padding:"10px 0"}}>
        <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}><span style={{flex:1}}>{sessions.find(s=>s.id===e.sessionId)?.name??"已删除连接"} · {e.database} · {e.success?"成功":"失败"} · <span title="后端数据库请求及结果读取耗时，不含前端通信和后续历史记录保存">后端查询 {e.durationMs??0} ms</span> · {e.executedAt}</span>
          <Button size="small" icon={saved.some(s=>s.id===e.id)?<StarFilled/>:<StarRegular/>} onClick={()=>void toggleHistory(e).catch(error=>notify.error(error))}>{saved.some(s=>s.id===e.id)?"取消收藏":"收藏"}</Button>
          <Button size="small" icon={<OpenRegular/>} disabled={opening} onClick={()=>{setOpening(true);void openSql(e.sessionId,e.database??"",e.sql).then(onClose).catch(error=>notify.error(error)).finally(()=>setOpening(false));}}>重新打开</Button></div>
        <pre style={{userSelect:"text",whiteSpace:"pre-wrap",overflowWrap:"anywhere",maxHeight:160,overflow:"auto"}}>{e.sql}</pre>{e.errorCode&&<div>{e.errorCode}</div>}
      </section>)}
    </DialogContent><DialogActions><Button disabled={!offset||busy} onClick={()=>setOffset(Math.max(0,offset-100))}>上一页</Button><span>第 {offset/100+1} 页</span><Button disabled={!more||busy} onClick={()=>setOffset(offset+100)}>下一页</Button><Button disabled={opening} onClick={onClose}>关闭</Button></DialogActions>
  </DialogBody></DialogSurface></Dialog>;
}
