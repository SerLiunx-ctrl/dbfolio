import {createRoot} from 'react-dom/client';
import {FluentProvider,Button} from '@fluentui/react-components';
import {CreateTableWorkspace} from '../../src/features/table/CreateTableWorkspace';
import {TableWorkspace} from '../../src/features/table/TableWorkspace';
import {UnsavedChangesDialog} from '../../src/app/UnsavedChangesDialog';
import {AppToaster} from '../../src/app/toast';
import {useTabStore} from '../../src/stores/useTabStore';
import {useSessionStore} from '../../src/stores/useSessionStore';
import {connectionBridge} from '../../src/ipc/connectionBridge';
import {buildTheme} from '../../src/theme';
import {surfaceColors} from '../../src/appearance';
import '../../src/monaco';import '../../src/styles.css';import '../../src/compact.css';
const w=window as any,p=new URLSearchParams(location.search),engine=(p.get('engine')??'mysql') as 'mysql'|'postgres'|'sqlite',mode=p.get('theme')??'light';
document.documentElement.dataset.density='compact';document.documentElement.dataset.oled=String(mode==='oled');
const palette=surfaceColors(mode==='oled'?'oled':'aurora',mode!=='light');document.documentElement.style.setProperty('--dw-palette-surface',palette.surface);document.documentElement.style.setProperty('--dw-palette-border',palette.border);document.documentElement.style.setProperty('--dw-palette-ink',palette.foreground);
connectionBridge.isOffline=()=>false;w.calls=[];w.tabs=useTabStore;w.session=useSessionStore;
useSessionStore.setState({sessions:[{id:'s',name:'测试',engine,readOnly:p.has('readonly')} as any]});
const meta=()=>{const d=w.saved;return {name:d?.table??'parents',kind:'table',columns:d?d.columns.map((c:any,i:number)=>({...c,rawType:c.dataType,ordinal:i+1,canonical:{kind:'unknown',raw:c.dataType}})):[{name:'id',ordinal:1,rawType:'integer',canonical:{kind:'int',bits:32,unsigned:false},nullable:false,autoIncrement:false,unsigned:false}],primaryKey:d?d.columns.filter((c:any)=>c.primaryKey).map((c:any)=>c.name):['id'],indexes:[],foreignKeys:[],rawDdl:'CREATE TABLE test(id INT)'};};
w.__TAURI_INTERNALS__={invoke:async(c:string,a:any)=>{
 w.calls.push({c,a});
 if(c==='meta_storage_engines')return ['InnoDB','MyISAM'];if(c==='meta_charsets')return [{charset:'utf8mb4',defaultCollation:'utf8mb4_0900_ai_ci'}];if(c==='meta_collations')return ['utf8mb4_0900_ai_ci','utf8mb4_bin'];
 if(c==='meta_tables')return [{name:'parents',schema:engine==='postgres'?'public':null,kind:'table'}];
 if(c==='ddl_preview'){if(!a.spec.draft?.table)throw Error('表名不能为空');return ['CREATE TABLE '+a.spec.draft.table+' (id INTEGER PRIMARY KEY)'];}
 if(c==='ddl_apply'){await new Promise(r=>setTimeout(r,120));if(w.failSave)throw Error('模拟数据库拒绝建表');w.saved=a.spec.draft;return [];}
 if(c==='meta_table_detail')return meta();
 if(c==='meta_table_info')return {name:w.saved.table,database:'demo',schema:null,kind:'table',columnCount:w.saved.columns.length,indexCount:0,foreignKeyCount:0,primaryKey:[],extra:{}};
 if(c==='settings_get')return null;if(c==='settings_set')return;
 throw Error(c);
}};
useTabStore.getState().openCreateTable('s','demo',engine);
function App(){const {tabs,activeId}=useTabStore();return <FluentProvider theme={buildTheme(mode!=='light','#0f6cbd',mode==='oled'?'oled':'aurora')} data-color-mode={mode==='light'?'light':'dark'} style={{height:'100vh',display:'flex',flexDirection:'column'}}><AppToaster/><UnsavedChangesDialog/><div id="dw-overlay-root"/><div>{tabs.map(t=><Button key={t.id} size="small" onClick={()=>useTabStore.getState().setActive(t.id)}>{t.title}</Button>)}<Button size="small" onClick={()=>useTabStore.getState().openCreateTable('s','demo',engine)}>另建一张表</Button><Button size="small" onClick={()=>activeId&&useTabStore.getState().close(activeId)}>关闭页签</Button></div>{tabs.map(t=><div key={t.id} style={{display:t.id===activeId?'flex':'none',flex:1,minHeight:0}}>{t.kind==='createTable'?<CreateTableWorkspace tab={t}/>:t.kind==='table'?<TableWorkspace tab={t}/>:null}</div>)}</FluentProvider>;}createRoot(document.getElementById('root')!).render(<App/>);
