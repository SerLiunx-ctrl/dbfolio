import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {FluentProvider,webLightTheme,Button} from '@fluentui/react-components';
import {QueryWorkspace} from '../../src/features/query/QueryWorkspace';
import {TableDataPanel} from '../../src/features/table/TableDataPanel';
import {UnsavedChangesDialog} from '../../src/app/UnsavedChangesDialog';
import {AppToaster} from '../../src/app/toast';
import {useSessionStore} from '../../src/stores/useSessionStore';
import {useTabStore} from '../../src/stores/useTabStore';
import {confirmEdits} from '../../src/stores/useEditGuard';
import {useWorkspace} from '../../src/stores/useWorkspace';
import {connectionBridge} from '../../src/ipc/connectionBridge';
import {monaco} from '../../src/monaco';import '../../src/styles.css';
const w=window as any;w.calls=[];w.monaco=monaco;w.value='old';let transaction:any=null;
const columns=['id','category_id'].map(name=>({name,rawType:'BIGINT',canonical:{kind:'int',bits:64,unsigned:false},nullable:false}));
const meta:any={name:'article',schema:'public',kind:'table',primaryKey:['id'],columns,indexes:[],foreignKeys:[{name:'fk_category',columns:['category_id'],refTable:'category',refSchema:'catalog',refColumns:['id']}]};
const result=()=>({columns:[{name:'id',rawType:'BIGINT'},{name:'name',rawType:'TEXT'}],rows:[[['int','9007199254740993'],['text',w.value]]],affected:null});
w.__TAURI_INTERNALS__={transformCallback:()=>1,unregisterCallback:()=>{},invoke:async(command:string,args:any)=>{
 w.calls.push({command,args});
 if(command==='settings_get')return localStorage.getItem(args.key);if(command==='settings_set'){localStorage.setItem(args.key,args.value);return;}
 if(command==='meta_databases')return [{name:'db'}];if(command==='meta_tables')return [{name:'article',schema:'public',kind:'table'},{name:'category',schema:'catalog',kind:'table'}];
 if(command==='meta_table_detail')return args.table==='category'?{...meta,name:'category',schema:'catalog',columns:[columns[0],{name:'name',rawType:'TEXT',canonical:{kind:'string'},nullable:false}],foreignKeys:[]}:meta;
 if(command==='build_filter_clause')return ' WHERE "id" = 13';
 if(command==='query_execute')return args.sql.includes('article')?{columns:columns.map(c=>({name:c.name,rawType:c.rawType})),rows:[[['int',1],['int',13]]],affected:null}:result();
 if(command==='query_fetch_page')return result();
 if(command==='transaction_begin'){transaction={id:crypto.randomUUID(),tabId:args.tabId,sessionId:args.sessionId,database:args.database,statements:0};return transaction;}
 if(command==='transaction_status')return transaction;
 if(command==='transaction_execute'){if(!transaction)throw {message:'事务已结束'};transaction.statements++;return result();}
 if(command==='transaction_finish'){transaction=null;return;}
 if(command.startsWith('task_'))return null;
 throw Error('Unexpected IPC '+command);
}};
w.loseTransaction=()=>{transaction=null;};w.closeTransaction=()=>confirmEdits(e=>e.kind==='transaction');
useSessionStore.setState({sessions:[{id:'s',name:'测试',engine:'postgres',readOnly:false}] as any,statuses:{s:{connected:true,serverVersion:'16'}} as any,activeSessionId:'s'});
useTabStore.setState({tabs:[{id:'q',kind:'query',sessionId:'s',database:'db',title:'测试'}],activeId:'q'});
useWorkspace.setState({drafts:{q:{sql:'SELECT 1 AS id',database:'db',sessionId:'s',updatedAt:''}}});
connectionBridge.currentTab=()=>useTabStore.getState().tabs[0];
function App(){const [table,setTable]=useState(location.search.includes('table'));return <FluentProvider theme={webLightTheme}><div style={{height:'100vh',display:'flex',flexDirection:'column'}}><Button onClick={()=>setTable(v=>!v)}>切换测试页面</Button>{table?<TableDataPanel tab={{id:'t',kind:'table',sessionId:'s',database:'db',schema:'public',table:'article',title:'article',view:'data',pinned:false}} detail={meta} engine="postgres" readOnly={true} onChanged={()=>{}}/>:<QueryWorkspace tab={{id:'q',kind:'query',sessionId:'s',database:'db',title:'查询'}}/>}<UnsavedChangesDialog/><AppToaster/></div></FluentProvider>;}
createRoot(document.getElementById('root')!).render(<App/>);
