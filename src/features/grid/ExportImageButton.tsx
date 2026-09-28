import { useState } from 'react';
import { Button } from '@fluentui/react-components';
import { ArrowDownloadRegular } from '@fluentui/react-icons';
import { save } from '@tauri-apps/plugin-dialog';
import { api } from '../../ipc';
import { useNotify } from '../../app/toast';
import type { Base64Image } from './base64Image';

export function ExportImageButton({image}:{image:Base64Image}) {
  const [busy,setBusy]=useState(false),notify=useNotify();
  const exportImage=async()=>{
    setBusy(true);
    try{
      const extension=image.mime==='image/jpeg'?'jpg':image.mime.slice(6);
      const path=await save({title:'导出原图',defaultPath:`image_${image.width}x${image.height}.${extension}`,filters:[{name:extension.toUpperCase()+' 图片',extensions:extension==='jpg'?['jpg','jpeg']:[extension]}]});
      if(path){await api.exportImage(path,image.src.slice(image.src.indexOf(',')+1));notify.success('原图已导出');}
    }catch(error){notify.error(error);}finally{setBusy(false);}
  };
  return <Button size="small" icon={<ArrowDownloadRegular/>} disabled={busy} onClick={()=>void exportImage()}>{busy?'正在导出…':'导出原图'}</Button>;
}
