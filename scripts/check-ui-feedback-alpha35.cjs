const {chromium}=require('playwright');const assert=require('node:assert/strict');
(async()=>{const b=await chromium.launch({channel:'msedge',headless:true});try{const p=await b.newPage({viewport:{width:1800,height:1000}});p.setDefaultNavigationTimeout(60000);const errors=[];p.on('pageerror',e=>errors.push(e.message));
for(const engine of ['mysql','postgres','sqlite']){
 await p.goto(`http://127.0.0.1:1425/scripts/fixtures/grid-workbench.html?engine=${engine}`);
 const cell=n=>p.locator(`.ag-row[row-index="0"] .ag-cell[col-id="c${n}"]`).first();await cell(3).waitFor();await p.getByRole('button',{name:'单元格详情',exact:true}).click();await cell(3).click();await p.locator('.dw-grid-inspector .monaco-editor').waitFor();await p.waitForFunction(()=>window.calls.some(c=>c.c==='cell_full_value'));
 await p.evaluate(()=>window.editText('修改后的中文'));await p.waitForTimeout(150);
 const before=await p.evaluate(()=>window.calls.filter(c=>c.c==='cell_full_value').length);
 for(const n of [1,2,0,6]){await cell(n).click();await p.waitForTimeout(130);assert.equal(await p.locator('.dw-grid-inspector [role="alert"]').count(),0);assert.equal(await p.evaluate(()=>window.calls.filter(c=>c.c==='cell_full_value').length),before);}
 console.log(`PASS ${engine}: text edits retained, integer/decimal/PK/NULL inspection skips full-text request`);
 for(const theme of ['light','dark','oled'])for(const zoom of [1,2]){
 await p.goto(`http://127.0.0.1:1425/scripts/fixtures/foreign-navigation.html?engine=${engine}&theme=${theme}&zoom=${zoom}`);
 for(const name of ['新建查询','新建分析','数据生成'])await p.getByRole('button',{name,exact:true}).waitFor();assert.equal(await p.getByRole('button',{name:'更多表操作'}).count(),0);
 await p.getByRole('tab',{name:/结构/}).click();const row=p.locator('[data-column-name="id"]');await row.waitFor();const h=(await row.boundingBox()).height;
 await row.getByRole('cell',{name:'id 字段名 单元格',exact:true}).dblclick();const input=row.getByRole('textbox');await input.fill('中文字段');const ih=await input.boundingBox();assert(ih.height>=22*zoom);assert(Math.abs((await row.boundingBox()).height-h)<1.5);await input.press('Tab');
 await row.getByRole('cell',{name:'id 字段类型 单元格',exact:true}).dblclick();const select=row.getByRole('combobox');await select.waitFor();assert(Math.abs((await row.boundingBox()).height-h)<1.5);const size=await select.evaluate(e=>({h:e.clientHeight,line:parseFloat(getComputedStyle(e).lineHeight),p:parseFloat(getComputedStyle(e).paddingTop)+parseFloat(getComputedStyle(e).paddingBottom)}));assert(size.h>=size.line+size.p-1);if(engine==="mysql"&&zoom===1)await p.screenshot({path:`.qa/alpha35-structure-${theme}.png`});console.log(`PASS ${engine} ${theme} ${zoom*100}%: direct toolbar, stable editor row, text room`);
 }
}
await p.goto('http://127.0.0.1:1425/scripts/fixtures/redis-counts.html');await p.getByText('125 个键',{exact:true}).waitFor();await p.evaluate(()=>window.count=250);await p.getByRole('button',{name:'搜索',exact:true}).click();await p.getByText('250 个键',{exact:true}).waitFor();await p.evaluate(()=>window.count=3);await p.getByRole('button',{name:'刷新',exact:true}).last().click();await p.getByText('3 个键',{exact:true}).waitFor();assert(await p.getByText('test:new',{exact:true}).count());await p.evaluate(()=>window.fail=true);await p.getByRole('button',{name:'搜索',exact:true}).click();await p.getByText('模拟计数读取失败',{exact:true}).waitFor();assert(await p.getByText('test:new',{exact:true}).count());assert(await p.getByText('3 个键',{exact:true}).count());console.log('PASS Redis: initial/search/refresh counts use server totals; failure keeps keys and last count');assert.deepEqual(errors,[]);
}finally{await b.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
