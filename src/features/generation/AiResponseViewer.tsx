import {InfoHint} from '../../common/InfoHint';
import {useEffect,useState} from 'react';
import {Button,Dialog,DialogSurface,DialogBody,DialogTitle,DialogContent,DialogActions} from '@fluentui/react-components';
import {api} from '../../ipc';
import {useNotify} from '../../app/toast';
import type {GenerationTrace} from './progress';
const PAGE=32768;
const bytes=(n:number)=>n>=1048576?`${(n/1048576).toFixed(2)} MiB`:`${(n/1024).toFixed(1)} KiB`;
export function AiResponseViewer({trace,open,onClose,onProcess}:{trace:GenerationTrace|null;open:boolean;onClose:()=>void;onProcess:()=>void}){
 const [selected,setSelected]=useState('latest'),[page,setPage]=useState(0);const notify=useNotify();
 useEffect(()=>{if(open){setSelected('latest');setPage(0);}},[open,trace?.startedAt]);
 const response=selected==='latest'?trace?.responses[trace.responses.length-1]:trace?.responses.find(r=>String(r.start)===selected);
 const text=response?.text??trace?.raw??'',pages=Math.max(1,Math.ceil(text.length/PAGE)),current=Math.min(page,pages-1);
 return <Dialog open={open} onOpenChange={(_,d)=>{if(!d.open)onClose();}}><DialogSurface style={{width:'min(1100px,94vw)',maxWidth:'94vw'}}><DialogBody><DialogTitle>查看 AI 响应</DialogTitle><DialogContent style={{maxHeight:'70vh',overflow:'auto'}}>
 <div className="gen-toolbar"><label>响应批次 <select className="dw-native-select" value={selected} onChange={e=>{setSelected(e.target.value);setPage(0);}}><option value="latest">最近收到的响应</option>{trace?.responses.map(r=><option key={r.start} value={String(r.start)}>第 {r.start}–{r.end} 条请求</option>)}</select></label><Button disabled={!text&&!response?.diagnostic} onClick={()=>void api.clipboardWriteText([text,response?.diagnostic].filter(Boolean).join('\n\n')).then(()=>notify.success('已复制此批次保留的响应')).catch(e=>notify.error(e))}>复制本批响应</Button></div>
 {response?<p className="gen-note">第 {response.start}–{response.end} 条请求 · {response.format} · {response.status?`HTTP ${response.status}`:'尚未收到 HTTP 响应'} · 传输 {bytes(response.receivedBytes)} · 正文 {bytes(response.contentBytes)}</p>:<p className="gen-note">{trace?.status==='running'?'当前请求仍在接收，暂时显示实时文本的末尾；请求结束后可查看保留的响应。':'没有收到可保留的完整响应记录。下方显示可用的实时文本。'}</p>}
 {response?.truncated&&<div role="status" className="gen-result-banner is-error">此响应触发读取上限，以下仅为已保留的部分，不能视为完整结果。</div>}
 {!!trace?.evictedResponses&&<p className="gen-note">为控制内存，已移除最早 {trace.evictedResponses} 个响应；当前最多保留最近 20 个批次、约 8 MiB 文本内存。</p>}
 <InfoHint label="响应内容说明">这里显示服务返回的正文，不代表已经通过数据校验。流式事件包装不计入 AI 正文大小；普通 HTTP 错误或无法解析的响应显示其原始正文。保留的响应会隐藏当前请求密钥。</InfoHint>
 <pre className="gen-code" style={{maxHeight:'42vh',minHeight:180,userSelect:'text'}}>{text.slice(current*PAGE,(current+1)*PAGE)||'未收到正文。请检查连接、权限或超时提示。'}</pre>
 <div className="gen-toolbar"><Button disabled={current===0} onClick={()=>setPage(current-1)}>上一段</Button><span>第 {current+1} / {pages} 段 · 共 {text.length.toLocaleString()} 字符</span><Button disabled={current+1>=pages} onClick={()=>setPage(current+1)}>下一段</Button></div>
 {response?.diagnostic&&<details open><summary>服务错误事件</summary><pre className="gen-code">{response.diagnostic}</pre></details>}
 </DialogContent><DialogActions><Button onClick={onProcess}>返回生成过程</Button><Button appearance="primary" onClick={onClose}>关闭</Button></DialogActions></DialogBody></DialogSurface></Dialog>;
}
