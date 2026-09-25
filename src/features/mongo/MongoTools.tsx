import {InfoHint} from '../../common/InfoHint';
import { openAnalysis } from "../analysis/AnalysisWorkspace";
import {newPlan,fromMongo,autoChart} from "../analysis/model";
import {useState} from "react";
import {Button,Dialog,DialogSurface,DialogBody,DialogTitle,DialogContent,DialogActions,Field,Select,Spinner} from "@fluentui/react-components";
import {open,save} from "@tauri-apps/plugin-dialog";
import {trackedInvoke} from "../../ipc/taskInvoke";
import {normalizeError} from "../../ipc";
import type {MongoTab} from "../../stores/useTabStore";

type Mode="stats"|"indexes"|"sample"|"aggregate"|"transfer";
const names:Record<Mode,string>={stats:"集合统计",indexes:"索引",sample:"字段抽样",aggregate:"聚合管道",transfer:"导入导出"};
const labels:Record<string,string>={ns:"集合",count:"文档数（估计）",size:"数据大小（字节）",avgObjSize:"平均文档大小（字节）",storageSize:"存储大小（字节）",totalIndexSize:"索引大小（字节）",nindexes:"索引数",capped:"固定大小集合"};
type Result={rows?:unknown[];limited?:boolean;note?:string;indexes?:{key:unknown;name?:string;unique?:boolean;expireAfterSeconds?:number}[];sampled?:number;fields?:Record<string,Record<string,number>>;[key:string]:unknown};
export function MongoTools({tab,readOnly,filter,disabled}:{tab:MongoTab;readOnly:boolean;filter:string;disabled:boolean}) {
 const [opened,setOpened]=useState(false),[mode,setMode]=useState<Mode>("stats"),[busy,setBusy]=useState(false),[error,setError]=useState("");
 const [result,setResult]=useState<Result|null>(null),[pipeline,setPipeline]=useState('[\n  { "$match": {} },\n  { "$limit": 100 }\n]');
 const [executedPipeline,setExecutedPipeline]=useState(pipeline);
 const [index,setIndex]=useState('{\n  "keys": { "createdAt": 1 },\n  "options": { "name": "createdAt_1" }\n}');
 const [format,setFormat]=useState("jsonl"),[direction,setDirection]=useState("export"),[path,setPath]=useState("");
 const [confirm,setConfirm]=useState<"index"|"import"|null>(null);
 const args={sessionId:tab.sessionId,database:tab.database,collection:tab.collection};
 const work=async(fn:()=>Promise<Result>)=>{setBusy(true);setError("");setResult(null);try{setResult(await fn());}catch(e){setError(normalizeError(e).message);}finally{setBusy(false);}};
 const inspect=()=>work(async()=>{const value=await trackedInvoke<Result>("mongo_inspect",{...args,operation:mode,text:mode==="aggregate"?pipeline:"{}"});if(mode==="aggregate")setExecutedPipeline(pipeline);return value;});
 const transfer=()=>work(()=>trackedInvoke<Result>("mongo_transfer",{sessionId:tab.sessionId,request:{database:tab.database,collection:tab.collection,path,direction,format,filter}}));
 const pick=async()=>{try{const options={filters:[{name:format==="jsonl"?"JSON Lines":"Extended JSON 数组",extensions:[format]}]};const selected=direction==="import"?await open({...options,multiple:false}):await save({...options,defaultPath:`${tab.collection}.${format}`});if(typeof selected==="string")setPath(selected);}catch(e){setError(normalizeError(e).message);}};
 return <><Button disabled={disabled} onClick={()=>setOpened(true)}>集合工具</Button><Dialog open={opened} onOpenChange={(_,d)=>setOpened(d.open)}><DialogSurface className="dw-mongo-tools"><DialogBody><DialogTitle>{tab.database}.{tab.collection} · 集合工具</DialogTitle><DialogContent className="dw-mongo-tool-content">
 <nav className="dw-mongo-tool-tabs">{(Object.keys(names) as Mode[]).map(m=><Button key={m} appearance={mode===m?"primary":"subtle"} disabled={busy} onClick={()=>{setMode(m);setResult(null);setError("");}}>{names[m]}</Button>)}</nav>
 {mode==="aggregate"&&<Field label="只读聚合管道（Extended JSON 数组）"><textarea spellCheck={false} value={pipeline} disabled={busy} onChange={e=>setPipeline(e.target.value)}/><InfoHint label="聚合管道说明">支持匹配、分组、排序、关联和分面等阶段；不支持写入阶段或服务端脚本。最多展示 500 条 / 8 MiB。</InfoHint></Field>}
 {mode==="sample"&&<InfoHint label="字段抽样说明">读取自然顺序前 100 条文档，统计顶层字段类型、出现次数及缺失次数。抽样不代表完整结构。</InfoHint>}
 {mode==="stats"&&<InfoHint label="集合统计说明">由服务器返回集合统计；文档数为统计值，空间单位为字节。</InfoHint>}
 {mode!=="transfer"&&<Button disabled={busy} onClick={()=>void inspect()}>{mode==="aggregate"?"执行聚合":"读取 / 刷新"}</Button>}
 {mode==="indexes"&&<details><summary>创建索引</summary><InfoHint label="索引参数说明">按 keys 中字段顺序建立复合索引；options 可指定 name、unique、sparse、expireAfterSeconds 等。TTL 索引可能自动删除过期数据。</InfoHint><Field label="索引定义"><textarea value={index} disabled={busy||readOnly} onChange={e=>setIndex(e.target.value)}/></Field><Button disabled={busy||readOnly} onClick={()=>setConfirm("index")}>预览并创建</Button></details>}
 {mode==="transfer"&&<><div className="dw-mongo-transfer-options"><Field label="方向"><Select value={direction} disabled={busy} onChange={(_,d)=>{setDirection(d.value);setPath("");setResult(null);}}><option value="export">导出</option><option value="import" disabled={readOnly}>导入（仅新增）</option></Select></Field><Field label="文件格式"><Select value={format} disabled={busy} onChange={(_,d)=>{setFormat(d.value);setPath("");}}><option value="jsonl">JSON Lines（逐行流式）</option><option value="json">Extended JSON 数组</option></Select></Field></div>
 <p>{direction==="export"?"按文档浏览页当前 Filter 导出全部匹配文档，忽略投影和浏览条数上限。文件采用 Canonical Extended JSON；成功后替换目标文件。":"导入仅插入，不覆盖已有 _id。失败记录保存到源文件同目录；取消后已写入数据保留。JSON 数组上限 64 MiB，大文件请选择 JSON Lines。"}</p>
 {direction==="export"&&<pre>Filter: {filter}</pre>}<Button disabled={busy} onClick={()=>void pick()}>选择文件</Button><p className="dw-mongo-file-path">{path||"尚未选择文件"}</p><Button appearance="primary" disabled={busy||!path||(direction==="import"&&readOnly)} onClick={()=>direction==="import"?setConfirm("import"):void transfer()}>{direction==="import"?"预览并导入":"开始导出"}</Button><InfoHint label="传输任务说明">进度和取消入口位于底部「任务中心」。单条写入发出后等待结果，取消会停止后续文档。</InfoHint></>}
 {busy&&<Spinner size="small" label="处理中，可在任务中心查看进度"/>}{error&&<p role="alert" className="dw-mongo-error">{error}</p>}
 {result&&<section className="dw-mongo-tool-result">
 {result.note&&<p>{result.note}</p>}{result.limited&&<p role="status">结果已达到预览上限，请增加筛选或缩小管道结果。</p>}
 {mode==="stats"?<dl>{Object.entries(result).map(([key,value])=><div key={key}><dt>{labels[key]||key}</dt><dd>{String(value)}</dd></div>)}</dl>:
 mode==="indexes"&&result.indexes?<table><thead><tr><th>名称</th><th>键与顺序</th><th>唯一</th><th>TTL 秒</th></tr></thead><tbody>{result.indexes.map((i,n)=><tr key={n}><td>{i.name}</td><td><code>{JSON.stringify(i.key)}</code></td><td>{i.unique?"是":"否"}</td><td>{i.expireAfterSeconds??"—"}</td></tr>)}</tbody></table>:
 mode==="sample"&&result.fields?<><p>抽样 {result.sampled} 条</p><table><thead><tr><th>字段</th><th>类型与次数</th><th>缺失次数</th></tr></thead><tbody>{Object.entries(result.fields).map(([key,types])=><tr key={key}><td>{key}</td><td>{Object.entries(types).map(([type,count])=>`${type}: ${count}`).join("，")}</td><td>{(result.sampled??0)-Object.values(types).reduce((a,b)=>a+b,0)}</td></tr>)}</tbody></table></>:
 mode==="aggregate"?<><Button onClick={()=>{const data=fromMongo(result.rows??[],result.limited?"MongoDB 受限聚合结果 · 最多 500 条 / 8 MiB":"MongoDB 当前聚合结果 · "+(result.rows?.length??0)+" 条");const plan=newPlan(tab.sessionId,tab.database,"mongo");plan.collection=tab.collection;plan.query=executedPipeline;plan.name=tab.collection+" 分析";plan.chart=autoChart(data);setOpened(false);openAnalysis(plan,data);}} title="将本次聚合结果带入独立分析页，不建立联动">用此结果绘图</Button><p>返回 {result.rows?.length??0} 条 · 只读结果</p>{result.rows?.map((row,i)=><details key={i}><summary>结果 {i+1}</summary><pre>{JSON.stringify(row,null,2)}</pre></details>)}</>:
 <>{result.index?<p>索引已创建：{String(result.index)}。点击读取 / 刷新查看列表。</p>:<p>{direction==="import"?`已写入 ${result.inserted??0} 条，失败 ${result.skipped??0} 条`:`已导出 ${result.rows??0} 条`}</p>}<pre>{JSON.stringify(result,null,2)}</pre></>}
 </section>}
 </DialogContent><DialogActions><Button onClick={()=>setOpened(false)}>{busy?"收起（后台继续，可在任务中心取消）":"关闭"}</Button></DialogActions></DialogBody></DialogSurface></Dialog>
 <Dialog open={confirm!==null} onOpenChange={(_,d)=>{if(!d.open)setConfirm(null);}}><DialogSurface><DialogBody><DialogTitle>{confirm==="index"?"确认创建索引":"确认导入文档"}</DialogTitle><DialogContent><p>目标：{tab.database}.{tab.collection}</p><pre>{confirm==="index"?index:path}</pre><p>{confirm==="index"?"索引会占用存储并影响写入；TTL 选项会使服务器自动删除过期文档。":"逐条插入，重复键记为失败；已写入的文档不会因取消或后续失败自动撤销。"}</p></DialogContent><DialogActions><Button onClick={()=>setConfirm(null)}>取消</Button><Button appearance="primary" disabled={readOnly||busy} onClick={()=>{if(readOnly)return;const kind=confirm;setConfirm(null);if(kind==="index")void work(()=>trackedInvoke<Result>("mongo_create_index",{...args,text:index}));else void transfer();}}>确认执行</Button></DialogActions></DialogBody></DialogSurface></Dialog></>;
}
