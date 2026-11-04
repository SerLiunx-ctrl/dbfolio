// 真实 ER 组件夹具；只请求本机 Vite，不访问数据库或外部 AI。
const fs=require('node:fs'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const resultPath='.qa/er54-motion-result.json';
fs.mkdirSync('.qa',{recursive:true});

async function cardFor(page,engine,name){
 const key=JSON.stringify(['db',engine==='postgres'?'app':null,name]);
 const card=page.locator('[data-er-table]').filter({has:page.locator(':scope > header > button:first-child').filter({hasText:new RegExp('^'+(engine==='postgres'?'app\\.':'')+name+'$')})}).first();
 await card.waitFor();return {key,card,title:card.locator(':scope > header > button:first-child')};
}
async function geometry(page){return page.evaluate(()=>({
 cards:[...document.querySelectorAll('[data-er-table]')].map(e=>({key:e.dataset.erTable,height:e.offsetHeight,fields:[...e.querySelectorAll('.dw-er-field')].map(f=>({text:f.getAttribute('aria-label'),top:f.offsetTop,height:f.offsetHeight}))})),
 lines:[...document.querySelectorAll('.dw-er-line')].map(e=>e.getAttribute('d')),
}));}
async function waitExpanded(title,value){await title.page().waitForFunction(({key,value})=>[...document.querySelectorAll('[data-er-table]')].find(e=>e.dataset.erTable===key)?.querySelector(':scope > header > button:first-child')?.getAttribute('aria-expanded')===String(value),{key:await title.evaluate(e=>e.closest('[data-er-table]').dataset.erTable),value});}
async function waitClosed(card){await card.locator('.dw-er-card-detail').waitFor({state:'detached'});}
// 同一个 evaluate 中采样第一帧，避免 Playwright 点击等待错过 160 ms 退场。
async function closingSnapshot(page,key,kind){return page.evaluate(async({key,kind})=>{
 const card=[...document.querySelectorAll('[data-er-table]')].find(e=>e.dataset.erTable===key);
 if(kind==='header')card.querySelector(':scope > header > button:first-child').click();
 else if(kind==='close')card.querySelector('[aria-label="关闭关系图详情"]').click();
 else {const viewport=document.querySelector('.dw-er-viewport');viewport.focus();viewport.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));}
 await new Promise(requestAnimationFrame);
 const detail=card.querySelector('.dw-er-card-detail');
 if(!detail)return {present:false};
 const style=getComputedStyle(detail),first={present:true,state:detail.dataset.state,inert:detail.inert,hidden:detail.getAttribute('aria-hidden'),label:detail.getAttribute('aria-label'),name:style.animationName,pointer:style.pointerEvents,opacity:Number(style.opacity),text:detail.textContent,activeDetails:document.querySelectorAll('[aria-label="关系图详情"]').length};
 const button=detail.querySelector('button');button?.focus();first.focusBlocked=document.activeElement!==button;
 await new Promise(r=>setTimeout(r,65));
 first.laterOpacity=detail.isConnected?Number(getComputedStyle(detail).opacity):0;
 return first;
 },{key,kind});}
function assertClosing(s,expected){assert(s.present,'退场阶段保留详情内容');assert.equal(s.state,'closing');assert.equal(s.inert,true);assert.equal(s.hidden,'true');assert.equal(s.label,null);assert.equal(s.pointer,'none');assert.equal(s.name,'dw-er-detail-close');assert.equal(s.activeDetails,0);assert.equal(s.focusBlocked,true);assert(s.text.includes(expected),'退场内容不得先变为空壳');assert(s.opacity>0&&s.opacity<=1);assert(s.laterOpacity<s.opacity,'退场动画透明度逐渐降低');}
async function dragHeader(page,card,zoom){const header=card.locator(':scope > header'),r=await header.boundingBox();await page.mouse.move(r.x+r.width*.6,r.y+r.height*.5);await page.mouse.down();await page.mouse.move(r.x+r.width*.6+22*zoom,r.y+r.height*.5+18*zoom,{steps:6});await page.mouse.up();}

