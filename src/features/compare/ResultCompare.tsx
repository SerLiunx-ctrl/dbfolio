import {useMemo,useState} from 'react';
import {create} from 'zustand';
import {Button,Checkbox,Dialog,DialogSurface,DialogBody,DialogTitle,DialogContent,DialogActions,Select,tokens} from '@fluentui/react-components';
import {formatDbValue,type QueryOutcome} from '../../ipc/types';
import {useNotify} from '../../app/toast';
import {compareResults,snapshotResult,type ResultSnapshot} from './model';
export const useResultBaseline=create<{baseline:ResultSnapshot|null}>(()=>({baseline:null}));
export function ResultCompareActions({result,source,scope,disabled}:{result:QueryOutcome|null;source:string;scope:string;disabled?:boolean}){
  const baseline=useResultBaseline(s=>s.baseline),[current,setCurrent]=useState<ResultSnapshot|null>(null),notify=useNotify();
  return <><Button size="small" appearance="subtle" disabled={disabled||!result?.columns.length} title="固定当前已加载结果，之后可与其他查询页或数据库的结果比较；本次应用关闭后清除" onClick={()=>{try{if(result)useResultBaseline.setState({baseline:snapshotResult(result,source,scope)});}catch(e){notify.error(e);}}}>{baseline?'替换对比基准':'固定为对比基准'}</Button>
  {baseline&&<Button size="small" appearance="subtle" disabled={disabled||!result?.columns.length} title={baseline.source+' · '+baseline.scope} onClick={()=>{try{if(result)setCurrent(snapshotResult(result,source,scope));}catch(e){notify.error(e);}}}>对比结果</Button>}
  {current&&baseline&&<ResultCompareDialog baseline={baseline} current={current} onClose={()=>setCurrent(null)}/>}</>;
}
export function ResultCompareDialog({baseline,current,onClose}:{baseline:ResultSnapshot;current:ResultSnapshot;onClose:()=>void}){
  const [keys,setKeys]=useState<string[]>([]),[filter,setFilter]=useState('all'),[page,setPage]=useState(0);
  const comparison=useMemo(()=>{try{return {data:compareResults(baseline.result,current.result,keys),error:''};}catch(e){return {data:null,error:(e as Error).message};}},[baseline,current,keys]);
  const rows=comparison.data?.differences.filter(d=>filter==='all'||d.kind===filter)??[];
  const labels={added:'新增',removed:'删除',changed:'修改'};
  return <Dialog open onOpenChange={(_,d)=>{if(!d.open)onClose();}}><DialogSurface style={{width:'min(1100px,94vw)',maxWidth:'94vw'}}><DialogBody><DialogTitle>查询结果对比</DialogTitle><DialogContent>
    <div style={{fontSize:12,display:'grid',gap:4}}><span>基准：{baseline.source} · {baseline.scope} · {baseline.capturedAt}</span><span>当前：{current.source} · {current.scope} · {current.capturedAt}</span><strong>仅比较这两份已加载快照，不代表整张表或完整查询结果。</strong></div>
    <fieldset style={{margin:'10px 0',border:`1px solid ${tokens.colorNeutralStroke2}`}}><legend>对比键（可多选）</legend>{baseline.result.columns.filter(c=>current.result.columns.some(v=>v.name===c.name)).map((c,i)=><Checkbox key={i} label={c.name} checked={keys.includes(c.name)} onChange={(_,d)=>{setKeys(v=>d.checked?[...v,c.name]:v.filter(k=>k!==c.name));setPage(0);}}/>)}</fieldset>
    {comparison.error&&<p role="status">{comparison.error}</p>}
    {comparison.data&&<><div style={{display:'flex',gap:12,alignItems:'center'}}><span>新增 {comparison.data.differences.filter(r=>r.kind==='added').length} · 删除 {comparison.data.differences.filter(r=>r.kind==='removed').length} · 修改 {comparison.data.differences.filter(r=>r.kind==='changed').length} · 相同 {comparison.data.equal}</span><Select aria-label="差异类型" value={filter} onChange={(_,d)=>{setFilter(d.value);setPage(0);}}><option value="all">全部差异</option>{Object.entries(labels).map(([v,l])=><option key={v} value={v}>{l}</option>)}</Select></div>
      <div style={{maxHeight:'50vh',overflow:'auto',marginTop:8}}><table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}><thead><tr>{['变化','对比键','字段','基准值','当前值'].map(n=><th key={n} style={{textAlign:'left',padding:6}}>{n}</th>)}</tr></thead><tbody>{rows.slice(page*50,page*50+50).flatMap((r,index)=>r.fields.map(field=>{const i=comparison.data!.names.indexOf(field);return <tr key={index+':'+field} style={{background:r.kind==='added'?tokens.colorPaletteGreenBackground1:r.kind==='removed'?tokens.colorPaletteRedBackground1:tokens.colorPaletteYellowBackground1}}><td style={{padding:6}}>{labels[r.kind]}</td><td>{r.key}</td><td>{field}</td><td style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxWidth:300}}>{r.before?formatDbValue(r.before[i]):'（无此行）'}</td><td style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxWidth:300}}>{r.after?formatDbValue(r.after[i]):'（无此行）'}</td></tr>;}))}</tbody></table>{!rows.length&&<p>没有差异。</p>}</div>
      <div style={{display:'flex',gap:8,marginTop:8}}><Button size="small" disabled={!page} onClick={()=>setPage(v=>v-1)}>上一页</Button><span>第 {page+1} 页 · 每页最多 50 条差异记录</span><Button size="small" disabled={(page+1)*50>=rows.length} onClick={()=>setPage(v=>v+1)}>下一页</Button></div></>}
  </DialogContent><DialogActions><Button onClick={()=>{useResultBaseline.setState({baseline:null});onClose();}}>清除基准</Button><Button appearance="primary" onClick={onClose}>关闭</Button></DialogActions></DialogBody></DialogSurface></Dialog>;
}
