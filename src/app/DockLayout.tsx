import { createContext, useContext, useEffect, useRef, useState, type ReactNode, type PointerEvent } from "react";
import { Button, Menu, MenuTrigger, MenuPopover, MenuList, MenuItem, tokens } from "@fluentui/react-components";
import { MoreHorizontalRegular, ArrowLeftRegular, ArrowRightRegular, ArrowUpRegular, ArrowDownRegular, ArrowResetRegular } from "@fluentui/react-icons";
import { dockTarget, useDockStore, type DockPanel, type DockSide } from "../stores/useDockStore";
import { useSettingsStore } from "../stores/useSettingsStore";
import { useNotify } from "./toast";
import { ResizeHandle } from "./ResizeHandle";
import { useFocusMode } from "../stores/useFocusMode";
const DragContext = createContext<(panel:DockPanel,event:PointerEvent)=>void>(()=>{});
export function DockTitle({panel,children}:{panel:DockPanel;children:ReactNode}) {
  const start = useContext(DragContext), notify=useNotify();
  const layout=useDockStore(s=>s.layout);
  const move=(side:DockSide,top:boolean)=>void useDockStore.getState().move(panel,side,top).catch(e=>notify.error(e,"保存布局失败"));
  return <span style={{display:"inline-flex",alignItems:"center",minWidth:0}}>
    <span onPointerDown={event=>{if(event.button===0)start(panel,event);}} title="拖动标题至窗口左/右边缘停靠" style={{cursor:"grab",touchAction:"none",userSelect:"none",whiteSpace:"nowrap"}}>{children}</span>
    <Menu><MenuTrigger disableButtonEnhancement><Button size="small" appearance="subtle" icon={<MoreHorizontalRegular/>} aria-label={panel==="sessions"?"会话布局":"对象浏览器布局"} style={{minWidth:20,width:20,padding:0}}/></MenuTrigger>
      <MenuPopover><MenuList>
        <MenuItem icon={<ArrowLeftRegular/>} onClick={()=>move("left",true)}>移到左侧</MenuItem>
        <MenuItem icon={<ArrowRightRegular/>} onClick={()=>move("right",true)}>移到右侧</MenuItem>
        <MenuItem icon={<ArrowUpRegular/>} onClick={()=>move(layout[panel],true)}>移到同侧上方</MenuItem>
        <MenuItem icon={<ArrowDownRegular/>} onClick={()=>move(layout[panel],false)}>移到同侧下方</MenuItem>
        <MenuItem icon={<ArrowResetRegular/>} onClick={()=>void useDockStore.getState().reset().catch(e=>notify.error(e,"恢复布局失败"))}>恢复默认停靠</MenuItem>
      </MenuList></MenuPopover>
    </Menu>
  </span>;
}
export function DockLayout({sessions,explorer,children}:{sessions:ReactNode;explorer:ReactNode;children:ReactNode}) {
  const layout=useDockStore(s=>s.layout), notify=useNotify();
  const rightWidth=useSettingsStore(s=>s.rightSidebarWidth);
  const width=useSettingsStore(s=>s.sidebarWidth), split=useSettingsStore(s=>s.sidebarSplit), savedCollapsed=useSettingsStore(s=>s.sidebarCollapsed);
  const focus=useFocusMode(s=>s.active), collapsed=savedCollapsed||focus;
  const frame=useRef<HTMLDivElement>(null);
  const [size,setSize]=useState({width:1200,height:700});
  const [drag,setDrag]=useState<{panel:DockPanel;target:ReturnType<typeof dockTarget>}|null>(null);
  const stopRef=useRef<(()=>void)|null>(null);
  useEffect(()=>{void useDockStore.getState().load().catch(e=>notify.error(e,"恢复面板布局失败"));},[notify]);
  useEffect(()=>{const el=frame.current;if(!el)return;const observer=new ResizeObserver(()=>setSize(old=>old.width===el.clientWidth&&old.height===el.clientHeight?old:{width:el.clientWidth,height:el.clientHeight}));observer.observe(el);return()=>{observer.disconnect();stopRef.current?.();};},[]);
  const left=!collapsed&&(layout.sessions==="left"||layout.explorer==="left"), right=!collapsed&&(layout.sessions==="right"||layout.explorer==="right");
  const sides=Number(left)+Number(right);
  const widthCap=Math.max(0,(size.width-240-sides*4)/Math.max(1,sides));
  const leftWidth=Math.min(width,widthCap), actualRightWidth=Math.min(rightWidth,widthCap);
  const both=layout.sessions===layout.explorer;
  const start=(panel:DockPanel,event:PointerEvent)=>{
    event.preventDefault();stopRef.current?.();
    const handle=event.currentTarget as HTMLElement;handle.setPointerCapture(event.pointerId);
    const origin={x:event.clientX,y:event.clientY};let started=false;let target:ReturnType<typeof dockTarget>=null;
    const move=(e:globalThis.PointerEvent)=>{if(e.pointerId!==event.pointerId)return;if(!started&&Math.hypot(e.clientX-origin.x,e.clientY-origin.y)<6)return;started=true;const rect=frame.current?.getBoundingClientRect();target=rect?dockTarget(e.clientX,e.clientY,rect):null;setDrag(old=>old?.panel===panel&&old.target?.side===target?.side&&old.target?.top===target?.top?old:{panel,target});};
    const cleanup=()=>{window.removeEventListener("pointermove",move);window.removeEventListener("pointerup",up);window.removeEventListener("pointercancel",cancel);window.removeEventListener("keydown",key);window.removeEventListener("blur",cancel);handle.removeEventListener("lostpointercapture",cancel);setDrag(null);stopRef.current=null;if(handle.hasPointerCapture(event.pointerId))handle.releasePointerCapture(event.pointerId);};
    const cancel=()=>cleanup();const key=(e:KeyboardEvent)=>{if(e.key==="Escape")cancel();};
    const up=(e:globalThis.PointerEvent)=>{if(e.pointerId!==event.pointerId)return;cleanup();if(started&&target)void useDockStore.getState().move(panel,target.side,target.top).catch(error=>notify.error(error,"保存布局失败"));};
    window.addEventListener("pointermove",move);window.addEventListener("pointerup",up);window.addEventListener("pointercancel",cancel);window.addEventListener("keydown",key);window.addEventListener("blur",cancel);handle.addEventListener("lostpointercapture",cancel);stopRef.current=cleanup;
  };
  const panelStyle=(panel:DockPanel)=>({gridColumn:layout[panel]==="left"?1:5,gridRow:both?(layout.first===panel?"1":"3"):"1 / 4",display:collapsed?"none":"flex",flexDirection:"column" as const,minWidth:0,minHeight:0,overflow:"hidden",borderInlineEnd:layout[panel]==="left"?`1px solid ${tokens.colorNeutralStroke2}`:undefined,borderInlineStart:layout[panel]==="right"?`1px solid ${tokens.colorNeutralStroke2}`:undefined});
  return <DragContext.Provider value={start}><div ref={frame} style={{flex:1,minHeight:0,minWidth:0,display:"grid",position:"relative",gridTemplateColumns:collapsed?"22px 0 minmax(0,1fr) 0 0":`${left?leftWidth:0}px ${left?4:0}px minmax(0,1fr) ${right?4:0}px ${right?actualRightWidth:0}px`,gridTemplateRows:both?`minmax(0,${split}fr) 4px minmax(0,${1-split}fr)`:"minmax(0,1fr) 0 0"}}>
    <div className="dw-sidebar" style={panelStyle("sessions")}>{sessions}</div>
    <div className="dw-sidebar" style={panelStyle("explorer")}>{explorer}</div>
    <div style={{gridColumn:3,gridRow:"1 / 4",minWidth:0,minHeight:0,display:"flex"}}>{children}</div>
    {collapsed&&<Button appearance="subtle" size="small" style={{gridColumn:1,gridRow:"1 / 4",minWidth:22,padding:0}} title={focus?"退出专注模式 (Ctrl+Shift+J)":"展开面板 (Ctrl+B)"} aria-label="展开面板" onClick={()=>{if(focus)useFocusMode.setState({active:false});else void useSettingsStore.getState().setSidebarCollapsed(false);}} icon={<ArrowRightRegular/>}/>}
    {(["left","right"] as const).map(side=>(side==="left"?left:right)&&<div key={side} style={{gridColumn:side==="left"?2:4,gridRow:"1 / 4",display:"flex"}}><ResizeHandle invert={side==="right"} value={side==="left"?leftWidth:actualRightWidth} min={Math.min(200,widthCap)} max={Math.min(460,widthCap)} onChange={v=>(side==="left"?useSettingsStore.getState().setSidebarWidth:useSettingsStore.getState().setRightSidebarWidth)(v,false)} onCommit={v=>(side==="left"?useSettingsStore.getState().setSidebarWidth:useSettingsStore.getState().setRightSidebarWidth)(v,true)}/></div>)}
    {!collapsed&&both&&<div style={{gridColumn:layout.sessions==="left"?1:5,gridRow:2,display:"flex",flexDirection:"column"}}><ResizeHandle direction="vertical" value={size.height*split} min={Math.min(100,size.height*.2)} max={Math.max(100,size.height-100)} onChange={v=>useSettingsStore.getState().setSidebarSplit(v/Math.max(1,size.height),false)} onCommit={v=>useSettingsStore.getState().setSidebarSplit(v/Math.max(1,size.height),true)}/></div>}
    {drag&&<div style={{position:"absolute",inset:0,zIndex:1000,pointerEvents:"none",border:`2px dashed ${tokens.colorBrandStroke1}`}}>
      <div style={{position:"absolute",top:8,left:"50%",transform:"translateX(-50%)",padding:"6px 12px",background:tokens.colorNeutralBackground1,borderRadius:6}}>拖到左/右边缘停靠 · 上下半区决定顺序 · Esc 取消</div>
      {drag.target&&<div style={{position:"absolute",[drag.target.side]:0,top:layout[drag.panel === "sessions" ? "explorer" : "sessions"] === drag.target.side && !drag.target.top ? "50%" : 0,height:layout[drag.panel === "sessions" ? "explorer" : "sessions"] === drag.target.side ? "50%" : "100%",width:drag.target.side==="left"?leftWidth:actualRightWidth,background:tokens.colorBrandBackground2,border:`2px solid ${tokens.colorBrandStroke1}`,display:"grid",placeItems:"center"}}>{drag.panel==="sessions"?"会话":"对象浏览器"} · {drag.target.side==="left"?"左侧":"右侧"}{drag.target.top?"上方":"下方"}</div>}
    </div>}
  </div></DragContext.Provider>;
}
