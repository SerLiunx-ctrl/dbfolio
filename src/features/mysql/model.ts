import {trackedInvoke as invoke} from '../../ipc/taskInvoke';
import type {QueryOutcome} from '../../ipc/types';
export type ObjectKind='view'|'procedure'|'function'|'trigger'|'event';
export const OBJECT_LABELS:Record<ObjectKind,string>={view:'视图',procedure:'存储过程',function:'函数',trigger:'触发器',event:'事件'};
export interface MysqlObject {kind:ObjectKind;name:string;parent:string|null;detail:string}
export interface Catalog {objects:MysqlObject[];scheduler:string;version:string}
export interface Definition {sql:string;dependencies:string[];parameters:{name:string;mode:string;dataType:string}[];sqlMode:string;charset:string;collation:string}
export interface ImportRequest {sessionId:string;database:string;path:string;encoding:string;continueOnError:boolean}
export interface ImportPreview {id:string;statements:number;bytes:number;scopes:string[];samples:{line:number;sql:string}[];warnings:string[]}
export interface ImportReport {executed:number;failed:number;cancelled:boolean;uncertain:boolean;error:string|null;reportPath:string;entries:{number:number;line:number;database:string;status:string;affected:number;error:string|null}[]}
export const mysqlApi={
 preview:(request:ImportRequest,originTabId:string)=>invoke<ImportPreview>('sql_import_preview',{request,originTabId}),
 execute:(sessionId:string,id:string,reportDirectory:string,originTabId:string)=>invoke<ImportReport>('sql_import_execute',{sessionId,id,reportDirectory,confirmed:true,originTabId}),
 objects:(sessionId:string,database:string)=>invoke<Catalog>('mysql_objects',{sessionId,database}),
 definition:(sessionId:string,database:string,kind:ObjectKind,name:string)=>invoke<Definition>('mysql_object_definition',{sessionId,database,kind,name}),
 apply:(request:{sessionId:string;database:string;kind:ObjectKind;name:string;sql:string|null;original:string|null;confirmed:boolean})=>invoke<void>('mysql_object_apply',{request}),
 call:(request:{sessionId:string;database:string;name:string;values:(string|null)[];confirmed:boolean},originTabId:string)=>invoke<{results:QueryOutcome[];truncated:boolean}>('mysql_procedure_call',{request,originTabId}),
};
