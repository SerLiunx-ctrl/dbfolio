const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  for(const theme of ['', '?oled&zoom=2']){
   await page.goto('http://127.0.0.1:1425/scripts/fixtures/updates.html'+theme);
   await page.getByText('当前版本：1.0.0-alpha.15',{exact:false}).waitFor();
   await page.getByRole('button',{name:'检查更新',exact:true}).click();await page.getByText('新版本 1.0.0-alpha.16',{exact:true}).waitFor();
   await page.getByRole('button',{name:'下载 1.0.0-alpha.16',exact:true}).click();
   const install=page.getByRole('button',{name:'重启并更新至 1.0.0-alpha.16',exact:true});await install.waitFor();
   await page.evaluate(()=>window.block('task'));await install.click();await page.getByRole('alert').filter({hasText:'请先等待'}).waitFor();
   assert(!await page.evaluate(()=>window.installed));
   await page.evaluate(()=>window.block(''));await install.click();
   await page.waitForFunction(()=>window.installed===true);
   assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command==='updater_install').length),1);
   await page.getByRole('dialog').waitFor({state:'hidden'});
   await page.waitForTimeout(300);
   await page.screenshot({path:'.qa/updates'+(theme?'-oled-2':'-light-1')+'.png',fullPage:true});
  }
  await page.goto('http://127.0.0.1:1425/scripts/fixtures/updates.html');
  await page.getByRole('button',{name:'检查更新',exact:true}).click();
  await page.getByRole('button',{name:'跳过此版本提醒',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.calls.find(c=>c.command==='updater_preferences').args.value.skipped),'1.0.0-alpha.16');
  await page.getByRole('button',{name:'检查更新',exact:true}).click();await page.evaluate(()=>window.slow=true);
  await page.getByRole('button',{name:'下载 1.0.0-alpha.16',exact:true}).click();
  await page.getByRole('button',{name:'取消任务',exact:true}).click();await page.getByRole('alert').filter({hasText:'下载已取消'}).waitFor();
  assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command==='updater_download').length),1);
  await page.evaluate(()=>window.failCheck=true);await page.getByRole('button',{name:'检查更新',exact:true}).click();await page.getByRole('alert').filter({hasText:'网络不可用'}).waitFor();
  await page.goto('http://127.0.0.1:1425/scripts/fixtures/updates.html');
  await page.getByRole('button',{name:'检查更新',exact:true}).click();await page.getByRole('button',{name:'下载 1.0.0-alpha.16',exact:true}).click();
  const install=page.getByRole('button',{name:'重启并更新至 1.0.0-alpha.16',exact:true});await install.waitFor();
  await page.evaluate(()=>window.block('edit'));await install.click();
  await page.getByRole('dialog').filter({hasText:'存在未保存的修改'}).waitFor();
  assert(!await page.evaluate(()=>window.installed));await page.getByRole('button',{name:'取消',exact:true}).click();
  assert(!await page.evaluate(()=>window.installed));
  await install.click();await page.getByRole('button',{name:'放弃修改并继续',exact:true}).click();await page.waitForFunction(()=>window.installed);
  assert(await page.evaluate(()=>window.discarded));
  assert.deepEqual(errors,[]);console.log('PASS light/OLED 100%/200%, check/download, skipped release, running-query install guard, cancellation and network failure');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
