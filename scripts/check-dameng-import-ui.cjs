const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs');
(async()=>{const browser=await chromium.launch({headless:true,channel:'msedge'});try{
 const base=process.env.DBFOLIO_UI_URL||'http://localhost:1425';
 const page=await browser.newPage({viewport:{width:1280,height:850}}),errors=[];page.on('pageerror',e=>errors.push(e.message));fs.mkdirSync('.qa',{recursive:true});
 for(const theme of ['light','dark']){
  await page.goto(`${base}/scripts/fixtures/mysql-tools.html?engine=dameng${theme==='dark'?'&dark':''}`);
  await page.getByRole('combobox',{name:'模式',exact:true}).waitFor();
  const sessions=page.getByRole('combobox',{name:'会话',exact:true});
  assert.deepEqual(await sessions.locator('option').allTextContents(),['本机达梦','其他 MySQL']);
  await page.getByRole('button',{name:'文件',exact:true}).click();
  assert(!(await page.getByRole('menuitem',{name:'导入 SQL 文件…',exact:true}).isDisabled()));
  assert(await page.getByRole('menuitem',{name:'MySQL 数据库对象…',exact:true}).isDisabled());
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'选择 SQL 文件',exact:true}).click();await page.getByRole('button',{name:'预检文件',exact:true}).click();
  await page.getByText('目标模式：AGENT',{exact:true}).waitFor();await page.getByText('跳过客户端显示指令 SET ECHO OFF（第 3 行）。',{exact:true}).waitFor();
  assert(await page.getByRole('button',{name:'选择报告目录并执行',exact:true}).isDisabled());
  await page.getByRole('checkbox',{name:/确认向 AGENT.*模式切换/}).check();await page.getByRole('button',{name:'选择报告目录并执行',exact:true}).click();
  await page.getByText(/执行成功 3 条/).waitFor();const request=await page.evaluate(()=>window.calls.find(c=>c.command==='sql_import_preview').args.request);assert.equal(request.sessionId,'s');assert.equal(request.database,'AGENT');assert.equal(request.path,'C:/fixture.sql');
  await page.screenshot({path:`.qa/dameng-import-${theme}.png`});
  await sessions.selectOption('other');await page.getByRole('combobox',{name:'数据库',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'预检文件',exact:true}).count(),0,'换目标后不保留原文件预检');
 }
 await page.goto(`${base}/scripts/fixtures/mysql-tools.html?engine=dameng&readonly`);await page.getByRole('button',{name:'选择 SQL 文件',exact:true}).click();assert(await page.getByRole('button',{name:'预检文件',exact:true}).isDisabled());
 await page.getByText('只读会话不能导入 SQL 文件。',{exact:true}).waitFor();
 await page.goto(`${base}/scripts/fixtures/mysql-tools.html?engine=dameng`);await page.evaluate(()=>window.tabs.getState().openMysqlTool('s','AGENT','objects'));await page.getByRole('alert').filter({hasText:'不支持数据库对象管理'}).waitFor();assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command==='mysql_objects').length),0);
 assert.deepEqual(errors,[]);console.log('PASS 达梦导入浅色/深色、文件菜单权限、模式目标、指令提示、确认执行/报告、切换失效、只读保护、MySQL 对象管理隔离');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
