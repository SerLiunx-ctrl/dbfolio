const {chromium}=require('C:/Users/zhangwq/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert=require('node:assert/strict');
(async()=>{const b=await chromium.launch({channel:'msedge',headless:true});try{
 const p=await b.newPage({viewport:{width:1100,height:900}});const errors=[];p.on('pageerror',e=>errors.push(e.message));
 await p.goto('http://localhost:1425/scripts/fixtures/access-scope.html');
 for(const n of ['空列表','单条','多条']){await p.getByRole('button',{name:n,exact:true}).click();for(const title of ['新建索引','添加外键']){const button=p.getByRole('button',{name:title,exact:true});assert(await button.isVisible());assert(await button.isEnabled());const r=await button.boundingBox();assert(r.x+r.width<1101&&r.x>700);}}
 await p.getByRole('button',{name:'切换只读'}).click();for(const title of ['新建索引','添加外键']){const btn=p.getByRole('button',{name:title,exact:true});assert(await btn.isVisible());assert(await btn.isDisabled());}
 await p.getByRole('button',{name:'会话设置'}).click();await p.getByRole('switch',{name:'仅允许指定数据库'}).check();await p.getByRole('button',{name:'从当前连接选择'}).click();await p.getByRole('checkbox',{name:'test_db',exact:true}).check();assert.equal(await p.getByLabel('允许的数据库（每行一个）').inputValue(),'test_db');
 await p.getByRole('button',{name:'保存',exact:true}).click();await p.getByRole('dialog').waitFor({state:'hidden'});const input=await p.evaluate(()=>window.calls.find(c=>c.command==='session_update').args.input);assert.deepEqual(input.allowedDatabases,['test_db']);assert.equal(await p.evaluate(()=>window.explorer.getState().databases.s),undefined);assert.equal(await p.evaluate(()=>window.sessions.getState().statuses.s),undefined);
 await p.getByRole('button',{name:'会话设置'}).click();assert(await p.getByRole('switch',{name:'仅允许指定数据库'}).isChecked());assert.equal(await p.getByLabel('允许的数据库（每行一个）').inputValue(),'test_db');await p.screenshot({path:'.qa/access-scope-v147.png'});assert.deepEqual(errors,[]);console.log('通过：索引/外键零条、单条、多条及只读按钮；白名单选择、保存、重开回显、断开连接与缓存清理');
}finally{await b.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
