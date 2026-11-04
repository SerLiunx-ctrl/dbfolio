// 正式 EXE 的隔离触发器验收。真实配置只读，MySQL 只操作本轮专属数据库。
// 可先执行 --preflight --version=1.0.0-alpha.54，只检查启动与已有本机凭据连接。
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const args = process.argv.slice(2);
const version = args.find(x => x.startsWith('--version='))?.slice(10) || require('../package.json').version;
const preflight = args.includes('--preflight');
const skipMysql = args.includes('--skip-mysql');
const mysqlSessionId = args.find(x => x.startsWith('--mysql-session='))?.slice(16) || process.env.DBFOLIO_TEST_MYSQL_SESSION;
const stamp = Date.now();
const out = path.resolve(`.qa/triggers55-native-${preflight ? 'preflight-' : ''}${stamp}`);
const profile = path.join(out, 'profile');
const ownDatabase = `dbfolio_trigger55_${stamp}`;
const delay = ms => new Promise(r => setTimeout(r, ms));
const result = { version, preflight, passed: false, cases: [], deferred: ['PostgreSQL 实库：用户明确暂缓'] };
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync('.qa/triggers55-latest-native.txt', out);

function withDb(file, readOnly, fn) {
  const db = new DatabaseSync(file, { readOnly });
  try { db.exec('PRAGMA busy_timeout=5000'); return fn(db); } finally { db.close(); }
}
function updateIsolatedSession(fields) {
  assert(profile.startsWith(out + path.sep));
  withDb(path.join(profile, 'app.db'), false, db => {
    const columns = Object.keys(fields);
    assert(columns.every(k => ['read_only', 'allowed_databases'].includes(k)));
    db.prepare(`UPDATE sessions SET ${columns.map(k => `"${k}"=?`).join(',')} WHERE id=?`)
      .run(...columns.map(k => fields[k]), mysqlSessionId);
  });
}
function copyLocalMysqlSession() {
  const source = path.join(process.env.APPDATA, 'data-workbench', 'app.db');
  assert(fs.existsSync(source), '真实配置不存在；不创建或修改真实配置');
  const row = withDb(source, true, db => db.prepare('SELECT * FROM sessions WHERE id=?').get(mysqlSessionId));
  assert(row, '指定本机会话不存在');
  assert.equal(row.engine, 'mysql');
  assert(['127.0.0.1', 'localhost', '::1'].includes(row.host), '仅允许指定的本机 MySQL');
  assert.equal(Number(row.port || 3306), 3306);
  assert.equal(row.read_only, 0);
  assert.equal(row.allowed_databases, null, '本轮须使用原有不受限本机会话');
  withDb(path.join(profile, 'app.db'), false, db => {
    const targetColumns = new Set(db.prepare('PRAGMA table_info(sessions)').all().map(c => c.name));
    const columns = Object.keys(row).filter(k => targetColumns.has(k));
    db.prepare(`INSERT INTO sessions(${columns.map(k => `"${k}"`).join(',')}) VALUES(${columns.map(() => '?').join(',')})`)
      .run(...columns.map(k => row[k]));
  });
  // 只复制配置行、保留 ID 复用凭据；不读取、输出、更新或删除 Windows 凭据。
}
async function expectRejected(label, fn, pattern) {
  let error;
  try { await fn(); } catch (e) { error = String(e); }
  assert(error, `${label} 应被拒绝`);
  if (pattern) assert.match(error, pattern, `${label}：${error}`);
  result.cases.push(label);
}
function bodyDraft(body, timing = 'AFTER') {
  return { timing, events: ['INSERT'], orientation: 'ROW', body, functionSchema: null, functionName: null };
}
function change(sessionId, database, table, name, draft, original = null) {
  return { sessionId, database, schema: null, table, name, draft, original, confirmed: true };
}
async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const port = listener.address().port;
  await new Promise(r => listener.close(r));
  return port;
}

