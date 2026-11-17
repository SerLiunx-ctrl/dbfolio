import type {ColumnInfo, ColumnMeta, DbValue, TableMeta} from '../../ipc/types';
import {sqlTokens, type SqlToken} from '../query/sqlText';
import {qualifiedTableSql, quoteIdent} from './value';

export type RowSqlKind = 'insert' | 'update';
export interface RowSqlOptions {
  kind: RowSqlKind;
  engine: string;
  database: string;
  schema?: string | null;
  table: TableMeta;
  columns: ColumnInfo[];
  rows: DbValue[][];
}
export interface RowSqlResult {sql: string; statements: string[]; omittedColumns: string[]; warnings: string[]}
type GeneratedColumn = ColumnMeta & {generated?: boolean};

function fail(message: string): never {throw Error(message);}
function supported(engine: string) {
  if (!['mysql','postgres','sqlite','dameng'].includes(engine)) fail('此数据库暂不支持复制行 SQL');
}
function textValue(value: unknown): string {
  if (typeof value !== 'string') fail('单元格缺少完整文本值');
  // TextEncoder replaces lone surrogates with U+FFFD; never silently change data.
  for (let i=0; i<value.length; i++) {
    const code=value.charCodeAt(i);
    if (code>=0xd800 && code<=0xdbff) {
      const next=value.charCodeAt(++i);
      if (!(next>=0xdc00 && next<=0xdfff)) fail('文本含不完整的 Unicode 字符，无法无损生成 SQL');
    } else if (code>=0xdc00 && code<=0xdfff) fail('文本含不完整的 Unicode 字符，无法无损生成 SQL');
  }
  return value;
}
function utf8Hex(value: string) {return Array.from(new TextEncoder().encode(value),byte=>byte.toString(16).padStart(2,'0')).join('');}
function stringLiteral(engine: string, value: string) {
  // Doubled apostrophes are independent of NO_BACKSLASH_ESCAPES. Use a UTF-8
  // expression only for mode-sensitive backslashes/control characters.
  if (engine==='mysql') return /[\\\x00-\x1f\x7f]/.test(value)?`CONVERT(X'${utf8Hex(value)}' USING utf8mb4)`:`'${value.replace(/'/g,"''")}'`;
  if (engine==='postgres') {
    if (value.includes('\0')) fail('PostgreSQL 文本不支持 NUL 字符');
    return `E'${value.replace(/\\/g,'\\\\').replace(/'/g,"''")}'`;
  }
  if (engine==='sqlite' && value.includes('\0')) return `CAST(X'${utf8Hex(value)}' AS TEXT)`;
  if (value.includes('\0')) fail('达梦文本含 NUL，暂不能无损生成该字面量');
  return `'${value.replace(/'/g,"''")}'`;
}
function integer(value: unknown, unsigned: boolean) {
  if (typeof value==='number') {
    if (!Number.isSafeInteger(value)) fail('整数已超出 JavaScript 安全范围，请使用数据库返回的精确文本值');
  } else if (typeof value!=='string' || !/^[+-]?\d+$/.test(value)) fail('无效的精确整数值');
  const n=BigInt(value as string | number);
  const min=unsigned?0n:-(1n<<63n), max=unsigned?(1n<<64n)-1n:(1n<<63n)-1n;
  if (n<min || n>max) fail('整数超出单元格类型范围');
  return n.toString();
}
function bytes(value: unknown) {
  const text=textValue(value), hex=text.replace(/^0x/i,'');
  if (!/^(?:[0-9a-f]{2})*$/i.test(hex)) fail('二进制值不是完整的十六进制字节');
  return hex.toLowerCase();
}
function bitType(column: ColumnMeta) {return /^(?:bit(?:\s+varying)?|varbit)(?:\s*\(\d+\))?$/i.test(column.rawType.trim());}
function bitLiteral(engine: string, value: DbValue, column: ColumnMeta) {
  const width=Number(column.rawType.match(/\((\d+)\)/)?.[1]??1);
  if (!Number.isSafeInteger(width) || width<1 || (engine==='mysql' && width>64)) fail('BIT 长度无法核实');
  let digits: string;
  if (engine==='postgres') {
    if (value[0]!=='text' || typeof value[1]!=='string' || !/^[01]+$/.test(value[1])) fail('PostgreSQL BIT 需要完整位字符串，不能从字节或数字推测位长度');
    digits=value[1];
  } else if (value[0]==='bytes') {const hex=bytes(value[1]);if(!hex)fail('BIT 缺少完整位值');digits=BigInt('0x'+hex).toString(2);}
  else if (value[0]==='int' || value[0]==='uint') {
    const n=BigInt(integer(value[1],true));digits=n.toString(2);
  } else if (value[0]==='bool' && typeof value[1]==='boolean') digits=value[1]?'1':'0';
  else fail('BIT 列需要完整位值，不能把普通文本或预览当作二进制');
  const varying=/varying|varbit/i.test(column.rawType);
  if ((!varying || /\(\d+\)/.test(column.rawType)) && digits.length>width) fail('位值超过目标 BIT 长度');
  return `${engine==='mysql'?'b':'B'}'${varying?digits:digits.padStart(width,'0')}'`;
}

