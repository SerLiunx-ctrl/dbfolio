// 真实组件 + 隔离 IPC；不连接用户数据库。
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try {
  const page=await browser.newPage({viewport:{width:1500,height:900}}), errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  const button=name=>name==='执行当前语句'?page.locator('button').filter({hasText:'执行当前语句'}):page.getByRole('button',{name,exact:true});
  const pageNumber=()=>page.getByRole('textbox',{name:'页码',exact:true});
  const sizes=()=>page.getByRole('combobox',{name:'每页条数',exact:true});
  const waitRange=text=>page.locator('.dw-result-footer').getByText(text,{exact:true}).waitFor();
  const jump=async number=>{await pageNumber().fill(String(number));await pageNumber().press('Enter');};
  const calls=()=>page.evaluate(()=>window.calls.filter(c=>['query_execute','query_fetch_page','transaction_execute'].includes(c.command)));
  for(const mode of ['table','query']) for(const engine of ['mysql','postgres','sqlite']) {
   await page.goto(`http://127.0.0.1:1425/scripts/fixtures/pagination.html?mode=${mode}&engine=${engine}`);
   if(mode==='query') {await page.locator('.monaco-editor').waitFor();await button('执行当前语句').click();}
   await waitRange('第 1–50 行');assert(await button('首页').isDisabled());
   await button('下一页').click();await waitRange('第 51–100 行');
   let last=(await calls()).at(-1);assert.equal(last.args.limit,50);
   if(mode==='table'){assert(last.args.sql.includes('> 50'));assert.equal(last.args.offset,0);} else assert.equal(last.args.offset,50);
   await jump(3);await waitRange('第 101–125 行');assert(await button('下一页').isDisabled());
   last=(await calls()).at(-1);if(mode==='table'){assert.equal(last.args.offset,0);assert(last.args.sql.includes('> 100'));}else assert.equal(last.args.offset,100);
   const before=(await calls()).length;
   for(const invalid of ['0','-1','1.2','abc','999999999999999999999']){await pageNumber().fill(invalid);assert(await button('跳转').isDisabled());await pageNumber().press('Enter');}
   assert.equal((await calls()).length,before);
   await pageNumber().press('Escape');assert.equal(await pageNumber().inputValue(),'3');
   await sizes().selectOption('100');await waitRange('第 1–100 行');assert.equal(await pageNumber().inputValue(),'1');
   await button('下一页').click();await waitRange('第 101–125 行');
   await button('首页').click();await waitRange('第 1–100 行');
   // 失败时保留已加载数据与原页大小。
   await page.evaluate(()=>window.failNext=true);await sizes().selectOption('200');
   await page.getByText('模拟分页失败',{exact:true}).waitFor();await page.waitForFunction(()=>!document.querySelector('select[aria-label="每页条数"]').disabled);
   assert.equal(await sizes().inputValue(),'100');await waitRange('第 1–100 行');
   await page.evaluate(()=>window.failNext=true);await jump(3);
   await page.waitForFunction(()=>!document.querySelector('select[aria-label="每页条数"]').disabled);
   await page.waitForFunction(()=>document.querySelector('input[aria-label="页码"]').value==='1');
   await page.evaluate(()=>window.delay=350);await sizes().selectOption('50');
   assert(await sizes().isDisabled());assert(await button('下一页').isDisabled());
   await waitRange('第 1–50 行');await page.waitForFunction(()=>!document.querySelector('select[aria-label="每页条数"]').disabled);
   await page.evaluate(()=>window.delay=0);
   // 超出末尾、空表都不显示 1–0 这样的错误范围。
   await jump(20);await waitRange('本页无数据');assert.equal((await calls()).at(-1).args.offset,950); // 无游标页回退 OFFSET
   assert(await button('下一页').isDisabled());assert(!(await button('首页').isDisabled()));
   await button('首页').click();await waitRange('第 1–50 行');
   if(mode==='table') {
    // 真正双击编辑后，更换页大小必须经过未保存保护。
    await page.locator('.ag-cell[col-id="c1"]').first().dblclick();
    const editor=page.locator('.ag-cell-inline-editing input');await editor.fill('changed');await editor.press('Enter');
    await button('提交').waitFor();assert(!(await button('提交').isDisabled()));
    const count=(await calls()).length;await sizes().selectOption('100');
    await page.getByRole('dialog').getByText('存在未保存的修改',{exact:true}).waitFor();
    await button('取消').click();assert.equal((await calls()).length,count);assert.equal(await sizes().inputValue(),'50');
    await jump(2);await button('取消').click();assert.equal(await pageNumber().inputValue(),'1');assert.equal((await calls()).length,count);
    await sizes().selectOption('100');await button('放弃修改并继续').click();await waitRange('第 1–100 行');
    assert.equal(await button('提交').isDisabled(),true);
    await button('刷新数据').click();await waitRange('第 1–100 行');assert.equal((await calls()).at(-1).args.limit,100);
   } else {
    await button('开启事务').click();await button('提交事务').waitFor();
    await sizes().selectOption('100');await waitRange('第 1–100 行');assert.equal((await calls()).at(-1).command,'transaction_execute');
    await button('下一页').click();await waitRange('第 101–125 行');assert.equal((await calls()).at(-1).args.offset,100);
    await button('回滚事务').click();await button('开启事务').waitFor();assert(await sizes().isDisabled());
    await button('执行当前语句').click();await waitRange('第 1–100 行');assert.equal((await calls()).at(-1).args.limit,100);
    await page.evaluate(()=>window.script=true);await button('执行当前语句').click();
    await page.getByText(/脚本已完成 2 条/).waitFor();assert.equal(await page.getByRole('group',{name:'结果分页',exact:true}).count(),0);
    await page.evaluate(()=>window.script=false);await button('执行当前语句').click();await sizes().waitFor();
   }
   await page.evaluate(()=>window.total=0);
   if(mode==='table')await button('刷新数据').click();else await button('执行当前语句').click();
   await waitRange('暂无数据');assert(await button('下一页').isDisabled());assert(await button('首页').isDisabled());
   // 未执行自动 COUNT，也不写用户全局分页偏好。
   assert(!(await calls()).some(c=>/COUNT\s*\(/i.test(c.args.sql)));
   assert(!(await page.evaluate(()=>window.calls.some(c=>c.command==='settings_set'&&c.args.key==='query_page_size'))));
   console.log(`PASS ${mode}/${engine}: first/prev/next/jump, page sizes, keyset fallback, errors, busy, empty, dirty/transaction/script guards`);
  }
  // 快照菜单：保存、更新后比较、帮助、清除；全过程无写入。
  await page.goto('http://127.0.0.1:1425/scripts/fixtures/pagination.html?mode=table&theme=oled');await waitRange('第 1–50 行');
  const compare=()=>page.getByRole('button',{name:/^结果对比/});
  await compare().click();await page.getByRole('menuitem',{name:'将当前页保存为基准',exact:true}).click();
  await page.evaluate(()=>window.value='new');await button('刷新数据').click();await page.getByText('new1',{exact:true}).waitFor();
  await compare().click();await page.getByRole('menuitem',{name:'与基准对比',exact:true}).click();
  await page.getByRole('checkbox',{name:'id',exact:true}).check();await page.getByText(/新增 0 · 删除 0 · 修改 50 · 相同 0/).waitFor();await button('关闭').click();
  await compare().click();await page.getByRole('menuitem',{name:'对比说明',exact:true}).click();await page.getByText(/只比较两份已加载快照/).waitFor();await button('知道了').click();
  await compare().click();await page.getByRole('menuitem',{name:'清除对比基准',exact:true}).click();
  assert(!(await page.evaluate(()=>window.calls.some(c=>c.command==='grid_commit'))));
  // 主题/缩放/窄窗口：检查实际控件边界与截图。
  for(const theme of ['light','dark','oled']) for(const zoom of [1,2]) {
   await page.goto(`http://127.0.0.1:1425/scripts/fixtures/pagination.html?mode=table&theme=${theme}`);await waitRange('第 1–50 行');
   await page.evaluate(zoom=>{const root=document.querySelector('[data-pagination-root]');Object.assign(root.style,{width:(innerWidth/zoom)+'px',height:(innerHeight/zoom)+'px',transform:'scale('+zoom+')',transformOrigin:'top left'});},zoom);
   await pageNumber().waitFor();const footer=page.locator('.dw-result-footer');
   const bounds=await footer.boundingBox();assert(bounds.y+bounds.height<=900+1,'页脚必须在窗口内');
   for(const element of [sizes(),pageNumber(),button('首页'),button('下一页')]){const box=await element.boundingBox();assert(box.x>=bounds.x-1&&box.x+box.width<=bounds.x+bounds.width+1);assert(box.y>=bounds.y-1&&box.y+box.height<=bounds.y+bounds.height+1);}
   await page.screenshot({path:`.qa/alpha21-pagination-${theme}-${zoom}.png`});
  }
  assert.deepEqual(errors,[]);console.log('PASS snapshot menu, 3 themes, 100%/200% zoom, no writes/automatic counts, no page errors');
 } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
