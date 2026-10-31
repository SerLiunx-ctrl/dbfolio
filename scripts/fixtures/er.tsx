import {createRoot} from 'react-dom/client';
import {FluentProvider,Button} from '@fluentui/react-components';
import {ErWorkspace} from '../../src/features/er/ErWorkspace';
import * as model from '../../src/features/er/model';
import {useTabStore,type ErTab} from '../../src/stores/useTabStore';
import {useSessionStore} from '../../src/stores/useSessionStore';
import {useSettingsStore} from '../../src/stores/useSettingsStore';
import {useEditGuard} from '../../src/stores/useEditGuard';
import {connectionBridge} from '../../src/ipc/connectionBridge';
import {AppToaster} from '../../src/app/toast';
import {buildTheme} from '../../src/theme';
import type {TableMeta,TableRef} from '../../src/ipc/types';
import '../../src/styles.css';import '../../src/compact.css';
const w=window as any,p=new URLSearchParams(location.search),engine=p.get('engine')??'mysql',mode=p.get('theme')??'light',zoom=Number(p.get('zoom')??1),schema=engine==='postgres'?'app':null;
document.documentElement.style.zoom=String(zoom);document.documentElement.dataset.oled=String(mode==='oled');useSettingsStore.setState({themeMode:mode as any});connectionBridge.isOffline=()=>false;
useSessionStore.setState({sessions:[{id:'er-session',name:'关系图验收',engine,readOnly:true,allowedDatabases:p.has('restricted')?['db']:undefined} as any]});
const column=(name:string,type='bigint')=>({name,rawType:type,ordinal:1,canonical:{kind:'unknown',raw:type} as const,nullable:true,autoIncrement:false,unsigned:false,comment:name+' 注释'});
const meta=(name:string,columns:string[],other={})=>({name,schema,kind:'table',comment:name+' 中文注释',columns:columns.map(n=>column(n,n==='title'?'varchar(128)':'bigint')),primaryKey:['tenant','id'],indexes:[],foreignKeys:[],...other} as TableMeta);
const users=meta('users',['tenant','id','parent_id','title','hidden1','hidden2'],{foreignKeys:[{name:'fk_self',columns:['tenant','parent_id'],refTable:engine==='sqlite'?'USERS':'users',refSchema:schema,refColumns:engine==='sqlite'?['','']:['tenant','id'],onDelete:'SET NULL',onUpdate:'NO ACTION'}]});
const orders=meta('orders',['tenant','id','user_id','title'],{foreignKeys:[{name:'fk_user',columns:['tenant','user_id'],refTable:'users',refSchema:schema,refColumns:['tenant','id'],onDelete:'CASCADE',onUpdate:'RESTRICT'},...(engine==='postgres'?[{name:'fk_audit',columns:['user_id'],refTable:'users',refSchema:'audit',refColumns:['id'],onDelete:'RESTRICT',onUpdate:'NO ACTION'}]:[]),...(p.has('external')?[{name:'fk_external',columns:['user_id'],refTable:'external_users',refDatabase:'other_db',refColumns:['id'],onDelete:'RESTRICT',onUpdate:'NO ACTION'}]:[])]});
const base=[users,orders,meta('isolated',['tenant','id','title']),...(engine==='postgres'?[meta('users',['id'],{schema:'audit',primaryKey:['id']})]:[])];
if(p.has('unsafe'))base.push(meta('危险<&"表',['字段<&"'],{comment:'<script>alert(1)</script> & 中文'}));
const refs:TableRef[]=(p.has('large')||p.has('medium'))?Array.from({length:p.has('large')?205:35},(_,i)=>({name:'table_'+i,schema,kind:'table'})):base.map(t=>({name:t.name,schema:t.schema,kind:t.kind,comment:t.comment}));
const tab:ErTab={id:'er',kind:'er',sessionId:'er-session',database:'db',title:'关系图',...(p.has('focus')?{focus:{table:'orders',schema,token:'first'}}:{})};
useTabStore.setState({tabs:[tab],activeId:tab.id});w.calls=[];w.exports=[];w.aiDelay=0;w.aiMode='normal';w.aiCandidates=[{name:'业务归属',from:model.tableKey('db',schema,'isolated'),to:model.tableKey('db',schema,'users'),columns:['tenant','id'],refColumns:['tenant','id'],confidence:'medium',reason:'复合键命名对应，需业务确认',warnings:['未检查数据行']}];w.model=model;w.tabs=useTabStore;w.guard=useEditGuard;w.concurrent=0;w.maxConcurrent=0;w.fixture={schema};
w.__TAURI_INTERNALS__={invoke:async(command:string,args:any)=>{w.calls.push({command,args:command==='er_export'?{path:args.path}:args});
 if(command==='ai_providers')return p.has('noai')?[]:[{id:'fake',name:'隔离模拟服务',model:'mock',isDefault:true}];
 if(command==='task_begin'||command==='task_release')return;
 if(command==='task_progress')return {message:'正在识别',processed:0,total:null,cancelRequested:!!w.cancelled};
 if(command==='task_cancel'){if(w.cancelError)throw {message:'模拟取消失败'};w.cancelled=true;return;}
 if(command==='er_ai_suggest'){await new Promise(r=>setTimeout(r,w.aiDelay));if(w.aiMode==='error')throw {message:'模拟服务失败'};return {checked:{candidates:w.aiCandidates,rejected:1,duplicates:1},fingerprint:'test',usage:{inputTokens:50,outputTokens:30,requests:1}};}
 if(command==='er_ai_verify'){if(w.aiMode==='stale')throw {message:'数据库结构已变化，请刷新元数据后重新识别'};return {checked:{candidates:args.request.candidates,rejected:0,duplicates:0},tables:base};}
 if(command==='meta_tables'){if(p.has('retry')&&!w.retryReady)throw Error('模拟目录读取失败');return refs;}
 if(command==='meta_table_detail'){w.concurrent++;w.maxConcurrent=Math.max(w.maxConcurrent,w.concurrent);await new Promise(r=>setTimeout(r,20));w.concurrent--;if(args.database!=='db')throw Error('无权读取引用库');if(p.has('denied')&&args.table==='isolated')throw Error('元数据权限不足');return base.find(t=>t.name===args.table&&(t.schema??null)===(args.schema??null))??meta(args.table,['tenant','id','title']);}
 if(command==='settings_get')return p.has('corrupt')?'not-json':localStorage.getItem(args.key);
 if(command==='settings_set'){if(w.failSave)throw Error('磁盘不可写');localStorage.setItem(args.key,args.value);return;}
 if(command==='plugin:dialog|save')return 'C:/test/graph.'+args.options.filters[0].extensions[0];
 if(command==='er_export'){w.exports.push(args);return;}
 throw Error(command);
}};
function App(){const t=useTabStore(s=>s.tabs.find(t=>t.kind==='er')) as ErTab;return <FluentProvider data-color-mode={mode==='light'?'light':'dark'} theme={buildTheme(mode!=='light','#2ca83b',mode==='oled'?'oled':'classic')} style={{height:100/zoom+'vh',display:'flex',flexDirection:'column'}}><AppToaster/><Button size="small" onClick={()=>useTabStore.getState().openEr('er-session','db',{table:'orders',schema})}>定位订单关联</Button><div style={{flex:1,minHeight:0}}><ErWorkspace tab={t} active/></div></FluentProvider>;}
createRoot(document.getElementById('root')!).render(<App/>);
