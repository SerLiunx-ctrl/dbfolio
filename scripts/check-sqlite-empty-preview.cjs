const fs=require('node:fs'),path=require('node:path'),ts=require('typescript'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process');
function load(file){file=path.resolve(file);const m={exports:{}};new Function('require','module','exports',ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(n=>load(path.resolve(path.dirname(file),n+'.ts')),m,m.exports);return m.exports;}
const {buildTableSelect}=load('src/features/grid/value.ts');
const sql=buildTableSelect('sqlite','main',null,'items',[{name:'id',canonical:{kind:'int',bits:64,unsigned:false}},{name:'payload',canonical:{kind:'binary'}},{name:'note',canonical:{kind:'string'}}]);
const script=String.raw`
import sys,json,sqlite3
sql=json.loads(sys.stdin.buffer.read().decode('utf-8'))
c=sqlite3.connect(':memory:')
c.execute('CREATE TABLE items(id INTEGER PRIMARY KEY, payload BLOB, note TEXT)')
source=[(1,None,None),(2,b'',''),(3,b'\x00\xff','quote " and tab\t\ntext')]
c.executemany('INSERT INTO items VALUES(?,?,?)',source)
assert c.execute("SELECT typeof(substr(X'',1,1025))").fetchone()[0]=='null'
assert c.execute(sql).fetchall()==source
print(json.dumps({'passed':True,'sqliteVersion':sqlite3.sqlite_version,'cases':['NULL','zero-length BLOB','nonempty binary','empty text','embedded tab/newline'],'productionSql':sql}))
`;
const r=spawnSync('python',['-c',script],{encoding:'utf8',input:JSON.stringify(sql)});if(r.status!==0)throw Error(r.stderr||r.stdout);const result=JSON.parse(r.stdout);assert(result.passed);fs.mkdirSync('.qa',{recursive:true});fs.writeFileSync('.qa/grid61-empty-preview.json',JSON.stringify(result,null,2));console.log('PASS 生产 SQLite 预览 SQL 实际执行：NULL / 空 BLOB / 字节 / 空文本 / Tab换行保持区别');
