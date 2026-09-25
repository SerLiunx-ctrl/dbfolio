import {createRoot} from 'react-dom/client';
import {useRef,useState} from 'react';
import {FluentProvider,webLightTheme,Button} from '@fluentui/react-components';
import {EditableDataGrid,type EditableDataGridHandle} from '../../src/features/grid/EditableDataGrid';
import {DataChangePreview} from '../../src/features/table/DataChangePreview';
import {useSessionStore} from '../../src/stores/useSessionStore';
import {useObjectPreferences} from '../../src/stores/useObjectPreferences';
import {connectionBridge} from '../../src/ipc/connectionBridge';
import type {RowChange} from '../../src/ipc/types';
const w=window as any;w.calls=[];connectionBridge.isOffline=()=>false;
w.__TAURI_INTERNALS__={invoke:async(c:string,a:any)=>{w.calls.push({c,a});if(c==='grid_preview_changes'){if(w.failPreview)throw Error('预览失败');return a.changes.map((v:any)=>v.kind+' SQL');}if(c.startsWith('task_'))return null;throw Error(c);}};
useSessionStore.setState({sessions:[{id:'s',name:'生产测试',engine:'mysql',readOnly:false} as any]});
w.setReadOnly=()=>useSessionStore.setState(s=>({sessions:s.sessions.map(v=>({...v,readOnly:true}))}));
useObjectPreferences.setState({environments:{s:'production'}});
const columns:any=[{name:'id',rawType:'int',canonical:{kind:'int'},nullable:false,ordinal:1},{name:'name',rawType:'varchar(100)',canonical:{kind:'string',len:100},nullable:true,ordinal:2}];
const rows:any=[[['int',1],['text','before1']],[['int',2],['text','before2']],[['int',3],['text','before3']]];
function Fixture(){const ref=useRef<EditableDataGridHandle>(null);const [changes,setChanges]=useState<RowChange[]>([]),[open,setOpen]=useState(false);w.grid=ref;
return <FluentProvider theme={webLightTheme}><Button onClick={()=>setOpen(true)}>预览</Button><Button onClick={()=>ref.current?.addRow()}>增加</Button><Button onClick={()=>ref.current?.deleteSelected()}>删除</Button><Button onClick={()=>ref.current?.discard()}>废弃</Button><pre id="changes">{JSON.stringify(changes)}</pre><div style={{height:380}}><EditableDataGrid ref={ref} tabId="t" sessionId="s" database="d" table="t" columns={columns} rows={rows} pkColumns={['id']} onPendingChange={setChanges}/></div><DataChangePreview open={open} sessionId="s" database="d" table="t" changes={changes} onApply={async indexes=>{w.submitted=indexes.map(i=>changes[i]);ref.current?.acceptChanges(indexes);}} onClose={()=>setOpen(false)}/></FluentProvider>;}
createRoot(document.getElementById('root')!).render(<Fixture/>);
