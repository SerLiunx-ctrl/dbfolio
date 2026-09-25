import type {DbValue, QueryOutcome} from '../../ipc/types';

export type ChartKind='bar'|'horizontal'|'line'|'area'|'pie'|'donut'|'scatter'|'histogram'|'kpi';
export type Aggregate='sum'|'avg'|'count'|'min'|'max';
export interface ChartConfig {kind:ChartKind;x:string;y:string;series:string;aggregate:Aggregate;sort:'source'|'asc'|'desc';top:number;bins:number;}
export interface AnalysisTable {table:string;schema:string;}
export interface AnalysisLookup extends AnalysisTable {field:string;key:string;label:string;}
export interface AnalysisPlan {version:1;id:string;name:string;sessionId:string;database:string;source:'sql'|'mongo';collection:string;query:string;parameters:Record<string,{type:'text'|'number'|'date'|'null';value:string}>;chart:ChartConfig;metadataSource?:AnalysisTable;lookup?:AnalysisLookup;}
export interface AnalysisColumn {id:string;name:string;type:string;numeric:boolean;comment?:string;}
export type Scalar=string|number|boolean|null;
export interface Dataset {columns:AnalysisColumn[];rows:Scalar[][];scope:string;capturedAt:string;warnings:string[];}
export const defaultChart:ChartConfig={kind:'bar',x:'',y:'',series:'',aggregate:'sum',sort:'source',top:30,bins:10};
export const chartNames:Record<ChartKind,string>={bar:'柱状图',horizontal:'条形图',line:'折线图',area:'面积图',pie:'饼图',donut:'环形图',scatter:'散点图',histogram:'直方图',kpi:'指标卡'};
export function newPlan(sessionId:string,database:string,source:'sql'|'mongo'='sql'):AnalysisPlan{return {version:1,id:crypto.randomUUID(),name:'新分析',sessionId,database,source,collection:'',query:source==='sql'?'SELECT 1 AS value':'[{"$match":{}},{"$limit":100}]',parameters:{},chart:{...defaultChart}};}
export function validatePlan(v:unknown):AnalysisPlan {
 const p=v as AnalysisPlan,c=p?.chart;
 if(!p||p.version!==1||!['sql','mongo'].includes(p.source)||!['id','name','sessionId','database','collection','query'].every(k=>typeof (p as unknown as Record<string,unknown>)[k]==='string')||p.query.length>200000||!p.name.trim()||p.name.length>120||!c||!Object.prototype.hasOwnProperty.call(chartNames,c.kind)||!['sum','avg','count','min','max'].includes(c.aggregate)||!['source','asc','desc'].includes(c.sort)||!['x','y','series'].every(k=>typeof (c as unknown as Record<string,unknown>)[k]==='string')||!Number.isInteger(c.top)||c.top<1||c.top>200||!Number.isInteger(c.bins)||c.bins<2||c.bins>100)throw Error('分析方案格式无效');
 if(!p.parameters||Array.isArray(p.parameters)||typeof p.parameters!=='object'||Object.keys(p.parameters).length>100||Object.values(p.parameters).some(v=>!v||!['text','number','date','null'].includes(v.type)||typeof v.value!=='string'))throw Error('分析参数格式无效');
 const table=(v:AnalysisTable)=>{if(!v||typeof v.table!=='string'||typeof v.schema!=='string'||v.table.length>512||v.schema.length>512)throw Error('分析关联表格式无效');return {table:v.table,schema:v.schema};};
 const metadataSource=p.metadataSource?table(p.metadataSource):undefined;
 let lookup:AnalysisLookup|undefined;
 if(p.lookup){const t=table(p.lookup);if(!['field','key','label'].every(k=>typeof (p.lookup as unknown as Record<string,unknown>)[k]==='string'&&String((p.lookup as unknown as Record<string,unknown>)[k]).length<=2048))throw Error('分析名称关联格式无效');lookup={...t,field:p.lookup.field,key:p.lookup.key,label:p.lookup.label};}
 // Only the explicit schema is stored. Results and connection credentials never enter a plan.
 return {version:1,id:p.id,name:p.name.trim(),sessionId:p.sessionId,database:p.database,source:p.source,collection:p.collection,query:p.query,parameters:Object.fromEntries(Object.entries(p.parameters).map(([k,v])=>[k,{type:v.type,value:v.value}])),chart:{kind:c.kind,x:c.x,y:c.y,series:c.series,aggregate:c.aggregate,sort:c.sort,top:c.top,bins:c.bins},...(metadataSource?{metadataSource}:{}),...(lookup?{lookup}:{})};
}
export function numeric(value:Scalar):number|null {
 if(typeof value==='boolean'||value===null||value==='')return null;
 if(typeof value==='string'&&!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value))return null;
 const n=Number(value);return Number.isFinite(n)&&Math.abs(n)<=Number.MAX_SAFE_INTEGER?n:null;
}
function sqlCell(cell:DbValue):Scalar {const [tag,v]=cell;if(tag==='null'||['int','uint'].includes(tag)&&typeof v==='number'&&!Number.isSafeInteger(v))return null;if(['trunc','readonly','bytes'].includes(tag))return null;if(typeof v==='string'||typeof v==='boolean'||typeof v==='number')return v;return JSON.stringify(v)??null;}
export function queryResultScope(count:number,offset:number,pageSize:number):string {
 return offset>0||count>=pageSize?`当前查询页 · 第 ${offset+1}–${offset+count} 行`:`查询结果 · ${count} 行`;
}
export function fromSql(result:QueryOutcome,scope:string):Dataset {
 const warnings:string[]=[];if(result.rows.some(r=>r.some(([tag,v])=>["int","uint"].includes(tag)&&typeof v==="number"&&!Number.isSafeInteger(v))))warnings.push("当前查询页中部分整数已超出 JavaScript 安全范围，按缺失值处理；重新执行分析可保留其完整文本。");if(result.rows.some(r=>r.some(c=>['trunc','readonly','bytes'].includes(c[0]))))warnings.push('截断、只读扩展类型和二进制单元格不参与分析，按缺失值处理。');
 const occurrences=new Map<string,number>();
 const columns=result.columns.map((c,i)=>{const occurrence=occurrences.get(c.name)??0;occurrences.set(c.name,occurrence+1);return {id:JSON.stringify([c.name,occurrence]),name:c.name,type:c.rawType,numeric:/^(tinyint|smallint|mediumint|int|integer|bigint|int[248]|float[48]?|double|real|decimal|numeric|number|money|smallmoney)\b/i.test(c.rawType)||result.rows.some(r=>['int','uint','float','decimal'].includes(r[i]?.[0]))};});
 return finish({columns,rows:result.rows.map(r=>r.map(sqlCell)),scope,capturedAt:new Date().toISOString(),warnings});
}
function mongoScalar(v:unknown):Scalar|undefined {
 if(v===null||typeof v==='string'||typeof v==='boolean'||typeof v==='number')return v;
 if(!v||typeof v!=='object')return undefined;
 const o=v as Record<string,unknown>;
 for(const key of ['$numberInt','$numberLong','$numberDouble','$numberDecimal','$oid'])if(typeof o[key]==='string')return o[key] as string;
 if('$date' in o){const d=o.$date;const n=typeof d==='object'&&d?Number((d as Record<string,string>).$numberLong):NaN;return Number.isFinite(n)&&Number.isFinite(new Date(n).getTime())?new Date(n).toISOString():String(d);}
 if(Array.isArray(v))return JSON.stringify(v);return undefined;
}
export function fromMongo(docs:unknown[],scope:string):Dataset {
 const paths=new Map<string,{name:string;numeric:boolean}>();
 const flattened=docs.map(doc=>{const row=new Map<string,Scalar>();const walk=(v:unknown,path:string[],depth:number)=>{
  const scalar=mongoScalar(v);if(scalar!==undefined||depth>=8){const id=JSON.stringify(path);if(!paths.has(id)&&paths.size>=200)return;const n=typeof v==='number'||!!v&&typeof v==='object'&&Object.keys(v).some(k=>k.startsWith('$number'));paths.set(id,{name:path.join('.')||'值',numeric:paths.get(id)?.numeric===true||n});row.set(id,scalar===undefined?JSON.stringify(v):scalar);return;}
  if(v&&typeof v==='object')for(const [k,value] of Object.entries(v))walk(value,[...path,k],depth+1);
 };walk(doc,[],0);return row;});
 const columns=[...paths].map(([id,c])=>({id,...c,type:c.numeric?'number':'text'}));
 return finish({columns,rows:flattened.map(r=>columns.map(c=>r.get(c.id)??null)),scope,capturedAt:new Date().toISOString(),warnings:['嵌套字段展开至 8 层、最多 200 个字段；数组作为文本。数值转换仅用于绘图，原始值保留。']});
}
function finish(data:Dataset){if(data.rows.length>=5000)data.warnings.push("数据量较大，分析和绘图可能需要较长时间。");if(data.columns.some((c,i)=>c.numeric&&data.rows.some(r=>r[i]!==null&&numeric(r[i])===null)))data.warnings.push('部分数值超出安全范围或不是有限数，已排除绘图，请检查数据页原始字段。');if(data.columns.some(c=>c.numeric))data.warnings.push('图表和统计使用浮点近似值，不用于精确财务核算。');return data;}
export function autoChart(data:Dataset):ChartConfig {return {...defaultChart,x:data.columns.find(c=>!c.numeric)?.id??data.columns[0]?.id??'',y:data.columns.find(c=>c.numeric)?.id??'',aggregate:data.columns.some(c=>c.numeric)?'sum':'count'};}
export interface Point {category:string;series:string;value:number|null;}
export interface ChartData {points:Point[];scatter:number[][];warnings:string[];}
export function aggregate(data:Dataset,c:ChartConfig):ChartData {
 const xi=data.columns.findIndex(v=>v.id===c.x),yi=data.columns.findIndex(v=>v.id===c.y),si=['bar','horizontal','line','area'].includes(c.kind)?data.columns.findIndex(v=>v.id===c.series):-1;
 const warnings:string[]=[];const output:ChartData={points:[],scatter:[],warnings};
 if(c.kind==='scatter'){for(const r of data.rows){const x=numeric(r[xi]??null),y=numeric(r[yi]??null);if(x!==null&&y!==null)output.scatter.push([x,y]);}return output;}
 if(c.kind==='histogram'){
  const values=data.rows.map(r=>numeric(r[yi]??null)).filter((v):v is number=>v!==null);if(!values.length)return output;
  const min=Math.min(...values),max=Math.max(...values),bins=min===max?1:c.bins,step=(max-min)/bins;
  const counts=Array(bins).fill(0) as number[];for(const v of values)counts[step===0?0:Math.min(bins-1,Math.floor((v-min)/step))]++;
  output.points=counts.map((count,i)=>({category:step===0?String(min):`${(min+i*step).toPrecision(5)} – ${(min+(i+1)*step).toPrecision(5)}`,series:'频数',value:count}));return output;
 }
 const labeler=()=>{const labels=new Map<string,string>(),used=new Set<string>();return (value:Scalar|undefined)=>{value=value??null;const key=JSON.stringify([typeof value,value]);if(labels.has(key))return labels.get(key)!;const base=value===null?'（空值）':String(value);let label=base,index=2;while(used.has(label))label=base+' ['+(index++)+']';used.add(label);labels.set(key,label);return label;};};
 const categoryLabel=labeler(),seriesLabel=labeler();
 const groups=new Map<string,{category:string;series:string;count:number;sum:number;min:number;max:number}>();
 for(const row of data.rows){const category=c.kind==='kpi'?'指标':categoryLabel(row[xi]);const series=si<0?'值':seriesLabel(row[si]);const key=JSON.stringify([category,series]);let g=groups.get(key);if(!g){g={category,series,count:0,sum:0,min:Infinity,max:-Infinity};groups.set(key,g);}const n=c.aggregate==='count'?1:numeric(row[yi]??null);if(n!==null){g.count++;g.sum+=n;g.min=Math.min(g.min,n);g.max=Math.max(g.max,n);}}
 let points=[...groups.values()].map(g=>({category:g.category,series:g.series,value:c.aggregate==='count'?g.count:g.count===0?null:c.aggregate==='avg'?g.sum/g.count:c.aggregate==='min'?g.min:c.aggregate==='max'?g.max:g.sum}));
 if(points.some(p=>p.value!==null&&!Number.isFinite(p.value))){warnings.push('聚合值溢出，已排除。');points=points.map(p=>({...p,value:p.value!==null&&Number.isFinite(p.value)?p.value:null}));}
 const totals=new Map<string,number>();for(const p of points)totals.set(p.category,(totals.get(p.category)??0)+(p.value??0));
 let categories=[...totals.keys()];if(c.sort!=='source')categories.sort((a,b)=>(totals.get(a)!-totals.get(b)!)*(c.sort==='asc'?1:-1));
 if(categories.length>c.top)warnings.push(`仅显示 ${c.top} / ${categories.length} 个分类，未显示分类未合并。`);categories=categories.slice(0,c.top);
 const series=[...new Set(points.map(p=>p.series))];if(series.length>12)warnings.push(`仅显示前 12 / ${series.length} 个系列。`);
 output.points=categories.flatMap(cat=>points.filter(p=>p.category===cat&&series.slice(0,12).includes(p.series)));return output;
}
export function profile(data:Dataset){return data.columns.map((col,i)=>{const values=data.rows.map(r=>r[i]);const present=values.filter(v=>v!==null);const nums=col.numeric?present.map(numeric).filter((v):v is number=>v!==null):[];return {name:col.name,type:col.type,rows:values.length,missing:values.length-present.length,distinct:new Set(present.map(v=>JSON.stringify(v))).size,numeric:nums.length,min:nums.length?Math.min(...nums):null,max:nums.length?Math.max(...nums):null,avg:nums.length?nums.reduce((a,b)=>a+b/nums.length,0):null};});}
export function csv(headers:string[],rows:Scalar[][]){const quote=(v:Scalar)=>{let s=v===null?'':String(v);if(typeof v!=='number'&&/^[\s]*[=+\-@\t\r]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';};return '\ufeff'+[headers,...rows].map(r=>r.map(quote).join(',')).join('\r\n');}
