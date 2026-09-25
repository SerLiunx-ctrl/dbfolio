import {useMemo,useState} from 'react';
import {Combobox,Option} from '@fluentui/react-components';
import type {DbValue} from '../../ipc/types';
import type {FilterValueChoice} from './filterValues';

export function FilterValueInput({value,placeholder,disabled,choices,onChange,onSelect,listMode=false}:{value:string;placeholder:string;disabled?:boolean;choices:FilterValueChoice[];onChange:(v:string)=>void;onSelect:(v:DbValue,text:string)=>void;listMode?:boolean}){
 const [searching,setSearching]=useState(false);
 const [open,setOpen]=useState(false);
 const matches=useMemo(()=>{const q=searching?value.toLocaleLowerCase():'';return choices.filter(c=>!q||c.text.toLocaleLowerCase().includes(q));},[choices,value,searching]);
 return <Combobox size="small" freeform className="dw-filter-value" aria-label={placeholder} placeholder={placeholder} disabled={disabled} open={open} value={value} selectedOptions={[]} listbox={{className:'dw-listbox-compact dw-filter-options'}} positioning={{position:'below',align:'start'}}
  onOpenChange={(_,d)=>{setOpen(d.open);if(!d.open)setSearching(false);}}
  onInput={e=>{setSearching(true);setOpen(true);onChange((e.target as HTMLInputElement).value);}}
  onOptionSelect={(_,d)=>{const c=choices.find(c=>c.key===d.optionValue);if(c&&!c.disabled){onSelect(c.value,c.text);setSearching(false);setOpen(false);}}}>
  <Option value="__scope" disabled text="当前已加载数据">当前已加载数据 · {matches.length} 个不同值</Option>
  {matches.slice(0,200).map(c=><Option key={c.key} value={c.key} text={c.text} disabled={c.disabled||(listMode&&(c.value[0]==='null'||c.text.includes(',')))} title={c.disabled?'仅有截断预览或不可直接筛选的值，请手动输入完整条件':c.text}>
   <span className="dw-filter-option-text">{c.value[0]==='null'?'NULL（空值）':c.text===''?'（空字符串）':c.text.slice(0,120)+(c.text.length>120?'…':'')}</span><small>{c.count}</small>
  </Option>)}
  {matches.length===0&&<Option disabled value="__none">无匹配值，可直接输入</Option>}
  {matches.length>200&&<Option disabled value="__more">先显示 200 项，输入文字搜索全部已加载值</Option>}
 </Combobox>;
}
