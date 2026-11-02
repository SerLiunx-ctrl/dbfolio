import {createRoot} from 'react-dom/client';
import {FluentProvider,Button} from '@fluentui/react-components';
import {DictionaryWorkspace} from '../../src/features/dictionary/DictionaryWorkspace';
import * as model from '../../src/features/dictionary/model';
import {useTabStore,type DictionaryTab} from '../../src/stores/useTabStore';
import {useSessionStore} from '../../src/stores/useSessionStore';
import {useSettingsStore} from '../../src/stores/useSettingsStore';
import {connectionBridge} from '../../src/ipc/connectionBridge';
import {buildTheme} from '../../src/theme';
import {SaveCommandBridge} from '../../src/app/SaveCommandBridge';
import {UnsavedChangesDialog} from '../../src/app/UnsavedChangesDialog';
import type {TableMeta} from '../../src/ipc/types';
import '../../src/styles.css';import '../../src/compact.css';
const w=window as any,params=new URLSearchParams(location.search),engine=(params.get('engine')??'mysql') as 'mysql'|'postgres'|'sqlite',mode=params.get('theme')??'light',zoom=Number(params.get('zoom')??1);
document.documentElement.dataset.density='compact';document.documentElement.dataset.oled=String(mode==='oled');useSettingsStore.setState({themeMode:mode as any});connectionBridge.isOffline=()=>false;
useSessionStore.setState({sessions:[{id:'s',engine,name:'字典验收',readOnly:true} as any]});
const tab:DictionaryTab={id:'dictionary-fixture',kind:'dictionary',sessionId:'s',database:'业务库',title:'数据字典'};useTabStore.setState({tabs:[tab],activeId:tab.id});
const col=(name:string,comment:string|null)=>({name,ordinal:1,rawType:'varchar(128)',canonical:{kind:'string' as const,len:128},nullable:false,defaultValue:"'中文'",autoIncrement:false,unsigned:false,comment});
const table=(name:string,schema:string|null,comment:string|null,kind:'table'|'view'='table'):TableMeta=>({name,schema,kind,columns:[col('id','编号'),{...col('业务字段',null),ordinal:2}],primaryKey:['id'],indexes:[{name:'idx_business',columns:[{name:'业务字段',desc:true,prefixLen:12}],unique:false,primary:false,method:'BTREE',comment:'索引注释'}],foreignKeys:[{name:'fk_parent',columns:['id','业务字段'],refSchema:schema,refTable:'parent',refColumns:['id','名称'],onDelete:'CASCADE',onUpdate:'NO ACTION'}],comment,rawDdl:engine==='postgres'&&kind==='table'?null:`CREATE ${kind==='view'?'VIEW':'TABLE'} "${name}" AS SELECT '<script>alert(1)</script>';`});
const tables=[table('users',engine==='postgres'?'app':null,'用户表'),table('orders',engine==='postgres'?'app':null,null),table('users','audit','审计用户'),table('用户视图',engine==='postgres'?'app':null,'用户视图','view')];
if(params.has('wide'))for(let i=0;i<499;i++)tables[0].columns.push({...col('宽字段'+i,null),ordinal:i+3});
if(params.has('large'))for(let i=0;i<50;i++)tables.push(table('extra_'+i,null,null));
w.model=model;w.tables=tables;w.calls=[];w.settings=new Map();w.failSave=false;w.failCollect=false;w.partial=false;w.delay=0;w.exports=[];
w.__TAURI_INTERNALS__={invoke:async(command:string,args:any)=>{w.calls.push({command,args});
 if(command==='settings_get')return w.settings.get(args.key)??null;
 if(command==='settings_set'){if(w.failSave)throw Error('模拟保存失败');w.settings.set(args.key,args.value);return;}
 if(command==='meta_tables')return tables.map(t=>({name:t.name,schema:t.schema,kind:t.kind,comment:t.comment}));
 if(command==='dictionary_collect'){await new Promise(r=>setTimeout(r,w.delay));if(w.failCollect)throw Error('模拟采集失败');return {engine,database:'业务库',serverVersion:'测试版',collectedAt:'2026-11-01T00:00:00Z',items:args.objects.map((r:any)=>{const meta=tables.find(t=>model.objectKey(t)===model.objectKey(r));return {...r,meta:w.partial&&r.name==='orders'?null:meta,error:w.partial&&r.name==='orders'?'没有读取权限':null};})};}
 if(command==='plugin:dialog|save')return `C:/fixture/字典.${args.options?.filters?.[0]?.extensions[0]??'md'}`;
 if(command==='dictionary_export'){w.exports.push(args);return JSON.stringify(args.document).length;}
 if(command==='clipboard_write_text')return;
 if(command.startsWith('task_'))return null;
 throw Error(command);
}};
function App(){const current=useTabStore(s=>s.tabs.find(t=>t.id===tab.id)) as DictionaryTab;return <FluentProvider theme={buildTheme(mode!=='light','#0f6cbd',mode==='oled'?'oled':'classic')} data-color-mode={mode==='light'?'light':'dark'} style={{height:'100vh',overflow:'hidden'}}><div style={{transform:`scale(${zoom})`,transformOrigin:'top left',width:`${100/zoom}%`,height:`${100/zoom}%`,display:'flex',flexDirection:'column'}}><Button size="small" onClick={()=>useTabStore.getState().openDictionary('s','业务库',{table:'users',schema:'audit'})}>定位审计表</Button><DictionaryWorkspace tab={current} active/><SaveCommandBridge tabId={tab.id} enabled onError={e=>console.error(e)}/></div><UnsavedChangesDialog/></FluentProvider>};createRoot(document.getElementById('root')!).render(<App/>);
