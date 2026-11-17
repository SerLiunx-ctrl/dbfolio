// Run the actual TypeScript serializer against an isolated, in-memory SQLite.
// SQLite NUMERIC affinity does not provide arbitrary-precision decimal storage;
// exact decimal-text assertions therefore use TEXT and a separate NUMERIC case
// explicitly records the engine's own conversion limit.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ts = require('typescript');
const cache = new Map();
function load(file) {
  file = path.resolve(file);
  if (cache.has(file)) return cache.get(file).exports;
  const module = { exports: {} }; cache.set(file, module);
  const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  new Function('module', 'exports', 'require', output)(module, module.exports, name => load(path.resolve(path.dirname(file), name + '.ts')));
  return module.exports;
}
const { serializeRowSql } = load('src/features/grid/rowSql.ts');
function column(name, kind, extra = {}) {
  const rawType = kind === 'string' ? 'TEXT' : kind === 'int' ? 'INTEGER' : kind === 'binary' ? 'BLOB' : kind === 'decimal' ? 'NUMERIC' : kind === 'dateTime' ? 'TEXT' : kind;
  const canonical = kind === 'int' ? { kind, bits: 64, unsigned: false } : kind === 'dateTime' ? { kind, tz: false, precision: 6 } : { kind };
  return { name, ordinal: 1, rawType, canonical, nullable: true, autoIncrement: false, unsigned: false, generated: false, ...extra };
}
function table(name, columns, primaryKey) {
  return { name, kind: 'table', schema: null, columns, primaryKey, indexes: [], foreignKeys: [], comment: null, rawDdl: null };
}
function serialize(target, rows, kind = 'insert') {
  return serializeRowSql({ engine: 'sqlite', database: 'main', table: target, columns: target.columns.map(({ name, rawType }) => ({ name, rawType })), rows, kind });
}

