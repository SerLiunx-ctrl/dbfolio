import {matchesShortcut,useShortcutLabel} from '../../app/shortcuts';
import {createPortal} from 'react-dom';
import {useEffect,useRef,useState,type RefObject} from 'react';
import {Button,Input} from '@fluentui/react-components';
import {SearchRegular,ArrowUpRegular,ArrowDownRegular,DismissRegular} from '@fluentui/react-icons';
import type {CellClassRules,GridApi,IRowNode} from 'ag-grid-community';

type Hit={node:IRowNode;column:string;key:string};
const states=new WeakMap<GridApi,{keys:Set<string>;current:string;refresh:()=>void}>();
const keyOf=(node:IRowNode,column:string)=>JSON.stringify([node.id,column]);
export const loadedFindRules:CellClassRules={
  'dw-find-match':p=>Boolean(p.column&&states.get(p.api)?.keys.has(keyOf(p.node,p.column.getColId()))),
  'dw-find-current':p=>Boolean(p.column&&states.get(p.api)?.current===keyOf(p.node,p.column.getColId())),
};
export function refreshLoadedFind(grid:GridApi|null|undefined){if(grid&&!grid.isDestroyed())states.get(grid)?.refresh();}

/** 仅遍历本地网格模型；不查数据库、不改变筛选和选择状态。 */
export function GridFind({grid,root,buttonHost=null}:{buttonHost?:HTMLElement|null;grid:GridApi|null;root:RefObject<HTMLDivElement|null>}){
  const findKey=useShortcutLabel('findData');
  const [open,setOpen]=useState(false),[query,setQuery]=useState(''),[summary,setSummary]=useState({index:-1,count:0});
  const input=useRef<HTMLInputElement>(null),button=useRef<HTMLButtonElement>(null),hits=useRef<Hit[]>([]),index=useRef(-1);
  const position=(next:number)=>{
    if(!grid||grid.isDestroyed())return;
    index.current=next;setSummary({index:next,count:hits.current.length});
    const hit=hits.current[next],state=states.get(grid);if(state)state.current=hit?.key??'';
    if(hit&&hit.node.rowIndex!==null){grid.ensureIndexVisible(hit.node.rowIndex,'middle');grid.ensureColumnVisible(hit.column);}
    grid.refreshCells({force:true});
  };
  const move=(delta:number)=>{const n=hits.current.length;if(n)position((index.current+delta+n)%n);};
  const close=()=>{
    setOpen(false);
    const hit=hits.current[index.current];
    if(grid&&!grid.isDestroyed()&&hit?.node.rowIndex!=null)grid.setFocusedCell(hit.node.rowIndex,hit.column);
    else button.current?.focus();
  };
  useEffect(()=>{if(!open)return;const id=requestAnimationFrame(()=>{input.current?.focus();input.current?.select();});return()=>cancelAnimationFrame(id);},[open]);
  useEffect(()=>{
    const key=(e:KeyboardEvent)=>{
      if(!matchesShortcut('findData',e))return;
      const element=e.target instanceof Element?e.target:null;
      if(element?.closest('input,textarea,[contenteditable="true"],.monaco-editor')&&!element.closest('.dw-grid-find-bar'))return;
      const box=root.current;if(element?.closest('[role="dialog"],[role="alertdialog"]')&&!box?.contains(element)&&!buttonHost?.contains(element))return;if(!box||!box.getBoundingClientRect().width||!box.getBoundingClientRect().height)return;
      const visible=[...document.querySelectorAll('.dw-grid-workbench')].filter(e=>e.getBoundingClientRect().width&&e.getBoundingClientRect().height);
      if(!box.contains(document.activeElement)&&!buttonHost?.contains(document.activeElement)&&visible.length!==1)return;
      e.preventDefault();e.stopPropagation();setOpen(true);input.current?.focus();input.current?.select();
    };
    document.addEventListener('keydown',key,true);return()=>document.removeEventListener('keydown',key,true);
  },[root,buttonHost]);
  useEffect(()=>{
    if(!grid||grid.isDestroyed())return;
    if(!open){states.delete(grid);hits.current=[];index.current=-1;setSummary({index:-1,count:0});grid.refreshCells({force:true});return;}
    let timer:ReturnType<typeof setTimeout>|undefined;
    const scan=()=>{
      if(grid.isDestroyed())return;
      const needle=query.toLowerCase(),old=hits.current[index.current]?.key,next:Hit[]=[];
      if(needle){const columns=grid.getAllDisplayedColumns().filter(c=>/^c\d+$/.test(c.getColId()));
        grid.forEachNodeAfterFilterAndSort(node=>{if(!node.data)return;for(const c of columns){
          const value=grid.getCellValue({rowNode:node,colKey:c,useFormatter:false});
          const text=Array.isArray(value)?value[0]==='null'?'':String(value[1]??''):String(value??'');
          if(text.toLowerCase().includes(needle))next.push({node,column:c.getColId(),key:keyOf(node,c.getColId())});
        }});
      }
      hits.current=next;states.set(grid,{keys:new Set(next.map(h=>h.key)),current:'',refresh:schedule});
      const kept=next.findIndex(h=>h.key===old);position(next.length?Math.max(0,kept):-1);
    };
    const schedule=()=>{if(timer)clearTimeout(timer);timer=setTimeout(scan,120);};
    states.set(grid,{keys:new Set(),current:'',refresh:schedule});schedule();
    const events=['modelUpdated','cellValueChanged','columnVisible','columnMoved','columnPinned'] as const;
    events.forEach(e=>grid.addEventListener(e,schedule));
    return()=>{if(timer)clearTimeout(timer);if(!grid.isDestroyed())events.forEach(e=>grid.removeEventListener(e,schedule));states.delete(grid);if(!grid.isDestroyed())grid.refreshCells({force:true});};
  // 导航不重扫；数据、排序、列显隐及编辑通过网格事件或显式通知合并重扫。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[grid,open,query]);
  const trigger=<Button ref={button} className="dw-grid-toolbar-action" appearance="secondary" size="small" icon={<SearchRegular/>} aria-label="查找已加载数据" title={`查找已加载数据 (${findKey})`} disabled={!grid} onClick={()=>{setOpen(true);input.current?.focus();input.current?.select();}}>查找</Button>;
  return <>{buttonHost?createPortal(trigger,buttonHost):trigger}
    {open&&<div className="dw-grid-find-bar" role="search" aria-label="查找已加载数据" onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();e.stopPropagation();move(e.shiftKey?-1:1);}if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close();}}}>
      <Input ref={input} size="small" aria-label="查找内容" placeholder="查找已加载数据" value={query} onChange={(_,d)=>setQuery(d.value)}/>
      <span className="dw-grid-find-count" role="status">{!query?'输入关键词':summary.count?`${summary.index+1} / ${summary.count}`:'无匹配'}</span>
      <Button size="small" appearance="subtle" icon={<ArrowUpRegular/>} aria-label="上一个匹配" title="上一个 (Shift+Enter)" disabled={!summary.count} onClick={()=>move(-1)}/>
      <Button size="small" appearance="subtle" icon={<ArrowDownRegular/>} aria-label="下一个匹配" title="下一个 (Enter)" disabled={!summary.count} onClick={()=>move(1)}/>
      <small title="仅查找已加载数据的可见列；截断值仅查找已加载部分，不查询数据库。">已加载数据 · 可见列</small>
      <Button size="small" appearance="subtle" icon={<DismissRegular/>} aria-label="关闭查找" title="关闭 (Esc)" onClick={close}/>
    </div>}
  </>;
}
