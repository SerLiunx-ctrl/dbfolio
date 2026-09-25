import {InfoHint} from '../../common/InfoHint';
import {useRef} from 'react';
import {Button} from '@fluentui/react-components';
import {TEMPLATE_PRESETS, TEMPLATE_VARIABLES} from './templateCatalog';

export function TemplateEditor({value,onChange}:{value:string;onChange:(value:string)=>void}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const selection = useRef({start:value.length,end:value.length});
  const insert = (token:string) => {
    const {start,end} = selection.current;
    onChange(value.slice(0,start)+token+value.slice(end));
    const next=start+token.length;
    selection.current={start:next,end:next};
    requestAnimationFrame(()=>{input.current?.focus();input.current?.setSelectionRange(next,next);});
  };
  return <div className="gen-template-editor">
    <textarea ref={input} className="gen-json" aria-label="文本模板" rows={3} value={value}
      onSelect={e=>{selection.current={start:e.currentTarget.selectionStart,end:e.currentTarget.selectionEnd};}}
      onChange={e=>onChange(e.target.value)}/>
    <label>常用模板 <select className="dw-native-select" value="" onChange={e=>{if(e.target.value){onChange(e.target.value);selection.current={start:e.target.value.length,end:e.target.value.length};}}}>
      <option value="">选择后替换当前模板</option>{TEMPLATE_PRESETS.map(p=><option key={p.pattern} value={p.pattern}>{p.label} · {p.pattern}</option>)}
    </select></label>
    <details open><summary>插入变量</summary>{[...new Set(TEMPLATE_VARIABLES.map(v=>v.group))].map(group=><div key={group} style={{marginTop:8}}>
      <strong className="gen-note">{group}</strong><div className="gen-toolbar" style={{flexWrap:'wrap',marginTop:4}}>{TEMPLATE_VARIABLES.filter(v=>v.group===group).map(v=><Button size="small" key={v.token} title={v.help} onClick={()=>insert(v.token)}>{v.label} <code>{v.token}</code></Button>)}</div>
    </div>)}</details>
    <InfoHint label="模板变量说明">UUID 在同一行各文本字段中保持一致；随机整数和随机串每次出现分别取值。日期/时间戳为任务开始时间（UTC）。预览后结果固定，写入不会重新生成。</InfoHint>
    <InfoHint label="模板参数说明">{'${参数名}'} 引用方案参数。未识别的花括号内容保留原文，可用于 Redis hash tag；模板仅处理本地文本字段，不替换 AI 返回内容。</InfoHint>
  </div>;
}
