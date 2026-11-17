const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function fixture() {
  const state = { text: '', writes: [], failWrite: false, write: null, read: null };
  const api = {
    clipboardWriteText: async text => {
      if (state.failWrite) throw Error('模拟系统剪贴板写入失败');
      if (state.write) await state.write(text);
      state.text = text;
      state.writes.push(text);
    },
    clipboardReadText: async () => state.read ? state.read() : state.text,
  };
  const file = path.resolve('src/features/grid/rowClipboard.ts');
  const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
  });
  assert.equal(output.diagnostics?.length ?? 0, 0, '生产模块应能正确转译');
  const module = { exports: {} };
  new Function('require', 'exports', 'module', output.outputText)(name => {
    assert.equal(name, '../../ipc');
    return { api };
  }, module.exports, module);
  return { state, ...module.exports };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

(async () => {
  const clipboard = fixture();
  const { parseClipboardTsv: parse } = clipboard;
  for (const [text, expected] of [
    ['', []],
    ['a\tb\r\nc\td\r\n', [['a', 'b'], ['c', 'd']]],
    ['a\t\r\nb\t\t\r\n', [['a', ''], ['b', '', '']]],
    ['\t', [['', '']]],
    ['\n', [['']]],
    ['a\n\n', [['a'], ['']]],
    ['a\rb\r', [['a'], ['b']]],
    ['""\t""', [['', '']]],
    ['"a\tb"\t"多行\r\n内容"\t"双引号""内容"\r\n', [['a\tb', '多行\r\n内容', '双引号"内容']]],
    ['"""带引号"""\t untrimmed \t中"文', [['"带引号"', ' untrimmed ', '中"文']]],
  ]) assert.deepEqual(parse(text), expected, JSON.stringify(text));
  for (const text of ['"未闭合', 'a\t"未闭合\n', '"已结束"多余内容', '"a" "b"']) {
    assert.throws(() => parse(text), /剪贴板 TSV 格式无效/);
  }

  const columns = [
    { name: '空值', rawType: 'TEXT' }, { name: '空串', rawType: 'TEXT' },
    { name: '金额', rawType: 'DECIMAL(38,9)' }, { name: '大整数', rawType: 'BIGINT' },
    { name: '二进制', rawType: 'BLOB' }, { name: '文本', rawType: 'TEXT' },
    { name: '真假', rawType: 'BOOLEAN' }, { name: '结构', rawType: 'JSON' },
  ];
  const rows = [[
    ['null', null], ['text', ''], ['decimal', '12345678901234567890.123456789'],
    ['uint', '18446744073709551615'], ['bytes', [0, 127, 128, 255]],
    ['text', '中文\t制表符\n换行 "双引号"'], ['bool', false], ['json', { nested: ['原值'] }],
  ]];
  const expected = structuredClone({ columns, rows });
  const copying = clipboard.writeRowClipboard(columns, rows);
  columns[0].name = '修改源列'; rows[0][4][1][0] = 255; rows[0][7][1].nested[0] = '修改源值';
  assert.equal(await copying, 1);
  assert.deepEqual(await clipboard.readRowClipboard(), expected, '复制时立即固定原始类型和值');
  assert.deepEqual(parse(clipboard.state.text), [[
    '', '', '12345678901234567890.123456789', '18446744073709551615', '0x007f80ff',
    '中文\t制表符\n换行 "双引号"', 'false', '{"nested":["原值"]}',
  ]]);
  const result = await clipboard.readRowClipboard();
  result.columns[0].name = '改返回列'; result.rows[0][4][1][0] = 42; result.rows[0][7][1].nested.push('改返回值');
  assert.deepEqual(await clipboard.readRowClipboard(), expected, '读取返回副本，不能污染下一次粘贴');
  const oldText = clipboard.state.text;
  clipboard.state.text = '其他程序的内容';
  assert.equal(await clipboard.readRowClipboard(), null);
  clipboard.state.text = oldText;
  assert.equal(await clipboard.readRowClipboard(), null, '已观察到过期的副本不可重新激活');

  const one = [{ name: 'v', rawType: 'TEXT' }];
  await clipboard.writeRowClipboard(one, [[['text', 'cell']]]);
  await clipboard.writeCellClipboard('cell');
  assert.equal(await clipboard.readRowClipboard(), null, '相同文本的单元格复制也使行副本失效');
  await clipboard.writeRowClipboard(one, [[['null', null]]]);
  assert.equal(clipboard.state.text, '');
  assert.deepEqual((await clipboard.readRowClipboard()).rows, [[['null', null]]], '空文本剪贴板仍可区分真实 NULL');
  await clipboard.writeRowClipboard(one, [[['text', '']]]);
  assert.deepEqual((await clipboard.readRowClipboard()).rows, [[['text', '']]], '空字符串不能变成 NULL');
  const count = clipboard.state.writes.length;
  for (const tag of ['trunc', 'readonly']) {
    await assert.rejects(clipboard.writeRowClipboard(one, [[[tag, '仅预览部分']]]), /截断或只读扩展值/);
  }
  await assert.rejects(clipboard.writeRowClipboard(one, [[['float', NaN]]]), /非有限数值/);
  await assert.rejects(clipboard.writeRowClipboard(one, [[['bytes', [256]]]]), /二进制数据无效/);
  await assert.rejects(clipboard.writeRowClipboard(one, [[]]), /列数与复制列不一致/);
  assert.equal(clipboard.state.writes.length, count, '拒绝的数据不应覆盖系统剪贴板');
  assert.equal(await clipboard.writeRowClipboard(one, []), 0);
  assert.equal(clipboard.state.writes.length, count, '没有行时不改变剪贴板');
  clipboard.clearRowClipboard();
  assert.equal(await clipboard.readRowClipboard(), null);

  clipboard.state.failWrite = true;
  await assert.rejects(clipboard.writeRowClipboard(one, [[['text', '写入失败']]]), /模拟系统/);
  assert.equal(await clipboard.readRowClipboard(), null, '写系统剪贴板失败不能留下类型副本');
  clipboard.state.failWrite = false;
  await clipboard.writeRowClipboard(one, [[['text', '恢复']]]);
  assert.equal((await clipboard.readRowClipboard()).rows[0][0][1], '恢复', '一次写入失败不阻塞后续复制');

  const cells = fixture();
  for (const value of ['"abc"', '"未闭合', "'未闭合", 'a\tb', 'a\r\nb\nc', '"a\tb\n引号"', 'SELECT 1;\nSELECT 2;']) {
    await cells.writeCellClipboard(value);
    assert.equal(cells.state.text, value, '单元格复制写原始文本，不写 TSV 包装');
    assert.equal(await cells.readRowClipboard(), null, '单元格副本不是类型化行');
    assert.deepEqual(cells.parseClipboardTsv(value), [[value]], '本模块单元格来源不得剥引号或拆 tab/换行');
  }
  await cells.writeCellClipboard('');
  assert.deepEqual(cells.parseClipboardTsv(''), [], '空文本粘贴策略保持不变');
  await cells.writeCellClipboard('"abc"');
  cells.state.text = '外部内容';
  assert.equal(await cells.readRowClipboard(), null);
  cells.state.text = '"abc"';
  assert.deepEqual(cells.parseClipboardTsv(cells.state.text), [['abc']], '观察到外部变化后旧单元格缓存永久失效');
  await cells.writeCellClipboard('"abc"');
  assert.deepEqual(cells.parseClipboardTsv('a\tb'), [['a', 'b']], '不匹配内容继续使用标准外部 TSV');
  assert.deepEqual(cells.parseClipboardTsv('"abc"'), [['abc']], '解析不匹配文本也会永久清理单元格来源');
  await cells.writeCellClipboard('a\tb');
  await cells.writeRowClipboard([{ name: 'a', rawType: 'TEXT' }, { name: 'b', rawType: 'TEXT' }], [[['text', 'a'], ['text', 'b']]]);
  assert.deepEqual(cells.parseClipboardTsv(cells.state.text), [['a', 'b']], '相同文本的行复制覆盖单元格来源');
  assert.notEqual(await cells.readRowClipboard(), null);
  await cells.writeCellClipboard('"abc"');
  cells.state.failWrite = true;
  await assert.rejects(cells.writeCellClipboard('失败值'), /模拟系统/);
  assert.deepEqual(cells.parseClipboardTsv('"abc"'), [['abc']], '单元格写入失败不能残留旧来源');
  cells.state.failWrite = false;
  const sql = 'SELECT 1;\nSELECT 2;';
  await cells.writeCellClipboard(sql);
  await cells.writeTextClipboard(sql);
  assert.equal(await cells.readRowClipboard(), null);
  assert.deepEqual(cells.parseClipboardTsv(sql), [['SELECT 1;'], ['SELECT 2;']], 'SQL 普通文本复制不带单元格来源');
  await cells.writeCellClipboard('"abc"');
  cells.clearRowClipboard();
  assert.deepEqual(cells.parseClipboardTsv('"abc"'), [['abc']], '显式清理也移除单元格缓存');

  const serial = fixture(), gate = deferred(), started = deferred();
  serial.state.write = async text => { if (text === 'first') { started.resolve(); await gate.promise; } };
  const first = serial.writeRowClipboard(one, [[['text', 'first']]]);
  const last = serial.writeCellClipboard('last');
  await started.promise; gate.resolve(); await Promise.all([first, last]);
  assert.deepEqual(serial.state.writes, ['first', 'last'], '并发复制按发起顺序写入');
  assert.equal(await serial.readRowClipboard(), null, '旧异步行复制不能覆盖新的单元格副本');
  const oldCell = fixture(), cellGate = deferred(), cellStarted = deferred();
  oldCell.state.write = async text => { if (text === 'a\tb') { cellStarted.resolve(); await cellGate.promise; } };
  const cellWriting = oldCell.writeCellClipboard('a\tb');
  await cellStarted.promise;
  const rowWriting = oldCell.writeRowClipboard([{ name: 'a', rawType: 'TEXT' }, { name: 'b', rawType: 'TEXT' }], [[['text', 'a'], ['text', 'b']]]);
  cellGate.resolve(); await Promise.all([cellWriting, rowWriting]);
  assert.deepEqual(oldCell.parseClipboardTsv(oldCell.state.text), [['a', 'b']], '较早异步单元格写入不能覆盖后续行来源');
  assert.notEqual(await oldCell.readRowClipboard(), null);
  const clearedCell = fixture(), clearGate = deferred(), clearStarted = deferred();
  clearedCell.state.write = async () => { clearStarted.resolve(); await clearGate.promise; };
  const clearingWrite = clearedCell.writeCellClipboard('a\tb');
  await clearStarted.promise; clearedCell.clearRowClipboard(); clearGate.resolve(); await clearingWrite;
  assert.deepEqual(clearedCell.parseClipboardTsv('a\tb'), [['a', 'b']], '写入期间清理的单元格缓存不能复活');
  await serial.writeRowClipboard(one, [[['text', 'pending read']]]);
  const readGate = deferred(); serial.state.read = () => readGate.promise;
  const reading = serial.readRowClipboard(); serial.clearRowClipboard(); readGate.resolve(serial.state.text);
  assert.equal(await reading, null, '读取期间清理的副本不能复活');

  // Deterministic round trips exercise delimiter/quote combinations through the
  // real writer and parser; all IPC is local and never touches the host clipboard.
  let seed = 61;
  const alphabet = ['a', '中', ' ', '\t', '\r', '\n', '"', '0'];
  const random = n => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % n; };
  const roundtrip = fixture();
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const fields = Array.from({ length: 1 + random(6) }, () => Array.from({ length: random(18) }, () => alphabet[random(alphabet.length)]).join(''));
    const cols = fields.map((_, i) => ({ name: String(i), rawType: 'TEXT' }));
    await roundtrip.writeRowClipboard(cols, [fields.map(text => ['text', text])]);
    // A single empty field serializes as empty text; only the typed snapshot can
    // distinguish that row from an empty external clipboard.
    assert.deepEqual(parse(roundtrip.state.text), roundtrip.state.text === '' ? [] : [fields]);
    assert.deepEqual((await roundtrip.readRowClipboard()).rows, [fields.map(text => ['text', text])]);
  }
  console.log('PASS 行剪贴板：Excel TSV/100组往返、精确类型/深副本、单元格引号/tab/多行原样、SQL纯文本来源分离、过期/失败/清理/异步竞争');
})().catch(error => { console.error(error); process.exitCode = 1; });
