import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {FluentProvider,webLightTheme,webDarkTheme} from '@fluentui/react-components';
import {TitleBar} from '../../src/app/TitleBar';
import {AppMenu} from '../../src/app/AppMenu';
const w=window as any;w.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'}},transformCallback:()=>1,unregisterCallback:()=>{},invoke:async()=>false};
function Demo(){const [result,setResult]=useState('工作区');return <FluentProvider theme={location.search.includes('dark')?webDarkTheme:webLightTheme} style={{height:'100vh'}}><TitleBar><AppMenu onNewSession={()=>setResult('新建连接')} onSync={()=>setResult('数据同步')} onSettings={()=>setResult('设置')}/></TitleBar><div style={{display:'flex',borderTop:'1px solid #8883',height:'calc(100vh - 40px)'}}><aside style={{width:220,padding:14,borderRight:'1px solid #8883'}}>会话<div style={{marginTop:22}}>本机 · MySQL</div></aside><main style={{padding:24}}><h3>{result}</h3></main></div></FluentProvider>};createRoot(document.getElementById('root')!).render(<Demo/>);
