// alpha60 正式 EXE：独立配置、随机源/目标模式、真实原生 DDL 回放及 UI 验收。
const fs = require('node:fs'), path = require('node:path'), net = require('node:net'), assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { ddlFixture, remapQualifiedOwners } = require('./fixtures/dameng-ddl.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const ident = value => '"' + value.replace(/"/g, '""') + '"';
const canonicalNewlines = value => value.replace(/\r\n/g, '\n');

(async () => {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const version = process.env.DBFOLIO_TEST_VERSION || require('../package.json').version;
  const exe = path.resolve(`release/${version}/DBFolio_${version}_windows_x64_portable/dbfolio.exe`);
  assert(fs.existsSync(exe), '先完成正式 portable 构建');
  let password = process.env.DBFOLIO_TEST_DM_PASSWORD;
  if (!password) { const inspected = spawnSync('docker', ['inspect', 'platform-dm8'], { encoding: 'utf8', windowsHide: true }); assert.equal(inspected.status, 0, '需要已启动的 platform-dm8'); password = JSON.parse(inspected.stdout)[0].Config.Env.find(v => v.startsWith('SYSDBA_PWD='))?.slice('SYSDBA_PWD='.length); }
  assert(password, '缺少本机测试凭据');
  const out = path.resolve('.qa/dm60-ddl-native-' + Date.now()); fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync('.qa/dm60-ddl-native-latest.txt', out);
  const prefix = 'DBFOLIO_DM60_' + Date.now(), names = { a: prefix + '_A', b: prefix + '_B', ta: prefix + '_TA', tb: prefix + '_TB' };
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve)); const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const app = spawn(exe, ['--startup-check', path.join(out, 'profile')], { cwd: path.dirname(exe), windowsHide: true, stdio: 'ignore', env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: path.join(out, 'webview'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1` } });
  let browser, page, invoke, sessionId, readOnlySessionId, clipboard, clipboardChanged = false, step = '启动', launchError;
  app.on('error', error => { launchError = error; });
  const created = [], result = { version, names, cases: [], passed: false };
  try {
    const ready = path.join(out, 'profile/frontend-ready.json');
    for (let i = 0; i < 240 && !fs.existsSync(ready); i++) { if (launchError) throw launchError; assert.equal(app.exitCode, null, '正式 EXE 提前退出'); await delay(250); }
    assert(fs.existsSync(ready), '正式 EXE 未就绪'); assert.equal(JSON.parse(fs.readFileSync(ready, 'utf8')).version, version);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); page = browser.contexts()[0].pages()[0]; page.setDefaultTimeout(20_000);
    invoke = async (command, args = {}) => { for(let attempt=0;;attempt++) { try { return await page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args).catch(error => { throw Error(JSON.stringify(error)); }), { command, args }); } catch(error) { if(!command.startsWith('clipboard_') || attempt>=20) throw error; await delay(50); } } };
    const session = await invoke('session_create', { input: { name: 'DM60 DDL 验收', engine: 'dameng', host: '127.0.0.1', port: Number(process.env.DBFOLIO_TEST_DM_PORT || 15236), username: 'SYSDBA', password, readOnly: false } }); sessionId = session.id;
    await invoke('session_connect', { id: sessionId });
    const query = (sql, database = 'SYSDBA') => invoke('query_execute', { sessionId, database, sql, force: true, limit: 100 });
    const metadata = (schema, table) => invoke('meta_table_detail', { sessionId, database: schema, schema, table });
    step = '隔离源结构';
    const existing = await invoke('meta_databases', { sessionId });
    for (const name of Object.values(names)) { assert(/^DBFOLIO_DM60_\d{13}_(?:A|B|TA|TB)$/.test(name)); assert(!existing.some(d => d.name === name)); await query(`CREATE SCHEMA ${ident(name)}`); created.push(name); }
    const fixture = ddlFixture(names.a, names.b);
    for (const sql of fixture.statements) await query(sql);
    result.cases.push('随机双源与双目标模式，双向跨模式外键、命名/匿名约束、普通/独立唯一/表达式索引、中文多行注释与视图');

    step = '原生定义完整回放';
    const definitions = [];
    for (const object of fixture.objects) {
      const source = await metadata(object.schema, object.table);
      assert.deepEqual(source.ddlWarnings || [], [], object.table + ' 正常原生读取不应报缺失'); assert(source.rawDdl);
      const targetSchema = object.schema === names.a ? names.ta : names.tb;
      const mapped = remapQualifiedOwners(source.rawDdl, { [names.a]: names.ta, [names.b]: names.tb });
      await query(`SET SCHEMA ${ident(targetSchema)};\n` + mapped, targetSchema);
      const target = await metadata(targetSchema, object.table);
      assert.deepEqual(target.ddlWarnings || [], []); assert.equal(target.comment, source.comment); assert.deepEqual(target.primaryKey, source.primaryKey);
      assert.deepEqual(target.columns.map(c => [c.name, c.rawType, c.nullable, c.autoIncrement, c.comment]), source.columns.map(c => [c.name, c.rawType, c.nullable, c.autoIncrement, c.comment]));
      assert.equal(target.foreignKeys.length, source.foreignKeys.length);
      for (const fk of target.foreignKeys) assert([names.ta, names.tb].includes(fk.refSchema));
      for (const name of ['QA_IX', 'QA_UIX', 'QA_EXPR']) if (source.indexes.some(i => i.name === name)) assert(target.indexes.some(i => i.name === name));
      if (object.table === 'QA_PARENT') { assert.equal(target.comment, fixture.comment, '模式名文字注释必须原样保留'); assert(source.rawDdl.includes('LOWER("TITLE")')); }
      fs.writeFileSync(path.join(out, object.table + '.sql'), source.rawDdl); definitions.push({ ...object, meta: source });
    }
    result.cases.push('通过正式 query_execute 与生产 dameng_script 回放完整原生定义；目标字段、注释、索引和外键元数据一致');

    step = '只读会话读取原生定义';
    const readonly = await invoke('session_create', { input: { name: 'DM60 DDL 只读验收', engine: 'dameng', host: '127.0.0.1', port: Number(process.env.DBFOLIO_TEST_DM_PORT || 15236), username: 'SYSDBA', password, readOnly: true } });
    readOnlySessionId = readonly.id;
    await invoke('session_connect', { id: readOnlySessionId });
    const readonlyMeta = await invoke('meta_table_detail', { sessionId: readOnlySessionId, database: names.a, schema: names.a, table: 'QA_PARENT' });
    assert.equal(readonlyMeta.rawDdl, definitions[0].meta.rawDdl, '只读会话应能读取相同的完整原生 DDL');
    assert.deepEqual(readonlyMeta.ddlWarnings || [], [], '只读 GET_DDL 不应被写保护误拦截');
    result.cases.push('真实只读会话可读取完整原生 DDL，内容与普通会话相同且无警告');

    step = 'DDL 页高亮与对象标题';
    await page.reload({ waitUntil: 'domcontentloaded' }); await page.getByText('DM60 DDL 验收', { exact: true }).click();
    const schemaRow = page.getByRole('treeitem').filter({ hasText: names.a }).first(); await schemaRow.getByText(names.a, { exact: true }).click();
    await page.getByText('QA_PARENT', { exact: true }).first().dblclick();
    const heading = page.locator('.dw-table-heading'); await heading.getByText(names.a + '.QA_PARENT', { exact: true }).waitFor();
    assert.equal(await heading.getByText(names.a + '.' + names.a + '.QA_PARENT', { exact: true }).count(), 0, '模式名在对象标题中重复');
    await page.getByRole('tab', { name: 'DDL', exact: true }).click();
    const panel = page.locator('.dw-ddl-panel:visible'); await panel.locator('.monaco-editor .view-lines').waitFor();
    assert.equal(await panel.getByRole('alert').count(), 0);
    const colors = await panel.locator('.view-line span[class*="mtk"]').evaluateAll(nodes => [...new Set(nodes.filter(n => n.textContent?.trim()).map(n => getComputedStyle(n).color))]);
    assert(colors.length >= 2, 'DDL 应使用 SQL token 着色');
    await page.screenshot({ path: path.join(out, 'ddl-native.png') });
    result.cases.push('DDL 使用 SQL 高亮、正常定义无警告、表标题仅显示一次模式名');

    step = '源码复制与查询打开';
    try { clipboard = await invoke('clipboard_read_text'); } catch(error) { result.clipboardPendingReason = String(error); }
    if (clipboard !== undefined) {
    await panel.getByRole('button', { name: '复制 DDL', exact: true }).click(); clipboardChanged = true;
    let copied;
    for (let i = 0; i < 50; i++) { copied = await invoke('clipboard_read_text'); if (copied === definitions[0].meta.rawDdl) break; await delay(100); }
    assert.equal(copied, definitions[0].meta.rawDdl, '复制内容必须是完整原始 DDL');
    // Read-only behavior is verified on the actual Monaco surface, including native EditContext.
    await invoke('clipboard_write_text', { text: 'DM60_EDITOR_COPY_SENTINEL' });
    const box = await panel.locator('.monaco-editor').boundingBox(); assert(box && box.height > 90); await page.mouse.click(box.x + 110, box.y + 60); await page.keyboard.press('Control+A'); await page.keyboard.insertText('SHOULD_NOT_CHANGE_DDL'); await page.keyboard.press('Control+A'); await page.keyboard.press('Control+C');
    await delay(200); assert.equal(canonicalNewlines(await invoke('clipboard_read_text')), canonicalNewlines(definitions[0].meta.rawDdl), '只读 DDL 编辑器不允许修改');
    await panel.getByRole('button', { name: '在查询页打开', exact: true }).click();
    await invoke('clipboard_write_text', { text: 'DM60_QUERY_COPY_SENTINEL' });
    const queryLines = page.locator('.dw-query-sql-pane:visible .monaco-editor .view-lines'); await queryLines.waitFor(); const queryBox = await page.locator('.dw-query-sql-pane:visible .monaco-editor').boundingBox(); assert(queryBox && queryBox.height > 90); await page.mouse.click(queryBox.x + 110, queryBox.y + 60); await page.keyboard.press('Control+A'); await page.keyboard.press('Control+C'); await delay(200);
    assert.equal(canonicalNewlines(await invoke('clipboard_read_text')), canonicalNewlines(definitions[0].meta.rawDdl), '查询编辑器应接收完整源码');
    await page.screenshot({ path: path.join(out, 'ddl-query-open.png') });
    result.cases.push('复制 DDL 为服务器完整源码、只读编辑器拒绝修改、在查询页打开保持完整 SQL');
      result.clipboardVerified = true;
    } else {
      // Locked/noninteractive Windows desktops can deny every clipboard client.
      // Keep that OS check pending while verifying query navigation via actual saved state.
      const readonly = await panel.locator('[aria-readonly="true"],textarea[readonly]').count();
      assert(readonly>0,'原生只读编辑器缺少只读属性');
      await panel.getByRole('button', { name: '在查询页打开', exact: true }).click();
      await page.locator('.dw-query-sql-pane:visible .monaco-editor .view-lines').waitFor();
      let workspace;
      for(let i=0;i<40;i++) { const raw=await invoke('settings_get',{key:'workspace_v1'}); workspace=raw?JSON.parse(raw):null; if(workspace?.drafts?.[workspace.activeId]?.sql===definitions[0].meta.rawDdl)break; await delay(100); }
      assert.equal(workspace?.drafts?.[workspace.activeId]?.sql,definitions[0].meta.rawDdl,'查询草稿必须接收完整原生源码');
      result.clipboardVerified = false;
      result.cases.push('原生只读属性及查询打开后的真实持久化草稿完整一致；系统剪贴板访问不可用，实际复制复验保留');
      await page.screenshot({path:path.join(out,'ddl-query-open.png')});
    }
    result.passed = true;
  } catch (error) { result.error = { step, message: String(error) }; process.exitCode = 1; if (page) await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {}); }
  finally {
    if (invoke && sessionId) {
      if (clipboardChanged && clipboard !== undefined) await invoke('clipboard_write_text', { text: clipboard }).catch(() => {});
      if (readOnlySessionId) {
        try { await invoke('session_delete', { id: readOnlySessionId }); result.readOnlySessionDeleted = true; }
        catch (error) { result.cleanupReadonlyError = String(error); result.passed = false; process.exitCode = 1; }
      }
      try { await invoke('session_disconnect', { id: sessionId }); await invoke('session_connect', { id: sessionId }); } catch(error) { (result.cleanupErrors ||= []).push(String(error)); result.passed = false; process.exitCode = 1; }
      for (const name of [...created].reverse()) {
        try { assert(/^DBFOLIO_DM60_\d{13}_(?:A|B|TA|TB)$/.test(name)); await invoke('query_execute', { sessionId, database: 'SYSDBA', sql: `DROP SCHEMA ${ident(name)} CASCADE`, force: true }); }
        catch (error) { (result.cleanupErrors ||= []).push(String(error)); result.passed = false; process.exitCode = 1; }
      }
      try { await invoke('session_delete', { id: sessionId }); result.sessionDeleted = true; } catch (error) { result.cleanupSessionError = String(error); result.passed = false; process.exitCode = 1; }
    }
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
    if (browser) await browser.close().catch(() => {}); app.kill(); await delay(1000); console.log(out);
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
