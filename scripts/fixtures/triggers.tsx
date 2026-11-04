import {monaco} from '../../src/monaco';
import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {Button,FluentProvider} from '@fluentui/react-components';
import {TriggersWorkspace} from '../../src/features/triggers/TriggersWorkspace';
import {triggerKey,type TriggerCatalog,type TriggerChange,type TriggerDefinition,type TriggerDraft,type TriggerItem} from '../../src/features/triggers/model';
import {useSessionStore} from '../../src/stores/useSessionStore';
import {useTabStore,type TriggerTab} from '../../src/stores/useTabStore';
import {useSettingsStore} from '../../src/stores/useSettingsStore';
import {useWorkspace} from '../../src/stores/useWorkspace';
import {useEditGuard} from '../../src/stores/useEditGuard';
import {useShortcutStore} from '../../src/stores/useShortcutStore';
import {UnsavedChangesDialog} from '../../src/app/UnsavedChangesDialog';
import {AppToaster} from '../../src/app/toast';
import {installBrowserGuards} from '../../src/app/browserGuards';
import {connectionBridge} from '../../src/ipc/connectionBridge';
import {buildTheme} from '../../src/theme';
import '../../src/styles.css';
import '../../src/compact.css';

const w=window as any,p=new URLSearchParams(location.search),engine=(p.get('engine')??'mysql') as 'mysql'|'postgres'|'sqlite',mode=p.get('theme')??'light',zoom=Number(p.get('zoom')??1),schema=engine==='postgres'?'public':null;
document.documentElement.style.zoom=String(zoom);document.documentElement.dataset.oled=String(mode==='oled');document.documentElement.dataset.density='compact';
useSettingsStore.setState({themeMode:mode as any,interfaceStyle:'classic',resolvedAccent:'#2ca83b'});
connectionBridge.isOffline=()=>false;connectionBridge.onFailure=()=>{};
useSessionStore.setState({sessions:[{id:'tr-session',name:'触发器隔离会话',engine,readOnly:p.has('readonly'),allowedDatabases:p.has('restricted')?['db']:undefined} as any],statuses:{'tr-session':{connected:true} as any},activeSessionId:'tr-session'});
const tab:TriggerTab={id:'triggers',kind:'triggers',sessionId:'tr-session',database:'db',title:'触发器 · db',...(p.has('scope')?{table:'items',schema}:{})};
useTabStore.setState({tabs:[tab],activeId:tab.id});w.tabs=useTabStore;w.guard=useEditGuard;w.sessions=useSessionStore;w.shortcuts=useShortcutStore;w.workspace=useWorkspace;w.monaco=monaco;w.calls=[];w.failApply=false;w.failPreview=false;w.failCatalog=false;
w.editor=()=>monaco.editor.getEditors().find(e=>e.getDomNode()?.closest('.dw-triggers-code'));
w.getSql=()=>w.editor()?.getModel()?.getValue();w.setSql=(text:string)=>w.editor()?.getModel()?.setValue(text);
const quote=(v:string)=>engine==='mysql'?'`'+v.replace(/`/g,'``')+'`':'"'+v.replace(/"/g,'""')+'"';
const body=engine==='mysql'?'BEGIN\n  SET NEW.value = COALESCE(NEW.value, 0);\nEND':'BEGIN\n  INSERT INTO audit_log(value) VALUES (NEW.value);\nEND';
const draft=(text=body):TriggerDraft=>({timing:'AFTER',events:['INSERT'],orientation:'ROW',body:text,functionSchema:engine==='postgres'?'public':null,functionName:engine==='postgres'?'audit_row':null});
const sqlFor=(c:TriggerChange)=>{const target=(c.schema?quote(c.schema)+'.':'')+quote(c.table),n=quote(c.name);return c.draft?`CREATE TRIGGER ${n} ${c.draft.timing} ${c.draft.events.join(' OR ')} ON ${target}\nFOR EACH ${c.draft.orientation}\n${engine==='postgres'?`EXECUTE FUNCTION ${quote(c.draft.functionSchema??'public')}.${quote(c.draft.functionName??'audit_row')}();`:c.draft.body+';'}`:`DROP TRIGGER ${n}${engine==='postgres'?' ON '+target:''};`;};
let items:TriggerItem[]=p.has('empty')?[]:[{name:'tr_items_audit',schema,table:'items',timing:'AFTER',event:'INSERT',enabled:engine==='postgres'?'O':null},{name:'tr_complex',schema,table:'items',timing:'BEFORE',event:'UPDATE',enabled:engine==='postgres'?'D':null},{name:'tr_other',schema,table:'audit_log',timing:'AFTER',event:'DELETE',enabled:engine==='postgres'?'O':null}];
const definitions=new Map<string,TriggerDefinition>();
for(const item of items){const simple=item.name!=='tr_complex',d=draft();if(item.name==='tr_other')d.events=['DELETE'];definitions.set(triggerKey(item),{sql:sqlFor({sessionId:tab.sessionId,database:'db',...item,draft:d,original:null,confirmed:false})+(simple?'':'\n-- 高级定义：保留参数、条件及原始环境'),draft:simple?d:null,warning:simple?'':'此触发器含高级选项，仅支持查看原始定义；请在查询中编辑。'});}
const catalog=():TriggerCatalog=>({items:structuredClone(items),functions:engine==='postgres'&&!p.has('nofunctions')?[{schema:'public',name:'audit_row'},{schema:'audit',name:'stamp_row'}]:[],targets:[{name:'items',schema,kind:'table'},{name:'audit_log',schema,kind:'table'},...(engine!=='mysql'?[{name:'items_view',schema,kind:'view' as const}]:[])],engine,version:engine==='mysql'?'MySQL 8.4 模拟':engine==='postgres'?'PostgreSQL 17 模拟':'SQLite 3.46 模拟'});
w.__TAURI_INTERNALS__={invoke:async(command:string,args:any)=>{
 w.calls.push({command,args:structuredClone(args)});
 if(command==='trigger_catalog'){if(w.failCatalog)throw {code:'E_SQL',message:'模拟目录读取失败'};return catalog();}
 if(command==='meta_tables')return catalog().targets;
 if(command==='trigger_definition'){const d=definitions.get(triggerKey(args));if(!d)throw {code:'E_SQL',message:'触发器不存在'};return structuredClone(d);}
 if(command==='trigger_preview'){
  if(w.failPreview)throw {code:'E_SQL',message:'模拟预览失败'};
  const c=args.request as TriggerChange;if(!c.name.trim()||!c.table)throw {message:'名称与对象必填'};
  if(c.draft?.events.includes('TRUNCATE')&&c.draft.orientation==='ROW')throw {message:'TRUNCATE 只允许语句级触发器'};
  return {statements:[...(c.original&&c.draft?[sqlFor({...c,draft:null})]:[]),sqlFor(c)],warning:engine==='mysql'?'DROP + CREATE 不能整体回滚，请核对原定义。':'保存前请核对触发器对象和事件。'};
 }
 if(command==='trigger_apply'){
  const c=args.request as TriggerChange;if(!c.confirmed)throw {message:'执行前需要确认'};
  if(w.failApply)throw {code:'E_SQL',message:'模拟数据库拒绝保存，草稿已保留'};
  const session=useSessionStore.getState().sessions[0];if(session.readOnly||(engine==='mysql'&&session.allowedDatabases))throw {message:'当前会话不允许写入触发器'};
  const key=triggerKey(c),existing=definitions.get(key);if((existing?.sql??null)!==c.original)throw {message:'触发器定义已变化，请刷新后重试'};
  items=items.filter(t=>triggerKey(t)!==key);
  if(c.draft){const item:TriggerItem={name:c.name,schema:c.schema,table:c.table,timing:c.draft.timing,event:c.draft.events.join(' OR '),enabled:engine==='postgres'?'O':null};items.push(item);definitions.set(key,{sql:sqlFor(c),draft:structuredClone(c.draft),warning:''});}else definitions.delete(key);
  return;
 }
 if(command==='settings_get')return localStorage.getItem(args.key);
 if(command==='settings_set'){localStorage.setItem(args.key,args.value);return;}
 if(command==='task_begin'||command==='task_release'||command==='task_cancel')return;
 if(command==='task_progress')return null;
 throw Error(command);
}};
installBrowserGuards();
function Bench(){const tabs=useTabStore(s=>s.tabs),activeId=useTabStore(s=>s.activeId),drafts=useWorkspace(s=>s.drafts);return <FluentProvider data-color-mode={mode==='light'?'light':'dark'} theme={buildTheme(mode!=='light','#2ca83b',mode==='oled'?'oled':'classic')} style={{height:100/zoom+'vh',display:'flex',flexDirection:'column'}}><AppToaster/><UnsavedChangesDialog/><div id="dw-overlay-root"/><nav style={{display:'flex',gap:5,flexShrink:0}}><Button size="small" onClick={()=>useTabStore.getState().setActive(tab.id)}>返回触发器</Button><Button size="small" onClick={()=>void useTabStore.getState().close(activeId??tab.id)}>关闭测试页签</Button></nav>{tabs.map(t=><div key={t.id} className="fixture-workspace" data-active={activeId===t.id} style={{display:activeId===t.id?'flex':'none',flex:1,minHeight:0,flexDirection:'column'}}>{t.kind==='triggers'?<TriggersWorkspace tab={t} active={activeId===t.id}/>:t.kind==='query'?<pre aria-label="查询草稿">{drafts[t.id]?.sql}</pre>:null}</div>)}</FluentProvider>;}
createRoot(document.getElementById('root')!).render(p.has('strict')?<StrictMode><Bench/></StrictMode>:<Bench/>);
