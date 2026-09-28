import { useEditorTheme } from "../../useEditorTheme";
import Editor, { type OnMount } from "@monaco-editor/react";
import { Button } from "@fluentui/react-components";
import { CodeRegular, SearchRegular, CopyRegular } from "@fluentui/react-icons";
import { useMemo, useRef, useState } from "react";
import { base64Image } from './base64Image';
import { ImagePreview } from './ImagePreview';
import { ExportImageButton } from './ExportImageButton';
import type { editor } from "monaco-editor";
import { useNotify } from "../../app/toast";
import { api } from "../../ipc";

interface ValueEditorProps {text:string;onChange?:(text:string)=>void;readOnly?:boolean;binary?:boolean;allowImage?:boolean}
export function ValueEditor(props: ValueEditorProps) {
  const image=useMemo(()=>!props.binary && props.allowImage!==false ? base64Image(props.text) : null,[props.text,props.binary,props.allowImage]);
  const [raw,setRaw]=useState(false),[failed,setFailed]=useState<string|null>(null);
  if(!image) return <TextValueEditor {...props}/>;
  return <><div className="dw-image-tools"><Button size="small" appearance={!raw?'primary':'secondary'} onClick={()=>setRaw(false)}>图片</Button><Button size="small" appearance={raw?'primary':'secondary'} onClick={()=>setRaw(true)}>原始文本</Button><ExportImageButton image={image}/></div>
    {raw?<TextValueEditor {...props}/>:!image.previewable?<p>图片尺寸过大，无法在窗口内预览，可导出原图查看。</p>:failed===image.src?<><p>图片解码失败，可导出原图或查看原始文本。</p><TextValueEditor {...props}/></>:<ImagePreview image={image} onError={()=>setFailed(image.src)}/>}</>;
}
function TextValueEditor({text,onChange,readOnly=false,binary=false}: ValueEditorProps) {
  const notify=useNotify();
  const editorTheme=useEditorTheme();
  const ref=useRef<editor.IStandaloneCodeEditor|null>(null);
  const json=!binary && /^[\s]*[\[{]/.test(text);
  const mount:OnMount=instance=>{ref.current=instance;};
  return <>
    <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:8,flexWrap:"wrap"}}>
      <Button size="small" icon={<SearchRegular />} onClick={()=>void ref.current?.getAction("actions.find")?.run()}>搜索</Button>
      <Button size="small" icon={<CodeRegular />} disabled={readOnly || binary || !json} onClick={()=>{try{JSON.parse(text);void ref.current?.getAction("editor.action.formatDocument")?.run();}catch{notify.error(Error("内容不是有效 JSON"));}}}>格式化 JSON</Button>
      <Button size="small" icon={<CopyRegular />} onClick={()=>void api.clipboardWriteText(text).catch(e=>notify.error(e))}>复制</Button>
      <span style={{fontSize:12}}>{binary ? "十六进制" : json ? "JSON" : "文本"} · {text.length.toLocaleString()} 字符</span>
    </div>
    <div style={{height:"min(48vh, 480px)",minHeight:160,border:"1px solid var(--colorNeutralStroke2)"}}>
      <Editor value={text} onChange={value=>onChange?.(value??"")} onMount={mount} language={json ? "json" : "plaintext"} theme={editorTheme.name} beforeMount={editorTheme.beforeMount}
        options={{readOnly,automaticLayout:true,minimap:{enabled:false},wordWrap:"on",scrollBeyondLastLine:false,fontSize:13,ariaLabel:"单元格详情内容"}} />
    </div>
  </>;
}
