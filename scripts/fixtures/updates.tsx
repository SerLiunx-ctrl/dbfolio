import {createRoot} from 'react-dom/client';
import {FluentProvider} from '@fluentui/react-components';
import {UpdatePanel} from '../../src/features/updates/UpdatePanel';
import {UpdateManager} from '../../src/features/updates/UpdateManager';
import {UnsavedChangesDialog} from '../../src/app/UnsavedChangesDialog';
import {useTaskStore} from '../../src/stores/useTaskStore';
import {useEditGuard} from '../../src/stores/useEditGuard';
import {buildTheme} from '../../src/theme';
import '../../src/styles.css';import '../../src/compact.css';
const w=window as any;w.calls=[];w.ready=false;
const status={version:'1.0.0-alpha.15',distribution:'portable',preferences:{automatic:false,channel:'preview',skipped:'',lastCheck:0,proxy:''},logPath:'C:/fixtures/updates',readyVersion:null as string|null};
w.block=(kind:string)=>{
  useTaskStore.setState({tasks:kind==='task'?[{id:'other',kind:'查询',label:'查询',sessionIds:[],status:'running',startedAt:Date.now()}]:[]});
  useEditGuard.setState({entries:kind==='edit'?{test:{tabId:'test',sessionId:'session',label:'未保存结构',save:async()=>{w.saved=true;},discard:()=>{w.discarded=true;}}}:{}});
};
w.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},invoke:async(command:string,args:any)=>{
 w.calls.push({command,args});
 if(command==='updater_status')return structuredClone({...status,readyVersion:w.ready?'1.0.0-alpha.16':null});
 if(command==='updater_preferences'){if(!['preview','stable'].includes(args.value.channel))throw Error('通道无效');status.preferences=args.value;return;}
 if(command==='updater_check'){if(w.failCheck)throw {message:'网络不可用'};return w.noUpdate?null:{version:'1.0.0-alpha.16',notes:'改进软件更新\n修复资源加载',date:null,skipped:status.preferences.skipped==='1.0.0-alpha.16',size:16000000};}
 if(command==='updater_download'){
   if(w.slow){while(!w.cancelled)await new Promise(r=>setTimeout(r,30));throw {code:'E_CANCELLED',message:'下载已取消'};}
   w.ready=true;return '1.0.0-alpha.16';
 }
 if(command==='task_cancel'){w.cancelled=true;return;}
 if(command==='task_progress')return {processed:500,total:1000,message:'下载中',cancelRequested:!!w.cancelled};
 if(command.startsWith('task_')||command==='settings_set'||command==='updater_ready')return;
 if(command==='updater_install'){w.installed=true;return;}
 if(command==='settings_get')return null;
 if(command.startsWith('plugin:opener'))return;
 if(command==='plugin:window|is_minimized'||command==='plugin:window|is_maximized')return false;
 if(command==='plugin:window|outer_position')return {x:0,y:0};
 if(command==='plugin:window|inner_size')return {width:1280,height:800};
 throw Error(command);
}};
const params=new URLSearchParams(location.search);const oled=params.has('oled');
document.documentElement.dataset.colorMode=oled?'oled':'light';
createRoot(document.getElementById('root')!).render(<FluentProvider theme={buildTheme(oled,'#0f6cbd',oled?'oled':'classic')} style={{minHeight:'100vh',padding:16,zoom:Number(params.get('zoom')||1)}}><UpdatePanel/><UpdateManager/><UnsavedChangesDialog/></FluentProvider>);
