import {createRoot} from 'react-dom/client';
import {FluentProvider,Button} from '@fluentui/react-components';
import {TableWorkspace} from '../../src/features/table/TableWorkspace';
import {CreateTableWorkspace} from '../../src/features/table/CreateTableWorkspace';
import {newColumn,newTableState} from '../../src/features/table/createTableDraft';
import {useTabStore} from '../../src/stores/useTabStore';
import {useSessionStore} from '../../src/stores/useSessionStore';
import {useSettingsStore} from '../../src/stores/useSettingsStore';
import {connectionBridge} from '../../src/ipc/connectionBridge';
import {buildTheme} from '../../src/theme';
import {AppToaster} from '../../src/app/toast';
import '../../src/styles.css';
import '../../src/compact.css';
const w=window as any,p=new URLSearchParams(location.search),engine=(p.get('engine')??'mysql') as 'mysql'|'postgres'|'sqlite',mode=p.get('theme')??'light',zoom=Number(p.get('zoom')??1);
const schema=engine==='postgres'?'source.schema':null,refSchema=engine==='postgres'?'ref.schema':null,refDatabase=engine==='mysql'&&!p.has('draft')?'other_db':'db';
const localName='本地.列"[]',refName='引用.列"[]';w.localName=localName;w.refName=refName;w.calls=[];
document.documentElement.style.zoom=String(zoom);document.documentElement.dataset.oled=String(mode==='oled');useSettingsStore.setState({themeMode:mode as any});connectionBridge.isOffline=()=>false;
useSessionStore.setState({sessions:[{id:'s',engine,name:'外键验收',readOnly:p.has('readonly')} as any]});
const columns=(special:string)=>Array.from({length:70},(_,i)=>({name:i===0?'id':i===65?special:'field_'+i,ordinal:i+1,rawType:'varchar(80)',canonical:{kind:'string',len:80},nullable:true,unsigned:false,autoIncrement:false}));
const source={name:'items',kind:'table',columns:columns(localName),primaryKey:[],indexes:[],foreignKeys:[{name:'fk_parent',columns:[localName],refDatabase,refSchema,refTable:'parents',refColumns:[refName],onUpdate:'NO ACTION',onDelete:'CASCADE'},{name:'fk_self',columns:['id'],refTable:'items',refColumns:[localName],refSchema:schema,onUpdate:'NO ACTION',onDelete:'NO ACTION'}],rawDdl:''};
const parent={...source,name:'parents',columns:columns(refName),foreignKeys:[]};
const draft=newTableState(engine);draft.schema=schema??'';draft.properties.name='items_draft';draft.columns=source.columns.map(c=>({...newColumn(engine,c.name),dataType:c.rawType}));draft.foreignKeys=[{name:'fk_parent',columns:[localName],refTable:'parents',refSchema,refColumns:[refName],onUpdate:'NO ACTION',onDelete:'CASCADE'},{name:'fk_self',columns:['id'],refTable:'',selfReference:true,refSchema:schema,refColumns:[localName],onUpdate:'NO ACTION',onDelete:'NO ACTION'}];
const sourceTab:any=p.has('draft')?{id:'source',kind:'createTable',sessionId:'s',database:'db',draft,title:'新建表*'}:{id:'source',kind:'table',sessionId:'s',database:'db',schema,table:'items',title:'items',view:'foreignKeys'};
useTabStore.setState({tabs:[sourceTab,...(p.has('existing')?[{id:'parent',kind:'table',sessionId:'s',database:refDatabase,schema:refSchema,table:'parents',title:'parents',view:'structure'} as any]:[])],activeId:'source'});w.tabs=useTabStore;
w.__TAURI_INTERNALS__={invoke:async(command:string,args:any)=>{
 w.calls.push({command,args});
 if(command==='meta_table_detail'){if(p.has('denied')&&args.table==='parents')throw Error('无权访问引用表');return args.table==='parents'?parent:source;}
 if(command==='meta_column_types')return {engine,serverVersion:'fixture',types:p.has('catalog')?[{name:'varchar',label:'varchar',description:'可变长度字符串',category:'字符',arguments:'length',defaultArguments:'255'},{name:'bigint',label:'bigint',description:'大整数',category:'数值',arguments:'none',defaultArguments:''},{name:'integer',label:'integer',description:'整数',category:'数值',arguments:'none',defaultArguments:''},...(engine==='postgres'?[{name:'vector',label:'vector',description:'向量 · vector 扩展',category:'扩展',arguments:'length',defaultArguments:'3'}]:[])]:[]};
 if(command==='meta_tables')return [{name:'parents',schema:refSchema,kind:'table'}];
 if(command==='meta_storage_engines')return ['InnoDB'];if(command==='meta_charsets')return [{charset:'utf8mb4',defaultCollation:'utf8mb4_bin'}];if(command==='meta_collations')return ['utf8mb4_bin'];
 if(command==='settings_get')return null;if(command==='settings_set'||command.startsWith('task_'))return;
 throw Error(command);
}};
function App(){const tabs=useTabStore(s=>s.tabs),active=useTabStore(s=>s.activeId);return <FluentProvider theme={buildTheme(mode!=='light','#2ca83b',mode==='oled'?'oled':'classic')} style={{height:100/zoom+'vh',display:'flex',flexDirection:'column'}}><AppToaster/>
 <div><Button size="small" onClick={()=>useTabStore.getState().setActive('source')}>查看源表</Button><Button size="small" onClick={()=>useTabStore.getState().openTable({sessionId:'s',database:refDatabase,schema:refSchema,table:'parents'},'structure','')}>查看引用表</Button><Button size="small" onClick={()=>{const tab=useTabStore.getState().tabs.find(t=>t.kind==='table'&&t.table==='parents');if(tab)useTabStore.getState().setActive(tab.id);}}>返回引用页签</Button></div>
 {tabs.map(tab=><div key={tab.id} data-active={tab.id===active} style={{display:tab.id===active?'flex':'none',flex:1,minHeight:0,flexDirection:'column'}}>{tab.kind==='createTable'?<CreateTableWorkspace tab={tab}/>:tab.kind==='table'?<TableWorkspace tab={tab} active={tab.id===active}/>:null}</div>)}
 </FluentProvider>;}
createRoot(document.getElementById('root')!).render(<App/>);
