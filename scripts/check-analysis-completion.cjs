const assert=require('node:assert/strict');
const {chromium}=require('C:/Users/zhangwq/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
(async()=>{const b=await chromium.launch({headless:true,channel:'msedge'});try{
const p=await b.newPage({viewport:{width:1200,height:900}}),errors=[];p.on('pageerror',e=>errors.push(e.message));
await p.goto('http://localhost:1425/scripts/fixtures/analysis-ui.html');
await p.locator('.dw-analysis-source summary').click();await p.locator('.dw-analysis-sql-editor .monaco-editor').waitFor();
const suggest=async(text,column)=>{await p.evaluate(({text,column})=>{const e=window.monaco.editor.getEditors()[0];e.setValue(text);e.setPosition({lineNumber:1,column:column??text.length+1});e.focus();e.trigger('test','editor.action.triggerSuggest',{});},{text,column});};
for(const scale of [1,1.25,1.5,.8]){
await p.evaluate(scale=>{const root=document.getElementById('root');root.style.transform='scale('+scale+')';root.style.transformOrigin='top left';root.style.width=(100/scale)+'%';},scale);
await p.evaluate(()=>document.querySelector('.dw-analysis').scrollTop=24);
await suggest('SELECT * FROM ord');
await p.locator('.suggest-widget.visible').getByText('orders',{exact:true}).waitFor();
const geometry=await p.evaluate(scale=>{const e=window.monaco.editor.getEditors()[0],pos=e.getScrolledVisiblePosition(e.getPosition()),rect=e.getDomNode().getBoundingClientRect(),w=document.querySelector('.suggest-widget.visible').getBoundingClientRect();return {dx:w.left-(rect.left+pos.left*scale),dy:w.top-(rect.top+(pos.top+pos.height)*scale),height:w.height};},scale);
assert(Math.abs(geometry.dx)<12,'缩放 '+scale+' 横向偏移 '+JSON.stringify(geometry));assert(Math.abs(geometry.dy)<12,'缩放 '+scale+' 纵向偏移 '+JSON.stringify(geometry));
await p.keyboard.press('Escape');
}
await p.evaluate(()=>{const r=document.getElementById('root');r.style.transform='';r.style.width='';});
await suggest('SELECT * FROM ord');await p.locator('.suggest-widget.visible').getByText('orders',{exact:true}).waitFor();
await p.keyboard.press('Escape');await suggest('SELECT o. FROM orders o',10);await p.locator('.suggest-widget.visible').getByText('customer_name',{exact:true}).waitFor();
await p.keyboard.press('Enter');assert((await p.evaluate(()=>window.monaco.editor.getModels()[0].getValue())).includes('"customer_name"'));
await p.getByLabel('数据库',{exact:true}).fill('other');
await suggest('SELECT * FROM other');await p.locator('.suggest-widget.visible').getByText('other_table',{exact:true}).waitFor();
assert(await p.evaluate(()=>window.calls.some(c=>c.command==='meta_tables'&&c.args.database==='other')));
assert.equal(await p.evaluate(()=>window.calls.filter(c=>c.command==='analysis_query').length),0);
await p.keyboard.press('Escape');await p.getByRole('button',{name:'保存方案',exact:true}).click();await p.getByText('分析方案已保存。下次打开后手动刷新数据。').waitFor();
assert((await p.evaluate(()=>[...window.storage.values()].join(''))).includes('SELECT * FROM other'));
await p.setViewportSize({width:720,height:800});assert(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
await p.screenshot({path:'.qa/analysis-completion-v121.png'});assert.deepEqual(errors,[]);console.log('通过：分析 SQL 表名、别名字段补全、切库范围、编辑保存、不自动执行和窄窗口。');
}finally{await b.close();}})().catch(e=>{console.error(e);process.exitCode=1;});