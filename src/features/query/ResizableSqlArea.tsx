import {api} from '../../ipc';
import {useEffect,useId,useRef,useState,type ReactNode} from 'react';
import './query-ai.css';

export function ResizableSqlArea({children,storageKey,reserveResults=false,expanded=false}:{children:ReactNode;storageKey:string;reserveResults?:boolean;expanded?:boolean}){
 const [narrow,setNarrow]=useState(()=>window.innerWidth<=700);
 const initial=320,min=expanded&&narrow?360:160,host=useRef<HTMLDivElement>(null),drag=useRef<{y:number;height:number;scale:number}|null>(null),id=useId();
 const adjusted=useRef(false);
 const [height,setHeight]=useState(initial);
 useEffect(()=>{let active=true;void api.settingsGet(storageKey).then(value=>{const saved=Number(value);if(active&&!adjusted.current&&saved>=160&&saved<=1600)setHeight(clamp(saved));}).catch(()=>{});return()=>{active=false;};},[storageKey]);
 const maximum=()=>{
  const node=host.current,parent=node?.parentElement;if(!node||!parent)return 800;
  const rect=node.getBoundingClientRect(),scale=rect.height/(node.offsetHeight||1)||1;
  return Math.max(min,reserveResults?parent.clientHeight-(rect.top-parent.getBoundingClientRect().top)/scale-140:window.innerHeight/scale*.7);
 };
 const clamp=(n:number)=>Math.round(Math.max(min,Math.min(maximum(),n)));
 const save=(n:number)=>{adjusted.current=true;void api.settingsSet(storageKey,String(n)).catch(()=>{});};
 useEffect(()=>{
  const resize=()=>{setNarrow(window.innerWidth<=700);if(host.current?.offsetHeight)setHeight(h=>clamp(h));};
  const observer=new ResizeObserver(resize);if(host.current?.parentElement)observer.observe(host.current.parentElement);
  window.addEventListener('resize',resize);resize();return()=>{observer.disconnect();window.removeEventListener('resize',resize);};
 },[reserveResults,min]);
 return <div ref={host} className="dw-resizable-sql" style={{height,minHeight:min}}>
  <div id={id} className="dw-resizable-sql-content">{children}</div>
  <div className="dw-sql-resizer" role="separator" tabIndex={0} aria-label="调整 SQL 编辑区高度" aria-orientation="horizontal" aria-controls={id} aria-valuenow={height} aria-valuemin={min} aria-valuemax={Math.max(height,Math.round(maximum()))} title="拖动调整高度，双击恢复；方向键微调"
   onPointerDown={e=>{if(e.button!==0)return;adjusted.current=true;e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId);const node=host.current!;drag.current={y:e.clientY,height,scale:node.getBoundingClientRect().height/node.offsetHeight||1};}}
   onPointerMove={e=>{const start=drag.current;if(start)setHeight(clamp(start.height+(e.clientY-start.y)/start.scale));}}
   onPointerUp={e=>{if(drag.current){drag.current=null;save(height);e.currentTarget.releasePointerCapture(e.pointerId);}}}
   onPointerCancel={()=>{drag.current=null;}} onLostPointerCapture={()=>{drag.current=null;}}
   onDoubleClick={()=>{const next=clamp(initial);setHeight(next);save(next);}}
   onKeyDown={e=>{if(!['ArrowUp','ArrowDown','Home','End'].includes(e.key))return;e.preventDefault();const next=clamp(e.key==='Home'?min:e.key==='End'?maximum():height+(e.key==='ArrowUp'?-20:20));setHeight(next);save(next);}}
  ><span/></div>
 </div>;
}
