import {Channel} from '@tauri-apps/api/core';
import {trackedInvoke} from '../../ipc/taskInvoke';
import type {TableMeta} from '../../ipc/types';
export interface Question {text:string;options?:string[];multiple?:boolean;requiresText?:boolean}
export interface Candidate {risk?:import("./sqlRisk").SqlRisk;sql:string;explanation:string;assumptions:string[];questions:(string|Question)[]}
export interface Reply {candidate:Candidate;validationError:string|null;usage:{inputTokens:number|null;outputTokens:number|null}}
export interface Snapshot {text:string;diagnostic:string;truncated:boolean;status:number}
export type AiEvent={kind:'delta';text:string}|{kind:'response';response:Snapshot}|{kind:'finished'};
export function schemaContext(meta:TableMeta){return {name:meta.name,schema:meta.schema,comment:meta.comment,columns:meta.columns.map(c=>({name:c.name,type:c.rawType,comment:c.comment,nullable:c.nullable})),indexes:meta.indexes,foreignKeys:meta.foreignKeys};}
export async function askQuery(request:Record<string,unknown>,onEvent:(e:AiEvent)=>void,originTabId?:string){
 const channel=new Channel<AiEvent>();let finish!:()=>void;const done=new Promise<void>(r=>finish=r);channel.onmessage=e=>{if(e.kind==='finished')finish();else onEvent(e);};
 try{return await trackedInvoke<Reply>('query_ai',{request,onEvent:channel,originTabId});}finally{let timer:ReturnType<typeof setTimeout>|undefined;await Promise.race([done,new Promise<void>(r=>{timer=setTimeout(r,1500);})]);clearTimeout(timer);}
}
