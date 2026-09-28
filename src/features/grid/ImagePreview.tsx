import { Button, Spinner } from '@fluentui/react-components';
import { useEffect, useState } from 'react';
import { useImageSource } from './useImageSource';
import type { Base64Image } from './base64Image';
import './image-preview.css';

export function ImagePreview({image,onError}:{image:Base64Image;onError:()=>void}) {
  const [original,setOriginal]=useState(false);
  const source=useImageSource(image,original?undefined:2048);
  useEffect(()=>{if(source?.failed)onError();},[source?.failed,onError]);
  return <>
    <div className="dw-image-tools"><Button size="small" onClick={()=>setOriginal(v=>!v)}>{original?'适应窗口':'原始尺寸'}</Button><span>{image.width} × {image.height} · {image.mime.replace('image/','').toUpperCase()}</span></div>
    <div className={'dw-image-stage'+(original?' dw-image-original':'')}>{source?.src?<img src={source.src} alt="完整图片" onError={onError}/>:<Spinner size="tiny" label="正在准备图片"/>}</div>
  </>;
}
