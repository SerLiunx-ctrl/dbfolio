import {trackedInvoke as invoke} from '../../ipc/taskInvoke';
export interface MongoQuery {filter:string;projection:string;sort:string;limit:number;}
export interface MongoRow {id:string|null;json:string;truncated:boolean;}
export interface MongoPage {rows:MongoRow[];cursor:string|null;}
export const mongo={
 collections:(sessionId:string,database:string)=>invoke<string[]>('mongo_collections',{sessionId,database}),
 find:(sessionId:string,database:string,collection:string,query:MongoQuery)=>invoke<MongoPage>('mongo_find',{sessionId,request:{database,collection,...query}}),
 next:(sessionId:string,cursor:string)=>invoke<MongoPage>('mongo_next',{sessionId,cursor}),
 release:(sessionId:string,cursor:string)=>invoke<void>('mongo_release',{sessionId,cursor}),
 document:(sessionId:string,database:string,collection:string,id:string)=>invoke<string>('mongo_document',{sessionId,database,collection,id}),
 write:(sessionId:string,database:string,collection:string,operation:string,original:string|null,text:string)=>invoke<string>('mongo_write',{sessionId,database,collection,operation,original,text}),
};
