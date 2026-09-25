/** Unknown totals stay indeterminate; never invent a percentage for a pending query. */
export function progressDisplay(processed?:number,total?:number|null){
 const count=Number.isFinite(processed)?Math.max(0,processed!):0;
 if(!Number.isFinite(total)||!total||total<=0)return {value:undefined,percent:undefined,text:count?`已处理 ${count.toLocaleString()} · 总量未知`:'等待进度'};
 const value=Math.min(1,count/total),percent=Math.floor(value*100);
 return {value,percent,text:`${count.toLocaleString()} / ${total.toLocaleString()} · ${percent}%`};
}
