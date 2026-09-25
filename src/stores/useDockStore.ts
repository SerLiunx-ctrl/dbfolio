import { create } from "zustand";
import { api } from "../ipc";
import { rememberUndo } from "./useLocalUndo";
export type DockPanel = "sessions" | "explorer";
export type DockSide = "left" | "right";
export interface DockState { sessions: DockSide; explorer: DockSide; first: DockPanel }
export const DEFAULT_DOCK: DockState = { sessions: "left", explorer: "left", first: "sessions" };
export function normalizeDock(value: unknown): DockState {
  const v = value as Partial<DockState> | null;
  return { sessions: v?.sessions === "right" ? "right" : "left", explorer: v?.explorer === "right" ? "right" : "left", first: v?.first === "explorer" ? "explorer" : "sessions" };
}
export function moveDock(layout: DockState, panel: DockPanel, side: DockSide, top: boolean): DockState {
  return { ...layout, [panel]: side, first: top ? panel : panel === "sessions" ? "explorer" : "sessions" };
}
export function dockTarget(x: number, y: number, bounds: {left:number;top:number;width:number;height:number}) {
  if (x < bounds.left || x > bounds.left + bounds.width || y < bounds.top || y > bounds.top + bounds.height) return null;
  const edge = Math.min(240, bounds.width * .25);
  const side: DockSide | null = x < bounds.left + edge ? "left" : x > bounds.left + bounds.width - edge ? "right" : null;
  return side ? {side, top:y < bounds.top + bounds.height / 2} : null;
}
const KEY = "workspace_panel_dock_v1";
let revision = 0, pending = Promise.resolve();
// 失败的操作未改变当前布局，错误已由操作入口展示；不因此永久阻止退出。
export const flushDockLayout = () => pending.catch(() => {});
function enqueue(operation: () => Promise<void>) {
  revision++;
  const job = pending.catch(() => {}).then(operation);
  pending = job;
  return job;
}
export const useDockStore = create<{layout:DockState;load:()=>Promise<void>;move:(panel:DockPanel,side:DockSide,top:boolean)=>Promise<void>;reset:()=>Promise<void>;apply:(layout:DockState,extra?:Record<string,string>)=>Promise<void>}>((set,get)=>({
  layout: DEFAULT_DOCK,
  load: async()=>{const start=revision;const raw=await api.settingsGet(KEY);if(start===revision){let value;try{value=raw ? JSON.parse(raw) : null;}catch{value=null;}set({layout:normalizeDock(value)});}},
  move: (panel,side,top)=>enqueue(async()=>{const previous=get().layout;const layout=moveDock(previous,panel,side,top);await api.settingsSet(KEY,JSON.stringify(layout));set({layout});rememberUndo("面板停靠",()=>get().apply(previous));}),
  reset: ()=>enqueue(async()=>{const previous=get().layout;await api.settingsSet(KEY,JSON.stringify(DEFAULT_DOCK));set({layout:{...DEFAULT_DOCK}});rememberUndo("恢复默认停靠",()=>get().apply(previous));}),
  apply: (layout,extra={})=>enqueue(async()=>{await api.settingsSetMany({...extra,[KEY]:JSON.stringify(layout)});set({layout});}),
}));
