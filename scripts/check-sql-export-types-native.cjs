// SQL 文件导出/本软件导入的正式 EXE 往返验收。仅使用本轮专属数据库。
// --minimal --version=1.0.0-alpha.55 可复现旧版 BIT 十六进制问题。
// 旧会话只读复制配置并复用其凭据，绝不删除旧 ID；也可用密码环境创建临时会话。
const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),assert=require('node:assert/strict');
const {spawn,spawnSync}=require('node:child_process'),{DatabaseSync}=require('node:sqlite');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const args=process.argv.slice(2),option=name=>args.find(v=>v.startsWith('--'+name+'='))?.slice(name.length+3);
const version=option('version')||require('../package.json').version,minimal=args.includes('--minimal'),probeOnly=args.includes('--probe-expressions'),expectFixed=args.includes('--expect-fixed');
const stamp=Date.now(),prefix=`dbfolio_export56_${stamp}`,out=path.resolve(`.qa/sql-export56-native-${version}-${stamp}`),profile=path.join(out,'profile');
const ownDatabases=new Set(),ownedSessions=new Set();let mysqlSessionId=option('mysql-session')||process.env.DBFOLIO_TEST_MYSQL_SESSION,sourceRecordSnapshot;
const result={version,minimal,expectFixed,passed:false,cases:[],exports:[],failures:[],cleanupErrors:[]};
const delay=ms=>new Promise(r=>setTimeout(r,ms)),qi=s=>'`'+s.replace(/`/g,'``')+'`';
const bitWidths=[1,3,7,8,9,12,16,32,63,64];
const bitPatterns=[()=>null,()=>0n,()=>1n,w=>(1n<<BigInt(w))-1n,w=>1n<<BigInt(w-1),w=>5n&((1n<<BigInt(w))-1n)];
const textLiteral=s=>`CONVERT(X'${Buffer.from(s,'utf8').toString('hex')}' USING utf8mb4)`;
const valueOf=cell=>cell?.[1],rowsOf=outcome=>outcome.rows.map(row=>Object.fromEntries(outcome.columns.map((c,i)=>[c.name,valueOf(row[i])])));
function typeFixtures(){
 const odd="单引号' 双引号\" 反斜杠\\ 中文😀\0\n\r\t\b\x1a; -- # /* */ ",long=odd.repeat(100);
 const fixture=(name,columns,rows)=>({name,create:`CREATE TABLE ${qi(name)}(id INT PRIMARY KEY,${columns}) ENGINE=InnoDB`,inserts:rows.map((values,i)=>`INSERT INTO ${qi(name)} VALUES(${i+1},${values})`)});
 return [
  fixture('integer_values','ti TINYINT,tu TINYINT UNSIGNED,si SMALLINT,su SMALLINT UNSIGNED,mi MEDIUMINT,mu MEDIUMINT UNSIGNED,iv INT,iu INT UNSIGNED,bi BIGINT,bu BIGINT UNSIGNED',[
   'NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL','-128,0,-32768,0,-8388608,0,-2147483648,0,-9223372036854775808,0','127,255,32767,65535,8388607,16777215,2147483647,4294967295,9223372036854775807,18446744073709551615','0,1,0,1,0,1,0,1,9007199254740993,9007199254740993']),
  fixture('number_values','f FLOAT,d DOUBLE,dec65 DECIMAL(65,30),dec38 DECIMAL(38,18)',[
   'NULL,NULL,NULL,NULL','0.123456789,0.12345678901234567,99999999999999999999999999999999999.999999999999999999999999999999,12345678901234567890.123456789012345678','1.23456789e20,1.7976931348623157e308,-99999999999999999999999999999999999.999999999999999999999999999999,-12345678901234567890.123456789012345678','1.17549435e-38,2.2250738585072014e-308,0.000000000000000000000000000001,0.000000000000000001','-3.4028234e38,-1.7976931348623157e308,0,0','1.401298464e-45,4.9406564584124654e-324,1,1']),
  fixture('string_values','c CHAR(80),v VARCHAR(255),tt TINYTEXT,t TEXT,mt MEDIUMTEXT,lt LONGTEXT,mb3 VARCHAR(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_bin,latin VARCHAR(255) CHARACTER SET latin1 COLLATE latin1_bin',[
   Array(8).fill('NULL').join(','),Array(8).fill(textLiteral('')).join(','),[...Array(6).fill(textLiteral(odd)),textLiteral("中文繁體 引号' 反斜杠\\\0"),textLiteral("éÿÅß ç æ £ ' \\\0")].join(','),[textLiteral('trailing  '),textLiteral('Case sensitive A a  '),textLiteral('中文😀'),textLiteral(long),textLiteral(long),textLiteral(long),textLiteral('中文尾空格  '),textLiteral('Latin trailing  ')].join(',')]),
  fixture('binary_values','b BINARY(8),vb VARBINARY(64),tb TINYBLOB,bl BLOB,mb MEDIUMBLOB,lb LONGBLOB',[
   'NULL,NULL,NULL,NULL,NULL,NULL',Array(6).fill("X''").join(','),Array(6).fill("X'000001FF5C270A1A'").join(','),["X'0000000000000000'","X'00'","X'00'","X'FF0000'","X'00FF'","X'800000FF'"].join(',')]),
  fixture('temporal_values','da DATE,dt DATETIME(6),ts TIMESTAMP(6) NULL,tm TIME(6),yr YEAR',[
   'NULL,NULL,NULL,NULL,NULL',"'1000-01-01','1000-01-01 00:00:00.000001','1970-01-01 00:00:01.000001','-838:59:59.999999',1901","'9999-12-31','9999-12-31 23:59:59.999999','2038-01-19 03:14:07.999999','838:59:59.999999',2155","'2024-02-29','2024-02-29 12:34:56.123456','2024-02-29 12:34:56.123456','-12:34:56.123456',2024"]),
  fixture('zero_date_values',"da DATE DEFAULT '0000-00-00',dt DATETIME(6) DEFAULT '0000-00-00 00:00:00.000000',ts TIMESTAMP(6) NULL,tm TIME(6),yr YEAR",[
   'NULL,NULL,NULL,NULL,NULL',"'0000-00-00','0000-00-00 00:00:00.000000','0000-00-00 00:00:00.000000','00:00:00.000000',0","'0000-01-01','0000-01-01 00:00:00.000001',NULL,'-00:00:00.000001',0","'2024-00-00','2024-00-00 00:00:00.999999',NULL,'00:00:00.000001',2024"]),
  fixture('invalid_date_values',"da DATE DEFAULT '2012-02-31',dt DATETIME(6) DEFAULT '2012-02-31 12:34:56.123456'",['NULL,NULL',"'2012-02-31','2012-02-31 12:34:56.123456'","'2024-04-31','2024-04-31 00:00:00.999999'"]),
  fixture('json_enum_values',"j JSON,e ENUM('','alpha','中文','引''号','path\\\\x'),s SET('a','b','中文'),e_digits ENUM('2','0','1')",[
   'NULL,NULL,NULL,NULL',[textLiteral('{"big":18446744073709551615,"negative":-9223372036854775808,"fraction":0.12345678901234567,"null":null,"zero":0,"array":[true,false,"中文😀","quote\\\" slash\\\\ nul\\u0000"]}'),"'中文'","'a,b,中文'","'0'"].join(','),[textLiteral('null'),"''","''","'1'"].join(','),[textLiteral('{"k":"value"}'),"'引''号'","'b'","'2'"].join(',')]),
  fixture('geometry_values','g GEOMETRY,p POINT SRID 4326,l LINESTRING,poly POLYGON,mp MULTIPOINT,ml MULTILINESTRING,mpl MULTIPOLYGON,gc GEOMETRYCOLLECTION',[
   Array(8).fill('NULL').join(','),["ST_GeomFromText('POINT(1 2)',0)","ST_GeomFromText('POINT(10 20)',4326)","ST_GeomFromText('LINESTRING(0 0,1 1,2 1)',0)","ST_GeomFromText('POLYGON((0 0,0 2,2 2,2 0,0 0))',0)","ST_GeomFromText('MULTIPOINT((1 2),(3 4))',0)","ST_GeomFromText('MULTILINESTRING((0 0,1 1),(2 2,3 3))',0)","ST_GeomFromText('MULTIPOLYGON(((0 0,0 2,2 2,2 0,0 0)))',0)","ST_GeomFromText('GEOMETRYCOLLECTION(POINT(1 2),LINESTRING(0 0,1 1))',0)"].join(','),["ST_GeomFromText('GEOMETRYCOLLECTION EMPTY',0)",...Array(6).fill('NULL'),"ST_GeomFromText('GEOMETRYCOLLECTION EMPTY',0)"].join(','),["ST_GeomFromText('POINT(10 20)',4326)",...Array(6).fill('NULL'),"ST_GeomFromText('GEOMETRYCOLLECTION(POINT(10 20))',4326)"].join(',')]),
  {name:'generated_values',create:'CREATE TABLE generated_values(id INT PRIMARY KEY,a BIGINT,b DECIMAL(20,8),v BIGINT GENERATED ALWAYS AS(a*2) VIRTUAL,s DECIMAL(30,8) GENERATED ALWAYS AS(b*3) STORED) ENGINE=InnoDB',inserts:['INSERT INTO generated_values(id,a,b) VALUES(1,NULL,NULL),(2,9007199254740993,123456789012.12345678),(3,-12345,-0.00000001)']},
  {name:'auto_increment_values',create:'CREATE TABLE auto_increment_values(id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,payload VARCHAR(50)) ENGINE=InnoDB',inserts:["INSERT INTO auto_increment_values(id,payload) VALUES(0,'explicit-zero'),(1,NULL),(9007199254740993,'large-id')"]},
 ];
}
fs.mkdirSync(out,{recursive:true});fs.writeFileSync('.qa/sql-export56-latest-native.txt',out);
function localDb(file,readOnly,fn){const db=new DatabaseSync(file,{readOnly});try{return fn(db);}finally{db.close();}}
function copyLocalRootSession(){
 const file=path.join(process.env.APPDATA,'data-workbench','app.db');assert(fs.existsSync(file),'真实配置不存在');
 const row=localDb(file,true,db=>mysqlSessionId?db.prepare('SELECT * FROM sessions WHERE id=?').get(mysqlSessionId):db.prepare("SELECT * FROM sessions WHERE engine='mysql' AND host IN ('127.0.0.1','localhost','::1') AND coalesce(port,3306)=3306 AND username='root' AND read_only=0 AND allowed_databases IS NULL LIMIT 1").get());
 assert(row,'未找到可复用本机 root 会话；可设置 DBFOLIO_TEST_MYSQL_PASSWORD');assert.equal(row.engine,'mysql');assert.equal(row.username,'root');assert(['127.0.0.1','localhost','::1'].includes(row.host));assert.equal(Number(row.port||3306),3306);assert.equal(row.read_only,0);assert.equal(row.allowed_databases,null);
 mysqlSessionId=row.id;sourceRecordSnapshot=JSON.stringify(row);row.name='SQL 文件导出隔离验收';row.group_name=null;assert(profile.startsWith(out+path.sep));localDb(path.join(profile,'app.db'),false,db=>{const available=new Set(db.prepare('PRAGMA table_info(sessions)').all().map(c=>c.name)),columns=Object.keys(row).filter(k=>available.has(k));db.prepare(`INSERT INTO sessions(${columns.map(qi).join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).run(...columns.map(k=>row[k]));});
 result.credentialMode='existing-local-root-session-reused';
}
async function freePort(){const s=net.createServer();await new Promise((r,j)=>{s.once('error',j);s.listen(0,'127.0.0.1',r);});const port=s.address().port;await new Promise(r=>s.close(r));return port;}
const exportRequest=(sessionId,database,tables,targetDatabase,file,mode='both')=>({sessionId,database,tables,allTables:false,mode,path:file,splitFiles:false,includeDatabase:true,dropTables:false,consistentSnapshot:true,batchRows:2,batchBytes:1024,filters:{},objectKinds:[],targetDatabase,omitDefiner:true,compressed:false});
(async()=>{
 const exe=path.resolve(`release/${version}/DBFolio_${version}_windows_x64_portable/dbfolio.exe`);assert(fs.existsSync(exe),'正式 portable EXE 不存在');
 const port=await freePort(),app=spawn(exe,['--startup-check',profile],{cwd:path.dirname(exe),windowsHide:true,env:{...process.env,HTTP_PROXY:'',HTTPS_PROXY:'',ALL_PROXY:'',NO_PROXY:'127.0.0.1,localhost',WEBVIEW2_USER_DATA_FOLDER:path.join(out,'webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`},stdio:'ignore'});
 let browser,page,invoke,connected=false;
 const query=(database,sql)=>invoke('query_execute',{sessionId:mysqlSessionId,database,sql,force:true,limit:100});
 const scalar=async(database,sql)=>(await query(database,sql)).rows[0]?.[0]?.[1];
 const makeDatabase=async suffix=>{const name=prefix+'_'+suffix;assert(/^dbfolio_export56_\d+_[a-z_]+$/.test(name));await query('information_schema',`CREATE DATABASE ${qi(name)} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);ownDatabases.add(name);return name;};
 const compare=async(source,target,table,targetTable=table)=>{
  const columns=rowsOf(await query('information_schema',`SELECT COLUMN_NAME,DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=${textLiteral(source)} AND TABLE_NAME=${textLiteral(table)} ORDER BY ORDINAL_POSITION`));
  const geometry=new Set(['geometry','point','linestring','polygon','multipoint','multilinestring','multipolygon','geometrycollection','geomcollection']),bytes=new Set(['char','varchar','tinytext','text','mediumtext','longtext','binary','varbinary','tinyblob','blob','mediumblob','longblob','json','enum','set']);
  const checks=columns.map((c,i)=>{const a='a.'+qi(c.COLUMN_NAME),b='b.'+qi(c.COLUMN_NAME),same=geometry.has(c.DATA_TYPE)?`(ST_AsWKB(${a})<=>ST_AsWKB(${b})) AND (ST_SRID(${a})<=>ST_SRID(${b}))`:bytes.has(c.DATA_TYPE)?`HEX(${a})<=>HEX(${b})`:`${a}<=>${b}`;return {column:c.COLUMN_NAME,kind:c.DATA_TYPE,expression:`SUM(NOT(${same})) AS ${qi('diff'+i)},SUM((${a} IS NULL)<>(${b} IS NULL)) AS ${qi('null'+i)}`};});
  const counts={source:Number(await scalar(source,`SELECT COUNT(*) FROM ${qi(table)}`)),target:Number(await scalar(target,`SELECT COUNT(*) FROM ${qi(targetTable)}`))};
  const values=rowsOf(await query(source,`SELECT COUNT(*) AS matched,${checks.map(c=>c.expression).join(',')} FROM ${qi(source)}.${qi(table)} a JOIN ${qi(target)}.${qi(targetTable)} b USING(id)`))[0];
  const differences=checks.map((c,i)=>({column:c.column,kind:c.kind,changed:Number(values['diff'+i]||0),nullChanged:Number(values['null'+i]||0)}));
  const check={table,counts,matched:Number(values.matched),differences,passed:counts.source===counts.target&&counts.source===Number(values.matched)&&differences.every(d=>d.changed===0&&d.nullChanged===0)};
  fs.writeFileSync(path.join(out,`${target}-${table}-compare.json`),JSON.stringify(check,null,2));return check;
 };
 const importFile=async(file,database)=>{const preview=await invoke('sql_import_preview',{request:{sessionId:mysqlSessionId,database,path:file,encoding:'utf-8',continueOnError:false}});const report=await invoke('sql_import_execute',{sessionId:mysqlSessionId,id:preview.id,reportDirectory:out,confirmed:true});return {preview,report};};
 const probeExpressions=async source=>{
  const probes={};probes.geometryColumnTypes=await query('information_schema',`SELECT COLUMN_NAME,DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=${textLiteral(source)} AND TABLE_NAME='geometry_values' ORDER BY ORDINAL_POSITION`);
  await query(source,'CREATE TABLE float_probe LIKE number_values');probes.floatCandidates=rowsOf(await query(source,"SELECT id,COALESCE(CAST((f+0e0) AS CHAR),'NULL') AS candidate FROM number_values ORDER BY id"));
  for(const row of probes.floatCandidates){assert(/^(?:NULL|[+\-0-9.eE]+)$/.test(row.candidate));await query(source,`INSERT INTO float_probe SELECT id,${row.candidate},d,dec65,dec38 FROM number_values WHERE id=${Number(row.id)}`);}
  probes.floatComparison=await compare(source,source,'number_values','float_probe');assert(probes.floatComparison.passed,'FLOAT f+0e0候选未精确往返');
  const traditionalFile=path.join(out,'probe-traditional-source.sql');fs.writeFileSync(traditionalFile,["CREATE TABLE qa_probe_modes(label VARCHAR(40) PRIMARY KEY,mode TEXT);","SET @QA_ORIGINAL_MODE=@@SQL_MODE;","INSERT INTO qa_probe_modes VALUES('initial',@@SQL_MODE);","SET SQL_MODE='TRADITIONAL';","INSERT INTO qa_probe_modes VALUES('traditional-expanded',@@SQL_MODE);","SET SQL_MODE=@QA_ORIGINAL_MODE;","INSERT INTO qa_probe_modes VALUES('restored',@@SQL_MODE);"].join('\n'));const capture=await importFile(traditionalFile,source);assert.equal(capture.report.failed,0,capture.report.error);
  const modes=rowsOf(await query(source,'SELECT label,mode FROM qa_probe_modes ORDER BY label')),traditional=modes.find(v=>v.label==='traditional-expanded').mode;
  const omitted=['NO_ZERO_DATE','NO_ZERO_IN_DATE','ANSI','TRADITIONAL','DB2','MAXDB','MSSQL','ORACLE','POSTGRESQL'],mode=[...new Set([...traditional.split(',').filter(v=>!omitted.includes(v)),'NO_AUTO_VALUE_ON_ZERO','ALLOW_INVALID_DATES'])].join(',');assert(mode.includes('STRICT_TRANS_TABLES'));
  const zeroFile=path.join(out,'probe-zero-compatible.sql');fs.writeFileSync(zeroFile,["SET @QA_OLD_SQL_MODE=@@SQL_MODE;",`SET SQL_MODE='${mode}';`,'CREATE TABLE zero_probe LIKE zero_date_values;','INSERT INTO zero_probe SELECT * FROM zero_date_values;','CREATE TABLE invalid_probe LIKE invalid_date_values;','INSERT INTO invalid_probe SELECT * FROM invalid_date_values;','SET SQL_MODE=@QA_OLD_SQL_MODE;',"INSERT INTO qa_probe_modes VALUES('candidate-restored',@@SQL_MODE);"].join('\n'));probes.zeroImport=await importFile(zeroFile,source);assert.equal(probes.zeroImport.report.failed,0,probes.zeroImport.report.error);probes.zeroComparison=await compare(source,source,'zero_date_values','zero_probe');assert(probes.zeroComparison.passed);probes.invalidDateComparison=await compare(source,source,'invalid_date_values','invalid_probe');assert(probes.invalidDateComparison.passed);probes.sqlModes=rowsOf(await query(source,'SELECT label,mode FROM qa_probe_modes ORDER BY label'));assert(probes.sqlModes.filter(v=>v.label!=='traditional-expanded').every(v=>v.mode===modes.find(v=>v.label==='initial').mode),'候选/原始模式恢复不一致');probes.candidateSqlMode=mode;
  await query(source,'CREATE TABLE spatial_probe(id INT PRIMARY KEY,g GEOMETRY)');for(const sql of ["INSERT INTO spatial_probe VALUES(1,NULL)","INSERT INTO spatial_probe VALUES(2,ST_GeomFromText('GEOMETRYCOLLECTION EMPTY',0))","INSERT INTO spatial_probe VALUES(3,ST_GeomFromText('GEOMETRYCOLLECTION(POINT(1 2),LINESTRING(0 0,1 1))',0))","INSERT INTO spatial_probe VALUES(4,ST_GeomFromText('POINT(10 20)',4326))","INSERT INTO spatial_probe VALUES(5,ST_GeomFromText('GEOMETRYCOLLECTION(POINT(10 20))',4326))"])await query(source,sql);
  await query(source,'CREATE TABLE spatial_probe_copy LIKE spatial_probe');probes.geometryCandidates=rowsOf(await query(source,"SELECT id,IF(g IS NULL,'NULL',CONVERT(CONCAT('ST_GeomFromWKB(X',CHAR(39),HEX(ST_AsWKB(g)),CHAR(39),',',ST_SRID(g),')') USING utf8mb4)) AS candidate FROM spatial_probe ORDER BY id"));
  for(const row of probes.geometryCandidates){assert(typeof row.candidate==='string');assert(/^(?:NULL|ST_GeomFromWKB\(X'[0-9A-F]+',\d+\))$/.test(row.candidate));await query(source,`INSERT INTO spatial_probe_copy VALUES(${Number(row.id)},${row.candidate})`);}
  probes.geometryComparison=await compare(source,source,'spatial_probe','spatial_probe_copy');assert(probes.geometryComparison.passed);fs.writeFileSync(path.join(out,'candidate-expression-probes.json'),JSON.stringify(probes,null,2));result.probes=probes;result.cases.push('候选SQL真实验证：FLOAT f+0e0精确往返、保留STRICT的零日期兼容模式、空间NULL/空集合/不同SRID保真');
 };
 const sqlExportUi=async(source,target,table)=>{
  await page.reload({waitUntil:'domcontentloaded'});
  await page.getByTitle('SQL 文件导出隔离验收',{exact:true}).first().click();await page.getByRole('button',{name:'文件',exact:true}).click();await page.getByRole('menuitem',{name:'导出 SQL 文件…',exact:true}).click();
  await page.getByRole('heading',{name:'导出 SQL 文件',exact:true}).waitFor();await page.getByLabel('数据库',{exact:true}).selectOption(source);await page.getByRole('checkbox',{name:table,exact:true}).check();await page.getByLabel('恢复目标库（可选；映射定义中的当前库引用）',{exact:true}).fill(target);await page.getByRole('checkbox',{name:'包含建库语句和 USE',exact:true}).check();
  // 原生保存对话框不注入、不改写 invoke；这里只核对真实工作区参数。
  assert(!(await page.getByRole('button',{name:'选择路径并导出',exact:true}).isDisabled()));await page.screenshot({path:path.join(out,'sql-export-table-ui.png')});
  result.ui={parametersScreenshot:path.join(out,'sql-export-table-ui.png'),nativeSaveDialogExecuted:false};result.cases.push('真实SQL导出工作区：单表选择/目标库映射参数与导出按钮状态；原生保存对话框未自动执行');
 };
 const roundtrip=async(label,source,target,table,mode='both',allTables=false)=>{
  const file=path.join(out,label+'.sql'),entry={label,table,mode,file};result.exports.push(entry);
  try{
   entry.export=await invoke('export_sql',{request:{...exportRequest(mysqlSessionId,source,[table],target,file,mode),allTables}});
   const sql=fs.readFileSync(file,'utf8');entry.insertSql=sql.split(/\r?\n/).filter(v=>v.startsWith('INSERT')||v.startsWith('('));
   entry.oddHexLiterals=[...sql.matchAll(/\bX'([0-9a-f]*)'/gi)].filter(m=>m[1].length%2!==0).map(m=>m[0]);
   if(expectFixed)assert.equal(entry.oddHexLiterals.length,0,'修复后不得出现奇数位X十六进制字面量');
   Object.assign(entry,await importFile(file,target));
   if(entry.report.failed||entry.report.error||entry.report.cancelled||entry.report.uncertain)throw Error('SQL 导入未完整成功：'+(entry.report.error||JSON.stringify(entry.report)));
   const names=allTables?result.fixtureTables:[table];entry.comparisons=[];for(const name of names){const comparison=await compare(source,target,name);entry.comparisons.push(comparison);if(!comparison.passed)result.failures.push({label:label+'/'+name,error:'源/目标服务器精确比较发现变化',differences:comparison.differences.filter(d=>d.changed||d.nullChanged)});}
   entry.succeeded=true;
  }catch(e){entry.error=String(e);entry.succeeded=false;result.failures.push({label,error:entry.error});}
  return entry;
 };
 const bundleRoundtrip=async(label,source,target,splitFiles,compressed)=>{
  const location=path.join(out,label+(compressed?'.zip':'')),entry={label,splitFiles,compressed};result.exports.push(entry);
  try{if(splitFiles&&!compressed)fs.mkdirSync(location);entry.export=await invoke('export_sql',{request:{...exportRequest(mysqlSessionId,source,[],target,location),allTables:true,splitFiles,compressed}});let directory=entry.export.path;
   if(compressed){directory=path.join(out,label+'-extracted');const unpack=spawnSync('powershell',['-NoProfile','-Command','Expand-Archive -LiteralPath $env:DBFOLIO_EXPORT_ARCHIVE -DestinationPath $env:DBFOLIO_EXPORT_EXTRACT'],{windowsHide:true,encoding:'utf8',env:{...process.env,DBFOLIO_EXPORT_ARCHIVE:entry.export.path,DBFOLIO_EXPORT_EXTRACT:directory}});assert.equal(unpack.status,0,unpack.stderr);}
   entry.imports=[];for(const name of fs.readdirSync(directory).filter(f=>f.endsWith('.sql')).sort()){const imported=await importFile(path.join(directory,name),target);entry.imports.push({name,...imported});assert.equal(imported.report.failed,0,imported.report.error);assert.equal(imported.report.uncertain,false);}
   assert(entry.imports.length);entry.comparisons=[];for(const table of result.fixtureTables){const comparison=await compare(source,target,table);entry.comparisons.push(comparison);assert(comparison.passed,'类型往返存在差异：'+table);}entry.succeeded=true;
  }catch(e){entry.error=String(e);result.failures.push({label,error:entry.error});}
 };
 try{
  for(let n=0;n<240&&!fs.existsSync(path.join(profile,'frontend-ready.json'));n++){assert(app.exitCode===null,'EXE提前退出');await delay(250);}
  assert.equal(JSON.parse(fs.readFileSync(path.join(profile,'frontend-ready.json'),'utf8')).version,version);
  browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);page=browser.contexts()[0].pages()[0];
  invoke=(command,commandArgs={})=>page.evaluate(({command,commandArgs})=>window.__TAURI_INTERNALS__.invoke(command,commandArgs).catch(e=>{throw Error(JSON.stringify(e));}),{command,commandArgs});
  if(process.env.DBFOLIO_TEST_MYSQL_PASSWORD&&!mysqlSessionId){const session=await invoke('session_create',{input:{name:'SQL 类型往返专属会话',engine:'mysql',host:'127.0.0.1',port:3306,username:'root',password:process.env.DBFOLIO_TEST_MYSQL_PASSWORD,readOnly:false}});mysqlSessionId=session.id;ownedSessions.add(session.id);result.credentialMode='environment-password-temporary-session';}else copyLocalRootSession();
  await invoke('session_connect',{id:mysqlSessionId});connected=true;
  result.mysqlVersion=String(await scalar('information_schema','SELECT VERSION()'));result.sqlMode=String(await scalar('information_schema','SELECT @@GLOBAL.sql_mode'));result.cases.push('正式EXE隔离配置、本机root连接、无密码日志');
  const source=await makeDatabase('source'),target=await makeDatabase('bit');
  const table='bit_values';await query(source,`CREATE TABLE ${qi(table)}(id INT PRIMARY KEY,${bitWidths.map(w=>`b${w} BIT(${w})`).join(',')})`);
  for(const [i,pattern] of bitPatterns.entries())await query(source,`INSERT INTO ${qi(table)} VALUES(${i+1},${bitWidths.map(w=>pattern(w)?.toString()??'NULL').join(',')})`);
  fs.writeFileSync(path.join(out,'source-bit-values.json'),JSON.stringify(await query(source,`SELECT id,${bitWidths.map(w=>`HEX(b${w})`).join(',')} FROM ${qi(table)} ORDER BY id`),null,2));
  const entry=probeOnly?{succeeded:false}:await roundtrip('bit-structure-data',source,target,table);
  if(entry.succeeded){const diff=await scalar(source,`SELECT COUNT(*) FROM ${qi(source)}.${qi(table)} a JOIN ${qi(target)}.${qi(table)} b USING(id) WHERE ${bitWidths.map(w=>`NOT(a.b${w}<=>b.b${w})`).join(' OR ')}`);assert.equal(Number(diff),0);assert.equal(Number(await scalar(target,`SELECT COUNT(*) FROM ${qi(table)}`)),bitPatterns.length);result.cases.push('BIT1/3/7/8/9/12/16/32/63/64：NULL/零/1/高位/奇数nibble/最大值完整往返（边界以BigInt构造SQL）');}
  if(!minimal){
   const fixtures=typeFixtures(),setup=path.join(out,'source-type-fixtures.sql');result.fixtureTables=[table,...fixtures.map(t=>t.name)];
   fs.writeFileSync(setup,["SET @QA_OLD_SQL_MODE=@@SQL_MODE;","SET SESSION SQL_MODE='ALLOW_INVALID_DATES,NO_AUTO_VALUE_ON_ZERO';","SET SESSION TIME_ZONE='+00:00';",'SET NAMES utf8mb4;',...fixtures.flatMap(t=>[t.create+';',...t.inserts.map(s=>s+';')]),'SET SESSION SQL_MODE=@QA_OLD_SQL_MODE;','COMMIT;'].join('\n'));
   result.setup=await importFile(setup,source);assert.equal(result.setup.report.failed,0,result.setup.report.error);assert.equal(result.setup.report.uncertain,false);result.cases.push('仅自有数据库、独立导入连接以UTC/宽松SQL_MODE准备边界数据，未修改全局设置');
   result.geometryDiagnostics=await query(source,"SELECT id,gc IS NULL AS gc_null,COALESCE(HEX(gc),'SQLNULL') AS internal_hex,COALESCE(ST_AsText(gc),'SQLNULL') AS wkt,COALESCE(HEX(ST_AsWKB(gc)),'SQLNULL') AS wkb,COALESCE(CAST(ST_SRID(gc) AS CHAR),'SQLNULL') AS srid,COALESCE(CONCAT('ST_GeomFromWKB(X',CHAR(39),HEX(ST_AsWKB(gc)),CHAR(39),',',ST_SRID(gc),')'),'SQLNULL') AS exported_expression FROM geometry_values ORDER BY id");fs.writeFileSync(path.join(out,'geometry-diagnostics.json'),JSON.stringify(result.geometryDiagnostics,null,2));
   if(probeOnly){await probeExpressions(source);result.passed=true;return;}
   const complete=await makeDatabase('complete'),dataOnly=await makeDatabase('data');
   for(const name of result.fixtureTables){await roundtrip('table-'+name,source,complete,name);const file=path.join(out,'prepare-data-'+name+'.sql');fs.writeFileSync(file,`SET @QA_OLD_MODE=@@SQL_MODE;\nSET SQL_MODE='ALLOW_INVALID_DATES';\nCREATE TABLE ${qi(dataOnly)}.${qi(name)} LIKE ${qi(source)}.${qi(name)};\nSET SQL_MODE=@QA_OLD_MODE;\n`);const prepared=await importFile(file,dataOnly);assert.equal(prepared.report.failed,0,prepared.report.error);await roundtrip('data-'+name,source,dataOnly,name,'data');}
   const entire=await makeDatabase('entire');await roundtrip('entire-database',source,entire,table,'both',true);
   for(const [label,split,zip] of [['split-files',true,false],['single-zip',false,true],['split-zip',true,true]]){const destination=await makeDatabase(label.replace(/-/g,'_'));await bundleRoundtrip(label,source,destination,split,zip);}
   result.cases.push('数值使用服务器<=>精确比较，文本/二进制使用HEX，空间列比较WKB和SRID；逐列单独比较NULL');
   result.tablePageSqlEntry={present:false,reason:'alpha.55 表数据导出弹窗只有 CSV/JSON/Excel；SQL 文件使用独立导出 SQL 文件工作区和 export_sql，不存在 transfer SQL sink'};
   if(args.includes('--ui')){const ui=await makeDatabase('ui');await sqlExportUi(source,ui,table);}
  }
  await page.screenshot({path:path.join(out,'native-app.png')});
  result.passed=result.failures.length===0;
 }catch(e){result.failures.push({label:'native-run',error:String(e)});process.exitCode=1;if(page)await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});}
 finally{
  if(invoke&&connected){for(const database of ownDatabases){assert(database.startsWith(prefix+'_')&&/^dbfolio_export56_\d+_[a-z_]+$/.test(database));await query('information_schema',`DROP DATABASE IF EXISTS ${qi(database)}`).catch(e=>result.cleanupErrors.push(String(e)));}try{result.remainingOwnDatabases=Number(await scalar('information_schema',`SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE LEFT(SCHEMA_NAME,${prefix.length+1})=${textLiteral(prefix+'_')}`));assert.equal(result.remainingOwnDatabases,0,'专属测试库未完全清理');}catch(e){result.cleanupErrors.push(String(e));}await invoke('session_disconnect',{id:mysqlSessionId}).catch(e=>result.cleanupErrors.push(String(e)));}
  // 不删除复用的旧 session ID，避免连带删除用户 Windows 凭据。
  if(invoke)for(const id of ownedSessions)await invoke('session_delete',{id}).catch(e=>result.cleanupErrors.push(String(e)));
  if(invoke)await invoke('plugin:window|destroy',{label:'main'}).catch(()=>{});if(browser)await browser.close().catch(()=>{});if(app.exitCode===null)spawnSync('taskkill',['/PID',String(app.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
  if(sourceRecordSnapshot){try{const record=localDb(path.join(process.env.APPDATA,'data-workbench','app.db'),true,db=>db.prepare('SELECT * FROM sessions WHERE id=?').get(mysqlSessionId));result.originalSessionConfigurationUnchanged=JSON.stringify(record)===sourceRecordSnapshot;assert(result.originalSessionConfigurationUnchanged,'原会话配置发生变化');}catch(e){result.cleanupErrors.push(String(e));}}
  const comparisons=result.exports.flatMap(e=>e.comparisons??[]);result.summary={typeTables:result.fixtureTables?.length??1,exportOperations:result.exports.length,importedSqlFiles:result.exports.reduce((n,e)=>n+(e.report?1:0)+(e.imports?.length??0),0),tableComparisons:comparisons.length,changedColumnComparisons:comparisons.reduce((n,c)=>n+c.differences.filter(d=>d.changed||d.nullChanged).length,0)};
  if(result.cleanupErrors.length)result.passed=false;fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({version,passed:result.passed,cases:result.cases,failures:result.failures.map(f=>({label:f.label,error:f.error,differences:f.differences})),cleanupErrors:result.cleanupErrors,out},null,2));if(!result.passed)process.exitCode=1;
 }
})().catch(e=>{console.error(String(e));process.exitCode=1;});
