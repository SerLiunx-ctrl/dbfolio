const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1500,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:1425/scripts/fixtures/session-completion-fixes.html');
  await page.locator('.monaco-editor').waitFor();
  const edit=async name=>{await page.locator('.session-row').filter({hasText:name}).click({button:'right'});await page.getByRole('menuitem',{name:'编辑会话',exact:true}).click();await page.getByRole('dialog',{name:'编辑会话',exact:true}).waitFor();};
  await edit('本机 B');await page.getByPlaceholder('例如：本地 MySQL').fill('更新后的 B');await page.getByRole('button',{name:'保存',exact:true}).click();
  await page.getByRole('dialog',{name:'编辑会话',exact:true}).waitFor({state:'hidden'});
  let state=await page.evaluate(()=>({active:window.sessions.getState().activeSessionId,tab:window.tabs.getState().activeId,calls:window.calls}));
  assert.equal(state.active,'a');assert.equal(state.tab,'qa');assert(state.calls.some(c=>c.command==='session_update'&&c.args.id==='b'));
  await page.locator('.monaco-editor').waitFor();
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('dw:settings',{detail:{category:'appearance'}})));
  await page.getByRole('textbox',{name:'搜索设置',exact:true}).waitFor();
  await edit('更新后的 B');await page.getByPlaceholder('例如：本地 MySQL').fill('更新后的 B');await page.getByRole('button',{name:'保存',exact:true}).click();
  await page.getByRole('dialog',{name:'编辑会话',exact:true}).waitFor({state:'hidden'});
  await page.getByRole('textbox',{name:'搜索设置',exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.sessions.getState().activeSessionId),'a');
  await page.evaluate(()=>window.dispatchEvent(new Event('dw:show-workspace')));
  // 编辑当前会话同样不跳到其他会话/页签；原有配置更新后的断开保护保留。
  await edit('本机 A');await page.getByPlaceholder('例如：本地 MySQL').fill('更新后的 A');await page.getByRole('button',{name:'保存',exact:true}).click();
  await page.getByRole('dialog',{name:'编辑会话',exact:true}).waitFor({state:'hidden'});
  state=await page.evaluate(()=>({active:window.sessions.getState().activeSessionId,tab:window.tabs.getState().activeId}));assert.equal(state.active,'a');assert.equal(state.tab,'qa');
  // 原有新建/复制选中新会话行为不受影响。
  await page.locator('.session-row').filter({hasText:'更新后的 B'}).click({button:'right'});await page.getByRole('menuitem',{name:'复制会话',exact:true}).click();
  await page.getByRole('dialog',{name:'复制会话',exact:true}).waitFor();await page.getByRole('button',{name:'保存',exact:true}).click();
  await page.getByRole('dialog',{name:'复制会话',exact:true}).waitFor({state:'hidden'});
  assert((await page.evaluate(()=>window.sessions.getState().activeSessionId)).startsWith('new'));
  assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command==='session_connect'||c.command==='query_execute').length),0);
  console.log('PASS actual App: editing background/current session preserves session and tab; copy still selects new session; no auto-connect or SQL');
  assert.deepEqual(errors,[]);
  await page.goto('http://127.0.0.1:1425/scripts/fixtures/session-completion-fixes.html?mode=completion');await page.waitForFunction(()=>window.editor);
  const set=async(engine,text,database='db')=>{
   await page.evaluate(({engine,text,database})=>{window.editor.trigger('test','hideSuggestWidget',{});window.sessions.setState(s=>({sessions:s.sessions.map(v=>({...v,engine}))}));window.context={sessionId:'a',database};const offset=text.indexOf('|');window.editor.setValue(text.replace('|',''));window.editor.setPosition(window.editor.getModel().getPositionAt(offset));window.editor.focus();},{engine,text,database});
  };
  const complete=()=>page.evaluate(()=>window.complete());
  const apply=async label=>page.evaluate(async label=>{const {suggestions}=await window.complete();const item=suggestions.find(s=>s.label===label);if(!item)throw Error('缺少候选 '+label);window.editor.executeEdits('accept-test',[{range:item.range,text:item.insertText}]);return window.editor.getValue();},label);
  for(const engine of ['mysql','postgres','sqlite']){
   const quote=engine==='mysql'?'`':'"';
   const sql=`SELECT count(*) FROM ${quote}digital_n|config_asr${quote} WHERE deleted = 0;`;
   await set(engine,sql);
   // 实际打开 Monaco 建议列表并按 Enter 接受，验证带引号的筛选与替换范围。
   await page.evaluate(()=>window.editor.trigger('test','editor.action.triggerSuggest',{}));
   const candidate=page.locator('.suggest-widget.visible').getByText('digital_new_table',{exact:true});await candidate.waitFor();await page.keyboard.press('Enter');
   assert.equal(await page.evaluate(()=>window.editor.getValue()),`SELECT count(*) FROM ${quote}digital_new_table${quote} WHERE deleted = 0;`);
   await set(engine,'SELECT * FROM digital_|config_asr WHERE deleted=0;');
   assert.equal(await apply('digital_new_table'),`SELECT * FROM ${quote}digital_new_table${quote} WHERE deleted=0;`);
   await set(engine,`SELECT t.${quote}del|eted${quote} FROM ${quote}digital_config_asr${quote} t;`);
   assert.equal(await apply('deleted'),`SELECT t.${quote}deleted${quote} FROM ${quote}digital_config_asr${quote} t;`);
   for(const text of ["SELECT 'digital_|config_asr'",'SELECT 1 -- digital_|config_asr','SELECT /* digital_|config_asr */ 1;']){
    await set(engine,text);const count=await page.evaluate(()=>window.calls.length);assert.deepEqual((await complete()).suggestions,[]);assert.equal(await page.evaluate(()=>window.calls.length),count);
   }
   await set(engine,`SELECT * FROM ${quote}digital_|`);assert.equal(await apply('digital_new_table'),`SELECT * FROM ${quote}digital_new_table${quote}`);
   console.log(`PASS ${engine}: actual Monaco quoted acceptance, full suffix replacement, alias fields, unfinished quote, string/comment protection`);
  }
  await set('mysql','SELECT * FROM `db`.`digital_|config_asr`;');assert.equal(await apply('digital_new_table'),'SELECT * FROM `db`.`digital_new_table`;');
  await set('mysql','SELECT * FROM `odd``|tail`;');assert.equal(await apply('odd`name'),'SELECT * FROM `odd``name`;');
  await set('postgres','SELECT * FROM "odd""|tail";');assert.equal(await apply('odd"name'),'SELECT * FROM "odd""name";');
  await set('sqlite','SELECT * FROM [odd]]|tail];');assert.equal(await apply('odd]name'),'SELECT * FROM "odd]name";');
  await set('postgres','SELECT $body$ digital_|config_asr $body$;');assert.deepEqual((await complete()).suggestions,[]);
  await set('mysql','SELECT "digital_|config_asr";');assert.deepEqual((await complete()).suggestions,[]);
  await set('mysql','SELECT * FROM `digital_|config_asr`;','other');assert((await complete()).suggestions.some(s=>s.label==='digital_new_table'));
  assert.equal(await apply('digital_new_table'),'SELECT * FROM `digital_new_table`;');
  // 元数据返回前切库，旧请求不得将候选送入新库。
  await set('mysql','SELECT * FROM dig|','delayed');await page.evaluate(()=>{window.delayTables=250;window.pendingCompletion=window.complete();window.context={sessionId:'a',database:'other'};});
  assert.deepEqual((await page.evaluate(()=>window.pendingCompletion)).suggestions,[]);
  assert.deepEqual(errors,[]);console.log('PASS escaped identifiers, database qualifier/switch, dollar quotes, stale response guard; no page errors');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
