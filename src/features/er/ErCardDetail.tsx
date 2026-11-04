import {useEffect,useRef,useState,type ReactNode} from 'react';

// 保留退场内容直到动画结束；收起后立即退出键盘和辅助技术的交互范围。
export function ErCardDetail({open,children}:{open:boolean;children:ReactNode}){
 const [present,setPresent]=useState(open),content=useRef<ReactNode>(null);
 if(open)content.current=children;
 useEffect(()=>{
  if(open){setPresent(true);return;}
  if(!present)return;
  const delay=window.matchMedia('(prefers-reduced-motion: reduce)').matches?0:160;
  const timer=window.setTimeout(()=>{content.current=null;setPresent(false);},delay);
  return()=>window.clearTimeout(timer);
 },[open,present]);
 if(!open&&!present)return null;
 return <aside className="dw-er-card-detail" aria-label={open?'关系图详情':undefined} aria-hidden={!open||undefined} inert={!open} data-state={open?'open':'closing'}>{content.current}</aside>;
}
