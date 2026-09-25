import type {QueryOutcome} from "../../ipc/types";
export interface PlanNode {label:string;table?:string;index?:string;rows?:string;cost?:string;warning?:string;children:PlanNode[];}
export function parsePlan(result:QueryOutcome):{nodes:PlanNode[];raw:unknown}|null {
 const value=result.rows[0]?.[0];
 if(!value||!["text","json"].includes(value[0])||typeof value[1]!=="string")return null;
 let raw:unknown;try{raw=JSON.parse(value[1]);}catch{return null;}
 function walk(v:unknown,depth=0):PlanNode[] {
  if(depth>80||!v||typeof v!=="object")return [];
  if(Array.isArray(v))return v.flatMap(x=>walk(x,depth+1));
  const o=v as Record<string,unknown>;
  const nodeType=o["Node Type"]??o.access_type??o.operation;
  const children=Object.entries(o).filter(([k])=>!["cost_info","used_columns","possible_keys"].includes(k)).flatMap(([,val])=>walk(val,depth+1));
  if(nodeType===undefined)return children;
  const label=String(nodeType), table=o["Relation Name"]??o.table_name, index=o["Index Name"]??o.key;
  const rows=o["Plan Rows"]??o.rows_examined_per_scan??o.estimated_rows;
  const cost=o["Total Cost"]??(o.cost_info as Record<string,unknown>|undefined)?.prefix_cost??o.estimated_total_cost;
  return [{label,table:table==null?undefined:String(table),index:index==null?undefined:String(index),rows:rows==null?undefined:String(rows),cost:cost==null?undefined:String(cost),warning:label==="ALL"||label==="Seq Scan"?"全表扫描；小表可能是合理选择":label==="index"?"全索引扫描":undefined,children}];
 }
 return {nodes:walk(raw),raw};
}
