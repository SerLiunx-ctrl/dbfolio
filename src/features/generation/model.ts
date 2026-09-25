import { trackedInvoke as invoke } from '../../ipc/taskInvoke';
import {Channel} from '@tauri-apps/api/core';
import type {GenerationEvent} from './progress';
import type { Engine } from '../../ipc/types';
export interface Provider { id:string;name:string;baseUrl:string;model:string;outputFormat:'schema'|'json'|'text';tokenParameter:'max_tokens'|'max_completion_tokens';timeoutSeconds:number;maxTokens:number;isDefault:boolean;hasKey:boolean }
export interface Target { sessionId:string;database:string;schema:string|null;object:string;redisKind:string|null;ttlSeconds:number|null }
export interface FieldRule { name:string;kind:string;args:Record<string,unknown>;nullPercent:number;unique:boolean }
export interface AiOptions {stream?:boolean;providerId:string;model:string|null;prompt:string}
export interface Plan {version:1;target:Target;count:number;seed:string;fields:FieldRule[];parameters:Record<string,string>;ai:AiOptions|null}
export interface GenerationField {name:string;rawType:string;kind:string;nullable:boolean;generated:boolean;unique:boolean;defaultValue:string|null;comment:string|null}
export interface Description {engine:Engine;fields:GenerationField[];fingerprint:string;warnings:string[];writeSupported:boolean}
export interface Usage {inputTokens:number|null;outputTokens:number|null;requests:number}
export interface Preview {id:string;count:number;offset:number;rows:Record<string,unknown>[];bytes:number;usage:Usage;status:'ready'|'writing'|'consumed';warnings:string[]}
export interface WriteReport {inserted:number;failed:number;unattempted:number;uncertain:number;cancelled:boolean;error:string|null}
export interface Template {version:1;id:string;name:string;engine:Engine;fields:FieldRule[];count:number;seed:string;parameters:Record<string,string>;redisKind:string|null;ttlSeconds:number|null}
export const generationApi={
 providers:()=>invoke<Provider[]>('ai_providers'),
 saveProvider:(provider:Provider,key:string|null)=>invoke<Provider[]>('ai_save',{provider,key}),
 removeProvider:(id:string)=>invoke<Provider[]>('ai_remove',{id}),
 models:(provider:Provider,key:string|null)=>invoke<string[]>('ai_models',{provider,key}),
 test:(provider:Provider,key:string|null)=>invoke<{usage:Usage}>('ai_test',{provider,key}),
 describe:(target:Target)=>invoke<Description>('generation_describe',{target}),
 generate:async(plan:Plan,onEvent?:(event:GenerationEvent)=>void)=>{
  const channel=new Channel<GenerationEvent>();let complete!:()=>void;
  const finished=new Promise<void>(resolve=>{complete=resolve;});
  channel.onmessage=e=>{if(e.kind==='finished')complete();else onEvent?.(e);};
  try{return await invoke<Preview>('generation_generate',{plan,onEvent:channel});}
  finally{
   // Channel payloads may arrive after the command result; drain them before freezing the UI state.
   let timer:ReturnType<typeof setTimeout>|undefined;
   await Promise.race([finished,new Promise<void>(resolve=>{timer=setTimeout(resolve,1500);})]);
   if(timer)clearTimeout(timer);
  }
 },
 preview:(id:string,offset:number)=>invoke<Preview>('generation_preview',{id,offset}),
 release:(id:string)=>invoke<void>('generation_release',{id}),
 write:(id:string,sessionId:string)=>invoke<WriteReport>('generation_write',{id,sessionId}),
 export:(id:string,path:string,format:string,sessionId:string)=>invoke<{rows:number}>('generation_export',{id,path,format,sessionId}),
 suggest:(target:Target,options:AiOptions)=>invoke<{fields:FieldRule[];usage:Usage}>('generation_suggest',{target,options}),
 readTemplate:(path:string)=>invoke<string>('generation_template_read',{path}),
 writeTemplate:(path:string,text:string)=>invoke<void>('generation_template_write',{path,text}),
};
export const RULES:Record<string,{label:string;args:Record<string,unknown>;help?:string}>={
 omit:{label:'数据库默认值 / 省略',args:{}},null:{label:'空值 NULL',args:{}},constant:{label:'固定值 / JSON',args:{value:'示例'}},
 sequence:{label:'递增序列',args:{start:'1',step:'1'}},integer:{label:'随机整数',args:{min:'1',max:'100'}},decimal:{label:'随机小数',args:{min:'0',max:'100',scale:2}},
 boolean:{label:'随机布尔值',args:{}},choice:{label:'候选值随机抽取',args:{values:['A','B','C']}},text:{label:'文本模板',args:{pattern:'示例-{n}'},help:'可插入随机 UUID、批次号、序号、时间和随机值。鼠标悬浮变量按钮可查看说明。'},
 uuid:{label:'UUID（按种子复现）',args:{},help:'相同种子和规则会重复生成相同 UUID；需每次生成新值时请选择随机 UUID。'},random_uuid:{label:'随机 UUID（每次新值）',args:{}},objectId:{label:'MongoDB ObjectId',args:{}},date:{label:'随机日期',args:{start:'2026-01-01',end:'2026-12-31'}},
 name:{label:'中文姓名',args:{}},email:{label:'测试邮箱',args:{}},company:{label:'测试公司',args:{}},compute:{label:'关联字段计算',args:{op:'concat',fields:[],separator:' '},help:'concat 拼接；add / multiply 为整数加法 / 乘法；不执行脚本。'},ai:{label:'AI 生成内容',args:{prompt:'生成自然的测试内容'}}
};
export function newRule(name:string,kind:string,args?:Record<string,unknown>):FieldRule{return{name,kind,args:structuredClone(args??RULES[kind].args),nullPercent:0,unique:false};}
export function defaultRules(d:Description,kind:string|null):FieldRule[]{if(d.engine==='redis')return[newRule('key','text',{pattern:'test:${prefix}:{uuid}'}),newRule('value','constant',{value:kind==='hash'?{name:'测试'}:'测试内容'})];return d.fields.map(f=>{
 if(f.generated||f.defaultValue!==null)return newRule(f.name,'omit');
 if(f.kind==='uuid')return newRule(f.name,'random_uuid');if(f.kind==='objectId')return newRule(f.name,'objectId');
 if(['int','long'].includes(f.kind))return newRule(f.name,f.unique?'sequence':'integer');if(['decimal','float','double','number'].includes(f.kind))return newRule(f.name,'decimal');if(['bool','boolean'].includes(f.kind))return newRule(f.name,'boolean');
 if(f.kind==='date')return newRule(f.name,'date');if(f.kind==='dateTime')return newRule(f.name,'constant',{value:(f.rawType.includes('with time zone')||f.rawType.includes('timestamptz'))?'2026-01-01T00:00:00Z':'2026-01-01 00:00:00'});if(f.kind==='time')return newRule(f.name,'constant',{value:f.rawType.includes('with time zone')||f.rawType.includes('timetz')?'12:00:00+00:00':'12:00:00'});
 if(['json','object','array'].includes(f.kind))return newRule(f.name,'constant',{value:f.kind==='array'?[]:{}});
 if(['unknown','binary'].includes(f.kind))return newRule(f.name,f.nullable?'null':'omit');
 return newRule(f.name,'text');});}
