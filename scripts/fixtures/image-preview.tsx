import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { FluentProvider } from '@fluentui/react-components';
import { EditableDataGrid } from '../../src/features/grid/EditableDataGrid';
import { ResultGrid } from '../../src/features/grid/ResultGrid';
import { base64Image, isImageCandidate, IMAGE_TEXT_LIMIT } from '../../src/features/grid/base64Image';
import { buildTheme } from '../../src/theme';
import { surfaceColors } from '../../src/appearance';
import { useSettingsStore } from '../../src/stores/useSettingsStore';
import { useSessionStore } from '../../src/stores/useSessionStore';
import { connectionBridge } from '../../src/ipc/connectionBridge';
import { AppToaster } from '../../src/app/toast';
import '../../src/monaco';
import '../../src/styles.css';
import '../../src/compact.css';
const w=window as any,params=new URLSearchParams(location.search),engine=params.get('engine')??'sqlite',theme=params.get('theme')??'light';
useSettingsStore.setState({themeMode:theme as any});
useSessionStore.setState({sessions:[{id:'s',name:'图片测试',engine,readOnly:false} as any]});
connectionBridge.isOffline=()=>false;
document.documentElement.dataset.density='compact';document.documentElement.dataset.oled=String(theme==='oled');
const palette=surfaceColors(theme==='oled'?'oled':'aurora',theme!=='light');
document.documentElement.style.setProperty('--dw-palette-surface',palette.surface);
document.documentElement.style.setProperty('--dw-palette-border',palette.border);
document.documentElement.style.setProperty('--dw-palette-ink',palette.foreground);
const canvas=document.createElement('canvas');canvas.width=640;canvas.height=320;const ctx=canvas.getContext('2d')!;
const gradient=ctx.createLinearGradient(0,0,640,320);gradient.addColorStop(0,'#0b7285');gradient.addColorStop(1,'#7048e8');ctx.fillStyle=gradient;ctx.fillRect(0,0,640,320);ctx.fillStyle='#fff';ctx.font='bold 42px sans-serif';ctx.fillText('DBFolio 图片预览',110,175);
const png=canvas.toDataURL(),jpeg=canvas.toDataURL('image/jpeg'),webp=canvas.toDataURL('image/webp');
const damaged=atob(png.split(',')[1]);const broken='data:image/png;base64,'+btoa(damaged.slice(0,33)+'\0'.repeat(damaged.length-45)+damaged.slice(-12));
w.images={png,jpeg,webp};w.imageUtils={base64Image,isImageCandidate,IMAGE_TEXT_LIMIT};w.calls=[];w.pending=[];w.active=0;w.maxActive=0;
w.__TAURI_INTERNALS__={invoke:async(c:string,a:any)=>{
 w.calls.push({c,a});if(c==='cell_full_value'){w.active++;w.maxActive=Math.max(w.maxActive,w.active);await new Promise(r=>setTimeout(r,80));w.active--;if(a.keys[0].value[1]===99)throw Error('模拟读取失败');return ['text',png];}
 if(c==='clipboard_write_text'){w.copied=a.text;return;}
 if(c==='plugin:dialog|save')return w.exportPath??null;
 if(c==='image_export'){if(w.exportError)throw Error('模拟磁盘写入失败');w.exported=a;return;}
 throw Error(c);
}};
const col=(name:string,rawType:string)=>({name,rawType,ordinal:1,nullable:true,autoIncrement:false,unsigned:false});
const columns=[col('id','bigint'),col('image_base64','LONGTEXT')];
const initial:any[]=[
 [['int',1],['trunc',png.slice(0,1024)+'…']],
 [['int',2],['text',jpeg.split(',')[1]]],
 [['int',3],['text',webp]],
 [['int',4],['text','普通文本：不是图片']],
 [['int',5],['text','data:image/svg+xml;base64,'+btoa('<svg xmlns="http://www.w3.org/2000/svg"/>')]],
 [['int',6],['text',broken]],
 ...Array.from({length:30},(_,i)=>[['int',i+10],['trunc',png.slice(0,1024)+'…']]),
];
function App(){const [rows,setRows]=useState(initial);w.setImage=(text:string)=>setRows([[['int',200],['text',text]]]);w.refreshRows=()=>setRows([[['int',100],['text','刷新后的文本']]]);return <FluentProvider theme={buildTheme(theme!=='light','#0f6cbd',theme==='oled'?'oled':'aurora')} data-color-mode={theme==='light'?'light':'dark'} style={{height:'100vh',padding:12,boxSizing:'border-box'}}>
<AppToaster/><h3>Base64 图片 · {engine}</h3><div style={{height:320}}>{params.has('result')?<ResultGrid columns={columns} rows={rows}/>:<EditableDataGrid tabId="t" columns={columns as any} rows={rows} pkColumns={params.has('nokey')?[]:['id']} sessionId="s" database="main" table="images" readOnly={params.has('readonly')} onPendingChange={v=>{w.pending=v;}}/>}</div>
</FluentProvider>;}createRoot(document.getElementById('root')!).render(<App/>);
