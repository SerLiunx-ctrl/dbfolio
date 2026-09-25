const fs=require('node:fs'),ts=require('typescript'),assert=require('node:assert/strict');
const mod={exports:{}};
new Function('module','exports',ts.transpileModule(fs.readFileSync('src/features/table/columnTypes.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText)(mod,mod.exports);
const t=mod.exports;
assert.deepEqual(t.typeOptions('sqlite'),['integer','real','text','blob','numeric']);
assert.equal(t.defaultColumnType('sqlite'),'text');
for(const name of ['tinyint','datetime','blob','double'])assert.ok(!t.typeOptions('postgres').includes(name));
for(const name of ['json','jsonb','timestamp','timestamptz','bytea','uuid'])assert.ok(t.typeOptions('postgres').includes(name));
assert.ok(!t.typeOptions('mysql').includes('uuid'));
assert.ok(t.typeOptions('postgres','CustomEnum[]').includes('CustomEnum[]'));
assert.equal(t.hasPrecision('sqlite','numeric'),false);assert.equal(t.hasPrecision('postgres','numeric'),true);
assert.equal(t.supportsIdentity('sqlite','bigint'),false);assert.equal(t.supportsIdentity('postgres','integer'),true);
console.log('通过：三引擎类型选项、默认类型、原始类型保留、精度与自增限制。');

for (const engine of ['mysql','postgres','sqlite']) {
  const groups=t.groupedTypeOptions(engine), flat=groups.flatMap(group=>group.types);
  assert.deepEqual([...flat].sort(), [...t.typeOptions(engine)].sort(), engine+' 分组不能遗漏或新增类型');
  assert.equal(new Set(flat).size,flat.length);assert.ok(groups.every(group=>group.types.length));
}
const existing=t.groupedTypeOptions('postgres','"Custom"."Enum"[]');
assert.equal(existing[0].label,'当前声明类型');assert.deepEqual(existing[0].types,['"Custom"."Enum"[]']);
assert.ok(!t.groupedTypeOptions('sqlite').some(group=>group.label==='日期与时间'));
console.log('通过：三引擎分组完整性、空分组隐藏、无重复与原始声明保留。');
