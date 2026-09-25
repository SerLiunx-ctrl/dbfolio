import {createRoot} from 'react-dom/client';
import {FluentProvider,webLightTheme} from '@fluentui/react-components';
import {FilterPanel} from '../../src/features/table/FilterPanel';
import '../../src/styles.css';
const w=window as any;w.calls=[];w.__TAURI_INTERNALS__={invoke:async(c:string)=>{w.calls.push(c);if(c==='settings_get')return null;throw Error(c);}};
const columns:any=[{name:'name',comment:'设备名称及备注'},{name:'device_status_code',comment:'设备状态编码，包含完整的业务状态说明'}];
w.longValue='long-'.repeat(40)+'SEARCH-END';
const rows:any=[[['text','001'],['text','ONLINE']],[['text','001'],['text','OFFLINE']],[['text',''],['text','ONLINE']],[['null',null],['text','ONLINE']],[['text',w.longValue],['text','OFFLINE']],[['trunc','preview'],['text','ONLINE']]];
createRoot(document.getElementById('root')!).render(<FluentProvider theme={webLightTheme}><div style={{padding:24}}><FilterPanel scope="test" columns={columns} loadedRows={rows} initialFilters={[]} initialConjunction="and" onApply={f=>w.applied=f} onClear={()=>{}}/></div></FluentProvider>);
