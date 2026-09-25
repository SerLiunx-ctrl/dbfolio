import {useEffect,useRef} from 'react';
import Editor,{type OnMount} from '@monaco-editor/react';
import {useEditorTheme} from '../../useEditorTheme';
import {registerSqlCompletion} from '../query/sqlCompletion';

// 与查询页共用补全提供器；回调读取最新数据库，避免跨库提示串用。
export function AnalysisSqlEditor({sessionId,database,value,readOnly,onChange}:{sessionId:string;database:string;value:string;readOnly:boolean;onChange:(value:string)=>void}){
 const theme=useEditorTheme(),context=useRef({sessionId,database}),completion=useRef<{dispose:()=>void}|null>(null);
 context.current={sessionId,database};
 useEffect(()=>()=>{completion.current?.dispose();},[]);
 const mount:OnMount=(editor,monaco)=>{
  completion.current?.dispose();
  completion.current=registerSqlCompletion(editor,monaco,()=>context.current);
  editor.onDidDispose(()=>{completion.current?.dispose();completion.current=null;});
 };
 return <div className="dw-analysis-sql-editor"><Editor height="156px" language="sql" theme={theme.name} beforeMount={theme.beforeMount} value={value} onChange={v=>onChange(v??'')} onMount={mount} options={{ariaLabel:'分析查询',readOnly,minimap:{enabled:false},fontSize:13,lineNumbers:'on',scrollBeyondLastLine:false,automaticLayout:true,wordWrap:'on',tabSize:2,fixedOverflowWidgets:false}}/></div>;
}
