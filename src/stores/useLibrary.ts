import { create } from "zustand";
import { api } from "../ipc";
import type { FilterCondition, HistoryEntry } from "../ipc/types";
export interface FilterPreset { id: string; scope: string; name: string; filters: FilterCondition[]; conjunction: "and" | "or" }
export interface SqlFile { path: string; sessionId: string; database: string }
interface Library { history: HistoryEntry[]; filters: FilterPreset[]; files: SqlFile[] }
export const useLibrary = create<Library>(() => ({ history: [], filters: [], files: [] }));
let loading: Promise<void> | undefined, queue = Promise.resolve();
export function loadLibrary() {
  return loading ??= (async () => {
    const raw=await api.settingsGet("productivity_library_v1");
    if (raw) {
      const data=JSON.parse(raw);if(!data || typeof data!=="object")throw Error("收藏与筛选方案格式无效");
      useLibrary.setState({
        history:(Array.isArray(data.history)?data.history:[]).filter((e:HistoryEntry)=>e&&Number.isSafeInteger(e.id)&&typeof e.sql==="string"&&typeof e.sessionId==="string"&&typeof e.executedAt==="string"),
        filters:(Array.isArray(data.filters)?data.filters:[]).filter((p:FilterPreset)=>p&&typeof p.id==="string"&&typeof p.name==="string"&&typeof p.scope==="string"&&["and","or"].includes(p.conjunction)&&Array.isArray(p.filters)&&p.filters.every(f=>f&&typeof f.column==="string"&&typeof f.operator==="string")),
        files:(Array.isArray(data.files)?data.files:[]).filter((f:SqlFile)=>f&&typeof f.path==="string"&&typeof f.database==="string"&&typeof f.sessionId==="string"),
      });
    }
  })().catch(error=>{loading=undefined;throw error;});
}
function update(change: (data: Library) => Library) {
  const job=queue.catch(()=>{}).then(async()=>{await loadLibrary();const next=change(useLibrary.getState());await api.settingsSet("productivity_library_v1",JSON.stringify(next));useLibrary.setState(next);});
  queue=job;return job;
}
export const toggleHistory = (entry: HistoryEntry) => update(s=>({...s,history:s.history.some(e=>e.id===entry.id)?s.history.filter(e=>e.id!==entry.id):[entry,...s.history]}));
export const rememberSqlFile = (file: SqlFile) => update(s=>({...s,files:[file,...s.files.filter(f=>f.path.toLowerCase()!==file.path.toLowerCase())].slice(0,100)}));
export const saveFilterPreset = (preset: FilterPreset) => update(s=>({...s,filters:[preset,...s.filters.filter(p=>p.scope!==preset.scope || p.name!==preset.name)]}));
export const deleteFilterPreset = (id: string) => update(s=>({...s,filters:s.filters.filter(p=>p.id!==id)}));
