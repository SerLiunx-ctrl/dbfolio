const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs'),ts=require('typescript');
const mod={exports:{}};
new Function('module','exports',ts.transpileModule(fs.readFileSync('src/features/table/createTableDraft.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText)(mod,mod.exports);
const {newTableState,newColumn,draftSpec}=mod.exports;
for(const engine of ['mysql','postgres','sqlite']){
 const state=newTableState(engine);state.properties.name=' items ';
 state.columns=[newColumn(engine,' parent_id ')];
 state.indexes=[{name:'idx_parent',columns:[{name:' parent_id '}],unique:false}];
 state.foreignKeys=[{name:'fk_self',columns:[' parent_id '],refColumns:[' parent_id '],selfReference:true,refTable:'items'}];
 const result=draftSpec(state,engine);
 assert.equal(result.columns[0].name,'parent_id');assert.equal(result.indexes[0].columns[0].name,'parent_id');
 assert.deepEqual(result.foreignKeys[0].columns,['parent_id']);assert.deepEqual(result.foreignKeys[0].refColumns,['parent_id']);
 assert.equal(state.columns[0].name,' parent_id ','生成预览不能修改原草稿');
}
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1650,height:900}});
  for(const engine of ['mysql','postgres','sqlite'])for(const theme of ['light','oled']){
   await page.goto(`http://localhost:1425/scripts/fixtures/column-flags.html?engine=${engine}&theme=${theme}`);
   assert.equal(await page.getByRole('textbox').count(),0);
   await page.getByRole('cell',{name:'text 字段名 单元格',exact:true}).dblclick();
   await page.getByRole('textbox',{name:'text 字段名',exact:true}).fill('  index_progress \t');
   await page.getByRole('button',{name:'保存',exact:true}).click();
   await page.waitForFunction(()=>window.calls.some(c=>c.c==='ddl_preview'));
   assert.equal(await page.evaluate(()=>window.calls.find(c=>c.c==='ddl_preview').a.spec.changes[0].newName),'index_progress');
   await page.getByRole('button',{name:'取消',exact:true}).click();
   assert.equal(await page.getByRole('cell',{name:'text 字段名 单元格',exact:true}).innerText(),'index_progress');
   await page.getByRole('button',{name:'废弃',exact:true}).click();
   await page.getByRole('button',{name:'添加列',exact:true}).click();
   await page.getByRole('textbox',{name:'新增列 字段名',exact:true}).fill(' extra ');
   await page.keyboard.press('Tab');
   await page.getByRole('cell',{name:'新增列 注释 单元格',exact:true}).dblclick();
   if(engine==='sqlite')assert.equal(await page.getByRole('textbox',{name:'新增列 注释',exact:true}).count(),0);
   else {await page.getByRole('textbox',{name:'新增列 注释',exact:true}).fill("备注 C:\\it's");await page.keyboard.press('Tab');}
   await page.getByRole('button',{name:'保存',exact:true}).click();
   await page.getByRole('checkbox',{name:'我已了解风险，确认执行'}).check();
   await page.getByRole('button',{name:'执行',exact:true}).click();
   await page.waitForFunction(()=>window.calls.some(c=>c.c==='ddl_apply'));
   const column=await page.evaluate(()=>window.calls.find(c=>c.c==='ddl_apply').a.spec.column);
   assert.equal(column.name,'extra');assert.equal(column.comment,engine==='sqlite'?'':"备注 C:\\it's");
  }
  await page.goto('http://localhost:1425/scripts/fixtures/column-flags.html?readonly');
  assert.equal(await page.getByRole('button',{name:'添加列',exact:true}).count(),0);
  console.log('PASS 三引擎改名去首尾空白、保存预览、废弃、新增注释与SQLite能力提示；双主题；建表草稿索引/自引用联动');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
