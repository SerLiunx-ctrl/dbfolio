const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs');
const base=process.env.DBFOLIO_UI_URL||'http://127.0.0.1:1425';
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 const result={passed:false,cases:[],positioning:[]};let page,stage='startup';
 try{
  page=await browser.newPage({viewport:{width:1280,height:750}});const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const cell=(row,column)=>page.locator(`.ag-row[row-index="${row}"] .ag-cell[col-id="c${column}"]`).first();
  const item=name=>page.getByRole('menuitem',{name,exact:true});
  const visibleMenus=()=>page.locator('[role="menu"]:visible');
  const rootOf=trigger=>trigger.locator('xpath=ancestor::*[@role="menu"][1]');
  const stablePopovers=async()=>{
   await page.waitForFunction(()=>[...document.querySelectorAll('.fui-MenuPopover')].filter(node=>node.getClientRects().length).every(node=>{let opacity=1;for(let current=node;current;current=current.parentElement)opacity*=Number(getComputedStyle(current).opacity);return opacity>=.99}));
   const boxes=()=>page.locator('.fui-MenuPopover:visible').evaluateAll(nodes=>nodes.map(node=>{const b=node.getBoundingClientRect();return[b.x,b.y,b.width,b.height]}));let previous=await boxes(),stable=0;
   for(let i=0;i<30;i++){await page.waitForTimeout(100);const current=await boxes();stable=JSON.stringify(current)===JSON.stringify(previous)?stable+1:0;if(stable>=2)return;previous=current}throw Error('Menu geometry must remain stable for 200ms after its entry animation');
  };
  const surfaces=async()=>{
   const values=await page.locator('.fui-MenuPopover:visible').evaluateAll(nodes=>nodes.map(node=>{let opacity=1;const ancestors=[];for(let current=node;current;current=current.parentElement){const style=getComputedStyle(current);opacity*=Number(style.opacity);ancestors.push({tag:current.tagName,opacity:style.opacity,transform:style.transform})}return{background:getComputedStyle(node).backgroundColor,effectiveOpacity:opacity,ancestors}}));
   for(const value of values){assert(value.effectiveOpacity>=.99,'all menu ancestors must finish opacity animation');const parts=value.background.match(/[\d.]+/g)?.map(Number);assert(parts&&parts.length>=3&&(!value.background.startsWith('rgba')||parts[3]>=.99),'actual App palette must provide an opaque menu surface: '+value.background)}return values;
  };
  const closed=()=>page.waitForFunction(()=>![...document.querySelectorAll('[role="menu"]')].some(node=>node.getClientRects().length));
  const open=async(kind,extra='')=>{const fixture=kind==='table'?'grid-workbench.html?clipboardRows&engine=sqlite&menuCapabilities&appScale':'result-grid-clipboard.html?';await page.goto(`${base}/scripts/fixtures/${fixture}${extra}`);await cell(0,1).waitFor();};
  const context=async(row=0,column=1)=>{await cell(row,column).click({button:'right'});await item('复制').waitFor();};
  const group=async(name,leaf)=>{await item(name).hover();await item(leaf).waitFor();};
  const mark=name=>{result.cases.push(name);console.log('PASS '+name);};

  for(const kind of ['table','result']){
   stage=kind+' hover and leaf dismissal';await open(kind);await context();
   const trigger=item('复制');assert.equal(await trigger.getAttribute('aria-haspopup'),'menu');
   await group('复制','复制单元格');assert.equal(await trigger.getAttribute('aria-expanded'),'true');assert.equal(await visibleMenus().count(),2);
   await item('复制单元格').hover();await item('复制单元格').click();await closed();
   const copied=await page.evaluate(()=>window.clipboard);assert.equal(copied,kind==='table'?'2':'甲\t引号"多\r\n行');
   assert.equal(await page.getByRole('menu',{name:'网格右键菜单',exact:true}).count(),0,'leaf action must remove the root menu and its overlay');
   await cell(1,1).click();assert.equal(await page.locator('.ag-row-selected').count(),1,'closed menu must not intercept the next grid click');
   mark(`${kind}: hover opens a usable submenu; leaf action closes all levels and releases grid input`);

   stage=kind+' keyboard navigation';await context();await item('复制').focus();await page.keyboard.press('ArrowRight');await item('复制单元格').waitFor();
   assert.match(await page.evaluate(()=>document.activeElement?.textContent||''),/复制单元格/);
   await page.keyboard.press('ArrowDown');assert.match(await page.evaluate(()=>document.activeElement?.textContent||''),/复制行/);
   await page.keyboard.press('ArrowLeft');await item('复制行').waitFor({state:'hidden'});assert(await item('复制').isVisible());assert.match(await page.evaluate(()=>document.activeElement?.textContent||''),/^复制/);
   await page.keyboard.press('ArrowRight');await item('复制单元格').waitFor();await page.keyboard.press('Escape');await item('复制单元格').waitFor({state:'hidden'});assert(await item('复制').isVisible(),'first Escape must return from the submenu');
   await page.keyboard.press('Escape');await closed();mark(`${kind}: ArrowRight/Down/Left and two-level Escape preserve menu focus`);

   stage=kind+' blank selection';await open(kind);for(const row of [0,1])await page.locator(`.ag-row[row-index="${row}"] .ag-selection-checkbox`).first().click();assert.equal(await page.locator('.ag-row-selected').count(),2);
   const grid=await page.locator('.ag-root-wrapper').boundingBox();assert(grid);await page.mouse.click(grid.x+250,grid.y+grid.height-60,{button:'right'});await group('复制','复制单元格');assert(await item('复制单元格').isDisabled());assert(!(await item('复制行').isDisabled()));await item('复制行').click();await closed();
   const typed=await page.evaluate(()=>window.readTyped());assert(typed);assert.deepEqual(typed.rows.map(row=>row[0][1]),[1,2]);assert.equal(await page.locator('.ag-row-selected').count(),2,'blank menu must preserve multi-selection');
   mark(`${kind}: blank right-click keeps multi-selection and copies selected rows while disabling cell-only actions`);

   stage=kind+' SQL action';await context();await group('复制 SQL','复制为 INSERT 语句…');assert(!(await item('复制为 INSERT 语句…').isDisabled()));await item('复制为 INSERT 语句…').click();await page.getByRole('dialog').waitFor();await closed();await page.getByRole('button',{name:'关闭',exact:true}).click();
   stage=kind+' outside dismissal';await context();await group('复制','复制行');const outside=await page.locator('.ag-root-wrapper').boundingBox();await page.mouse.click(outside.x+80,outside.y+outside.height-45);await closed();mark(`${kind}: SQL leaf opens its dialog after menu dismissal; outside grid click closes both levels`);
  }

  stage='table primary capability actions';await open('table');await context(0,3);
  for(const name of ['查看/编辑单元格详情','查看关联记录…','按此值筛选（替换条件）','复制为新行（待提交）','设为 NULL'])assert(await item(name).isVisible(),`${name} must remain a primary action`);
  await item('按此值筛选（替换条件）').click();await closed();assert.deepEqual((await page.evaluate(()=>window.menuCallbacks)).map(v=>[v.kind,v.column]),[['filter','notes']]);
  await context(0,3);await item('查看关联记录…').click();await closed();assert.deepEqual((await page.evaluate(()=>window.menuCallbacks)).map(v=>v.kind),['filter','related']);
  await context(0,3);await group('粘贴','粘贴为新行（待提交）');assert(await item('粘贴到当前单元格').isVisible());await page.keyboard.press('Escape');await page.keyboard.press('Escape');await closed();mark('table: detail/relationship/filter/new-row/NULL remain primary actions; paste choices form a submenu');

  stage='read-only menu';await open('table','&readonly');await context(0,3);
  for(const name of ['粘贴','复制为新行（待提交）','设为 NULL'])assert.equal(await item(name).count(),0,`read-only menu must not expose ${name}`);
  await group('复制 SQL','复制为 UPDATE 语句…');assert(!(await item('复制为 INSERT 语句…').isDisabled()));assert(!(await item('复制为 UPDATE 语句…').isDisabled()));await page.keyboard.press('Escape');await page.keyboard.press('Escape');await closed();
  await open('result');await context();assert.equal(await item('粘贴').count(),0);await page.keyboard.press('Escape');await closed();
  await open('result','&noContext');await context();await group('复制 SQL','复制为 INSERT 语句…');for(const name of ['复制为 INSERT 语句…','复制为 UPDATE 语句…']){assert(await item(name).isDisabled());assert.match(await item(name).getAttribute('title'),/会话或数据库上下文/)}await page.keyboard.press('Escape');await page.keyboard.press('Escape');await closed();mark('read-only/query contexts keep text/SQL copy, hide mutation actions and explain unavailable SQL targets');

  for(const [theme,zoom] of [['light',1],['dark',1.25],['oled',2]])for(const kind of ['table','result']){
   stage=`${kind} ${theme} ${zoom} edge positioning`;await page.setViewportSize({width:1280,height:360});await open(kind,`&theme=${theme}&zoom=${zoom}`);
   const grid=await page.locator('.ag-root-wrapper').boundingBox();assert(grid);const click={x:Math.min(1260,grid.x+grid.width-20),y:Math.min(330,grid.y+grid.height-45)};await page.mouse.click(click.x,click.y,{button:'right'});await item('复制').waitFor();
   const root=rootOf(item('复制'));await stablePopovers();const rootBox=await root.boundingBox();assert(rootBox);
   for(const [groupName,leaf] of [['复制','复制行'],['复制 SQL','复制为 INSERT 语句…'],...(kind==='table'?[['粘贴','粘贴为新行（待提交）']]:[])]){
    await item(groupName).hover();await item(leaf).waitFor();await stablePopovers();const submenu=rootOf(item(leaf)),bounds=await submenu.boundingBox();assert(bounds);const viewport=page.viewportSize();
    for(const [name,box] of [['root',rootBox],['submenu',bounds]])assert(box.x>=-0.5&&box.y>=-0.5&&box.x+box.width<=viewport.width+0.5&&box.y+box.height<=viewport.height+0.5,`${stage}/${groupName}: ${name} overflow ${JSON.stringify(box)}`);
    assert(bounds.x<rootBox.x,'right-edge submenu must flip to the left');assert.equal(await submenu.evaluate(node=>node.scrollWidth<=node.clientWidth+2),true,'submenu labels must not be horizontally clipped');
    result.positioning.push({kind,theme,zoom,group:groupName,root:rootBox,submenu:bounds,surfaces:await surfaces()});
    if(groupName==='复制 SQL')await page.screenshot({path:`.qa/grid-context-menu-${kind}-${theme}-${zoom}-copy-sql.png`});
   }
   await page.screenshot({path:`.qa/grid-context-menu-${kind}-${theme}-${zoom}.png`});await page.keyboard.press('Escape');await page.keyboard.press('Escape');await closed();
  }mark('table/query light/dark/OLED menus at 100%/125%/200% flip from the bottom-right and remain within the viewport');

  assert.deepEqual(errors,[]);result.pageErrors=errors;result.passed=true;fs.mkdirSync('.qa',{recursive:true});fs.writeFileSync('.qa/grid-context-menu-ui.json',JSON.stringify(result,null,2));
 }catch(error){result.error={stage,message:String(error),stack:error.stack};fs.mkdirSync('.qa',{recursive:true});fs.writeFileSync('.qa/grid-context-menu-ui.json',JSON.stringify(result,null,2));if(page)await page.screenshot({path:'.qa/grid-context-menu-failure.png'}).catch(()=>{});throw error}
 finally{await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
