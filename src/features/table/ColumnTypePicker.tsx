import {useState} from 'react';
import {Combobox,Option} from '@fluentui/react-components';
import type {DataTypeOption} from '../../ipc/types';

export function ColumnTypePicker({types,value,label,disabled,onSelect}:{types:DataTypeOption[];value:string;label:string;disabled:boolean;onSelect:(value:string)=>void}){
  const [query,setQuery]=useState<string|null>(null);
  const [open,setOpen]=useState(true);
  const selected=types.find(t=>t.name===value);
  const matches=types.filter(t=>`${t.name} ${t.label} ${t.description} ${t.category}`.toLowerCase().includes((query??'').toLowerCase()));
  return <Combobox autoFocus size="small" className="dw-column-type-picker" aria-label={label} title={selected?`${selected.label} · ${selected.description}`:value}
    expandIcon={{'aria-label':'展开字段类型列表'}}
    listbox={{className:'dw-column-type-options',onMouseDown:e=>e.preventDefault()}}
    open={open} onOpenChange={(_,d)=>setOpen(d.open)} value={query??selected?.label??value} selectedOptions={[value]} disabled={disabled}
    onChange={e=>{setQuery(e.target.value);setOpen(true);}} onBlur={()=>setQuery(null)}
    onOptionSelect={(_,d)=>{if(d.optionValue&&types.some(t=>t.name===d.optionValue&&!t.unavailable)){setQuery(null);setOpen(false);onSelect(d.optionValue);}}}>
    {matches.map(t=><Option key={t.name} value={t.name} text={t.label} disabled={t.unavailable}><span className="dw-type-option"><strong>{t.label}</strong><small>{t.description}</small></span></Option>)}
    {!matches.length&&<Option disabled text="没有匹配的类型">没有匹配的类型</Option>}
  </Combobox>;
}
