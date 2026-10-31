import type {TableMeta, TableRef} from '../../ipc/types';

export const MAX_TABLES=80, CARD_WIDTH=292, ROW_HEIGHT=25;
export type Point={x:number;y:number};
export type ErTable={key:string;database:string;name:string;schema?:string|null;meta?:TableMeta;error?:string};
export type Relation={id:string;name:string;from:string;to:string;columns:string[];refColumns:string[];manual:boolean;onDelete?:string;onUpdate?:string;source?:'ai';confidence?:'high'|'medium'|'low';reason?:string;warnings?:string[]};
export type Layout={version:1;positions:Record<string,Point>;visible:string[];expanded:string[];manual:Relation[];mode:'compact'|'full'|'names';comments:boolean;onlyRelated:boolean;view:{x:number;y:number;zoom:number}};
export const tableKey=(database:string,schema:string|null|undefined,name:string)=>JSON.stringify([database,schema??null,name]);
export const refTable=(database:string,t:TableRef):ErTable=>({key:tableKey(database,t.schema,t.name),database,schema:t.schema,name:t.name});
export const emptyLayout=():Layout=>({version:1,positions:{},visible:[],expanded:[],manual:[],mode:'compact',comments:true,onlyRelated:false,view:{x:24,y:24,zoom:1}});
const finite=(x:unknown)=>typeof x==='number'&&Number.isFinite(x)&&Math.abs(x)<=100000;
export function parseLayout(raw:string):Layout {
 const v=JSON.parse(raw);if(v?.version!==1||!Array.isArray(v.visible)||!Array.isArray(v.expanded)||!Array.isArray(v.manual)||v.manual.length>500)throw Error('关系图布局格式无效');
 const a=emptyLayout();a.visible=v.visible.filter((x:unknown)=>typeof x==='string').slice(0,MAX_TABLES);a.expanded=v.expanded.filter((x:unknown)=>typeof x==='string').slice(0,MAX_TABLES);
 for(const [key,p] of Object.entries(v.positions??{}) as [string,Point][])if(finite(p?.x)&&finite(p?.y))a.positions[key]={x:p.x,y:p.y};
 if(['compact','full','names'].includes(v.mode))a.mode=v.mode;a.comments=v.comments!==false;a.onlyRelated=v.onlyRelated===true;
 if(finite(v.view?.x)&&finite(v.view?.y)&&finite(v.view?.zoom))a.view={x:v.view.x,y:v.view.y,zoom:Math.min(4,Math.max(.05,v.view.zoom))};
 a.manual=v.manual.filter((r:Relation)=>r&&typeof r.id==='string'&&typeof r.name==='string'&&typeof r.from==='string'&&typeof r.to==='string'&&Array.isArray(r.columns)&&r.columns.length>0&&r.columns.length<=32&&r.columns.every(c=>typeof c==='string')&&Array.isArray(r.refColumns)&&r.refColumns.length===r.columns.length&&r.refColumns.every(c=>typeof c==='string')).map((r:Relation)=>({id:r.id,name:r.name,from:r.from,to:r.to,columns:r.columns,refColumns:r.refColumns,manual:true,...(r.source==='ai'?{source:'ai' as const,confidence:['high','medium','low'].includes(r.confidence??'')?r.confidence:undefined,reason:typeof r.reason==='string'?r.reason.slice(0,4000):undefined,warnings:Array.isArray(r.warnings)?r.warnings.filter(w=>typeof w==='string').slice(0,10).map(w=>w.slice(0,2000)):[]}: {})}));return a;
}
export function relations(tables:ErTable[],manual:Relation[],caseInsensitive=false):Relation[]{
 const byKey=new Map(tables.map(t=>[t.key,t]));const result:Relation[]=[];
 for(const t of tables)for(const [i,f] of (t.meta?.foreignKeys??[]).entries()){
  let to=tableKey(f.refDatabase??t.database,f.refSchema??t.schema,f.refTable);if(caseInsensitive&&!byKey.has(to)){const matches=tables.filter(v=>v.database.toLowerCase()===(f.refDatabase??t.database).toLowerCase()&&(v.schema??'').toLowerCase()===(f.refSchema??t.schema??'').toLowerCase()&&v.name.toLowerCase()===f.refTable.toLowerCase());if(matches.length===1)to=matches[0].key;}const target=byKey.get(to);
  const refs=f.refColumns.map((c,i)=>c||target?.meta?.primaryKey[i]||'');
  result.push({id:JSON.stringify([t.key,f.name,i]),name:f.name,from:t.key,to,columns:f.columns,refColumns:refs,manual:false,onDelete:f.onDelete,onUpdate:f.onUpdate});
 }
 return [...result,...manual];
}
export function missingTargets(tables:ErTable[],edges:Relation[]):ErTable[]{
 const known=new Set(tables.map(t=>t.key));const result:ErTable[]=[];
 for(const e of edges)if(!known.has(e.to)){try{const [database,schema,name]=JSON.parse(e.to);if(typeof database==='string'&&typeof name==='string'){result.push({key:e.to,database,schema,name,error:'引用表未加载或不在当前范围'});known.add(e.to);}}catch{/* 损坏的本地标注不生成目标。 */}}
 return result;
}
export function displayedColumns(t:ErTable,edges:Relation[],layout:Layout){
 if(layout.mode==='names')return [];const columns=t.meta?.columns??[];
 if(layout.mode==='full'||layout.expanded.includes(t.key))return columns;
 const linked=new Set(edges.flatMap(e=>[...(e.from===t.key?e.columns:[]),...(e.to===t.key?e.refColumns:[])]));
 return columns.filter((c,i)=>i<4||t.meta?.primaryKey.includes(c.name)||linked.has(c.name));
}
export function cardHeight(t:ErTable,edges:Relation[],layout:Layout){return 42+(layout.comments&&t.meta?.comment?24:0)+displayedColumns(t,edges,layout).length*ROW_HEIGHT+28;}
// 按无向关联分组，再按邻接顺序排布；循环和自引用不会导致递归或无限遍历。
export function autoLayout(tables:ErTable[],edges:Relation[],layout:Layout):Record<string,Point>{
 const known=new Set(tables.map(t=>t.key)),adj=new Map(tables.map(t=>[t.key,[] as string[]]));for(const e of edges)if(known.has(e.from)&&known.has(e.to)&&e.from!==e.to){adj.get(e.from)!.push(e.to);adj.get(e.to)!.push(e.from);}
 const result:Record<string,Point>={},seen=new Set<string>(),order:string[]=[];
 for(const t of tables){if(seen.has(t.key))continue;const queue=[t.key];seen.add(t.key);for(let i=0;i<queue.length;i++){const key=queue[i];order.push(key);for(const next of adj.get(key)??[])if(!seen.has(next)){seen.add(next);queue.push(next);}}}
 let y=24,height=0;for(const [i,key] of order.entries()){if(i>0&&i%3===0){y+=height+65;height=0;}const t=tables.find(t=>t.key===key)!;result[key]={x:(i%3)*(CARD_WIDTH+110)+24,y};height=Math.max(height,cardHeight(t,edges,layout));}return result;
}
export function relationPath(e:Relation,tables:ErTable[],edges:Relation[],layout:Layout){
 const a=tables.find(t=>t.key===e.from),b=tables.find(t=>t.key===e.to);if(!a||!b)return '';
 const p=layout.positions[a.key],q=layout.positions[b.key];if(!p||!q)return '';
 const y=(t:ErTable,point:Point,column:string)=>{const i=displayedColumns(t,edges,layout).findIndex(c=>c.name===column);return point.y+42+(layout.comments&&t.meta?.comment?24:0)+(i<0?0:i*ROW_HEIGHT+ROW_HEIGHT/2);};
 const ay=y(a,p,e.columns[0]),by=y(b,q,e.refColumns[0]);
 if(a.key===b.key)return `M${p.x+CARD_WIDTH},${ay} C${p.x+CARD_WIDTH+70},${ay-45} ${p.x+CARD_WIDTH+70},${by+75} ${p.x+CARD_WIDTH},${by}`;
 const right=q.x>=p.x,ax=p.x+(right?CARD_WIDTH:0),bx=q.x+(right?0:CARD_WIDTH),offset=Math.max(45,Math.abs(bx-ax)/2)*(right?1:-1);
 return `M${ax},${ay} C${ax+offset},${ay} ${bx-offset},${by} ${bx},${by}`;
}
export function validateManual(r:Relation,tables:ErTable[]){
 const a=tables.find(t=>t.key===r.from),b=tables.find(t=>t.key===r.to);
 if(!r.name.trim()||r.name.length>120)throw Error('请输入 1～120 字的关联名称');
 if(!a?.meta||!b?.meta)throw Error('请先加载关联两端的表');
 if(!r.columns.length||r.columns.length!==r.refColumns.length||r.columns.length>32)throw Error('请添加成对的关联字段');
 if(new Set(r.columns).size!==r.columns.length||new Set(r.refColumns).size!==r.refColumns.length)throw Error('关联字段不能重复');
 if(r.columns.some(c=>!a.meta!.columns.some(v=>v.name===c))||r.refColumns.some(c=>!b.meta!.columns.some(v=>v.name===c)))throw Error('关联字段已不存在，请重新选择');
}
export const xml=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]!)).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g,'');
export function bounds(tables:ErTable[],edges:Relation[],layout:Layout){return {width:Math.max(500,...tables.map(t=>(layout.positions[t.key]?.x??0)+CARD_WIDTH+100)),height:Math.max(300,...tables.map(t=>(layout.positions[t.key]?.y??0)+cardHeight(t,edges,layout)+60))};}
export function exportSvg(tables:ErTable[],edges:Relation[],layout:Layout){
 const {width,height}=bounds(tables,edges,layout),ids=new Set(tables.map(t=>t.key));
 const lines=edges.filter(e=>ids.has(e.from)&&ids.has(e.to)).map(e=>`<path d="${relationPath(e,tables,edges,layout)}" fill="none" stroke="${e.manual?'#8b5bb5':'#4783a8'}" stroke-width="2" marker-end="url(#er-arrow)" ${e.manual?'stroke-dasharray="6 4"':''}/>`).join('');
 const cards=tables.map(t=>{const p=layout.positions[t.key]??{x:24,y:24},cols=displayedColumns(t,edges,layout);let y=42;const comment=layout.comments&&t.meta?.comment?`<text x="12" y="57" fill="#64748b">${xml(t.meta.comment.slice(0,32))}</text>`:'';if(comment)y+=24;
 return `<g transform="translate(${p.x},${p.y})"><title>${xml(t.database+'.'+(t.schema?t.schema+'.':'')+t.name)}</title><rect width="${CARD_WIDTH}" height="${cardHeight(t,edges,layout)}" rx="5" fill="#fff" stroke="#94a3b8"/><text x="12" y="25" font-weight="600">${xml((t.database+'.'+(t.schema?t.schema+'.':'')+t.name).slice(0,35))}</text>${comment}${cols.map((c,i)=>`<svg x="12" y="${y+i*ROW_HEIGHT}" width="155" height="25" overflow="hidden"><text y="17">${xml((t.meta?.primaryKey.includes(c.name)?'PK ':'')+c.name)}</text></svg><text x="175" y="${y+i*ROW_HEIGHT+17}" fill="#64748b">${xml(c.rawType.slice(0,15))}</text>`).join('')}${t.error?`<text x="12" y="${y+18}" fill="#b45309">元数据未加载</text>`:''}</g>`;}).join('');
 return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img"><title>ER 关系图：实线为外键，虚线为业务关联</title><defs><marker id="er-arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10Z" fill="#4783a8"/></marker></defs><rect width="100%" height="100%" fill="#f8fafc"/><g font-family="Segoe UI,Microsoft YaHei,sans-serif" font-size="12" fill="#1e293b">${lines}${cards}</g></svg>`;
}
export function exportMermaid(tables:ErTable[],edges:Relation[]){
 const ids=new Map(tables.map((t,i)=>[t.key,'T'+i]));
 const clean=(s:string)=>s.slice(0,500).replace(/[\r\n]/g,' ').replace(/[\"&<>|#]/g,c=>'#'+c.charCodeAt(0)+';')||'_';
 const entities=tables.map(t=>'  '+ids.get(t.key)+'["'+clean(t.database+'.'+(t.schema?t.schema+'.':'')+t.name)+(t.meta?.columns??[]).map(c=>'<br/>'+clean((t.meta?.primaryKey.includes(c.name)?'PK ':'')+c.name+' · '+c.rawType)).join('')+'"]');
 // 流程图连线仅表达引用方向，不为未知或业务关系虚构基数。
 const links=edges.filter(e=>ids.has(e.from)&&ids.has(e.to)).map(e=>'  '+ids.get(e.from)+(e.manual?' -.->|"':' -->|"')+clean((e.manual?'业务关联 ':'外键 ')+e.name+' '+e.columns.join(',')+' → '+e.refColumns.join(','))+'"| '+ids.get(e.to));
 return ['flowchart LR',...entities,...links,''].join('\n');
}
