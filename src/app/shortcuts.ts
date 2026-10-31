import {useEffect,useRef} from 'react';
import {useShortcutStore} from '../stores/useShortcutStore';
import {displayShortcut,eventShortcut,type ShortcutId} from './shortcutModel';
type Handler={id:ShortcutId;priority:number;run:(event:KeyboardEvent)=>boolean|void};
const handlers=new Set<Handler>();let installed=false;
function dispatch(event:KeyboardEvent){
 const target=event.target instanceof Element?event.target:null;
 if(event.isComposing||target?.closest('[data-shortcut-recorder]'))return;
 if([...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].some(e=>e.getBoundingClientRect().width))return;
 const key=eventShortcut(event);if(!key)return;
 for(const handler of [...handlers].sort((a,b)=>b.priority-a.priority)){
  if(useShortcutStore.getState().bindings[handler.id]!==key)continue;
  if(event.repeat&&!['zoomIn','zoomOut'].includes(handler.id)){event.preventDefault();event.stopImmediatePropagation();return;}
  if(handler.run(event)===false)continue;
  event.preventDefault();event.stopImmediatePropagation();return;
 }
}
export function registerShortcut(id:ShortcutId,run:Handler['run'],priority=0){if(!installed){window.addEventListener('keydown',dispatch,true);installed=true;}const entry={id,run,priority};handlers.add(entry);return()=>{handlers.delete(entry);if(!handlers.size){window.removeEventListener('keydown',dispatch,true);installed=false;}};}
export function useShortcut(id:ShortcutId,run:Handler['run'],enabled=true,priority=0){const latest=useRef({run,enabled});latest.current={run,enabled};useEffect(()=>registerShortcut(id,e=>latest.current.enabled?latest.current.run(e):false,priority),[id,priority]);}
export function useShortcutLabel(id:ShortcutId){return useShortcutStore(s=>displayShortcut(s.bindings[id]));}
export function matchesShortcut(id:ShortcutId,event:KeyboardEvent|React.KeyboardEvent){return eventShortcut(event)===useShortcutStore.getState().bindings[id];}
