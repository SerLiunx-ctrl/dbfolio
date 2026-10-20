const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs');
const assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({channel:'msedge',headless:true,args:['--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows']});try{
const results=[];
for(const kind of ['table','result'])for(let repeat=0;repeat<3;repeat++){
 console.log('START',kind,repeat);const page=await browser.newPage({viewport:{width:2560,height:1440}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const client=await page.context().newCDPSession(page);await client.send('Performance.enable');
 await page.addInitScript(()=>{window.decodes=0;const original=window.atob;window.atob=(s)=>{window.decodes++;return original(s);};});
 await page.goto(`${process.env.GRID_BENCH_URL||'http://localhost:1426'}/scripts/fixtures/grid-scroll.html${kind==='result'?'?result':''}`);
 await page.locator('.ag-row[row-index="0"] [col-id="c0"]').waitFor();await page.waitForTimeout(400);
 const before=await client.send('Performance.getMetrics');
 const record=await page.evaluate(async()=>{
  const viewport=document.querySelector('.ag-grid-viewport');if(!viewport)throw Error('Grid viewport not found');window.decodes=0;
  let frames=[],longTasks=[],last=performance.now();
  const observer=new PerformanceObserver(list=>longTasks.push(...list.getEntries().map(e=>e.duration)));observer.observe({type:'longtask',buffered:false});
  let maxRows=0,maxCells=0;
  await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('滚动采样超时')),60000);let frame=0;function tick(now){frames.push(now-last);last=now;viewport.scrollTop=(frame<90?frame:180-frame)*130;frame++;maxRows=Math.max(maxRows,document.querySelectorAll('.ag-row').length);maxCells=Math.max(maxCells,document.querySelectorAll('.ag-cell').length);if(frame<180)requestAnimationFrame(tick);else {clearTimeout(timeout);resolve();}}requestAnimationFrame(tick);});
  await new Promise(r=>setTimeout(r,100));observer.disconnect();frames=frames.slice(3).sort((a,b)=>a-b);
  return {p95:frames[Math.floor(frames.length*.95)],max:frames.at(-1),over34:frames.filter(v=>v>34).length,longTasks:longTasks.length,longTaskMs:longTasks.reduce((a,b)=>a+b,0),decodes:window.decodes,maxRows,maxCells,domNodes:document.querySelectorAll('*').length,calls:window.calls.length};
 });
 assert.deepEqual(errors,[]);assert(record.maxRows>0&&record.maxRows<570,'Row virtualization remains enabled');assert.equal(record.calls,0,'Scrolling must not query the database');
 const after=await client.send('Performance.getMetrics');const metric=(name)=>after.metrics.find(x=>x.name===name).value-before.metrics.find(x=>x.name===name).value;
 results.push({kind,repeat,...record,taskMs:metric('TaskDuration')*1000,scriptMs:metric('ScriptDuration')*1000,layoutMs:metric('LayoutDuration')*1000,recalcMs:metric('RecalcStyleDuration')*1000});console.log('DONE',kind,repeat,record);await page.close();
}
fs.writeFileSync(process.env.GRID_BENCH_REPORT||'.qa/grid-before.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
