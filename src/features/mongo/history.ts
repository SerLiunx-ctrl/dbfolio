import {create} from 'zustand';
import {api} from '../../ipc';
import type {MongoQuery} from './api';
export interface MongoHistory {id:string;sessionId:string;database:string;collection:string;query:MongoQuery;at:string;favorite:boolean;}
export const useMongoHistory=create<{items:MongoHistory[]}>(()=>({items:[]}));
let loaded:Promise<void>|undefined,queue=Promise.resolve();
export function loadMongoHistory(){return loaded??=(async()=>{const raw=await api.settingsGet('mongo_history_v1');if(raw){const items=JSON.parse(raw);useMongoHistory.setState({items:Array.isArray(items)?items.filter(i=>typeof i.id==='string'&&i.query&&typeof i.query.filter==='string'&&typeof i.query.projection==='string'&&typeof i.query.sort==='string'&&Number.isFinite(i.query.limit)&&typeof i.sessionId==='string'&&typeof i.database==='string'&&typeof i.collection==='string').slice(0,200):[]});}})().catch(e=>{loaded=undefined;throw e;});}
function update(fn:(items:MongoHistory[])=>MongoHistory[]){const job=queue.catch(()=>{}).then(async()=>{await loadMongoHistory();const next=fn(useMongoHistory.getState().items);const items=[...next.filter(i=>i.favorite).slice(0,100),...next.filter(i=>!i.favorite).slice(0,100)];await api.settingsSet('mongo_history_v1',JSON.stringify(items));useMongoHistory.setState({items});});queue=job;return job;}
export function addMongoHistory(item:Omit<MongoHistory,'id'|'at'|'favorite'>){return update(items=>[{...item,id:crypto.randomUUID(),at:new Date().toISOString(),favorite:false},...items.filter(i=>i.favorite||JSON.stringify([i.sessionId,i.database,i.collection,i.query])!==JSON.stringify([item.sessionId,item.database,item.collection,item.query]))] );}
export const starMongoHistory=(id:string)=>update(items=>{const item=items.find(i=>i.id===id);if(item&&!item.favorite&&items.filter(i=>i.favorite).length>=100)throw Error('最多收藏 100 条 MongoDB 查询，请先取消部分收藏');return items.map(i=>i.id===id?{...i,favorite:!i.favorite}:i);});
