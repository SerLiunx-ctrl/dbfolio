import {createPortal} from 'react-dom';
import { GridFind } from './GridFind';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Checkbox, Input, Popover, PopoverSurface, PopoverTrigger, Select, Tooltip, type ButtonProps } from '@fluentui/react-components';
import { TableSettingsRegular, PanelRightRegular, PanelBottomRegular, DismissRegular } from '@fluentui/react-icons';
import type { ColumnState, GridApi } from 'ag-grid-community';
import { api } from '../../ipc';
import { useNotify } from '../../app/toast';
import './grid-workbench.css';

type Layout = Pick<ColumnState, 'colId' | 'width' | 'hide' | 'pinned' | 'flex'>[];
export function GridIconButton({label,showLabel=false,...props}:ButtonProps&{label:string;showLabel?:boolean}) {
  return <Tooltip content={label} relationship="label"><Button size="small" appearance={showLabel?"secondary":"subtle"} className={showLabel?"dw-grid-toolbar-action":"dw-grid-icon-action"} aria-label={label} title={label} {...props}>{showLabel?label:null}</Button></Tooltip>;
}
const cached = new Map<string, Layout>();
export function useGridLayout(scope: string, columns: {name:string;rawType:string}[]) {
  const [grid, setGrid] = useState<GridApi | null>(null);
  const [revision, setRevision] = useState(0);
  const restoring = useRef(false), touched = useRef(false), timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const signature = JSON.stringify(columns.map(c => [c.name,c.rawType]));
  const key = 'dw.gridLayout.v1.' + JSON.stringify([scope,signature]);
  const notify = useNotify();
  const persist = () => {
    if (!grid || restoring.current || grid.isDestroyed()) return;
    touched.current = true;
    const state = grid.getColumnState().filter(c=>/^c\d+$/.test(c.colId)).map(({colId,width,hide,pinned,flex})=>({colId,width,hide,pinned,flex}));
    // 缓存只有有限个布局，不保存任何数据行或单元格内容。
    if (cached.size >= 100 && !cached.has(key)) cached.delete(cached.keys().next().value!);
    cached.set(key,state);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(()=>{timer.current=null;void api.settingsSet(key,JSON.stringify(state)).catch(e=>notify.error(e,'列布局保存失败'));},250);
    setRevision(v=>v+1);
  };
  useEffect(()=>{
    if (!grid) return;
    let alive=true;touched.current=false;
    restoring.current=true;
    grid.applyColumnState({state:columns.map((_,i)=>{const colId=`c${i}`,def=grid.getColumn(colId)?.getColDef();return {colId,hide:false,pinned:null,width:def?.initialWidth??110,flex:def?.initialFlex??null};}),applyOrder:true});
    restoring.current=false;
    const restore=(value:unknown)=>{
      if(!alive||touched.current||grid.isDestroyed()||!Array.isArray(value))return;
      const known=new Set(columns.map((_,i)=>`c${i}`)), seen=new Set<string>();
      const state:Layout=[];
      for(const item of value){
        if(!item||!known.has(item.colId)||seen.has(item.colId))continue;
        seen.add(item.colId);
        state.push({colId:item.colId,width:Number.isFinite(item.width)?Math.max(80,Math.min(8000,item.width)):undefined,hide:item.hide===true,pinned:item.pinned==='left'||item.pinned==='right'?item.pinned:null,flex:Number.isFinite(item.flex)?Math.max(0,Math.min(10,item.flex)):null});
      }
      if(state.length&&state.every(c=>c.hide))state[0].hide=false;
      restoring.current=true;
      grid.applyColumnState({state,applyOrder:true});
      restoring.current=false;setRevision(v=>v+1);
    };
    const local=cached.get(key);
    if(local)restore(local);
    else void api.settingsGet(key).then(text=>{if(text){try{restore(JSON.parse(text));}catch{/* 损坏偏好不影响查询。 */}}}).catch(()=>{});
    return ()=>{alive=false;if(timer.current){clearTimeout(timer.current);timer.current=null;const latest=cached.get(key);if(latest)void api.settingsSet(key,JSON.stringify(latest)).catch(()=>{});}};
  // 列结构改变才重新读取；行刷新不覆盖用户布局。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[grid,key]);
  return {grid,setGrid,persist,revision,reset:()=>{
    if(!grid)return;
    restoring.current=true;
    // 显式清除显隐/冻结；列定义未声明 hide/pinned 时，不能依赖 undefined 重置旧状态。
    const state=columns.map((_,i)=>{const colId=`c${i}`,def=grid.getColumn(colId)?.getColDef();return {colId,hide:false,pinned:null,width:def?.initialWidth??110,flex:def?.initialFlex??null};});
    grid.applyColumnState({state,applyOrder:true});
    restoring.current=false;persist();
  }};
}

export function GridColumns({layout,columns}:{layout:ReturnType<typeof useGridLayout>;columns:{name:string;rawType:string}[]}) {
  const [search,setSearch]=useState('');
  const grid=layout.grid;
  const states=grid&&!grid.isDestroyed()?grid.getColumnState().filter(c=>/^c\d+$/.test(c.colId)):[];
  const visible=states.filter(c=>!c.hide).length;
  const change=(state:ColumnState)=>{grid?.applyColumnState({state:[state]});layout.persist();};
  return <Popover positioning={{position:'below',align:'end'}}><PopoverTrigger disableButtonEnhancement><Button size="small" appearance="secondary" className="dw-grid-toolbar-action" aria-label="列管理" title="列管理" icon={<TableSettingsRegular/>} disabled={!grid}>列管理</Button></PopoverTrigger>
    <PopoverSurface className="dw-grid-columns"><div className="dw-grid-column-heading"><strong>列管理</strong><Button size="small" onClick={layout.reset}>恢复默认</Button></div>
      <Input size="small" aria-label="搜索列" placeholder="搜索列名" value={search} onChange={(_,d)=>setSearch(d.value)}/>
      <div className="dw-grid-column-list">{states.map((s,index)=>{const c=columns[Number(s.colId.slice(1))];if(!c||!c.name.toLowerCase().includes(search.toLowerCase()))return null;
        return <div className="dw-grid-column-item" key={s.colId}>
          <Checkbox aria-label={`显示列 ${c.name}`} checked={!s.hide} disabled={!s.hide&&visible<=1} onChange={(_,d)=>change({colId:s.colId,hide:!d.checked})}/>
          <span title={`${c.name} · ${c.rawType}`}>{c.name}<small>{c.rawType}</small></span>
          <Select size="small" aria-label={`冻结列 ${c.name}`} value={s.pinned==='left'||s.pinned==='right'?s.pinned:''} onChange={(_,d)=>change({colId:s.colId,pinned:d.value==='left'?'left':d.value==='right'?'right':null})}><option value="">不冻结</option><option value="left">左侧</option><option value="right">右侧</option></Select>
          <Button size="small" aria-label={`上移列 ${c.name}`} disabled={index===0} onClick={()=>{grid?.moveColumns([s.colId],Math.max(0,(grid.getAllGridColumns().findIndex(c=>c.getColId()===s.colId)??1)-1));layout.persist();}}>↑</Button>
          <Button size="small" aria-label={`下移列 ${c.name}`} disabled={index===states.length-1} onClick={()=>{grid?.moveColumns([s.colId],(grid.getAllGridColumns().findIndex(c=>c.getColId()===s.colId)??0)+1);layout.persist();}}>↓</Button>
        </div>;
      })}</div><small>拖动表头也可调整顺序；至少保留一列。</small>
    </PopoverSurface></Popover>;
}

interface DockSize {side:'bottom'|'right';height:number;width:number}
const defaultSize:DockSize={side:'bottom',height:240,width:440};
let savedSize:DockSize|undefined;
export function GridWorkbench({children,tools,inspector,onClose,grid=null,toolbarHost=null}:{toolbarHost?:HTMLElement|null;grid?:GridApi|null;children:ReactNode;tools:ReactNode;inspector:ReactNode;onClose:()=>void}) {
  const [size,setSize]=useState<DockSize>(savedSize??defaultSize), touched=useRef(false), root=useRef<HTMLDivElement>(null);
  const drag=useRef<{start:number;initial:number;scale:number;size:DockSize}|null>(null);
  const notify=useNotify();
  useEffect(()=>{if(savedSize)return;let alive=true;void api.settingsGet('dw.gridDock.v1').then(text=>{if(!alive||touched.current||!text)return;try{const v=JSON.parse(text);const next:DockSize={side:v.side==='right'?'right':'bottom',height:Math.max(140,Math.min(900,Number(v.height)||240)),width:Math.max(260,Math.min(1200,Number(v.width)||440))};savedSize=next;setSize(next);}catch{/* 默认尺寸 */}}).catch(()=>{});return()=>{alive=false;};},[]);
  const save=(v:DockSize)=>{touched.current=true;savedSize=v;setSize(v);void api.settingsSet('dw.gridDock.v1',JSON.stringify(v)).catch(e=>notify.error(e,'详情布局保存失败'));};
  return <div ref={root} className="dw-grid-workbench"><div className="dw-grid-tools" data-external={!!toolbarHost}><GridFind grid={grid} root={root} buttonHost={toolbarHost}/>{toolbarHost?createPortal(tools,toolbarHost):tools}</div><div className={`dw-grid-split dw-grid-split-${size.side}`}>
    <div className="dw-grid-main">{children}</div>
    {inspector&&<><div role="separator" aria-label="调整单元格详情尺寸" aria-orientation={size.side==='bottom'?'horizontal':'vertical'} tabIndex={0} className="dw-grid-splitter"
      onPointerDown={e=>{const r=root.current!;drag.current={start:size.side==='bottom'?e.clientY:e.clientX,initial:size.side==='bottom'?size.height:size.width,scale:r.getBoundingClientRect().width/r.offsetWidth,size};e.currentTarget.setPointerCapture(e.pointerId);}}
      onPointerMove={e=>{const d=drag.current;if(!d)return;const delta=(d.start-(size.side==='bottom'?e.clientY:e.clientX))/d.scale;const next={...size,[size.side==='bottom'?'height':'width']:Math.max(size.side==='bottom'?140:260,Math.min(size.side==='bottom'?900:1200,d.initial+delta))};touched.current=true;setSize(next);}}
      onPointerUp={e=>{if(drag.current){drag.current=null;save(size);e.currentTarget.releasePointerCapture(e.pointerId);}}}
      onPointerCancel={()=>{if(drag.current)setSize(drag.current.size);drag.current=null;}}
      onKeyDown={e=>{const delta=e.key==='ArrowUp'||e.key==='ArrowLeft'?20:e.key==='ArrowDown'||e.key==='ArrowRight'?-20:0;if(delta){e.preventDefault();save({...size,[size.side==='bottom'?'height':'width']:Math.max(size.side==='bottom'?140:260,Math.min(size.side==='bottom'?900:1200,(size.side==='bottom'?size.height:size.width)+delta))});}}}/>
      <section aria-label="单元格详情" className="dw-grid-inspector" style={size.side==='bottom'?{height:size.height}:{width:size.width}}><div className="dw-grid-inspector-bar"><strong>单元格详情</strong><span/><GridIconButton label={size.side==='bottom'?'停靠右侧':'停靠底部'} icon={size.side==='bottom'?<PanelRightRegular/>:<PanelBottomRegular/>} onClick={()=>save({...size,side:size.side==='bottom'?'right':'bottom'})}/><GridIconButton label="关闭单元格详情" icon={<DismissRegular/>} onClick={onClose}/></div>{inspector}</section></>}
  </div></div>;
}
