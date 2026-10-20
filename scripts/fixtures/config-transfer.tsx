import {createRoot} from 'react-dom/client';
import {FluentProvider} from '@fluentui/react-components';
import {ConfigTransferSettings} from '../../src/features/settings/ConfigTransferSettings';
import {useSessionStore} from '../../src/stores/useSessionStore';
import {useTabStore} from '../../src/stores/useTabStore';
import {useTaskStore} from '../../src/stores/useTaskStore';
import {buildTheme} from '../../src/theme';
import '../../src/styles.css';import '../../src/compact.css';
const w=window as any;w.calls=[];
const sessions=['mysql','postgres','sqlite','redis','mongodb'].map((engine,i)=>({id:`s${i}`,engine,name:`演示 ${engine}`,host:'localhost',filePath:engine==='sqlite'?'C:/数据库/演示.db':null,readOnly:true,groupName:'开发',allowedDatabases:null}));
const bundle={format:'dbfolio-config',version:1,appVersion:'1.0.0-alpha.10',exportedAt:'2026-10-18',sessions,folders:['开发','空分组'],preferences:{ui_theme:'dark'},favorites:[{id:4,sessionId:'s0',sql:'select 1'}],filters:[{id:'filter',scope:JSON.stringify(['s0','demo',null,'t']),name:'筛选'}],analyses:[{id:'analysis',sessionId:'s0',name:'分析'}],relations:[{id:'relation',source:{sessionId:'s0'}}],environments:{s0:'development'},objectFavorites:[{sessionId:'s0',name:'t'}]};
w.setBlocked=(kind:string)=>{
 useSessionStore.setState({statuses:kind==='connection'?{s0:{connected:true} as any}:{}});
 useTabStore.setState({tabs:kind==='tab'?[{id:'test'} as any]:[]});
 useTaskStore.setState({tasks:kind==='task'?[{id:'test',status:'running'} as any]:[]});
};
w.__TAURI_INTERNALS__={invoke:async(command:string,args:any)=>{
 w.calls.push({command,args});
 if(command==='session_list')return sessions;
 if(command==='settings_get')return args.key==='session_folders'?JSON.stringify(['开发','空分组']):null;
 if(command==='plugin:dialog|open')return w.cancelFile?null:'C:/fixtures/config.json';
 if(command==='plugin:dialog|save')return w.cancelFile?null:'C:/fixtures/export.json';
 if(command==='config_read'){if(w.invalidFile)throw {message:'配置文件损坏或格式不受支持'};return structuredClone(bundle);}
 if(command==='config_export')return;
 if(command==='config_preview'){return {fingerprint:'fixture-preview',sessions:args.bundle.sessions.map((s:any)=>({name:s.name,engine:s.engine,action:args.options.mode==='skip'?'跳过':'新建',targetName:s.name})),added:{'收藏 SQL':args.bundle.favorites.length,'筛选方案':args.bundle.filters.length,'分析方案':args.bundle.analyses.length,'业务关联':args.bundle.relations.length},skipped:{},folders:args.bundle.folders.length,preferences:Object.keys(args.bundle.preferences).length,warnings:['密码与证书内容不迁移']};}
 if(command==='config_import'){if(w.failImport)throw {message:'配置已变化，请重新预览'};sessionStorage.setItem('imported',JSON.stringify(args));return;}
 throw Error(command);
}};
const zoom=Number(new URLSearchParams(location.search).get('zoom')||1);
createRoot(document.getElementById('root')!).render(<FluentProvider theme={buildTheme(location.search.includes('oled'),'#0f6cbd',location.search.includes('oled')?'oled':'classic')} style={{minHeight:'100vh',padding:16,zoom}}><ConfigTransferSettings/></FluentProvider>);
