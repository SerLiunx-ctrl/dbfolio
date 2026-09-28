import type { Engine, TableDraft, DraftColumn } from '../../ipc/types';
import type { ColumnEdit } from './InlineColumnRow';
export interface TablePropertyForm {name:string;comment:string;engine:string;charset:string;collation:string;autoIncrement:string;rowFormat:string}
export const emptyProperties=():TablePropertyForm=>({name:'',comment:'',engine:'',charset:'',collation:'',autoIncrement:'',rowFormat:''});
export interface CreateTableState {properties:TablePropertyForm;schema:string;columns:DraftColumn[];indexes:TableDraft['indexes'];foreignKeys:TableDraft['foreignKeys']}
export const newColumn=(engine:Engine,name=''):DraftColumn=>({id:crypto.randomUUID(),name,dataType:engine==='sqlite'?'TEXT':'varchar(255)',nullable:true,primaryKey:false,autoIncrement:false,unsigned:false,defaultMode:'none',defaultValue:'',comment:'',onUpdate:''});
export const newTableState=(engine:Engine):CreateTableState=>({properties:{...emptyProperties(),engine:engine==='mysql'?'InnoDB':''},schema:engine==='postgres'?'public':'',columns:[],indexes:[],foreignKeys:[]});
export function draftSpec(state:CreateTableState,engine:Engine):TableDraft {
 const {name,comment,...options}=state.properties;
 return {schema:state.schema||null,table:name.trim(),columns:state.columns,indexes:state.indexes,foreignKeys:state.foreignKeys.map(f=>f.selfReference?{...f,refTable:name.trim(),refSchema:state.schema||null}:f),options:{...(engine==='sqlite'?{}:{comment}),...(engine==='mysql'?Object.fromEntries(Object.entries(options).filter(([,v])=>v!=='')):{})}};
}
export function updateDraftColumn(state:CreateTableState,id:string,patch:Partial<ColumnEdit>&{primaryKey?:boolean}):CreateTableState {
 const old=state.columns.find(c=>c.id===id);if(!old)return state;
 const name=patch.newName??old.name;
 const columns=state.columns.map(c=>c.id===id?{...c,...patch,name,defaultMode:patch.defaultMode??(patch.autoIncrement?'none':c.defaultMode)}:c);
 const replace=(v:string)=>v===old.name?name:v;
 return {...state,columns,indexes:state.indexes.map(i=>({...i,columns:i.columns.map(c=>({...c,name:replace(c.name)}))})),foreignKeys:state.foreignKeys.map(f=>({...f,columns:f.columns.map(replace),refColumns:f.selfReference||(f.refTable===state.properties.name&&(f.refSchema??'')===(state.schema??''))?f.refColumns.map(replace):f.refColumns}))};
}
