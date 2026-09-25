import { availableMonitors, getCurrentWindow, PhysicalPosition, PhysicalSize } from "@tauri-apps/api/window";
import { api } from "../ipc";
import { fitWindow, type WindowGeometry } from "./windowGeometry";

const KEY = "window_geometry_v1";
let geometry: WindowGeometry | null = null;
let started: Promise<void> | undefined;
let queue = Promise.resolve();
let timer: ReturnType<typeof setTimeout> | undefined;

async function capture() {
  const win = getCurrentWindow();
  if (await win.isMinimized()) return;
  const maximized = await win.isMaximized();
  if (maximized && geometry) { geometry = {...geometry,maximized}; return; }
  const [position,size] = await Promise.all([win.outerPosition(),win.innerSize()]);
  geometry = {x:position.x,y:position.y,width:size.width,height:size.height,maximized};
}

export function initializeWindowState(onError: (error: unknown) => void) {
  return started ??= (async () => {
    const win = getCurrentWindow();
    try {
      const raw = await api.settingsGet(KEY);
      const monitors = await availableMonitors();
      geometry = fitWindow(raw ? JSON.parse(raw) : null, monitors.map(m=>m.workArea));
      if (geometry) {
        await win.setPosition(new PhysicalPosition(geometry.x,geometry.y));
        await win.setSize(new PhysicalSize(geometry.width,geometry.height));
        if (geometry.maximized) await win.maximize();
      }
      await capture();
      const changed = () => {
        if(timer) clearTimeout(timer);
        timer=setTimeout(()=>void flushWindowState().catch(onError),250);
      };
      await win.onMoved(changed);
      await win.onResized(changed);
    } catch(error) { onError(error); }
    finally { await win.show(); }
  })();
}

export async function flushWindowState() {
  if(timer) clearTimeout(timer);
  queue=queue.catch(()=>{}).then(async()=>{
    await capture();
    if(geometry) await api.settingsSet(KEY,JSON.stringify(geometry));
  });
  return queue;
}
