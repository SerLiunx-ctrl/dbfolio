// 从尚未收完的 JSON 响应中提取顶层 sql 字符串；不把包装、说明或问题显示为 SQL。
function stringAt(source:string,start:number){
 let text='';
 for(let i=start+1;i<source.length;i++){
  const c=source[i];
  if(c==='"')return {text,end:i+1,complete:true};
  if(c!=='\\'){text+=c;continue;}
  const escape=source[++i];
  if(escape===undefined)break;
  if(escape==='u'){
   const hex=source.slice(i+1,i+5);if(!/^[0-9a-f]{4}$/i.test(hex))break;
   text+=String.fromCharCode(parseInt(hex,16));i+=4;
  }else{
   const escaped:Record<string,string>={'"':'"','\\':'\\','/':'/','n':'\n','r':'\r','t':'\t','b':'\b','f':'\f'};
   if(!(escape in escaped))break;text+=escaped[escape];
  }
 }
 // Unicode 代理对跨 chunk 时，不显示半个字符。
 return {text:text.replace(/[\uD800-\uDBFF]$/,''),end:source.length,complete:false};
}
export function streamedSql(source:string):string{
 let depth=0;
 for(let i=source.indexOf('{');i>=0&&i<source.length;i++){
  const c=source[i];
  if(c==='{'||c==='['){depth++;continue;}
  if(c==='}'||c===']'){depth--;continue;}
  if(c!=='"')continue;
  const value=stringAt(source,i);if(!value.complete)return '';
  let next=value.end;while(/\s/.test(source[next]??'')&&next<source.length)next++;
  if(depth===1&&value.text==='sql'&&source[next]===':'){
   next++;while(/\s/.test(source[next]??'')&&next<source.length)next++;
   return source[next]==='"'?stringAt(source,next).text:'';
  }
  i=value.end-1;
 }
 return '';
}
