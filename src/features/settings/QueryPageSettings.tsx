import {useState} from 'react';
import {Button,Field,Input} from '@fluentui/react-components';
import {useSettingsStore} from '../../stores/useSettingsStore';
import {useNotify} from '../../app/toast';

export function QueryPageSettings(){
  const saved=useSettingsStore(s=>s.queryPageSize);
  const [value,setValue]=useState(String(saved));
  const [busy,setBusy]=useState(false);
  const notify=useNotify();
  const size=Number(value);
  const valid=value.trim()!==''&&Number.isInteger(size)&&size>=1&&size<=5000;
  return <div style={{display:'flex',flexDirection:'column',gap:12,maxWidth:420}}>
    <Field label="每页最大查询行数" validationMessage={!valid?'请输入 1～5000 之间的整数':undefined}>
      <Input aria-label="每页最大查询行数" type="number" min={1} max={5000} step={1} value={value} onChange={(_,d)=>setValue(d.value)}/>
    </Field>
    <span style={{fontSize:12}}>默认 200 行。刷新表数据或重新执行 SQL 后生效；行数越多，加载可能越慢。</span>
    <Button style={{alignSelf:'flex-start'}} appearance="primary" disabled={busy||!valid||size===saved} onClick={async()=>{setBusy(true);try{await useSettingsStore.getState().setQueryPageSize(size);}catch(e){notify.error(e);}finally{setBusy(false);}}}>保存</Button>
  </div>;
}
