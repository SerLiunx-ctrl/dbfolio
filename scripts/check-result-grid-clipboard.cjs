const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
(async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1380,height:850}}), errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    const base=process.env.DBFOLIO_UI_URL||'http://127.0.0.1:1425';
    const cell=(row,col)=>page.locator(`.ag-row[row-index="${row}"] .ag-cell[col-id="c${col}"]`).first();
    const open=async(query='')=>{await page.goto(`${base}/scripts/fixtures/result-grid-clipboard.html${query}`);await cell(0,0).waitFor();};
    const rowCheck=row=>page.locator(`.ag-row[row-index="${row}"] .ag-selection-checkbox`).first();
    const menu=name=>page.getByRole('menuitem',{name,exact:true});
    const grouped=async(group,name)=>{await menu(group).hover();await menu(name).click();};
    const copyMenu=async(row,col,name)=>{await cell(row,col).click({button:'right'});await grouped('复制',name);};
    const typed=()=>page.evaluate(()=>window.readTyped());
    const selectPair=async()=>{await rowCheck(0).click();await rowCheck(1).click();};

    await open();await selectPair();await copyMenu(0,1,'复制行');
    let snapshot=await typed();assert.deepEqual(snapshot.rows.map(row=>row[0][1]),[1,2]);
    assert.deepEqual(snapshot.rows,await page.evaluate(()=>window.fixture.rows.slice(0,2)));
    await copyMenu(2,1,'复制行');snapshot=await typed();assert.deepEqual(snapshot.rows.map(row=>row[0][1]),[3],'右键未选中行应替换旧选择目标');
    assert.equal(await page.locator('.ag-row-selected').count(),1);

    await open();await selectPair();
    const blank=await page.locator('.ag-root-wrapper').boundingBox();assert(blank);
    await page.mouse.click(blank.x+30,blank.y+blank.height*0.7,{button:'right'});
    await menu('复制').hover();assert(await menu('复制单元格').isDisabled());await menu('复制行').click();
    snapshot=await typed();assert.deepEqual(snapshot.rows.map(row=>row[0][1]),[1,2],'空白右键应保留多选');

    await page.getByRole('button',{name:'列管理',exact:true}).click();
    await page.getByRole('checkbox',{name:'显示列 enabled',exact:true}).uncheck();
    await page.getByRole('button',{name:'上移列 notes',exact:true}).click();await page.keyboard.press('Escape');
    await copyMenu(1,1,'复制行');snapshot=await typed();
    assert.deepEqual(snapshot.columns.map(c=>c.name),['notes','id','nullable_text','binary_value','amount']);
    assert.deepEqual(snapshot.rows.map(row=>row[1][1]),[1,2]);
    assert.deepEqual(snapshot.rows[0][2],['null',null]);assert.deepEqual(snapshot.rows[1][2],['text','']);
    assert.deepEqual(snapshot.rows[0][3],['bytes','0x007fff']);assert.deepEqual(snapshot.rows[0][4],['decimal','12345678901234567890.1234']);

    await copyMenu(0,1,'复制单元格');
    assert.equal(await page.evaluate(()=>window.clipboard),'甲\t引号"多\r\n行');assert.equal(await typed(),null,'单元格复制应使typed行快照失效');
    await cell(0,0).click({button:'right'});
    await menu('复制 SQL').hover();
    assert(!(await menu('复制为 INSERT 语句…').isDisabled()),'只读会话允许生成SQL文本');
    assert(!(await menu('复制为 UPDATE 语句…').isDisabled()));await page.keyboard.press('Escape');

    await open();
    for(const kind of ['INSERT','UPDATE']) {
      await cell(0,0).click({button:'right'});await grouped('复制 SQL',`复制为 ${kind} 语句…`);
      const dialog=page.getByRole('dialog');await dialog.getByRole('heading',{name:`复制为 ${kind} SQL`,exact:true}).waitFor();
      assert(await dialog.getByRole('button',{name:'复制 SQL',exact:true}).isDisabled(),'查询结果必须由用户选择目标表');
      const target=dialog.getByRole('combobox',{name:'SQL 复制目标表',exact:true});await target.selectOption(JSON.stringify(['test','records']));
      await page.waitForFunction(()=>[...document.querySelectorAll('[role="dialog"] button')].some(button=>button.textContent==='复制 SQL'&&!button.disabled));
      await dialog.getByRole('button',{name:'复制 SQL',exact:true}).click();
      const sql=await page.evaluate(()=>window.clipboard);assert.match(sql,new RegExp(`^${kind} (?:INTO )?`));assert(sql.includes('`test`.`records`'));assert(sql.includes('12345678901234567890.1234'));assert(sql.includes("X'007fff'"));
      if(kind==='INSERT')assert(!sql.startsWith('INSERT INTO `test`.`records` (`id`'),'INSERT略过自增列');
      else assert.match(sql,/WHERE `id` = 1;$/);
      await dialog.getByRole('button',{name:'关闭',exact:true}).click();
    }

    await open('?noContext');await cell(0,0).click({button:'right'});
    await menu('复制 SQL').hover();
    for(const name of ['复制为 INSERT 语句…','复制为 UPDATE 语句…']){assert(await menu(name).isDisabled());assert.match(await menu(name).getAttribute('title'),/会话或数据库上下文/);}await page.keyboard.press('Escape');
    await open();await page.evaluate(()=>{window.failClipboard=true;});await copyMenu(0,1,'复制单元格');
    await page.getByText('复制单元格失败',{exact:true}).waitFor();
    await copyMenu(0,0,'复制行');await page.getByText('复制行失败',{exact:true}).waitFor();
    await open('?truncated');await copyMenu(0,0,'复制行');await page.getByText('复制行失败',{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>window.calls.filter(c=>['grid_commit','update_cell','transaction_execute'].includes(c.command)).length),0);
    assert.deepEqual(errors,[]);
    fs.mkdirSync('.qa',{recursive:true});await page.screenshot({path:'.qa/alpha61-result-grid-clipboard.png'});
    console.log('PASS 查询结果右键目标、多选、空白菜单、显示列顺序、NULL/空串/精确值/分隔符保真、只读SQL目标选择/INSERT与UPDATE生成、上下文禁用、复制错误反馈，无直接写库入口');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
