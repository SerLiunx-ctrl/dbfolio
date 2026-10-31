import {useRef} from 'react';
import {useShortcut} from './shortcuts';
import {confirmEdits,useEditGuard} from '../stores/useEditGuard';
import {flushEditors} from './editFlush';
/** Ctrl+S 沿用编辑保护与 SQL 预览，不隐式提交手动事务。 */
export function SaveCommandBridge({tabId,enabled,onError}:{tabId:string|null;enabled:boolean;onError:(error:unknown)=>void}){
 const lock=useRef(false);
 useShortcut('save',event=>{
  if(lock.current)return;lock.current=true;
  if(event.target instanceof HTMLElement&&event.target.closest('input,textarea,[contenteditable="true"]'))event.target.blur();
  void(async()=>{try{
   await flushEditors(tabId!);
   const matches=(e:import('../stores/useEditGuard').PendingEdit)=>e.tabId===tabId&&e.kind!=='transaction'&&e.shortcutSave!==false;
   const entries=Object.values(useEditGuard.getState().entries).filter(matches);
   if(entries.some(e=>e.busy?.()))throw Error('当前编辑正在处理，请稍后保存');
   if(entries.length&&entries.every(e=>e.local))for(const e of entries)await e.save();
   else if(entries.length)await confirmEdits(matches,'save');
  }catch(e){onError(e);}finally{lock.current=false;}})();
 },enabled&&!!tabId,-100);return null;
}
