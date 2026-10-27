import {getGridApi} from "ag-grid-community";
import {createRoot} from 'react-dom/client';
import {useState} from 'react';
import {FluentProvider,Button,Checkbox,Popover,PopoverTrigger,PopoverSurface} from '@fluentui/react-components';
import {useAppTheme} from '../../src/theme';
import {useSettingsStore} from '../../src/stores/useSettingsStore';
import {useSessionStore} from '../../src/stores/useSessionStore';
import {useTabStore} from '../../src/stores/useTabStore';
import {useWorkspace} from '../../src/stores/useWorkspace';
import {useDockStore} from '../../src/stores/useDockStore';
import {DockLayout,DockTitle} from '../../src/app/DockLayout';
import {TabOverflow} from '../../src/app/WorkbenchHub';
import {TableWorkspace} from '../../src/features/table/TableWorkspace';
import {ResultGrid} from '../../src/features/grid/ResultGrid';
import {EditableDataGrid} from '../../src/features/grid/EditableDataGrid';
import {connectionBridge} from '../../src/ipc/connectionBridge';
import {AppToaster} from '../../src/app/toast';
import type {ColumnMeta,DbValue} from '../../src/ipc/types';
import '../../src/monaco';
import '../../src/styles.css';
import '../../src/compact.css';
import '../../src/motion.css';

const w=window as any, params=new URLSearchParams(location.search), engine=params.get('engine')??'mysql', mode=params.get('mode')??'table';
const themeMode=params.get('theme')??'light', value='1919654707669256368';
useSettingsStore.setState({themeMode:themeMode as any,sidebarSplit:.47,interfaceStyle:'slate'});
connectionBridge.isOffline=()=>false;
useSessionStore.setState({sessions:[{id:'s',name:'本机',engine,readOnly:false} as any]});
const columns:ColumnMeta[]=[['id','bigint'],['status','varchar(20)'],['device_code','varchar(128)'],['comment','text']].map(([name,rawType],i)=>({name,rawType,ordinal:i+1,canonical:{kind:'unknown',raw:rawType},nullable:true,autoIncrement:i===0,unsigned:false}));
const rows:DbValue[][]=[[['uint',value],['text','SUCCESS'],['text','DEVICE-123456789012345678901234'],['text','设备信息备注'.repeat(20)]]];
const detail:any={name:'devices',kind:'table',columns,primaryKey:['id'],indexes:[{name:'idx_device_status',primary:false,unique:false,columns:[{name:'status'}],method:'BTREE'}],foreignKeys:[{name:'fk_device',columns:['id'],refTable:'other_devices',refColumns:['id'],onDelete:'CASCADE',onUpdate:'RESTRICT'}],rawDdl:`CREATE TABLE devices (id BIGINT PRIMARY KEY, status VARCHAR(20));\n-- AUTO_INCREMENT=${value}`};
const tab:any={id:'t',kind:'table',sessionId:'s',database:'test',table:'devices',title:'devices',view:params.get('view')??'ddl'};
const tabs=Array.from({length:10},(_,i)=>({...tab,id:'t'+i,title:'long_device_table_name_'+i,database:'long_database_name_'+i}));
useTabStore.setState({tabs,activeId:tabs[0].id});
w.gridApi=()=>Array.from({length:10},(_,i)=>getGridApi(String(i))).find(Boolean);
w.calls=[];w.workspace=useWorkspace;w.tabs=useTabStore;w.settings=useSettingsStore;w.dock=useDockStore;
w.__TAURI_INTERNALS__={invoke:async(command:string,args:any)=>{
 w.calls.push({command,args});
 if(command==='meta_table_detail')return detail;
 if(command==='meta_table_info')return {...detail,columnCount:columns.length,indexCount:1,foreignKeyCount:1,autoIncrementColumn:'id',extra:{engine:'InnoDB',charset:'utf8mb4',collation:'utf8mb4_general_ci',autoIncrementValue:value}};
 if(command==='meta_storage_engines')return ['InnoDB','MyISAM'];
 if(command==='meta_charsets')return [{charset:'utf8mb4',defaultCollation:'utf8mb4_general_ci'}];
 if(command==='meta_collations')return ['utf8mb4_general_ci'];
 if(command==='query_execute'||command==='query_fetch_page')return {columns,rows,affected:null};
 if(command==='settings_get')return null;
 if(command==='settings_set'||command==='settings_set_many'||command.startsWith('task_'))return null;
 if(command==='clipboard_write_text'){w.copied=args.text;return;}
 if(command==='ddl_preview')return ['ALTER TABLE devices COMMENT=...'];
 throw Error(command);
}};
function Demo(){
 const {theme,dark}=useAppTheme();const [data,setData]=useState(rows);w.reloadRows=()=>setData(old=>old.map(row=>[...row]));
 return <FluentProvider theme={theme} data-color-mode={dark?'dark':'light'} style={{height:'100vh',display:'flex',flexDirection:'column'}}><AppToaster/>
 <div style={{display:'flex',height:32,alignItems:'center'}}><TabOverflow tabs={tabs} activeId={tabs[0].id}/>
 <Popover><PopoverTrigger disableButtonEnhancement><Button size="small">控件状态</Button></PopoverTrigger><PopoverSurface><Checkbox label="未选中"/><Checkbox label="已选中" defaultChecked/><Checkbox label="禁用" disabled/><Button disabled>不可用</Button></PopoverSurface></Popover>
 </div>
 <DockLayout sessions={<><header style={{display:'flex',alignItems:'center',height:36,flexShrink:0}}><DockTitle panel="sessions">会话</DockTitle></header><div>本机会话列表</div></>} explorer={<><DockTitle panel="explorer">对象浏览器</DockTitle><div>数据库与表</div></>}>
 <div style={{display:'flex',flex:1,minWidth:0,minHeight:0}}>{mode==='result'?<ResultGrid columns={columns} rows={data}/>:mode==='grid'?<EditableDataGrid columns={columns} rows={data} tabId="g" pkColumns={['id']} sessionId="s" database="test" table="devices"/>:<TableWorkspace tab={tab} active/>}</div>
 </DockLayout></FluentProvider>;
}
createRoot(document.getElementById('root')!).render(<Demo/>);
