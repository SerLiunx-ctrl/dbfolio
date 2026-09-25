import {useSessionReadOnly} from "../../stores/useSessionReadOnly";
import {InfoHint} from '../../common/InfoHint';
import {useState} from "react";
import {Button,Textarea,Dialog,DialogSurface,DialogBody,DialogTitle,DialogContent,DialogActions} from "@fluentui/react-components";
import {PlayRegular,HistoryRegular} from "@fluentui/react-icons";
import {api,normalizeError} from "../../ipc";
import type {RedisTab} from "../../stores/useTabStore";
import {parseRedisCommand} from "./parseCommand";
const READ_COMMANDS=new Set("PING GET MGET GETRANGE STRLEN TYPE TTL PTTL EXISTS SCAN HGET HMGET HLEN HSCAN LLEN LRANGE LINDEX SCARD SISMEMBER SSCAN ZCARD ZSCORE ZRANGE ZSCAN XLEN XRANGE INFO DBSIZE TIME".split(" "));
export function RedisConsole({tab}:{tab:RedisTab}){
 const readOnly=useSessionReadOnly(tab.sessionId);
 const [text,setText]=useState("PING"),[busy,setBusy]=useState(false),[history,setHistory]=useState<{command:string;result:string}[]>([]);
 const [confirm,setConfirm]=useState<string[]|null>(null);
 const db=Number(tab.database.replace(/^db/,""));
 const blocked=readOnly&&!READ_COMMANDS.has(text.trim().split(/\s+/)[0].toUpperCase());
 const run=async(args:string[],force=false)=>{if(readOnly&&!READ_COMMANDS.has((args[0]??"").toUpperCase())){setHistory(h=>[{command:text,result:"只读会话仅允许读取命令"},...h]);return;}setBusy(true);try{const result=await api.redisCommand(tab.sessionId,db,args,force);setHistory(h=>[{command:text,result:JSON.stringify(result,null,2)},...h].slice(0,100));setConfirm(null);}catch(e){const error=normalizeError(e);if(error.code==="E_DANGEROUS")setConfirm(args);else {setHistory(h=>[{command:text,result:error.message},...h].slice(0,100));setConfirm(null);}}finally{setBusy(false);}};
 return <div style={{padding:16,flex:1,minHeight:0,overflow:"auto",display:"flex",flexDirection:"column",gap:10}}>
 <strong>{tab.database} · 命令控制台</strong><InfoHint label="控制台说明">支持常用读写命令；写命令需确认。历史仅保留在当前页签内。</InfoHint>
 <Textarea value={text} rows={3} onChange={(_,d)=>setText(d.value)} placeholder={'GET "key name"'} onKeyDown={e=>{if(e.ctrlKey&&e.key==="Enter"&&!busy){try{void run(parseRedisCommand(text));}catch(err){setHistory(h=>[{command:text,result:String(err)},...h]);}}}}/>
 <div style={{display:"flex",gap:8,flexWrap:"wrap"}}><Button appearance="primary" icon={<PlayRegular/>} disabled={busy||blocked} title={blocked?"只读会话仅允许读取命令":undefined} onClick={()=>{try{void run(parseRedisCommand(text));}catch(err){setHistory(h=>[{command:text,result:String(err)},...h]);}}}>执行（Ctrl+Enter）</Button>
 {['PING','SCAN 0 COUNT 100','INFO','DBSIZE'].map(command=><Button key={command} size="small" onClick={()=>setText(command)}>{command}</Button>)}<Button onClick={()=>setHistory([])}>清空历史</Button></div>
 {history.map((item,i)=><section key={i} style={{padding:12,border:'1px solid var(--colorNeutralStroke2)',borderRadius:8}}><Button size="small" icon={<HistoryRegular/>} onClick={()=>setText(item.command)}>回填</Button><code style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>{item.command}</code><pre style={{maxHeight:300,overflow:"auto",whiteSpace:"pre-wrap",overflowWrap:"anywhere",userSelect:"text"}}>{item.result}</pre></section>)}
 <Dialog open={!!confirm} onOpenChange={(_,d)=>{if(!d.open&&!busy)setConfirm(null);}}><DialogSurface><DialogBody><DialogTitle>确认执行写命令</DialogTitle><DialogContent><p>目标：{tab.title} / {tab.database}</p><pre style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>{JSON.stringify(confirm)}</pre></DialogContent><DialogActions><Button disabled={busy} onClick={()=>setConfirm(null)}>取消</Button><Button disabled={busy||readOnly} appearance="primary" onClick={()=>confirm&&void run(confirm,true)}>确认执行</Button></DialogActions></DialogBody></DialogSurface></Dialog>
 </div>;
}
