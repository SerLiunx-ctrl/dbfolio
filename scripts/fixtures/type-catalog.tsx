import {useState} from 'react';import {createRoot} from 'react-dom/client';import {Button,FluentProvider} from '@fluentui/react-components';
import {ColumnsPanel} from '../../src/features/table/StructurePanel';import {CreateTableWorkspace} from '../../src/features/table/CreateTableWorkspace';import {ColumnDialog} from '../../src/features/table/ColumnDialog';
import {useTabStore} from '../../src/stores/useTabStore';import {useSessionStore} from '../../src/stores/useSessionStore';import {buildTheme} from '../../src/theme';import {AppToaster} from '../../src/app/toast';import {connectionBridge} from '../../src/ipc/connectionBridge';
import type {Engine} from '../../src/ipc/types';import '../../src/monaco';import '../../src/styles.css';import '../../src/compact.css';
const w=window as any,p=new URLSearchParams(location.search),engine=(p.get('engine')??'postgres') as Engine,mode=p.get('mode')??'columns',file=p.get('catalog')??'pg-vector';
const initial=await fetch('/.qa/alpha28-types/'+file+'.json').then(r=>r.json());
useSessionStore.setState({sessions:[{id:'s',engine,name:'类型能力测试',readOnly:false} as any],statuses:{s:{sessionId:'s',connected:true,serverVersion:initial.serverVersion}}});connectionBridge.isOffline=()=>false;
const detail:any={name:'items',kind:'table',columns:[{name:'id',ordinal:1,rawType:'bigint',canonical:{kind:'int',bits:64,unsigned:false},nullable:false,autoIncrement:false,unsigned:false}],primaryKey:[],indexes:[],foreignKeys:[],rawDdl:'CREATE TABLE items(id bigint NOT NULL)'};
w.calls=[];w.tabs=useTabStore;w.enabled=true;w.fail=false;
w.__TAURI_INTERNALS__={invoke:async(command:string,args:any)=>{w.calls.push({command,args});
 if(command==='meta_column_types'){if(w.fail)throw Error('模拟无权限读取类型');const name=engine==='postgres'?(args.database==='other'||!w.enabled?'pg-plain':'pg-vector'):file;await new Promise(r=>setTimeout(r,args.database==='other'?20:150));return fetch('/.qa/alpha28-types/'+name+'.json').then(r=>r.json());}
 if(command==='ddl_preview')return ['-- 验证参数'];if(command==='ddl_apply')return [];
 if(command==='meta_storage_engines')return ['InnoDB'];if(command==='meta_charsets')return [];if(command==='meta_collations')return [];if(command==='meta_tables')return [];if(command==='settings_get')return null;if(command==='settings_set')return null;
 throw Error(command);
}};
if(mode==='create')useTabStore.getState().openCreateTable('s','postgres',engine);
function Demo(){const [database,setDatabase]=useState('postgres'),[open,setOpen]=useState(true),tabs=useTabStore(s=>s.tabs);return <FluentProvider theme={buildTheme(p.has('oled'),'#0f6cbd',p.has('oled')?'oled':'aurora')} style={{minHeight:'100vh'}}><AppToaster/><Button onClick={()=>setDatabase(v=>v==='other'?'postgres':'other')}>切库</Button>{mode==='create'?tabs.map(t=>t.kind==='createTable'?<CreateTableWorkspace key={t.id} tab={t}/>:null):mode==='legacy'?<ColumnDialog open={open} mode="add" sessionId="s" database={database} table="items" engine={engine} onClose={()=>setOpen(false)} onDone={()=>{}}/>:<ColumnsPanel tab={{id:'t',kind:'table',sessionId:'s',database,table:'items',title:'items',view:'structure'}} detail={detail} engine={engine} readOnly={false} onChanged={()=>{}}/>}</FluentProvider>}
createRoot(document.getElementById('root')!).render(<Demo/>);
