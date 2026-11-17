import { createRoot } from 'react-dom/client';
import { createRef } from 'react';
import { FluentProvider } from '@fluentui/react-components';
import { ResultGrid, type ResultGridHandle } from '../../src/features/grid/ResultGrid';
import { TableDataPanel } from '../../src/features/table/TableDataPanel';
import { readRowClipboard } from '../../src/features/grid/rowClipboard';
import { AppToaster } from '../../src/app/toast';
import { useAppTheme } from '../../src/theme';
import { useSessionStore } from '../../src/stores/useSessionStore';
import { useSettingsStore } from '../../src/stores/useSettingsStore';
import { connectionBridge } from '../../src/ipc/connectionBridge';
import type { ColumnInfo, DbValue, CanonicalType } from '../../src/ipc/types';
import '../../src/styles.css';
import '../../src/compact.css';

const w = window as any, params = new URLSearchParams(location.search);
const mode=params.get('theme')??'light', zoom=Number(params.get('zoom')??1), parent=params.has('parent');
document.documentElement.dataset.density='compact';
if(mode==='oled')document.documentElement.dataset.oled='true';
const columns: ColumnInfo[] = [{name:'id',rawType:'bigint'},{name:'notes',rawType:'text'},{name:'enabled',rawType:'boolean'},{name:'nullable_text',rawType:'varchar(20)'},{name:'binary_value',rawType:'varbinary(20)'},{name:'amount',rawType:'decimal(30,4)'}];
const rows: DbValue[][] = [
  [['int',1],['text','甲\t引号"多\r\n行'],['bool',true],['null',null],['bytes','0x007fff'],['decimal','12345678901234567890.1234']],
  [['int',2],['text',''],['bool',false],['text',''],['bytes','0x'],['decimal','0.1000']],
  [['int',3],['text','第三行'],['bool',true],['text','尾行'],['bytes','0x80'],['decimal','3.0000']],
];
if(params.has('edgeRows'))rows.splice(0,rows.length,...Array.from({length:40},(_,index):DbValue[]=>[['int',index+1],['text','边界验收 '+(index+1)],['bool',true],['null',null],['bytes','0x80'],['decimal','3.0000']]));
const canonical:CanonicalType[]=[{kind:'int',bits:64,unsigned:false},{kind:'string',len:null},{kind:'bool'},{kind:'string',len:20},{kind:'binary'},{kind:'decimal',precision:30,scale:4}];
const metadata={name:'records',schema:'test',kind:'table',columns:columns.map((column,index)=>({...column,canonical:canonical[index],ordinal:index+1,nullable:index!==0,autoIncrement:index===0,unsigned:false,generated:false})),primaryKey:params.has('noKey')?[]:['id'],indexes:[],foreignKeys:[]};
if(params.has('truncated'))rows[0][1]=['trunc','不完整内容'];
w.calls=[];w.clipboard='';w.fixture={columns,rows};w.readTyped=readRowClipboard;
w.__TAURI_INTERNALS__={invoke:async(command:string,args:any)=>{
  w.calls.push({command,args});
  if(command.startsWith('task_'))return null;
  if(command==='settings_get')return null;
  if(command==='settings_set')return;
  if(command==='clipboard_write_text'){if(w.failClipboard)throw Error('模拟剪贴板写入失败');w.clipboard=args.text;return;}
  if(command==='clipboard_read_text')return w.clipboard;
  if(command==='meta_tables')return [{name:'records',schema:'test',kind:'table'}];
  if(command==='meta_table_detail')return metadata;
  if(command==='query_execute'||command==='query_fetch_page')return {columns,rows,affected:null};
  if(command==='grid_preview_changes')return args.changes.map((change:any)=>change.kind==='insert'?'INSERT INTO records (notes) VALUES (\'无主键新增\')':'UNEXPECTED '+change.kind);
  if(command==='grid_commit'){w.committed=args.changes;return args.changes.length;}
  throw Error('未预期的 IPC：'+command);
}};
connectionBridge.isOffline=()=>false;
useSettingsStore.setState({themeMode:mode as any,interfaceStyle:'classic',density:'compact'});
useSessionStore.setState({sessions:[{id:'readonly',name:parent?'表数据验收':'只读查询',engine:'mysql',readOnly:!parent} as any]});
const ref=createRef<ResultGridHandle>();w.resultHandle=ref;
function Fixture(){const {theme}=useAppTheme();return <FluentProvider theme={theme} style={{height:'100vh'}}>
  <AppToaster/><div style={{display:'flex',flexDirection:'column',width:`${100/zoom}%`,height:`${100/zoom}%`,transform:`scale(${zoom})`,transformOrigin:'top left'}}>{parent
    ?<TableDataPanel tab={{id:'no-key-parent',kind:'table',sessionId:'readonly',database:'test',schema:'test',table:'records'} as any} active engine="mysql" readOnly={false} detail={metadata as any} onChanged={()=>{w.changed=true;}}/>
    :<ResultGrid ref={ref} columns={columns} rows={rows} {...(!params.has('noContext')?{sessionId:'readonly',database:'test'}:{})}/>}</div>
  <div id="dw-overlay-root"/>
</FluentProvider>;}
createRoot(document.getElementById('root')!).render(<Fixture/>);
