const { chromium } = require('playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const errors = [];
  try {
    for (const suffix of ['', '&zoom=2', '&dark', '&dark&zoom=2', '&oled', '&oled&zoom=2']) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      page.on('pageerror', e => errors.push(e.message));
      await page.goto(`http://127.0.0.1:1425/scripts/fixtures/ai-settings.html?${suffix}`);
      const table = page.getByRole('table', { name: 'AI 模型配置' });
      await table.getByText('已有模型', { exact: true }).waitFor();
      assert.equal(await page.getByRole('textbox', { name: '配置名称' }).count(), 0);
      const row = table.getByRole('row').filter({ hasText: '已有模型' });
      await row.getByRole('button', { name: '编辑', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '编辑模型配置', exact: true });
      const model = dialog.getByRole('combobox', { name: '模型 ID', exact: true });
      await model.waitFor(); await model.locator('option[value="model-a"]').waitFor({ state: 'attached' });
      assert.equal(await model.inputValue(), 'legacy-model');
      assert.equal(await dialog.getByRole('textbox', { name: '手动填写模型 ID' }).count(), 0);
      assert.equal(await dialog.getByRole('combobox', { name: '思考等级', exact: true }).inputValue(), '');
      await model.selectOption('model-b');
      await dialog.getByRole('combobox', { name: '思考等级', exact: true }).selectOption('high');
      const max = dialog.getByRole('spinbutton', { name: '输出 token 上限' });
      await max.fill('128001'); assert(await dialog.getByRole('button', { name: '保存', exact: true }).isDisabled());
      await max.fill('128000');
      await dialog.getByRole('spinbutton', { name: '温度' }).fill('0');
      await dialog.getByRole('spinbutton', { name: 'Top P' }).fill('0.9');
      await dialog.screenshot({ path: `.qa/ai44-editor${suffix.replaceAll('&', '-') || '-light'}.png` });
      await page.evaluate(() => { window.failSave = true; });
      await dialog.getByRole('button', { name: '保存', exact: true }).click();
      await dialog.getByRole('alert').filter({ hasText: '模拟保存失败' }).waitFor();
      assert.equal(await max.inputValue(), '128000');
      await page.evaluate(() => { window.failSave = false; });
      await dialog.getByRole('button', { name: '保存', exact: true }).click(); await dialog.waitFor({ state: 'detached' });
      const saved = await page.evaluate(() => window.calls.filter(c => c.command === 'ai_save').at(-1).args);
      assert.equal(saved.key, null); assert.equal(saved.provider.maxTokens, 128000); assert.equal(saved.provider.reasoningEffort, 'high'); assert.equal(saved.provider.temperature, 0); assert.equal(saved.provider.topP, 0.9);
      await page.getByRole('textbox', { name: '搜索模型配置' }).fill('model-b'); assert.equal(await table.getByRole('row').count(), 2);
      await page.getByRole('textbox', { name: '搜索模型配置' }).fill('nothing'); await table.getByText('没有匹配的模型配置').waitFor();
      await page.getByRole('textbox', { name: '搜索模型配置' }).fill('');
      await page.getByRole('button', { name: '新增模型', exact: true }).click();
      const create = page.getByRole('dialog', { name: '新增模型配置', exact: true });
      await create.getByRole('textbox', { name: '配置名称' }).fill('备用模型');
      // An empty model list must allow manual entry without losing the current form.
      await page.evaluate(() => { window.modelMode = 'empty'; });
      await create.getByRole('button', { name: '获取模型', exact: true }).click();
      await create.getByRole('textbox', { name: '手动填写模型 ID' }).fill('custom-model');
      await create.getByRole('button', { name: '保存', exact: true }).click(); await create.waitFor({ state: 'detached' });
      const extra = table.getByRole('row').filter({ hasText: '备用模型' });
      await extra.getByRole('button', { name: '设为默认', exact: true }).click(); await extra.getByText('默认', { exact: true }).waitFor();
      await page.evaluate(() => { window.modelMode = 'fail'; });
      await extra.getByRole('button', { name: '编辑', exact: true }).click();
      await dialog.getByRole('textbox', { name: '手动填写模型 ID' }).waitFor();
      assert.equal(await dialog.getByRole('textbox', { name: '手动填写模型 ID' }).inputValue(), 'custom-model');
      await page.evaluate(() => { window.modelMode = 'ready'; });
      await dialog.getByRole('button', { name: '重新获取', exact: true }).click(); await dialog.getByRole('combobox', { name: '模型 ID' }).waitFor();
      await dialog.getByRole('textbox', { name: '配置名称' }).fill('不保存');
      await page.keyboard.press('Escape');
      await dialog.getByRole('button', { name: '继续编辑', exact: true }).click();
      await dialog.getByRole('button', { name: '废弃', exact: true }).click();
      await dialog.getByRole('button', { name: '废弃修改', exact: true }).click(); await dialog.waitFor({ state: 'detached' });
      assert.equal(await table.getByText('不保存', { exact: true }).count(), 0);
      await extra.getByRole('button', { name: '测试', exact: true }).click(); await page.getByText('「备用模型」测试通过', { exact: true }).waitFor();
      await extra.getByRole('button', { name: '删除', exact: true }).click();
      await page.getByRole('dialog', { name: '删除模型配置？', exact: true }).getByRole('button', { name: '删除', exact: true }).click();
      await extra.waitFor({ state: 'detached' });
      if (!suffix) {
        await page.evaluate(() => { window.modelMode = 'ready'; window.modelDelay = 700; });
        await row.getByRole('button', { name: '编辑', exact: true }).click();
        await dialog.getByRole('textbox', { name: '服务地址' }).fill('http://127.0.0.1:1234/second/v1');
        await page.evaluate(() => { window.modelDelay = 20; });
        await dialog.getByRole('button', { name: '获取模型', exact: true }).click();
        await dialog.getByRole('combobox', { name: '模型 ID' }).locator('option[value="second-model"]').waitFor({ state: 'attached' });
        await page.waitForTimeout(850);
        assert.equal(await dialog.getByRole('combobox', { name: '模型 ID' }).locator('option[value="model-a"]').count(), 0, '迟到的旧地址模型列表不得覆盖新地址');
        await dialog.getByRole('button', { name: '废弃', exact: true }).click();
        await dialog.getByRole('button', { name: '废弃修改', exact: true }).click(); await dialog.waitFor({ state: 'detached' });
        console.log('PASS discovery request revision: old endpoint response ignored');
      }
      await page.screenshot({ path: `.qa/ai44-list${suffix.replaceAll('&', '-') || '-light'}.png` });
      console.log(`PASS ${suffix || 'light'}: list/search, dropdown/legacy, bounds/128000/options, failure retention, empty/error fallback/retry, default/test/delete, dirty discard`);
      await page.close();
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
