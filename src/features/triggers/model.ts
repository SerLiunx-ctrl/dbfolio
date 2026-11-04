import {trackedInvoke as invoke} from '../../ipc/taskInvoke';
export interface TriggerDraft {timing:'BEFORE'|'AFTER'|'INSTEAD OF';events:string[];orientation:'ROW'|'STATEMENT';body:string;functionSchema:string|null;functionName:string|null}
export interface TriggerItem {name:string;schema:string|null;table:string;timing:string;event:string;enabled:string|null}
export interface TriggerTarget {name:string;schema:string|null;kind:'table'|'view'}
export interface TriggerCatalog {items:TriggerItem[];functions:{schema:string;name:string}[];targets?:TriggerTarget[];engine:string;version:string}
export interface TriggerDefinition {sql:string;draft:TriggerDraft|null;warning:string}
export interface TriggerChange {sessionId:string;database:string;table:string;schema:string|null;name:string;draft:TriggerDraft|null;original:string|null;confirmed:boolean}
export interface TriggerPreview {statements:string[];warning:string}
export const triggerKey=(t:Pick<TriggerItem,'schema'|'table'|'name'>)=>JSON.stringify([t.schema??null,t.table,t.name]);
export const targetKey=(t:{schema?:string|null;name:string})=>JSON.stringify([t.schema??null,t.name]);
export const targetLabel=(t:{schema?:string|null;name:string})=>(t.schema?t.schema+'.':'')+t.name;
export const newTriggerDraft=(view=false):TriggerDraft=>({timing:view?'INSTEAD OF':'AFTER',events:['INSERT'],orientation:'ROW',body:'',functionSchema:null,functionName:null});
export const triggerApi={
 catalog:(sessionId:string,database:string)=>invoke<TriggerCatalog>('trigger_catalog',{sessionId,database}),
 definition:(sessionId:string,database:string,t:TriggerItem)=>invoke<TriggerDefinition>('trigger_definition',{sessionId,database,name:t.name,table:t.table,schema:t.schema??null}),
 preview:(request:TriggerChange)=>invoke<TriggerPreview>('trigger_preview',{request}),
 apply:(request:TriggerChange)=>invoke<void>('trigger_apply',{request:{...request,confirmed:true}}),
};