/** 仅序列化已加载完整值，不执行 SQL，也不把未知/截断值转换成文本。 */
export function rowSqlLiteral(engine: string, value: DbValue, column: ColumnMeta): string {
  supported(engine);
  if (!Array.isArray(value) || value.length!==2) fail('单元格值结构不完整');
  const [tag,data]=value;
  if (tag==='trunc' || tag==='readonly') fail('包含截断预览或只读扩展值，不能生成完整 SQL；请读取完整值或调整列范围');
  if (tag==='null') {if (data!==null) fail('NULL 单元格值无效');return 'NULL';}
  if ((engine==='mysql' || engine==='postgres') && bitType(column)) return bitLiteral(engine,value,column);
  if (!column.canonical || column.canonical.kind==='unknown') fail(`暂不支持目标列类型 ${column.rawType}，请通过 SQL 手动处理`);
  switch (tag) {
    case 'bool':
      if (typeof data!=='boolean') fail('无效布尔值');
      return engine==='postgres'?(data?'TRUE':'FALSE'):(data?'1':'0');
    case 'int': return integer(data,false);
    case 'uint': return integer(data,true);
    case 'decimal': {
      const decimal=textValue(data);
      if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(decimal)) fail('无效的精确十进制值');
      return decimal;
    }
    case 'float':
      if (typeof data!=='number' || !Number.isFinite(data)) fail('非有限浮点数暂不能无损生成 SQL');
      return Object.is(data,-0)?'-0.0':String(data);
    case 'bytes': {
      if (column.canonical.kind!=='binary') fail(`字节值不能当作 ${column.rawType} 写入；请通过 SQL 明确转换`);
      const hex=bytes(data);
      return engine==='postgres'?`decode('${hex}', 'hex')`:engine==='dameng'?`HEXTORAW('${hex}')`:`X'${hex}'`;
    }
    case 'json': {
      if (column.canonical.kind!=='json' && !(engine==='sqlite' && column.canonical.kind==='string')) fail('JSON 展示值与目标类型不一致，不能当作数组或扩展类型回写');
      const json=textValue(data);
      try {JSON.parse(json);} catch {fail('JSON 值语法无效，不能生成 SQL');}
      const literal=stringLiteral(engine,json);
      return engine==='postgres'?`${literal}::${/^jsonb\b/i.test(column.rawType)?'jsonb':'json'}`:literal;
    }
    case 'date': case 'time': case 'datetime': {
      const literal=stringLiteral(engine,textValue(data));
      if (engine==='postgres') {
        const tz=(column.canonical.kind==='dateTime' || column.canonical.kind==='time') && column.canonical.tz;
        return `${literal}::${tag==='date'?'date':tag==='time'?(tz?'timetz':'time'):(tz?'timestamptz':'timestamp')}`;
      }
      if (engine==='dameng') return `${tag==='date'?'DATE':tag==='time'?'TIME':'TIMESTAMP'} ${literal}`;
      return literal;
    }
    case 'uuid': {
      const uuid=textValue(data);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) fail('UUID 值无效');
      const literal=stringLiteral(engine,uuid);return engine==='postgres'?`${literal}::uuid`:literal;
    }
    case 'text': return stringLiteral(engine,textValue(data));
    default: return fail('未知单元格类型，不能生成 SQL');
  }
}

