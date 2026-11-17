import {useEffect,useMemo,useRef,useState} from 'react';
import Editor from '@monaco-editor/react';
import {Button,Dialog,DialogActions,DialogBody,DialogContent,DialogSurface,DialogTitle,Select,Spinner,tokens} from '@fluentui/react-components';
import {CopyRegular} from '@fluentui/react-icons';
import {api,normalizeError} from '../../ipc';
import type {ColumnInfo,DbValue,TableMeta,TableRef} from '../../ipc/types';
import {useSessionStore} from '../../stores/useSessionStore';
import {useEditorTheme} from '../../useEditorTheme';
import {ensureSqlLanguage,sqlLanguage} from '../../sqlLanguage';
import {serializeRowSql,type RowSqlKind} from './rowSql';
import {writeTextClipboard} from './rowClipboard';

export interface CopyRowsSqlDialogProps {
  kind: RowSqlKind;
  rows: DbValue[][];
  columns: ColumnInfo[];
  sessionId: string;
  database: string;
  schema?: string | null;
  table?: string;
  onClose: ()=>void;
}
const tableKey=(table:TableRef)=>JSON.stringify([table.schema??null,table.name]);
export function CopyRowsSqlDialog({kind,rows,columns,sessionId,database,schema,table,onClose}:CopyRowsSqlDialogProps) {
  const session=useSessionStore(s=>s.sessions.find(v=>v.id===sessionId)),engine=session?.engine,theme=useEditorTheme();
  const [tables,setTables]=useState<TableRef[]>([]),[selected,setSelected]=useState(''),[metadata,setMetadata]=useState<TableMeta|null>(null);
  const [catalogLoading,setCatalogLoading]=useState(false),[detailLoading,setDetailLoading]=useState(false),[error,setError]=useState(''),[copying,setCopying]=useState(false),[copied,setCopied]=useState(false);
  const loading=catalogLoading||detailLoading;
  const sequence=useRef(0);
  useEffect(()=>{
    let alive=true;setTables([]);setSelected('');setMetadata(null);setError('');setCopied(false);
    if (!engine || !['mysql','postgres','sqlite','dameng'].includes(engine)) {setCatalogLoading(false);setError('当前会话暂不支持复制行 SQL');return;}
    if (table) {setCatalogLoading(false);return;}
    setCatalogLoading(true);
    api.listTables(sessionId,database).then(list=>{if(alive)setTables(list.filter(v=>v.kind==='table'));}).catch(e=>{if(alive)setError(normalizeError(e).message);}).finally(()=>{if(alive)setCatalogLoading(false);});
    return()=>{alive=false;};
  },[sessionId,database,engine,table]);
  useEffect(()=>{
    const id=++sequence.current;setMetadata(null);setCopied(false);setError('');
    if (!engine || !['mysql','postgres','sqlite','dameng'].includes(engine)) {setDetailLoading(false);setError('当前会话暂不支持复制行 SQL');return;}
    const chosen=table?{name:table,schema}:tables.find(v=>tableKey(v)===selected);
    if (!chosen) {setDetailLoading(false);return;}
    setDetailLoading(true);
    api.tableDetail(sessionId,database,chosen.name,chosen.schema).then(detail=>{if(sequence.current===id)setMetadata(detail);}).catch(e=>{if(sequence.current===id)setError(normalizeError(e).message);}).finally(()=>{if(sequence.current===id)setDetailLoading(false);});
    return()=>{sequence.current++;};
  },[sessionId,database,schema,table,tables,selected,engine]);
  const preview=useMemo(()=>{
    if (!metadata || !engine) return null;
    const selectedSchema=table?schema:tables.find(v=>tableKey(v)===selected)?.schema;
    try {return {result:serializeRowSql({kind,engine,database,schema:metadata.schema||selectedSchema,table:metadata,columns,rows}),error:''};}
    catch(e) {return {result:null,error:e instanceof Error?e.message:String(e)};}
  },[metadata,engine,kind,database,schema,columns,rows,table,tables,selected]);
  const sql=preview?.result?.sql??'',message=error||preview?.error;
  useEffect(()=>setCopied(false),[sql]);
  const copy=async()=>{if(!sql||copying)return;setCopying(true);setError('');try{await writeTextClipboard(sql);setCopied(true);}catch(e){setError(normalizeError(e).message);}finally{setCopying(false);}};
  return <Dialog open onOpenChange={(_,d)=>{if(!d.open&&!copying)onClose();}}><DialogSurface style={{width:880,maxWidth:'95vw'}}><DialogBody>
    <DialogTitle>复制为 {kind.toUpperCase()} SQL</DialogTitle><DialogContent>
      <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:8,fontSize:12}}><strong>{rows.length} 行</strong><span>目标表</span>
        {table?<code>{schema?schema+'.':''}{table}</code>:<Select size="small" aria-label="SQL 复制目标表" style={{minWidth:220,flex:1}} value={selected} disabled={loading&&tables.length===0} onChange={(_,d)=>setSelected(d.value)}><option value="">请选择服务器中的真实表</option>{tables.map(t=><option key={tableKey(t)} value={tableKey(t)}>{t.schema?t.schema+'.':''}{t.name}</option>)}</Select>}
        {loading&&<Spinner size="tiny" label="读取元数据…"/>}
      </div>
      <div style={{fontSize:12,lineHeight:'18px',color:tokens.colorNeutralForeground3,marginBottom:6}}>{kind==='insert'?'仅复制已加载值；INSERT 略过自增和生成列，主键可能重新分配。':'仅复制已加载值；WHERE 使用本次行快照的完整主键，SET 不修改主键、自增及生成列。'}{!table&&'查询结果需自行选择目标表，不推测 JOIN 或别名。'}复制后请核对目标、字段与服务器约束；此处不会执行 SQL。</div>
      {message&&<div role="alert" style={{fontSize:12,color:tokens.colorPaletteRedForeground1,whiteSpace:'pre-wrap',marginBlock:6}}>{message}</div>}
      {!!preview?.result?.omittedColumns.length&&<div title={preview.result.omittedColumns.join('、')} style={{fontSize:12,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',marginBottom:4}}>已略过：{preview.result.omittedColumns.join('、')}</div>}
      {preview?.result?.warnings.map(w=><div key={w} style={{fontSize:12,color:tokens.colorNeutralForeground3,marginBottom:4}}>{w}</div>)}
      {sql?<div style={{height:320,maxHeight:'45vh',minHeight:160,border:`1px solid ${tokens.colorNeutralStroke2}`}}><Editor language={sqlLanguage(engine)} value={sql} theme={theme.name} beforeMount={m=>{ensureSqlLanguage(m,engine);theme.beforeMount(m);}} options={{ariaLabel:'行 SQL 预览',readOnly:true,domReadOnly:true,automaticLayout:true,minimap:{enabled:false},fontSize:12,lineHeight:18,scrollBeyondLastLine:false,wordWrap:'on'}}/></div>:!loading&&!message&&<div style={{paddingBlock:18,fontSize:12,color:tokens.colorNeutralForeground3}}>{table?'正在准备 SQL…':tables.length?'选择目标表后预览 SQL。':'当前范围没有可用的目标表。'}</div>}
    </DialogContent><DialogActions><Button size="small" disabled={copying} onClick={onClose}>关闭</Button><Button size="small" appearance="primary" icon={<CopyRegular/>} disabled={!sql||loading||!!preview?.error||copying} onClick={()=>void copy()}>{copying?'复制中…':copied?'已复制':'复制 SQL'}</Button></DialogActions>
  </DialogBody></DialogSurface></Dialog>;
}
