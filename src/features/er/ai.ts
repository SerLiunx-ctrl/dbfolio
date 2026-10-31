import type {TableMeta} from '../../ipc/types';
import type {Relation} from './model';
export type AiCandidate={name:string;from:string;to:string;columns:string[];refColumns:string[];confidence:'high'|'medium'|'low';reason:string;warnings:string[]};
export type AiChecked={candidates:AiCandidate[];rejected:number;duplicates:number};
export type AiRequest={sessionId:string;database:string;tables:{name:string;schema:string|null}[];providerId:string;instruction:string;existing:Pick<Relation,'from'|'to'|'columns'|'refColumns'>[]};
export type AiReply={checked:AiChecked;fingerprint:string;usage:{inputTokens:number|null;outputTokens:number|null;requests:number}};
export type AiVerified={checked:AiChecked;tables:TableMeta[]};
export const confidenceLabel=(value:string)=>({high:'高',medium:'中',low:'低'}[value]??'未知');
export function relationSignature(r:Pick<Relation,'from'|'to'|'columns'|'refColumns'>){
 const direct=JSON.stringify([r.from,r.to,r.columns.map((c,i)=>[c,r.refColumns[i]]).sort()]);
 const reverse=JSON.stringify([r.to,r.from,r.refColumns.map((c,i)=>[c,r.columns[i]]).sort()]);return direct<reverse?direct:reverse;
}
export const annotation=(c:AiCandidate):Relation=>({...c,id:crypto.randomUUID(),manual:true,source:'ai'});
