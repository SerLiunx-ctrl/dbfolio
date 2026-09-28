import { useEffect, useState } from 'react';
import type { Base64Image } from './base64Image';

export function imageBlob(image:Base64Image):Blob {
  const body=image.src.slice(image.src.indexOf(',')+1),parts:Uint8Array<ArrayBuffer>[]=[];
  // 分段解码避免对几十 MiB 字符串构造同等大小的数字数组。
  for(let offset=0;offset<body.length;offset+=65536){const decoded=atob(body.slice(offset,offset+65536));const bytes=new Uint8Array(decoded.length);for(let i=0;i<decoded.length;i++)bytes[i]=decoded.charCodeAt(i);parts.push(bytes);}
  return new Blob(parts,{type:image.mime});
}

export function useImageSource(image:Base64Image|null,maxEdge?:number) {
  const [result,setResult]=useState<{image:Base64Image;maxEdge?:number;src?:string;failed?:boolean;isActive:()=>boolean}|null>(null);
  useEffect(()=>{
    if(!image||!image.previewable)return;
    let alive=true,url:string|undefined;
    void (async()=>{
      let blob=imageBlob(image);
      if(maxEdge&&Math.max(image.width,image.height)>maxEdge&&!(image.mime==='image/gif'&&maxEdge>96)){
        const scale=Math.min(1,maxEdge/Math.max(image.width,image.height));
        const bitmap=await createImageBitmap(blob,{resizeWidth:Math.max(1,Math.round(image.width*scale)),resizeHeight:Math.max(1,Math.round(image.height*scale)),resizeQuality:'high'});
        try{if(!alive)return;const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;const ctx=canvas.getContext('2d');if(!ctx)throw Error('Canvas unavailable');ctx.drawImage(bitmap,0,0);blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(Error('Image decode failed')),'image/png'));}finally{bitmap.close();}
      }
      if(!alive)return;url=URL.createObjectURL(blob);setResult({image,maxEdge,src:url,isActive:()=>alive});
    })().catch(()=>{if(alive)setResult({image,maxEdge,failed:true,isActive:()=>alive});});
    return()=>{alive=false;if(url)URL.revokeObjectURL(url);};
  },[image,maxEdge]);
  return result?.image===image&&result.maxEdge===maxEdge&&result.isActive()?result:null;
}
