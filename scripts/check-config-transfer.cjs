const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  for(const theme of ['', '?oled&zoom=2']){
   await page.goto('http://127.0.0.1:1425/scripts/fixtures/config-transfer.html'+theme);
   await page.getByLabel('演示 mysql',{exact:true}).waitFor();
   await page.getByRole('button',{name:'全不选',exact:true}).click();
   await page.getByLabel('演示 sqlite',{exact:true}).check();
   await page.getByRole('button',{name:'导出所选配置…'}).click();
   await page.getByRole('status').waitFor();
   const options=await page.evaluate(()=>window.calls.find(c=>c.command==='config_export').args.options);
   assert.deepEqual(options.sessionIds,['s2']);
   await page.getByRole('button',{name:'导入配置',exact:true}).click();
   await page.evaluate(()=>window.invalidFile=true);
   await page.getByRole('button',{name:'选择配置文件…'}).click();await page.getByRole('alert').waitFor();
   assert.equal(await page.getByRole('button',{name:'预览导入',exact:true}).count(),0);
   await page.evaluate(()=>window.invalidFile=false);
   await page.getByRole('button',{name:'选择配置文件…'}).click();
   await page.getByRole('button',{name:'预览导入',exact:true}).click();
   await page.getByRole('button',{name:'确认导入…'}).waitFor();
   for(const kind of ['connection','tab','task']){await page.evaluate(kind=>window.setBlocked(kind),kind);await page.waitForFunction(()=>document.querySelector('button')!==null);assert(await page.getByRole('button',{name:'确认导入…'}).isDisabled());}
   await page.evaluate(()=>window.setBlocked('none'));
   await page.getByRole('button',{name:'确认导入…'}).click();
   await page.getByRole('button',{name:'取消',exact:true}).click();assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command==='config_import').length),0);
   await page.getByRole('combobox',{name:'重复处理'}).selectOption('merge');
   assert.equal(await page.getByRole('button',{name:'确认导入…'}).count(),0);
   await page.getByRole('button',{name:'全不选',exact:true}).click();await page.getByLabel('演示 sqlite',{exact:true}).check();
   await page.getByLabel('首选项',{exact:true}).uncheck();
   await page.getByRole('button',{name:'预览导入',exact:true}).click();await page.getByRole('button',{name:'确认导入…'}).waitFor();
   const args=await page.evaluate(()=>window.calls.filter(c=>c.command==='config_preview').at(-1).args);
   assert.equal(args.options.mode,'merge');assert.deepEqual(args.bundle.preferences,{});assert.equal(args.bundle.sessions.length,1);assert.equal(args.bundle.favorites.length,0);assert.equal(args.bundle.filters.length,0);assert.equal(args.bundle.analyses.length,0);assert.equal(args.bundle.relations.length,0);
   await page.screenshot({path:'.qa/config-transfer'+(theme?'-oled-200':'-light')+'.png',fullPage:true});
   await page.evaluate(()=>window.failImport=true);await page.getByRole('button',{name:'确认导入…'}).click();await page.getByRole('button',{name:'导入并刷新界面'}).click();await page.getByRole('alert').waitFor();
   assert.equal(await page.getByRole('button',{name:'确认导入…'}).count(),0);
   await page.evaluate(()=>window.failImport=false);await page.getByRole('button',{name:'预览导入',exact:true}).click();await page.getByRole('button',{name:'确认导入…'}).click();await page.getByRole('button',{name:'导入并刷新界面'}).click();
   await page.getByRole('button',{name:'导出所选配置…'}).waitFor();assert(await page.evaluate(()=>sessionStorage.getItem('imported')));
  }
  assert.deepEqual(errors,[]);console.log('PASS R05 UI: export selection, invalid file, preview invalidation, dependency filtering, active-work guards, cancel, failure and successful reload; light/OLED, 100%/200%.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
