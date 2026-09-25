import type * as Monaco from "monaco-editor";
import { api } from "../../ipc";
import { useSessionStore } from "../../stores/useSessionStore";
import { currentStatement, tableReferences } from "./sqlText";
import type { TableRef } from "../../ipc/types";
export function registerSqlCompletion(editor:Monaco.editor.IStandaloneCodeEditor, monaco:typeof Monaco, context:()=>{sessionId:string;database:string}) {
 let cache:{key:string;time:number;tables:TableRef[]}|null=null;
 return monaco.languages.registerCompletionItemProvider("sql",{
 triggerCharacters:["."],
 provideCompletionItems:async(model,position,_,token)=>{
 if(model!==editor.getModel())return {suggestions:[]};
 const ctx=context(),cacheKey=ctx.sessionId+"/"+ctx.database,version=model.getVersionId();
 const stale=()=>token.isCancellationRequested||version!==model.getVersionId()||ctx.sessionId!==context().sessionId||ctx.database!==context().database;
 try{
 let tables:TableRef[];
 if(cache?.key===cacheKey&&Date.now()-cache.time<30000)tables=cache.tables;
 else {tables=await api.listTables(ctx.sessionId,ctx.database);cache={key:cacheKey,time:Date.now(),tables};}
 if(stale())return {suggestions:[]};
 const word=model.getWordUntilPosition(position);
 const range={startLineNumber:position.lineNumber,endLineNumber:position.lineNumber,startColumn:word.startColumn,endColumn:word.endColumn};
 const engine=useSessionStore.getState().sessions.find(s=>s.id===ctx.sessionId)?.engine;
 const quote=(name:string)=>engine==="mysql"?'`'+name.replace(/`/g,'``')+'`':'"'+name.replace(/"/g,'""')+'"';
 const sql=currentStatement(model.getValue(),model.getOffsetAt(position),engine);
 const refs=tableReferences(sql,engine);
 const prefix=model.getLineContent(position.lineNumber).slice(0,word.startColumn-1);
 const qualifier=prefix.match(/([\w]+|"[^"]+"|`[^`]+`)\.\s*$/)?.[1]?.replace(/^["`]|["`]$/g,"");
 const matched=qualifier?refs.filter(r=>r.alias===qualifier||r.name===qualifier):refs;
 let database=ctx.database;
 if(qualifier&&!matched.length&&engine==="mysql"){
   const dbs=await api.listDatabases(ctx.sessionId);
   if(dbs.some(d=>d.name===qualifier)){database=qualifier;tables=await api.listTables(ctx.sessionId,database);}
 }
 const suggestions:Monaco.languages.CompletionItem[]=[];
 if(!qualifier||!matched.length){
   tables.filter(t=>!qualifier||(engine==="mysql"&&database===qualifier)||database!==ctx.database||t.schema===qualifier).forEach(t=>suggestions.push({label:t.name,kind:monaco.languages.CompletionItemKind.Class,insertText:qualifier?quote(t.name):t.schema?quote(t.schema)+"."+quote(t.name):quote(t.name),detail:t.schema??t.comment??t.kind,range}));
 }
 if(!qualifier){
   for(const schema of new Set(tables.map(t=>t.schema).filter((s):s is string=>!!s)))suggestions.push({label:schema,kind:monaco.languages.CompletionItemKind.Module,insertText:quote(schema),range});
   for(const kw of ["SELECT","FROM","WHERE","JOIN","LEFT JOIN","ON","GROUP BY","ORDER BY","LIMIT","INSERT INTO","UPDATE","DELETE FROM","COUNT(*)","IS NULL","IS NOT NULL"])suggestions.push({label:kw,kind:monaco.languages.CompletionItemKind.Keyword,insertText:kw,range});
 }
 const metadata=await Promise.all(matched.slice(0,6).map(async ref=>{
   const db=engine==="mysql"&&ref.schema?ref.schema:ctx.database;
   const schema=engine==="mysql"?null:ref.schema??tables.find(t=>t.name===ref.name)?.schema;
   return api.tableDetail(ctx.sessionId,db,ref.name,schema).then(table=>({table,ref})).catch(()=>null);
 }));
 if(stale())return {suggestions:[]};
 metadata.forEach(item=>item?.table.columns.forEach(c=>suggestions.push({label:c.name,kind:monaco.languages.CompletionItemKind.Field,insertText:quote(c.name),detail:(item.ref.alias??item.table.name)+" · "+c.rawType+(c.comment?" · "+c.comment:""),range})));
 return {suggestions};
 }catch{return {suggestions:[]};}
 }
 });
}
