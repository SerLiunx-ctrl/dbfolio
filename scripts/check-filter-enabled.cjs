const { chromium } = require('C:/Users/zhangwq/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    for (const engine of ['mysql', 'postgres', 'sqlite']) {
      const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.goto(`http://127.0.0.1:1425/scripts/fixtures/filter-enabled.html?engine=${engine}`);
      const open = async () => { await page.getByRole('button', { name: /^筛选(?: \d+\/\d+)?$/, exact: true }).click(); await page.getByRole('button', { name: '应用筛选', exact: true }).waitFor(); };
      const checkbox = index => page.getByRole('checkbox', { name: `启用筛选条件 ${index}`, exact: true });
      const apply = async (enabled, total) => { await page.getByRole('button', { name: '应用筛选', exact: true }).click(); await page.getByRole('button', { name: `筛选 ${enabled}/${total}`, exact: true }).waitFor(); };
      await open();
      await page.getByText('筛选方案', { exact: true }).click();
      await page.getByRole('button', { name: '载入：旧方案', exact: true }).click();
      assert(await checkbox(1).isChecked()); assert(await checkbox(2).isChecked());
      await checkbox(2).uncheck();
      await apply(1, 2);
      let applied = await page.evaluate(() => window.applied);
      assert.equal(applied.filters.length, 2); assert.equal(applied.filters[1].enabled, false);
      await open();
      assert(!(await checkbox(2).isChecked()));
      assert.equal(await page.getByRole('combobox', { name: '输入或选择值', exact: true }).nth(1).inputValue(), '3');
      const rowHeight = await page.locator('.dw-filter-row').first().evaluate(element => element.getBoundingClientRect().height);
      assert(rowHeight <= 32, `compact row ${rowHeight}`);
      await page.evaluate(async () => { await Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))); });
      await page.screenshot({ path: `.qa/filter-enabled-${engine}.png` });
      await checkbox(1).uncheck();
      await apply(0, 2);
      await page.waitForFunction(() => window.calls.filter(call => call.command === 'query_execute').at(-1)?.args.sql.includes('WHERE') === false);
      await open();
      await checkbox(2).check();
      await page.getByRole('combobox').filter({ hasText: 'AND（全部条件）' }).click();
      await page.getByRole('option', { name: 'OR（任一条件）', exact: true }).click();
      await page.getByText('筛选方案', { exact: true }).click();
      await page.getByRole('textbox', { name: '筛选方案名称', exact: true }).fill('临时组合');
      await page.getByRole('button', { name: '保存方案', exact: true }).click();
      await page.getByRole('button', { name: '载入：临时组合', exact: true }).waitFor();
      const stored = await page.evaluate(() => JSON.parse(window.settings.get('productivity_library_v1')).filters.find(preset => preset.name === '临时组合'));
      assert.equal(stored.filters[0].enabled, false); assert.equal(stored.filters[1].enabled, true); assert.equal(stored.conjunction, 'or');
      await checkbox(1).check();
      await page.evaluate(() => window.reloadPresets());
      await page.getByRole('button', { name: '载入：临时组合', exact: true }).click();
      assert(!(await checkbox(1).isChecked())); assert(await checkbox(2).isChecked());
      await apply(1, 2);
      applied = await page.evaluate(() => window.applied); assert.equal(applied.conjunction, 'or');
      await open();
      await checkbox(1).check(); await apply(2, 2);
      await open();
      await page.getByRole('button', { name: '删除条件', exact: true }).first().click();
      assert.equal(await page.getByRole('checkbox', { name: /^启用筛选条件/ }).count(), 1);
      await page.getByRole('button', { name: '清空筛选', exact: true }).click();
      await page.getByRole('button', { name: '筛选', exact: true }).waitFor();
      assert.deepEqual(errors, []);
      console.log(`PASS ${engine}: legacy defaults, retained disabled values, reopen, all-off unfiltered query, enable, AND/OR, persistent presets, compact rows, delete/clear`);
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
