const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    for (const suffix of ['', '&zoom=2', '&dark', '&dark&zoom=2', '&oled', '&oled&zoom=2']) {
      await page.goto(`http://127.0.0.1:1425/scripts/fixtures/settings-preview.html?category=updates${suffix}`);
      const nav = page.getByRole('navigation', { name: '首选项分类' });
      for (const group of ['界面与操作', '数据与服务', '应用管理']) assert(await nav.getByRole('heading', { name: group }).isVisible());
      assert.equal(await nav.getByRole('button').count(), 9);
      for (const name of ['编辑器', '同步', '高级']) assert.equal(await nav.getByRole('button', { name, exact: true }).count(), 0);
      await page.getByText('当前版本：1.0.0-alpha.33', { exact: true }).waitFor();
      assert(!(await page.locator('[aria-label="更新代理"]').isVisible()));
      assert(!(await page.getByRole('button', { name: '打开更新文件夹', exact: true }).isVisible()));
      await page.getByRole('button', { name: '检查更新', exact: true }).click();
      await page.getByText('当前没有可用的新版本', { exact: true }).waitFor();
      await page.getByText('更新设置', { exact: true }).click();
      await page.getByRole('textbox', { name: '更新代理', exact: true }).fill('http://127.0.0.1:7897');
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await page.waitForFunction(() => window.calls.some(call => call.command === 'updater_preferences' && call.args.value.proxy === 'http://127.0.0.1:7897'));
      await page.getByText('更新设置', { exact: true }).click();
      await page.evaluate(() => { window.hasUpdate = true; });
      await page.getByRole('button', { name: '检查更新', exact: true }).click();
      await page.getByRole('button', { name: '下载 1.0.0-alpha.34', exact: true }).click();
      await page.getByRole('button', { name: '重启并更新至 1.0.0-alpha.34', exact: true }).waitFor();
      await page.getByText('下载完成，重启即可更新。', { exact: true }).waitFor();
      await page.getByRole('textbox', { name: '搜索设置', exact: true }).fill('分页');
      assert.equal(await nav.getByRole('button').count(), 1);
      await nav.getByRole('button', { name: '数据浏览', exact: true }).click();
      await page.getByRole('spinbutton', { name: '每页最大查询行数' }).waitFor();
      await page.getByRole('textbox', { name: '搜索设置', exact: true }).fill('不存在的设置');
      await page.getByText('没有匹配的设置', { exact: true }).waitFor();
      await page.getByRole('textbox', { name: '搜索设置', exact: true }).fill('');
      await nav.getByRole('button', { name: '关于', exact: true }).click();
      const aboutPage = page.getByRole('main', { name: '关于', exact: true });
      assert(await aboutPage.getByText('版本 1.0.0-alpha.33', { exact: true }).isVisible());
      assert.equal(await aboutPage.getByRole('listitem').count(), 3);
      await page.screenshot({ path: `.qa/settings-about${suffix.replaceAll('&', '-') || '-light'}.png` });
      for (const close of ['button', 'escape', 'outside']) {
        await page.evaluate(() => window.dispatchEvent(new Event('dw:about')));
        const dialog = page.getByRole('dialog', { name: '关于 DBFolio', exact: true });
        await dialog.waitFor();
        await dialog.evaluate(async element => { await Promise.all(element.getAnimations({ subtree: true }).filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))); });
        const baseline = await dialog.evaluate(element => element.offsetWidth);
        await page.evaluate(() => {
          window.closingFrames = []; window.recordClosing = true;
          const frame = () => { const dialog = document.querySelector('.dw-about-dialog'); if (dialog) window.closingFrames.push({ width: dialog.offsetWidth, text: dialog.textContent }); if (window.recordClosing) requestAnimationFrame(frame); }; requestAnimationFrame(frame);
        });
        if (close === 'button') await dialog.getByRole('button', { name: '关闭', exact: true }).click();
        else if (close === 'escape') await page.keyboard.press('Escape');
        else await page.mouse.click(4, 4);
        await dialog.waitFor({ state: 'detached' });
        const frames = await page.evaluate(() => { window.recordClosing = false; return window.closingFrames; });
        assert(frames.length > 0);
        assert(frames.every(frame => frame.width <= baseline + 1 && frame.text.includes('本版更新') && !frame.text.includes('我的布局')), `关闭尺寸/内容稳定 ${close}`);
      }
      await page.evaluate(() => window.dispatchEvent(new Event('dw:layouts')));
      const layout = page.getByRole('dialog', { name: '工作区布局', exact: true }); await layout.waitFor();
      await layout.getByRole('button', { name: '关闭', exact: true }).click(); await layout.waitFor({ state: 'detached' });
      assert(!(await page.evaluate(() => window.calls.some(call => /plugin:window\|(set_size|maximize|unmaximize)/.test(call.command)))));
      await nav.getByRole('button', { name: '软件更新', exact: true }).click();
      await page.screenshot({ path: `.qa/settings-updates${suffix.replaceAll('&', '-') || '-light'}.png` });
      console.log(`PASS ${suffix || 'light'}: grouped/searchable settings, compact update page, proxy/download, version/notes, button/Esc/outside close width, layout regression`);
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
