import type {DbValue,QueryOutcome} from '../../ipc/types';
export interface ResultSnapshot {result:QueryOutcome;source:string;scope:string;capturedAt:string}
export interface ResultDifference {kind:'added'|'removed'|'changed';key:string;before?:DbValue[];after?:DbValue[];fields:string[]}
// Decimal normalization uses strings, preserving integers beyond Number.MAX_SAFE_INTEGER.
function numeric(text:string){
  const m=/^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if(!m||!(m[2]||m[3]))throw Error('结果包含无效数值');
  const exponent=Number(m[4]||0)-(m[3]||'').length;
  if(!Number.isSafeInteger(exponent)||Math.abs(exponent)>100000)throw Error('数值指数超出对比范围');
  let digits=(m[2]+(m[3]||'')).replace(/^0+/,'');if(!digits)return '0';
  const trailing=digits.length-digits.replace(/0+$/,'').length;digits=digits.slice(0,digits.length-trailing);
  return (m[1]==='-'?'-':'')+digits+'e'+(exponent+trailing);
}
function identity(value:DbValue):string{
  if(!value||value[0]==='trunc'||value[0]==='readonly')throw Error('结果含截断值或不可比较类型，请查询完整的可比较字段后重试');
  if(['int','uint','decimal','float'].includes(value[0]))return 'number:'+numeric(String(value[1]));
  return JSON.stringify(value);
}
export function compareResults(before:QueryOutcome,after:QueryOutcome,keys:string[]){
  const names=before.columns.map(c=>c.name),nextNames=after.columns.map(c=>c.name);
  if(new Set(names).size!==names.length||new Set(nextNames).size!==nextNames.length)throw Error('结果存在重名列，请用 SQL 别名区分后比较');
  if(names.length!==nextNames.length||names.some(n=>!nextNames.includes(n)))throw Error('两份结果的字段名称不一致，请查询相同字段后比较');
  if(!keys.length||keys.some(k=>!names.includes(k)))throw Error('请选择双方共有且唯一的对比键，可选择多个字段');
  const keyIndexes=keys.map(k=>names.indexOf(k));
  function index(result:QueryOutcome,side:string){
    const order=names.map(n=>result.columns.findIndex(c=>c.name===n));
    const map=new Map<string,DbValue[]>();
    for(const raw of result.rows){const row=order.map(i=>raw[i]);row.forEach(identity);
      if(keyIndexes.some(i=>row[i][0]==='null'))throw Error(side+'的对比键含 NULL，请选择其他键');
      const key=JSON.stringify(keyIndexes.map(i=>identity(row[i])));
      if(map.has(key))throw Error(side+'存在重复对比键，请补充字段组成唯一键');map.set(key,row);
    }return map;
  }
  const a=index(before,'基准结果'),b=index(after,'当前结果'),differences:ResultDifference[]=[];let equal=0;
  const displayKey=(row:DbValue[])=>keyIndexes.map(i=>String(row[i][1])).join(' / ');
  for(const [key,row] of a){const next=b.get(key);if(!next){differences.push({kind:'removed',key:displayKey(row),before:row,fields:names});continue;}
    const fields=names.filter((_,i)=>identity(row[i])!==identity(next[i]));
    if(fields.length)differences.push({kind:'changed',key:displayKey(row),before:row,after:next,fields});else equal++;
  }
  for(const [key,row] of b)if(!a.has(key))differences.push({kind:'added',key:displayKey(row),after:row,fields:names});
  return {differences,equal,names};
}
export function snapshotResult(result:QueryOutcome,source:string,scope:string):ResultSnapshot{
  if(result.rows.length>5000||new TextEncoder().encode(JSON.stringify(result)).byteLength>8*1024*1024)throw Error('对比快照过大，请筛选结果或减少字段后重试');
  return {result:structuredClone(result),source,scope,capturedAt:new Date().toLocaleString()};
}
