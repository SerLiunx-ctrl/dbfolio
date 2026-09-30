const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const drop=async(page,names)=>page.evaluate(names=>window.emitSqliteDrop(names.map(name=>'C:\\数据库\\'+name)),names);
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  for(const theme of ['', '?oled']){
   await page.goto('http://localhost:1425/scripts/fixtures/sqlite-drop.html'+theme);
   await page.getByRole('button',{name:'手动新建'}).waitFor();
   const a=await page.locator('[data-sort-tab="a"]').boundingBox(),c=await page.locator('[data-sort-tab="c"]').boundingBox();
   await page.mouse.move(a.x+10,a.y+10);await page.mouse.down();await page.mouse.move(c.x+c.width-10,c.y+10,{steps:12});await page.mouse.up();
   assert.deepEqual(await page.locator('[data-sort-tab]').evaluateAll(els=>els.map(el=>el.dataset.sortTab)),['b','c','a']);
   await page.locator('[data-sort-tab="b"]').click({position:{x:8,y:8}});assert.equal(await page.locator('#selected-tab').innerText(),'b');
   await page.getByRole('button',{name:'关闭 c',exact:true}).click();assert.equal(await page.locator('[data-sort-tab="c"]').count(),0);
   await drop(page,['demo.db']);
   const dialog=page.getByRole('dialog');await dialog.waitFor();
   assert.equal(await page.getByPlaceholder('例如：本地 MySQL').inputValue(),'demo (2)');
   assert.equal(await dialog.getByPlaceholder(/database\.db/).inputValue(),'C:\\数据库\\demo.db');
   assert.equal(await dialog.getByText('SQLite',{exact:true}).count(),1);
   assert.equal((await page.evaluate(()=>window.calls.filter(c=>c.command==='session_create'))).length,0);
   await drop(page,['中文 空格.sqlite3']);
   await page.waitForFunction(()=>document.querySelector('input[placeholder="例如：本地 MySQL"]').value==='中文 空格');
   await page.getByPlaceholder('例如：本地 MySQL').fill('我指定的名称');
   await drop(page,['next.sqlite']);
   await page.waitForFunction(()=>[...document.querySelectorAll('input')].some(i=>i.value.endsWith('next.sqlite')));
   assert.equal(await page.getByPlaceholder('例如：本地 MySQL').inputValue(),'我指定的名称');
   await page.evaluate(()=>window.failSave=true);
   await dialog.getByRole('button',{name:'保存',exact:true}).click();await page.getByText('模拟保存失败',{exact:true}).waitFor();
   assert.equal(await page.getByPlaceholder('例如：本地 MySQL').inputValue(),'我指定的名称');
   await page.evaluate(()=>window.failSave=false);
   await dialog.getByRole('button',{name:'保存',exact:true}).click();await dialog.waitFor({state:'hidden'});
   const saved=await page.evaluate(()=>window.calls.filter(c=>c.command==='session_create').at(-1).args.input);
   assert.equal(saved.engine,'sqlite');assert.equal(saved.name,'我指定的名称');assert.equal(saved.filePath,'C:\\数据库\\next.sqlite');assert.equal(saved.host,null);
   await page.getByRole('button',{name:'编辑已有'}).click();await drop(page,['replace.db']);
   await page.getByText('请先完成或关闭当前对话框，再拖入数据库文件',{exact:true}).waitFor();assert.equal(await page.getByPlaceholder('例如：本地 MySQL').inputValue(),'demo');
   await dialog.getByRole('button',{name:'取消',exact:true}).click();await dialog.waitFor({state:'hidden'});
   await drop(page,['invalid.db']);await page.getByText('未识别为 SQLite 数据库',{exact:true}).waitFor();assert.equal(await dialog.count(),0);
   await drop(page,['one.db','two.db']);await page.getByText('请一次拖入一个 SQLite 数据库文件',{exact:true}).waitFor();assert.equal(await dialog.count(),0);
   const internal=await page.evaluate(()=>{const data=new DataTransfer();data.setData('application/x-workbench-tab','tab');const event=new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data});document.dispatchEvent(event);return event.defaultPrevented;});assert.equal(internal,false);
   await page.getByRole('button',{name:'手动新建'}).click();await page.evaluate(()=>window.delayInspect=true);await drop(page,['stale.db']);
   await dialog.getByRole('button',{name:'取消',exact:true}).click();await dialog.waitFor({state:'hidden'});await page.getByRole('button',{name:'手动新建'}).click();
   await page.getByText('会话编辑状态已变化，请重新拖入文件',{exact:true}).waitFor();assert.equal(await page.getByPlaceholder('例如：本地 MySQL').inputValue(),'');
   await page.evaluate(()=>window.delayInspect=false);await drop(page,['final.db']);await page.waitForFunction(()=>document.querySelector('input[placeholder="例如：本地 MySQL"]').value==='final');
   await page.waitForTimeout(400);await page.screenshot({path:`.qa/sqlite-drop${theme?'-oled':''}.png`});
  }
  assert.deepEqual(errors,[]);console.log('PASS SQLite 拖入填表、同名避让、中文路径、手动名称保留、保存/失败/取消、已有会话保护、多文件/无效文件、过期结果与内部拖动隔离（浅色/OLED）');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