function word(t: SqlToken | undefined, expected: string) {return t?.kind==='word' && t.text.toUpperCase()===expected;}
function unquote(t: SqlToken) {
  if (t.kind==='word') return t.text;
  if (t.kind==='quoted' && t.text.startsWith('"') && t.text.endsWith('"')) return t.text.slice(1,-1).replace(/""/g,'"');
  return null;
}
function generatedColumns(engine: string, table: TableMeta) {
  const result=new Set(table.columns.filter(c=>(c as GeneratedColumn).generated===true).map(c=>c.name));
  if (engine!=='dameng' || !table.columns.some(c=>(c as GeneratedColumn).generated===undefined) || !table.rawDdl) return result;
  const tokens=sqlTokens(table.rawDdl,engine).filter(t=>t.kind!=='space' && t.kind!=='comment');
  const create=tokens.findIndex((t,i)=>word(t,'CREATE') && word(tokens[i+1],'TABLE'));
  const open=create<0?-1:tokens.findIndex((t,i)=>i>create && t.text==='(');
  const hasGenerated=tokens.some(t=>word(t,'GENERATED') || word(t,'AS'));
  if (open<0) {if (hasGenerated) fail('达梦生成列定义无法可靠定位，请核对原生 DDL 后手动复制');return result;}
  let depth=1, start=open+1, closed=false, close=-1;
  const inspect=(definition: SqlToken[])=>{
    let nested=0, generated=false, signal=false;
    for(let i=1;i<definition.length;i++) {
      const token=definition[i];
      if(token.text==='(')nested++;
      else if(token.text===')')nested--;
      else if(!nested) {
        if(word(token,'GENERATED'))signal=true;
        if(word(token,'AS') && !word(definition[i+1],'IDENTITY'))generated=true;
      }
    }
    if (!generated && !signal) return;
    const name=definition[0] && unquote(definition[0]), column=table.columns.find(c=>c.name===name);
    if (!column) fail('达梦生成列定义与字段元数据不一致，无法安全生成 SQL');
    if (generated) result.add(column.name);
    else if (!column.autoIncrement) fail(`无法核实字段 ${column.name} 的生成属性，请通过 SQL 手动处理`);
  };
  for (let i=open+1;i<tokens.length;i++) {
    if (tokens[i].text==='(') depth++;
    else if (tokens[i].text===')') {
      depth--;if (!depth) {inspect(tokens.slice(start,i));closed=true;close=i;break;}
    } else if (tokens[i].text===',' && depth===1) {inspect(tokens.slice(start,i));start=i+1;}
  }
  if (!closed && hasGenerated) fail('达梦原生生成列定义不完整，无法安全生成 SQL');
  const outside=tokens.filter((_,i)=>i<open||i>close);
  if (closed && outside.some((t,i)=>word(t,'GENERATED') || word(t,'AS') && outside[i+1]?.text==='(')) fail('达梦原生生成属性无法定位到字段，无法安全生成 SQL');
  return result;
}
function identifier(name: string) {if (!name || name.includes('\0')) fail('目标名称或字段名无效');return name;}

