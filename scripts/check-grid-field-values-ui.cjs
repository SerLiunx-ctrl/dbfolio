const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const base = process.env.DBFOLIO_UI_URL || 'http://127.0.0.1:1426';
    const names = ['id', 'bit1', 'bit3', 'bit64', 'tiny', 'year_value', 'document', 'binary_value', 'note', 'amount'];
    const cell = name => page.locator(`.ag-row[row-index="0"] .ag-cell[col-id="c${names.indexOf(name)}"]`).first();
    const open = async (engine = 'mysql') => { await page.goto(`${base}/scripts/fixtures/grid-field-values.html?engine=${engine}`); await cell('bit1').waitFor(); };
    const changes = () => page.evaluate(() => window.grid.current.getChanges());
    const values = async () => Object.fromEntries((await changes())[0]?.changes.map(change => [change.column, change.newValue]) ?? []);
    const edit = async (name, text) => { await cell(name).dblclick(); const input = cell(name).locator('input'); await input.fill(text); await input.press('Enter'); };
    const model = async text => { await page.evaluate(text => window.editText(text), text); await page.waitForFunction(text => window.editorText() === text, text); };
    const pasteCurrent = async name => { await cell(name).click({ button: 'right' }); await page.getByRole('menuitem', { name: '粘贴', exact: true }).hover(); await page.getByRole('menuitem', { name: '粘贴到当前单元格', exact: true }).click(); };

    await open();
    await edit('bit1', '1'); await edit('bit3', '7'); await edit('bit64', '18446744073709551615'); await edit('tiny', '127'); await edit('year_value', '2155');
    assert.deepEqual(await values(), { bit1: ['uint', 1], bit3: ['uint', 7], bit64: ['uint', '18446744073709551615'], tiny: ['int', 127], year_value: ['uint', 2155] });
    let before = await changes();
    for (const [name, value] of [['bit1', '2'], ['bit1', '-1'], ['bit3', '8'], ['bit64', '18446744073709551616'], ['tiny', '128'], ['year_value', '1'], ['year_value', '1900']]) {
      await edit(name, value); assert.deepEqual(await changes(), before, `${name}无效输入保留上次有效值`);
    }
    await edit('bit1', ''); assert.deepEqual((await values()).bit1, ['null', null]);
    await edit('bit1', '0'); assert.equal((await values()).bit1, undefined, '0与原BIT0相等');
    console.log('PASS MySQL BIT inline0/1/NULL、BIT64精确最大值/溢出、tinyint显示宽度、YEAR防隐式转换');

    await open(); await cell('bit1').click();
    await page.evaluate(() => { window.clipboard = '1\t5\t9007199254740993'; });
    assert.equal(await page.evaluate(() => window.grid.current.pasteFromClipboard()), 3);
    assert.deepEqual(await values(), { bit1: ['uint', 1], bit3: ['uint', 5], bit64: ['uint', '9007199254740993'] });
    before = await changes();
    await page.evaluate(() => { window.clipboard = '0\t8\t1'; });
    assert.equal(await page.evaluate(() => window.grid.current.pasteFromClipboard()), 0);
    assert.deepEqual(await changes(), before, '外部TSV位宽错误应整批不变');
    await page.evaluate(() => window.typed([['bool', false], ['bytes', [7]], ['uint', '18446744073709551615']]));
    await pasteCurrent('bit1');
    await page.waitForFunction(() => window.grid.current.getChanges()[0]?.changes.some(change => change.column === 'bit64' && change.newValue[1] === '18446744073709551615'));
    assert.deepEqual(await values(), { bit3: ['uint', 7], bit64: ['uint', '18446744073709551615'] });
    before = await changes();
    await page.evaluate(() => window.typed([['bytes', [49]], ['uint', 1]]));
    await pasteCurrent('bit1');
    await page.getByText('粘贴失败，未修改任何单元格', { exact: true }).last().waitFor();
    assert.deepEqual(await changes(), before, '旧BIT ASCII字节副本不可错当数值1');
    console.log('PASS 外部TSV/typed bool与旧BIT bytes粘贴、BIT64精确值、错误原子拒绝');

    await open(); await cell('bit1').click();
    await page.getByRole('button', { name: '单元格详情', exact: true }).click();
    await page.locator('.dw-grid-inspector .monaco-editor').waitFor();
    await model('1'); await page.waitForFunction(() => window.grid.current.getChanges()[0]?.changes.some(change => change.column === 'bit1' && change.newValue[0] === 'uint' && change.newValue[1] === 1));
    before = await changes(); await model('2');
    await page.locator('.dw-inspector-error').waitFor(); assert.match(await page.locator('.dw-inspector-error').innerText(), /整数超出范围/);
    assert.deepEqual(await changes(), before, '详情无效值不覆盖有效UInt');
    await page.getByRole('button', { name: '废弃无效输入', exact: true }).click();
    await cell('bit64').click(); await page.waitForFunction(() => window.editorText() === '0');
    await model('18446744073709551615');
    await page.waitForFunction(() => window.grid.current.getChanges()[0]?.changes.some(change => change.column === 'bit64' && change.newValue[1] === '18446744073709551615'));
    await page.getByRole('checkbox', { name: 'NULL', exact: true }).check();
    assert.deepEqual((await values()).bit64, ['null', null]);
    await page.getByRole('checkbox', { name: 'NULL', exact: true }).uncheck();
    assert.deepEqual((await values()).bit64, ['uint', '18446744073709551615']);
    await model(''); await page.locator('.dw-inspector-error').waitFor();
    assert.deepEqual((await values()).bit64, ['uint', '18446744073709551615'], '详情空文本不隐式设NULL');
    console.log('PASS 真实CellInspector/Monaco编辑、精确BIT64、显式NULL、无效输入与空文本保护');

    await open();
    await edit('document', '{"large":9007199254740993}'); await edit('binary_value', '0x80ff');
    before = await changes();
    for (const [name, value] of [['document', '{'], ['document', '中文'], ['binary_value', '0x1'], ['binary_value', 'text']]) { await edit(name, value); assert.deepEqual(await changes(), before); }
    await cell('document').click(); await page.evaluate(() => { window.clipboard = '{}\t0x1'; });
    assert.equal(await page.evaluate(() => window.grid.current.pasteFromClipboard()), 0);
    assert.deepEqual(await changes(), before, 'JSON/binary外部粘贴使用相同严格校验');
    console.log('PASS JSON不重写大整数、binary完整字节、inline与外部粘贴拒绝无效内容');

    await open(); await edit('amount', '9999.9900');
    assert.deepEqual((await values()).amount, ['decimal', '9999.9900']);
    before = await changes();
    for (const value of ['10000', '1.234', '-1']) { await edit('amount', value); assert.deepEqual(await changes(), before, 'Decimal不静默舍入或截断'); }
    await edit('amount', '12300e-4'); assert.deepEqual((await values()).amount, ['decimal', '12300e-4']);
    await cell('amount').click(); before = await changes();
    await page.evaluate(() => { window.clipboard = '1.234'; });
    assert.equal(await page.evaluate(() => window.grid.current.pasteFromClipboard()), 0);
    assert.deepEqual(await changes(), before);
    await page.evaluate(() => window.typed([['decimal', '-0.01']])); await pasteCurrent('amount');
    await page.getByText('无符号十进制数不能为负数', { exact: true }).last().waitFor();
    assert.deepEqual(await changes(), before);
    await page.evaluate(() => window.typed([['decimal', '2.500']])); await pasteCurrent('amount');
    await page.waitForFunction(() => window.grid.current.getChanges()[0]?.changes.some(change => change.column === 'amount' && change.newValue[1] === '2.500'));
    await cell('amount').click(); await page.getByRole('button', { name: '单元格详情', exact: true }).click();
    await page.locator('.dw-grid-inspector .monaco-editor').waitFor(); await model('5.000');
    await page.waitForFunction(() => window.grid.current.getChanges()[0]?.changes.some(change => change.column === 'amount' && change.newValue[1] === '5.000'));
    before = await changes(); await model('5.001'); await page.locator('.dw-inspector-error').waitFor();
    assert.deepEqual(await changes(), before);
    console.log('PASS Decimal三个编辑入口精确文本、等值尾零/e表示、precision/scale/unsigned拒绝，详情保留有效值');

    for (const engine of ['postgres', 'sqlite']) {
      await open(engine); await edit('bit3', '001');
      assert.deepEqual((await values()).bit3, ['text', '001'], `${engine}同名BIT保留文本位宽`);
    }
    await open('dameng'); await edit('bit1', '1'); assert.deepEqual((await values()).bit1, ['bool', true]);
    assert.deepEqual(errors, [], '夹具不应出现页面异常');
    assert.equal(await page.evaluate(() => window.calls.some(call => call.command === 'grid_commit')), false, '编辑验收不写数据库');
    console.log('PASS PG/SQLite BIT位宽文本、DM BIT布尔值保持兼容，无grid_commit');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
