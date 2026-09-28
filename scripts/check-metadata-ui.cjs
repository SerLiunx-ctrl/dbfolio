// Run Vite on port 1425. Uses synthetic metadata in an isolated headless browser.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 700 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    const color = l => l.evaluate(e => getComputedStyle(e).color);
    const horizontal = async () => {
      const rows = page.locator('.dw-schema-action-row');
      for (let i = 0; i < await rows.count(); i++) {
        const buttons = rows.nth(i).getByRole('button');
        if (await buttons.count() !== 2) continue;
        const a = await buttons.nth(0).boundingBox(), b = await buttons.nth(1).boundingBox();
        assert(Math.abs(a.y - b.y) < 1 && b.x >= a.x + a.width, '操作按钮保持水平排列');
      }
    };
    for (const theme of ['light', 'dark', 'oled']) {
      await page.goto(`http://localhost:1425/scripts/fixtures/metadata-ui.html?theme=${theme}`);
      await page.getByRole('table', { name: '索引信息' }).waitFor();
      const numeric = theme === 'light' ? 'rgb(8, 111, 155)' : 'rgb(123, 205, 241)';
      assert.equal(await color(page.locator('.dw-metadata-column').first()), numeric);
      assert.notEqual(await color(page.getByText('主键', { exact: true })), await color(page.getByText('唯一', { exact: true })));
      assert.notEqual(await color(page.getByText('BTREE', { exact: true })), await color(page.getByText('HASH', { exact: true })));
      assert.equal(await page.locator('.dw-metadata-type').count(), 3);
      await horizontal();
      await page.getByRole('button', { name: 'foreignKeys', exact: true }).click();
      const ref = page.getByRole('row').filter({ hasText: 'fk_user' }).locator('td').nth(2);
      await ref.locator('.dw-metadata-type').waitFor();
      assert.equal(await color(ref.locator('.dw-metadata-column')), numeric);
      assert.equal(await page.evaluate(() => window.calls.filter(x => x.c === 'meta_table_detail' && x.a.table === 'users').length), 1, '引用表去重');
      assert.equal(await page.getByRole('row').filter({ hasText: 'fk_denied' }).locator('td').nth(2).locator('.dw-metadata-type').count(), 0, '无权限不猜测类型');
      assert.notEqual(await color(page.getByText('SET NULL', { exact: true })), await color(page.getByText('NO ACTION', { exact: true })));
      await horizontal();
      if (theme === 'oled') await page.screenshot({ path: '.qa/metadata-fk-oled.png' });
      await page.getByRole('button', { name: 'ddl', exact: true }).click();
      await page.waitForFunction(() => window.monaco.editor.getEditors().some(e => e.getModel()?.getLanguageId() === 'sql'));
      const check = await page.evaluate(() => {
        const m = window.monaco, e = m.editor.getEditors().find(e => e.getModel()?.getLanguageId() === 'sql');
        return { readonly: e.getOption(m.editor.EditorOption.readOnly), text: e.getValue(), height: e.getLayoutInfo().height };
      });
      assert(check.readonly && check.height > 400 && check.text.includes('CREATE TABLE'));
      await page.waitForFunction(() => new Set([...document.querySelectorAll('.view-line span')].map(e => getComputedStyle(e).color)).size >= 3);
      if (theme === 'oled') await page.screenshot({ path: '.qa/metadata-ddl-oled.png' });
    }
    for (const engine of ['sqlite', 'postgres']) {
      await page.goto(`http://localhost:1425/scripts/fixtures/metadata-ui.html?view=columns&engine=${engine}`);
      await page.getByRole('table', { name: '列信息' }).waitFor();
      for (const zoom of [0.8, 1, 1.25, 1.5]) {
        await page.evaluate(z => { document.body.style.zoom = String(z); }, zoom);
        await horizontal();
        const row = await page.getByRole('row').nth(1).boundingBox();
        assert(row.height <= 30 * zoom, '不因按钮堆叠撑高行');
      }
      await page.getByRole('button', { name: '添加列', exact: true }).click();
      await horizontal();
      await page.getByRole('button', { name: '取消', exact: true }).click();
      if (engine === 'sqlite') await page.screenshot({ path: '.qa/metadata-sqlite-actions.png' });
    }
    await page.goto('http://localhost:1425/scripts/fixtures/metadata-ui.html?view=foreignKeys');
    await page.waitForFunction(() => window.calls.some(x => x.c === 'meta_table_detail'));
    await page.evaluate(() => window.switchDatabase());
    await page.waitForTimeout(500);
    assert.equal(await page.getByRole('row').filter({ hasText: 'fk_user' }).locator('td').nth(2).locator('.dw-metadata-type').innerText(), 'datetime', '切换后忽略旧请求');
    assert.deepEqual(errors, []);
    console.log('PASS 索引/外键三主题配色、引用类型去重/失败/竞态、DDL SQL 高亮与只读、SQLite/PostgreSQL 操作横排及缩放');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
