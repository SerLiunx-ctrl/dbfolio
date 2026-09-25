import {create} from 'zustand';
import {api} from '../../ipc';
import {type AnalysisPlan,type Dataset,validatePlan} from './model';
export const useAnalysisLibrary=create<{items:AnalysisPlan[]}>(()=>({items:[]}));
export const resultSnapshots=new Map<string,Dataset>();
let loading:Promise<void>|undefined,queue=Promise.resolve();
export function loadAnalyses(){return loading??=(async()=>{const raw=await api.settingsGet('analysis_plans_v1');if(raw){const data=JSON.parse(raw);if(!Array.isArray(data))throw Error('分析库格式无效');useAnalysisLibrary.setState({items:data.map(validatePlan)});}})().catch(e=>{loading=undefined;throw e;});}
export function saveAnalysis(plan:AnalysisPlan){return mutate(items=>[...items.filter(p=>p.id!==plan.id),validatePlan(plan)]);}
export function deleteAnalysis(id:string){return mutate(items=>items.filter(p=>p.id!==id));}
function mutate(update:(p:AnalysisPlan[])=>AnalysisPlan[]){const task=queue.catch(()=>{}).then(async()=>{await loadAnalyses();const items=update(useAnalysisLibrary.getState().items);const raw=JSON.stringify(items);if(items.length>100||raw.length>2*1024*1024)throw Error('最多保存 100 个分析方案，总大小不超过 2 MiB');await api.settingsSet('analysis_plans_v1',raw);useAnalysisLibrary.setState({items});});queue=task;return task;}
