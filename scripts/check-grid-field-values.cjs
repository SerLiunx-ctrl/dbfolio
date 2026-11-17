const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const modules = new Map();
function load(file) {
  const full = path.resolve(file);
  if (modules.has(full)) return modules.get(full).exports;
  const output = ts.transpileModule(fs.readFileSync(full, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
  });
  assert.equal(output.diagnostics?.length ?? 0, 0, full);
  const module = { exports: {} };
  modules.set(full, module);
  new Function('require', 'exports', 'module', output.outputText)(name => {
    assert(name.startsWith('.'), `纯模块不得引入外部运行时：${name}`);
    return load(path.resolve(path.dirname(full), name + '.ts'));
  }, module.exports, module);
  return module.exports;
}

const { parseCell } = load('src/features/grid/value.ts');
const { detailValue } = load('src/features/grid/detailValue.ts');
const { clipboardValue } = load('src/features/grid/clipboardValue.ts');
let checks = 0;
function equal(actual, expected, message) { assert.deepEqual(actual, expected, message); checks++; }
function rejects(action, pattern, message) { assert.throws(action, pattern, message); checks++; }
const column = (rawType, canonical, extra = {}) => ({ name: 'value', rawType, canonical, ordinal: 1, nullable: true, unsigned: false, autoIncrement: false, ...extra });
const routes = [
  (column, text) => parseCell(column, text),
  (column, text) => detailValue(['null', null], text, false, column),
  (column, text) => clipboardValue(column, [column.canonical.kind === 'binary' ? 'bytes' : 'text', text]),
];

for (let bits = 1; bits <= 64; bits++) {
  const bit = column(`bit(${bits})`, { kind: 'int', bits, unsigned: true }, { unsigned: true });
  const max = (1n << BigInt(bits)) - 1n;
  for (const parse of routes) {
    for (const value of [0n, 1n, max]) {
      equal(parse(bit, value.toString()), ['uint', value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString()], `BIT(${bits})精确无符号类型`);
    }
    for (const value of ['-1', (max + 1n).toString(), '1.0', '1e0', 'true', '0x01', ' ']) rejects(() => parse(bit, value), /整数/, `BIT(${bits})不得降级为文本`);
  }
  equal(clipboardValue(bit, ['bool', true]), ['uint', 1]);
  equal(clipboardValue(bit, ['bool', false]), ['uint', 0]);
  const hex = max.toString(16).padStart(Math.ceil(bits / 8) * 2, '0');
  equal(BigInt(clipboardValue(bit, ['bytes', '0x' + hex])[1]), max, '旧BIT二进制副本按大端值恢复');
  equal(clipboardValue(bit, ['null', null]), ['null', null]);
  equal(detailValue(['uint', 1], '', true, bit), ['null', null]);
  equal(parseCell(bit, ''), ['null', null]);
  rejects(() => detailValue(['uint', 0], '', false, bit), /整数/, '详情清空不会隐式设NULL');
  rejects(() => clipboardValue(bit, ['text', '']), /整数/, '类型化空串不会隐式设NULL');
}
const bit1 = column('BIT(1)', { kind: 'int', bits: 1, unsigned: true });
for (const bytes of ['0x31', [49], '0x02', [2]]) rejects(() => clipboardValue(bit1, ['bytes', bytes]), /整数超出范围/, 'ASCII字节1不能误当位值1');
for (const bytes of ['0x1', 'not hex', [256], [-1], [1.5]]) rejects(() => clipboardValue(bit1, ['bytes', bytes]), /二进制/);
equal(clipboardValue(bit1, ['bytes', [1]]), ['uint', 1]);
equal(clipboardValue(bit1, ['bytes', new Uint8Array([0, 1])]), ['uint', 1]);
for (const empty of ['0x', [], new Uint8Array()]) rejects(() => clipboardValue(bit1, ['bytes', empty]), /空二进制值不能转换为 BIT/, '空BLOB不能默默变成位值0');
equal(clipboardValue(bit1, ['bytes', '0x00']), ['uint', 0], '真实BIT0使用非空字节');
for (const tag of ['trunc', 'readonly']) rejects(() => clipboardValue(bit1, [tag, '1']), /不完整/);

for (const rawType of ['bit(5)', 'bit varying(5)', 'varbit(5)', 'BIT(1)']) {
  for (const kind of [{ kind: 'unknown', raw: rawType }, { kind: 'string', len: 5 }]) {
    for (const parse of routes) equal(parse(column(rawType, kind), '00101'), ['text', '00101'], 'PG位串及SQLite同名声明保留位宽和文本');
  }
}
for (const parse of routes) {
  equal(parse(column('BIT', { kind: 'bool' }), '1'), ['bool', true], 'DM BIT保持布尔类型');
  equal(parse(column('tinyint(1)', { kind: 'int', bits: 8, unsigned: false }), '127'), ['int', 127], 'tinyint显示宽度不约束值为0或1');
  equal(parse(column('TIME', { kind: 'time', tz: false }), '-838:59:59'), ['time', '-838:59:59'], 'MySQL TIME不是24小时制时钟');
}
const year = column('YEAR', { kind: 'int', bits: 16, unsigned: true });
for (const parse of routes) {
  for (const value of [0, 1901, 2001, 2155]) equal(parse(year, String(value)), ['uint', value]);
  for (const value of ['1', '70', '1900', '2156', '65535']) rejects(() => parse(year, value), /YEAR/);
  equal(parse(column('SMALLINT UNSIGNED', year.canonical), '1'), ['uint', 1], 'YEAR规则不影响其他uint16');
}

