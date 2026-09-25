// Run Vite on port 1425, then run this script with PLAYWRIGHT_MODULE set if needed.
// Uses only an isolated headless Edge process and synthetic task data.
const assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{const browser=await chromium.launch({headless:true,channel:'msedge'});try{
 const p=await browser.newPage({viewport:{width:1200,height:800}});await p.goto(process.env.TASK_UI_URL||'http://localhost:1425/scripts/fixtures/task-ui.html');
 const trigger=p.locator('.dw-task-trigger'),card=p.locator('.dw-task-hover');
 await trigger.hover();await card.waitFor({state:'visible'});
 await p.waitForTimeout(2300);assert(await card.isVisible(),'持续进度更新时保持显示');
 await card.hover();await p.waitForTimeout(600);assert(await card.isVisible(),'移入浮层不消失');
 await p.locator('#outside').hover();await card.waitFor({state:'hidden'});
 await p.locator('#outside').click();await p.keyboard.press('Tab');await card.waitFor({state:'visible'});await p.keyboard.press('Escape');await card.waitFor({state:'hidden'});
 await trigger.click();await p.getByRole('dialog',{name:'任务中心',exact:true}).waitFor();assert(!await card.isVisible(),'打开任务中心时不叠加浮层');await p.getByRole('button',{name:'关闭',exact:true}).click();
 assert.equal(await p.locator('#generation-tab .dw-tab-activity').getAttribute('aria-busy'),'true');
 assert.equal(await p.locator('#other-tab .dw-tab-activity').getAttribute('aria-busy'),'false','按来源页签隔离');
 await p.evaluate(()=>window.updateTask('test',{status:'cancelling'}));await p.getByLabel('正在停止 · 生成测试数据').waitFor();
 for(const status of ['success','error','cancelled']){await p.evaluate(status=>window.updateTask('test',{status}),status);await p.waitForTimeout(30);assert.equal(await p.locator('#generation-tab .dw-tab-activity').getAttribute('aria-busy'),'false');}
 await p.evaluate(()=>window.taskStore.setState({tasks:Array.from({length:4},(_,i)=>({id:'t'+i,kind:'生成',label:'任务'+i,sessionIds:[],status:'running',startedAt:Date.now(),progress:{processed:i,total:4,message:'正在生成',cancelRequested:false}}))}));
 const cdp=await p.context().newCDPSession(p);
 for(const zoom of [0.8,1,1.25,1.5]){await p.mouse.move(0,0);await cdp.send('Emulation.setDeviceMetricsOverride',{width:Math.floor(1200/zoom),height:Math.floor(800/zoom),deviceScaleFactor:zoom,mobile:false});await trigger.hover();await card.waitFor({state:'visible'});await p.waitForTimeout(400);assert.equal(await card.locator('section').count(),3);assert.equal(await card.getByRole('progressbar').count(),3);assert(await card.isVisible(),'缩放后可见');const box=await card.boundingBox();assert(box.y>=0&&box.y+box.height<=Math.floor(800/zoom)+1,'浮层应在视口中');}
 await cdp.send('Emulation.clearDeviceMetricsOverride');await p.setViewportSize({width:640,height:480});await trigger.hover();await card.waitFor({state:'visible'});await p.waitForTimeout(500);const box=await card.boundingBox();assert(box.x>=0&&box.y>=0&&box.x+box.width<=640&&box.y+box.height<=480,'窄窗口浮层可见');
 await p.screenshot({path:'.qa/task-ui-v111.png'});
 console.log('通过：滚动容器中的悬浮持续显示、移入/离开、键盘聚焦/Esc、完整任务中心、前三任务、缩放/窄窗口、来源页签动画与结束状态。');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
