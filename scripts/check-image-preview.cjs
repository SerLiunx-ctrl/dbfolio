const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1200,height:760}});
  for(const [engine,theme] of [['mysql','light'],['postgres','dark'],['sqlite','oled']]){
   await page.goto(`http://localhost:1425/scripts/fixtures/image-preview.html?engine=${engine}&theme=${theme}`);
   const first=page.locator('.ag-row[row-index="0"] [col-id="c1"]');
   await first.getByAltText('图片缩略图').waitFor();
   await page.waitForFunction(()=>document.querySelector('.ag-row[row-index="0"] img')?.naturalWidth===96);
   const stats=await page.evaluate(()=>({calls:window.calls.length,max:window.maxActive,pending:window.pending}));
   assert(stats.calls<30,'只读取可见候选单元格');assert(stats.max<=2,'自动读取并发有上限');assert.deepEqual(stats.pending,[]);
   await first.getByRole('button',{name:'查看图片',exact:true}).click();
   await page.getByRole('dialog').getByAltText('完整图片').waitFor();
   assert.equal(await page.getByAltText('完整图片').evaluate(e=>e.naturalWidth),640);
   await page.getByRole('button',{name:'原始尺寸',exact:true}).click();assert(await page.locator('.dw-image-original').count());
   await page.getByRole('button',{name:'原始文本',exact:true}).click();
   await page.getByRole('button',{name:'复制',exact:true}).click();
   await page.waitForFunction(()=>window.copied===window.images.png);
   assert(await page.evaluate(()=>window.calls.some(x=>x.c==='cell_full_value'&&x.a.maxChars===64*1024*1024)));
   assert(await page.evaluate(()=>!window.calls.some(x=>/update|commit/.test(x.c))));
   await page.getByRole('button',{name:'关闭',exact:true}).click();
   assert.equal(await page.locator('.ag-row[row-index="5"] img').count(),0,'解码失败回退原文');
   assert.equal(await page.locator('.ag-row[row-index="0"]').evaluate(e=>e.getBoundingClientRect().height),28,'图片不撑高行');
   await page.screenshot({path:`.qa/images-${engine}-${theme}.png`});
  }
  const checks=await page.evaluate(()=>{
   const {base64Image:p,isImageCandidate:c,IMAGE_TEXT_LIMIT:limit}=window.imageUtils;
   const {png,jpeg,webp}=window.images;
   return {png:!!p(png),jpeg:!!p(jpeg),webp:!!p(webp),raw:!!p(png.split(',')[1].replace(/(.{60})/g,'$1\n')),urlSafe:!!p(jpeg.split(',')[1].replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')),svg:p('data:image/svg+xml;base64,'+btoa('<svg/>')),url:p('https://example.org/a.png'),ordinary:p(btoa('ordinary business text')),large:p('A'.repeat(limit+1)),partial:p(png.slice(0,45)+'…'),candidate:c(['trunc',png.slice(0,500)+'…'])};
  });
  for(const key of ['png','jpeg','webp','raw','urlSafe','candidate'])assert.equal(checks[key],true,key);
  for(const key of ['svg','url','ordinary','large','partial'])assert.equal(checks[key],null,key);
  const edge=await page.evaluate(()=>{
   const p=window.imageUtils.base64Image;
   const bmp=new Uint8Array(58),d=new DataView(bmp.buffer);bmp[0]=66;bmp[1]=77;d.setUint32(2,58,true);d.setUint32(10,54,true);d.setUint32(14,40,true);d.setUint32(18,1,true);d.setUint32(22,1,true);d.setUint16(26,1,true);d.setUint16(28,24,true);
   const huge=atob(window.images.png.split(',')[1]).split('').map(c=>c.charCodeAt(0));new DataView(new Uint8Array(huge).buffer);huge[16]=0;huge[17]=1;huge[18]=0;huge[19]=0;
   return {gif:!!p('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'),bmp:!!p(btoa(String.fromCharCode(...bmp))),huge:p(btoa(huge.map(c=>String.fromCharCode(c)).join('')))};
  });assert(edge.gif&&edge.bmp);assert.equal(edge.huge.previewable,false);
  for(const suffix of ['&result','&nokey','&readonly']){
   await page.goto('http://localhost:1425/scripts/fixtures/image-preview.html?engine=sqlite'+suffix);
   await page.locator('.ag-row[row-index="1"] [col-id="c1"]').getByAltText('图片缩略图').waitFor();
   if(suffix!=='&readonly')assert.equal(await page.evaluate(()=>window.calls.length),0,'无主键/查询结果不补读');
   await page.locator('.ag-row[row-index="1"] [col-id="c1"]').getByRole('button',{name:'查看图片',exact:true}).click();
   await page.getByAltText('完整图片').waitFor();await page.getByRole('button',{name:'关闭',exact:true}).click();
  }
  await page.goto('http://localhost:1425/scripts/fixtures/image-preview.html?engine=sqlite');
  await page.waitForFunction(()=>window.calls.length>0);await page.evaluate(()=>window.refreshRows());
  await page.waitForTimeout(250);assert.equal(await page.getByAltText('图片缩略图').count(),0,'刷新后旧请求不得显示旧图片');
  console.log('PASS Base64 图片三引擎/三主题、截断限量补读、并发与可见范围、原图/原文复制、无主键/只读/查询结果、误识别和刷新竞态');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
