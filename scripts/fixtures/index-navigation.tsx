import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { FluentProvider } from '@fluentui/react-components';
import { TableWorkspace } from '../../src/features/table/TableWorkspace';
import { CreateTableWorkspace } from '../../src/features/table/CreateTableWorkspace';
import { newColumn, newTableState } from '../../src/features/table/createTableDraft';
import { buildTheme } from '../../src/theme';
import { useSettingsStore } from '../../src/stores/useSettingsStore';
import { useSessionStore } from '../../src/stores/useSessionStore';
import { useTabStore } from '../../src/stores/useTabStore';
import { connectionBridge } from '../../src/ipc/connectionBridge';
import '../../src/styles.css';
import '../../src/compact.css';

const w = window as any, params = new URLSearchParams(location.search);
const engine = (params.get('engine') ?? 'mysql') as 'mysql'|'postgres'|'sqlite';
const mode = params.get('theme') ?? 'light';
const target = '名字.列"[]';
useSettingsStore.setState({themeMode:mode as any});
document.documentElement.dataset.oled = String(mode === 'oled');
document.documentElement.dataset.density = 'compact';
connectionBridge.isOffline = () => false;
useSessionStore.setState({sessions:[{id:'s',name:'隔离测试',engine,readOnly:params.has('readonly')} as any]});
const columns = Array.from({length:70},(_,i)=>({name:i===0?'id':i===65?target:`column_${i}`,ordinal:i+1,rawType:'varchar(80)',nullable:true,autoIncrement:false,unsigned:false}));
const detail = {name:'items',kind:'table',columns,primaryKey:[],indexes:[
  {name:'idx_target',unique:false,columns:[{name:target,prefixLen:10,desc:true},{name:'id'}],method:'BTREE'},
  {name:'idx_expression',unique:false,columns:[{name:'lower(column_1)'}],method:'BTREE'},
],foreignKeys:[{name:'fk_owner',columns:['id'],refTable:'parents',refColumns:['id'],onDelete:'NO ACTION',onUpdate:'NO ACTION'}],rawDdl:''};
const draft = newTableState(engine);
draft.properties.name = 'new_items';
draft.columns = columns.map(c=>({...newColumn(engine,c.name),dataType:c.rawType}));
draft.indexes = [{name:'idx_target',unique:false,columns:[{name:target},{name:'id'}]}];
draft.foreignKeys=[{name:'fk_owner',columns:['id'],refTable:'parents',refSchema:engine==='postgres'?'public':null,refColumns:['id'],onDelete:'NO ACTION',onUpdate:'NO ACTION'}];
const draftTab:any={id:'draft',kind:'createTable',sessionId:'s',database:'db',draft,title:'新建表*'};
useTabStore.setState({tabs:[draftTab],activeId:'draft'});
w.calls=[];w.target=target;w.tabs=useTabStore;
w.__TAURI_INTERNALS__={invoke:async(command:string,args:any)=>{
  w.calls.push({command,args});
  if(command==='meta_table_detail')return {...detail,name:args.table};
  if(command==='meta_column_types')return {engine,serverVersion:'fixture',types:[]};
  if(command==='meta_storage_engines')return ['InnoDB'];
  if(command==='meta_charsets')return [{charset:'utf8mb4',defaultCollation:'utf8mb4_bin'}];
  if(command==='meta_collations')return ['utf8mb4_bin'];
  if(command==='settings_get'){ if(params.has('late'))return new Promise(resolve=>{w.releaseWidths=resolve;}); return JSON.parse(localStorage.getItem('schema-width-fixture')??'{}')[args.key]??null; }
  if(command==='settings_set'){const saved=JSON.parse(localStorage.getItem('schema-width-fixture')??'{}');saved[args.key]=args.value;if(params.has('holdSave'))return new Promise(resolve=>{w.releaseSave=()=>{localStorage.setItem('schema-width-fixture',JSON.stringify(saved));resolve(null);};});localStorage.setItem('schema-width-fixture',JSON.stringify(saved));return;}
  if(command==='meta_tables')return [{name:'parents',schema:engine==='postgres'?'public':null,kind:'table'}];
  if(command.startsWith('task_'))return;
  throw Error(command);
}};
function Draft(){const tab=useTabStore(s=>s.tabs[0]);return <CreateTableWorkspace tab={tab as any}/>;}
function App(){
  const [table,setTable]=useState('items');w.switchTable=()=>setTable('other');
  return <FluentProvider theme={buildTheme(mode!=='light','#2ca83b',mode==='oled'?'oled':'aurora')} data-color-mode={mode==='light'?'light':'dark'} style={{height:'100vh',display:'flex',flexDirection:'column'}}>
    {params.has('draft')?<Draft/>:<TableWorkspace active tab={{id:table,kind:'table',sessionId:'s',database:'db',schema:engine==='postgres'?'public':null,table,view:params.has('structure')?'structure':'indexes',title:table}}/>}
  </FluentProvider>;
}
createRoot(document.getElementById('root')!).render(<App/>);
