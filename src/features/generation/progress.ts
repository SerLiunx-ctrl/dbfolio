export type GenerationEvent =
 | {kind:'response';snapshot:AiResponse}
 | {kind:'finished'}
 | {kind:'batch';start:number;end:number;total:number}
 | {kind:'delta';text:string}
 | {kind:'validated';number:number;row:Record<string,unknown>}
 | {kind:'progress';count:number;usage:{requests:number;inputTokens:number|null;outputTokens:number|null}}
 | {kind:'rejected';number:number;row:Record<string,unknown>;message:string};
export interface AiResponse {text:string;diagnostic:string;format:string;status:number;receivedBytes:number;contentBytes:number;truncated:boolean}
export interface SavedResponse extends AiResponse {start:number;end:number}
export interface GenerationTrace {
 status:'running'|'success'|'error'|'cancelled';total:number;count:number;start:number;end:number;
 raw:string;characters:number;rows:{number:number;cells:Record<string,string>}[];
 error:string;rejected?:{number:number;json:string};startedAt:number;endedAt?:number;
 usage:{requests:number;inputTokens:number|null;outputTokens:number|null};
 responses:SavedResponse[];evictedResponses:number;
}
export const newTrace=(total:number):GenerationTrace=>({status:'running',total,count:0,start:0,end:0,raw:'',characters:0,rows:[],error:'',startedAt:Date.now(),usage:{requests:0,inputTokens:null,outputTokens:null},responses:[],evictedResponses:0});
export function reduceGenerationEvent(s:GenerationTrace,e:GenerationEvent):GenerationTrace{
 if(s.status!=='running')return s;
 switch(e.kind){
  case 'finished':return s;
  case 'response':{
   const response={...e.snapshot,start:s.start,end:s.end,text:e.snapshot.text.slice(0,2*1024*1024),truncated:e.snapshot.truncated||e.snapshot.text.length>2*1024*1024};
   const responses=[...s.responses,response];let evicted=s.evictedResponses;
   let size=responses.reduce((n,r)=>n+r.text.length+r.diagnostic.length,0);
   while(responses.length>20||size>4*1024*1024){const old=responses.shift()!;size-=old.text.length+old.diagnostic.length;evicted++;}
   return {...s,responses,evictedResponses:evicted};
  }
  case 'batch':return {...s,start:e.start,end:e.end,total:e.total,raw:''};
  case 'delta':return {...s,raw:(s.raw+e.text).slice(-65536),characters:s.characters+e.text.length};
  case 'validated':return {...s,count:Math.max(s.count,e.number),rows:s.rows.length>=100?s.rows:[...s.rows,{number:e.number,cells:Object.fromEntries(Object.entries(e.row).map(([k,v])=>[k,(typeof v==='string'?v:JSON.stringify(v)??'（省略）').slice(0,500)]))}]};
  case 'progress':return {...s,count:e.count,usage:e.usage};
  case 'rejected':return {...s,count:Math.max(s.count,e.number-1),error:e.message,rejected:{number:e.number,json:JSON.stringify(e.row,null,2).slice(0,32768)}};
 }
}
