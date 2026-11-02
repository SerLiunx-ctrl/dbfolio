import type {Engine} from '../../ipc/types';
import {trackedInvoke as invoke} from '../../ipc/taskInvoke';
export interface MqObject {name:string;kind:'topic'|'queue'|'exchange';count:string|null;partitions:number[];state:string|null}
export interface MqCatalog {engine:Engine;scopes:string[];scope:string;objects:MqObject[];limited:boolean;clusters:string[];capabilities:{read:boolean;readChangesState:boolean;publish:boolean;create:boolean;delete:boolean;purge:boolean;bindings:boolean;consumers:boolean}}
export interface MqMessage {id:string;timestamp:string|null;partition:number|null;offset:string|null;key:string|null;keyBase64:string|null;body:string|null;bodyBase64:string|null;bytes:number;truncated:boolean;propertiesJson:string}
export interface MqPage {messages:MqMessage[];nextOffset:string|null;earliestOffset:string|null;latestOffset:string|null;limited:boolean;notice:string}
export interface MqRead {scope:string;name:string;kind:string;partition:number;offset?:string;timestamp?:number;endTimestamp?:number;key?:string;messageId?:string;limit:number;confirmed:boolean}
export interface MqMutation {action:string;scope:string;name:string;kind:string;confirmed:boolean;partition?:number;partitions?:number;replicas?:number;clusterName?:string;key?:string|null;keyEncoding?:string;body?:string|null;encoding?:string;propertiesJson?:string;routingKey?:string;exchange?:string;exchangeType?:string;durable?:boolean;tag?:string}
export const mqApi={catalog:(sessionId:string,scope?:string)=>invoke<MqCatalog>('mq_catalog',{sessionId,scope}),inspect:(sessionId:string,scope:string,name:string,kind:string)=>invoke<string>('mq_inspect',{sessionId,scope,name,kind}),read:(sessionId:string,request:MqRead,originTabId?:string)=>invoke<MqPage>('mq_read',{sessionId,request,originTabId}),mutate:(sessionId:string,request:MqMutation)=>invoke<unknown>('mq_mutate',{sessionId,request}),export:(path:string,messages:MqMessage[],format:string,source:{engine:Engine;scope:string;name:string;kind:string})=>invoke<number>('mq_export',{path,messages,format,source})};
export const objectKey=(o:{kind:string;name:string})=>JSON.stringify([o.kind,o.name]);
export const systemObject=(name:string)=>/^(__|amq\.|%SYS%|rmq_sys|RMQ_SYS|SCHEDULE_TOPIC_)/i.test(name);
export function matchesMessage(m:MqMessage,search:string){const q=search.toLocaleLowerCase();return !q||[m.id,m.key,m.body,m.offset,m.timestamp,m.propertiesJson].some(v=>v?.toLocaleLowerCase().includes(q));}
export const formatBytes=(bytes:number)=>bytes<1024?`${bytes} B`:bytes<1024*1024?`${(bytes/1024).toFixed(1)} KiB`:`${(bytes/1024/1024).toFixed(1)} MiB`;

/** datetime-local 按分钟输入时，结束边界应包含选中分钟的全部毫秒。 */
export const endOfSelectedMinute=(value:string)=>new Date(value).getTime()+59999;
