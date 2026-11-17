const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs');
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try {
  const page=await browser.newPage({viewport:{width:1280,height:800}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));const base=process.env.DBFOLIO_UI_URL||'http://127.0.0.1:1425';
  const cell=(row,column)=>page.locator(`.ag-row[row-index="${row}"] .ag-cell[col-id="c${column}"]`).first();
  await page.goto(`${base}/scripts/fixtures/result-grid-clipboard.html?parent&noKey`);await cell(0,1).waitFor();
  await page.getByText('无主键 · 现有行只读，可新增',{exact:true}).waitFor();
  const add=page.getByRole('button',{name:'添加行',exact:true});assert(!(await add.isDisabled()),'无主键表应允许新增');
  await cell(0,1).dblclick();assert.equal(await page.locator('.ag-cell-inline-editing').count(),0,'已有无主键行应只读');
  assert(await page.getByRole('button').filter({hasText:/^删除行$/}).isDisabled(),'无主键已有行不可删除');
  await add.click();await cell(3,1).waitFor();const input=cell(3,1).locator('input');await input.fill('无主键新增');await input.press('Enter');
  await page.getByText('1 项待提交',{exact:true}).waitFor();await page.getByRole('button',{name:'提交',exact:true}).click();
  const preview=page.getByRole('dialog');await preview.getByRole('heading',{name:'提交数据修改 · test.records',exact:true}).waitFor();
  await page.waitForFunction(()=>window.calls.some(c=>c.command==='grid_preview_changes'));
  const requests=await page.evaluate(()=>window.calls.filter(c=>c.command==='grid_preview_changes'));
  assert(requests.length>0);for(const request of requests){assert.equal(request.args.changes.length,1);assert.equal(request.args.changes[0].kind,'insert');assert.deepEqual(request.args.changes[0].values.find(v=>v.column==='notes').value,['text','无主键新增']);}
  await preview.getByRole('button',{name:'SQL 预览',exact:true}).click();await preview.getByText(/INSERT INTO records/).waitFor();
  assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command==='grid_commit').length),0,'进入预览不应立即提交');
  assert(!requests.some(r=>r.args.changes.some(c=>c.kind==='update'||c.kind==='delete')));
  await preview.getByRole('button',{name:'取消',exact:true}).click();await page.getByRole('button',{name:'放弃修改',exact:true}).click();
  assert.equal(await page.locator('.ag-row').count(),3);assert.equal(await cell(0,1).textContent(),'甲\t引号"多\r\n行');
  console.log('PASS 无主键表新增进入单条INSERT预览，已有行不可更新/删除，无立即提交');

  fs.mkdirSync('.qa',{recursive:true});
  for(const theme of ['light','dark','oled'])for(const zoom of [1,2]) {
   await page.setViewportSize({width:1280,height:350});await page.emulateMedia({colorScheme:theme==='light'?'light':'dark'});
   await page.goto(`${base}/scripts/fixtures/result-grid-clipboard.html?parent&edgeRows&theme=${theme}&zoom=${zoom}`);await cell(0,1).waitFor();
   const grid=page.locator('.ag-root-wrapper');const gridBox=await grid.boundingBox();assert(gridBox);
   await cell(0,1).click();
   // Move the actual grid viewport to its final loaded row, then open at its visible edge.
   await page.mouse.move(gridBox.x+gridBox.width/2,gridBox.y+gridBox.height/2);await page.mouse.wheel(0,10000);await page.waitForTimeout(150);
   const visible=await page.locator('.ag-cell[col-id="c1"]').evaluateAll((nodes,limits)=>nodes.map(node=>{const b=node.getBoundingClientRect();return {row:node.closest('.ag-row')?.getAttribute('row-index'),x:b.left,y:b.top,width:b.width,height:b.height};}).filter(b=>b.y>limits.top&&b.y+b.height<limits.bottom),{top:gridBox.y,bottom:gridBox.y+gridBox.height-(zoom===2?40:22)});
   assert(visible.length>0);const target=visible.at(-1);
   const edgeCells=await page.locator(`.ag-row[row-index="${target.row}"] .ag-cell[col-id]`).evaluateAll(nodes=>nodes.map(node=>{const b=node.getBoundingClientRect();return {x:b.left,y:b.top,right:b.right,bottom:b.bottom};}).filter(b=>b.x<innerWidth-8&&b.right>8&&b.y>0&&b.bottom<innerHeight-5));
   const edge=edgeCells.sort((a,b)=>b.right-a.right)[0];assert(edge);
   const click={x:Math.min(edge.right-5,gridBox.x+gridBox.width-50),y:edge.bottom-5};assert(click.x>1200,'应在窗口右边界附近实际右击');
   const hit=await page.evaluate(point=>{const node=document.elementFromPoint(point.x,point.y);return{tag:node?.tagName,classes:node?.className,text:node?.textContent?.slice(0,120),cell:node?.closest('.ag-cell')?.getAttribute('col-id'),row:node?.closest('.ag-row')?.getAttribute('row-index')}},click);
   await page.mouse.click(click.x,click.y,{button:'right'});
   const menu=page.getByRole('menu',{name:'网格右键菜单',exact:true}).locator('..');try{await menu.waitFor({timeout:5000})}catch(error){await page.screenshot({path:'.qa/grid-context-boundary-failure.png'});fs.writeFileSync('.qa/grid-context-boundary-failure.json',JSON.stringify({theme,zoom,viewport:page.viewportSize(),gridBox,target,edge,click,hit,menus:await page.locator('[role="menu"]').count(),scroll:await page.locator('.ag-body-viewport').evaluateAll(nodes=>nodes.map(node=>({top:node.scrollTop,height:node.clientHeight,total:node.scrollHeight})))},null,2));throw error}const bounds=await menu.boundingBox();assert(bounds);
   assert(bounds.x>=0&&bounds.y>=0&&bounds.x+bounds.width<=1280.5&&bounds.y+bounds.height<=350.5,`${theme}/${zoom}: menu out of viewport ${JSON.stringify(bounds)}`);
   const scroll=await menu.evaluate(node=>({height:node.clientHeight,total:node.scrollHeight,overflow:getComputedStyle(node).overflowY}));assert(['auto','scroll'].includes(scroll.overflow));
   if(scroll.total>scroll.height){await menu.evaluate(node=>{node.scrollTop=node.scrollHeight;});assert((await menu.evaluate(node=>node.scrollTop))>0,'超过窗口高度的菜单应能滚动');}
   await page.waitForTimeout(200);await page.screenshot({path:`.qa/alpha61-context-menu-${theme}-${zoom}.png`});
   await page.setViewportSize({width:1280,height:400});
   await menu.getByRole('menuitem',{name:'复制 SQL',exact:true}).hover();
   await page.getByRole('menuitem',{name:'复制为 INSERT 语句…',exact:true}).click();
   const dialog=page.getByRole('dialog');await dialog.getByRole('heading',{name:'复制为 INSERT SQL',exact:true}).waitFor();
   await page.waitForFunction(()=>[...document.querySelectorAll('[role="dialog"] button')].some(button=>button.textContent==='复制 SQL'&&!button.disabled));
   const editor=dialog.locator('.monaco-editor');await editor.locator('.view-lines').waitFor();
   await page.waitForFunction(()=>!!document.querySelector('[role="dialog"] .monaco-editor .view-line')?.textContent?.trim());
   await page.waitForTimeout(350);
   let stable=false;
   for(let i=0;i<10;i++){const before=await dialog.boundingBox();await page.waitForTimeout(100);const after=await dialog.boundingBox();if(before&&after&&['x','y','width','height'].every(key=>Math.abs(before[key]-after[key])<0.5)){stable=true;break;}}
   assert(stable,'SQL弹窗应结束入场动画并保持稳定尺寸');
   assert(Number(await dialog.evaluate(node=>getComputedStyle(node).opacity))>=0.99,'SQL弹窗应完成不透明入场');
   const background=await dialog.evaluate(node=>getComputedStyle(node).backgroundColor);assert(!['transparent','rgba(0, 0, 0, 0)'].includes(background),'应初始化真实App palette，弹窗不应透明叠字');
   assert.match(await editor.locator('.view-lines').textContent(),/INSERT[\s\u00a0]+INTO/,'实际SQL内容已显示');
   const editorBounds=await editor.boundingBox();assert(editorBounds&&editorBounds.height>=150,'预览内容应有可读高度');
   for(const name of ['关闭','复制 SQL']){const button=dialog.getByRole('button',{name,exact:true});const b=await button.boundingBox();assert(b&&b.height>=22&&b.y>=0&&b.y+b.height<=400.5,`${theme}/${zoom}: SQL modal button clipped`);const font=await button.evaluate(node=>Number.parseFloat(getComputedStyle(node).fontSize));assert(font>=11,'SQL按钮字体应可读');}
   await page.screenshot({path:`.qa/alpha61-menu-${theme}-${zoom}.png`});await dialog.getByRole('button',{name:'关闭',exact:true}).click();
   console.log(`PASS ${theme} ${zoom*100}%: bottom/right menu clamp/scroll and readable SQL actions`);
  }
  assert.deepEqual(errors,[]);
 } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
