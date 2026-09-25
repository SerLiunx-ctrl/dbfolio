import {InfoHint} from '../../common/InfoHint';
import {useEffect,useState} from 'react';
import {Button,Field,Input,Select} from '@fluentui/react-components';
import {api,normalizeError} from '../../ipc';
import type {ColumnMeta} from '../../ipc/types';
import type {SourceFilter} from './model';
export function SourceFilters({purpose="sync",sessionId,database,tables,filters,disabled,onChange}:{purpose?:"sync"|"export";sessionId:string;database:string;tables:string[];filters:Record<string,SourceFilter>;disabled:boolean;onChange:(v:Record<string,SourceFilter>)=>void}){
 const [table,setTable]=useState(tables[0]??''),[columns,setColumns]=useState<ColumnMeta[]>([]),[error,setError]=useState(''),[loading,setLoading]=useState(false);
 const current=tables.includes(table)?table:tables[0]??'';
 useEffect(()=>{let active=true;setColumns([]);setError('');if(!current)return;setLoading(true);void api.tableDetail(sessionId,database,current).then(m=>{if(active)setColumns(m.columns);}).catch(e=>{if(active)setError(normalizeError(e).message);}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[sessionId,database,current]);
 const filter=filters[current]??{conjunction:'and',conditions:[]};
 const update=(f:SourceFilter)=>onChange({...filters,[current]:f});
 return <details open><summary>源数据筛选 · {Object.values(filters).reduce((n,f)=>n+f.conditions.length,0)} 条条件</summary>
 <InfoHint label="源数据筛选说明">{purpose==="export"?"仅筛选导出的数据行，不影响结构。未配置条件时导出全部源行。":"仅影响数据同步，结构同步不受影响。未配置条件的表同步全部源行；启用筛选时不删除目标其他行。目标仍按主键扫描匹配，目标行数表示扫描范围。"}</InfoHint>
 <fieldset disabled={disabled||loading} style={{border:0,padding:0,minWidth:0,maxHeight:320,overflow:'auto'}}>
 <div style={{display:'flex',gap:8,flexWrap:'wrap'}}><Field size="small" label="筛选源表"><Select size="small" value={current} onChange={(_,d)=>setTable(d.value)}>{tables.map(t=><option key={t}>{t}</option>)}</Select></Field><Field size="small" label="条件组合"><Select size="small" value={filter.conjunction} onChange={(_,d)=>update({...filter,conjunction:d.value})}><option value="and">全部满足（AND）</option><option value="or">任一满足（OR）</option></Select></Field></div>
 {filter.conditions.map((c,i)=><div key={i} style={{display:'flex',gap:6,flexWrap:'wrap',marginTop:6}}>
 <Select size="small" aria-label={'筛选字段 '+(i+1)} value={c.column} onChange={(_,d)=>update({...filter,conditions:filter.conditions.map((v,j)=>i===j?{...v,column:d.value}:v)})}><option value="">选择字段</option>{columns.map(v=><option key={v.name} value={v.name}>{v.name}{v.comment?' · '+v.comment:''}</option>)}</Select>
 <Select size="small" aria-label={'筛选操作 '+(i+1)} value={c.operator} onChange={(_,d)=>update({...filter,conditions:filter.conditions.map((v,j)=>i===j?{...v,operator:d.value as typeof c.operator}:v)})}>{Object.entries({eq:'等于',ne:'不等于',gt:'大于',ge:'大于等于',lt:'小于',le:'小于等于',contains:'包含',isNull:'为空',isNotNull:'不为空',between:'介于'}).map(([v,label])=><option key={v} value={v}>{label}</option>)}</Select>
 {!['isNull','isNotNull'].includes(c.operator)&&<Input size="small" aria-label={'筛选值 '+(i+1)} value={c.value??''} onChange={(_,d)=>update({...filter,conditions:filter.conditions.map((v,j)=>i===j?{...v,value:d.value}:v)})}/>}
 {c.operator==='between'&&<Input size="small" aria-label={'筛选上限 '+(i+1)} value={c.value2??''} onChange={(_,d)=>update({...filter,conditions:filter.conditions.map((v,j)=>i===j?{...v,value2:d.value}:v)})}/>}
 <Button size="small" onClick={()=>update({...filter,conditions:filter.conditions.filter((_,j)=>i!==j)})}>删除条件</Button></div>)}
 <Button size="small" disabled={!columns.length||filter.conditions.length>=50} onClick={()=>update({...filter,conditions:[...filter.conditions,{column:columns[0].name,operator:'eq',value:''}]})}>添加条件</Button>
 </fieldset>{loading&&<p>正在读取字段…</p>}{error&&<p role="alert">{error}</p>}
 </details>;
}
