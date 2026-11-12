import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {FluentProvider,webLightTheme} from '@fluentui/react-components';
import {monaco} from '../../src/monaco';
import {sqlLanguage} from '../../src/sqlLanguage';
import {AnalysisSqlEditor} from '../../src/features/analysis/AnalysisSqlEditor';
import {ConfirmSqlDialog} from '../../src/features/table/ConfirmSqlDialog';
import {useSessionStore} from '../../src/stores/useSessionStore';
import '../../src/styles.css';
const w=window as any;
w.monaco=monaco;w.sqlLanguage=sqlLanguage;w.calls=[];
w.__TAURI_INTERNALS__={invoke:async(command:string,args:any)=>{w.calls.push({command,args});if(command==='settings_get')return null;if(command==='meta_tables')return [{name:'dm_orders',kind:'table'}];if(command==='meta_table_detail')return {name:args.table,columns:[{name:'note',rawType:'CLOB'}]};if(command.startsWith('task_')||command==='settings_set')return;throw Error(command);}};
useSessionStore.setState({sessions:[{id:'dm',name:'达梦高亮测试',engine:'dameng',readOnly:false}] as any,statuses:{dm:{connected:true}} as any});
w.sql=`CREATE TABLE "DM_TYPES" (
  "ID" BIGINT IDENTITY(1,1), "NOTE" CLOB, "IMAGE" BLOB,
  "CLOB" VARCHAR2(40) DEFAULT 'CLOB BLOB IDENTITY CLUSTER STORAGE',
  CLUSTER PRIMARY KEY("ID")
) STORAGE(ON "MAIN", CLUSTERBTR);
-- CLOB BLOB IDENTITY CLUSTER STORAGE
/* CLOB BLOB IDENTITY CLUSTER STORAGE */`;
function App(){const [value,setValue]=useState(w.sql),[open,setOpen]=useState(false);return <FluentProvider theme={webLightTheme}><main style={{padding:12}}><AnalysisSqlEditor sessionId="dm" database="AGENT" value={value} readOnly={false} onChange={setValue}/><button onClick={()=>setOpen(true)}>显示 SQL 确认</button><ConfirmSqlDialog open={open} sessionId="dm" title="达梦确认预览" loadPreview={async()=>[w.sql]} onApply={async()=>{}} onClose={()=>setOpen(false)} onDone={()=>{}}/></main></FluentProvider>;}
createRoot(document.getElementById('root')!).render(<App/>);
