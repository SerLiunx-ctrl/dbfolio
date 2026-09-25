import {useLayoutEffect,useRef} from 'react';

/** 单个指示条跟随选中标签，使用布局坐标，兼容工作区缩放和标签换行。 */
export function TabIndicator(){
 const ref=useRef<HTMLSpanElement>(null);
 useLayoutEffect(()=>{
  const line=ref.current,strip=line?.parentElement;
  if(!line||!strip)return;
  let frame=0,ready=false;
  const update=()=>{
   const tab=strip.querySelector<HTMLElement>('.dw-workspace-tab[aria-selected="true"]');
   if(!tab||!tab.offsetWidth){line.style.visibility='hidden';ready=false;line.removeAttribute('data-ready');return;}
   line.style.visibility='visible';
   line.style.left=`${tab.offsetLeft}px`;
   line.style.top=`${tab.offsetTop+tab.offsetHeight-2}px`;
   line.style.width=`${tab.offsetWidth}px`;
   if(!ready){ready=true;cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{line.dataset.ready='true';});}
  };
  const resize=new ResizeObserver(update);
  const watch=()=>{resize.disconnect();resize.observe(strip);strip.querySelectorAll('.dw-workspace-tab').forEach(t=>resize.observe(t));update();};
  const observer=new MutationObserver(watch);
  observer.observe(strip,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['aria-selected']});
  watch();
  return()=>{cancelAnimationFrame(frame);observer.disconnect();resize.disconnect();};
 },[]);
 return <span ref={ref} className="dw-tab-indicator" aria-hidden="true"/>;
}
