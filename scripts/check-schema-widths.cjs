const assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:720}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  const choose=async(kind,draft=false)=>{
   await page.getByRole('tab',{name:new RegExp(kind==='structure'?'结构':kind==='indexes'?'索引':'外键')}).click();
   return page.getByRole('table',{name:kind==='structure'?(draft?'列草稿':'列信息'):kind==='indexes'?(draft?'索引草稿':'索引信息'):(draft?'外键草稿':'外键信息'),exact:true});
  };
  const drag=async(table,label,distance)=>{
   const handle=table.getByRole('separator',{name:`调整${label}列宽`,exact:true});
   await handle.scrollIntoViewIfNeeded();
   const th=table.getByRole('columnheader',{name:label,exact:true}),before=await th.boundingBox(),box=await handle.boundingBox();
   await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
   await page.mouse.move(box.x+box.width/2+distance,box.y+box.height/2,{steps:8});await page.mouse.up();
   const after=await th.boundingBox();assert(Math.abs(after.width-before.width-distance)<4,`${label} 拖动距离准确：${before.width} -> ${after.width}`);
   assert.equal(await table.locator('thead th').count(),await table.getByRole('separator').count(),'每个表头都可调整');
   assert.equal(await table.locator('tbody tr').first().locator('td').count(),await table.locator('thead th').count());
   const index=await th.evaluate(e=>e.cellIndex),cell=await table.locator('tbody tr').first().locator('td').nth(index).boundingBox();
   assert(Math.abs(cell.width-after.width)<2,'表头与单元格对齐');
   assert.equal(await table.locator('tbody tr').first().locator('td').nth(index).evaluate(e=>getComputedStyle(e).overflowX),'hidden','内容不能越过相邻列');
   const scroll=await table.evaluate(e=>{let p=e.parentElement;while(p&&!['auto','scroll'].includes(getComputedStyle(p).overflowX))p=p.parentElement;return {exists:!!p,needed:!!p&&e.getBoundingClientRect().width>p.getBoundingClientRect().width,overflow:!!p&&p.scrollWidth>p.clientWidth};});
   assert(scroll.exists&&(!scroll.needed||scroll.overflow),'宽度超出容器时提供横向滚动');
   return {handle,th,after};
  };
  for(const engine of ['mysql','postgres','sqlite'])for(const theme of ['light','dark','oled']){
   await page.goto(`http://127.0.0.1:1425/scripts/fixtures/index-navigation.html?engine=${engine}&theme=${theme}`);
   for(const kind of ['structure','indexes','foreignKeys']){
    const table=await choose(kind);
    for(const zoom of [1,2]){
     await page.evaluate(z=>document.body.style.zoom=String(z),zoom);
     assert((await table.locator('thead tr').boundingBox()).height<=28*zoom,'表头保持紧凑行高');
     const label=zoom===1?'名称':kind==='structure'?'注释':kind==='indexes'?'列':'引用';
     const {handle,th}=await drag(table,label,90);
     const value=Number(await handle.getAttribute('aria-valuenow'));
     await handle.focus();await page.keyboard.press('ArrowRight');
     assert.equal(Number(await handle.getAttribute('aria-valuenow')),value+10,'方向键按 CSS 像素调整');
     await page.keyboard.press('Home');
     assert(Number(await handle.getAttribute('aria-valuenow'))<value+10,'恢复默认');
     if(zoom===2&&theme==='dark')await page.screenshot({path:`.qa/schema-widths-${engine}-${kind}.png`});
     assert((await th.boundingBox()).width>0);
    }
   }
   await page.evaluate(()=>document.body.style.zoom='1');
   console.log(`PASS ${engine}/${theme}: 结构/索引/外键、双缩放、对齐、裁切、键盘恢复`);
  }
  for(const engine of ['mysql','postgres','sqlite']){
   await page.goto(`http://127.0.0.1:1425/scripts/fixtures/index-navigation.html?engine=${engine}&draft`);
   for(const kind of ['structure','indexes','foreignKeys'])await drag(await choose(kind,true),'名称',70);
   const table=await choose('indexes',true);
   await table.getByRole('button',{name:'在结构中定位字段 名字.列"[]',exact:true}).click();
   await page.locator('.dw-column-located').waitFor();
   assert.equal(await page.evaluate(()=>window.tabs.getState().tabs[0].draft.columns.length),70,'调整不修改建表草稿');
   console.log(`PASS ${engine}: 三类草稿表、索引定位`);
  }
  await page.goto('http://127.0.0.1:1425/scripts/fixtures/index-navigation.html?engine=mysql&readonly');
  let table=await choose('indexes');let {handle,th}=await drag(table,'名称',110);
  const saved=(await th.boundingBox()).width;
  await page.waitForFunction(()=>window.calls.some(c=>c.command==='settings_set'));
  await page.reload();table=await choose('indexes');th=table.getByRole('columnheader',{name:'名称',exact:true});
  await page.waitForFunction(expected=>Math.abs(document.querySelector('th[data-schema-column=name]').getBoundingClientRect().width-expected)<2,saved);
  handle=table.getByRole('separator',{name:'调整名称列宽',exact:true});
  await handle.scrollIntoViewIfNeeded();const box=await handle.boundingBox(),before=(await th.boundingBox()).width;
  const writes=await page.evaluate(()=>window.calls.filter(c=>c.command==='settings_set').length);
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+80,box.y+box.height/2,{steps:6});
  await handle.dispatchEvent('pointercancel',{pointerId:1,bubbles:true});await page.mouse.up();
  assert(Math.abs((await th.boundingBox()).width-before)<2,'取消恢复原宽度');
  assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command==='settings_set').length),writes,'取消不保存');
  await handle.dblclick();assert.equal(Number(await handle.getAttribute('aria-valuenow')),260);
  await page.goto('http://127.0.0.1:1425/scripts/fixtures/index-navigation.html?engine=postgres&late');
  table=await choose('indexes');const resized=await drag(table,'名称',90);
  const actual=(await resized.th.boundingBox()).width;
  await page.evaluate(()=>window.releaseWidths(JSON.stringify({name:900})));
  await page.waitForTimeout(100);assert(Math.abs((await resized.th.boundingBox()).width-actual)<2,'延迟设置不覆盖用户拖动');
  assert.equal(await page.evaluate(()=>window.calls.filter(c=>/^(ddl_|query_)/.test(c.command)).length),0,'只保存界面偏好');
  await page.goto('http://127.0.0.1:1425/scripts/fixtures/index-navigation.html?engine=mysql&draft&holdSave');
  table=await choose('indexes',true);const pending=await drag(table,'名称',75),pendingWidth=(await pending.th.boundingBox()).width;
  await choose('structure',true);table=await choose('indexes',true);
  assert(Math.abs((await table.getByRole('columnheader',{name:'名称',exact:true}).boundingBox()).width-pendingWidth)<2,'保存未返回时切页仍保留列宽');
  await page.evaluate(()=>window.releaseSave());
  assert.deepEqual(errors,[]);
  console.log('PASS 列宽记忆、只读、取消、双击恢复、延迟偏好保护');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
