import {useCallback,useEffect,useRef,useState} from 'react';
import {mqApi,type MqCatalog} from './model';
export function refreshMq(sessionId:string,scope:string){window.dispatchEvent(new CustomEvent('dw:mq-refresh',{detail:{sessionId,scope}}));}
export function useCatalog(sessionId:string,scope?:string,enabled=true){
 const [catalog,setCatalog]=useState<MqCatalog|null>(null),[loading,setLoading]=useState(false),[error,setError]=useState('');const revision=useRef(0);
 const refresh=useCallback(async()=>{if(!enabled){setLoading(false);return;}const version=++revision.current;setLoading(true);setError('');try{const next=await mqApi.catalog(sessionId,scope);if(version===revision.current)setCatalog(next);}catch(e){if(version===revision.current)setError(String((e as {message?:string}).message??e));}finally{if(version===revision.current)setLoading(false);}},[sessionId,scope,enabled]);
 useEffect(()=>{setCatalog(null);},[sessionId,scope]);
 useEffect(()=>{void refresh();return()=>{revision.current++;};},[refresh]);
 useEffect(()=>{const listener=(e:Event)=>{const detail=(e as CustomEvent).detail;if(detail?.sessionId===sessionId&&(!scope||detail.scope===scope))void refresh();};window.addEventListener('dw:mq-refresh',listener);return()=>window.removeEventListener('dw:mq-refresh',listener);},[refresh,sessionId,scope]);
 return {catalog,loading,error,refresh};
}
