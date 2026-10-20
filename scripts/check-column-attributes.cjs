const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs'),ts=require('typescript');
const mod={exports:{}};
new Function('module','exports',ts.transpileModule(fs.readFileSync('src/features/table/createTableDraft.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText)(mod,mod.exports);
const {newColumn,updateColumnDraft,newTableState,draftSpec,updateDraftColumn}=mod.exports;
for(const engine of ['mysql','postgres','sqlite']){
 let c=newColumn(engine);c=updateColumnDraft(c,{defaultMode:'literal',defaultValue:undefined});assert.equal(c.defaultValue,'');
 c=updateColumnDraft(c,{defaultMode:'null'});c=updateColumnDraft(c,{primaryKey:true});assert.equal(c.defaultMode,'none');assert.equal(c.nullable,false);
 const state=newTableState(engine);state.properties.name=' items ';state.columns=[newColumn(engine,' old ')];state.indexes=[{name:'idx',unique:false,columns:[{name:' old '}]}];
 assert.equal(draftSpec(state,engine).indexes[0].columns[0].name,'old');
 assert.equal(updateDraftColumn(state,state.columns[0].id,{defaultMode:'literal',defaultValue:undefined}).columns[0].defaultValue,'');
}
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{
 const page=await browser.newPage({viewport:{width:1700,height:900}});
 const cell=(name)=>page.getByRole('cell',{name:`新增列 ${name} 单元格`,exact:true});
 const select=async(name,value)=>{await cell(name==='默认值模式'?'默认值':name).dblclick();await page.getByRole('combobox',{name:`新增列 ${name}`,exact:true}).selectOption(value);};
 const input=async(name,value)=>{await cell(name).dblclick();await page.getByRole('textbox',{name:`新增列 ${name}`,exact:true}).fill(value);await page.keyboard.press('Tab');};
 const start=async(engine,theme='light',extra='')=>{
  await page.goto(`http://localhost:1425/scripts/fixtures/column-flags.html?engine=${engine}&theme=${theme}${extra}`);
  await page.getByRole('button',{name:'添加列',exact:true}).click();
  await page.getByRole('textbox',{name:'新增列 字段名',exact:true}).fill(' index_progress \t');await page.keyboard.press('Tab');
 };
 const preview=async()=>{
  await page.evaluate(()=>window.calls=[]);await page.getByRole('button',{name:'保存',exact:true}).click();
  await page.waitForFunction(()=>window.calls.some(c=>c.c==='ddl_preview'));
  assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.c==='ddl_apply').length),0,'预览不应写入');
  return page.evaluate(()=>window.calls.find(c=>c.c==='ddl_preview').a.spec);
 };
 for(const engine of ['mysql','postgres','sqlite'])for(const theme of ['light','oled']){
  await start(engine,theme);
  await select('字段类型',engine==='mysql'?'decimal':engine==='postgres'?'numeric':'TEXT');
  if(engine!=='sqlite')await input('长度/集合','18,6');
  await select('默认值模式','literal');await page.getByRole('textbox',{name:'新增列 默认值',exact:true}).fill('12.345678');await page.keyboard.press('Tab');
  if(engine==='mysql')await page.getByRole('checkbox',{name:'新增列 无符号',exact:true}).check();
  if(engine!=='sqlite')await input('注释',"金额 C:\\it's");
  else {await cell('注释').dblclick();assert.equal(await page.getByRole('textbox',{name:'新增列 注释',exact:true}).count(),0);}
  await select('键','unique');await page.keyboard.press('Tab');
  for(const zoom of [1,2]){
   await page.evaluate(z=>document.body.style.zoom=String(z),zoom);
   const row=page.locator('table[aria-label="列信息"] tbody tr').last();
   assert.equal(await row.locator('td').count(),await page.locator('table[aria-label="列信息"] thead th').count());
   await page.screenshot({path:`.qa/column-attributes-${engine}-${theme}-${zoom}.png`});
  }
  await page.evaluate(()=>document.body.style.zoom='1');
  assert.equal(await page.evaluate(()=>Object.keys(window.editGuard.getState().entries).length),1,'新增草稿注册未保存保护');
  const spec=await preview();assert.equal(spec.type,'addColumnDraft');assert.equal(spec.column.name,'index_progress');assert.equal(spec.key,'unique');
  assert.equal(spec.column.dataType,engine==='sqlite'?'TEXT':engine==='mysql'?'decimal(18,6)':'numeric(18,6)');
  assert.equal(spec.column.defaultValue,'12.345678');assert.equal(spec.column.unsigned,engine==='mysql');assert.equal(spec.column.comment,engine==='sqlite'?'':"金额 C:\\it's");
  assert.equal(spec.position==null,engine!=='mysql');
  await page.getByRole('checkbox',{name:'我已了解风险，确认执行'}).check();
  await page.evaluate(()=>window.failSave=true);await page.getByRole('button',{name:'执行',exact:true}).click();
  await page.waitForFunction(()=>window.calls.some(c=>c.c==='ddl_apply'));await page.getByRole('button',{name:'执行',exact:true}).waitFor();
  assert.equal(await page.getByRole('dialog').count(),1,'失败保留预览与草稿');
  await page.evaluate(()=>window.failSave=false);await page.getByRole('button',{name:'执行',exact:true}).click();
  await page.waitForFunction(()=>window.changed===1);assert.equal(await page.evaluate(()=>Object.keys(window.editGuard.getState().entries).length),0);assert.equal(await cell('字段名').count(),0);
 }
 await start('mysql');await select('字段类型','datetime');await input('长度/集合','3');await select('默认值模式','timestamp');await select('ON UPDATE','CURRENT_TIMESTAMP');
 let spec=await preview();assert.equal(spec.column.dataType,'datetime(3)');assert.equal(spec.column.defaultMode,'timestamp');assert.equal(spec.column.onUpdate,'CURRENT_TIMESTAMP');
 await page.getByRole('button',{name:'取消',exact:true}).click();await select('字段类型','varchar');
 spec=await preview();assert.equal(spec.column.defaultMode,'none');assert.equal(spec.column.onUpdate,'');
 await page.getByRole('button',{name:'取消',exact:true}).click();await select('默认值模式','literal');await page.keyboard.press('Tab');assert.equal(await cell('默认值').innerText(),"''");
 spec=await preview();assert.equal(spec.column.defaultValue,'');
 await page.getByRole('button',{name:'取消',exact:true}).click();await page.getByRole('button',{name:'废弃',exact:true}).click();assert.equal(await cell('字段名').count(),0);
 for(const engine of ['mysql','postgres']){
  await start(engine,'light','&noauto');await select('字段类型','bigint');await select('键','index');await page.getByRole('checkbox',{name:'新增列 自动增长',exact:true}).check();
  spec=await preview();assert.equal(spec.column.autoIncrement,true);assert.equal(spec.column.nullable,false);assert.equal(spec.column.defaultMode,'none');
 }
 await start('sqlite');await select('字段类型','integer');assert(await page.getByRole('checkbox',{name:'新增列 自动增长',exact:true}).isDisabled());
 await select('默认值模式','none');assert.equal(await page.getByRole('combobox',{name:'新增列 默认值模式'}).locator('option[value="timestamp"]').count(),0);
 await page.goto('http://localhost:1425/scripts/fixtures/column-flags.html?engine=mysql');
 await page.getByRole('cell',{name:'id 字段类型 单元格',exact:true}).dblclick();await page.getByRole('combobox',{name:'id 字段类型',exact:true}).selectOption('varchar');
 spec=await preview();assert.equal(spec.changes[0].unsigned,false);assert.equal(spec.changes[0].autoIncrement,false);
 await page.goto('http://localhost:1425/scripts/fixtures/column-flags.html?readonly');assert.equal(await page.getByRole('button',{name:'添加列',exact:true}).count(),0);
 console.log('PASS 完整属性跨三引擎、预览/失败保留/废弃、身份列、精度/默认值联动、能力限制、双主题双缩放、建表草稿一致性');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
