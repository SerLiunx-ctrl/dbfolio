import {useEffect,useRef} from 'react';
const flushers=new Set<{tabId:string;finish:()=>void}>();
/** 网格结束编辑后会异步通知 React；读取编辑保护登记前等待通知及渲染完成。 */
export function useEditFlusher(tabId:string,finish:()=>void){const latest=useRef(finish);latest.current=finish;useEffect(()=>{const entry={tabId,finish:()=>latest.current()};flushers.add(entry);return()=>{flushers.delete(entry);};},[tabId]);}
export async function flushEditors(tabId:string){
 for(const entry of flushers)if(entry.tabId===tabId)entry.finish();
 await new Promise<void>(resolve=>setTimeout(resolve,0));
 await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
}
