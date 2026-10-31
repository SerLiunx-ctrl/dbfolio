const {chromium}=require('playwright');const assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({channel:'msedge',headless:true});try{
 const p=await browser.newPage({viewport:{width:1600,height:950}});const errors=[];p.on('pageerror',e=>errors.push(e.message));
 const cell=(row,col)=>p.locator(`.ag-row[row-index="${row}"] .ag-cell[col-id="c${col}"]`).first();
 const open=async(col=1)=>{await p.getByRole('button',{name:'单元格详情',exact:true}).click();await cell(0,col).click();await p.locator('.dw-grid-inspector .monaco-editor').waitFor();await p.waitForFunction(()=>!document.querySelector('.dw-grid-inspector [role=progressbar]'));};
 const edit=async(text)=>{await p.locator('.dw-grid-inspector .monaco-editor').waitFor();await p.waitForTimeout(150);await p.evaluate(text=>window.editText(text),text);await p.waitForTimeout(100);};
 for(const engine of ['mysql','postgres','sqlite']){
  await p.goto(`http://127.0.0.1:1425/scripts/fixtures/grid-workbench.html?engine=${engine}`);await cell(0,1).waitFor();await open();
  await edit('42');assert.deepEqual((await p.evaluate(()=>window.grid.current.getChanges()))[0].changes[0],{column:'count',oldValue:['int',2],newValue:['int',42]});
  await edit('3.5');await p.getByRole('alert').filter({hasText:'整数'}).waitFor();assert(await p.getByRole('button',{name:'提交',exact:true}).isDisabled());
  await cell(1,3).click();assert.equal(await p.locator('.dw-inspector-meta strong').textContent(),'count');
  await p.getByRole('button',{name:'废弃无效输入'}).click();assert.equal(await p.evaluate(()=>window.editorText()),'42');
  await cell(0,2).click();await p.waitForFunction(()=>window.editorText()==='1.25');await edit('12345678901234567890.1234567890');
  await cell(0,3).click();await p.waitForFunction(()=>window.editorText()?.length>4000);assert((await cell(0,3).textContent()).includes('短预览'),'仅查看不把完整值留在网格');await edit('新的完整内容');
  const changes=await p.evaluate(()=>window.grid.current.getChanges());assert.equal(changes[0].changes[2].oldValue[1],'完整日志😀'.repeat(1000));assert.deepEqual(changes[0].changes[1].newValue,['decimal','12345678901234567890.1234567890']);
  assert.equal(await p.evaluate(()=>window.calls.filter(c=>['update_cell','grid_commit'].includes(c.c)).length),0,'详情编辑不得直接写数据库');
  await p.getByRole('button',{name:'放弃修改',exact:true}).click();assert.deepEqual(await p.evaluate(()=>window.grid.current.getChanges()),[]);
  await cell(0,1).click();await p.waitForFunction(()=>window.editorText()==='2');await edit('9');await p.getByRole('button',{name:'提交',exact:true}).click();assert.equal((await p.evaluate(()=>window.submitted))[0].changes[0].newValue[1],9);
  await p.getByRole('button',{name:'列管理',exact:true}).click();await p.getByRole('checkbox',{name:'显示列 notes',exact:true}).uncheck();await p.getByRole('combobox',{name:'冻结列 count',exact:true}).selectOption('left');await p.getByRole('button',{name:'上移列 amount',exact:true}).click();
  await p.keyboard.press('Escape');await p.waitForTimeout(400);assert.equal(await p.locator('.ag-header-cell[col-id="c3"]').count(),0);assert((await p.locator('.ag-header-cell[col-id="c1"]').boundingBox()).x<(await p.locator('.ag-header-cell[col-id="c0"]').boundingBox()).x,'冻结列位于其他数据列左侧');
  await p.reload();await cell(0,1).waitFor();await p.waitForTimeout(400);assert.equal(await p.locator('.ag-header-cell[col-id="c3"]').count(),0);assert((await p.locator('.ag-header-cell[col-id="c1"]').boundingBox()).x<(await p.locator('.ag-header-cell[col-id="c0"]').boundingBox()).x,'冻结列位于其他数据列左侧');
  await cell(0,2).click();await p.evaluate(()=>{window.clipboard='9.99\t{"k":2}';});assert.equal(await p.evaluate(()=>window.grid.current.pasteFromClipboard()),2);
  let pasted=(await p.evaluate(()=>window.grid.current.getChanges()))[0].changes;assert.deepEqual(pasted.map(c=>c.column),['amount','document']);
  await p.evaluate(()=>window.grid.current.copySelected());assert((await p.evaluate(()=>window.copied)).startsWith('2\t1\t9.99\t{"k":2}\t'),'复制跟随可见列顺序');await p.evaluate(()=>window.grid.current.discard());
  await p.getByRole('button',{name:'列管理',exact:true}).click();await p.getByRole('button',{name:'恢复默认',exact:true}).click();await p.keyboard.press('Escape');await p.locator('.ag-header-cell[col-id="c3"]').waitFor();await p.waitForTimeout(400);
  console.log(`PASS ${engine}: dock numeric/decimal/full baseline, invalid buffer guard, discard/commit staging, columns hide/pin/order/reset/persistence`);
 }
 for(const variant of ['readonly','noKey','badKey','result']){
  await p.goto(`http://127.0.0.1:1425/scripts/fixtures/grid-workbench.html?${variant}`);await cell(0,1).waitFor();await open(3);await p.locator('.dw-inspector-meta').filter({hasText:'只读'}).waitFor();assert.equal(await p.locator('.dw-grid-inspector input[type=checkbox]').isDisabled(),true);if(variant==='readonly')await p.waitForFunction(()=>window.editorText()?.length>4000);
  if(variant==='noKey'||variant==='badKey'||variant==='result')assert.equal(await p.evaluate(()=>window.calls.filter(c=>c.c==='cell_full_value').length),0);
  console.log(`PASS ${variant}: only supported reads, read-only inspector`);
 }
 for(const theme of ['light','dark','oled'])for(const zoom of [1,2]){
  await p.goto(`http://127.0.0.1:1425/scripts/fixtures/grid-workbench.html?theme=${theme}&zoom=${zoom}`);await cell(0,1).waitFor();await open();
  await p.getByRole('button',{name:'停靠右侧',exact:true}).click();let separator=p.getByRole('separator',{name:'调整单元格详情尺寸'});await separator.focus();await separator.press('ArrowLeft');await p.getByRole('button',{name:'停靠底部',exact:true}).click();await separator.focus();await separator.press('ArrowUp');
  const bounds=await p.locator('.dw-grid-inspector').boundingBox();assert(bounds.height>=140*zoom&&bounds.width>200);await p.screenshot({path:`.qa/alpha33-workbench-${theme}-${zoom}.png`});await p.getByRole('button',{name:'关闭单元格详情',exact:true}).click();assert.equal(await p.locator('.dw-grid-inspector').count(),0);
  console.log(`PASS ${theme} ${zoom*100}%: both docks, keyboard resize, close, screenshot`);
 }
 await p.goto('http://127.0.0.1:1425/scripts/fixtures/grid-workbench.html?slow&table=race');await cell(0,1).waitFor();await open(1);
 await cell(0,3).click();await cell(1,1).click();await p.waitForFunction(()=>window.editorText()==='4');await p.waitForTimeout(700);assert.equal(await p.evaluate(()=>window.editorText()),'4','迟到完整值不覆盖新选中单元格');
 await cell(0,6).click();await p.locator('.dw-grid-inspector input[type=checkbox]').check();await p.locator('.dw-grid-inspector input[type=checkbox]').uncheck();assert.deepEqual((await p.evaluate(()=>window.grid.current.getChanges()))[0].changes[0].newValue,['text','']);
 await cell(0,4).click();await p.waitForFunction(()=>window.editorText()==='{"a":1}');await edit('{"a":');assert(await p.getByRole('button',{name:'提交',exact:true}).isDisabled());await edit('{"a":2}');assert.deepEqual((await p.evaluate(()=>window.grid.current.getChanges()))[0].changes.find(c=>c.column==='document').newValue,['json','{"a":2}']);await p.getByRole('button',{name:'格式化 JSON',exact:true}).click();await p.waitForFunction(()=>window.editorText()?.includes('\n'));assert.deepEqual(JSON.parse((await p.evaluate(()=>window.grid.current.getChanges()))[0].changes.find(c=>c.column==='document').newValue[1]),{a:2});
 await cell(0,5).click();await p.waitForFunction(()=>window.editorText()==='0x0102');await edit('0x0');assert(await p.getByRole('button',{name:'提交',exact:true}).isDisabled());await edit('0x010203');assert.deepEqual((await p.evaluate(()=>window.grid.current.getChanges()))[0].changes.find(c=>c.column==='binary').newValue,['bytes','0x010203']);
 await p.goto('http://127.0.0.1:1425/scripts/fixtures/grid-workbench.html?late&table=late');await cell(0,1).waitFor();await p.getByRole('button',{name:'列管理',exact:true}).click();await p.getByRole('checkbox',{name:'显示列 notes',exact:true}).uncheck();await p.evaluate(()=>window.releaseSettings());await p.waitForTimeout(200);assert.equal(await p.locator('.ag-header-cell[col-id="c3"]').count(),0,'迟到偏好不覆盖用户调整');
 console.log('PASS displayed-column paste/copy, NULL vs empty string, JSON/hex validation, stale full read and late layout preferences');
 assert.deepEqual(errors,[]);
 }finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
