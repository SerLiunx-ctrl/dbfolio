import {formatDbValue,type DbValue} from '../../ipc/types';
export interface FilterValueChoice {key:string;text:string;value:DbValue;disabled:boolean;count:number}
export function loadedFilterValues(rows:DbValue[][],columnIndex:number):FilterValueChoice[]{
 const values=new Map<string,FilterValueChoice>();
 for(const row of rows){
  const value=row[columnIndex];if(!value)continue;
  const key=JSON.stringify(value);
  const existing=values.get(key);
  if(existing){existing.count++;continue;}
  values.set(key,{key,text:formatDbValue(value),value,disabled:['trunc','readonly','bytes'].includes(value[0]),count:1});
 }
 return [...values.values()];
}
