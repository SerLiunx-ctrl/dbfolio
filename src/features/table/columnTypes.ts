import type { DataTypeCatalog, DataTypeOption, Engine } from "../../ipc/types";
// 仅在服务器读取失败时提供保守的基础选项；正常选择以服务器目录为准。
const FALLBACK_TYPES: Record<Engine, string[]> = {
  mysql: ["tinyint", "smallint", "mediumint", "int", "bigint", "boolean", "decimal", "float", "double", "varchar", "char", "text", "mediumtext", "longtext", "date", "time", "datetime", "timestamp", "json", "blob", "mediumblob", "longblob"],
  postgres: ["smallint", "integer", "bigint", "boolean", "numeric", "real", "double precision", "varchar", "char", "text", "date", "time", "timetz", "timestamp", "timestamptz", "interval", "json", "jsonb", "bytea", "uuid", "inet", "cidr", "macaddr"],
  sqlite: ["integer", "int", "bigint", "real", "numeric", "decimal", "text", "varchar", "char", "blob", "boolean", "date", "datetime", "timestamp", "any"],
  mongodb: [], redis: [],
};
export const defaultColumnType = (engine: Engine) => engine === "sqlite" ? "text" : "varchar";
export const hasLength = (type: string) => ["varchar", "char"].includes(type);
export const hasPrecision = (engine: Engine, type: string) => engine !== "sqlite" && ["decimal", "numeric"].includes(type);
export const hasTimePrecision = (engine: Engine, type: string) => engine !== "sqlite" && ["time", "timetz", "datetime", "timestamp", "timestamptz"].includes(type);
export const supportsIdentity = (engine: Engine, type: string) => (engine === "sqlite" ? ["integer"] : engine === "postgres" ? ["smallint", "integer", "bigint"] : ["tinyint", "smallint", "mediumint", "int", "integer", "bigint"]).includes(type);
export const typeHint = (engine: Engine) => engine === "sqlite"
  ? "SQLite 普通表按类型亲和性处理；NUMERIC 不是定点精度约束。日期/JSON 通常存为 TEXT，布尔值通常存为 INTEGER（0/1）。STRICT 表仅支持 INT、INTEGER、REAL、TEXT、BLOB、ANY，请通过 SQL 管理。"
  : engine === "postgres" ? "类型按当前数据库发现，扩展类型需已安装且有使用权限；timestamp 与 timestamptz、json 与 jsonb 分别保留。数组及复杂类型参数通过 SQL 管理。" : "类型按服务器版本筛选；自增仅适用于整数列。";


const DESCRIPTIONS:Record<string,string>={tinyint:'1 字节整数',smallint:'2 字节整数',mediumint:'3 字节整数',int:'4 字节整数',integer:'整数',bigint:'8 字节整数',boolean:'布尔值',decimal:'精确定点数',numeric:'精确数值',float:'单精度浮点数',real:'单精度浮点数',double:'双精度浮点数','double precision':'双精度浮点数',varchar:'可变长度字符串',char:'固定长度字符串',text:'文本',mediumtext:'中等长度文本',longtext:'长文本',date:'日期',time:'不带时区的时间',timetz:'带时区的时间',datetime:'日期时间',timestamp:'日期时间',timestamptz:'带时区的日期时间',interval:'时间间隔',json:'JSON 文档',jsonb:'二进制 JSON 文档',blob:'二进制数据',mediumblob:'中等长度二进制数据',longblob:'长二进制数据',bytea:'二进制数据',uuid:'唯一标识符',inet:'IP 地址',cidr:'网络地址',macaddr:'MAC 地址',any:'任意值',enum:'枚举值列表',set:'集合值列表',binary:'固定长度二进制',varbinary:'可变长度二进制'};
const typeNameKey=(name:string)=>JSON.stringify((name.match(/"(?:[^"]|"")*"|[^.]+/g)??[]).map(v=>{v=v.trim();return v.startsWith('"')?v.slice(1,-1).replace(/""/g,'"'):v.toLowerCase();}));
export function availableTypeOptions(engine:Engine,catalog?:DataTypeCatalog,current?:string):DataTypeOption[]{
 const basics=[...FALLBACK_TYPES[engine],...(engine==='mysql'?['enum','set','binary','varbinary']:[])];
 const types=catalog?.types??basics.filter(t=>!['json','jsonb'].includes(t)).map(name=>({name,label:name,description:(DESCRIPTIONS[name]??'声明类型')+' · 未核验',category:'基础类型',arguments:(['enum','set'].includes(name)?'values':hasLength(name)||['binary','varbinary'].includes(name)?'length':hasPrecision(engine,name)?'precision':hasTimePrecision(engine,name)?'temporal':'none') as DataTypeOption['arguments'],defaultArguments:['enum','set'].includes(name)?"'值1'":['varchar','varbinary'].includes(name)?'255':['char','binary'].includes(name)?'1':hasPrecision(engine,name)?'10,0':''}));
 if(current&&!types.some(t=>t.name===current)){
   const aliases:Record<string,string>={'character varying':'varchar','character':'char','timestamp without time zone':'timestamp','timestamp with time zone':'timestamptz','time without time zone':'time','time with time zone':'timetz',int4:'integer',int8:'bigint',int2:'smallint',bool:'boolean'};
   const known=types.find(t=>typeNameKey(t.name)===typeNameKey(current)||(!current.includes('.')&&t.label===current)||t.name===aliases[current.toLowerCase()]);
   if(known)return types.map(t=>t===known?{...t,name:current}:t);
   return [{name:current,label:current,description:'当前声明 · 不在可用列表',category:'当前声明',arguments:'none',defaultArguments:'',unavailable:true},...types];
 }
 return types;
}
export const typeOptionText=(type:DataTypeOption)=>`${type.label} · ${type.description}`;
