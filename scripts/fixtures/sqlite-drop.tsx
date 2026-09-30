import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {FluentProvider,Button} from '@fluentui/react-components';
import {SessionDialog} from '../../src/features/sessions/SessionDialog';
import {SqliteFileDrop,sqliteDropEvents,type SqliteFileDraft} from '../../src/features/sessions/SqliteFileDrop';
import {useTabPointerSort} from '../../src/app/useTabPointerSort';
import {emitTo} from '@tauri-apps/api/event';
import {useSessionStore} from '../../src/stores/useSessionStore';
import {buildTheme} from '../../src/theme';
import {AppToaster} from '../../src/app/toast';
import {installBrowserGuards} from '../../src/app/browserGuards';
import {api} from '../../src/ipc';
import '../../src/styles.css';import '../../src/compact.css';
const w=window as any;w.calls=[];w.messages=[];
const native=location.search.includes('native');
if(!native){
 sqliteDropEvents.listen=async handler=>{w.emitSqliteDrop=(paths:string[])=>handler({type:'drop',paths,position:{x:0,y:0} as any});return()=>{delete w.emitSqliteDrop;};};
}else w.emitSqliteDrop=(paths:string[])=>emitTo({kind:'Webview',label:'main'},'tauri://drag-drop',{paths,position:{x:0,y:0}});
const originalInvoke=w.__TAURI_INTERNALS__?.invoke;
const fixtureInvoke=async(command:string,args:any)=>{
 w.calls.push({command,args});
 if(command==='sqlite_file_inspect'){
  if(native)return originalInvoke(command,args);
  if(w.delayInspect)await new Promise(r=>setTimeout(r,600));
  if(args.path.includes('invalid'))throw {message:'未识别为 SQLite 数据库'};
  return {path:args.path,name:args.path.split('\\').pop().replace(/\.(db|sqlite3?)$/i,'')};
 }
 if(command==='session_create'){
  if(w.failSave)throw {message:'模拟保存失败'};
  return {...args.input,id:crypto.randomUUID(),createdAt:'',updatedAt:'',hasPassword:false};
 }
 if(command==='session_test')return {ok:true,serverVersion:'SQLite',steps:[]};
 if(command==='settings_set')return;
 if(command==='settings_get')return null;
 throw Error(command);
};
if(native){
 api.createSession=input=>fixtureInvoke('session_create',{input});
 api.settingsSet=(key,value)=>fixtureInvoke('settings_set',{key,value});
 api.settingsGet=key=>fixtureInvoke('settings_get',{key});
 api.testSession=input=>fixtureInvoke('session_test',{input});
}else w.__TAURI_INTERNALS__={invoke:fixtureInvoke};
installBrowserGuards();
const sample:any={id:'old',name:'demo',engine:'sqlite',filePath:'C:\\demo.db',hasPassword:false,readOnly:false,createdAt:'',updatedAt:''};
useSessionStore.setState({sessions:[sample]});
function SortTabs(){
 const [items,setItems]=useState(['a','b','c']),[selected,setSelected]=useState('');
 const sort=useTabPointerSort((id,target,after)=>setItems(previous=>{const next=previous.filter(i=>i!==id);next.splice(next.indexOf(target)+(after?1:0),0,id);return next;}));
 return <><div role="tablist" style={{display:'flex',userSelect:'none'}}>{items.map(id=><div key={id} role="tab" data-sort-tab={id} onPointerDown={e=>sort.start(e,id)} onClick={()=>{if(!sort.consumeClick())setSelected(id);}} style={{padding:12,width:140,border:'1px solid gray'}}>{id}<button onClick={e=>{e.stopPropagation();setItems(items.filter(i=>i!==id));}}>关闭 {id}</button></div>)}</div><span id="selected-tab">{selected}</span></>;
}
function Fixture(){
 const [open,setOpen]=useState(false),[edit,setEdit]=useState(false),[file,setFile]=useState<SqliteFileDraft|null>(null);
 const [saved,setSaved]=useState('');
 return <><Button onClick={()=>{setEdit(false);setFile(null);setOpen(true);}}>手动新建</Button><Button onClick={()=>{setEdit(true);setFile(null);setOpen(true);}}>编辑已有</Button><div id="saved">{saved}</div><SortTabs/>
 <SessionDialog open={open} session={edit?sample:null} folders={[]} sqliteFile={file} onClose={()=>{setOpen(false);setFile(null);}} onSaved={s=>setSaved(s.name)}/>
 <SqliteFileDrop contextKey={`${open}:${edit}`} onFile={f=>{setFile(f);setEdit(false);setOpen(true);}}/><AppToaster/>
 </>;
}
const oled=location.search.includes('oled');document.documentElement.dataset.density='compact';document.documentElement.dataset.oled=String(oled);
createRoot(document.getElementById('root')!).render(<FluentProvider theme={buildTheme(oled,'#0f6cbd',oled?'oled':'aurora')} data-color-mode={oled?'dark':'light'}><Fixture/></FluentProvider>);
