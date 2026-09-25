import type * as Monaco from 'monaco-editor';
import {useEffect,useRef} from 'react';
import Editor,{type OnMount} from '@monaco-editor/react';
import {useEditorTheme} from '../../useEditorTheme';
import {api} from '../../ipc';

export function PromptEditor({sessionId,database,value,busy,onChange}:{sessionId:string;database:string;value:string;busy:boolean;onChange:(v:string)=>void}){
 const theme=useEditorTheme(),context=useRef({sessionId,database}),completion=useRef<{dispose:()=>void}|null>(null);
 if(context.current.sessionId!==sessionId||context.current.database!==database)context.current={sessionId,database};
 useEffect(()=>()=>completion.current?.dispose(),[]);
 const mount:OnMount=(editor,monaco)=>{
  completion.current?.dispose();
  completion.current=monaco.languages.registerCompletionItemProvider('plaintext',{
   triggerCharacters:['@','.'],
   provideCompletionItems:async(model:Monaco.editor.ITextModel,position:Monaco.Position,_:Monaco.languages.CompletionContext,token:Monaco.CancellationToken)=>{
    if(model!==editor.getModel())return {suggestions:[]};
    const ctx=context.current,version=model.getVersionId();
    const stale=()=>token.isCancellationRequested||model.isDisposed()||version!==model.getVersionId()||ctx!==context.current;
    try{
     const tables=await api.listTables(ctx.sessionId,ctx.database),word=model.getWordUntilPosition(position);
     const prefix=model.getLineContent(position.lineNumber).slice(0,word.startColumn-1);
     const qualifier=prefix.match(/@?([\w]+(?:\.[\w]+)?)\.$/)?.[1];
     const range={startLineNumber:position.lineNumber,endLineNumber:position.lineNumber,startColumn:word.startColumn,endColumn:word.endColumn};
     const matched=tables.filter(t=>qualifier?(t.name===qualifier||`${t.schema}.${t.name}`===qualifier):model.getValue().includes(t.name)).slice(0,6);
     const suggestions=qualifier?[]:tables.map(t=>({label:t.name,kind:monaco.languages.CompletionItemKind.Class,insertText:t.schema?`${t.schema}.${t.name}`:t.name,detail:t.comment??t.schema??'表',range}));
     for(const table of matched){
      const meta=await api.tableDetail(ctx.sessionId,ctx.database,table.name,table.schema);
      suggestions.push(...meta.columns.map(c=>({label:c.name,kind:monaco.languages.CompletionItemKind.Field,insertText:qualifier?c.name:`${table.schema?table.schema+'.':''}${table.name}.${c.name}`,detail:`${table.name} · ${c.rawType}${c.comment?' · '+c.comment:''}`,range})));
     }
     return {suggestions:stale()?[]:suggestions};
    }catch{return {suggestions:[]};}
   }
  });
 };
 return <div className="dw-smart-prompt" style={{position:"relative"}}>{!value&&<span aria-hidden style={{position:"absolute",zIndex:1,top:8,left:8,pointerEvents:"none",color:"var(--colorNeutralForeground3)",fontSize:13}}>描述需求，输入 @ 引用表或字段</span>}<Editor height="96px" language="plaintext" value={value} onChange={v=>onChange(v??'')} onMount={mount} theme={theme.name} beforeMount={theme.beforeMount} options={{ariaLabel:'生成需求',readOnly:busy,minimap:{enabled:false},lineNumbers:'off',glyphMargin:false,folding:false,lineDecorationsWidth:8,lineNumbersMinChars:0,renderLineHighlight:'none',overviewRulerLanes:0,hideCursorInOverviewRuler:true,unicodeHighlight:{ambiguousCharacters:false,invisibleCharacters:false},wordWrap:'on',scrollBeyondLastLine:false,automaticLayout:true,fontSize:13,fixedOverflowWidgets:false,quickSuggestions:true,suggestOnTriggerCharacters:true,padding:{top:8,bottom:8}}}/></div>;
}
