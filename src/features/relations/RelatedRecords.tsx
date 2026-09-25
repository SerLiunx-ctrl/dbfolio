import {useEffect,useMemo,useState} from 'react';
import {Button,Field,Select,Spinner,tokens} from '@fluentui/react-components';
import {api,normalizeError} from '../../ipc';
import type {ColumnMeta,DbValue,Engine,QueryOutcome,TableMeta,TableRef,TableSelection} from '../../ipc/types';
import {loadRelations,saveRelation,useRelations} from '../../stores/useRelations';
import {foreignRelations,relationValues,sourceKey,type BusinessRelation} from './model';
import {buildTableSelect} from '../grid/value';
import {ResultGrid} from '../grid/ResultGrid';
import {InfoHint} from '../../common/InfoHint';

export interface RelatedSelection {column:string;row:DbValue[]}
export function RelatedRecords({source,meta,engine,selection,onClose}:{source:TableSelection;meta:TableMeta;engine:Engine;selection:RelatedSelection;onClose:()=>void}){
  const items=useRelations(s=>s.items),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const options=useMemo(()=>[...foreignRelations(source,meta),...items.filter(r=>sourceKey(r.source)===sourceKey(source))].filter(r=>r.columns.includes(selection.column)),[items,source,meta,selection.column]);
  const [chosen,setChosen]=useState(''),[config,setConfig]=useState(false),[tables,setTables]=useState<TableRef[]>([]),[fields,setFields]=useState<ColumnMeta[]>([]);
  const [target,setTarget]=useState(''),[key,setKey]=useState(''),[label,setLabel]=useState(''),[result,setResult]=useState<QueryOutcome|null>(null),[page,setPage]=useState(0);
  const relation=options.find(r=>r.id===chosen)??options[0];
  useEffect(()=>{void loadRelations().catch(e=>setError(normalizeError(e).message));},[]);
  useEffect(()=>{if(!config)return;let live=true;void api.listTables(source.sessionId,source.database).then(t=>{if(live)setTables(t);}).catch(e=>{if(live)setError(normalizeError(e).message);});return()=>{live=false;};},[config,source.sessionId,source.database]);
  useEffect(()=>{setFields([]);if(!target)return;let live=true;const [schema,table]=JSON.parse(target);void api.tableDetail(source.sessionId,source.database,table,schema||null).then(t=>{if(live)setFields(t.columns);}).catch(e=>{if(live)setError(normalizeError(e).message);});return()=>{live=false;};},[target,source.sessionId,source.database]);
  useEffect(()=>{let live=true;setResult(null);setError('');setBusy(false);if(!relation)return;
    const read=async()=>{setBusy(true);try{
      const values=relationValues(relation,meta.columns.map(c=>c.name),selection.row);
      const targetMeta=await api.tableDetail(source.sessionId,relation.target.database,relation.target.table,relation.target.schema??null);
      const keys=relation.keys.every(k=>!k)&&targetMeta.primaryKey.length===relation.keys.length?targetMeta.primaryKey:relation.keys;
      if(keys.some(k=>!targetMeta.columns.some(c=>c.name===k)))throw Error('目标关联键已不存在，请重新配置');
      const where=await api.buildFilterClause(source.sessionId,keys.map((column,i)=>({column,operator:'eq',literal:values[i]})),'and');
      const sql=buildTableSelect(engine,relation.target.database,relation.target.schema,relation.target.table,targetMeta.columns)+where;
      const data=await api.queryFetchPage(source.sessionId,relation.target.database,sql,page*100,100,[]);
      if(live)setResult(data);
    }catch(e){if(live)setError(normalizeError(e).message);}finally{if(live)setBusy(false);}};
    void read();return()=>{live=false;};
  },[relation,selection,source.sessionId,meta,engine,page]);
  return <aside aria-label="关联记录" style={{width:'42%',minWidth:340,maxWidth:'65%',display:'flex',flexDirection:'column',borderLeft:`1px solid ${tokens.colorNeutralStroke2}`,padding:10,gap:8,minHeight:0}}>
    <header style={{display:'flex',alignItems:'center',gap:8}}><strong>关联记录 · {selection.column}</strong><InfoHint label="业务关联">外键自动识别；没有外键时可保存业务关联。只读取匹配记录，不修改表结构。复合外键按整组字段查找。</InfoHint><Button size="small" style={{marginLeft:'auto'}} onClick={onClose}>关闭</Button></header>
    {!!options.length&&<Select aria-label="关联关系" value={relation?.id} onChange={(_,d)=>{setChosen(d.value);setPage(0);}}>{options.map(r=><option key={r.id} value={r.id}>{r.target.database}.{r.target.table} · {r.keys.join(', ')}{r.id.startsWith('fk:')?'（外键）':''}</option>)}</Select>}
    <div><Button size="small" onClick={()=>setConfig(v=>!v)}>配置业务关联</Button>{relation&&!relation.id.startsWith('fk:')&&<Button size="small" disabled={busy} onClick={()=>{void saveRelation(relation,true).catch(e=>setError(normalizeError(e).message));}}>移除关联</Button>}</div>
    {config&&<div style={{display:'grid',gap:6}}>
      <Field size="small" label="目标表"><Select value={target} onChange={(_,d)=>{setTarget(d.value);setKey('');setLabel('');}}><option value="">选择表</option>{tables.map(t=>{const id=JSON.stringify([t.schema??'',t.name]);return <option key={id} value={id}>{t.schema?t.schema+'.':''}{t.name}</option>;})}</Select></Field>
      <Field size="small" label="目标关联键"><Select value={key} onChange={(_,d)=>setKey(d.value)}><option value="">选择字段</option>{fields.map(c=><option key={c.name} value={c.name}>{c.name}{c.comment?' · '+c.comment:''}</option>)}</Select></Field>
      <Field size="small" label="名称字段（可选）"><Select value={label} onChange={(_,d)=>setLabel(d.value)}><option value="">不指定</option>{fields.map(c=><option key={c.name} value={c.name}>{c.name}{c.comment?' · '+c.comment:''}</option>)}</Select></Field>
      <Button size="small" disabled={!target||!key||busy} onClick={async()=>{setBusy(true);try{const [schema,table]=JSON.parse(target);const r:BusinessRelation={id:crypto.randomUUID(),source,columns:[selection.column],target:{database:source.database,schema:schema||null,table},keys:[key],label};await saveRelation(r);setChosen(r.id);setPage(0);setConfig(false);}catch(e){setError(normalizeError(e).message);}finally{setBusy(false);}}}>保存并查看</Button>
    </div>}
    {error&&<div role="alert" style={{color:tokens.colorPaletteRedForeground1}}>{error}</div>}{busy&&<Spinner size="tiny"/>}
    {!relation&&!error&&<span>此字段尚未配置关联。</span>}
    {result&&<><span>{relation?.target.table} · 本页 {result.rows.length} 行{relation?.label?' · 名称字段：'+relation.label:''}</span><div style={{flex:1,minHeight:150}}><ResultGrid columns={result.columns} rows={result.rows}/></div><div style={{display:'flex',gap:8}}><Button size="small" disabled={busy||page===0} onClick={()=>setPage(p=>p-1)}>上一页</Button><Button size="small" disabled={busy||result.rows.length<100} onClick={()=>setPage(p=>p+1)}>下一页</Button></div></>}
  </aside>;
}
