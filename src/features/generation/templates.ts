import {create} from 'zustand';
import {api} from '../../ipc';
import {type Template,validateTemplate} from './model';
export const useGenerationTemplates=create<{items:Template[]}>(()=>({items:[]}));
let loading:Promise<void>|undefined,queue=Promise.resolve();
export function loadTemplates(){return loading??=(async()=>{const raw=await api.settingsGet('generation_templates_v1');if(raw){const a=JSON.parse(raw);if(!Array.isArray(a))throw Error('模板存储格式无效');useGenerationTemplates.setState({items:a.map((v:Template)=>({...validateTemplate(v),id:v.id}))});}})().catch(e=>{loading=undefined;throw e;});}
export function storeTemplate(t:Template){const work=queue.catch(()=>{}).then(async()=>{await loadTemplates();const items=[...useGenerationTemplates.getState().items.filter(v=>v.id!==t.id),t];if(items.length>100)throw Error('最多保存 100 个模板');const raw=JSON.stringify(items);if(raw.length>2*1024*1024)throw Error('模板库超过 2 MiB，请导出归档部分模板');await api.settingsSet('generation_templates_v1',raw);useGenerationTemplates.setState({items});});queue=work;return work;}
export function deleteTemplate(id:string){const work=queue.catch(()=>{}).then(async()=>{await loadTemplates();const items=useGenerationTemplates.getState().items.filter(v=>v.id!==id);await api.settingsSet('generation_templates_v1',JSON.stringify(items));useGenerationTemplates.setState({items});});queue=work;return work;}