export function serializeRowSql(options: RowSqlOptions): RowSqlResult {
  const {engine,database,table,columns,rows,kind}=options;
  supported(engine);
  if(kind!=='insert'&&kind!=='update')fail('不支持此 SQL 复制类型');
  if (table.kind!=='table') fail('复制行 SQL 仅支持真实表，不能把视图或查询别名作为写入目标');
  if (!rows.length || !columns.length) fail('请先选择需要复制的行和列');
  identifier(table.name);if (engine==='mysql' || engine==='dameng') identifier(database);
  const schema=options.schema??table.schema;if(schema)identifier(schema);
  const metadata=new Map<string,ColumnMeta>();
  for (const c of table.columns) {identifier(c.name);if (metadata.has(c.name)) fail('目标元数据包含重复字段名，请刷新后重试');metadata.set(c.name,c);}
  const names=new Set<string>();
  const matched=columns.map(c=>{
    if (names.has(c.name)) fail(`结果包含重复字段名 ${c.name}，请调整查询列，不能猜测别名或 JOIN 来源`);
    names.add(c.name);const target=metadata.get(c.name);
    if (!target) fail(`结果字段 ${c.name} 不存在于目标表；请使用实际列名，不能猜测别名或 JOIN 来源`);
    return target;
  });
  // Reject incomplete snapshots even when an automatically generated column is omitted.
  rows.forEach((row,index)=>{
    if (!Array.isArray(row) || row.length!==columns.length) fail(`第 ${index+1} 行与字段数量不一致`);
    row.forEach(value=>{if (!Array.isArray(value) || value.length!==2 || !['null','bool','int','uint','float','decimal','text','bytes','date','time','datetime','json','uuid'].includes(value[0])) fail(`第 ${index+1} 行包含不完整、截断、只读或未知值，不能生成完整 SQL`);});
  });
  const generated=generatedColumns(engine,table), pk=new Set(table.primaryKey), omittedColumns:string[]=[];
  const included=matched.map((column,index)=>({column,index})).filter(({column})=>{
    const omit=generated.has(column.name) || column.autoIncrement || (kind==='update'&&pk.has(column.name));
    if (omit) omittedColumns.push(column.name);return !omit;
  });
  if (!included.length) fail(kind==='insert'?'当前列仅包含自增或生成列，没有可复制的 INSERT 字段':'当前列仅包含主键或生成列，没有可复制的 UPDATE 字段');
  const keyColumns=table.primaryKey.map(name=>({column:metadata.get(name),index:columns.findIndex(c=>c.name===name)}));
  if (kind==='update') {
    if (!keyColumns.length) fail('目标表没有真实主键，不能生成可可靠定位的 UPDATE');
    if (pk.size!==table.primaryKey.length) fail('目标主键元数据重复，请刷新后重试');
    if (keyColumns.some(key=>!key.column || key.index<0)) fail('选中结果缺少完整主键，不能生成 UPDATE');
    if (table.primaryKey.some(name=>generated.has(name))) fail('生成列主键无法安全定位，请通过 SQL 手动处理');
  }
  const target=qualifiedTableSql(engine,database,options.schema??table.schema,table.name), keys=new Set<string>();
  const statements=rows.map((row,rowIndex)=>{
    const literal=(index:number,column:ColumnMeta)=>{try{return rowSqlLiteral(engine,row[index],column);}catch(e){return fail(`第 ${rowIndex+1} 行 · ${column.name}：${e instanceof Error?e.message:String(e)}`);}};
    if (kind==='insert') return `INSERT INTO ${target} (${included.map(v=>quoteIdent(engine,v.column.name)).join(', ')}) VALUES (${included.map(v=>literal(v.index,v.column)).join(', ')});`;
    const keyValues=keyColumns.map(key=>{
      if (row[key.index][0]==='null') fail(`第 ${rowIndex+1} 行主键为 NULL，无法可靠定位，不能生成 UPDATE`);
      return literal(key.index,key.column!);
    });
    const signature=JSON.stringify(keyValues);if (keys.has(signature)) fail('选中结果包含重复主键，不能生成确定的 UPDATE');keys.add(signature);
    return `UPDATE ${target} SET ${included.map(v=>`${quoteIdent(engine,v.column.name)} = ${literal(v.index,v.column)}`).join(', ')} WHERE ${keyColumns.map((v,i)=>`${quoteIdent(engine,v.column!.name)} = ${keyValues[i]}`).join(' AND ')};`;
  });
  const warnings=table.columns.some(c=>(c as GeneratedColumn).generated===undefined)?['部分字段未提供生成列标记；仅略过已识别生成列，请核对目标表定义。']:[];
  return {sql:statements.join('\n'),statements,omittedColumns,warnings};
}
