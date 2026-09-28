import { Button, Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions, Spinner } from '@fluentui/react-components';
import { useEffect, useState } from 'react';
import type { DbValue } from '../../ipc/types';
import { IMAGE_TEXT_LIMIT } from './base64Image';
import { ValueEditor } from './ValueEditor';

export interface ImageValueTarget { name:string;value:DbValue;loadValue?:(limit:number)=>Promise<DbValue|null> }
export function ImageValueDialog({target,onClose}:{target:ImageValueTarget;onClose:()=>void}) {
  const [value,setValue]=useState(target.value),[loading,setLoading]=useState(false),[hint,setHint]=useState('');
  useEffect(()=>{
    if(target.value[0]!=='trunc'||!target.loadValue)return;
    let alive=true;setLoading(true);
    target.loadValue(IMAGE_TEXT_LIMIT).then(result=>{
      if(!alive)return;
      if(result&&result[0]==='text')setValue(result);
      else setHint('完整值超出图片预览范围或已不可用，显示当前文本预览。');
    }).catch(()=>{if(alive)setHint('读取完整图片失败，显示当前文本预览。');}).finally(()=>{if(alive)setLoading(false);});
    return()=>{alive=false;};
  },[target]);
  return <Dialog open onOpenChange={(_,d)=>{if(!d.open)onClose();}}><DialogSurface style={{width:'90vw',maxWidth:1100}}><DialogBody>
    <DialogTitle>图片详情 · {target.name}</DialogTitle><DialogContent>{loading?<Spinner size="tiny" label="读取完整图片…"/>:<>{hint&&<p role="status">{hint}</p>}<ValueEditor text={String(value[1]??'')} readOnly allowImage={value[0]==='text'}/></>}</DialogContent>
    <DialogActions><Button onClick={onClose}>关闭</Button></DialogActions>
  </DialogBody></DialogSurface></Dialog>;
}
