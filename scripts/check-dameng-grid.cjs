const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),ts=require('typescript');
function load(file){const module={exports:{}};const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;new Function('require','exports','module',code)(name=>load(path.resolve(path.dirname(file),name+'.ts')),module.exports,module);return module.exports;}
const {buildTableSelect,parseCell}=load(path.resolve('src/features/grid/value.ts'));
const columns=[{name:'id',canonical:{kind:'int',bits:64,unsigned:false}},{name:'blob_data',canonical:{kind:'binary',len:null}},{name:'clob_data',canonical:{kind:'string',len:null}},{name:'title',canonical:{kind:'string',len:128}}];
assert.equal(buildTableSelect('dameng','D','S','T',columns),'SELECT "id", DBMS_LOB.SUBSTR("blob_data", 257, 1) AS "blob_data", substr("clob_data", 1, 1025) AS "clob_data", "title" FROM "S"."T"');
assert.equal(buildTableSelect('dameng','D',null,'T',[columns[0]]),'SELECT "id" FROM "D"."T"');
assert.deepEqual(parseCell({canonical:{kind:'decimal',precision:38,scale:9}},'12345678901234567890.123456789'),['decimal','12345678901234567890.123456789']);
assert.deepEqual(parseCell({canonical:{kind:'bool'}},'1'),['bool',true]);
console.log('PASS 达梦数据页模式限定、BLOB 字节预览、CLOB 截断 SQL、Decimal/BIT 编辑');
