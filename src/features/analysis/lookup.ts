import type {ColumnMeta} from '../../ipc/types';
import type {AnalysisLookup, Dataset, Scalar} from './model';
import {qualifiedTableSql,quoteIdent} from '../grid/value';

export const lookupColumnId=(field:string)=>'lookup:'+field;
export function lookupSql(engine:string,database:string,lookup:AnalysisLookup){
 if(!lookup.table||!lookup.field||!lookup.key||!lookup.label)throw Error('请完整选择分析字段、关联表、关联键和名称字段');
 return `SELECT ${quoteIdent(engine,lookup.key)} AS ${quoteIdent(engine,'lookup_key')}, ${quoteIdent(engine,lookup.label)} AS ${quoteIdent(engine,'lookup_label')} FROM ${qualifiedTableSql(engine,database,lookup.schema||null,lookup.table)}`;
}
export function withComments(data:Dataset,columns:ColumnMeta[]):Dataset {
 // Explicitly selected source only; ambiguous duplicate output names receive no guessed comment.
 return {...data,columns:data.columns.map(c=>({...c,comment:data.columns.filter(v=>v.name===c.name).length===1?columns.find(v=>v.name===c.name)?.comment??undefined:undefined}))};
}
export function applyLookup(data:Dataset,lookup:AnalysisLookup,labels:Dataset):Dataset {
 const index=data.columns.findIndex(c=>c.id===lookup.field);
 if(index<0)throw Error('名称关联的分析字段已不存在，请重新选择');
 const key=(value:Scalar)=>value===null?null:String(value);
 const entries=new Map<string,string>();
 for(const row of labels.rows){const id=key(row[0]);if(id===null||row[1]===null||row[1]==='')continue;const label=String(row[1]);if(entries.has(id)&&entries.get(id)!==label)throw Error(`关联键 ${id} 对应多个名称，请修正关联表或使用 SQL JOIN 明确关联条件`);entries.set(id,label);}
 const ids=[...new Set(data.rows.map(r=>key(r[index])))].filter((v):v is string=>v!==null);
 const bases=new Map(ids.map(id=>[id,entries.get(id)??`未匹配 [${id}]`]));
 const counts=new Map<string,number>();for(const name of bases.values())counts.set(name,(counts.get(name)??0)+1);
 const used=new Set<string>(),display=new Map<string,string>();
 for(const id of ids){const name=bases.get(id)!;const base=counts.get(name)!>1?`${name} [${id}]`:name;let label=base,n=2;while(used.has(label))label=base+' ['+(n++)+']';used.add(label);display.set(id,label);}
 const missing=ids.filter(id=>!entries.has(id)).length;
 return {...data,columns:[...data.columns,{id:lookupColumnId(lookup.field),name:data.columns[index].name+' · 名称',type:'text',numeric:false,comment:`${lookup.table}.${lookup.label}（按 ${lookup.key} 关联）`}],rows:data.rows.map(r=>{const id=key(r[index]);return [...r,id===null?null:display.get(id)!];}),warnings:[...new Set([...data.warnings,...labels.warnings]),`名称来自 ${lookup.table}.${lookup.label}，原始 ID 保留；同名的不同 ID 分开统计。`,...(missing?[`有 ${missing} 个 ID 未匹配到名称，保留 ID 展示。`]:[])]};
}
