import {generateDdl} from '../table/ddl';
import type { Engine, TableMeta, TableRef } from '../../ipc/types';
export interface DictionaryItem { name:string;schema:string|null;meta:TableMeta|null;error:string|null }
export interface Snapshot { engine:Engine;database:string;serverVersion:string;collectedAt:string;items:DictionaryItem[] }
export interface Note {group:string;note:string;columns:Record<string,string>}
export interface Notes {version:1;objects:Record<string,Note>}
export const objectKey=(v:{name:string;schema?:string|null})=>JSON.stringify([v.schema??null,v.name]);
export const objectLabel=(v:{name:string;schema?:string|null})=>(v.schema?v.schema+'.':'')+v.name;
export const emptyNotes=():Notes=>({version:1,objects:{}});
export const noteFor=(notes:Notes,item:{name:string;schema?:string|null}):Note=>notes.objects[objectKey(item)]??{group:'',note:'',columns:{}};
export const columnNote=(note:Note,name:string)=>Object.prototype.hasOwnProperty.call(note.columns,name)&&typeof note.columns[name]==='string'?note.columns[name]:'';
export function parseNotes(raw:string):Notes {
 const v=JSON.parse(raw);if(v?.version!==1||!v.objects||typeof v.objects!=='object'||Array.isArray(v.objects)||Object.keys(v.objects).length>5000)throw Error('数据字典本地说明格式无效');
 const entries=Object.entries(v.objects).map(([key,n])=>{const item=n as Note;const ref=JSON.parse(key);if(!Array.isArray(ref)||ref.length!==2||!(ref[0]===null||typeof ref[0]==='string')||typeof ref[1]!=='string'||!item||typeof item.group!=='string'||item.group.length>100||typeof item.note!=='string'||!item.columns||typeof item.columns!=='object'||Array.isArray(item.columns)||Object.values(item.columns).some(v=>typeof v!=='string'))throw Error('数据字典本地说明格式无效');return[key,item];});
 if(new TextEncoder().encode(raw).byteLength>2*1024*1024)throw Error('本地说明超过 2 MiB');return{version:1,objects:Object.fromEntries(entries)};
}
export function missing(item:DictionaryItem,notes:Notes){const n=noteFor(notes,item);return{table:!item.meta?.comment?.trim()&&!n.note.trim(),columns:item.meta?.columns.filter(c=>!c.comment?.trim()&&!columnNote(n,c.name).trim()).length??0};}
export function matches(item:DictionaryItem,notes:Notes,search:string,group:string|undefined,onlyMissing:boolean){
 const n=noteFor(notes,item);if(group!==undefined&&n.group!==group)return false;
 const count=missing(item,notes);if(onlyMissing&&!count.table&&!count.columns)return false;
 const needle=search.trim().toLocaleLowerCase();return !needle||[objectLabel(item),item.meta?.comment,n.group,n.note,...(item.meta?.columns??[]).flatMap(c=>[c.name,c.rawType,c.comment,columnNote(n,c.name)])].some(s=>s?.toLocaleLowerCase().includes(needle));
}
export function exportDocument(snapshot:Snapshot,items:DictionaryItem[],notes:Notes){
 if(!items.length)throw Error('当前范围没有对象');if(items.some(i=>!i.meta||i.error))throw Error('导出范围包含采集失败的对象，请重试或调整导出范围');
 return{version:1,engine:snapshot.engine,database:snapshot.database,serverVersion:snapshot.serverVersion,collectedAt:snapshot.collectedAt,entries:items.map(item=>{const note=noteFor(notes,item);return{definition:item.meta!.rawDdl??(item.meta!.kind==='table'?'-- 根据元数据重建，仅供结构说明参考；不保证包含服务器全部属性。\n'+generateDdl(snapshot.engine,item.meta!):null),meta:item.meta!,group:note.group,note:note.note,columnNotes:Object.fromEntries(item.meta!.columns.map(c=>[c.name,columnNote(note,c.name)]))};})};
}
export const references=(catalog:TableRef[],keys:string[])=>catalog.filter(v=>keys.includes(objectKey(v))).map(v=>({name:v.name,schema:v.schema??null}));