(async()=>{const browser=await chromium.launch({channel:'msedge',headless:true}),results=[],extra={};try{
 for(const engine of ['mysql','postgres','sqlite'])for(const theme of ['light','dark','oled'])for(const zoom of [1,2]){
  const page=await browser.newPage({viewport:{width:1920,height:1200},reducedMotion:'no-preference'}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(15000);
  try{
   await page.goto(`http://127.0.0.1:1425/scripts/fixtures/er.html?engine=${engine}&theme=${theme}&zoom=${zoom}`,{waitUntil:'domcontentloaded',timeout:60000});await page.waitForFunction(()=>!document.querySelector('.dw-er-loading'));await page.getByRole('button',{name:'适应画布',exact:true}).click();
   const a=await cardFor(page,engine,'users'),b=await cardFor(page,engine,'orders'),before=await geometry(page);
   await a.title.click();await waitExpanded(a.title,true);const detail=a.card.getByLabel('关系图详情',{exact:true});await detail.waitFor();assert.equal(await detail.evaluate(e=>getComputedStyle(e).animationName),'dw-er-detail-open');assert((await detail.textContent()).includes('users'));if(engine==='mysql'&&zoom===1&&['light','dark'].includes(theme)){await page.waitForTimeout(200);await page.screenshot({path:`.qa/er54-motion-${theme}.png`});}
   const headerClose=await closingSnapshot(page,a.key,'header');assertClosing(headerClose,'users');await waitClosed(a.card);await waitExpanded(a.title,false);assert.deepEqual(await geometry(page),before,'详情开关不得改字段锚点、卡片高度或连线 d');
   await a.title.focus();await a.title.press('Enter');await waitExpanded(a.title,true);await a.title.press('Space');await waitExpanded(a.title,false);await waitClosed(a.card);await a.title.press('Space');await waitExpanded(a.title,true);
   assertClosing(await closingSnapshot(page,a.key,'close'),'users');await waitClosed(a.card);await a.title.press('Enter');await waitExpanded(a.title,true);assertClosing(await closingSnapshot(page,a.key,'escape'),'users');await waitClosed(a.card);
   // 30 ms 内 A→B→A，等待超过旧定时器的有效期后，新面板仍存在。
   const rapid=await page.evaluate(async({a,b})=>{const title=k=>[...document.querySelectorAll('[data-er-table]')].find(e=>e.dataset.erTable===k).querySelector(':scope > header > button:first-child');title(a).click();await new Promise(requestAnimationFrame);title(b).click();await new Promise(requestAnimationFrame);title(a).click();await new Promise(r=>setTimeout(r,210));return {active:[...document.querySelectorAll('[aria-label="关系图详情"]')].map(e=>e.closest('[data-er-table]').dataset.erTable),closing:document.querySelectorAll('.dw-er-card-detail[data-state="closing"]').length};},{a:a.key,b:b.key});assert.deepEqual(rapid,{active:[a.key],closing:0});
   await dragHeader(page,a.card,zoom);await waitExpanded(a.title,true);await a.title.focus();await a.title.press('Enter');await waitExpanded(a.title,false);await waitClosed(a.card);
   await dragHeader(page,a.card,zoom);await waitExpanded(a.title,false);await a.title.focus();await a.title.press('Space');await waitExpanded(a.title,true);await page.waitForTimeout(180);assert.equal(await a.card.getByLabel('关系图详情',{exact:true}).count(),1);
   // AI 面板与详情开关独立；切换不触发任务取消或清空输入。
   await a.title.press('Enter');await waitExpanded(a.title,false);await waitClosed(a.card);await page.getByRole('button',{name:'AI 识别关联',exact:true}).click();const ai=page.getByLabel('AI 识别关联',{exact:true});await ai.getByLabel('关联识别补充要求',{exact:true}).fill('保留业务说明 '+engine);await a.title.evaluate(e=>e.click());await waitExpanded(a.title,true);await a.title.evaluate(e=>e.click());await waitExpanded(a.title,false);await waitClosed(a.card);assert.equal(await ai.getByLabel('关联识别补充要求',{exact:true}).inputValue(),'保留业务说明 '+engine);assert(await ai.isVisible());assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command==='task_cancel').length),0);await ai.getByRole('button',{name:'关闭 AI 识别',exact:true}).click();
   // 隐藏未选中 A 不得冒泡改为选中 A 或关闭 B。
   await b.title.evaluate(e=>e.click());await waitExpanded(b.title,true);await a.card.getByRole('button',{name:'隐藏 '+(engine==='postgres'?'app.':'')+'users',exact:true}).click();assert.equal(await a.card.count(),0);assert.equal(await b.title.getAttribute('aria-expanded'),'true');assert.equal(await b.card.getByLabel('关系图详情',{exact:true}).count(),1);
   assert.deepEqual(errors,[]);assert.equal(await page.evaluate(()=>window.calls.some(c=>/ddl_|grid_commit|query_execute/.test(c.command))),false);results.push({engine,theme,zoom,passed:true});console.log(`PASS ${engine} ${theme} ${zoom}: 二次点击/键盘、退场缓存与禁用、快速反转、拖动隔离、AI 共存和连线锚点`);
  }catch(e){await page.screenshot({path:`.qa/er54-motion-failure-${engine}-${theme}-${zoom}.png`}).catch(()=>{});throw e;}finally{await page.close();}
 }
 const page=await browser.newPage({viewport:{width:1800,height:1000},reducedMotion:'reduce'});try{await page.goto('http://127.0.0.1:1425/scripts/fixtures/er.html?engine=sqlite&theme=dark',{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>!document.querySelector('.dw-er-loading'));const a=await cardFor(page,'sqlite','users');await a.title.evaluate(e=>e.click());await waitExpanded(a.title,true);assert.equal(await a.card.getByLabel('关系图详情',{exact:true}).evaluate(e=>getComputedStyle(e).animationName),'none');await a.title.evaluate(e=>e.click());await waitClosed(a.card);extra.reducedMotion=true;console.log('PASS 减少动态效果：无动画且立即完成收起');}finally{await page.close();}
 fs.writeFileSync(resultPath,JSON.stringify({passed:true,results,...extra},null,2));
 }catch(e){fs.writeFileSync(resultPath,JSON.stringify({passed:false,results,error:String(e),...extra},null,2));throw e;}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1});
