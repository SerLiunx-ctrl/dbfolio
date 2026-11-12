const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),ts=require('typescript');
function load(file){const m={exports:{}};new Function('require','exports','module',ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(n=>load(path.resolve(path.dirname(file),n+'.ts')),m.exports,m);return m.exports;}
const {ddlContent}=load(path.resolve('src/features/table/ddlContent.ts')),{objectDisplayName}=load(path.resolve('src/features/table/objectName.ts')),{exportDocument,emptyNotes}=load(path.resolve('src/features/dictionary/model.ts'));
const meta={name:'T',kind:'table',columns:[{name:'ID',rawType:'DECIMAL(20,0)',autoIncrement:true}],primaryKey:['ID'],indexes:[],foreignKeys:[],rawDdl:null};
assert.equal(ddlContent('dameng',meta).sql,null);
assert.equal(ddlContent('dameng',{...meta,rawDdl:'  '}).sql,null);
assert.equal(ddlContent('dameng',{...meta,ddlWarnings:['没有权限']}).warnings[0],'没有权限');
const partial=ddlContent('dameng',{...meta,rawDdl:'CREATE TABLE T(ID INT);',ddlWarnings:['索引无法读取\nDROP TABLE X;']});assert(partial.sql.startsWith('-- DDL 读取说明：索引无法读取 DROP TABLE X;\n\nCREATE TABLE'));
for(const e of ['mysql','postgres','sqlite'])assert(ddlContent(e,meta).sql.includes('CREATE TABLE'));
assert.equal(objectDisplayName('dameng','AGENT','AGENT','T'),'AGENT.T');assert.equal(objectDisplayName('dameng','SYSDBA','APP','T'),'APP.T');assert.equal(objectDisplayName('postgres','db','public','T'),'db.public.T');
assert.equal(exportDocument({engine:'dameng',database:'A',items:[],serverVersion:'DM8',collectedAt:'now'},[{name:'T',schema:null,meta,error:null}],emptyNotes()).entries[0].definition,null);
console.log('PASS 达梦 DDL 缺失不生成替代 SQL、部分诊断随复制保留、字典一致、其他引擎回退和模式名称');
if(process.argv.includes('--logic-only'))process.exit(0);
(async()=>{const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');const browser=await chromium.launch({headless:true,channel:'msedge'});try{const page=await browser.newPage({viewport:{width:1280,height:800}}),errors=[];page.on('pageerror',e=>errors.push(e.message));fs.mkdirSync('.qa',{recursive:true});for(const theme of ['light','dark','oled']){await page.goto(`http://localhost:1425/scripts/fixtures/dameng-ddl.html?theme=${theme}`);await page.getByRole('button',{name:'复制 DDL',exact:true}).waitFor();await page.waitForFunction(()=>window.monaco.editor.getModels().some(m=>m.getLanguageId()==='dameng-sql'));
assert.equal(await page.getByTestId('object-name').innerText(),'AGENT.MODEL_CATALOG');
await page.getByRole('button',{name:'复制 DDL',exact:true}).click();await page.getByRole('button',{name:'在查询页打开',exact:true}).click();await page.waitForFunction(()=>window.copied.length===1&&window.opened.length===1);assert.equal(await page.evaluate(()=>window.copied[0]===window.opened[0]),true);
await page.evaluate(()=>window.setDetail({ddlWarnings:['索引 IDX_X 无法读取，定义可能不完整']}));await page.getByRole('alert').getByText('索引 IDX_X 无法读取，定义可能不完整').waitFor();await page.getByRole('button',{name:'在查询页打开',exact:true}).click();assert((await page.evaluate(()=>window.opened.at(-1))).startsWith('-- DDL 读取说明：'));
await page.screenshot({path:`.qa/dm60-ddl-${theme}.png`});
await page.evaluate(()=>window.setDetail({rawDdl:null,ddlWarnings:['原生定义读取失败：无查看定义权限']}));await page.getByRole('alert').getByText('原生定义读取失败：无查看定义权限').waitFor();assert(await page.getByRole('button',{name:'复制 DDL',exact:true}).isDisabled());assert(await page.getByRole('button',{name:'在查询页打开',exact:true}).isDisabled());assert.equal(await page.locator('.dw-ddl-editor').count(),0);
await page.getByText('服务器未返回原生 DDL，已停用通用重建；可在「结构」页查看元数据。',{exact:true}).waitFor();}
assert.deepEqual(errors,[]);console.log('PASS 达梦三主题 DDL 原生编辑器、复制/查询一致、部分警告、失败禁回退和禁操作');}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
