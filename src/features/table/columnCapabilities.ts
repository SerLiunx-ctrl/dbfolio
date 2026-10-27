import type { Engine } from '../../ipc/types';

export function columnCapabilities(engine: Engine) {
  return {
    unsigned: engine === 'mysql',
    onUpdate: engine === 'mysql',
    comment: engine !== 'sqlite',
    identityEditable: engine !== 'postgres',
    insertPosition: engine === 'mysql',
    reorder: engine !== 'postgres',
  };
}

export function splitColumnType(raw: string, engine: Engine) {
  const text = engine === 'mysql' ? raw.replace(/\s+(unsigned|zerofill)\b/gi, '').trim() : raw.trim();
  let quote='',start=-1,depth=0;
  for(let i=0;i<text.length;i++){
    const char=text[i];
    if(quote){if(char===quote){if(text[i+1]===quote)i++;else quote='';}else if(char==='\\'&&engine==='mysql')i++;continue;}
    if(['"',"'",'`'].includes(char)){quote=char;continue;}
    if(char==='('){if(depth++===0)start=i;}
    else if(char===')'&&depth>0&&--depth===0)return {type:(text.slice(0,start).trim()+text.slice(i+1)).trim(),args:text.slice(start+1,i)};
  }
  return {type:text,args:''};
}

export function joinColumnType(type: string, args: string) {
  if (!args) return type;
  const suffix = type.match(/(\s+(?:with|without) time zone|\[\])+$/i)?.[0] ?? '';
  return type.slice(0, type.length - suffix.length) + `(${args})` + suffix;
}
