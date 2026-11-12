// 正式 EXE + 隔离配置 + 专用模式。原始 SQL 文件只读，凭据仅来自环境变量。
// 运行前设置 DBFOLIO_TEST_DM_PASSWORD、DBFOLIO_TEST_DM_SQL；可选 DBFOLIO_TEST_DM_PORT / DBFOLIO_TEST_DM_USER / DBFOLIO_TEST_VERSION。
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const ident = value => '"' + value.replace(/"/g, '""') + '"';
const literal = value => "'" + value.replace(/'/g, "''") + "'";

// 此安全检查只限定本验收脚本可复制的用户样例，并不替代应用的脚本解析器。
function tokens(text) {
  const result = [];
  for (let at = 0; at < text.length;) {
    if (/\s/.test(text[at])) { at++; continue; }
    if (text.startsWith('--', at)) { while (at < text.length && text[at] !== '\n') at++; continue; }
    if (text.startsWith('/*', at)) {
      let depth = 1; at += 2;
      while (at < text.length && depth) {
        if (text.startsWith('/*', at)) { depth++; at += 2; }
        else if (text.startsWith('*/', at)) { depth--; at += 2; }
        else at++;
      }
      assert.equal(depth, 0, '原文件注释未闭合');
      continue;
    }
    if (text[at] === "'" || text[at] === '"') {
      const quote = text[at++], kind = quote === "'" ? 'literal' : 'identifier';
      let value = '', closed = false;
      while (at < text.length) {
        const c = text[at++];
        if (c === quote) {
          if (text[at] === quote) { value += quote; at++; }
          else { closed = true; break; }
        } else value += c;
      }
      assert(closed, '原文件字符串或标识符未闭合');
      result.push({ kind, value });
      continue;
    }
    const word = text.slice(at).match(/^[A-Za-z_\u0080-\uffff][\w$\u0080-\uffff]*/);
    if (word) { result.push({ kind: 'word', value: word[0] }); at += word[0].length; }
    else result.push({ kind: 'symbol', value: text[at++] });
  }
  return result;
}

function prepareSource(source, schema) {
  assert(!source.includes('\0'), '原文件包含空字符');
  assert(source.length < 10 * 1024 * 1024, '本验收只接受已核对的小型样例文件');
  const tableMatches = [...source.matchAll(/^\s*CREATE\s+TABLE\s+"((?:[^"\r\n]|"")+)"\s*\(/gim)];
  const tableNames = tableMatches.map(m => m[1].replace(/""/g, '"'));
  const triggerNames = [...source.matchAll(/^\s*CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+"([^"]+)"/gim)].map(m => m[1]);
  const indexes = [...source.matchAll(/^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+"([^"]+)"\s+ON\s+"([^"]+)"/gim)].map(m => ({ name: m[1], table: m[2] }));
  assert(tableNames.length > 0 && triggerNames.length > 0 && indexes.length > 0, '原文件不再符合已核对的表/索引/触发器样例');
  assert(tableNames.includes('CHAT_AGENT_RUN'), '原文件缺少已核对的触发器范围测试表');
  const all = tokens(source), upper = token => token?.value.toUpperCase();
  const isName = token => token && ['word', 'identifier'].includes(token.kind);
  const originalSchemaTokens = all.filter(t => isName(t) && upper(t) === 'AGENT');
  assert.equal(originalSchemaTokens.length, 1, '存在 SET SCHEMA 之外的 AGENT 标识，停止验收');
  for (let i = 0; i < all.length; i++) {
    const t = all[i], word = upper(t);
    if (t.kind === 'word') {
      assert(!['GRANT', 'REVOKE', 'AUTHORIZATION', 'CONNECT', 'SPOOL', 'HOST', 'EXECUTE', 'DBMS_SQL', 'UTL_FILE', 'UTL_HTTP', 'DBLINK', 'EXTERNAL', 'USE', 'CALL', 'SHUTDOWN', 'STARTUP', 'BACKUP', 'RESTORE', 'ALTER', 'DROP', 'DELETE', 'SELECT'].includes(word), '原文件不再是已核对的纯 DDL 样例，包含管理、权限、查询、删除或外部操作，停止验收');
      if (word === 'SET') {
        const setting = upper(all[i + 1]), value = upper(all[i + 2]);
        assert(setting === 'SCHEMA' && value === 'AGENT' || ['DEFINE', 'ECHO'].includes(setting) && value === 'OFF', '原文件包含未核对的模式切换或 SET 指令，停止验收');
      }
      if (word === 'CREATE') {
        let next = i + 1;
        if (upper(all[next]) === 'OR' && upper(all[next + 1]) === 'REPLACE') next += 2;
        if (upper(all[next]) === 'UNIQUE') next++;
        assert(['TABLE', 'INDEX', 'TRIGGER'].includes(upper(all[next])), '原文件包含未核对的对象创建，停止验收');
      }
      if (word === 'INSERT') assert.equal(upper(all[i - 1]), 'BEFORE', '原文件包含非触发器声明 INSERT，停止验收');
      if (word === 'UPDATE') assert.equal(upper(all[i - 1]), 'OR', '原文件包含非触发器声明 UPDATE，停止验收');
    }
    if (isName(t) && all[i + 1]?.value === '.' && isName(all[i + 2])) {
      const pseudoRecord = ['NEW', 'OLD'].includes(word) && all[i - 1]?.value === ':';
      const commentColumn = tableNames.includes(t.value) && all[i - 1]?.value.toUpperCase() === 'COLUMN';
      assert(pseudoRecord || commentColumn, '原文件包含未核对的模式/对象限定名称，停止验收');
      assert.notEqual(all[i + 3]?.value, '.', '原文件包含跨模式三段限定名称，停止验收');
    }
  }
  let schemaReplacements = 0;
  const copy = source.replace(/^(\s*SET\s+SCHEMA\s+)"AGENT"\s*;[ \t]*$/gim, (_, prefix) => {
    schemaReplacements++;
    return prefix + ident(schema) + ';';
  });
  assert.equal(schemaReplacements, 1, '只允许替换唯一 SET SCHEMA "AGENT" 行');
  assert(!tokens(copy).some(t => isName(t) && upper(t) === 'AGENT'), '模式替换后仍包含 AGENT 标识');
  return { copy, tableNames, triggerNames, indexes };
}

async function run() {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const password = process.env.DBFOLIO_TEST_DM_PASSWORD;
  const sourcePath = process.env.DBFOLIO_TEST_DM_SQL;
  assert(password, '请设置 DBFOLIO_TEST_DM_PASSWORD');
  assert(sourcePath && path.isAbsolute(sourcePath) && fs.statSync(sourcePath).isFile(), '请设置 DBFOLIO_TEST_DM_SQL 为原始 SQL 文件的完整路径');
  const version = process.env.DBFOLIO_TEST_VERSION || require('../package.json').version;
  const out = path.resolve('.qa/dm59-import-native-' + Date.now());
  const schema = 'DBFOLIO_DM59_' + Date.now();
  assert(/^DBFOLIO_DM59_\d{13}$/.test(schema));
  const originalBytes = fs.readFileSync(sourcePath), sourceHash = hash(originalBytes);
  const prepared = prepareSource(originalBytes.toString('utf8').replace(/^\uFEFF/, ''), schema);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync('.qa/dm59-import-native-latest.txt', out);
  const sourceCopy = path.join(out, 'user-sample-isolated.sql');
  fs.writeFileSync(sourceCopy, prepared.copy, 'utf8');
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const exe = path.resolve(`release/${version}/DBFolio_${version}_windows_x64_portable/dbfolio.exe`);
  assert(fs.existsSync(exe), '正式 portable EXE 尚未生成');
  assert(fs.statSync(path.join(path.dirname(exe), 'web')).isDirectory(), '正式 portable 缺少外置 web 资源');
  const app = spawn(exe, ['--startup-check', path.join(out, 'profile')], {
    cwd: path.dirname(exe), windowsHide: true, stdio: 'ignore',
    env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: path.join(out, 'webview'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1` },
  });
  let launchError;
  app.on('error', error => { launchError = error; });
  const sessions = [];
  const result = { version, schema, exeSha256: hash(fs.readFileSync(exe)), source: { name: path.basename(sourcePath), bytes: originalBytes.length, sha256: sourceHash, tables: prepared.tableNames.length, indexes: prepared.indexes.length, triggers: prepared.triggerNames.length }, cases: [], passed: false };
  let browser, page, invoke, base, created = false, step = '启动';
  try {
    for (let i = 0; i < 200 && !fs.existsSync(path.join(out, 'profile/frontend-ready.json')); i++) {
      if (launchError) throw launchError;
      if (app.exitCode !== null) throw Error('正式 EXE 在前端就绪前退出：' + app.exitCode);
      await delay(250);
    }
    assert(fs.existsSync(path.join(out, 'profile/frontend-ready.json')), '正式 EXE 启动检查超时');
    assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'profile/frontend-ready.json'), 'utf8')).version, version, '实际 EXE 版本与验收版本不一致');
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    page = browser.contexts()[0].pages()[0];
    page.setDefaultTimeout(20_000);
    invoke = (command, args = {}) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args).catch(error => { throw Error(JSON.stringify(error)); }), { command, args });
    const createSession = async readOnly => {
      const session = await invoke('session_create', { input: { name: readOnly ? 'DM59 导入只读验收' : 'DM59 导入验收', engine: 'dameng', host: '127.0.0.1', port: Number(process.env.DBFOLIO_TEST_DM_PORT || 15236), username: process.env.DBFOLIO_TEST_DM_USER || 'SYSDBA', password, readOnly } });
      sessions.push(session.id);
      const status = await invoke('session_connect', { id: session.id });
      return { session, status };
    };
    const writable = await createSession(false);
    base = { sessionId: writable.session.id, database: schema };
    result.serverVersion = writable.status.serverVersion;
    assert.match(result.serverVersion, /DM8/);
    assert(!(await invoke('meta_databases', { sessionId: base.sessionId })).some(d => d.name === schema), '测试模式已存在，停止而不复用');
    await invoke('ddl_create_database', { sessionId: base.sessionId, name: schema });
    created = true;
    const query = (sql, extra = {}) => invoke('query_execute', { ...base, sql, force: true, limit: 100, ...extra });
    const rows = async sql => (await query(sql)).rows;
    const scalar = async sql => (await rows(sql))[0]?.[0]?.[1];
    const preview = (file, continueOnError = false, sessionId = base.sessionId) => invoke('sql_import_preview', { request: { sessionId, database: schema, path: file, encoding: 'utf-8', continueOnError }, originTabId: 'dm59-import-check' });
    const execute = (plan, confirmed = true, sessionId = base.sessionId) => invoke('sql_import_execute', { sessionId, id: plan.id, reportDirectory: out, confirmed, originTabId: 'dm59-import-check' });
    const write = (name, sql) => { const file = path.join(out, name + '.sql'); fs.writeFileSync(file, sql, 'utf8'); return file; };
    const assertReportFile = report => {
      const file = path.resolve(report.reportPath);
      assert(file.startsWith(out + path.sep), '报告路径超出隔离目录');
      const entries = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
      assert.equal(entries[0].status, 'running');
      assert.equal(entries.at(-1).status, 'finished');
      for (const entry of report.entries) {
        const pending = entries.findIndex(e => e.number === entry.number && e.status === 'pending');
        const final = entries.findIndex(e => e.number === entry.number && e.status === entry.status);
        assert(pending >= 0 && final > pending, '逐语句结果缺少发送前 pending 边界');
      }
      return entries;
    };
    result.cases.push('正式 EXE 原生认证及全新专用模式；原文件仅模式替换的隔离副本');

    step = '原文件预检与导入';
    const fullPlan = await preview(sourceCopy);
    assert(fullPlan.statements > prepared.tableNames.length + prepared.triggerNames.length);
    assert(fullPlan.samples.length > 0 && fullPlan.samples.every(s => s.line > 0));
    assert(!fullPlan.samples.some(s => /^(?:WHENEVER|PROMPT|SET\s+(?:DEFINE|ECHO))\b/i.test(s.sql.trim())), '客户端指令进入服务器 SQL 预览');
    const warningText = fullPlan.warnings.join('\n');
    for (const directive of ['WHENEVER', 'DEFINE', 'ECHO', 'PROMPT']) assert.match(warningText, new RegExp(directive, 'i'));
    await assert.rejects(() => execute(fullPlan, false), /确认/);
    const fullReport = await execute(fullPlan);
    assert.equal(fullReport.failed, 0, fullReport.error || '原文件导入失败');
    assert.equal(fullReport.uncertain, false);
    assert.equal(fullReport.executed, fullPlan.statements);
    assert.equal(fs.readFileSync(sourceCopy, 'utf8'), prepared.copy, '用户样例的隔离副本在执行过程中被修改');
    assertReportFile(fullReport);
    result.import = { statements: fullPlan.statements, executed: fullReport.executed, failed: fullReport.failed, warnings: fullPlan.warnings.length };
    result.cases.push('83 KB 原文件只改模式名后预检及实际导入；WHENEVER/DEFINE/ECHO/PROMPT 不发送；确认保护及报告边界');

    step = '导入元数据';
    const tables = await invoke('meta_tables', base);
    assert.equal(tables.filter(t => t.kind === 'table').length, prepared.tableNames.length);
    for (const name of prepared.tableNames) assert(tables.some(t => t.name === name && t.kind === 'table'));
    const triggers = await rows(`SELECT TRIGGER_NAME FROM ALL_TRIGGERS WHERE OWNER=${literal(schema)}`);
    for (const name of prepared.triggerNames) assert(triggers.some(r => r[0][1] === name), '原始触发器缺失');
    const first = await invoke('meta_table_detail', { ...base, schema, table: 'CHAT_AGENT_RUN' });
    assert(first.columns.find(c => c.name === 'ID').autoIncrement);
    assert(first.comment && first.columns.find(c => c.name === 'ID').comment);
    for (const index of prepared.indexes.filter(i => i.table === 'CHAT_AGENT_RUN')) assert(first.indexes.some(i => i.name === index.name));
    result.cases.push('所有原始表和触发器存在，IDENTITY、中文注释和原始索引元数据正确');

    step = '原始触发器范围';
    const required = ['SESSION_ID', 'APP_ID', 'OWNER_USER_ID', 'REQUEST_MESSAGE_ID', 'RUN_STATUS', 'IS_STREAM', 'CONFIG_SOURCE', 'PREFIX_MESSAGES_HASH', 'TOOL_RESULT_DISPLAY_POLICY', 'STARTED_AT', 'DEADLINE_AT', 'CREATE_ID'];
    const values = [1, 1, literal('qa-owner'), 1, literal('COMPLETED'), 0, literal('DRAFT'), literal('a'.repeat(64)), literal('HIDE'), "TIMESTAMP '2026-11-12 00:00:00.000'", "TIMESTAMP '2026-11-12 00:00:00.000'", literal('qa')];
    await query(`INSERT INTO "CHAT_AGENT_RUN"(${required.map(ident).join(',')}) VALUES (${values.join(',')})`);
    const badValues = [...values]; badValues[3] = 2;
    await assert.rejects(() => query(`SET IDENTITY_INSERT "CHAT_AGENT_RUN" ON;\nINSERT INTO "CHAT_AGENT_RUN"("ID",${required.map(ident).join(',')}) VALUES (-1,${badValues.join(',')});\nSET IDENTITY_INSERT "CHAT_AGENT_RUN" OFF;`), /20010|Unsigned identity/i);
    assert.equal(Number(await scalar('SELECT COUNT(*) FROM "CHAT_AGENT_RUN" WHERE "REQUEST_MESSAGE_ID"=2')), 0);
    result.cases.push('真实原始触发器允许合法 IDENTITY 插入，拒绝越界显式 ID 且无坏行');

    step = '查询脚本';
    const batch = [
      'WHENEVER SQLERROR EXIT 1', 'SET DEFINE OFF', 'SET ECHO OFF', `SET SCHEMA ${ident(schema)};`,
      'CREATE TABLE "QA_QUERY"("ID" INT PRIMARY KEY,"function" INT,"event" INT,"trigger" INT);',
      'CREATE OR REPLACE TRIGGER "TRG_QA_QUERY" BEFORE INSERT OR UPDATE ON "QA_QUERY" FOR EACH ROW',
      'BEGIN', '  IF :NEW."ID" < 0 THEN', "    RAISE_APPLICATION_ERROR(-20010,'QA_RANGE_REJECT');", '  END IF;', 'END;', '/',
      'INSERT INTO "QA_QUERY" VALUES(1,7,8,9);', 'COMMIT;', 'PROMPT DM59_QUERY_OK',
      'SELECT "function","event","trigger" FROM "QA_QUERY";',
    ].join('\n');
    const queried = await query(batch);
    assert.deepEqual(queried.rows[0].map(v => Number(v[1])), [7, 8, 9]);
    assert(queried.scriptStatements > 1);
    const notices = (queried.notices || []).join('\n');
    for (const directive of ['WHENEVER', 'DEFINE', 'ECHO', 'DM59_QUERY_OK']) assert.match(notices, new RegExp(directive));
    await assert.rejects(() => query('INSERT INTO "QA_QUERY" VALUES(-1,0,0,0)'), /20010|QA_RANGE_REJECT/);
    result.cases.push('查询页批次使用独占连接，整段 BEGIN/END IF 触发器、模式/提交/PROMPT 与合法 function/event/trigger 标识符');

    step = '错误行与停止';
    await query('CREATE TABLE "QA_EVENTS"("ID" INT PRIMARY KEY,"NOTE" VARCHAR(80))');
    const snapshotFile = write('snapshot', 'INSERT INTO "QA_EVENTS" VALUES(50,\'预检快照\');\n');
    const snapshotPlan = await preview(snapshotFile);
    fs.appendFileSync(snapshotFile, 'INSERT INTO "QA_EVENTS" VALUES(51,\'预检后追加，禁止执行\');\n');
    const snapshotReport = await execute(snapshotPlan);
    assert.equal(snapshotReport.executed, 1); assert.equal(snapshotReport.failed, 0);
    assert.equal(Number(await scalar('SELECT COUNT(*) FROM "QA_EVENTS" WHERE "ID"=50')), 1);
    assert.equal(Number(await scalar('SELECT COUNT(*) FROM "QA_EVENTS" WHERE "ID"=51')), 0, '执行读取了预检后的源文件修改');
    assertReportFile(snapshotReport);
    result.cases.push('独立样例预检后追加 SQL 不被执行，验证固定快照；用户样例副本保持只改模式名');
    const failureScript = (before, after) => `-- 验收行号\nINSERT INTO "QA_EVENTS" VALUES(${before},'已执行;分号在文本中');\nINSERT INTO "QA_MISSING59" VALUES(1);\nINSERT INTO "QA_EVENTS" VALUES(${after},'后续');\n`;
    const stopPlan = await preview(write('stop', failureScript(10, 11)));
    const stop = await execute(stopPlan);
    assert.equal(stop.executed, 1); assert.equal(stop.failed, 1); assert.equal(stop.uncertain, false);
    assert.equal(stop.entries.find(e => e.status === 'failed').line, 3);
    assert.match(stop.error, /3/);
    assert.equal(Number(await scalar('SELECT COUNT(*) FROM "QA_EVENTS" WHERE "ID"=10')), 1);
    assert.equal(Number(await scalar('SELECT COUNT(*) FROM "QA_EVENTS" WHERE "ID"=11')), 0);
    assertReportFile(stop);
    const continueReport = await execute(await preview(write('continue', failureScript(20, 21)), true));
    assert.equal(continueReport.executed, 2); assert.equal(continueReport.failed, 1);
    assert.equal(Number(await scalar('SELECT COUNT(*) FROM "QA_EVENTS" WHERE "ID" IN (20,21)')), 2);
    assertReportFile(continueReport);
    const wheneverPlan = await preview(write('whenever-exit', 'WHENEVER SQLERROR EXIT 1\n' + failureScript(30, 31)), true);
    const whenever = await execute(wheneverPlan);
    assert.equal(whenever.executed, 1); assert.equal(whenever.failed, 1);
    assert.equal(Number(await scalar('SELECT COUNT(*) FROM "QA_EVENTS" WHERE "ID"=31')), 0);
    assertReportFile(whenever);
    result.cases.push('错误报告保留真实文件行号；默认停止、显式继续及 WHENEVER EXIT 优先停止，已提交数据保留');

    step = '未提交事务收尾';
    const transactionBegin = process.env.DBFOLIO_TEST_DM_TRANSACTION_BEGIN || 'SET AUTOCOMMIT OFF';
    const rollback = await execute(await preview(write('unfinished-transaction', `${transactionBegin};\nINSERT INTO "QA_EVENTS" VALUES(40,'应回滚');\n`)));
    assert.equal(rollback.failed, 0, rollback.error || '事务样例失败');
    assert.equal(rollback.uncertain, false);
    assert.equal(Number(await scalar('SELECT COUNT(*) FROM "QA_EVENTS" WHERE "ID"=40')), 0, '文件末尾未提交 DML 未回滚');
    assertReportFile(rollback);
    result.cases.push('脚本末尾未提交 DML 回滚，不撤销此前已隐式提交的 DDL');

    step = '只读保护';
    const readonly = await createSession(true);
    await assert.rejects(() => preview(sourceCopy, false, readonly.session.id), /只读/);
    const protectedPlan = await preview(write('readonly-plan', 'SELECT 1 FROM DUAL;'));
    await assert.rejects(() => execute(protectedPlan, true, readonly.session.id), /只读|匹配/);
    await assert.rejects(() => invoke('query_execute', { ...base, sessionId: readonly.session.id, sql: 'INSERT INTO "QA_EVENTS" VALUES(99,\'禁止\')', force: true }), /只读/);
    assert.equal(Number(await scalar('SELECT COUNT(*) FROM "QA_EVENTS" WHERE "ID"=99')), 0);
    result.cases.push('只读会话拒绝脚本预检、跨会话计划执行和查询写入');

    if (process.env.DBFOLIO_TEST_DM_IMPORT_UI !== '0') {
      step = '导入入口界面';
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByText('DM59 导入验收', { exact: true }).click();
      const schemaLabel = page.getByRole('treeitem').filter({ hasText: schema }).getByText(schema, { exact: true }).first();
      await schemaLabel.click({ button: 'right' });
      await page.getByRole('menuitem', { name: /导入 SQL 文件/ }).click();
      await page.getByRole('button', { name: '选择 SQL 文件', exact: true }).waitFor();
      await page.getByLabel('模式', { exact: true }).waitFor();
      assert.equal(await page.getByRole('option', { name: schema, exact: true }).count(), 1);
      await page.screenshot({ path: path.join(out, 'dm59-sql-import.png') });
      result.cases.push('达梦模式右键菜单可进入共用 SQL 文件导入页');

      step = '查询页完整脚本与选中执行';
      await schemaLabel.click({ button: 'right' });
      await page.getByRole('menuitem', { name: '新建查询', exact: true }).click();
      const pane = page.locator('.dw-query-sql-pane:visible');
      const editorBox = pane.locator('.monaco-editor');
      const editorLines = editorBox.locator('.view-lines');
      await editorLines.waitFor();
      // Verify actual execution through the local query journal and server results.
      const uiQuery = async (sql, selectAll = true) => {
        // Newer WebView2 uses native EditContext; focus the real editor surface.
        const editorBox = await pane.locator('.monaco-editor').boundingBox();
        assert(editorBox && editorBox.height > 90);
        await page.mouse.click(editorBox.x + 110, editorBox.y + 65);
        await page.keyboard.press('Control+A');
        await page.keyboard.insertText(sql);
        if (selectAll) await page.keyboard.press('Control+A');
        else {
          // Put the caret inside IF rather than selecting the complete program block.
          await page.keyboard.press('Control+Home');
          await page.keyboard.press('ArrowDown');
          await page.keyboard.press('ArrowDown');
        }
        const before = await invoke('query_history_list', { sessionId: base.sessionId, limit: 50 });
        const previousId = Math.max(0, ...before.map(e => e.id));
        await page.getByRole('button').filter({ hasText: /^执行当前语句$/ }).click();
        let last, confirmedOnce = false;
        for (let i = 0; i < 300; i++) {
          const confirm = page.getByRole('button', { name: '确认执行', exact: true });
          if (!confirmedOnce && await confirm.isVisible()) { await confirm.click({ force: true }); confirmedOnce = true; }
          const history = await invoke('query_history_list', { sessionId: base.sessionId, limit: 50 });
          const entry = history.find(e => e.id > previousId);
          if (entry) { last = { sql: entry.sql, status: entry.success ? 'success' : 'error', error: entry.errorCode }; break; }
          await delay(100);
        }
        assert(last && last.status !== 'running', '查询页未完成请求，可能误弹命名参数窗口');

        await delay(200);
        return last;
      };
      const uiBatch = batch.replaceAll('QA_QUERY', 'QA_UI_QUERY').replaceAll('DM59_QUERY_OK', 'DM59_UI_QUERY_OK');
      const uiResult = await uiQuery(uiBatch);
      assert.equal(uiResult.status, 'success', JSON.stringify(uiResult.error));
      assert.deepEqual((await rows('SELECT "function","event","trigger" FROM "QA_UI_QUERY"'))[0].map(v => Number(v[1])), [7, 8, 9]);
      await page.getByText(/^脚本已完成 6 条/).waitFor();
      await page.getByRole('status').filter({ hasText: 'DM59_UI_QUERY_OK' }).waitFor();
      await page.screenshot({ path: path.join(out, 'dm59-query-script.png') });
      const caretBlock = 'CREATE OR REPLACE TRIGGER "TRG_QA_UI_QUERY" BEFORE INSERT OR UPDATE ON "QA_UI_QUERY" FOR EACH ROW\nBEGIN\n  IF :NEW."ID" < 0 THEN\n    RAISE_APPLICATION_ERROR(-20010,\'QA_UI_CARET\');\n  END IF;\nEND;\n/';
      const caretResult = await uiQuery(caretBlock, false);
      assert.equal(caretResult.status, 'success', JSON.stringify(caretResult.error));
      assert.match(caretResult.sql, /CREATE OR REPLACE TRIGGER[\s\S]*END;\s*(?:\/)?$/, '光标位于 IF 时未执行完整触发器');
      await assert.rejects(() => query('INSERT INTO "QA_UI_QUERY" VALUES(-1,0,0,0)'), /20010|QA_UI_CARET/);
      result.cases.push('查询页选中整批执行，:NEW 伪记录不弹参数框；光标在 IF 内执行完整触发器；客户端输出单独显示');

      step = '查询失败清除旧结果';
      const beforeFailure = await uiQuery('SELECT "function","event","trigger" FROM "QA_UI_QUERY";');
      assert.equal(beforeFailure.status, 'success', JSON.stringify(beforeFailure.error));
      await page.locator('.ag-root-wrapper:visible').waitFor();
      const failedQuery = await uiQuery('SELECT * FROM "QA_MISSING59";');
      assert.equal(failedQuery.status, 'error');
      assert.equal(await page.locator('.ag-root-wrapper:visible').count(), 0, '失败后仍残留旧结果网格');
      assert.equal(await page.getByText(/^脚本已完成 /).count(), 0, '失败后仍残留旧脚本完成提示');
      await page.screenshot({ path: path.join(out, 'dm59-query-failure.png') });
      result.cases.push('查询页失败时清除旧网格和旧脚本状态，不再混显示旧结果');
    }
    result.passed = true;
  } catch (error) {
    result.error = { step, message: String(error) };
    if (page) await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
    process.exitCode = 1;
  } finally {
    if (invoke) {
      if (created) {
        try {
          assert(/^DBFOLIO_DM59_\d{13}$/.test(schema));
          for (const id of sessions) {
            try { await invoke('session_disconnect', { id }); }
            catch (error) { result.cleanupDisconnectError = String(error); result.passed = false; process.exitCode = 1; }
          }
          await invoke('session_connect', { id: base.sessionId });
          await invoke('query_execute', { ...base, database: 'SYSDBA', sql: `DROP SCHEMA ${ident(schema)} CASCADE`, force: true });
          result.cleanedSchema = true;
        } catch (error) { result.cleanupError = String(error); result.passed = false; process.exitCode = 1; }
      }
      for (const id of sessions) {
        try { await invoke('session_delete', { id }); }
        catch (error) { result.cleanupSessionError = String(error); result.passed = false; process.exitCode = 1; }
      }
    }
    result.sourceUnchanged = fs.existsSync(sourcePath) && hash(fs.readFileSync(sourcePath)) === sourceHash;
    if (!result.sourceUnchanged) { result.sourceError = '原始文件内容在验收期间发生变化'; result.passed = false; process.exitCode = 1; }
    result.sourceCopyUnchanged = fs.existsSync(sourceCopy) && fs.readFileSync(sourceCopy, 'utf8') === prepared.copy;
    if (!result.sourceCopyUnchanged) { result.sourceCopyError = '用户样例隔离副本超出了模式名替换'; result.passed = false; process.exitCode = 1; }
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
    if (browser) await browser.close().catch(() => {});
    app.kill();
    await delay(1500);
    console.log(out);
  }
}

module.exports = { prepareSource };
if (require.main === module) run().catch(error => { console.error(error.message); process.exitCode = 1; });
