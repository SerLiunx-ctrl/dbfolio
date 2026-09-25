import type {DataSyncOptions,SchemaSyncOptions,FilterCondition} from '../../ipc/types';
export interface SourceFilter {conditions:FilterCondition[];conjunction:string}
export interface SyncDraft {sourceSession:string;sourceDb:string;targetSession:string;targetDb:string;selected:string[];schemaOptions:SchemaSyncOptions;dataOptions:DataSyncOptions;filters:Record<string,SourceFilter>}
