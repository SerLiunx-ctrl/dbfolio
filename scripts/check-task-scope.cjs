const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage();
    await page.goto('http://localhost:1425/scripts/fixtures/task-scope.html');
    await page.waitForFunction(() => window.start);
    await page.evaluate(() => { window.start('query_execute', 'q1'); window.start('transaction_execute', 'q2'); });
    await page.waitForFunction(() => window.activeSessionTasks('s').length === 2);
    assert(!await page.locator('.dw-task-trigger').evaluate(e => e.classList.contains('is-active')), '前台查询不点亮任务中心');
    await page.locator('.dw-task-trigger').click();
    await page.getByText('暂无任务', { exact: true }).waitFor();
    await page.evaluate(() => window.api.queryCancel('s', 'q1'));
    await page.waitForFunction(() => window.store.getState().tasks.length === 1);
    assert.equal(await page.evaluate(() => window.activeSessionTasks('s')[0].tabId), 'q2', '停止只作用于来源查询页');
    await page.evaluate(() => window.finish(window.store.getState().tasks[0].id, true));
    await page.waitForFunction(() => window.store.getState().tasks.length === 0);
    for (const command of ['query_fetch_page', 'query_explain', 'analysis_query', 'mongo_find', 'mongo_next', 'mongo_write', 'mysql_procedure_call']) {
      await page.evaluate(c => window.start(c), command);
      await page.waitForFunction(() => window.store.getState().tasks.length === 1);
      assert.equal(await page.getByRole('dialog').locator('section').count(), 0, command + ' 不出现在任务中心');
      await page.evaluate(() => window.finish(window.store.getState().tasks[0].id));
      await page.waitForFunction(() => window.store.getState().tasks.length === 0);
    }
    for (const command of ['import_csv', 'export_sql', 'query_ai', 'generation_write', 'sync_execute_data', 'mongo_create_index']) {
      await page.evaluate(c => window.start(c), command);
    }
    await page.waitForFunction(() => window.activeSessionTasks('s').length === 6);
    await page.waitForFunction(() => document.querySelectorAll('[role="dialog"] section').length === 6);
    await page.evaluate(() => window.store.getState().tasks.forEach(t => window.finish(t.id)));
    await page.waitForFunction(() => window.activeSessionTasks('s').length === 0);
    assert.equal(await page.evaluate(() => window.store.getState().tasks.length), 6, '后台任务保留结束记录');
    await page.getByRole('button', { name: '清除已结束记录' }).click();
    assert.equal(await page.evaluate(() => window.store.getState().tasks.length), 0);
    console.log('PASS 前台查询不展示、连接保护仍有效、按来源取消、成功/失败/取消清理、后台任务保留记录');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
