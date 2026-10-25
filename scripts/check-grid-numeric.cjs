const { chromium } = require('C:/Users/zhangwq/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    for (const engine of ['mysql', 'postgres', 'sqlite']) {
      const page = await browser.newPage({ viewport: { width: 1700, height: 700 } });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`http://localhost:1425/scripts/fixtures/grid-numeric.html?engine=${engine}`);
      const names = ['id', 'count', 'amount', 'ratio', 'code', 'large', 'unsigned'];
      const cell = name => page.locator(`.ag-row[row-index="0"] .ag-cell[col-id="c${names.indexOf(name)}"]`);
      async function edit(name, text) {
        await cell(name).dblclick();
        const input = cell(name).locator('input');
        await input.fill(text);
        await input.press('Enter');
      }
      const changes = () => page.evaluate(() => window.grid.current.getChanges());
      await edit('count', ' +42 ');
      await edit('amount', ' 12345678901234567890.1234567890 ');
      await edit('ratio', ' 1.25e2 ');
      await edit('code', '0012');
      await edit('large', '9007199254740993');
      if (engine === 'mysql') await edit('unsigned', '18446744073709551615');
      let actual = Object.fromEntries((await changes())[0].changes.map(c => [c.column, c.newValue]));
      assert.deepEqual(actual, {
        count: ['int', 42], amount: ['decimal', '12345678901234567890.1234567890'], ratio: ['float', 125], code: ['text', '0012'], large: ['int', '9007199254740993'],
        ...(engine === 'mysql' ? { unsigned: ['uint', '18446744073709551615'] } : {}),
      });
      const before = await changes();
      for (const [name, value] of [['count', '3.5'], ['ratio', 'NaN'], ['amount', 'bad'], ['large', '9223372036854775808']]) {
        await edit(name, value);
        assert.deepEqual(await changes(), before, `${engine} ${name} rejects invalid input`);
      }
      if (engine === 'mysql') {
        await edit('unsigned', '-1');
        assert.deepEqual(await changes(), before);
      }
      await cell('count').click();
      await page.evaluate(() => { window.clipboard = '7\tinvalid'; });
      assert.equal(await page.evaluate(() => window.grid.current.pasteFromClipboard()), 0);
      assert.deepEqual(await changes(), before, 'invalid paste is atomic');
      await page.evaluate(() => { window.clipboard = ' 8 \t99.25\t2e2\t0007'; });
      assert.equal(await page.evaluate(() => window.grid.current.pasteFromClipboard()), 4);
      actual = Object.fromEntries((await changes())[0].changes.map(c => [c.column, c.newValue]));
      assert.deepEqual(actual.count, ['int', 8]);
      assert.deepEqual(actual.amount, ['decimal', '99.25']);
      assert.deepEqual(actual.ratio, ['float', 200]);
      assert.deepEqual(actual.code, ['text', '0007']);
      assert.deepEqual(await page.evaluate(() => window.detail(window.columns[1], ' +21 ')), ['int', 21]);
      assert.deepEqual(errors, []);
      console.log(`PASS ${engine}: double-click, NULL numeric, typed IPC changes, exact large numbers, rejection, atomic paste, detail editor`);
      await page.close();
    }
    const page = await browser.newPage();
    await page.goto('http://localhost:1425/scripts/fixtures/grid-numeric.html');
    await page.waitForFunction(() => window.parse);
    const result = await page.evaluate(() => {
      const parse = (canonical, text) => window.parse({ canonical }, text);
      const invalid = (canonical, text) => { try { parse(canonical, text); return false; } catch { return true; } };
      const checked = [];
      for (const bits of [8, 16, 24, 32, 64]) for (const unsigned of [false, true]) {
        const type = { kind: 'int', bits, unsigned };
        const min = unsigned ? 0n : -(1n << BigInt(bits - 1));
        const max = unsigned ? (1n << BigInt(bits)) - 1n : (1n << BigInt(bits - 1)) - 1n;
        const [tag, payload] = parse(type, max.toString());
        checked.push(tag === (unsigned ? 'uint' : 'int') && BigInt(payload) === max && BigInt(parse(type, min.toString())[1]) === min && invalid(type, (max + 1n).toString()) && invalid(type, (min - 1n).toString()));
      }
      return { checked, invalid: [' ', 'NaN', 'Infinity', '0x20', '1.2.3'].every(text => invalid({ kind: 'float', bits: 64 }, text)), float32: invalid({ kind: 'float', bits: 32 }, '1e39'), bool: parse({ kind: 'bool' }, ' true '), empty: parse({ kind: 'int', bits: 32, unsigned: false }, '') };
    });
    assert(result.checked.every(Boolean));
    assert(result.invalid && result.float32);
    assert.deepEqual(result.bool, ['bool', true]);
    assert.deepEqual(result.empty, ['null', null]);
    console.log('PASS signed/unsigned 8/16/24/32/64-bit boundaries, float grammar/overflow, bool, empty NULL');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
