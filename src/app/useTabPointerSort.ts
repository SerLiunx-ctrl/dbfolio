import {useEffect, useRef, useState, type PointerEvent as ReactPointerEvent} from 'react';

/** Pointer sorting coexists with Tauri native file drops on Windows. */
export function useTabPointerSort(moveTab:(id:string,target:string,after:boolean)=>void) {
  const [target,setTarget]=useState<{id:string;after:boolean}|null>(null);
  const drag=useRef<{id:string;x:number;y:number;active:boolean;target:typeof target}|null>(null);
  const move=useRef(moveTab);move.current=moveTab;
  const suppressClick=useRef(false);
  useEffect(()=>{
    const reset=()=>{drag.current=null;setTarget(null);};
    const onMove=(e:PointerEvent)=>{
      const current=drag.current;if(!current)return;
      if(!(e.buttons&1)){reset();return;}
      if(!current.active&&Math.hypot(e.clientX-current.x,e.clientY-current.y)<5)return;
      current.active=true;e.preventDefault();
      const element=document.elementFromPoint(e.clientX,e.clientY)?.closest<HTMLElement>('[data-sort-tab]');
      const id=element?.dataset.sortTab;
      const next=element&&id&&id!==current.id?{id,after:e.clientX>element.getBoundingClientRect().left+element.getBoundingClientRect().width/2}:null;
      current.target=next;setTarget(next);
      const strip=element?.closest<HTMLElement>('[role="tablist"]');
      if(strip){const rect=strip.getBoundingClientRect();if(e.clientX<rect.left+24)strip.scrollLeft-=16;else if(e.clientX>rect.right-24)strip.scrollLeft+=16;}
    };
    const onUp=()=>{
      const current=drag.current;
      if(current?.active){suppressClick.current=true;if(current.target)move.current(current.id,current.target.id,current.target.after);}
      reset();
    };
    document.addEventListener('pointermove',onMove,{passive:false});document.addEventListener('pointerup',onUp);
    document.addEventListener('pointercancel',reset);window.addEventListener('blur',reset);
    return()=>{document.removeEventListener('pointermove',onMove);document.removeEventListener('pointerup',onUp);document.removeEventListener('pointercancel',reset);window.removeEventListener('blur',reset);};
  },[]);
  const start=(e:ReactPointerEvent,id:string)=>{
    suppressClick.current=false;
    if(e.button!==0||(e.target as Element).closest('button'))return;
    drag.current={id,x:e.clientX,y:e.clientY,active:false,target:null};
  };
  const consumeClick=()=>{const value=suppressClick.current;suppressClick.current=false;return value;};
  return {target,start,consumeClick};
}
