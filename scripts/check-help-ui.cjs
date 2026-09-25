const assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'C:/Users/zhangwq/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
(async()=>{const browser=await chromium.launch({headless:true,channel:'msedge'});try{
 const page=await browser.newPage({viewport:{width:720,height:900}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://localhost:1425/scripts/fixtures/help-ui.html');
 const help=page.getByRole('button',{name:'模板变量说明',exact:true});
 for(let i=0;i<2;i++){
  assert.equal(await page.getByRole('tooltip').count(),0);
  await help.hover();await page.getByRole('tooltip').waitFor();
  assert((await page.getByRole('tooltip').innerText()).includes('同一行'));
  await page.keyboard.press('Escape');await page.getByRole('tooltip').waitFor({state:'hidden'});
  await page.getByRole('button',{name:'强调色说明'}).focus();await page.getByRole('tooltip').waitFor();
  assert((await page.getByRole('tooltip').innerText()).includes('点击应用'));
  await page.getByRole('button',{name:'切换主题'}).click();await page.mouse.move(0,0);
  await page.getByRole('tooltip').waitFor({state:'hidden'});
 }
 assert.equal(await page.getByLabel('文本模板',{exact:true}).inputValue(),'system:user:{uuid}');
 await page.screenshot({path:'.qa/help-ui-v127.png'});assert.deepEqual(errors,[]);
 console.log('通过：明暗主题、悬浮提示、键盘聚焦、Escape 关闭与原编辑控件保留');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
