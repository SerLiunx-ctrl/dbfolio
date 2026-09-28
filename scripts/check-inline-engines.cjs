const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
(async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try {
    const p=await browser.newPage({viewport:{width:1600,height:800}});
    for(const engine of ['mysql','sqlite','postgres']) {
      await p.goto(`http://localhost:1425/scripts/fixtures/column-flags.html?engine=${engine}`);
      const cell=(name)=>p.getByRole('cell',{name:'text '+name+' 单元格',exact:true});
      await cell('字段名').waitFor();
      assert.equal(await p.getByRole('textbox').count(),0);
      assert.equal(await p.getByLabel('编辑列',{exact:true}).count(),0);
      await cell('字段名').dblclick();await p.getByRole('textbox',{name:'text 字段名',exact:true}).fill('description');
      await cell('长度/集合').dblclick();await p.getByRole('textbox',{name:'text 长度/集合',exact:true}).fill('80');
      await cell('默认值').dblclick();await p.getByRole('combobox',{name:'text 默认值模式'}).selectOption('literal');
      await p.getByRole('textbox',{name:'text 默认值',exact:true}).fill('hello');
      if(engine!=='sqlite') {await cell('注释').dblclick();await p.getByRole('textbox',{name:'text 注释',exact:true}).fill('备注');}
      else {await cell('注释').dblclick();assert.equal(await p.getByRole('textbox',{name:'text 注释',exact:true}).count(),0);}
      assert.equal(await p.evaluate(()=>window.calls.length),0,'修改仅暂存');
      await p.getByRole('button',{name:'保存',exact:true}).click();
      await p.getByRole('checkbox',{name:'我已了解风险，确认执行'}).check();
      const change=await p.evaluate(()=>window.calls.find(x=>x.c==='ddl_preview').a.spec.changes[0]);
      assert.equal(change.newName,'description');assert.equal(change.dataType,'varchar(80)');assert.equal(change.defaultValue,'hello');
      assert.equal(change.comment,engine==='sqlite'?undefined:'备注');assert.equal(change.unsigned,undefined);
      await p.getByRole('button',{name:'执行',exact:true}).click();
      await p.waitForFunction(()=>window.changed===1);
      assert(await p.getByRole('button',{name:'保存',exact:true}).isDisabled());
      await cell('字段名').dblclick();await p.getByRole('textbox',{name:'text 字段名',exact:true}).fill('discard_me');
      await p.getByRole('button',{name:'废弃',exact:true}).click();
      assert.equal(await cell('字段名').innerText(),'text');
      await cell('字段名').click({button:'right'});
      assert.equal(await p.getByRole('menuitem',{name:'修改',exact:true}).count(),0);
      await p.getByRole('menuitem',{name:'创建索引',exact:true}).waitFor();await p.keyboard.press('Escape');
      await p.goto(`http://localhost:1425/scripts/fixtures/column-flags.html?engine=${engine}&readonly`);
      await cell('字段名').dblclick();assert.equal(await p.getByRole('textbox').count(),0);
    }
    await p.goto('http://localhost:1425/scripts/fixtures/column-flags.html?engine=sqlite&theme=oled');
    const cell=p.getByRole('cell',{name:'text 字段类型 单元格',exact:true});await cell.dblclick();
    await p.getByRole('combobox',{name:'text 字段类型',exact:true}).selectOption('integer');
    await p.evaluate(()=>window.failSave=true);
    await p.getByRole('button',{name:'保存',exact:true}).click();await p.getByRole('checkbox',{name:'我已了解风险，确认执行'}).check();
    await p.getByRole('button',{name:'执行',exact:true}).click();await p.waitForFunction(()=>window.calls.some(x=>x.c==='ddl_apply'));
    await p.getByRole('button',{name:'取消',exact:true}).click();assert(await p.getByRole('button',{name:'保存',exact:true}).isEnabled(),'保存失败保留草稿');
    await p.screenshot({path:'.qa/inline-sqlite-oled.png'});
    console.log('PASS 三引擎行内编辑/暂存/预览/保存/废弃、字段能力、统一菜单、只读、保存失败保留草稿');
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
