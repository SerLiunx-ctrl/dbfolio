import {InfoHint} from '../../common/InfoHint';
import {useMemo} from "react";
import type {QueryOutcome} from "../../ipc/types";
import {ResultGrid} from "../grid/ResultGrid";
import {parsePlan,type PlanNode} from "./plan";
function Node({node}:{node:PlanNode}) {
 return <li><details open><summary><strong>{node.label}</strong>{node.table&&<span> · {node.table}</span>}</summary><div className="dw-plan-metrics"><span>索引：{node.index||"—"}</span><span>预估行数：{node.rows??"—"}</span><span>预估成本：{node.cost??"—"}</span></div>{node.warning&&<p className="dw-plan-warning">{node.warning}</p>}{node.children.length>0&&<ul>{node.children.map((child,i)=><Node key={i} node={child}/>)}</ul>}</details></li>;
}
export function ExplainView({result}:{result:QueryOutcome}){
 const parsed=useMemo(()=>parsePlan(result),[result]);
 return <div className="dw-plan-view"><InfoHint label="执行计划说明">仅请求预估计划（未开启 ANALYZE）；行数和成本为优化器估计，成本不等于耗时。</InfoHint>{parsed?<>{parsed.nodes.length?<ul>{parsed.nodes.map((node,i)=><Node key={i} node={node}/>)}</ul>:<p>此计划格式暂未提取节点，请查看原始计划。</p>}<details><summary>原始 JSON 计划</summary><pre>{JSON.stringify(parsed.raw,null,2)}</pre></details></>:<div style={{height:360}}><ResultGrid columns={result.columns} rows={result.rows}/></div>}</div>;
}
