import type * as Monaco from "monaco-editor";
import { api } from "../../ipc";
import { useSessionStore } from "../../stores/useSessionStore";
import { currentStatement, tableReferences, sqlTokens } from "./sqlText";
import type { TableRef } from "../../ipc/types";
export function registerSqlCompletion(editor:Monaco.editor.IStandaloneCodeEditor, monaco:typeof Monaco, context:()=>{sessionId:string;database:string}) {
 let cache:{key:string;time:number;tables:TableRef[]}|null=null;
 return monaco.languages.registerCompletionItemProvider("sql",{
 triggerCharacters:["."],
 provideCompletionItems:async(model,position,_,token)=>{
 if(model!==editor.getModel())return {suggestions:[]};
 const ctx=context(),cacheKey=ctx.sessionId+"/"+ctx.database,version=model.getVersionId();
 const stale=()=>token.isCancellationRequested||version!==model.getVersionId()||ctx.sessionId!==context().sessionId||ctx.database!==context().database;
 const engine=useSessionStore.getState().sessions.find(s=>s.id===ctx.sessionId)?.engine;
 const text=model.getValue(),offset=model.getOffsetAt(position);
 const tokens=sqlTokens(text,engine);
 const enclosing=tokens.find(t=>t.start<offset&&offset<=t.end&&(t.kind==="quoted"||t.kind==="comment"));
 // 单引号/dollar-quote 是值，MySQL 默认模式中的双引号也是值；不把它们改成对象名。
 if(enclosing&&(enclosing.kind==="comment"||enclosing.text[0]==="'"||enclosing.text[0]==="$"||(engine==="mysql"&&enclosing.text[0]==='"')))return {suggestions:[]};
 const word=model.getWordAtPosition(position)??model.getWordUntilPosition(position);
 const start=enclosing?.start??model.getOffsetAt({lineNumber:position.lineNumber,column:word.startColumn});
 const end=enclosing?.end??model.getOffsetAt({lineNumber:position.lineNumber,column:word.endColumn});
 const from=model.getPositionAt(start),to=model.getPositionAt(end);
 if(from.lineNumber!==to.lineNumber)return {suggestions:[]}; // Monaco 替换范围只能位于同一行。
 const range={startLineNumber:from.lineNumber,endLineNumber:to.lineNumber,startColumn:from.column,endColumn:to.column};
 const unquote=(name:string)=>name.replace(/^["`\[]|["`\]]$/g,"").replace(/""/g,'"').replace(/``/g,'`').replace(/\]\]/g,']');
 // 从完整替换范围之前读限定符，支持库/schema/别名及它们的转义名称。
 const previous=tokens.filter(t=>t.end<=start&&t.kind!=="space"&&t.kind!=="comment");
 const qualifierToken=previous[previous.length-1]?.text==="."?previous[previous.length-2]:undefined;
 const qualifier=qualifierToken&&(qualifierToken.kind==="word"||qualifierToken.kind==="quoted")?unquote(qualifierToken.text):undefined;
 // Monaco 用替换起点到光标的文本筛选候选；范围含原引号时，筛选文本也须包含该引号。
 const filterText=(name:string)=>{
   if(!enclosing)return name;
   const open=enclosing.text[0],close=open==="["?"]":open;
   return open+name.split(close).join(close.repeat(2))+close;
 };
 try{
 let tables:TableRef[];
 if(cache?.key===cacheKey&&Date.now()-cache.time<30000)tables=cache.tables;
 else {tables=await api.listTables(ctx.sessionId,ctx.database);cache={key:cacheKey,time:Date.now(),tables};}
 if(stale())return {suggestions:[]};
 const quote=(name:string)=>engine==="mysql"?'`'+name.replace(/`/g,'``')+'`':'"'+name.replace(/"/g,'""')+'"';
 const sql=currentStatement(text,offset,engine);
 const refs=tableReferences(sql,engine);
 const matched=qualifier?refs.filter(r=>r.alias===qualifier||r.name===qualifier):refs;
 let database=ctx.database;
 if(qualifier&&!matched.length&&engine==="mysql"){
   const dbs=await api.listDatabases(ctx.sessionId);
   if(dbs.some(d=>d.name===qualifier)){database=qualifier;tables=await api.listTables(ctx.sessionId,database);}
 }
 const suggestions:Monaco.languages.CompletionItem[]=[];
 if(!qualifier||!matched.length){
   tables.filter(t=>!qualifier||(engine==="mysql"&&database===qualifier)||database!==ctx.database||t.schema===qualifier).forEach(t=>suggestions.push({label:t.name,filterText:filterText(t.name),kind:monaco.languages.CompletionItemKind.Class,insertText:qualifier?quote(t.name):t.schema?quote(t.schema)+"."+quote(t.name):quote(t.name),detail:t.schema??t.comment??t.kind,range}));
 }
 if(!qualifier){
   for(const schema of new Set(tables.map(t=>t.schema).filter((s):s is string=>!!s)))suggestions.push({label:schema,filterText:filterText(schema),kind:monaco.languages.CompletionItemKind.Module,insertText:quote(schema),range});
   if(!enclosing)for(const kw of ["SELECT","FROM","WHERE","JOIN","LEFT JOIN","ON","GROUP BY","ORDER BY","LIMIT","INSERT INTO","UPDATE","DELETE FROM","COUNT(*)","IS NULL","IS NOT NULL"])suggestions.push({label:kw,kind:monaco.languages.CompletionItemKind.Keyword,insertText:kw,range});
 }
 const metadata=await Promise.all(matched.slice(0,6).map(async ref=>{
   const db=engine==="mysql"&&ref.schema?ref.schema:ctx.database;
   const schema=engine==="mysql"?null:ref.schema??tables.find(t=>t.name===ref.name)?.schema;
   return api.tableDetail(ctx.sessionId,db,ref.name,schema).then(table=>({table,ref})).catch(()=>null);
 }));
 if(stale())return {suggestions:[]};
 metadata.forEach(item=>item?.table.columns.forEach(c=>suggestions.push({label:c.name,filterText:filterText(c.name),kind:monaco.languages.CompletionItemKind.Field,insertText:quote(c.name),detail:(item.ref.alias??item.table.name)+" · "+c.rawType+(c.comment?" · "+c.comment:""),range})));
 return {suggestions};
 }catch{return {suggestions:[]};}
 }
 });
}
