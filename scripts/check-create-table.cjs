const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');const assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({channel:'msedge',headless:true});try{
 const page=await browser.newPage({viewport:{width:1500,height:900}});
 for(const [engine,theme] of [['mysql','light'],['postgres','dark'],['sqlite','oled']]){
  await page.goto(`http://localhost:1425/scripts/fixtures/create-table.html?engine=${engine}&theme=${theme}`);
  await page.getByRole('textbox',{name:'表名',exact:true}).fill('children');
  assert.equal(await page.getByRole('dialog').count(),0);assert.equal(await page.getByRole('tab',{name:'数据',exact:true}).count(),0);
  if(engine!=='sqlite')await page.getByRole('textbox',{name:'表注释',exact:true}).fill('新建表测试');
  if(engine==='mysql'){await page.getByRole('combobox',{name:'引擎',exact:true}).selectOption('InnoDB');await page.getByRole('combobox',{name:'默认字符集',exact:true}).selectOption('utf8mb4');await page.getByRole('combobox',{name:'默认排序规则',exact:true}).selectOption('utf8mb4_bin');await page.getByRole('combobox',{name:'默认字符集',exact:true}).selectOption('');assert(!(await page.getByRole('combobox',{name:'默认排序规则',exact:true}).isDisabled()));await page.getByRole('combobox',{name:'默认字符集',exact:true}).selectOption('utf8mb4');await page.getByRole('combobox',{name:'默认排序规则',exact:true}).selectOption('utf8mb4_bin');}
  await page.getByRole('tab',{name:/结构/}).click();
  for(const [i,name] of ['id','parent_id','label'].entries()){
   await page.getByRole('button',{name:'添加列',exact:true}).click();const row=page.locator('table[aria-label="列草稿"] tbody tr').nth(i);
   assert.equal(await row.getByRole('textbox').count(),0,'默认无输入框');
   await row.locator('td').nth(1).dblclick();await row.getByRole('textbox').fill(name);await row.getByRole('textbox').press('Tab');
   if(i<2){await row.locator('td').nth(2).dblclick();await row.getByRole('combobox').selectOption(engine==='sqlite'?'integer':'bigint');await row.getByRole('combobox').press('Tab');}
   if(i===0){await row.getByRole('checkbox',{name:'id 主键',exact:true}).check();await row.getByRole('checkbox',{name:'id 自动增长',exact:true}).check();}
  }
  await page.getByRole('tab',{name:/索引/}).click();await page.getByRole('button',{name:'添加索引',exact:true}).click();
  await page.getByLabel('索引 1 名称',{exact:true}).dblclick();await page.getByLabel('索引 1 名称输入',{exact:true}).fill('idx_label');await page.getByLabel('完成编辑 索引 1 名称',{exact:true}).click();
  await page.getByLabel('索引 1 类型',{exact:true}).dblclick();await page.getByRole('combobox',{name:'索引 1 类型选择',exact:true}).selectOption('unique');await page.getByLabel('完成编辑 索引 1 类型',{exact:true}).click();await page.getByLabel('索引 1 列',{exact:true}).dblclick();await page.getByRole('combobox',{name:'索引 1 列选择',exact:true}).click();await page.getByRole('menuitemcheckbox',{name:'label',exact:true}).click();await page.getByLabel('完成编辑 索引 1 列',{exact:true}).click();
  await page.getByRole('tab',{name:/外键/}).click();await page.getByRole('button',{name:'添加外键',exact:true}).click();
  await page.getByLabel('外键 1 名称',{exact:true}).dblclick();await page.getByLabel('外键 1 名称输入',{exact:true}).fill('fk_parent');await page.getByLabel('完成编辑 外键 1 名称',{exact:true}).click();
  await page.getByLabel('外键 1 列',{exact:true}).dblclick();await page.getByRole('combobox',{name:'外键 1 列选择',exact:true}).click();await page.getByRole('menuitemcheckbox',{name:'parent_id',exact:true}).click();await page.getByLabel('完成编辑 外键 1 列',{exact:true}).click();
  await page.getByLabel('外键 1 引用表',{exact:true}).dblclick();await page.getByRole('combobox',{name:'外键 1 引用表选择',exact:true}).selectOption(JSON.stringify([engine==='postgres'?'public':'','parents']));await page.getByLabel('完成编辑 外键 1 引用表',{exact:true}).click();
  await page.getByLabel('外键 1 引用列',{exact:true}).dblclick();await page.getByRole('combobox',{name:'外键 1 引用列选择',exact:true}).click();await page.getByRole('menuitemcheckbox',{name:'id',exact:true}).click();await page.getByLabel('完成编辑 外键 1 引用列',{exact:true}).click();
  await page.getByRole('tab',{name:/结构/}).click();const parent=page.locator('table[aria-label="列草稿"] tbody tr').nth(1);await parent.locator('td').nth(1).dblclick();await parent.getByRole('textbox').fill('parent_new');await parent.getByRole('textbox').press('Tab');
  assert.equal(await page.evaluate(()=>window.tabs.getState().tabs[0].draft.foreignKeys[0].columns[0]),'parent_new');
  await parent.getByRole('button',{name:'删除列 parent_new',exact:true}).click();await page.getByRole('alert').filter({hasText:'请先从索引和外键中移除'}).waitFor();
  await page.screenshot({path:`.qa/create-table-${engine}-${theme}.png`});
  await page.getByRole('tab',{name:'DDL',exact:true}).click();await page.waitForFunction(()=>window.calls.some(c=>c.c==='ddl_preview'));
  assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.c==='ddl_apply').length),0,'草稿未保存不执行DDL');
  await page.getByRole('button',{name:'另建一张表',exact:true}).click();assert.equal(await page.getByRole('textbox',{name:'表名',exact:true}).inputValue(),'');
  await page.getByRole('button',{name:'新建表*',exact:true}).first().click();await page.getByRole('tab',{name:'信息',exact:true}).click();assert.equal(await page.getByRole('textbox',{name:'表名',exact:true}).inputValue(),'children');
  await page.getByRole('button',{name:'关闭页签',exact:true}).click();await page.getByRole('dialog').getByText('存在未保存的修改',{exact:true}).waitFor();await page.getByRole('button',{name:'取消',exact:true}).click();
  await page.evaluate(()=>window.failSave=true);await page.getByRole('button',{name:'保存',exact:true}).click();await page.getByRole('alert').filter({hasText:'模拟数据库拒绝建表'}).waitFor();assert.equal(await page.getByRole('tab',{name:'数据',exact:true}).count(),0);assert.equal(await page.getByRole('textbox',{name:'表名',exact:true}).inputValue(),'children');
  await page.evaluate(()=>window.failSave=false);await page.getByRole('button',{name:'保存',exact:true}).click();await page.getByRole('tab',{name:'数据',exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.tabs.getState().tabs[0].kind),'table');assert.equal(await page.evaluate(()=>window.saved.indexes.length),1);assert.equal(await page.evaluate(()=>window.saved.indexes[0].unique),true);assert.equal(await page.evaluate(()=>window.saved.foreignKeys[0].columns[0]),'parent_new');assert.equal(await page.evaluate(()=>window.tabs.getState().tabs[0].title),'children');await page.getByRole('button',{name:'新建表*',exact:true}).click();await page.getByRole('textbox',{name:'表名',exact:true}).fill('discard_me');await page.getByRole('button',{name:'关闭页签',exact:true}).click();await page.getByRole('button',{name:'放弃修改并继续',exact:true}).click();assert.equal(await page.evaluate(()=>window.tabs.getState().tabs.length),1);
 }
 await page.goto('http://localhost:1425/scripts/fixtures/create-table.html?engine=sqlite&readonly');assert(await page.getByRole('button',{name:'保存',exact:true}).isDisabled());
 console.log('PASS 三引擎建表页/三主题、双击行内字段、属性/索引/外键草稿、引用改名、切换保留、关闭保护、失败保留、保存后原页签转为表详情并显示数据、只读');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
