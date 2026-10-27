import {APP_RELEASE} from "../../src/app/releaseInfo";
import {createRoot} from 'react-dom/client';
import App from '../../src/App';
import {monaco} from '../../src/monaco';
import {registerSqlCompletion} from '../../src/features/query/sqlCompletion';
import {useSessionStore} from '../../src/stores/useSessionStore';
import {useTabStore} from '../../src/stores/useTabStore';
import {useWorkspace} from '../../src/stores/useWorkspace';
import {useSettingsStore} from '../../src/stores/useSettingsStore';
import {connectionBridge} from '../../src/ipc/connectionBridge';
import '../../src/styles.css';
import '../../src/compact.css';
import '../../src/motion.css';
const w=window as any, mode=new URLSearchParams(location.search).get('mode');
const records:any[]=['a','b'].map(id=>({id,name:'本机 '+id.toUpperCase(),engine:'mysql',host:'127.0.0.1',port:3306,username:'root',database:'db',readOnly:false,groupName:null,hasPassword:false,createdAt:'',updatedAt:''}));
let serial=0;
w.calls=[];w.sessions=useSessionStore;w.tabs=useTabStore;w.context={sessionId:'a',database:'db'};w.delayTables=0;
const outcomes=()=>[{name:w.context.database==='other'?'digital_new_table':'digital_config_asr',kind:'table'}, {name:'digital_new_table',kind:'table'}, {name:'odd`name',kind:'table'}, {name:'odd"name',kind:'table'}, {name:'odd]name',kind:'table'}];
w.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},transformCallback:()=>++serial,unregisterCallback:()=>{},invoke:async(command:string,args:any)=>{
 w.calls.push({command,args});
 if(command==='session_list')return records;
 if(command==='session_statuses')return records.map(s=>({sessionId:s.id,connected:true,serverVersion:'8.4'}));
 if(command==='session_update'){const i=records.findIndex(s=>s.id===args.id);return records[i]={...records[i],...args.input};}
 if(command==='session_create'||command==='session_duplicate'){const record={...records[0],...args.input,id:'new'+(++serial)};records.push(record);return record;}
 if(command==='settings_get')return null;
 if(command==='settings_set'||command==='settings_set_many'||command.startsWith('task_')||command==='updater_ready')return null;
 if(command==='system_accent_color')return '#0078d4';
 if(command==='meta_databases')return [{name:'db'},{name:'other'}];
 if(command==='meta_tables'){const result=outcomes();if(w.delayTables)await new Promise(resolve=>setTimeout(resolve,w.delayTables));return result;}
 if(command==='meta_table_detail')return {name:args.table,kind:'table',columns:[{name:'deleted',rawType:'int',nullable:false}],primaryKey:[],indexes:[],foreignKeys:[]};
 if(command==='plugin:event|listen')return ++serial;
 if(command==='plugin:event|unlisten')return;
 if(command==='plugin:window|available_monitors')return [];
 if(command==='plugin:window|inner_size')return {width:1400,height:900};
 if(command==='plugin:window|outer_position')return {x:0,y:0};
 if(command.startsWith('plugin:window|is_'))return false;
 if(command.startsWith('plugin:window|'))return;
 if(command==='updater_status')return {version:APP_RELEASE,distribution:'portable',preferences:{automatic:false,channel:'preview',proxy:null,lastCheck:0},readyVersion:null,logPath:''};
 throw Error('Unexpected IPC '+command);
}};
connectionBridge.isOffline=()=>false;
useSettingsStore.setState({themeMode:'light'});
useSessionStore.setState({sessions:records,activeSessionId:'a',statuses:{a:{sessionId:'a',connected:true,serverVersion:'8.4'},b:{sessionId:'b',connected:true,serverVersion:'8.4'}}});
useTabStore.setState({tabs:[{id:'qa',kind:'query',sessionId:'a',database:'db',title:'当前查询'}],activeId:'qa'});
const draft={sql:'SELECT 1;',database:'db',sessionId:'a',updatedAt:''};useWorkspace.setState({drafts:{qa:draft},saved:{qa:draft}});
if(mode==='completion'){
 const editor=monaco.editor.create(document.getElementById('root')!,{value:'',language:'sql',automaticLayout:true,wordBasedSuggestions:'off',quickSuggestions:false});
 const facade={...monaco,languages:{...monaco.languages,registerCompletionItemProvider:(language:string,provider:any)=>{w.provider=provider;return monaco.languages.registerCompletionItemProvider(language,provider);}}};
 registerSqlCompletion(editor,facade as typeof monaco,()=>w.context);w.editor=editor;w.monaco=monaco;
 w.complete=()=>w.provider.provideCompletionItems(editor.getModel(),editor.getPosition(),{triggerKind:0},{isCancellationRequested:false});
 document.getElementById('root')!.style.height='90vh';editor.layout();
}else createRoot(document.getElementById('root')!).render(<App/>);