const exactDecimal = '12345678901234567890.123456789';
const note = "O'Brien 中文😀\t制表符\r\n换行\\字面量\\n";
const columns = [
  column('id', 'int', { autoIncrement: true, nullable: false }),
  column('signed_min', 'int'), column('signed_max', 'int'), column('unsafe_js_int', 'int'),
  column('decimal_text', 'string'), column('decimal_numeric', 'decimal'),
  column('null_text', 'string'), column('empty_text', 'string'), column('note', 'string'),
  column('nul_text', 'string'), column('binary_data', 'binary'), column('empty_binary', 'binary'),
  column('stamp', 'dateTime'), column('qty', 'int'),
  column('virtual_value', 'int', { generated: true }), column('stored_value', 'int', { generated: true }),
];
const target = table('qa_rows', columns, ['id']);
const rows = [
  [
    ['int', 7777], ['int', '-9223372036854775808'], ['int', '9223372036854775807'], ['int', '9007199254740993'],
    ['text', exactDecimal], ['decimal', exactDecimal], ['null', null], ['text', ''], ['text', note],
    ['text', '前\0中\0后'], ['bytes', '0x00017f80ff00'], ['bytes', '0x'], ['datetime', '2026-11-17 12:34:56.123456'], ['int', 7], ['int', -1000], ['int', -2000],
  ],
  [
    ['int', 8888], ['int', '-9223372036854775807'], ['int', '9223372036854775806'], ['int', '9007199254740995'],
    ['text', '000123.4500'], ['decimal', '0.000000000000000000000000000001'], ['null', null], ['text', ''],
    ['text', "x'); DROP TABLE qa_rows; --\n仍是文本"], ['text', '\0'], ['bytes', '0xff0080'], ['bytes', '0x'],
    ['datetime', '2026-11-17 00:00:00.000001'], ['int', 9], ['int', 123], ['int', 456],
  ],
];
const inserts = serialize(target, rows);
assert.deepEqual(inserts.omittedColumns, ['id', 'virtual_value', 'stored_value']);
assert(inserts.sql.includes(exactDecimal), 'Decimal 的原始精确文本必须完整写入 SQL');
assert(!inserts.statements.some(sql => /INSERT.*\("id"/.test(sql)), '自增主键默认省略');
assert(inserts.sql.includes("CAST(X'"), 'SQLite NUL 文本必须使用无损 UTF-8 表达式');

const composite = table('qa_composite', [
  column('left_id', 'int', { nullable: false }), column('scope', 'string', { nullable: false }),
  column('note', 'string'), column('binary_data', 'binary'), column('null_text', 'string'), column('empty_text', 'string'),
], ['left_id', 'scope']);
const scopeA = "tenant 'one'\t\\key\n\0A", scopeB = "tenant 'one'\t\\key\n\0B";
const compositeRows = [
  [['int', '-9223372036854775808'], ['text', scopeA], ['text', 'before A'], ['bytes', '0x0001'], ['null', null], ['text', '']],
  [['int', '-9223372036854775808'], ['text', scopeB], ['text', 'before B'], ['bytes', '0x0002'], ['null', null], ['text', '']],
  [['int', '9223372036854775807'], ['text', scopeA], ['text', 'untouched'], ['bytes', '0x0003'], ['null', null], ['text', '']],
];
const compositeInserts = serialize(composite, compositeRows);
const updatedNote = "updated '引号'\t\r\n\\path\0tail";
const updateRows = [[...compositeRows[0].map(cell => structuredClone(cell))]];
updateRows[0][2] = ['text', updatedNote]; updateRows[0][3] = ['bytes', '0xff0000'];
const updates = serialize(composite, updateRows, 'update');
assert(updates.sql.includes('WHERE "left_id" = -9223372036854775808 AND "scope" = '));
assert(!updates.sql.includes('SET "left_id"') && !updates.sql.includes('SET "scope"'));

const payload = {
  insert: inserts.statements, compositeInsert: compositeInserts.statements, update: updates.statements,
  expected: rows.map(row => Object.fromEntries(columns.map((c, i) => [c.name, row[i][1]]))),
  exactDecimal, updatedNote, scopeA, scopeB,
};
const python = String.raw`
import decimal,json,sqlite3,sys
p=json.loads(sys.stdin.buffer.read().decode('utf-8'))
c=sqlite3.connect(':memory:')
c.row_factory=sqlite3.Row
c.execute('''CREATE TABLE qa_rows(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 signed_min INTEGER, signed_max INTEGER, unsafe_js_int INTEGER,
 decimal_text TEXT, decimal_numeric NUMERIC,
 null_text TEXT, empty_text TEXT, note TEXT, nul_text TEXT,
 binary_data BLOB, empty_binary BLOB, stamp TEXT, qty INTEGER,
 virtual_value INTEGER GENERATED ALWAYS AS(qty*2) VIRTUAL,
 stored_value INTEGER GENERATED ALWAYS AS(qty*3) STORED)''')
for _ in range(2):
 for sql in p['insert']:
  cur=c.execute(sql)
  assert cur.rowcount==1
actual=c.execute('SELECT * FROM qa_rows ORDER BY id').fetchall()
assert [r['id'] for r in actual]==[1,2,3,4], '复制新行必须由数据库分配新主键'
for i,row in enumerate(actual):
 e=p['expected'][i%2]
 for name in ['signed_min','signed_max','unsafe_js_int']:
  assert str(row[name])==e[name],(name,str(row[name]),e[name])
 for name in ['decimal_text','empty_text','note','nul_text','stamp']:
  assert row[name]==e[name],(name,repr(row[name]),repr(e[name]))
 assert row['null_text'] is None
 assert row['empty_text']=='' and row['empty_text'] is not None
 assert row['binary_data']==bytes.fromhex(e['binary_data'][2:])
 assert row['empty_binary']==b'' and row['empty_binary'] is not None
 assert row['virtual_value']==e['qty']*2 and row['stored_value']==e['qty']*3
# This records SQLite's numeric storage limit, not a serializer failure or a
# claim that SQLite NUMERIC supports precision equivalent to server DECIMAL.
numeric=actual[0]['decimal_numeric']
assert isinstance(numeric,float)
assert decimal.Decimal(str(numeric))!=decimal.Decimal(p['exactDecimal'])
c.execute('CREATE TABLE qa_composite(left_id INTEGER NOT NULL,scope TEXT NOT NULL,note TEXT,binary_data BLOB,null_text TEXT,empty_text TEXT,PRIMARY KEY(left_id,scope))')
for sql in p['compositeInsert']: c.execute(sql)
for sql in p['update']:
 assert c.execute(sql).rowcount==1, '复合主键更新必须且仅定位一行'
updated=c.execute('SELECT * FROM qa_composite WHERE left_id=? AND scope=?',(-9223372036854775808,p['scopeA'])).fetchone()
assert updated['note']==p['updatedNote']
assert updated['binary_data']==bytes.fromhex('ff0000')
assert updated['null_text'] is None and updated['empty_text']==''
assert c.execute('SELECT note FROM qa_composite WHERE left_id=? AND scope=?',(-9223372036854775808,p['scopeB'])).fetchone()[0]=='before B'
assert c.execute('SELECT note FROM qa_composite WHERE left_id=? AND scope=?',(9223372036854775807,p['scopeA'])).fetchone()[0]=='untouched'
assert c.execute('SELECT COUNT(*) FROM qa_rows').fetchone()[0]==4
assert c.execute('SELECT COUNT(*) FROM qa_composite').fetchone()[0]==3
print(json.dumps({'passed':True,'sqliteVersion':sqlite3.sqlite_version,'insertedRows':len(actual),'compositeUpdatedRows':1,'cases':['signed int64 and integers above JS safe range','exact Decimal text in TEXT','NULL vs empty string','apostrophe/newline/tab/backslash/NUL/UTF-8','binary including zero bytes and empty BLOB','generated columns omitted and recalculated','auto-increment copied rows','composite primary-key UPDATE isolation'],'numericLimit':{'storageType':'REAL','originalDecimal':p['exactDecimal'],'sqliteReadback':str(numeric),'note':'SQLite NUMERIC affinity converts this literal to approximate REAL; exact arbitrary-precision decimal storage is not claimed.'}},ensure_ascii=False))
`;
const result = spawnSync(process.env.DBFOLIO_PYTHON || 'python', ['-c', python], {
  input: JSON.stringify(payload), encoding: 'utf8', windowsHide: true,
});
if (result.error) throw result.error;
if (result.status !== 0) { process.stderr.write(result.stderr); throw Error('SQLite 行 SQL 真实往返验收失败'); }
const report = JSON.parse(result.stdout);
assert(report.passed);
fs.mkdirSync('.qa', { recursive: true });
fs.writeFileSync('.qa/grid61-row-sql-roundtrip.json', JSON.stringify(report, null, 2));
console.log('PASS 生产 serializeRowSql → SQLite 内存执行/回读：int64、Decimal文本、NULL/空串、转义/NUL/字节、生成列略过、自增新行、复合主键 UPDATE');
console.log('边界：SQLite NUMERIC 自身将超精度 Decimal 转为近似 REAL；仅 TEXT 路径保证该十进制文本逐字保留。');
