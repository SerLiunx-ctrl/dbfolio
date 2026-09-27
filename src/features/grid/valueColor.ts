import {isNullValue,isReadOnlyValue,type CanonicalType,type DbValue} from '../../ipc/types';

export function valueTypeGroup(rawType:string,canonical?:CanonicalType,value?:DbValue){
 const kind=canonical?.kind;
 if(kind&&kind!=='unknown'){
  if(['int','float','decimal'].includes(kind))return 'number';
  if(['date','time','dateTime'].includes(kind))return 'date';
  if(kind==='bool')return 'boolean';
  if(['json','binary'].includes(kind))return 'document';
  return 'text';
 }
 const raw=rawType.toLowerCase().trim();
 if(/\b(date|datetime\d*|timestamp\w*|time\w*|interval|year)\b/.test(raw))return 'date';
 if(/\b(bool|boolean)\b/.test(raw))return 'boolean';
 if(/\b(tinyint|smallint|mediumint|bigint|int\d*|integer|serial\d*|bigserial|smallserial|decimal|numeric|number|float\d*|double|real|money|smallmoney)\b/.test(raw))return 'number';
 if(/\b(jsonb?|xml|\w*blob|\w*binary|bytea|bit|varbit)\b/.test(raw))return 'document';
 if(/\b(\w*char|\w*text|clob|uuid|enum|set|citext)\b/.test(raw))return 'text';
 const tag=value?.[0];
 if(tag&&['int','uint','float','decimal'].includes(tag))return 'number';
 if(tag&&['date','time','datetime'].includes(tag))return 'date';
 if(tag==='bool')return 'boolean';
 if(tag==='json'||tag==='bytes')return 'document';
 return 'text';
}

// 结构元数据与数据单元格共用同一套类型配色。
export function fieldTypeStyle(rawType:string,canonical?:CanonicalType){
 return {color:`var(--dw-value-${valueTypeGroup(rawType,canonical)})`};
}

export function valueCellStyle(rawType:string,value?:DbValue,canonical?:CanonicalType){
 if(isReadOnlyValue(value))return {color:'var(--dw-value-special)',fontStyle:'italic'};
 if(isNullValue(value))return {color:'var(--dw-value-null)',fontStyle:'italic'};
 // 显式重置斜体，避免 AG Grid 复用单元格时残留 NULL/截断值样式。
 return {color:`var(--dw-value-${valueTypeGroup(rawType,canonical,value)})`,fontStyle:'normal'};
}
