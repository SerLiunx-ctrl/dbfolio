import {useEffect,useState} from 'react';
import {Button,Dialog,DialogSurface,DialogBody,DialogTitle,DialogContent,DialogActions,Spinner} from '@fluentui/react-components';
import {invoke} from '@tauri-apps/api/core';
import {api,normalizeError} from '../../ipc';
import {generationApi} from '../generation/model';
import {askQuery,schemaContext} from './queryAi';
import {streamedSql} from './streamSql';
export interface SqlEditRequest {mode:'format'|'optimize';sql:string;apply:(sql:string)=>void}
export function AiSqlEdit({request,sessionId,database,tabId,onClose}:{request:SqlEditRequest;sessionId:string;database:string;tabId:string;onClose:()=>void}){
 const [output,setOutput]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(true);
 useEffect(()=>{let alive=true,text='';void(async()=>{try{
  await invoke('query_validate_sql',{sessionId,sql:request.sql});
  const providers=await generationApi.providers(),provider=providers.find(p=>p.isDefault)??providers[0];
  if(!provider?.model)throw Error('请先在首选项中配置默认 AI 服务和模型。');
  const context=[];
  if(request.mode==='optimize'){
   const tables=await api.listTables(sessionId,database);
   const selected=tables.filter(t=>request.sql.toLowerCase().includes(t.name.toLowerCase()));
   if(selected.length>20)throw Error('涉及超过 20 张表，请缩小 SQL 选区。');
   for(const t of selected){if(!alive)return;context.push(schemaContext(await api.tableDetail(sessionId,database,t.name,t.schema)));}
  }
  if(!alive)return;
  const result=await askQuery({sessionId,database,providerId:provider.id,model:provider.model,mode:request.mode,prompt:request.mode==='format'?'格式化选中 SQL，保留语义和注释。':'优化选中 SQL，保持语义等价。',context,sql:request.sql,error:'',history:[],stream:true},e=>{if(alive&&e.kind==='delta'){text+=e.text;setOutput(streamedSql(text));}},tabId);
  if(!alive)return;if(result.validationError)throw Error(result.validationError);
  await invoke('query_validate_sql',{sessionId,sql:result.candidate.sql});
  if(alive)setOutput(result.candidate.sql);
 }catch(e){if(alive)setError(normalizeError(e).message);}finally{if(alive)setBusy(false);}})();return()=>{alive=false;};},[request,sessionId,database,tabId]);
 return <Dialog open onOpenChange={(_,d)=>{if(!d.open&&!busy)onClose();}}><DialogSurface style={{width:850,maxWidth:'90vw'}}><DialogBody><DialogTitle>{request.mode==='format'?'AI 格式化 SQL':'AI 优化 SQL'}</DialogTitle><DialogContent>
 {busy&&<Spinner size="tiny" label="正在处理…"/>}{error&&<div role="alert">{error}</div>}
 <pre style={{maxHeight:'55vh',overflow:'auto',whiteSpace:'pre-wrap',userSelect:'text'}}>{output}</pre>
 {output&&<div style={{fontSize:12}}>内容由 AI 生成，涉及修改的语句请仔细甄别！</div>}
 </DialogContent><DialogActions><Button disabled={busy} onClick={onClose}>关闭</Button><Button appearance="primary" disabled={busy||!!error||!output.trim()} onClick={()=>{try{request.apply(output);onClose();}catch(e){setError(normalizeError(e).message);}}}>替换选中 SQL</Button></DialogActions></DialogBody></DialogSurface></Dialog>;
}
