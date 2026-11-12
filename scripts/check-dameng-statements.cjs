const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const cache = new Map();
function load(name) {
  if (cache.has(name)) return cache.get(name).exports;
  const module = { exports: {} }; cache.set(name, module);
  const source = fs.readFileSync(`src/features/query/${name}.ts`, 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  new Function('module', 'exports', 'require', code)(module, module.exports, path => load(path.replace('./', '')));
  return module.exports;
}
const { sqlTokens, currentStatement, namedParameters, fillParameters } = load('sqlText');
const { damengStatementRanges } = load('damengStatement');
const ranges = sql => damengStatementRanges(sql, sqlTokens(sql, 'dameng'));
const selected = (sql, marker) => currentStatement(sql, sql.indexOf(marker), 'dameng');

const script = `-- DM8 控制行使用换行，不需要分号
WHENEVER SQLERROR EXIT 1
SET DEFINE OFF
SET ECHO OFF
SET SCHEMA "AGENT";
CREATE TABLE "T" ("ID" INT, "NOTE" VARCHAR(100));
CREATE OR REPLACE TRIGGER "TRG_T"
BEFORE INSERT OR UPDATE ON "T" FOR EACH ROW
BEGIN
  IF :NEW."ID" IS NOT NULL THEN
    :NEW."NOTE" := '有分号; 的中文';
  END IF;
END;
/
COMMIT;
PROMPT DM8_IMPORT_OK_AGENT`;
const statements = ranges(script);
assert.deepEqual(statements.map(s => s.kind), ['client', 'client', 'client', 'sql', 'sql', 'program', 'sql', 'client']);
assert(selected(script, 'WHENEVER').endsWith('WHENEVER SQLERROR EXIT 1'));
assert.equal(selected(script, 'SET DEFINE'), 'SET DEFINE OFF');
assert.equal(selected(script, 'SET ECHO'), 'SET ECHO OFF');
assert.equal(selected(script, 'SET SCHEMA'), 'SET SCHEMA "AGENT"');
assert.equal(selected(script, 'CREATE TABLE'), 'CREATE TABLE "T" ("ID" INT, "NOTE" VARCHAR(100))');
const trigger = statements.find(s => s.kind === 'program').text;
for (const marker of ['TRG_T', ':NEW."ID"', ':NEW."NOTE"', 'END IF;', 'END;\n/', '/\nCOMMIT']) {
  assert.equal(selected(script, marker), trigger, marker);
}
assert(trigger.endsWith('END;'));
assert(!trigger.endsWith('/'));
assert.deepEqual(namedParameters(trigger, 'dameng'), []);
assert.equal(currentStatement(script, script.length, 'dameng'), 'PROMPT DM8_IMPORT_OK_AGENT');

const binds = 'SELECT :id, :new, :old, :NEW."ID", :old . "ID", :NEW/* 注释 */."ID", :value FROM dual';
assert.deepEqual(namedParameters(binds, 'dameng').map(p => p.name), ['id', 'new', 'old', 'value']);
assert.equal(fillParameters(binds, { id:'1', new:'2', old:'3', value:"'中文'" }, 'dameng'), 'SELECT 1, 2, 3, :NEW."ID", :old . "ID", :NEW/* 注释 */."ID", \'中文\' FROM dual');
assert.deepEqual(namedParameters(':NEW."ID"', 'mysql').map(p => p.name), ['NEW']);

const anonymous = `DECLARE
  v INT := 1;
BEGIN
  BEGIN
    v := CASE WHEN v=1 THEN 2 ELSE 3 END;
  END;
  FOR i IN 1..2 LOOP
    IF i=1 THEN v := 4; END IF;
  END LOOP;
  CASE v WHEN 4 THEN v := 5; ELSE v := 0; END CASE;
END;
/
SELECT 2;`;
assert.equal(ranges(anonymous).length, 2);
for (const marker of ['v INT', 'THEN 2', 'END;\n  FOR', 'END IF;', 'END LOOP;', 'END CASE;']) {
  assert.equal(selected(anonymous, marker), ranges(anonymous)[0].text, marker);
}
assert.equal(selected(anonymous, 'SELECT 2'), 'SELECT 2');
assert.deepEqual(ranges('BEGIN NULL; END; /\n').map(s => s.kind), ['program', 'sql']); // slash must occupy its own line
assert.deepEqual(ranges('BEGIN NULL; END;\r\n/ -- disql terminator\r\nSELECT 1/2;').map(s => s.kind), ['program', 'sql']);
assert.equal(selected('BEGIN NULL; END;\r\n/\r\nSELECT 1;', '/\r'), 'BEGIN NULL; END;');

for (const head of ['DECLARE', 'CREATE PROCEDURE OUTER_P AS', 'CREATE OR REPLACE FUNCTION OUTER_P RETURN INT AS', 'CREATE TRIGGER OUTER_P BEFORE INSERT ON T FOR EACH ROW DECLARE', 'CREATE OR REPLACE PACKAGE BODY OUTER_P AS', 'CREATE TYPE BODY OUTER_P AS']) {
  const unit = `${head}\n  PROCEDURE INNER_P AS BEGIN CASE WHEN 1=1 THEN NULL; END CASE; END;\nBEGIN INNER_P(); END;`;
  const sql = `${unit}\n/\nSELECT 2;`;
  assert.equal(ranges(sql).length, 2, head);
  assert.equal(ranges(sql)[0].kind, 'program', head);
  for (const marker of ['INNER_P AS', 'END CASE;', 'END;\nBEGIN', 'INNER_P();']) {
    assert.equal(selected(sql, marker), unit, `${head}: ${marker}`);
  }
  assert.equal(currentStatement(unit, unit.length, 'dameng'), unit, `${head}: EOF`);
}
const transactions = 'BEGIN TRANSACTION; INSERT INTO T VALUES(1); ROLLBACK;\nSTART TRANSACTION; SELECT 2; COMMIT;\nBEGIN TRAN; SELECT 3; ROLLBACK;';
assert.deepEqual(ranges(transactions).map(s=>s.kind), Array(9).fill('sql'));
assert.equal(selected(transactions, 'BEGIN TRANSACTION'), 'BEGIN TRANSACTION');
assert.equal(selected(transactions, 'START TRANSACTION'), 'START TRANSACTION');
assert.equal(selected(transactions, 'SELECT 2'), 'SELECT 2');
assert.equal(selected(transactions, 'BEGIN TRAN;'), 'BEGIN TRAN');
assert.equal(ranges('START other.sql\nSELECT 1;')[0].kind, 'client', '客户端 START 仍按行独立选择');
const caseBlock = 'BEGIN CASE WHEN 1=1 THEN NULL; END CASE; END;\n/\nSELECT 1;';
assert.equal(ranges(caseBlock).length, 2);
assert.equal(selected(caseBlock, 'END CASE;'), 'BEGIN CASE WHEN 1=1 THEN NULL; END CASE; END;');

for (const literal of ["q'[text; 'quoted';\n/\nPROMPT hidden]'", "Q'{text; 'quoted'}'", "q'(text;)'", "q'<text;>'", "nq'!中文; 'quote'!'"]) {
  const sql = `SELECT ${literal} AS v FROM dual; SELECT 2;`;
  assert.equal(ranges(sql).length, 2, literal);
  assert.equal(selected(sql, 'SELECT 2'), 'SELECT 2', literal);
}
assert.equal(ranges("/* BEGIN; PROMPT fake\n/ */ SELECT 'END;'; -- /\nSELECT 2;").length, 2);
assert.equal(ranges('PROMPT success; still message\nSET IDENTITY_INSERT "T" ON;\nSELECT 1;').length, 3);
assert.equal(selected('\ufeff-- 注释\r\nSET ECHO OFF\r\nSELECT 1;', 'SELECT 1'), 'SELECT 1');
assert.equal(selected('-- 😀 前导注释\nSELECT 1;\nSELECT 2;', 'SELECT 2'), 'SELECT 2');
assert.equal(currentStatement("SELECT ';'; SELECT 2;", 5, 'mysql'), "SELECT ';'");
assert.equal(currentStatement('SELECT $$x;y$$; SELECT 2;', 24, 'postgres'), 'SELECT 2');
assert.equal(currentStatement('SELECT [a;b]; SELECT 2;', 23, 'sqlite'), 'SELECT 2');

// Optional user-provided script is parsed read-only; never connect to a database.
const fixture = process.argv[2];
if (fixture) {
  const sql = fs.readFileSync(fixture, 'utf8');
  const parsed = ranges(sql);
  const triggers = parsed.filter(s => /^CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\b/im.test(s.text));
  assert(triggers.length > 0);
  for (const s of triggers) {
    assert(/END IF;\s*END;\s*$/i.test(s.text));
    const at = s.start + sql.slice(s.start, s.end).indexOf(':NEW.');
    assert.equal(currentStatement(sql, at, 'dameng'), s.text);
    assert.deepEqual(namedParameters(s.text, 'dameng'), []);
  }
  assert(currentStatement(sql, sql.length, 'dameng').endsWith('PROMPT DM8_IMPORT_OK_AGENT'));
  assert(parsed.some(s => s.kind === 'client' && /WHENEVER SQLERROR EXIT 1/.test(s.text)));
  console.log(`PASS 只读脚本解析：${parsed.length} 个单元，${triggers.length} 个完整触发器，尾部 PROMPT 独立选择`);
}
console.log('PASS 达梦客户端行、匿名块/触发器、内部 IF/CASE/LOOP 分号、独立斜线、引号/注释、伪记录/命名参数、跨引擎回归');
