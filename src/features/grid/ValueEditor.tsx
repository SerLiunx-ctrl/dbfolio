import { useEditorTheme } from "../../useEditorTheme";
import Editor, { type OnMount } from "@monaco-editor/react";
import { Button } from "@fluentui/react-components";
import { CodeRegular, SearchRegular, CopyRegular } from "@fluentui/react-icons";
import { useRef } from "react";
import type { editor } from "monaco-editor";
import { useNotify } from "../../app/toast";
import { api } from "../../ipc";

export function ValueEditor({text,onChange,readOnly=false,binary=false}: {text:string;onChange?:(text:string)=>void;readOnly?:boolean;binary?:boolean}) {
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
