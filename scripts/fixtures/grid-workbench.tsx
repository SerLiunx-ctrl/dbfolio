import {SaveCommandBridge} from '../../src/app/SaveCommandBridge';
import {UnsavedChangesDialog} from '../../src/app/UnsavedChangesDialog';
import {useUiActivity} from '../../src/app/uiActivity';
import { createRoot } from 'react-dom/client';
import { createRef, useState } from 'react';
import { Button, FluentProvider } from '@fluentui/react-components';
import { EditableDataGrid, type EditableDataGridHandle } from '../../src/features/grid/EditableDataGrid';
import { ResultGrid } from '../../src/features/grid/ResultGrid';
import { TableDataPanel } from '../../src/features/table/TableDataPanel';
import { useSessionStore } from '../../src/stores/useSessionStore';
import { useEditGuard } from '../../src/stores/useEditGuard';
import { AppToaster } from '../../src/app/toast';
import { buildTheme } from '../../src/theme';
import { useSettingsStore } from '../../src/stores/useSettingsStore';
import { connectionBridge } from '../../src/ipc/connectionBridge';
import type { ColumnMeta, DbValue } from '../../src/ipc/types';
import '../../src/styles.css';
import '../../src/compact.css';
import { monaco } from '../../src/monaco';
const w=window as any,p=new URLSearchParams(location.search),engine=p.get('engine')??'mysql',theme=p.get('theme')??'light';
const zoom=Number(p.get('zoom')??1);
connectionBridge.isOffline=()=>false;useSettingsStore.setState({themeMode:theme as any});
if(theme==='oled')document.documentElement.dataset.oled='true';document.documentElement.style.zoom=p.get('zoom')??'1';document.documentElement.dataset.density='compact';
w.calls=[];
w.guards=()=>Object.values(useEditGuard.getState().entries).map(e=>e.label);
useSessionStore.setState({sessions:[{id:engine,name:'验收',engine,readOnly:false} as any]});
w.editText=(text:string)=>monaco.editor.getModels().filter(m=>!m.isDisposed()).at(-1)?.setValue(text);
w.editorState=()=>{const m=monaco.editor.getModels().filter(m=>!m.isDisposed()).at(-1);return {language:m?.getLanguageId(),markers:m?monaco.editor.getModelMarkers({resource:m.uri}):[],options:monaco.editor.getEditors().at(-1)?.getRawOptions()};};
w.editorText=()=>monaco.editor.getModels().filter(m=>!m.isDisposed()).at(-1)?.getValue();
const columns:ColumnMeta[]=[
 {name:'id',rawType:'bigint',canonical:{kind:'int',bits:64,unsigned:false}},
 {name:'count',rawType:'int',canonical:{kind:'int',bits:32,unsigned:false}},
 {name:'amount',rawType:'decimal(30,10)',canonical:{kind:'decimal',precision:30,scale:10}},
 {name:'notes',rawType:'text',canonical:{kind:'string',len:null}},
 {name:'document',rawType:'json',canonical:{kind:'json'}},
 {name:'binary',rawType:'bytea',canonical:{kind:'binary'}},
 {name:'nullable',rawType:'varchar(20)',canonical:{kind:'string',len:20}},
].map((c,i)=>({...c,ordinal:i+1,nullable:true,unsigned:false,autoIncrement:false})) as ColumnMeta[];
const initial:DbValue[][]=[[['int',1],['int',2],['decimal','1.25'],['trunc','短预览'],['json','{"a":1}'],['bytes','0x0102'],['null',null]],[['int',2],['int',4],['decimal','2.50'],['text','第二行'],['json','{}'],['bytes','0x'],['text','']]];
if(p.has('findRows'))initial.splice(0,initial.length,...Array.from({length:570},(_,i):DbValue[]=>[['int',i+1],['int',i],['decimal','1.25'],['text',[0,300,569].includes(i)?'查找目标':'普通数据'],['json','{}'],['bytes','0x0102'],['null',null]]));
if(p.has('badKey'))initial[0][0]=['trunc','不可定位的截断主键'];
w.__TAURI_INTERNALS__={invoke:async(c:string,a:any)=>{
 w.calls.push({c,a});
 if(c.startsWith('task_'))return null;
 if(c==='settings_get'){if(p.has('late')&&a.key.startsWith('dw.gridLayout'))await new Promise(resolve=>{w.releaseSettings=resolve;});return localStorage.getItem(a.key);}
 if(c==='settings_set'){localStorage.setItem(a.key,a.value);return;}
 if(c==='cell_full_value'){if(p.has('slow'))await new Promise(resolve=>setTimeout(resolve,a.column==='notes'?600:50));return a.column==='notes'?['text','完整日志😀'.repeat(1000)]:initial[Number(a.keys[0].value[1])-1][columns.findIndex(v=>v.name===a.column)];}
 if(c==='clipboard_write_text'){w.copied=a.text;return;}
 if(c==='clipboard_read_text')return w.clipboard;
 if(c==='query_execute')return {columns,rows:initial,affected:null};
 if(c==='grid_preview_changes')return a.changes.map(()=> 'UPDATE records SET count = 5');
 if(c==='grid_commit'){if(w.failCommit)throw Error('模拟并发冲突');w.submitted=a.changes;return a.changes.length;}
 throw Error('未预期的 IPC：'+c);
}};
const ref=createRef<EditableDataGridHandle>();w.grid=ref;
function App(){
 const inactive=useUiActivity(s=>s.inactive);w.idle=(value:boolean)=>useUiActivity.setState({inactive:value});
 const [rows,setRows]=useState(initial),[invalid,setInvalid]=useState<string|null>(null),[changes,setChanges]=useState<any[]>([]);
 w.refresh=()=>setRows(initial.map(row=>[...row]));w.emptyRows=()=>setRows([]);
 return <FluentProvider theme={buildTheme(theme!=='light','#2c7dcc',theme==='oled'?'oled':'classic')} style={{height:window.innerHeight/zoom}}><AppToaster/>{p.has('shortcuts')&&<><SaveCommandBridge tabId="parent" enabled onError={e=>{w.saveError=String(e);}}/><UnsavedChangesDialog/></>}
   {p.has('parent')?<div style={{height:'100%',display:'flex',flexDirection:'column'}}><TableDataPanel tab={{id:'parent',type:'table',sessionId:engine,database:'test',table:'records'} as any} active={!inactive} engine={engine as any} readOnly={false} detail={{name:'records',kind:'table',columns,primaryKey:['id'],indexes:[],foreignKeys:[]} as any} onChanged={()=>{w.changed=true;}}/></div>:<>
   <div style={{height:28}}><Button size="small" disabled={!changes.length||!!invalid} onClick={()=>{w.submitted=ref.current!.getChanges();ref.current!.acceptChanges(changes.map((_,i)=>i));}}>提交</Button><Button size="small" onClick={()=>ref.current?.discard()}>放弃修改</Button><span data-testid="pending">{changes.length} / {invalid??'有效'}</span></div>
   <div style={{height:window.innerHeight/zoom-28}}>{p.has('result')?<ResultGrid columns={columns} rows={rows}/>:<EditableDataGrid ref={ref} tabId="workbench" columns={columns} rows={rows} pkColumns={p.has('noKey')?[]:['id']} sessionId={engine} database="test" table={p.get('table')??'records'} readOnly={p.has('readonly')||p.has('noKey')} onPendingChange={setChanges} onValidationChange={setInvalid}/>}</div>
   </>}
 </FluentProvider>;
}
createRoot(document.getElementById('root')!).render(<App/>);
