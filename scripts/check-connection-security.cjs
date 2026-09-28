const {chromium}=require('C:/Users/zhangwq/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({channel:'msedge',headless:true});try{
const page=await browser.newPage({viewport:{width:1300,height:1050}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
for(const theme of ['', '?oled']){
 await page.goto('http://localhost:1425/scripts/fixtures/connection-security.html'+theme);
 await page.getByText('连接安全与超时',{exact:true}).click();
 await page.getByLabel('连接超时（秒）',{exact:true}).fill('12');await page.getByLabel('查询超时（秒）',{exact:true}).fill('90');
 await page.getByRole('switch',{name:'通过 SSH 隧道连接',exact:true}).check();
 await page.getByLabel('SSH 主机',{exact:true}).fill('jump.example');await page.getByLabel('SSH 用户名',{exact:true}).fill('qa');
 await page.getByRole('button',{name:'获取服务器指纹',exact:true}).click();
 await page.getByRole('button',{name:'已核对，信任此指纹',exact:true}).waitFor();
 assert.equal(await page.getByLabel('已信任的主机指纹（SHA256）',{exact:true}).inputValue(),'');
 await page.getByRole('button',{name:'已核对，信任此指纹',exact:true}).click();
 await page.getByRole('button',{name:'测试连接',exact:true}).click();
 await page.getByText('证书与服务器名不匹配',{exact:true}).waitFor();
 const call=await page.evaluate(()=>window.calls.find(c=>c.command==='session_test').args.input);
 assert.equal(call.network.ssh.host,'jump.example');assert.equal(call.network.connectTimeoutSecs,12);assert.equal(call.network.queryTimeoutSecs,90);assert.equal(call.sshPassword,null);assert(call.network.ssh.fingerprint.startsWith('SHA256:'));
 await page.screenshot({path:'.qa/connection-security'+(theme?'‑oled':'')+'.png'});
 await page.getByLabel('SSH 主机',{exact:true}).fill('changed.example');assert.equal(await page.getByLabel('已信任的主机指纹（SHA256）',{exact:true}).inputValue(),'');
 assert.equal(await page.getByRole('button',{name:'已核对，信任此指纹',exact:true}).count(),0);
}
assert.deepEqual(errors,[]);console.log('PASS 连接安全表单、指纹显式信任与地址变化失效、超时保存、失败诊断及浅色/OLED');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
