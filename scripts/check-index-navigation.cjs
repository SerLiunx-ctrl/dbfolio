const assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:720}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  const target='名字.列"[]';
  const link=()=>page.getByRole('button',{name:'在结构中定位字段 '+target,exact:true});
  const checkRow=async(draft=false)=>{
   await page.getByRole('tab',{name:/结构/}).evaluate(e=>{if(e.getAttribute('aria-selected')!=='true')throw Error('未切换到结构');});
   const row=page.locator('.dw-column-located:visible');await row.waitFor();
   assert.equal(await row.getAttribute('data-column-name'),target);
   assert(await row.evaluate(e=>e===document.activeElement),'焦点落在整行');
   const rect=await row.boundingBox();assert(rect.y>=0&&rect.y+rect.height<=720,'长表目标滚动到视口');
   assert.equal(await row.getByRole('textbox').count(),0,'定位不进入编辑');
   assert.equal(await page.evaluate(()=>window.calls.filter(c=>/^(ddl_|query_|execute)/.test(c.command)).length),0,'定位不执行数据库写入或查询');
   assert.equal(await page.getByRole('table',{name:draft?'列草稿':'列信息'}).count(),1);
  };
  for(const engine of ['mysql','postgres','sqlite'])for(const theme of ['light','dark','oled']){
   await page.goto(`http://127.0.0.1:1425/scripts/fixtures/index-navigation.html?engine=${engine}&theme=${theme}`);
   await page.getByRole('table',{name:'索引信息'}).waitFor();
   assert.equal(await page.getByRole('button',{name:'在结构中定位字段 lower(column_1)',exact:true}).count(),0,'表达式无伪跳转');
   for(const zoom of [1,2]){
    await page.evaluate(z=>document.body.style.zoom=String(z),zoom);
    await link().focus();await page.keyboard.press(zoom===1?'Enter':' ');await checkRow();
    if(zoom===1&&theme==='dark')await page.screenshot({path:`.qa/index-navigation-${engine}.png`});
    await page.getByRole('tab',{name:/索引/}).click();
   }
   if(engine==='mysql'&&theme==='light'){
    await page.evaluate(()=>document.body.style.zoom='1');await link().click();await checkRow();
    await page.waitForTimeout(3200);assert.equal(await page.locator('.dw-column-located').count(),0,'高亮自动消退');
    await page.getByRole('tab',{name:/索引/}).click();await link().click();await checkRow();
    const cell=page.getByRole('cell',{name:target+' 字段名 单元格',exact:true});await cell.dblclick();
    await cell.getByRole('textbox').fill('pending_name');await cell.getByRole('textbox').press('Tab');
    await page.getByRole('tab',{name:/索引/}).click();await link().click();await checkRow();
    assert(await page.getByText('pending_name',{exact:true}).isVisible(),'保留未保存编辑');
    await page.getByRole('button',{name:'废弃',exact:true}).click();
    await page.evaluate(()=>window.switchTable());await page.getByRole('table',{name:'索引信息'}).waitFor();
    assert.equal(await page.locator('.dw-column-located').count(),0,'切表不遗留定位');
    await link().click();await checkRow();
   }
   console.log(`PASS ${engine}/${theme}: 名称精确定位、滚动、键盘与双缩放`);
  }
  for(const engine of ['mysql','postgres','sqlite']){
   await page.goto(`http://127.0.0.1:1425/scripts/fixtures/index-navigation.html?engine=${engine}&readonly`);
   await link().click();await checkRow();assert.equal(await page.getByRole('button',{name:'保存',exact:true}).count(),0);
   await page.goto(`http://127.0.0.1:1425/scripts/fixtures/index-navigation.html?engine=${engine}&draft`);
   await page.getByRole('tab',{name:/索引/}).click();await link().focus();await page.keyboard.press('Enter');await checkRow(true);
   assert.equal(await page.evaluate(()=>window.tabs.getState().tabs[0].draft.columns.length),70,'草稿不变');
   console.log(`PASS ${engine}: 只读及新建表草稿`);
  }
  await page.goto('http://127.0.0.1:1425/scripts/fixtures/index-navigation.html?engine=postgres&structure');
  await page.getByRole('table',{name:'列信息'}).waitFor();
  await page.getByRole('tab',{name:/索引/}).click();await link().click();await checkRow();
  await page.evaluate(()=>window.switchTable());
  await page.waitForFunction(()=>document.querySelector('.dw-table-heading')?.textContent.includes('other'));
  await page.waitForFunction(()=>!document.querySelector('.dw-column-located'));
  console.log('PASS 复用结构面板切表后立即清理高亮');
  assert.deepEqual(errors,[]);
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
