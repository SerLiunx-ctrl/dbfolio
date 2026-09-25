import {InfoHint} from '../../common/InfoHint';
import {useEffect,useRef,useState} from 'react';
import {Button,Dialog,DialogSurface,DialogBody,DialogTitle,DialogContent,DialogActions,ProgressBar,Spinner} from '@fluentui/react-components';
import {newTrace,reduceGenerationEvent,type GenerationEvent,type GenerationTrace} from './progress';

export function useGenerationTrace(){
 const [trace,setTrace]=useState<GenerationTrace|null>(null);
 const current=useRef<GenerationTrace|null>(null),timer=useRef<ReturnType<typeof setTimeout>|null>(null),alive=useRef(true);
 const flush=()=>{if(timer.current)clearTimeout(timer.current);timer.current=null;if(alive.current)setTrace(current.current);};
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;if(timer.current)clearTimeout(timer.current);};},[]);
 return {trace,current,
  start:(total:number)=>{current.current=newTrace(total);flush();},
  receive:(event:GenerationEvent)=>{if(!alive.current||!current.current)return;current.current=reduceGenerationEvent(current.current,event);if(!timer.current)timer.current=setTimeout(flush,80);},
  finish:(status:GenerationTrace['status'],error='')=>{if(current.current){current.current={...current.current,status,error,endedAt:Date.now()};flush();}},
 };
}
export function GenerationMonitor({trace,open,onClose,onCancel,onPreview,cancelEnabled,onResponses}:{trace:GenerationTrace|null;open:boolean;onClose:()=>void;onCancel:()=>void;onPreview:()=>void;cancelEnabled:boolean;onResponses:()=>void}){
 const [now,setNow]=useState(Date.now()),[follow,setFollow]=useState(true);
 const raw=useRef<HTMLPreElement>(null);
 useEffect(()=>{if(!open||trace?.status!=='running')return;const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[open,trace?.status]);
 useEffect(()=>{if(follow&&raw.current)raw.current.scrollTop=raw.current.scrollHeight;},[trace?.raw,follow]);
 if(!trace)return null;
 const running=trace.status==='running',success=trace.status==='success',cancelled=trace.status==='cancelled';
 const title=running?'正在生成数据':success?'生成成功，可确认预览':cancelled?'生成已停止':'生成失败，请查看原因';
 const columns=[...new Set(trace.rows.flatMap(r=>Object.keys(r.cells)))];
 return <Dialog open={open} onOpenChange={(_,d)=>{if(!d.open)onClose();}}><DialogSurface className="gen-monitor"><DialogBody><DialogTitle>{title}</DialogTitle><DialogContent className="gen-monitor-content">
 <div className={'gen-result-banner '+(success?'is-success':trace.status==='error'?'is-error':'')} role={trace.status==='error'?'alert':'status'}>
 <div className="gen-toolbar">{running&&<Spinner size="tiny"/>}<strong>{trace.count} / {trace.total} 条已校验</strong><span>耗时 {Math.max(0,Math.floor(((trace.endedAt??now)-trace.startedAt)/1000))} 秒</span><span>已接收 {trace.characters.toLocaleString()} 字符</span></div>
 {running&&<ProgressBar value={trace.count} max={Math.max(trace.total,1)}/>}
 <p>{running?(trace.start?`当前处理第 ${trace.start}–${trace.end} 条；${trace.raw?'正在接收 / 校验内容':'等待服务返回或本地生成'}`:'正在读取结构、检查配置或排队…'):success?'完整批次已通过校验，尚未写入数据库。':'本次未形成完整可写入批次，未写入数据库。已接收内容保留在下方。'}</p>
 {trace.error&&<><strong>原因</strong><p className="gen-error">{trace.error}</p><InfoHint label="调整规则建议">请根据出错字段调整规则或生成要求，再重新生成。重复值可扩大取值范围、使用序列，或让名称包含行号。</InfoHint></>}
 </div>
 <p className="gen-note">AI 已完成请求 {trace.usage.requests} 次 · 输入 / 输出 tokens：{trace.usage.inputTokens??'未报告'} / {trace.usage.outputTokens??'未报告'}。字符数仅表示传输进度。</p>
 {trace.rejected&&<details open><summary>第 {trace.rejected.number} 条出错数据（诊断用）</summary><pre className="gen-code">{trace.rejected.json}</pre></details>}
 <div className="gen-monitor-grid"><section><div className="gen-toolbar"><h3>当前批次返回内容</h3><Button size="small" onClick={()=>setFollow(v=>!v)}>{follow?'暂停跟随':'跟随最新'}</Button></div><InfoHint label="实时内容说明">流式文本尚未校验；仅保留当前批次末尾 65536 个字符。不完整 JSON 不作为可写入数据。</InfoHint><pre ref={raw} className="gen-code gen-live-output">{trace.raw||(running?'等待内容…':'本次未收到内容')}</pre></section>
 <section><h3>已校验数据 · 前 100 条</h3><InfoHint label="已校验预览说明">每批完整返回后进行校验并追加。单元格预览最多 500 字符；完整结果在成功后的预览页查看。</InfoHint><div className="gen-table-scroll gen-live-table"><table className="gen-table"><thead><tr><th>#</th>{columns.map(c=><th key={c}>{c}</th>)}</tr></thead><tbody>{trace.rows.map(r=><tr key={r.number}><td>{r.number}</td>{columns.map(c=><td key={c} title={r.cells[c]}><pre>{r.cells[c]??'（省略）'}</pre></td>)}</tr>)}</tbody></table>{!trace.rows.length&&<p className="gen-note">尚无通过校验的数据。</p>}</div></section></div>
 </DialogContent><DialogActions><Button onClick={onResponses}>查看 / 复制 AI 响应</Button>{running&&<Button disabled={!cancelEnabled} onClick={onCancel}>停止生成</Button>}<Button onClick={onClose}>{running?'收起，后台继续':'关闭过程面板'}</Button>{success&&<Button appearance="primary" onClick={onPreview}>查看完整预览</Button>}</DialogActions></DialogBody></DialogSurface></Dialog>;
}
