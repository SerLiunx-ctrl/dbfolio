import {create} from 'zustand';
import {api} from '../ipc';
import type {BusinessRelation} from '../features/relations/model';
const KEY='business_relations_v1';
let loading:Promise<void>|undefined,queue=Promise.resolve();
export const useRelations=create<{items:BusinessRelation[];loaded:boolean}>(()=>({items:[],loaded:false}));
export function loadRelations(){
  if(useRelations.getState().loaded)return Promise.resolve();
  return loading??(loading=(async()=>{
    const raw=await api.settingsGet(KEY),items=raw?JSON.parse(raw):[];
    if(!Array.isArray(items)||items.some(r=>!r?.id||!r.source?.sessionId||!r.source?.table||!r.target?.table||!Array.isArray(r.columns)||!Array.isArray(r.keys)))throw Error('业务关联配置格式无效');
    useRelations.setState({items,loaded:true});
  })().finally(()=>{loading=undefined;}));
}
export function saveRelation(relation:BusinessRelation,remove=false){
  const work=queue.catch(()=>{}).then(async()=>{await loadRelations();const items=useRelations.getState().items.filter(r=>r.id!==relation.id);if(!remove)items.push(relation);await api.settingsSet(KEY,JSON.stringify(items));useRelations.setState({items});});
  queue=work;return work;
}
