const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try {
  const page=await browser.newPage({viewport:{width:1600,height:1000}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const text='<img src=x onerror=alert(1)> '+'完整日志😀'.repeat(400);
  for(const [engine,theme] of [['mysql','light'],['postgres','dark'],['sqlite','oled']]){
   for(const result of [false,true]){
    await page.goto(`http://localhost:1425/scripts/fixtures/image-preview.html?engine=${engine}&theme=${theme}${result?'&result':''}`);
    await page.waitForFunction(()=>!!window.setImage);
    await page.evaluate(text=>window.setImage(text),text);
    const cell=page.locator('.ag-row[row-index="0"] [col-id="c1"]');
    await page.waitForFunction(()=>document.querySelector('.ag-row[row-index="0"] [col-id="c1"]')?.textContent?.startsWith('<img'));
    assert((await cell.textContent()).length<=257,'长文本单行预览有界');
    assert.equal(await cell.locator('img').count(),0,'普通值不解析为 HTML');
    await cell.click({button:'right'});
    await page.getByRole('menuitem',{name:'复制单元格',exact:true}).click();
    assert.equal(await page.evaluate(()=>window.copied),text,'复制仍为完整原文');
    if(!result){
     await cell.dblclick();const editor=page.locator('.ag-cell-inline-editing input');
     assert.equal(await editor.inputValue(),text,'编辑器仍为完整原文');
     const png=await page.evaluate(()=>window.images.png);
     await editor.fill(png);await editor.press('Enter');
     await cell.getByAltText('图片缩略图').waitFor();
     assert.equal(await page.evaluate(()=>window.pending[0].changes.find(v=>v.column==='image_base64').newValue[1]),png,'编辑提交不使用预览截断值');
     // 刷新成普通值时应卸载图片组件。
     await page.evaluate(text=>window.setImage(text),text);
     await page.waitForFunction(()=>!document.querySelector('.ag-row[row-index="0"] img'));
    } else {
     await cell.click({button:'right'});await page.getByRole('menuitem',{name:'查看单元格详情',exact:true}).click();
     await page.getByRole('region',{name:'单元格详情',exact:true}).getByRole('button',{name:'复制',exact:true}).click();
     assert.equal(await page.evaluate(()=>window.copied),text,'详情仍为完整原文');
     await page.getByRole('button',{name:'关闭单元格详情',exact:true}).click();
    }
   }
  }
  assert.deepEqual(errors,[]);console.log('PASS 三引擎/三主题：原生文本、长文预览、完整编辑/复制/详情、文本切换图片与刷新');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
