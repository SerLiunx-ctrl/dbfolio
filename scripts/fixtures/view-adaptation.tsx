import {createRoot} from 'react-dom/client';
import App from '../../src/App';import '../../src/monaco';
import {useSessionStore} from '../../src/stores/useSessionStore';import {useTabStore} from '../../src/stores/useTabStore';
import {useExplorerStore} from '../../src/stores/useExplorerStore';import {useSettingsStore} from '../../src/stores/useSettingsStore';
import {connectionBridge} from '../../src/ipc/connectionBridge';import {objectCapabilities} from '../../src/features/table/objectCapabilities';
import {APP_RELEASE} from '../../src/app/releaseInfo';import '../../src/styles.css';import '../../src/compact.css';import '../../src/motion.css';
const w=window as any,p=new URLSearchParams(location.search),engine=(p.get('engine')??'mysql') as 'mysql'|'postgres'|'sqlite',theme=p.get('theme')??'light',zoom=p.get('zoom')??'1',materialized=p.has('materialized'),table=p.has('table'),schema=engine==='postgres'?'public':null;
w.calls=[];w.tabs=useTabStore;w.explorer=useExplorerStore;w.capabilities=objectCapabilities;let serial=0;
const records:any[]=[{id:'s',name:'界面验收',engine,host:'127.0.0.1',port:3306,readOnly:p.has('readonly')},{id:'other',name:'另一会话',engine,readOnly:false}];
const columns:any[]=[{ordinal:1,name:'host',rawType:'varchar(255)',canonical:{kind:'string',len:255},nullable:true,unsigned:false,autoIncrement:false,defaultValue:null,comment:null},{ordinal:2,name:'used_bytes',rawType:'bigint',canonical:{kind:'int',bits:64,unsigned:false},nullable:false,unsigned:false,autoIncrement:false,defaultValue:null,comment:null}];
const catalog=[{name:'item_table',schema,kind:'table',engine:'InnoDB',sizeBytes:1024},{name:'item_view',schema,kind:'view'},{name:'another_view',schema,kind:'view'}];
const detail=(name:string)=>({name,schema,kind:name==='item_table'?'table':'view',columns,primaryKey:name==='item_table'?['host']:[],foreignKeys:[],indexes:name==='item_table'||materialized?[{name:'idx_host',unique:false,columns:[{name:'host'}],method:'BTREE'}]:[],rawDdl:p.has('missingDdl')?null:name==='item_table'?'CREATE TABLE item_table(host VARCHAR(255))':materialized?'-- 根据服务器视图查询定义重建\nCREATE MATERIALIZED VIEW public.item_view AS SELECT host, used_bytes FROM item_table;':'CREATE VIEW item_view AS SELECT host, used_bytes FROM item_table;'});
const initialTab:any={id:'fixture-view',kind:'table',sessionId:'s',database:'dbA',schema,table:table?'item_table':'item_view',title:table?'item_table':'item_view',view:p.get('initial')??'data'};
w.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},transformCallback:()=>++serial,unregisterCallback:()=>{},invoke:async(command:string,args:any={})=>{
 w.calls.push({command,args});
 if(command==='session_list')return records;if(command==='session_statuses')return records.map(s=>({sessionId:s.id,connected:true,serverVersion:'fixture'}));
 if(command==='settings_get'){const cached=localStorage.getItem('fixture.'+args.key);if(cached!==null)return cached;if(args.key==='ui_theme')return theme;if(args.key==='ui_zoom')return zoom;if(args.key==='ui_motion_mode')return 'off';if(args.key==='workspace_v1')return JSON.stringify({version:1,tabs:[initialTab],activeId:initialTab.id,activeSessionId:'s'});return null;}
 if(command==='settings_set'){localStorage.setItem('fixture.'+args.key,args.value);return;}if(command==='settings_set_many'||command.startsWith('task_')||command==='updater_ready')return null;
 if(command==='system_accent_color')return '#0078d4';if(command==='ui_inactive')return false;
 if(command==='meta_databases')return [{name:'dbA'},{name:'dbB'}];if(command==='meta_tables')return catalog;
 if(command==='meta_table_detail')return detail(args.table);if(command==='meta_table_info'){const d=detail(args.table);return {name:args.table,database:args.database,schema,kind:d.kind,columnCount:2,indexCount:d.indexes.length,foreignKeyCount:0,primaryKey:d.primaryKey,autoIncrementColumn:null,extra:{engine:'InnoDB',charset:'utf8mb4',collation:'utf8mb4_bin'},rowEstimate:null};}
 if(command==='meta_column_types')return {engine,serverVersion:'fixture',types:[{name:'varchar',label:'varchar',description:'字符串',category:'字符',arguments:'length'},{name:'bigint',label:'bigint',description:'整数',category:'数值',arguments:'none'}]};if(command==='meta_storage_engines')return ['InnoDB'];if(command==='meta_charsets')return [{charset:'utf8mb4',defaultCollation:'utf8mb4_bin'}];if(command==='meta_collations')return ['utf8mb4_bin'];
 if(command==='query_execute'||command==='query_fetch_page')return {columns:columns.map(c=>({name:c.name,rawType:c.rawType})),rows:[[['text','localhost'],['int',24]],[['text','中文节点'],['int',48]]],affected:null};
 if(command==='plugin:event|listen')return ++serial;if(command==='plugin:event|unlisten')return;if(command==='plugin:window|available_monitors')return [];if(command==='plugin:window|inner_size')return {width:1500,height:1000};if(command==='plugin:window|outer_position')return {x:0,y:0};if(command.startsWith('plugin:window|is_'))return false;if(command.startsWith('plugin:window|'))return;
 if(command==='updater_status')return {version:APP_RELEASE,distribution:'portable',preferences:{automatic:false,channel:'preview',proxy:null,lastCheck:0},readyVersion:null,logPath:''};
 throw Error('Unexpected fixture IPC '+command);
}};
connectionBridge.isOffline=()=>false;useSessionStore.setState({sessions:records,activeSessionId:'s',statuses:{s:{sessionId:'s',connected:true},other:{sessionId:'other',connected:true}}});
useSettingsStore.setState({themeMode:theme as any,zoom:Number(zoom)});
useExplorerStore.setState({databases:{s:[{name:'dbA'},{name:'dbB'}],other:[{name:'dbA'}]},tables:{'tables:s:dbA':catalog,'tables:s:dbB':catalog,'tables:other:dbA':catalog}});
useTabStore.setState({tabs:[initialTab],activeId:initialTab.id});
createRoot(document.getElementById('root')!).render(<App/>);
