// 实际加载 AppToaster/useNotify 与动效样式，验证通知生命周期，不访问数据库。
const fs = require('node:fs');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.TOAST_UI_URL || 'http://127.0.0.1:1426/scripts/fixtures/toast.html';
const errors = [], results = [];
async function pageFor(browser, motion, theme = 'light') {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  page.on('pageerror', error => errors.push(error.message));
  if (motion === 'system-reduced') await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${base}?theme=${theme}${motion === 'system-reduced' ? '' : '&motion=' + motion}`);
  await page.waitForFunction(() => !!window.notify);
  return page;
}
const notify = page => page.evaluate(() => {
  window.notify.success('会话已创建', '测试数据库');
  window.notify.error({ code: 'E_NETWORK', message: '网络连接被拒绝' }, '连接失败');
});
(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  try {
    if (process.argv.includes('--baseline')) {
      // 使用已发布源码中的原始样式复现，记录被禁用的实际 Fluent 计时器。
      const original = cp.execFileSync('git', ['show', 'v1.0.0-alpha.56:src/motion.css'], { encoding: 'utf8' });
      await Promise.all(['full', 'reduced', 'off'].map(async motion => {
        const p = await pageFor(browser, motion);
        await p.addStyleTag({ content: original });
        await notify(p);
        await p.getByText('连接失败', { exact: true }).waitFor();
        const timers = await p.locator('[data-timer-status]').evaluateAll(es => es.map(e => ({ animation: getComputedStyle(e).animationName, duration: getComputedStyle(e).animationDuration })));
        await p.waitForTimeout(7600);
        const remaining = await p.locator('.fui-ToastContainer').count();
        assert.equal(remaining, motion === 'full' ? 0 : 2);
        if (motion !== 'full') {
          await p.evaluate(() => document.documentElement.dataset.motion = 'full');
          await p.waitForFunction(() => !document.querySelector('.fui-ToastContainer'), undefined, { timeout: 9000 });
        }
        results.push({ mode: 'baseline-' + motion, remaining, timers });
        await p.close();
      }));
    } else {
      for (const theme of ['light', 'dark']) await Promise.all(['full', 'reduced', 'off', 'system-reduced'].map(async motion => {
        const p = await pageFor(browser, motion, theme);
        await notify(p);
        await p.getByText('连接失败', { exact: true }).waitFor();
        const timers = await p.locator('[data-timer-status]').evaluateAll(es => es.map(e => getComputedStyle(e).animationName));
        assert(timers.every(name => name !== 'none'), '不可见功能计时不受动效开关影响');
        await p.waitForTimeout(4200);
        assert.equal(await p.getByText('会话已创建', { exact: true }).count(), 0);
        assert.equal(await p.getByText('连接失败', { exact: true }).count(), 1);
        await p.getByText('连接失败', { exact: true }).waitFor({ state: 'hidden', timeout: 4500 });
        await p.waitForFunction(() => !document.querySelector('.fui-ToastContainer'));
        results.push({ theme, motion, successAndErrorExpired: true });
        await p.close();
      }));
      const p = await pageFor(browser, 'off');
      await p.evaluate(() => window.notify.success('悬停计时测试'));
      const toast = p.locator('.fui-ToastContainer');
      await toast.hover();
      await p.waitForTimeout(3600);
      assert.equal(await toast.count(), 1, '悬停暂停');
      await p.locator('#outside').hover();
      await toast.waitFor({ state: 'hidden', timeout: 4500 });
      await p.evaluate(() => window.notify.error({ message: '长错误内容' }, '手动关闭测试'));
      await p.getByRole('button', { name: '关闭通知', exact: true }).click();
      await toast.waitFor({ state: 'hidden', timeout: 1500 });
      await p.evaluate(() => window.notify.success('焦点暂停测试'));
      await p.getByRole('button', { name: '关闭通知', exact: true }).focus();
      await p.waitForTimeout(3600);
      assert.equal(await toast.count(), 1, '键盘焦点暂停');
      await p.locator('#outside').focus();
      await toast.waitFor({ state: 'hidden', timeout: 4500 });
      await p.evaluate(() => { window.notify.success('后台到期测试'); window.dispatchEvent(new Event('blur')); });
      await toast.waitFor({ state: 'hidden', timeout: 5000 });
      await p.waitForFunction(() => !document.querySelector('.fui-ToastContainer'));
      await p.evaluate(() => window.dispatchEvent(new Event('focus')));
      assert.equal(await toast.count(), 0);
      await p.evaluate(() => { window.notify.error({ code: 'E_CANCELLED', message: '已停止后续处理' }); window.notify.success('另一条通知'); });
      await p.getByText('任务已取消', { exact: true }).waitFor();
      await p.getByRole('button', { name: '关闭通知', exact: true }).first().click();
      await p.waitForFunction(() => document.querySelectorAll('.fui-ToastContainer').length === 1);
      assert.equal(await toast.count(), 1, '只关闭当前通知');
      await p.getByRole('button', { name: '关闭通知', exact: true }).click();
      await toast.waitFor({ state: 'hidden', timeout: 1500 });
      // 通知已经显示时切换模式，也不能重置或停掉剩余时间。
      await p.evaluate(() => { document.documentElement.dataset.motion = 'full'; window.notify.success('切换动效测试'); });
      await toast.waitFor();
      await p.waitForTimeout(900);
      await p.evaluate(() => document.documentElement.dataset.motion = 'off');
      await toast.waitFor({ state: 'hidden', timeout: 4500 });
      results.push({ interaction: '悬停/离开、键盘焦点/离开、后台、手动关闭、取消与多通知、显示中切换动效', passed: true });
      await p.close();
    }
    assert.deepEqual(errors, []);
    const file = `.qa/toast57-${process.argv.includes('--baseline') ? 'baseline' : 'lifecycle'}.json`;
    fs.writeFileSync(file, JSON.stringify({ passed: true, results, errors }, null, 2));
    console.log(`PASS ${results.length} 组通知生命周期验收，结果 ${file}`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
