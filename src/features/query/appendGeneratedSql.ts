export function appendGeneratedSql(current:string,candidate:string):string {
 if(!current.trim())return candidate;
 // 换行后再补分号，避免末尾单行注释吞掉语句分隔符。
 return current+(current.trimEnd().endsWith(';')?'\n\n':'\n;\n\n')+candidate;
}
