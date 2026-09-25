const fs=require('node:fs'),ts=require('typescript'),assert=require('node:assert/strict');
const mod={exports:{}};
new Function('module','exports',ts.transpileModule(fs.readFileSync('src/ipc/types.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText)(mod,mod.exports);
const {isReadOnlyValue,isTruncatedValue,isNullValue,formatDbValue}=mod.exports;
assert.equal(formatDbValue(['readonly','[0.1,0.2]']),'[0.1,0.2]');
assert.equal(isReadOnlyValue(['readonly','[1]']),true);assert.equal(isReadOnlyValue(['trunc','cut']),true);
assert.equal(isNullValue(['readonly','[解析失败]']),false);assert.equal(isTruncatedValue(['readonly','[1]']),false);
assert.equal(formatDbValue(['null',null]),'(NULL)');
console.log('通过：向量文本显示、只读保护、真实 NULL 与解析失败/截断区分。');
