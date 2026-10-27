import {useEffect,useState} from 'react';
import {api,normalizeError} from '../../ipc';
import type {DataTypeCatalog,Engine} from '../../ipc/types';
import {useSessionStore} from '../../stores/useSessionStore';

/** 每个结构面板只读取一次；切库/重连/手动刷新时重读，过期响应不能串入新会话。 */
export function useColumnTypeCatalog(sessionId:string,database:string,engine:Engine,revision?:unknown){
 const status=useSessionStore(s=>s.statuses[sessionId]);
 const [request,setRequest]=useState(0),[result,setResult]=useState<{scope:string;catalog?:DataTypeCatalog;error?:string}>();
 const scope=JSON.stringify([sessionId,database,engine,request,status?.connected,status?.serverVersion]);
 useEffect(()=>{let alive=true;setResult(undefined);
  if(!sessionId||status?.connected===false)return;
  void api.columnTypes(sessionId,database).then(catalog=>{if(alive)setResult({scope,catalog});}).catch(error=>{if(alive)setResult({scope,error:normalizeError(error).message});});
  return()=>{alive=false;};
 },[scope,sessionId,database,engine,status,revision]);
 const current=result?.scope===scope?result:undefined;
 return {catalog:current?.catalog,error:current?.error,refresh:()=>setRequest(v=>v+1),loading:!current&&status?.connected!==false};
}
