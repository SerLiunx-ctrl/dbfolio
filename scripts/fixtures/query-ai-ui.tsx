import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {FluentProvider,webLightTheme} from '@fluentui/react-components';
import '../../src/monaco';
import {SmartSqlPanel} from '../../src/features/query/SmartSqlPanel';
import {appendGeneratedSql} from '../../src/features/query/appendGeneratedSql';
import {monaco} from '../../src/monaco';
(window as any).monaco=monaco;
import {useSessionStore} from '../../src/stores/useSessionStore';
import {useTabStore} from '../../src/stores/useTabStore';
import {useEditGuard,usePendingEdit} from '../../src/stores/useEditGuard';
import {connectionBridge} from '../../src/ipc/connectionBridge';
import '../../src/styles.css';
const provider={id:'p',name:'模拟服务',model:'mock-sql',isDefault:true};
const tasks=new Map();(window as any).calls=[];(window as any).guard=useEditGuard;
(window as any).__TAURI_INTERNALS__={transformCallback:()=>1,unregisterCallback:()=>{},invoke:async(command:string,args:any)=>{
 (window as any).calls.push({command,args});
 if(command==='ai_providers')return (window as any).noProvider?[]:[{...provider,id:'other',isDefault:false},provider];
 if(command==='meta_tables')return [{name:'posts',kind:'table',schema:'public',comment:'文章'},{name:'categories',kind:'table',schema:'public',comment:'分类'}];
 if(command==='meta_table_detail'&&(window as any).metaFail)throw Error('读取结构失败');
 if(command==='meta_table_detail')return {name:args.table,schema:'public',comment:'表备注',columns:[{name:'id',rawType:'BIGINT',comment:'主键',nullable:false}],indexes:[],foreignKeys:[],rawDdl:'DO NOT SEND'};
 if(command==='task_begin'){tasks.set(args.id,false);return;}
 if(command==='task_cancel'){tasks.set(args.id,true);return;}
 if(command==='task_progress')return null;
 if(command==='task_release'){tasks.delete(args.id);return;}
 if(command==='query_ai'){
  const emit=(e:any)=>args.onEvent.onmessage(e);emit({kind:'delta',text:'{"sql":"SELECT'});await new Promise(r=>setTimeout(r,350));
  if((window as any).changeEditor)(window as any).setSql('SELECT user_edit');
  if((window as any).slow)await new Promise(r=>setTimeout(r,800));
  const text=(window as any).fail?'provider failed raw':JSON.stringify({sql:'SELECT 2 AS value'});emit({kind:'response',response:{text,diagnostic:'',status:200,truncated:false}});emit({kind:'finished'});
  if(tasks.get(args.taskId))throw {code:'E_CANCELLED',message:'已取消生成'};
  if((window as any).fail)throw {message:'模拟接口失败'};
  return {candidate:{risk:(window as any).aiRisk,sql:args.request.mode==='explain'?'':(window as any).unsafe?'DELETE FROM posts':'SELECT 2 AS value',explanation:'按选择的表结构生成。',assumptions:(window as any).assume?['分类 ID 与分类表 ID 关联属于推测']:[],questions:(window as any).structured?[{text:'如何定位文章？',options:['按 ID','按 slug'],requiresText:true},{text:'需要哪些字段？',options:['标题','分类'],multiple:true}]:(window as any).question?['有效文章的状态值是什么？']:[]},validationError:null,usage:{inputTokens:10,outputTokens:12}};
 }
 throw Error('Unexpected IPC '+command);
}};
useSessionStore.setState({sessions:[{id:'s',name:'测试',engine:'postgres'}] as any,statuses:{s:{connected:true,serverVersion:'16'}} as any,activeSessionId:'s'});
useTabStore.setState({tabs:[{id:'q',kind:'query',sessionId:'s',database:'db',title:'测试'}],activeId:'q'});
connectionBridge.currentTab=()=>useTabStore.getState().tabs[0];
function App(){const[sql,setSql]=useState('SELECT original');(window as any).setSql=setSql;usePendingEdit({tabId:'q',sessionId:'s',label:'SQL 草稿',save:async()=>{},discard:()=>{}},true);return <FluentProvider theme={webLightTheme}><div className="dw-smart-split" style={{height:500}}><textarea aria-label="原编辑器" value={sql} onChange={e=>setSql(e.target.value)}/><div className="dw-smart-side"><SmartSqlPanel tabId="q" sessionId="s" database="db" sql={sql} onClose={()=>{}} onAppend={text=>setSql(v=>appendGeneratedSql(v,text))}/></div></div></FluentProvider>}
createRoot(document.getElementById('root')!).render(<App/>);
