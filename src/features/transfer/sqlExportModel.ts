import type { SourceFilter } from '../sync/model';
export interface SqlExportDraft {sessionId:string;database:string;tables:string[];allTables:boolean;mode:'structure'|'data'|'both';splitFiles:boolean;includeDatabase:boolean;dropTables:boolean;consistentSnapshot:boolean;batchRows:number;batchBytes:number;filters:Record<string,SourceFilter>}
export const DEFAULT_SQL_EXPORT:SqlExportDraft={sessionId:'',database:'',tables:[],allTables:false,mode:'both',splitFiles:false,includeDatabase:false,dropTables:false,consistentSnapshot:true,batchRows:500,batchBytes:1048576,filters:{}};
export interface SqlExportResult {path:string;rows:number;bytes:number;tables:number}