const json = column('json', { kind: 'json' });
const binary = column('varbinary(20)', { kind: 'binary', len: 20 });
for (const parse of routes) {
  for (const text of ['null', 'true', '"中文"', '{"large":9007199254740993}', '[1,2]']) equal(parse(json, text), ['json', text], 'JSON校验不重写大整数');
  for (const text of ['{', 'undefined', '普通中文', '{"trailing":1,}']) rejects(() => parse(json, text), SyntaxError);
  for (const text of ['0x', '0x00', '0x80FF']) equal(parse(binary, text), ['bytes', text]);
  for (const text of ['0x1', '0xabc', 'hello', '00ff', ' 0x00 ']) rejects(() => parse(binary, text), /完整十六进制/);
}
equal(clipboardValue(binary, ['bytes', [0, 255]]), ['bytes', [0, 255]]);
equal(clipboardValue(binary, ['bytes', '0x']), ['bytes', '0x']);
rejects(() => clipboardValue(binary, ['bytes', '0x1']), /完整十六进制/);
rejects(() => clipboardValue(binary, ['bytes', [256]]), /二进制/);
rejects(() => clipboardValue(binary, ['text', '0xff']), /二进制数据/);
equal(parseCell(binary, ''), ['null', null]);
rejects(() => detailValue(['bytes', '0x00'], '', false, binary), /完整十六进制/);
equal(detailValue(['text', 'original'], '', false, column('text', { kind: 'string' })), ['text', '']);
equal(clipboardValue(column('text', { kind: 'string' }), ['text', '']), ['text', '']);

const decimal = column('decimal(6,2) unsigned', { kind: 'decimal', precision: 6, scale: 2 }, { unsigned: true });
for (const parse of routes) {
  for (const text of ['9999.99', '00009999.9900', '+1.2300', '.0100', '1e-2', '12300e-4', '-0.000', '0e99999999999999999']) equal(parse(decimal, text), ['decimal', text], '精确Decimal接受数学等值的尾零和e指数');
  for (const text of ['10000', '9999.999', '.001', '1e99999999999999999']) rejects(() => parse(decimal, text), /精度限制|小数位限制/);
  for (const text of ['-0.01', '-1e-99999999999999999']) rejects(() => parse(decimal, text), /无符号/);
  rejects(() => parse(decimal, '1e-99999999999999999'), /小数位限制/, '指数校验不展开巨型字符串');
  const precise = column('numeric(38,10)', { kind: 'decimal', precision: 38, scale: 10 });
  equal(parse(precise, '1234567890123456789012345678.1234567890'), ['decimal', '1234567890123456789012345678.1234567890'], '全精度数不得经过Number');
  rejects(() => parse(precise, '12345678901234567890123456789.1234567890'), /精度限制/);
  const negativeScale = column('numeric(3,-2)', { kind: 'decimal', precision: 3, scale: null });
  for (const text of ['12300', '100', '123e2', '-99900', '0']) equal(parse(negativeScale, text), ['decimal', text], 'PG负scale从真实rawType恢复');
  for (const text of ['12345', '1', '999001', '100000']) rejects(() => parse(negativeScale, text), /精度限制|小数位限制/);
  const fraction = column('numeric(3,5)', { kind: 'decimal', precision: 3, scale: 5 });
  for (const text of ['0.00123', '.00001', '9.99e-3']) equal(parse(fraction, text), ['decimal', text], 'PG scale可大于precision');
  for (const text of ['0.01', '0.000001']) rejects(() => parse(fraction, text), /精度限制|小数位限制/);
  const sqlite = column('DECIMAL(3,2)', { kind: 'decimal', precision: null, scale: null });
  equal(parse(sqlite, '123456789.123456789'), ['decimal', '123456789.123456789'], 'SQLite声明的p/s不产生固定精度约束');
  equal(parse(column('numeric', { kind: 'decimal' }), '123456789.123456789'), ['decimal', '123456789.123456789'], '无限制numeric不增加隐含精度约束');
}

console.log(`PASS ${checks} assertions: BIT(1..64)精确类型/边界、三入口一致、PG与SQLite位串保留、DM布尔、YEAR、tinyint、TIME、JSON/binary严格校验、Decimal无损精度/scale/unsigned与PG负scale、显式NULL及空串`);
