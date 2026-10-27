const fs=require('node:fs'),ts=require('typescript'),assert=require('node:assert/strict');
const mod={exports:{}};new Function('module','exports',ts.transpileModule(fs.readFileSync('src/features/table/columnTypes.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText)(mod,mod.exports);const t=mod.exports;
for(const engine of ['mysql','postgres','sqlite']){
 const basic=t.availableTypeOptions(engine);assert(basic.every(v=>v.description.includes('未核验')));assert(!basic.some(v=>['json','jsonb','vector'].includes(v.name)));
 assert.equal(t.supportsIdentity(engine,'bigint'),engine!=='sqlite');assert.equal(t.defaultColumnType(engine),engine==='sqlite'?'text':'varchar');
}
const vector={name:'"vectors.qa"."vector"',label:'vectors.qa.vector',description:'向量 · vector 扩展 0.8.0',category:'向量',arguments:'dimensions',defaultArguments:''};
const catalog={serverVersion:'17',types:[vector,{name:'varchar',label:'varchar',description:'可变长度字符串',category:'文本',arguments:'length',defaultArguments:'255'}]};
assert.deepEqual(t.availableTypeOptions('postgres',catalog),catalog.types);
const existing=t.availableTypeOptions('postgres',catalog,'"vectors.qa".vector');assert.equal(existing[0].name,'"vectors.qa".vector');assert.equal(existing[0].arguments,'dimensions');
const alias=t.availableTypeOptions('postgres',catalog,'character varying');assert(alias.some(v=>v.name==='character varying'&&v.arguments==='length'));
const unknown=t.availableTypeOptions('postgres',catalog,'"Other"."Enum"[]');assert.equal(unknown[0].name,'"Other"."Enum"[]');assert.equal(unknown[0].unavailable,true);
assert(t.typeOptionText(vector).includes('vector 扩展 0.8.0'));assert.equal(t.hasPrecision('sqlite','numeric'),false);
console.log('PASS server catalog authority, explicit conservative fallback, quoted/schema type identity, aliases, unavailable current declarations and Chinese descriptions');
