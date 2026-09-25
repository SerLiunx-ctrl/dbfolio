import { validatePlan } from "../features/analysis/model";
import type { Plan } from "../features/generation/model";
import { create } from "zustand";
import { api } from "../ipc";
import { useTabStore, type WorkspaceTab } from "./useTabStore";
import { useSessionStore } from "./useSessionStore";
export interface SqlDraft { sql: string; database: string; sessionId: string; updatedAt: string; name?: string; filePath?: string; fileBaseline?: string }
export const useWorkspace = create<{generationPlans:Record<string,Plan>;drafts:Record<string,SqlDraft>;saved:Record<string,SqlDraft>;recoveredTabs:number|null}>(()=>({generationPlans:{},drafts:{},saved:{},recoveredTabs:null}));
let lastSaved: string | undefined;
let ready=false, timer:ReturnType<typeof setTimeout>|undefined, queue=Promise.resolve();
const KEY="workspace_v1";
export function updateDraft(id:string,draft:SqlDraft){useWorkspace.setState(s=>({drafts:{...s.drafts,[id]:draft}}));}
export async function saveDraft(id:string,draft:SqlDraft){useWorkspace.setState(s=>({saved:{...s.saved,[id]:draft}}));await flushWorkspace();}
function snapshot(){const tabs=useTabStore.getState();const docs=useWorkspace.getState();return JSON.stringify({version:1,tabs:tabs.tabs,activeId:tabs.activeId,activeSessionId:useSessionStore.getState().activeSessionId,drafts:docs.drafts,generationPlans:docs.generationPlans,saved:docs.saved});}
export function flushWorkspace(){if(timer)clearTimeout(timer);if(!ready)return Promise.resolve();const value=snapshot();queue=queue.catch(()=>{}).then(async()=>{if(value===lastSaved)return;await api.settingsSet(KEY,value);lastSaved=value;});return queue;}
export async function initializeWorkspace(onError:(e:unknown)=>void){
 const raw=await api.settingsGet(KEY);
 if(raw){try{const data=JSON.parse(raw);if(data.version!==1)throw Error("工作区版本不支持");
 const sessions=useSessionStore.getState().sessions;
 const tabs:WorkspaceTab[]=(Array.isArray(data.tabs)?data.tabs:[]).slice(0,500).filter((t:any)=>{
 if((t?.kind==="sync"||t?.kind==="sqlExport"))return typeof t.id==="string"&&t.sessionId===""&&t.database===""&&typeof t.title==="string";
 const session=sessions.find(s=>s.id===t?.sessionId);return session && typeof t.id==="string"&&typeof t.database==="string"&&typeof t.title==="string"&&
 ((t.kind==="analysis"&&(()=>{try{const p=validatePlan(t.plan);return p.sessionId===t.sessionId&&p.database===t.database&&(p.source==="mongo"?session.engine==="mongodb":["mysql","postgres","sqlite"].includes(session.engine));}catch{return false;}})())||(t.kind==="generation"&&t.target&&t.target.sessionId===t.sessionId)||(t.kind==="redis"&&session.engine==="redis")||(t.kind==="mongo"&&session.engine==="mongodb"&&typeof t.collection==="string")||(session.engine!=="redis"&&session.engine!=="mongodb"&&(t.kind==="query"||(t.kind==="table"&&typeof t.table==="string"&&["data","structure","indexes","foreignKeys","ddl","info"].includes(t.view)))));
 });
 const clean=(values:any):Record<string,SqlDraft>=>Object.fromEntries(Object.entries(values??{}).filter(([,v]:any)=>v&&typeof v.sql==="string"&&typeof v.database==="string"&&sessions.some(s=>s.id===v.sessionId))) as Record<string,SqlDraft>;
 useWorkspace.setState({generationPlans:Object.fromEntries(Object.entries(data.generationPlans??{}).filter(([id,v]:any)=>tabs.some(t=>t.id===id&&t.kind==="generation"&&t.sessionId===v?.target?.sessionId)&&v?.version===1&&Array.isArray(v.fields))) as Record<string,Plan>,drafts:clean(data.drafts),saved:clean(data.saved),recoveredTabs:tabs.length||null});
 useTabStore.setState({tabs,activeId:tabs.some(t=>t.id===data.activeId)?data.activeId:null});
 if(sessions.some(s=>s.id===data.activeSessionId))useSessionStore.getState().setActiveSession(data.activeSessionId);
 }catch(e){onError(e);return ()=>{};}}
 ready=true;
 lastSaved=undefined;
 const schedule=()=>{if(timer)clearTimeout(timer);timer=setTimeout(()=>void flushWorkspace().catch(onError),500);};
 const unsub=[useTabStore.subscribe((s,p)=>{if(s.tabs!==p.tabs||s.activeId!==p.activeId)schedule();}),useWorkspace.subscribe((s,p)=>{if(s.drafts!==p.drafts||s.saved!==p.saved||s.generationPlans!==p.generationPlans)schedule();}),useSessionStore.subscribe((s,p)=>{if(s.activeSessionId!==p.activeSessionId)schedule();})];
 return ()=>{unsub.forEach(fn=>fn());if(timer)clearTimeout(timer);ready=false;};
}
