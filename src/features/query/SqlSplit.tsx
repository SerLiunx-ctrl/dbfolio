import {useEffect,useRef,useState,type ReactNode} from 'react';
import {api} from '../../ipc';
import './query-ai.css';

export function SqlSplit({open,storageKey,children}:{open:boolean;storageKey:string;children:[ReactNode,ReactNode]}){
 const host=useRef<HTMLDivElement>(null),drag=useRef<{position:number;ratio:number;size:number}|null>(null),adjusted=useRef(false);
 const [ratio,setRatio]=useState(50),[narrow,setNarrow]=useState(()=>window.innerWidth<=700);
 const clamp=(value:number)=>Math.max(25,Math.min(75,value));
 useEffect(()=>{let alive=true;void api.settingsGet(storageKey).then(v=>{const n=Number(v);if(alive&&!adjusted.current&&n>=25&&n<=75)setRatio(n);}).catch(()=>{});return()=>{alive=false;};},[storageKey]);
 useEffect(()=>{const resize=()=>setNarrow(window.innerWidth<=700);window.addEventListener('resize',resize);return()=>window.removeEventListener('resize',resize);},[]);
 const save=(value:number)=>{adjusted.current=true;void api.settingsSet(storageKey,String(value)).catch(()=>{});};
 return <div ref={host} className={open?'dw-sql-split dw-sql-split-open':'dw-sql-split'} style={open?(narrow?{gridTemplateRows:`minmax(0,${ratio}fr) 7px minmax(0,${100-ratio}fr)`}:{gridTemplateColumns:`minmax(0,${ratio}fr) 7px minmax(0,${100-ratio}fr)`}):undefined}>
  {children[0]}
  {open&&<div role="separator" tabIndex={0} className="dw-sql-column-resizer" aria-label="调整 SQL 与智能生成比例" aria-orientation={narrow?'horizontal':'vertical'} aria-valuenow={Math.round(ratio)} aria-valuemin={25} aria-valuemax={75} title="拖动调整两侧比例，双击恢复"
   onPointerDown={e=>{if(e.button!==0)return;e.preventDefault();adjusted.current=true;e.currentTarget.setPointerCapture(e.pointerId);const rect=host.current!.getBoundingClientRect();drag.current={position:narrow?e.clientY:e.clientX,ratio,size:narrow?rect.height:rect.width};}}
   onPointerMove={e=>{const start=drag.current;if(start)setRatio(clamp(start.ratio+((narrow?e.clientY:e.clientX)-start.position)/start.size*100));}}
   onPointerUp={e=>{if(drag.current){drag.current=null;save(ratio);e.currentTarget.releasePointerCapture(e.pointerId);}}}
   onPointerCancel={()=>{drag.current=null;}} onLostPointerCapture={()=>{drag.current=null;}}
   onDoubleClick={()=>{setRatio(50);save(50);}}
   onKeyDown={e=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(e.key))return;e.preventDefault();const next=clamp(e.key==='Home'?25:e.key==='End'?75:ratio+(['ArrowLeft','ArrowUp'].includes(e.key)?-2:2));setRatio(next);save(next);}}
  ><span/></div>}
  {children[1]}
 </div>;
}
