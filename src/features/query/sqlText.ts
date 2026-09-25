export interface SqlToken { text: string; start: number; end: number; kind: "word" | "quoted" | "comment" | "space" | "symbol" }
/** 词法扫描保留原文位置，分号和参数只在引号/注释外识别。 */
export function sqlTokens(sql: string, engine = "mysql"): SqlToken[] {
  const tokens: SqlToken[]=[];
  for(let i=0;i<sql.length;){
    const start=i; let kind:SqlToken["kind"]="symbol";
    if (/\s/.test(sql[i])) {kind="space";while(i<sql.length&&/\s/.test(sql[i]))i++;}
    else if(sql.startsWith("--",i)||(engine==="mysql"&&sql[i]==="#")) {kind="comment";while(i<sql.length&&sql[i]!=="\n")i++;}
    else if(sql.startsWith("/*",i)) {kind="comment";i+=2;let depth=1;while(i<sql.length&&depth){if(sql.startsWith("/*",i)){depth++;i+=2;}else if(sql.startsWith("*/",i)){depth--;i+=2;}else i++;}}
    else if ((['"',"'","`"].includes(sql[i])||(engine==="sqlite"&&sql[i]==="["))) {kind="quoted";const close=sql[i]==="["?"]":sql[i];i++;while(i<sql.length){if(sql[i]==="\\"&&(engine==="mysql"||(engine==="postgres"&&sql[start-1]?.toUpperCase()==="E"))){i+=2;continue;}if(sql[i++]===close){if(sql[i]===close)i++;else break;}}}
    else if(sql[i]==="$" && /^\$(?:[A-Za-z_][\w]*)?\$/.test(sql.slice(i))){kind="quoted";const tag=sql.slice(i).match(/^\$(?:[A-Za-z_][\w]*)?\$/)![0];const end=sql.indexOf(tag,i+tag.length);i=end<0?sql.length:end+tag.length;}
    else if(/[A-Za-z_\u0080-\uffff]/.test(sql[i])) {kind="word";i++;while(i<sql.length&&/[\w$\u0080-\uffff]/.test(sql[i]))i++;}
    else i++;
    tokens.push({text:sql.slice(start,i),start,end:Math.min(i,sql.length),kind});
  }
  return tokens;
}
export function currentStatement(sql: string, offset: number, engine = "mysql"): string {
  const delimiters=sqlTokens(sql, engine).filter(t=>t.kind==="symbol"&&t.text===";");
  let start=0,last="";
  for(const t of delimiters){
    const statement=sql.slice(start,t.start).trim();
    if(offset<=t.start)return statement;
    if(statement)last=statement;
    start=t.end;
  }
  const tail=sql.slice(start).trim();
  return sqlTokens(tail,engine).some(t=>t.kind!=="space"&&t.kind!=="comment")?tail:last;
}
export function namedParameters(sql: string, engine = "mysql") {
  const tokens=sqlTokens(sql, engine), found:{name:string;start:number;end:number}[]=[];
  tokens.forEach((token,i)=>{const next=tokens[i+1];if(token.text===":"&&tokens[i-1]?.text!==":"&&next?.kind==="word"&&next.start===token.end)found.push({name:next.text,start:token.start,end:next.end});});
  return found;
}
export function fillParameters(sql: string, literals: Record<string,string>, engine = "mysql") {
  let result=sql;
  for(const p of namedParameters(sql, engine).reverse()){if(!Object.prototype.hasOwnProperty.call(literals,p.name))throw Error(`缺少参数 ${p.name}`);result=result.slice(0,p.start)+literals[p.name]+result.slice(p.end);}
  return result;
}
export function tableReferences(sql: string, engine = "mysql") {
  const tokens=sqlTokens(sql, engine).filter(t=>t.kind!=="space"&&t.kind!=="comment");
  const identifier=(t:SqlToken|undefined)=>!!t&&(t.kind==="word"||(t.kind==="quoted"&&t.text[0]!=="'"&&t.text[0]!=="$"));
  const unquote=(text:string)=>text.replace(/^["`\[]|["`\]]$/g,"").replace(/""/g,'"').replace(/``/g,'`').replace(/\]\]/g,']');
  const refs:{name:string;schema?:string;alias?:string}[]=[];
  for(let i=0;i<tokens.length;i++){
    if(tokens[i].kind!=="word"||!/^(FROM|JOIN|UPDATE|INTO)$/i.test(tokens[i].text)||!identifier(tokens[i+1]))continue;
    let name=unquote(tokens[++i].text),schema:string|undefined;
    if(tokens[i+1]?.text==="."&&identifier(tokens[i+2])){schema=name;name=unquote(tokens[i+2].text);i+=2;}
    if(tokens[i+1]?.text.toUpperCase()==="AS")i++;
    let alias:string|undefined;
    if(identifier(tokens[i+1])&&!/^(WHERE|JOIN|LEFT|RIGHT|INNER|OUTER|FULL|CROSS|ON|SET|VALUES|GROUP|ORDER|HAVING|LIMIT|OFFSET|UNION|RETURNING|USING)$/i.test(tokens[i+1].text))alias=unquote(tokens[++i].text);
    refs.push({name,schema,alias});
  }
  return refs;
}
export function formatSql(sql: string, engine = "mysql") {
  // 保守排版：只调整子句前空白，不修改字面量、标识符或注释内容。
  const tokens=sqlTokens(sql, engine);let out="",depth=0,previous:string|undefined;
  for(let i=0;i<tokens.length;i++){
    const t=tokens[i];if(t.kind==="space"){out+=t.text;continue;}
    if(t.kind==="symbol"&&t.text===")")depth=Math.max(0,depth-1);
    const upper=t.text.toUpperCase();
    let nextIndex=i+1;while(tokens[nextIndex]?.kind==="space")nextIndex++;
    const next=tokens[nextIndex]?.text.toUpperCase();
    const clause=/^(SELECT|FROM|WHERE|HAVING|LIMIT|OFFSET|UNION|EXCEPT|INTERSECT|SET|VALUES|RETURNING|AND|OR)$/.test(upper)
      || (["GROUP","ORDER"].includes(upper)&&next==="BY")
      || (["LEFT","RIGHT","INNER","OUTER","FULL","CROSS"].includes(upper)&&["JOIN","OUTER"].includes(next??""))
      || (upper==="JOIN"&&!["LEFT","RIGHT","INNER","OUTER","FULL","CROSS"].includes(previous??""));
    if(t.kind==="word"&&clause && depth===0 && out.trim()){
      // 行注释后的换行保留；不重写注释。
      out=out.replace(/[ \t]+$/g,"");if(!out.endsWith("\n"))out+="\n";
    }
    out+=t.text;previous=upper;
    if(t.kind==="symbol"&&t.text==="(")depth++;
    if(t.kind==="symbol"&&t.text===";")out+="\n";
  }
  return out.trim();
}
