import {sqlTokens} from './sqlText';
export interface SqlRisk {level:'none'|'yellow'|'red';reason:string}
/** 提示用途的保守检查，不代替数据库执行权限或执行确认。 */
export function sqlRisk(sql:string,engine='mysql',ai?:SqlRisk):SqlRisk {
 const tokens=sqlTokens(sql,engine).filter(t=>t.kind!=='space'&&t.kind!=='comment');
 const words=tokens.map(t=>t.kind==='word'?t.text.toUpperCase():'');
 let local:SqlRisk={level:'none',reason:''};
 if(words.some(w=>['DROP','TRUNCATE','REINDEX'].includes(w))||words.includes('INDEX')&&words.some(w=>['CREATE','ALTER'].includes(w)))local={level:'red',reason:'包含删除对象、清空数据或索引调整，可能造成数据丢失、锁表或影响查询性能。'};
 else if(words.some(w=>['INSERT','UPDATE','DELETE','ALTER','CREATE','REPLACE','MERGE','GRANT','REVOKE','CALL','EXEC','DO'].includes(w)))local={level:'yellow',reason:'包含数据、表结构或权限修改，请核对目标对象和影响范围。'};
 else {
  let depth=0;const depths=tokens.map(t=>{if(t.text===')')depth--;const d=depth;if(t.text==='(')depth++;return d;});
  for(let i=0;i<words.length;i++)if(words[i]==='SELECT'){
   let from=false,bounded=false;
   for(let j=i+1;j<words.length;j++){
    if(depths[j]<depths[i]||tokens[j].text===';'||depths[j]===depths[i]&&['UNION','EXCEPT','INTERSECT'].includes(words[j]))break;
    if(depths[j]!==depths[i])continue;
    if(words[j]==='FROM')from=true;
    if(['WHERE','LIMIT','TOP','FETCH'].includes(words[j]))bounded=true;
   }
   if(from&&!bounded){local={level:'yellow',reason:'查询未限定筛选条件或返回数量，可能读取或聚合全表数据，请留意数据量。'};break;}
  }
 }
 const rank={none:0,yellow:1,red:2};
 return ai&&rank[ai.level]>rank[local.level]?{level:ai.level,reason:ai.reason||'AI 判断该语句存在风险，请核对执行影响。'}:local;
}
