const { chromium } = require('C:/Users/zhangwq/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 700 } });
    const color = locator => locator.evaluate(el => getComputedStyle(el).color);
    for (const engine of ['mysql', 'postgres', 'sqlite']) {
      for (const theme of ['light', 'dark', 'oled']) {
        await page.goto(`http://localhost:1425/scripts/fixtures/column-flags.html?colors&engine=${engine}&theme=${theme}`);
        const expected = theme === 'light'
          ? ['rgb(8, 111, 155)', 'rgb(24, 115, 68)', 'rgb(133, 82, 173)', 'rgb(148, 80, 23)', 'rgb(152, 96, 34)']
          : ['rgb(123, 205, 241)', 'rgb(134, 216, 171)', 'rgb(210, 176, 245)', 'rgb(255, 188, 133)', 'rgb(239, 207, 134)'];
        for (const [name, group] of [['id', 0], ['text', 1], ['sample_0', 0], ['sample_1', 2], ['sample_2', 3], ['sample_3', 4], ['sample_4', 4]]) {
          const label = page.getByText(name, { exact: true });
          assert.equal(await color(label), expected[group], `${engine}/${theme}/${name}`);
          const row = label.locator('xpath=ancestor::tr');
          assert.equal(await color(row.locator('td').nth(2).locator('span').first()), expected[group]);
        }
        assert.equal(await page.getByRole('textbox').count(), 0);
        if (engine === 'mysql') {
          await page.getByRole('cell', { name: 'text 字段类型 单元格', exact: true }).dblclick();
          await page.getByRole('combobox', { name: 'text 字段类型', exact: true }).selectOption('int');
          await page.getByRole('combobox', { name: 'text 字段类型', exact: true }).press('Tab');
          assert.equal(await color(page.getByText('text', { exact: true })), expected[0]);
          assert.equal((await page.evaluate(() => window.calls)).length, 0, '修改类型仍仅暂存');
          await page.getByRole('button', { name: '废弃', exact: true }).click();
          assert.equal(await color(page.getByText('text', { exact: true })), expected[1]);
        }
        if (engine === 'mysql' && theme === 'oled') await page.screenshot({ path: '.qa/structure-colors-oled.png' });
      }
    }
    console.log('PASS 三引擎、浅色/深色/OLED 类型配色，以及双击编辑、暂存和废弃后颜色联动');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