export function validateTemplate(v:unknown):Template{assertSafeNumbers(v);const t=v as Template;if(!t||t.version!==1||typeof t.name!=='string'||!['mysql','postgres','sqlite','mongodb','redis'].includes(t.engine)||!Array.isArray(t.fields)||!t.fields.length||t.fields.length>200||!Number.isInteger(t.count)||t.count<1||t.count>100000||typeof t.seed!=='string'||!t.parameters||typeof t.parameters!=='object'||Array.isArray(t.parameters)||Object.values(t.parameters).some(v=>typeof v!=='string')||t.fields.some(f=>!f||typeof f.name!=='string'||!Object.prototype.hasOwnProperty.call(RULES,f.kind)||!f.args||typeof f.args!=='object'||Array.isArray(f.args)||!Number.isInteger(f.nullPercent)||f.nullPercent<0||f.nullPercent>100||typeof f.unique!=='boolean'))throw Error('模板格式不受支持或字段配置无效');return{version:1,id:crypto.randomUUID(),name:t.name.slice(0,80),engine:t.engine,fields:t.fields,count:t.count,seed:t.seed,parameters:t.parameters,redisKind:t.redisKind??null,ttlSeconds:t.ttlSeconds??null};}

export function assertSafeNumbers(value:unknown):void{if(typeof value==="number"&&(!Number.isFinite(value)||Number.isInteger(value)&&!Number.isSafeInteger(value)))throw Error("JSON 包含不安全的大整数，请改用带双引号的字符串或 Extended JSON $numberLong");if(value&&typeof value==="object")Object.values(value).forEach(assertSafeNumbers);}

// Direct generation keeps structural rules local; business values come from the model.
export function directAiFields(fields:FieldRule[],description:Description):FieldRule[]{
 return fields.map(field=>{
  const meta=description.fields.find(f=>f.name===field.name);
  if(meta?.generated||['unknown','binary'].includes(meta?.kind??'')||
     ['omit','null','sequence','uuid','random_uuid','objectId','compute'].includes(field.kind)||
     description.engine==='redis'&&field.name==='key')return structuredClone(field);
  if(field.kind==='ai')return structuredClone(field);
  const constraints=['integer','decimal','choice','date'].includes(field.kind)
   ? ` 本次要求未指定取值时，可参考原规则：${JSON.stringify({kind:field.kind,args:field.args})}`:'';
  return {...newRule(field.name,'ai',{prompt:'根据本次生成要求，直接生成符合字段类型的业务值。'+constraints}),unique:field.unique};
 });
}

export function prepareDirectAiPlan(plan:Plan,description:Description):Plan{
 if(!plan.ai?.providerId)throw Error('请先选择 AI 服务；可前往首选项添加服务和模型');
 if(!plan.ai.prompt.trim())throw Error('请填写 AI 生成要求，例如业务场景、内容风格和字段之间的关系');
 if(!Number.isInteger(plan.count)||plan.count<1||plan.count>2000)throw Error('AI 直接生成支持 1–2000 条，请调整生成数量');
 const fields=directAiFields(plan.fields,description);
 if(!fields.some(f=>f.kind==='ai'))throw Error('没有可由 AI 生成的字段。当前字段均为省略、空值、标识符、计算规则或不支持的类型；请先调整字段规则');
 return {...plan,fields};
}
