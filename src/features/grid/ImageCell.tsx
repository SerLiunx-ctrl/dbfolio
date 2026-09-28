import { useEffect, useMemo, useRef, useState } from 'react';
import type { DbValue } from '../../ipc/types';
import { base64Image, isImageCandidate, THUMBNAIL_TEXT_LIMIT } from './base64Image';
import './image-preview.css';
import { useImageSource } from './useImageSource';

// 可见单元格才读取，所有网格共用最多两个读取槽；离开视口可撤销尚未开始的任务。
let active=0;
const queue:{run:()=>Promise<void>;cancelled:boolean}[]=[];
function pump() {
  while(active<2&&queue.length){const job=queue.shift()!;if(job.cancelled)continue;active++;void job.run().finally(()=>{active--;pump();});}
}
function enqueue(run:()=>Promise<void>){const job={run,cancelled:false};queue.push(job);pump();return()=>{job.cancelled=true;};}

export function ImageCell({value,text,loadValue,onOpen}:{value?:DbValue;text:string;loadValue?:(limit:number)=>Promise<DbValue|null>;onOpen:()=>void}) {
  const ref=useRef<HTMLSpanElement>(null);
  const loadRef=useRef(loadValue);loadRef.current=loadValue;
  const candidate=isImageCandidate(value), truncated=value?.[0]==='trunc';
  const [loaded,setLoaded]=useState<{source:DbValue|undefined;value:DbValue|null}|null>(null);
  const [failed,setFailed]=useState<string|null>(null);
  const canLoad=!!loadValue;
  useEffect(()=>{
    if(!candidate||!truncated||!canLoad||!ref.current)return;
    let alive=true,started=false,queued=false,cancel=()=>{};
    const observer=new IntersectionObserver(entries=>{
      if(started)return;
      if(!entries.some(e=>e.isIntersecting)){cancel();queued=false;return;}
      if(queued)return;queued=true;
      cancel=enqueue(async()=>{if(!alive)return;started=true;observer.disconnect();try{const result=await loadRef.current?.(THUMBNAIL_TEXT_LIMIT);if(alive)setLoaded({source:value,value:result??null});}catch{if(alive)setLoaded({source:value,value:null});}});
    });observer.observe(ref.current);
    return()=>{alive=false;cancel();observer.disconnect();};
  },[value,candidate,truncated,canLoad]);
  const source=truncated?(loaded?.source===value?loaded.value:null):value;
  const image=useMemo(()=>source?.[0]==='text'?base64Image(String(source[1])):null,[source]);
  const preview=useImageSource(image,96);
  const showImage=image&&preview?.src&&!preview.failed&&failed!==image.src;
  const canOpen=image&&failed!==image.src&&!preview?.failed||(candidate&&truncated&&canLoad);
  return <span ref={ref}>{canOpen?<button type="button" className="dw-image-cell" title="查看图片；原始文本可在详情中查看" aria-label="查看图片" onDoubleClick={e=>e.stopPropagation()} onClick={e=>{e.stopPropagation();onOpen();}}>
    {showImage?<img src={preview.src} alt="图片缩略图" onError={()=>setFailed(image.src)}/>:null}<span>{showImage?'查看图片':'图片 · 点击查看'}</span>
  </button>:text}</span>;
}
