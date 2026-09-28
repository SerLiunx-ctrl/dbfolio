const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1200,height:900}});
  await page.addInitScript(()=>{
   window.liveImageUrls=new Set();const create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL);
   URL.createObjectURL=b=>{const url=create(b);window.liveImageUrls.add(url);return url;};
   URL.revokeObjectURL=url=>{window.liveImageUrls.delete(url);revoke(url);};
  });
  await page.goto('http://localhost:1425/scripts/fixtures/image-preview.html?engine=sqlite');
  await page.waitForFunction(()=>window.setImage);
  await page.evaluate(()=>{
   const c=document.createElement('canvas');c.width=8000;c.height=4000;const ctx=c.getContext('2d');ctx.fillStyle='#126e82';ctx.fillRect(0,0,8000,4000);ctx.fillStyle='#fff';ctx.font='160px sans-serif';ctx.fillText('PNG 8000 × 4000',900,1900);
   window.highres=c.toDataURL();window.setImage(window.highres);c.width=1;c.height=1;
  });
  await page.waitForFunction(()=>document.querySelector('.ag-row img')?.naturalWidth===96);
  await page.getByRole('button',{name:'查看图片',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.dw-image-stage img')?.naturalWidth===2048);
  assert(await page.getByText('8000 × 4000 · PNG',{exact:true}).count());
  for(let i=0;i<3;i++){
   await page.getByRole('button',{name:'原始尺寸',exact:true}).click();
   await page.getByRole('button',{name:'适应窗口',exact:true}).click();
  }
  await page.waitForFunction(()=>document.querySelector('.dw-image-stage img')?.naturalWidth===2048);
  await page.screenshot({path:'.qa/image-highres-alpha5.png'});
  await page.getByRole('button',{name:'原始尺寸',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.dw-image-stage img')?.naturalWidth===8000);
  assert(await page.locator('.dw-image-original').evaluate(e=>e.scrollWidth>=8000));
  await page.getByRole('button',{name:'适应窗口',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.dw-image-stage img')?.naturalWidth===2048);
  await page.getByRole('button',{name:'导出原图',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.calls.filter(x=>x.c==='image_export').length),0,'取消保存不写文件');
  await page.evaluate(()=>window.exportPath='C:/temp/原图.png');
  await page.getByRole('button',{name:'导出原图',exact:true}).click();
  await page.waitForFunction(()=>window.exported);
  assert(await page.evaluate(()=>window.exported.base64===window.highres.split(',')[1]),'导出原始字节而非缩略图');
  assert(await page.evaluate(()=>window.calls.find(x=>x.c==='plugin:dialog|save').a.options.filters[0].extensions[0]==='png'));
  await page.evaluate(()=>window.exportError=true);
  await page.getByRole('button',{name:'导出原图',exact:true}).click();
  await page.getByText('模拟磁盘写入失败',{exact:true}).waitFor();
  await page.getByRole('button',{name:'关闭',exact:true}).click();
  // 旧版 8 Mi 字符限制和要求 IEND 位于文件末尾都会误拒绝此合法 PNG。
  await page.evaluate(()=>{
   window.large='data:image/x-png;charset=utf-8;base64,'+btoa(atob(window.images.png.split(',')[1])+'\0'.repeat(7*1024*1024));
   window.exportError=false;window.exported=null;window.setImage(window.large);
  });
  await page.waitForFunction(()=>document.querySelector('.ag-row img')?.naturalWidth===96);
  await page.getByRole('button',{name:'查看图片',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.dw-image-stage img')?.naturalWidth===640);
  await page.getByRole('button',{name:'导出原图',exact:true}).click();
  await page.waitForFunction(()=>window.exported);
  assert(await page.evaluate(()=>window.exported.base64===window.large.split(',')[1]));
  await page.getByRole('button',{name:'关闭',exact:true}).click();
  await page.evaluate(()=>window.refreshRows());
  await page.waitForFunction(()=>window.liveImageUrls.size===0);
  console.log('PASS PNG 3200万像素缩略图/适应窗口/原始尺寸、9Mi字符与PNG附加字节、MIME别名/参数、原图导出/取消/失败提示、Blob资源回收');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
