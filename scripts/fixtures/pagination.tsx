import {createRoot} from 'react-dom/client';
import {FluentProvider} from '@fluentui/react-components';
import {TableDataPanel} from '../../src/features/table/TableDataPanel';
import {QueryWorkspace} from '../../src/features/query/QueryWorkspace';
import {UnsavedChangesDialog} from '../../src/app/UnsavedChangesDialog';
import {AppToaster} from '../../src/app/toast';
import {useSettingsStore} from '../../src/stores/useSettingsStore';
import {useSessionStore} from '../../src/stores/useSessionStore';
import {useTabStore} from '../../src/stores/useTabStore';
import {useWorkspace} from '../../src/stores/useWorkspace';
import {useAppTheme} from '../../src/theme';
import {connectionBridge} from '../../src/ipc/connectionBridge';
import type {DbValue, Engine, TableMeta} from '../../src/ipc/types';
import '../../src/monaco';
import '../../src/styles.css';
import '../../src/compact.css';
const w=window as any, params=new URLSearchParams(location.search), engine=(params.get('engine')??'mysql') as Engine;
const mode=params.get('mode')??'table';
useSettingsStore.setState({themeMode:(params.get('theme')??'light') as any,queryPageSize:50,interfaceStyle:'slate'});
document.documentElement.dataset.density='compact';
const columns:TableMeta['columns']=[{name:'id',ordinal:1,rawType:'bigint',canonical:{kind:'int',bits:64,unsigned:false},nullable:false,autoIncrement:false,unsigned:false},
 {name:'name',ordinal:2,rawType:'varchar(40)',canonical:{kind:'string'},nullable:false,autoIncrement:false,unsigned:false}];
const detail:TableMeta={name:'items',kind:'table',columns,primaryKey:['id'],indexes:[],foreignKeys:[]};
const tab:any={id:'t',kind:mode==='table'?'table':'query',sessionId:'s',database:'test',table:'items',title:'items',view:'data'};
w.calls=[];w.total=125;w.value='old';w.failNext=false;w.delay=0;w.script=false;w.workspace=useWorkspace;
let transaction:any=null;
w.loseTransaction=()=>{transaction=null;};
w.__TAURI_INTERNALS__={transformCallback:()=>1,unregisterCallback:()=>{},invoke:async(command:string,args:any)=>{
 w.calls.push({command,args});
 if(command==='settings_get')return null;
 if(command==='settings_set'||command==='settings_set_many'||command.startsWith('task_'))return null;
 if(command==='meta_databases')return [{name:'test'}];
 if(command==='meta_tables')return [{name:'items',kind:'table'}];
 if(command==='meta_table_detail')return detail;
 if(command==='grid_preview_changes')return ['UPDATE items SET name = ...'];
 if(command==='transaction_begin'){transaction={id:'tx',tabId:'t',sessionId:'s',database:args.database,statements:0};return transaction;}
 if(command==='transaction_status')return transaction;
 if(command==='transaction_finish'){transaction=null;return;}
 if(['query_execute','query_fetch_page','transaction_execute'].includes(command)){
   if(w.delay)await new Promise(resolve=>setTimeout(resolve,w.delay));
   if(w.failNext){w.failNext=false;throw {code:'E_DB',message:'模拟分页失败'};}
   if(command==='transaction_execute'){if(!transaction)throw {message:'事务已结束'};transaction.statements++;}
   // 模拟 keyset 和 OFFSET 两条现有后端路径，不读取用户数据库。
   const cursor=/WHERE\s+["`]?id["`]?\s*>\s*(\d+)/i.exec(args.sql??'');
   const start=cursor?Number(cursor[1]):args.offset??0;
   const length=Math.max(0,Math.min(args.limit??50,w.total-start));
   const rows:DbValue[][]=Array.from({length},(_,i)=>[['int',String(start+i+1)],['text',w.value+String(start+i+1)]]);
   return {columns,rows,affected:null,...(w.script?{scriptStatements:2}:{})};
 }
 throw Error('Unexpected IPC '+command);
}};
connectionBridge.isOffline=()=>false;
connectionBridge.currentTab=()=>tab;
useSessionStore.setState({sessions:[{id:'s',name:'本机',engine,readOnly:false} as any],statuses:{s:{connected:true,serverVersion:'test'} as any},activeSessionId:'s'});
useTabStore.setState({tabs:[tab],activeId:tab.id});
useWorkspace.setState({drafts:{t:{sql:'SELECT id, name FROM items',database:'test',sessionId:'s',updatedAt:''}}});
function App(){const {theme,dark}=useAppTheme();return <FluentProvider theme={theme} data-pagination-root data-style="slate" data-color-mode={dark?'dark':'light'} style={{height:'100vh',display:'flex',flexDirection:'column'}}>
 {mode==='table'?<TableDataPanel tab={tab} active detail={detail} engine={engine} readOnly={false} onChanged={()=>{}}/>:<QueryWorkspace tab={tab} active/>}
 <UnsavedChangesDialog/><AppToaster/>
</FluentProvider>;}
createRoot(document.getElementById('root')!).render(<App/>);
