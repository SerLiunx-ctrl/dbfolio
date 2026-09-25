/** 空白分词，支持单双引号、空字符串及反斜杠转义。 */
export function parseRedisCommand(text:string):string[]{
 const out:string[]=[];let part="",quote="",started=false;
 for(let i=0;i<text.length;i++){const c=text[i];
 if(c==='\\'){if(i+1===text.length)throw Error("命令末尾的转义不完整");const next=text[++i];part+=next==='n'?'\n':next==='r'?'\r':next==='t'?'\t':next;started=true;}
 else if(quote){if(c===quote)quote="";else part+=c;}
 else if(c==='"'||c==="'"){quote=c;started=true;}
 else if(/\s/.test(c)){if(started){out.push(part);part="";started=false;}}
 else {part+=c;started=true;}}
 if(quote)throw Error("引号未闭合");if(started)out.push(part);if(!out.length)throw Error("请输入命令");return out;
}
