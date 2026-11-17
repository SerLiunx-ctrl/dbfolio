const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs');
(async()=>{const browser=await chromium.launch({channel:'msedge',headless:true});const results=[];try{
 const p=await browser.newPage({viewport:{width:1600,height:1000}}),errors=[];p.on('pageerror',e=>errors.push(e.message));
 const base=process.env.DBFOLIO_UI_URL||'http://127.0.0.1:1425';
 const grouped=async(group,name)=>{await p.getByRole('menuitem',{name:group,exact:true}).hover();await p.getByRole('menuitem',{name,exact:true}).click();};
 const cell=(r,c)=>p.locator(`.ag-row[row-index="${r}"] [col-id="c${c}"]`).first();
 const go=async(engine,extra='')=>{await p.goto(`${base}/scripts/fixtures/grid-workbench.html?clipboardRows&engine=${engine}${extra}`);await cell(0,0).waitFor();};
 const blank=async()=>{const box=await p.locator('.ag-root-wrapper').boundingBox();await p.mouse.click(box.x+250,box.y+240,{button:'right'});};
 const copy=async(r=0)=>{await cell(r,3).click({button:'right'});await grouped('复制','复制行');await p.waitForFunction(()=>typeof window.copied==='string');};
 for(const engine of ['mysql','postgres','sqlite','dameng']){
  await go(engine);await copy();assert((await p.evaluate(()=>window.copied)).includes('"第一行\n带\t制表和""引号"""'));
  await blank();await grouped('粘贴','粘贴为新行（待提交）');await cell(2,1).waitFor();await p.keyboard.press('Escape');
  let changes=await p.evaluate(()=>window.grid.current.getChanges());assert.equal(changes.length,1);assert.equal(changes[0].kind,'insert');
  const values=Object.fromEntries(changes[0].values.map(v=>[v.column,v.value]));assert(!('id'in values));assert.deepEqual(values.count,['int',2]);assert.deepEqual(values.nullable,['null',null]);assert.deepEqual(values.notes,['text','第一行\n带\t制表和"引号"']);assert.deepEqual(values.binary,['bytes','0x0102']);
  assert.equal(await p.evaluate(()=>window.calls.filter(v=>['grid_commit','update_cell'].includes(v.c)).length),0);
  await p.evaluate(()=>window.grid.current.discard());await copy(1);assert((await p.evaluate(()=>window.copied)).startsWith('2\t4\t'));
  await p.evaluate(()=>window.grid.current.pasteFromClipboard());await cell(2,1).waitFor();await p.keyboard.press('Escape');
  changes=await p.evaluate(()=>window.grid.current.getChanges());assert.deepEqual(changes[0].values.find(v=>v.column==='notes').value,['text','']);assert.deepEqual(changes[0].values.find(v=>v.column==='nullable').value,['text','']);
  await p.evaluate(()=>window.grid.current.discard());
  await p.evaluate(()=>{window.clipboard='\tbad-number\t1.25';});let failed=false;try{await p.evaluate(()=>window.grid.current.pasteAsRows());}catch{failed=true;}assert(failed);assert.deepEqual(await p.evaluate(()=>window.grid.current.getChanges()),[]);
  await cell(0,1).click();await p.evaluate(()=>{window.clipboard='42\t9.125';});assert.equal(await p.evaluate(()=>window.grid.current.pasteFromClipboard()),2);changes=await p.evaluate(()=>window.grid.current.getChanges());assert.deepEqual(changes[0].changes[0].newValue,['int',42]);assert.deepEqual(changes[0].changes[1].newValue,['decimal','9.125']);await p.evaluate(()=>window.grid.current.discard());
  await cell(0,3).click({button:'right'});await grouped('复制 SQL','复制为 INSERT 语句…');await p.getByRole('button',{name:'复制 SQL',exact:true}).click();await p.waitForFunction(()=>window.copied?.startsWith('INSERT INTO '));assert(!(await p.evaluate(()=>window.copied)).includes('(`id`, '));await p.getByRole('button',{name:'关闭',exact:true}).click();
  await cell(0,3).click({button:'right'});await grouped('复制 SQL','复制为 UPDATE 语句…');await p.getByRole('button',{name:'复制 SQL',exact:true}).click();await p.waitForFunction(()=>window.copied?.startsWith('UPDATE '));assert((await p.evaluate(()=>window.copied)).includes(' WHERE '));await p.getByRole('button',{name:'关闭',exact:true}).click();
  results.push({engine,appendTyped:true,blankMenu:true,rightClickTarget:true,emptyAndNullDistinct:true,autoIncrementOmitted:true,externalTypedOverwrite:true,atomicFailure:true,insertAndUpdatePreview:true,noImmediateWrite:true});console.log('PASS',engine,'行复制/空白菜单/追加/精确类型/SQL/原子校验');
 }
 for(const text of ['"abc"','"not closed','a\tb\n第二行']){
  await go('sqlite','&literalCell='+encodeURIComponent(text));await cell(0,3).click({button:'right'});await grouped('复制','复制单元格');await p.waitForFunction(text=>window.copied===text,text);
  await cell(1,3).click({button:'right'});await grouped('粘贴','粘贴到当前单元格');await p.waitForFunction(()=>window.grid.current.getChanges().length===1);const changes=await p.evaluate(()=>window.grid.current.getChanges());assert.equal(changes[0].changes.length,1);assert.deepEqual(changes[0].changes[0].newValue,['text',text]);
 }
 await go('sqlite','&manualKey');await cell(0,3).click({button:'right'});await p.getByRole('menuitem',{name:'复制为新行（待提交）',exact:true}).click();await cell(2,0).waitFor();await p.keyboard.press('Escape');await cell(2,0).dblclick();const editor=cell(2,0).locator('input');await editor.fill('9');await editor.press('Enter');assert.deepEqual((await p.evaluate(()=>window.grid.current.getChanges()))[0].values.find(v=>v.column==='id').value,['int',9]);
 await go('sqlite');await copy();await p.evaluate(()=>window.emptyRows());await p.waitForFunction(()=>!document.querySelector('.ag-row'));await blank();await grouped('粘贴','粘贴为新行（待提交）');await cell(0,1).waitFor();await p.keyboard.press('Escape');assert.equal((await p.evaluate(()=>window.grid.current.getChanges())).length,1);
 await go('sqlite');await p.evaluate(()=>{window.blockClipboard=true;window.clipboard='\t3';window.pastePromise=window.grid.current.pasteAsRows().then(()=>null,e=>String(e));});await p.waitForFunction(()=>!!window.releaseClipboard);await p.evaluate(()=>window.refresh());await p.waitForTimeout(100);await p.evaluate(()=>{window.blockClipboard=false;window.releaseClipboard();});assert((await p.evaluate(()=>window.pastePromise)).includes('目标已变化'));assert.deepEqual(await p.evaluate(()=>window.grid.current.getChanges()),[]);
 await go('sqlite','&readonly');await blank();assert.equal(await p.getByRole('menuitem',{name:'粘贴',exact:true}).count(),0);await p.keyboard.press('Escape');
 assert.deepEqual(errors,[]);fs.writeFileSync('.qa/grid61-ui.json',JSON.stringify({results,manualPrimaryKeyEditable:true,readOnlyProtected:true,rawCellQuotedMultilineRoundtrip:true,emptyTableAppend:true,stalePasteRejected:true,passed:true},null,2));
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
