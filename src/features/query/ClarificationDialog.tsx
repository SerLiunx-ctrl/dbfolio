import {Button,Checkbox,Dialog,DialogSurface,DialogBody,DialogTitle,DialogContent,DialogActions,Radio,RadioGroup} from '@fluentui/react-components';
import type {Question} from './queryAi';
export interface Answer {choices:string[];text:string}
export function ClarificationDialog({open,questions,answers,onAnswer,onClose,onSubmit,blocked}:{open:boolean;questions:(string|Question)[];answers:Answer[];onAnswer:(index:number,answer:Answer)=>void;onClose:()=>void;onSubmit:()=>void;blocked:string}){
 const normalized=questions.map(q=>typeof q==='string'?{text:q,options:[],requiresText:true}:q);
 const complete=normalized.every((q,i)=>{const a=answers[i];return !!a&&(q.requiresText?a.text.trim().length>0:a.choices.length>0||a.text.trim().length>0);});
 return <Dialog modalType="non-modal" open={open} onOpenChange={(_,d)=>{if(!d.open)onClose();}}><DialogSurface className="dw-query-ai dw-ai-clarification dw-smart-clarification"><DialogBody><DialogTitle>补充信息后继续生成</DialogTitle><DialogContent>

 {normalized.map((q,i)=>{const a=answers[i]??{choices:[],text:''};return <fieldset key={i} className="dw-ai-question"><legend>{i+1}. {q.text}</legend>
 {!!q.options?.length&&(q.multiple?<div>{q.options.map((option,j)=><Checkbox key={j} label={option} checked={a.choices.includes(option)} onChange={(_,d)=>onAnswer(i,{...a,choices:d.checked?[...a.choices,option]:a.choices.filter(v=>v!==option)})}/>)}</div>:<RadioGroup value={a.choices[0]??''} onChange={(_,d)=>onAnswer(i,{...a,choices:[d.value]})}>{q.options.map((option,j)=><Radio key={j} value={option} label={option}/>)}</RadioGroup>)}
 <label>{q.requiresText||!q.options?.length?'具体值 / 回答（必填）':'其他答案 / 补充（可选）'}<textarea aria-label={'问题 '+(i+1)+' 的补充回答'} value={a.text} maxLength={2000} onChange={e=>onAnswer(i,{...a,text:e.target.value})}/></label></fieldset>;})}
 {blocked&&<p role="alert" className="dw-ai-error">{blocked}</p>}
 </DialogContent><DialogActions><Button onClick={onClose}>稍后回答</Button><Button appearance="primary" disabled={!complete||!!blocked} onClick={onSubmit}>提交回答并继续生成</Button></DialogActions></DialogBody></DialogSurface></Dialog>;
}
