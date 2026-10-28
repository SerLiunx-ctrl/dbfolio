import { useEffect, useRef, useState } from 'react';
import { Button, Checkbox, Spinner } from '@fluentui/react-components';
import { ValueEditor } from './ValueEditor';
import { detailValue } from './detailValue';
import { isReadOnlyValue, type ColumnMeta, type DbValue } from '../../ipc/types';

export interface InspectorTarget {
  id:string;name:string;rawType:string;value:DbValue;editable?:boolean;column?:ColumnMeta;
  load?:()=>Promise<DbValue>;
  hydrate?:(value:DbValue)=>void;
  change?:(value:DbValue)=>void;
}
// 只挂载当前单元格的一个编辑器。有效输入立即加入网格待提交；此组件不写数据库。
export function CellInspector({target,onInvalid}:{target:InspectorTarget|null;onInvalid?:(message:string|null)=>void}) {
  const [value,setValue]=useState<DbValue>(target?.value??['null',null]);
  const [text,setText]=useState(String(target?.value[1]??'')),[nullValue,setNull]=useState(target?.value[0]==='null');
  const [loading,setLoading]=useState(false),[error,setError]=useState<string|null>(null),[loadError,setLoadError]=useState(false);
  const staged=useRef(value);
  const invalid=useRef(onInvalid);invalid.current=onInvalid;
  useEffect(()=>{
    let alive=true;setError(null);setLoadError(false);invalid.current?.(null);
    const show=(v:DbValue)=>{staged.current=v;setValue(v);setText(String(v[1]??''));setNull(v[0]==='null');};
    show(target?.value??['null',null]);setLoading(Boolean(target?.load));
    if(target?.load)void target.load().then(v=>{if(!alive)return;target.hydrate?.(v);show(v);}).catch(e=>{if(alive){setLoadError(true);setError(String(e));}}).finally(()=>{if(alive)setLoading(false);});
    return ()=>{alive=false;};
  // 同一单元格的输入由本地缓冲持有；切换、刷新和废弃通过 id 重建。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[target?.id]);
  if(!target)return <div className="dw-grid-inspector-content">选中单元格查看详情。</div>;
  const editable=target.editable&&!loading&&!loadError&&!isReadOnlyValue(value);
  const update=(nextText:string,nextNull:boolean)=>{
    if(!editable)return;
    setText(nextText);setNull(nextNull);
    try{
      const next=detailValue(staged.current,nextText,nextNull,target.column);
      target.change?.(next);staged.current=next;setValue(next);setError(null);invalid.current?.(null);
    }catch(e){const message=e instanceof Error?e.message:String(e);setError(message);invalid.current?.(message);}
  };
  return <div className="dw-grid-inspector-content"><div className="dw-inspector-meta"><strong>{target.name}</strong><span>{target.rawType}</span><span>{editable?'修改进入待提交，点击表格工具栏“提交”后生效':'只读'}</span>
    <Checkbox size="medium" label="NULL" checked={nullValue} disabled={!editable} onChange={(_,d)=>update(text,d.checked===true)}/>
    {error&&!loadError&&<Button size="small" onClick={()=>{setText(String(staged.current[1]??''));setNull(staged.current[0]==='null');setError(null);invalid.current?.(null);}}>废弃无效输入</Button>}
  </div>{error&&<div role="alert" className="dw-inspector-error">{error}</div>}{loading?<Spinner size="tiny" label="读取完整值…"/>:<ValueEditor text={text} onChange={v=>update(v,nullValue)} binary={value[0]==='bytes'} allowImage={value[0]==='text'} readOnly={!editable||nullValue}/>}
    {isReadOnlyValue(value)&&<small>当前为截断或扩展类型预览，只读显示；表数据页可在有可靠主键时读取完整值。</small>}
  </div>;
}
