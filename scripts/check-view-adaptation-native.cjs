// 正式 EXE、隔离配置；MySQL 仅使用复制到测试配置的只读会话，写入限于专用 MariaDB/SQLite 测试对象。
const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),{DatabaseSync}=require('node:sqlite');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const version=process.env.DBFOLIO_TEST_VERSION||require('../package.json').version;
 const out=path.resolve('.qa/views48-native-'+Date.now());fs.mkdirSync(out,{recursive:true});fs.writeFileSync('.qa/views48-latest-native.txt',out);
 const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
 const exe=path.resolve(`release/${version}/DBFolio_${version}_windows_x64_portable/dbfolio.exe`);assert(fs.existsSync(exe));
 const app=spawn(exe,['--startup-check',path.join(out,'profile')],{cwd:path.dirname(exe),windowsHide:true,env:{...process.env,WEBVIEW2_USER_DATA_FOLDER:path.join(out,'webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`},stdio:'ignore'});
 let browser,page,invoke,step='启动';const owned=[],cleanup=[],result={version,engines:[],cases:[],passed:false};
 try{
  for(let i=0;i<180&&!fs.existsSync(path.join(out,'profile/frontend-ready.json'));i++)await delay(250);
  assert(fs.existsSync(path.join(out,'profile/frontend-ready.json')),'正式程序未就绪');
  browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);page=browser.contexts()[0].pages()[0];
  invoke=(command,args={})=>page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args).catch(e=>{throw Error(JSON.stringify(e))}),{command,args});
  const query=(base,sql)=>invoke('query_execute',{...base,sql,force:true,limit:100});
  const create=async(input)=>{const session=await invoke('session_create',{input:{readOnly:false,...input}});owned.push(session.id);const status=await invoke('session_connect',{id:session.id});assert(status.connected);return {session,status};};
  const validateUi=async(session,database,view,engine)=>{
   await page.reload({waitUntil:'domcontentloaded'});await page.getByTitle(session.name,{exact:true}).first().click();
   const branch=page.locator(`[data-fui-tree-item-value=${JSON.stringify('db:'+database)}]`);await branch.waitFor();
   if(await branch.getAttribute('aria-expanded')!=='true')await branch.locator('.fui-TreeItemLayout__expandIcon').first().click();
   const tree=page.getByRole('group',{name:database+' 对象',exact:true});await tree.getByText(view,{exact:true}).dblclick();
   await page.locator('.dw-workspace-tab svg[aria-label="视图"]').waitFor();await page.getByRole('tab',{name:'数据',exact:true}).click();
   await page.locator('.ag-row').first().waitFor();
   for(const name of ['添加行','删除行','粘贴','提交','放弃修改','数据生成','触发器','查看关联'])assert.equal(await page.getByRole('button',{name,exact:true}).count(),0,engine+' '+name);
   assert.equal(await page.getByRole('tab',{name:/^索引|^外键/}).count(),0);
   await page.getByRole('tab',{name:/^结构/}).click();const columns=page.locator('.dw-view-columns');await columns.getByRole('table').waitFor();assert.equal(await columns.locator('input,select,textarea,button').count(),0);
   for(const name of ['默认值','自动增长','ON UPDATE','无符号','键','操作'])assert.equal(await columns.getByRole('columnheader',{name,exact:true}).count(),0);
   await page.screenshot({path:path.join(out,engine+'-structure.png')});
   await page.getByRole('tab',{name:'信息',exact:true}).click();const info=page.locator('.dw-table-info');await info.getByText('列数',{exact:true}).waitFor();
   for(const label of ['索引数','外键数','主键','自增','引擎','字符集','排序规则','行数（估算）','存储'])assert.equal(await info.getByText(label,{exact:true}).count(),0,engine+' 信息 '+label);
   await page.getByRole('tab',{name:'DDL',exact:true}).click();await page.locator('.monaco-editor').first().waitFor();
   const workspace=page.locator('.dw-workspace-tab').filter({hasText:view}).first();await workspace.click();
   await page.getByRole('button',{name:'隐藏视图 '+database,exact:true}).click();await page.getByRole('button',{name:'显示视图 '+database,exact:true}).waitFor();assert.equal(await tree.getByText(view,{exact:true}).count(),0);assert.equal(await branch.getAttribute('aria-expanded'),'true');
   assert(await workspace.isVisible());
   const stored=JSON.parse(await invoke('settings_get',{key:'explorer_hidden_views_v1'}));assert.equal(stored[JSON.stringify([session.id,database])],true);
   await page.getByRole('button',{name:'刷新对象 '+database,exact:true}).click();await page.getByRole('button',{name:'刷新对象 '+database,exact:true}).isEnabled();assert.equal(await branch.getAttribute('aria-expanded'),'true');
   await page.reload({waitUntil:'domcontentloaded'});await page.getByTitle(session.name,{exact:true}).first().click();await page.getByRole('button',{name:'显示视图 '+database,exact:true}).waitFor();
   await page.getByRole('button',{name:'显示视图 '+database,exact:true}).click();await page.getByRole('button',{name:'隐藏视图 '+database,exact:true}).waitFor();
   const restored=page.locator(`[data-fui-tree-item-value=${JSON.stringify('db:'+database)}]`);if(await restored.getAttribute('aria-expanded')!=='true')await restored.locator('.fui-TreeItemLayout__expandIcon').first().click();
   await page.getByRole('group',{name:database+' 对象',exact:true}).getByText(view,{exact:true}).waitFor();
   result.cases.push(engine+'：正式界面视图独立图标、只读数据/结构、精简信息/页签、DDL、显隐和刷新不折叠、实际设置保存及前端重启恢复');
  };
  const guard=async(base,view)=>{
   const changes=[{kind:'insert',values:[{column:'id',value:['int',2]},{column:'label',value:['text','禁止写入']}]}];
   for(const command of ['grid_preview_changes','grid_commit'])await assert.rejects(()=>invoke(command,{...base,table:view,schema:null,changes}),/视图数据页仅支持浏览/);
   assert.equal((await query(base,'SELECT id FROM qa48_base ORDER BY id')).rows.length,1,'视图提交不得写入基础表');
   const table={...base,table:'qa48_base',schema:null,changes};assert((await invoke('grid_preview_changes',table)).length);assert.equal(await invoke('grid_commit',table),1);
   assert.equal((await query(base,'SELECT id FROM qa48_base ORDER BY id')).rows.length,2);
   await invoke('grid_commit',{...table,changes:[{kind:'delete',keys:[{column:'id',value:['int',2]}]}]});
   assert.equal((await query(base,'SELECT id FROM qa48_base')).rows.length,1);
  };
  step='MySQL 只读系统视图';
  const source=new DatabaseSync(path.join(process.env.APPDATA,'data-workbench/app.db'),{readOnly:true});
  const mysql=source.prepare("SELECT * FROM sessions WHERE engine='mysql' AND host IN ('localhost','127.0.0.1') AND port=3306 LIMIT 1").get();source.close();assert(mysql);mysql.read_only=1;mysql.name='MySQL 系统视图验收';
  const config=new DatabaseSync(path.join(out,'profile/app.db'));const cols=config.prepare('PRAGMA table_info(sessions)').all().map(c=>c.name).filter(c=>Object.hasOwn(mysql,c));
  config.prepare(`INSERT INTO sessions (${cols.map(c=>'"'+c+'"').join(',')}) VALUES (${cols.map(()=>'?').join(',')})`).run(...cols.map(c=>mysql[c]));config.close();
  // 保留原会话 ID 以使用已有凭据，但绝不 session_delete，避免删除用户凭据。
  const mysqlStatus=await invoke('session_connect',{id:mysql.id});const mysqlBase={sessionId:mysql.id,database:'sys'};
  const sys=await invoke('meta_tables',mysqlBase);const sysView=sys.find(t=>t.name==='memory_by_host_by_current_bytes'&&t.kind==='view')||sys.find(t=>t.name==='host_summary'&&t.kind==='view');assert(sysView);
  assert.equal((await invoke('meta_table_detail',{...mysqlBase,table:sysView.name})).kind,'view');assert((await query(mysqlBase,'SELECT * FROM `'+sysView.name+'`')).rows.length);
  await validateUi(mysql,'sys',sysView.name,'mysql');result.engines.push({engine:'mysql',serverVersion:mysqlStatus.serverVersion,readOnly:true});
  step='MariaDB 可更新视图与网格保护';const credentials=JSON.parse(fs.readFileSync('.qa/mariadb-connection.json','utf8'));assert.equal(credentials.database,'dbfolio_compat');assert.equal(credentials.host,'127.0.0.1');
  const maria=await create({name:'MariaDB 视图验收',engine:'mysql',host:credentials.host,port:credentials.port,username:credentials.username,password:credentials.password});const mariaBase={sessionId:maria.session.id,database:credentials.database};
  // 固定 qa48_ 前缀仅用于本轮专用验收；若已有对象则拒绝覆盖。
  const existing=await invoke('meta_tables',mariaBase);assert(!existing.some(t=>['qa48_base','qa48_view'].includes(t.name)),'专用对象已存在，请先检查上轮验收记录');
  await query(mariaBase,'CREATE TABLE qa48_base(id INT PRIMARY KEY,label VARCHAR(80))');cleanup.push({base:mariaBase,sql:'DROP TABLE IF EXISTS qa48_base'});
  await query(mariaBase,"INSERT INTO qa48_base VALUES (1,'中文视图')");await query(mariaBase,'CREATE VIEW qa48_view AS SELECT id,label FROM qa48_base');cleanup.push({base:mariaBase,sql:'DROP VIEW IF EXISTS qa48_view'});
  assert.equal((await invoke('meta_table_detail',{...mariaBase,table:'qa48_view'})).kind,'view');await guard(mariaBase,'qa48_view');
  await query(mariaBase,"UPDATE qa48_view SET label='SQL 明确更新' WHERE id=1");assert.equal((await query(mariaBase,'SELECT label FROM qa48_base')).rows[0][0][1],'SQL 明确更新');
  await validateUi(maria.session,mariaBase.database,'qa48_view','mariadb');result.engines.push({engine:'mariadb',serverVersion:maria.status.serverVersion,updatableViewGuard:true,tableCrud:true,explicitSql:true});
  step='SQLite INSTEAD OF 触发器视图与网格保护';const filePath=path.join(out,'sample.db');fs.writeFileSync(filePath,'');const sqlite=await create({name:'SQLite 视图验收',engine:'sqlite',filePath});const sqliteBase={sessionId:sqlite.session.id,database:'main'};
  for(const sql of ['CREATE TABLE qa48_base(id INTEGER PRIMARY KEY,label TEXT)',"INSERT INTO qa48_base VALUES (1,'中文视图')",'CREATE VIEW qa48_view AS SELECT id,label FROM qa48_base','CREATE TRIGGER qa48_insert INSTEAD OF INSERT ON qa48_view BEGIN INSERT INTO qa48_base(id,label) VALUES(NEW.id,NEW.label); END'])await query(sqliteBase,sql);
  await guard(sqliteBase,'qa48_view');await query(sqliteBase,"INSERT INTO qa48_view VALUES(3,'SQL 显式插入')");assert.equal((await query(sqliteBase,'SELECT label FROM qa48_base WHERE id=3')).rows[0][0][1],'SQL 显式插入');await query(sqliteBase,'DELETE FROM qa48_base WHERE id=3');
  await validateUi(sqlite.session,'main','qa48_view','sqlite');result.engines.push({engine:'sqlite',serverVersion:sqlite.status.serverVersion,insteadOfTriggerGuard:true,tableCrud:true,explicitSql:true});
  result.cases.push('MariaDB 可更新视图和 SQLite 带 INSTEAD OF 触发器视图：预览/提交统一后端拒绝、基础表不变；普通表网格增删回归与明确 SQL 写入仍可用');
  result.postgres='按用户既有决定保留真实服务器待验收；组件矩阵及物化视图索引读取已覆盖';result.passed=true;
 }catch(e){result.failedStep=step;result.error=String(e);process.exitCode=1;if(page)await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});}
 finally{
  if(invoke){for(const item of cleanup.reverse())try{await invoke('query_execute',{...item.base,sql:item.sql,force:true,limit:100});}catch(e){(result.cleanupErrors??=[]).push(String(e));}for(const id of owned)await invoke('session_delete',{id}).catch(e=>(result.cleanupErrors??=[]).push(String(e)));await invoke('plugin:window|destroy',{label:'main'}).catch(()=>{});}
  if(browser)await browser.close().catch(()=>{});for(let i=0;i<30&&app.exitCode===null;i++)await delay(100);if(app.exitCode===null)app.kill();
  if(result.cleanupErrors?.length){result.passed=false;process.exitCode=1;}fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));console.log(out);
 }
})().catch(e=>{console.error(e);process.exitCode=1});
