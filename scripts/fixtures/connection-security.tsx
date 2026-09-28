import {createRoot} from 'react-dom/client';
import {FluentProvider} from '@fluentui/react-components';
import {SessionDialog} from '../../src/features/sessions/SessionDialog';
import {buildTheme} from '../../src/theme';
import {AppToaster} from '../../src/app/toast';
import '../../src/styles.css';import '../../src/compact.css';
const w=window as any;w.calls=[];
const fingerprint='SHA256:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq';
w.__TAURI_INTERNALS__={invoke:async(command:string,args:any)=>{
 w.calls.push({command,args});
 if(command==='session_ssh_fingerprint')return fingerprint;
 if(command==='session_test')return {ok:false,serverVersion:'',steps:[{key:'address',label:'地址解析',status:'ok',message:'通过',durationMs:1},{key:'ssh',label:'SSH 与转发',status:'ok',message:'通过',durationMs:5},{key:'tls',label:'TLS / 证书',status:'failed',message:'证书与服务器名不匹配',durationMs:8},{key:'authentication',label:'数据库认证',status:'skipped',message:'TLS 未通过，未完成数据库认证',durationMs:0}]};
 if(command==='session_update')return {...args.input,id:'s',hasPassword:true};
 if(command==='settings_get')return null;if(command==='settings_set')return;
 throw Error(command);
}};
document.documentElement.dataset.density='compact';
const oled=location.search.includes('oled');document.documentElement.dataset.oled=String(oled);
createRoot(document.getElementById('root')!).render(<FluentProvider theme={buildTheme(oled,'#0f6cbd',oled?'oled':'aurora')} data-color-mode={oled?'dark':'light'}><SessionDialog open session={{id:'s',name:'诊断测试',engine:'mysql',host:'127.0.0.1',port:3306,username:'qa',readOnly:false,hasPassword:true,createdAt:'',updatedAt:''}} folders={[]} onClose={()=>{}} onSaved={()=>{}}/><AppToaster/></FluentProvider>);
