const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({channel:'msedge',headless:true});try{
 const page=await browser.newPage({viewport:{width:1200,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 for(const suffix of ['','&oled']){
  await page.goto('http://localhost:1425/scripts/fixtures/postgres-compat.html?engine=postgres'+suffix);
  const complex=page.getByRole('row').filter({hasText:'idx_partial'}),normal=page.getByRole('row').filter({hasText:'idx_normal'});
  assert(await complex.getByRole('button',{name:'编辑索引',exact:true}).isDisabled());assert(!(await normal.getByRole('button',{name:'编辑索引',exact:true}).isDisabled()));
  await complex.click({button:'right'});assert.equal(await page.getByRole('menuitem',{name:'编辑索引',exact:true}).getAttribute('aria-disabled'),'true');await page.keyboard.press('Escape');await page.mouse.click(900,600);
  const ddl=await page.evaluate(()=>window.ddl());assert(ddl.includes('INCLUDE (id) WHERE pid > 0'));assert(ddl.includes('REFERENCES "qa.dot"."parent"'));
  await page.getByRole('button',{name:'编辑已有外键',exact:true}).click();const dialog=page.getByRole('dialog');
  assert.equal(await dialog.getByRole('combobox',{name:'引用表',exact:true}).innerText(),'sales.parent');
  await dialog.getByRole('button',{name:'下一步：预览 SQL',exact:true}).click();
  await page.waitForFunction(()=>window.calls.some(c=>c.command==='ddl_preview'));const first=await page.evaluate(()=>window.calls.find(c=>c.command==='ddl_preview').args.spec);
  assert.equal(first.refSchema,'sales');assert.equal(first.refTable,'parent');assert.deepEqual(first.refColumns,['id']);
  await dialog.getByRole('button',{name:'上一步',exact:true}).click();
  await dialog.getByRole('combobox',{name:'引用表',exact:true}).click();assert(await page.getByRole('option',{name:'sales.parent',exact:true}).isVisible());await page.getByRole('option',{name:'public.parent',exact:true}).click();
  assert(await dialog.getByRole('button',{name:'下一步：预览 SQL',exact:true}).isDisabled());
  await new Promise(r=>setTimeout(r,250));await dialog.getByRole('combobox',{name:'引用列',exact:true}).click();
  assert.equal(await page.getByRole('menuitemcheckbox',{name:'id',exact:true}).count(),0,'旧 Schema 的异步列响应不能覆盖新选择');
  await page.getByRole('menuitemcheckbox',{name:'public_id',exact:true}).click();await page.keyboard.press('Escape');
  await dialog.getByRole('button',{name:'下一步：预览 SQL',exact:true}).click();const latest=await page.evaluate(()=>window.calls.filter(c=>c.command==='ddl_preview').at(-1).args.spec);
  assert.equal(latest.refSchema,'public');assert.deepEqual(latest.refColumns,['public_id']);
  console.log('PASS PostgreSQL'+suffix+': qualified same-name tables, reference-column reset/load, preserved edit schema, complex-index guard and original DDL');
 }
 await page.goto('http://localhost:1425/scripts/fixtures/postgres-compat.html?engine=mysql');await page.getByRole('button',{name:'编辑已有外键',exact:true}).click();
 const dialog=page.getByRole('dialog');await dialog.getByRole('combobox').filter({hasText:'CASCADE'}).click();assert.equal(await page.getByRole('option',{name:'SET DEFAULT',exact:true}).count(),0);await page.keyboard.press('Escape');
 assert.deepEqual(errors,[]);console.log('PASS MySQL: shared foreign-key UI hides unsupported SET DEFAULT');
}finally{await browser.close();}})().catch(error=>{console.error(error);process.exitCode=1;});
