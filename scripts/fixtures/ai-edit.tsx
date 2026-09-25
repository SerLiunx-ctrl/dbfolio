import {createRoot} from 'react-dom/client';
import {FluentProvider,webLightTheme} from '@fluentui/react-components';
import {AiSqlEdit} from '../../src/features/query/AiSqlEdit';
import {connectionBridge} from '../../src/ipc/connectionBridge';
connectionBridge.isOffline=()=>false;
const w=window as any;w.calls=[];const bad=new URLSearchParams(location.search).get('bad');
w.__TAURI_INTERNALS__={transformCallback:()=>1,unregisterCallback:()=>{},invoke:async(c:string,a:any)=>{w.calls.push(c);if(c==='query_validate_sql'){if(a.sql==='invalid'||bad==='output'&&a.sql==='SELECT 2')throw Error('SQL 语法校验未通过');return;}if(c==='ai_providers')return [{id:'p',model:'m',isDefault:true}];if(c==='query_ai')return {candidate:{sql:'SELECT 2',questions:[]},validationError:null};if(c.startsWith('task_'))return null;throw Error(c);}};
const request={mode:'format' as const,sql:bad==='input'?'invalid':'SELECT 1',apply:(sql:string)=>w.applied=sql};
createRoot(document.getElementById('root')!).render(<FluentProvider theme={webLightTheme}><AiSqlEdit request={request} sessionId="s" database="d" tabId="t" onClose={()=>{}}/></FluentProvider>);
