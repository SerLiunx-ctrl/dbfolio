// 本地隔离 IPC fixture，验证真实组件，不连接用户数据库。
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try {
  const page=await browser.newPage({viewport:{width:1600,height:1000}}), errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  const visit=query=>page.goto('http://127.0.0.1:1425/scripts/fixtures/ui-polish.html?'+query);
  for(const engine of ['mysql','postgres','sqlite']) {
   await visit(`engine=${engine}&view=ddl&theme=oled`);
   await page.getByRole('button',{name:'复制 DDL',exact:true}).click();
   await page.waitForFunction(()=>window.copied?.includes('1919654707669256368'));
   await page.getByRole('button',{name:'在查询页打开',exact:true}).click();
   const draft=await page.evaluate(()=>window.workspace.getState().drafts[window.tabs.getState().activeId]);
   assert(draft.sql.includes('1919654707669256368'));assert.equal(draft.database,'test');
   assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command==='query_execute').length),0,'打开 DDL 不执行 SQL');
   await page.getByRole('button',{name:'更多表操作',exact:true}).click();
   assert(await page.getByRole('menuitem',{name:'新建分析',exact:true}).isVisible());
   assert.equal(await page.getByRole('menuitem',{name:'触发器',exact:true}).count(),engine==='mysql'?1:0);
   await page.keyboard.press('Escape');
   await visit(`engine=${engine}&view=data`);
   await page.getByRole('button',{name:'刷新数据',exact:true}).waitFor();
   await page.getByRole('button',{name:'刷新元数据',exact:true}).click();
   await page.getByRole('button',{name:'刷新数据',exact:true}).click();
   console.log(`PASS ${engine}: DDL copy/query draft without execution, capability menu, separate refresh actions`);
  }
  await visit('view=info');
  const auto=page.getByRole('textbox',{name:'自增起始值',exact:true});
  await auto.waitFor();assert.equal(await auto.inputValue(),'1919654707669256368');
  assert.equal(await page.getByRole('button',{name:'刷新元数据',exact:true}).count(),1);
  await page.getByRole('textbox',{name:'表注释',exact:true}).fill('只修改注释');
  await page.getByRole('button',{name:'预览修改',exact:true}).click();
  await page.waitForFunction(()=>window.calls.some(c=>c.command==='ddl_preview'));
  assert.deepEqual(await page.evaluate(()=>window.calls.find(c=>c.command==='ddl_preview').args.spec.options),{comment:'只修改注释'});
  assert(!(await page.evaluate(()=>window.calls.some(c=>c.command==='ddl_apply'))));
  console.log('PASS precision: exact decimal input; unrelated option preview excludes auto increment');
  for(const mode of ['grid','result']) {
   await visit('mode='+mode);
   const status=page.locator('.ag-header-cell[col-id="c1"]'), code=page.locator('.ag-header-cell[col-id="c2"]');
   await code.waitFor();const short=await status.boundingBox(),long=await code.boundingBox();assert(long.width>short.width+60);
   const handle=code.locator('.ag-header-cell-resize');const box=await handle.boundingBox();
   await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+75,box.y+box.height/2,{steps:5});await page.mouse.up();
   const resized=(await code.boundingBox()).width;await page.evaluate(()=>window.reloadRows());
   assert(Math.abs((await code.boundingBox()).width-resized)<2,'刷新行不能重置手动列宽');
   console.log(`PASS ${mode}: content/type widths and manual resize retained`);
  }
  for(const first of ['sessions','explorer']) {
   await visit('mode=grid&theme=oled');
   await page.evaluate(first=>window.dock.setState({layout:{sessions:'left',explorer:'left',first}}),first);
   const sessions=page.locator('.dw-sidebar').first(), explorer=page.locator('.dw-sidebar').nth(1);
   await page.getByRole('button',{name:'收起会话区',exact:true}).waitFor();const before=await sessions.boundingBox(),oldExplorer=await explorer.boundingBox();
   await page.getByRole('button',{name:'收起会话区',exact:true}).click();
   assert((await sessions.boundingBox()).height<=41);assert((await explorer.boundingBox()).height>oldExplorer.height+100);
   await page.getByRole('button',{name:'展开会话区',exact:true}).click();assert(Math.abs((await sessions.boundingBox()).height-before.height)<1);
   assert.equal(await page.evaluate(()=>window.settings.getState().sidebarSplit),.47);
   assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command==='settings_set').length),0);
  }
  await page.getByRole('button',{name:'控件状态',exact:true}).click();
  const surface=page.locator('.fui-PopoverSurface');await surface.waitFor();
  await surface.evaluate(async e=>{await Promise.all(e.getAnimations({subtree:true}).map(a=>a.finished.catch(()=>{})));});
  assert.equal(await surface.evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(18, 18, 18)');
  assert.equal(await page.getByRole('checkbox',{name:'未选中',exact:true}).evaluate(e=>getComputedStyle(e.parentElement.querySelector('.fui-Checkbox__indicator')).borderColor),'rgb(133, 133, 133)');
  await page.screenshot({path:'.qa/alpha20-oled-controls.png'});
  await page.keyboard.press('Escape');await page.getByRole('button',{name:'本会话全部页签',exact:true}).click();
  assert.equal(await page.getByRole('menuitem').count(),10);
  assert(await page.getByRole('menuitem').last().getByText('long_database_name_9',{exact:true}).isVisible());
  await page.getByRole('menuitem').last().click();assert.equal(await page.evaluate(()=>window.tabs.getState().activeId),'t9');
  console.log('PASS sidebar: both orders, collapse/restore without preference writes; OLED surface/checkbox contrast; overflow menu');
  await page.goto('http://127.0.0.1:1425/scripts/fixtures/settings-preview.html');
  const gallery=page.locator('.dw-style-gallery');assert.equal(await gallery.getAttribute('open'),null);
  const color=page.getByRole('radio',{name:'暗色',exact:true});await color.check();
  await gallery.locator('summary').click();const preview=page.locator('[data-preview="ocean"] .dw-style-preview');
  const dark=await preview.evaluate(e=>getComputedStyle(e).backgroundColor);
  await page.getByRole('radio',{name:'亮色',exact:true}).check();assert.notEqual(await preview.evaluate(e=>getComputedStyle(e).backgroundColor),dark);
  await page.getByRole('radio',{name:'纯黑（OLED）',exact:true}).check();assert.equal(await preview.evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(0, 0, 0)');
  await page.screenshot({path:'.qa/alpha20-appearance-oled.png'});
  console.log('PASS appearance: gallery collapsed; light/dark/OLED previews track selected mode');
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