(async () => {
  assert(skipMysql || mysqlSessionId, '请传 --mysql-session=<本机 MySQL 会话 ID> / DBFOLIO_TEST_MYSQL_SESSION，或显式 --skip-mysql');
  const exe = path.resolve(`release/${version}/DBFolio_${version}_windows_x64_portable/dbfolio.exe`);
  assert(fs.existsSync(exe), '正式 portable EXE 不存在');
  const port = await freePort();
  const app = spawn(exe, ['--startup-check', profile], {
    cwd: path.dirname(exe), windowsHide: true,
    env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '127.0.0.1,localhost',
      WEBVIEW2_USER_DATA_FOLDER: path.join(out, 'webview'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1` },
    stdio: 'ignore',
  });
  let browser, page, invoke, sqliteId, readonlyId, mysqlConnected = false, databaseCreated = false;
  const query = (id, database, sql) => invoke('query_execute', { sessionId: id, database, sql, force: true, limit: 50 });
  const scalar = async (id, database, sql) => (await query(id, database, sql)).rows[0]?.[0]?.[1];
  const definition = r => invoke('trigger_definition', { sessionId: r.sessionId, database: r.database, schema: r.schema, table: r.table, name: r.name });
  const preview = r => invoke('trigger_preview', { request: r });
  const apply = r => invoke('trigger_apply', { request: r });
  const catalog = (id, database) => invoke('trigger_catalog', { sessionId: id, database });
  const sqliteUi = async session => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByTitle(session.name, { exact: true }).first().click();
    const branch = page.locator('[data-fui-tree-item-value="db:main"]');
    await branch.waitFor();
    if (await branch.getAttribute('aria-expanded') !== 'true') await branch.locator('.fui-TreeItemLayout__expandIcon').first().click();
    await page.getByRole('group', { name: 'main 对象', exact: true }).getByText('items', { exact: true }).dblclick();
    const triggerButton = page.getByRole('button', { name: '触发器', exact: true });
    await triggerButton.waitFor();
    assert(await triggerButton.locator('svg').count(), '表工具栏入口应有 Flash 图标');
    await triggerButton.click();
    const workspace = page.getByRole('region', { name: '触发器工作区', exact: true });
    await workspace.waitFor();
    await workspace.getByRole('button', { name: '新增触发器', exact: true }).click();
    await workspace.getByLabel('触发器名称', { exact: true }).fill('ui_insert');
    assert.equal(await workspace.getByLabel('触发器所属对象', { exact: true }).inputValue(), '[null,"items"]');
    await workspace.getByRole('button', { name: '填入空操作示例', exact: true }).click();
    await workspace.locator('.view-lines').filter({ hasText: 'SELECT 1' }).waitFor();
    const editor = workspace.locator('.dw-triggers-code textarea').first();
    await editor.waitFor();
    await workspace.locator('.dw-triggers-code .monaco-editor').click({ position: { x: 110, y: 12 } });
    assert(await editor.evaluate(e => document.activeElement?.closest('.monaco-editor') === e.closest('.monaco-editor')), '实际编辑器获得键盘焦点');
    await page.keyboard.press('Control+a');
    await page.keyboard.insertText("BEGIN\n  INSERT INTO audit VALUES('界面保存');\nEND");
    await workspace.locator('.view-lines').filter({ hasText: '界面保存' }).waitFor();
    await workspace.getByRole('button', { name: '保存', exact: true }).click();
    let dialog = page.getByRole('dialog');
    await dialog.waitFor();
    await dialog.locator('pre').filter({ hasText: 'CREATE TRIGGER' }).waitFor();
    assert.equal((await catalog(session.id, 'main')).items.some(t => t.name === 'ui_insert'), false, '预览时还未执行');
    await page.screenshot({ path: path.join(out, 'sqlite-ui-create-preview.png') });
    await dialog.getByRole('checkbox', { name: '我已了解风险，确认执行', exact: true }).check();
    await dialog.getByRole('button', { name: '执行', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await workspace.getByRole('button', { name: 'ui_insert', exact: true }).waitFor();
    await workspace.getByRole('button', { name: '编辑', exact: true }).waitFor();
    assert.match(await workspace.locator('.view-lines').innerText(), /CREATE\s+TRIGGER/);
    await query(session.id, 'main', 'INSERT INTO items VALUES(80)');
    assert.equal(await scalar(session.id, 'main', 'SELECT msg FROM audit ORDER BY rowid DESC LIMIT 1'), '界面保存');
    await page.screenshot({ path: path.join(out, 'sqlite-ui-definition.png') });
    await workspace.getByRole('button', { name: '删除', exact: true }).click();
    dialog = page.getByRole('dialog');
    await dialog.locator('pre').filter({ hasText: 'DROP TRIGGER' }).waitFor();
    await dialog.getByRole('checkbox', { name: '我已了解风险，确认执行', exact: true }).check();
    await dialog.getByRole('button', { name: '执行', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await workspace.getByText('触发器已删除', { exact: true }).waitFor();
    assert.equal((await catalog(session.id, 'main')).items.some(t => t.name === 'ui_insert'), false);
    await page.screenshot({ path: path.join(out, 'sqlite-ui-deleted.png') });
    result.cases.push('真实界面：Flash 入口与独立页、SQLite 表单/Monaco 新增、预览确认、定义显示、真实触发及删除');
  };
  try {
    for (let i = 0; i < 240 && !fs.existsSync(path.join(profile, 'frontend-ready.json')); i++) {
      assert(app.exitCode === null, '应用在前端就绪前退出');
      await delay(250);
    }
    const ready = JSON.parse(fs.readFileSync(path.join(profile, 'frontend-ready.json'), 'utf8'));
    assert.equal(ready.version, version);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    page = browser.contexts()[0].pages()[0];
    invoke = (command, commandArgs = {}) => page.evaluate(({ command, commandArgs }) =>
      window.__TAURI_INTERNALS__.invoke(command, commandArgs).catch(e => { throw Error(JSON.stringify(e)); }),
    { command, commandArgs });
    result.cases.push('正式 EXE 隔离配置与前端完整启动');

    if (!skipMysql) {
      copyLocalMysqlSession();
      await invoke('session_connect', { id: mysqlSessionId });
      mysqlConnected = true;
      assert.equal(Number(await scalar(mysqlSessionId, 'information_schema', 'SELECT 1')), 1);
      result.mysqlVersion = String(await scalar(mysqlSessionId, 'information_schema', 'SELECT VERSION()'));
      result.cases.push('真实本机 MySQL 凭据复用连接，原配置只读且未删除原会话');
    } else result.deferred.push('MySQL 实库：调用者指定 --skip-mysql');
    if (preflight) { result.passed = true; return; }

    const filePath = path.join(out, 'sample.db');
    fs.writeFileSync(filePath, '');
    const session = await invoke('session_create', { input: { name: '触发器 SQLite 隔离验收', engine: 'sqlite', filePath, readOnly: false } });
    sqliteId = session.id;
    await invoke('session_connect', { id: sqliteId });
    for (const sql of [
      'CREATE TABLE items(id INTEGER PRIMARY KEY)', 'CREATE TABLE other(id INTEGER PRIMARY KEY)',
      'CREATE TABLE audit(msg TEXT)', 'CREATE VIEW editable AS SELECT id FROM items',
    ]) await query(sqliteId, 'main', sql);
    let request = change(sqliteId, 'main', 'items', 'tr_中文"名称', bodyDraft("BEGIN INSERT INTO audit VALUES('新增'); END"));
    let list = await catalog(sqliteId, 'main');
    assert.equal(list.engine, 'sqlite');
    assert(list.targets.some(t => t.name === 'editable' && t.kind === 'view'));
    assert(!list.targets.some(t => t.name.startsWith('sqlite_')));
    assert.equal((await preview(request)).statements.length, 1);
    assert.equal((await catalog(sqliteId, 'main')).items.length, 0);
    result.cases.push('SQLite 表/视图目标与预览不执行 SQL');
    await expectRejected('SQLite 未确认禁止应用', () => apply({ ...request, confirmed: false }), /确认/);
    await apply(request);
    let original = await definition(request);
    assert(original.draft && original.sql.includes('tr_中文""名称'));
    list = await catalog(sqliteId, 'main');
    assert(list.items.some(t => t.name === request.name && t.table === 'items' && t.event === 'INSERT'));
    await query(sqliteId, 'main', 'INSERT INTO items VALUES(1)');
    assert.equal(await scalar(sqliteId, 'main', 'SELECT msg FROM audit ORDER BY rowid DESC LIMIT 1'), '新增');
    result.cases.push('SQLite 创建、目录、中文引用名称、读取定义与真实触发');
    await expectRejected('SQLite 重名不能覆盖', () => apply(request), /已存在/);
    await expectRejected('SQLite 目标表不匹配不能读取', () => definition({ ...request, table: 'other' }), /不属于|不存在|不匹配/);
    request.original = original.sql;
    request.draft = bodyDraft('BEGIN INVALID SYNTAX; END');
    assert.equal((await preview(request)).statements.length, 2);
    await expectRejected('SQLite 修改失败回滚', () => apply(request));
    assert.equal((await definition(request)).sql, original.sql);
    await query(sqliteId, 'main', 'INSERT INTO items VALUES(2)');
    assert.equal(await scalar(sqliteId, 'main', 'SELECT msg FROM audit ORDER BY rowid DESC LIMIT 1'), '新增');
    request.draft = bodyDraft("BEGIN INSERT INTO audit VALUES('修改'); END");
    await apply(request);
    let updated = await definition(request);
    await query(sqliteId, 'main', 'INSERT INTO items VALUES(3)');
    assert.equal(await scalar(sqliteId, 'main', 'SELECT msg FROM audit ORDER BY rowid DESC LIMIT 1'), '修改');
    result.cases.push('SQLite 替换成功、失败保留原定义与真实写入行为');
    await expectRejected('SQLite 旧定义乐观校验', () => apply(request), /已变化/);
    await expectRejected('SQLite 主体尾部禁止夹带 SQL', () => preview({ ...request, original: updated.sql, draft: bodyDraft('BEGIN SELECT 1; END; DROP TABLE audit') }), /夹带|END 后/);
    await expectRejected('SQLite 限定 main 数据库', () => catalog(sqliteId, 'other'), /main/);
    const ro = await invoke('session_create', { input: { name: '触发器只读验收', engine: 'sqlite', filePath, readOnly: true } });
    readonlyId = ro.id;
    await invoke('session_connect', { id: readonlyId });
    await expectRejected('SQLite 只读会话禁止应用', () => apply({ ...request, sessionId: readonlyId, original: updated.sql, draft: null }), /只读/);
    await invoke('session_disconnect', { id: readonlyId });
    await apply({ ...request, original: updated.sql, draft: null });
    assert.equal((await catalog(sqliteId, 'main')).items.length, 0);
    result.cases.push('SQLite 删除与只读安全校验');
    await query(sqliteId, 'main', "CREATE TRIGGER conditional AFTER INSERT ON items WHEN NEW.id>0 BEGIN INSERT INTO audit VALUES('条件'); END");
    const complex = change(sqliteId, 'main', 'items', 'conditional', null);
    const complexDef = await definition(complex);
    assert.equal(complexDef.draft, null);
    assert(complexDef.warning.length > 0);
    await expectRejected('SQLite 复杂定义仅查看不能覆盖', () => preview({ ...complex, original: complexDef.sql, draft: bodyDraft('BEGIN SELECT 1; END') }));
    await apply({ ...complex, original: complexDef.sql });
    const view = change(sqliteId, 'main', 'editable', 'view_insert', bodyDraft('BEGIN INSERT INTO items VALUES(NEW.id); END', 'INSTEAD OF'));
    await expectRejected('SQLite 视图拒绝不支持的时机', () => preview({ ...view, draft: bodyDraft('BEGIN SELECT 1; END') }), /INSTEAD OF/);
    await apply(view);
    await query(sqliteId, 'main', 'INSERT INTO editable VALUES(40)');
    assert.equal(Number(await scalar(sqliteId, 'main', 'SELECT id FROM items WHERE id=40')), 40);
    await apply({ ...view, original: (await definition(view)).sql, draft: null });
    let ftsAvailable = false;
    try { await query(sqliteId, 'main', 'CREATE VIRTUAL TABLE docs USING fts5(body)'); ftsAvailable = true; } catch (_) { /* 构建可能未启用 FTS5。 */ }
    if (ftsAvailable) assert(!(await catalog(sqliteId, 'main')).targets.some(t => t.name.startsWith('docs')));
    result.cases.push('SQLite 复杂定义只读/删除、视图 INSTEAD OF 与虚拟/影子表目标过滤');
    await sqliteUi(session);

    if (mysqlConnected) {
      assert.match(ownDatabase, /^dbfolio_trigger55_\d+$/);
      await query(mysqlSessionId, 'information_schema', `CREATE DATABASE \`${ownDatabase}\` CHARACTER SET utf8mb4`);
      databaseCreated = true;
      for (const sql of ['CREATE TABLE items(id INT PRIMARY KEY)', 'CREATE TABLE other(id INT PRIMARY KEY)', 'CREATE TABLE audit(msg VARCHAR(100))', 'CREATE VIEW item_view AS SELECT id FROM items']) await query(mysqlSessionId, ownDatabase, sql);
      list = await catalog(mysqlSessionId, ownDatabase);
      assert.equal(list.engine, 'mysql');
      assert(!list.targets.some(t => t.name === 'item_view'));
      request = change(mysqlSessionId, ownDatabase, 'items', 'tr_中文', bodyDraft("BEGIN INSERT INTO audit VALUES('新增'); END"));
      assert.equal((await preview(request)).statements.length, 1);
      await expectRejected('MySQL 未确认禁止应用', () => apply({ ...request, confirmed: false }), /确认/);
      await apply(request);
      original = await definition(request);
      assert(original.draft, original.warning);
      await query(mysqlSessionId, ownDatabase, 'INSERT INTO items VALUES(1)');
      assert.equal(await scalar(mysqlSessionId, ownDatabase, 'SELECT msg FROM audit LIMIT 1'), '新增');
      result.cases.push('MySQL 专属数据库创建、目录、中文触发器定义与真实触发');
      await expectRejected('MySQL 拒绝视图触发器目标', () => preview({ ...request, table: 'item_view', name: 'bad_view' }), /目标/);
      await expectRejected('MySQL 重名不能覆盖', () => apply(request), /已存在/);
      request.original = original.sql;
      request.draft = bodyDraft('BEGIN INVALID SYNTAX; END');
      await expectRejected('MySQL 修改失败保留或恢复旧触发器', () => apply(request));
      assert.equal((await definition(request)).sql, original.sql);
      request.draft = bodyDraft("BEGIN INSERT INTO audit VALUES('修改'); END");
      const replacementPreview = await preview(request);
      assert.equal(replacementPreview.statements.length, 2);
      assert(replacementPreview.warning.includes('隐式提交'));
      await apply(request);
      updated = await definition(request);
      assert.equal(updated.sql.match(/^CREATE\s+(DEFINER=.*?)\s+TRIGGER\b/is)?.[1], original.sql.match(/^CREATE\s+(DEFINER=.*?)\s+TRIGGER\b/is)?.[1], '替换必须保留原 DEFINER');
      await query(mysqlSessionId, ownDatabase, 'DELETE FROM audit');
      await query(mysqlSessionId, ownDatabase, 'INSERT INTO items VALUES(2)');
      assert.equal(await scalar(mysqlSessionId, ownDatabase, 'SELECT msg FROM audit LIMIT 1'), '修改');
      await expectRejected('MySQL 旧定义乐观校验', () => apply(request), /已变化/);
      await expectRejected('MySQL 主体尾部禁止夹带 SQL', () => preview({ ...request, original: updated.sql, draft: bodyDraft('BEGIN SELECT 1; END; DROP TABLE audit') }), /夹带|END 后/);
      result.cases.push('MySQL 替换、DEFINER 保留、失败旧定义保留与乐观校验');
      updateIsolatedSession({ read_only: 1 });
      await expectRejected('MySQL 只读会话禁止应用', () => apply({ ...request, original: updated.sql, draft: null }), /只读/);
      updateIsolatedSession({ read_only: 0, allowed_databases: JSON.stringify([ownDatabase]) });
      assert((await catalog(mysqlSessionId, ownDatabase)).items.length > 0);
      await expectRejected('MySQL 白名单拒绝读取未允许库', () => catalog(mysqlSessionId, 'information_schema'), /范围限制/);
      await expectRejected('MySQL 白名单保留原存储程序写保护', () => preview({ ...request, original: updated.sql, draft: null }), /范围限制|受限会话/);
      updateIsolatedSession({ allowed_databases: null });
      // 相同事件多个触发器可能有顺序依赖，因此只读，不能无意 DROP+CREATE 改变顺序。
      const sibling = change(mysqlSessionId, ownDatabase, 'items', 'tr_sibling', bodyDraft("BEGIN INSERT INTO audit VALUES('同事件'); END"));
      await apply(sibling);
      const ordered = await definition(request);
      assert.equal(ordered.draft, null);
      assert(ordered.warning);
      await expectRejected('MySQL 多触发器顺序定义只读', () => preview({ ...request, original: ordered.sql }));
      await apply({ ...sibling, original: (await definition(sibling)).sql, draft: null });
      await apply({ ...request, original: (await definition(request)).sql, draft: null });
      assert.equal((await catalog(mysqlSessionId, ownDatabase)).items.length, 0);
      result.cases.push('MySQL 只读/白名单、同事件顺序保护与删除');
    }
    result.passed = true;
  } catch (error) {
    result.error = String(error);
    process.exitCode = 1;
    if (page) await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
  } finally {
    const cleanupErrors = [];
    if (invoke) {
      if (mysqlConnected) {
        try { updateIsolatedSession({ read_only: 0, allowed_databases: null }); } catch (e) { cleanupErrors.push(`隔离配置恢复：${e}`); }
        if (databaseCreated) {
          try {
            assert.match(ownDatabase, /^dbfolio_trigger55_\d+$/);
            await query(mysqlSessionId, 'information_schema', `DROP DATABASE \`${ownDatabase}\``);
            result.mysqlDatabaseRemoved = true;
          } catch (e) { cleanupErrors.push(`专属测试数据库清理：${e}`); }
        }
        // 绝不可 session_delete(mysqlSessionId)：隔离配置内删除也会删除用户真实凭据。
        await invoke('session_disconnect', { id: mysqlSessionId }).catch(e => cleanupErrors.push(`MySQL 断开：${e}`));
      }
      for (const id of [readonlyId, sqliteId].filter(Boolean)) {
        assert.notEqual(id, mysqlSessionId);
        await invoke('session_delete', { id }).catch(e => cleanupErrors.push(`测试 SQLite 会话清理：${e}`));
      }
      await invoke('plugin:window|destroy', { label: 'main' }).catch(() => {});
    }
    if (browser) await browser.close().catch(() => {});
    for (let i = 0; i < 20 && app.exitCode === null; i++) await delay(100);
    if (app.exitCode === null) spawnSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    // 只结束本轮隔离目录对应的 WebView，保留用户正在使用的 DBFolio 和其他 WebView。
    const closed = spawnSync('powershell', ['-NoProfile', '-Command', "$taskQaRoot=$env:DBFOLIO_NATIVE_WEBVIEW_ROOT; $taskQaWebviews=@(Get-CimInstance Win32_Process | Where-Object { $_.Name -ieq 'msedgewebview2.exe' -and $_.CommandLine -and $_.CommandLine.IndexOf($taskQaRoot,[StringComparison]::OrdinalIgnoreCase) -ge 0 }); foreach($taskQaWebview in $taskQaWebviews){ Stop-Process -Id $taskQaWebview.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 300; $taskQaLeft=@(Get-CimInstance Win32_Process | Where-Object { $_.Name -ieq 'msedgewebview2.exe' -and $_.CommandLine -and $_.CommandLine.IndexOf($taskQaRoot,[StringComparison]::OrdinalIgnoreCase) -ge 0 }); if($taskQaLeft.Count -gt 0){ exit 1 }"], { windowsHide: true, env: { ...process.env, DBFOLIO_NATIVE_WEBVIEW_ROOT: out }, encoding: 'utf8' });
    result.isolatedWebviewsClosed = closed.status === 0;
    if (!result.isolatedWebviewsClosed) cleanupErrors.push('本轮 WebView 未完全关闭');
    if (cleanupErrors.length) { result.cleanupErrors = cleanupErrors; result.passed = false; process.exitCode = 1; }
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    console.log(out);
  }
})().catch(error => {
  result.error = String(error);
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
  console.error(String(error));
  process.exitCode = 1;
});
