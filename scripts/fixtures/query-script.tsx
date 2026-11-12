import {createRoot} from 'react-dom/client';
import {FluentProvider,webLightTheme} from '@fluentui/react-components';
import {QueryWorkspace} from '../../src/features/query/QueryWorkspace';
import {useSessionStore} from '../../src/stores/useSessionStore';
import {useWorkspace} from '../../src/stores/useWorkspace';
import {useTabStore} from '../../src/stores/useTabStore';
import {useSettingsStore} from '../../src/stores/useSettingsStore';
import {connectionBridge} from '../../src/ipc/connectionBridge';
import {monaco} from '../../src/monaco';
import '../../src/styles.css';
const w=window as any;
w.monaco=monaco;w.calls=[];
const script="SET @ddl = 'ALTER TABLE t ADD n INT';\nPREPARE stmt FROM @ddl;\nEXECUTE stmt;\nDEALLOCATE PREPARE stmt;\nSELECT * FROM t;";
w.__TAURI_INTERNALS__={transformCallback:()=>1,unregisterCallback:()=>{},invoke:async(command:string,args:any)=>{
 w.calls.push({command,args});
 if(command==='settings_get')return null;if(command==='settings_set'||command.startsWith('task_'))return;
 if(command==='meta_databases')return [{name:'test_db'}];if(command==='meta_tables')return [];
 if(command==='query_execute'){
  if(w.preflightFail)throw {code:'E_INVALID_INPUT',message:'脚本第 1 行预检失败：模拟失败；整段未执行'};
  if(w.fail)throw {code:'E_SQL_EXEC',message:'脚本第 3 条（第 3 行）失败：模拟失败。此前 2 条已处理，后续未执行；已完成写入或 DDL 不会自动回滚，请核对后再操作'};
  if(w.onlyAffected)return {columns:[],rows:[],affected:3};
  if(w.notices)return {columns:[],rows:[],affected:0,notices:['已跳过 disql 客户端显示指令 SET ECHO OFF','DM8_IMPORT_OK_AGENT']};
  return {columns:[{name:'n',rawType:'INT'}],rows:[[['int',1]],[['int',2]]],affected:0,...(args.sql.includes('PREPARE')?{scriptStatements:5}:{})};
 }
 if(command==='query_fetch_page')throw Error('脚本结果不得翻页重放');
 throw Error(command);
}};
connectionBridge.isOffline=()=>false;
useSettingsStore.setState({queryPageSize:2});
const engine=new URLSearchParams(location.search).get('engine')==='dameng'?'dameng':'mysql';
useSessionStore.setState({sessions:[{id:'s',name:'受限会话',engine,allowedDatabases:['test_db'],readOnly:false}] as any,statuses:{s:{connected:true,serverVersion:'8.4'}} as any,activeSessionId:'s'});
useTabStore.setState({tabs:[{id:'q',kind:'query',sessionId:'s',database:'test_db',title:'查询'}],activeId:'q'});
useWorkspace.setState({drafts:{q:{sql:script,database:'test_db',sessionId:'s',updatedAt:''}}});
createRoot(document.getElementById('root')!).render(<FluentProvider theme={webLightTheme}><div style={{height:'100vh',display:'flex',flexDirection:'column'}}><QueryWorkspace active tab={{id:'q',kind:'query',sessionId:'s',database:'test_db',title:'查询'}}/></div></FluentProvider>);
