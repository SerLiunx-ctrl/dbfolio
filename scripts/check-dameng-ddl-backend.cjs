// alpha60 DDL 专项：复用既有窄 harness 骨架，读取当前生产源码，不构建 Tauri。
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { ddlFixture } = require('./fixtures/dameng-ddl.cjs');
const root = process.cwd();
const previous = fs.readFileSync(path.join(__dirname, 'check-dameng-import-backend.cjs'), 'utf8');
let scaffold = previous.slice(0, previous.indexOf("write('acceptance.rs',"));
assert(scaffold.includes("write('lib.rs'"), '窄 harness 骨架边界已改变');
scaffold = scaffold.replace(/let sample;[\s\S]*?if \(process\.env\.DBFOLIO_TEST_DM_PASSWORD\) assert\(sample,[^\n]+\);\n/, '')
  .replaceAll('dm59-import-backend-check', 'dm60-ddl-backend-check').replaceAll('dbfolio-dm59-import-check', 'dbfolio-dm60-ddl-check').replaceAll('DBFOLIO_DM59_', 'DBFOLIO_DM60_');
assert(!scaffold.includes('let sample;'), '旧样例导入安全检查应仅由 alpha59 脚本执行');
const generated = new Function('require', 'process', scaffold + '\nreturn {dest,out,write,production,schema};')(require, process);
const { dest, out, write, production, schema } = generated;
const names = { a: schema + '_A', b: schema + '_B', ta: schema + '_TA', tb: schema + '_TB' };
fs.writeFileSync(path.join(out, 'fixture.json'), JSON.stringify(ddlFixture(names.a, names.b)));

// Only the harness copy exposes a parent-level test helper; collector implementation remains exact production code.
fs.mkdirSync(path.join(dest, 'src/adapters/dameng'), { recursive: true });
const adapterCopy = path.join(dest, 'src/adapters/dameng.rs');
const adapterSource = fs.readFileSync(production('adapters/dameng.rs'), 'utf8')
  .replace(/(?:#\[path\s*=\s*"dameng\/ddl\.rs"\]\s*)?mod ddl;/, `#[path=${JSON.stringify(production('adapters/dameng/ddl.rs'))}] mod ddl;`)
  .replace(/#\[path\s*=\s*"dameng\/tests\.rs"\]/, `#[path=${JSON.stringify(production('adapters/dameng/tests.rs'))}]`);
assert(adapterSource.includes(production('adapters/dameng/ddl.rs')), 'DDL 子模块路径未映射');
fs.writeFileSync(adapterCopy, adapterSource + `
#[cfg(test)]pub async fn ddl_failure_probe(adapter:&DamengAdapter,owner:&str,meta:&crate::meta::TableMeta)->serde_json::Value{
let missing=ddl::read(adapter,owner,"QA_MISSING_MAIN",false,&[],&[],None).await;
assert!(missing.sql.is_none());assert!(!missing.warnings.is_empty());assert!(missing.warnings.join(" ").contains("未生成替代定义"));
let mut gone=meta.indexes.iter().find(|i|i.name=="QA_IX").unwrap().clone();gone.name="QA_MISSING_INDEX".into();
let partial=ddl::read(adapter,owner,"QA_PARENT",false,&[gone],&meta.columns,meta.comment.as_deref()).await;
assert!(partial.sql.as_ref().is_some_and(|s|s.contains("CREATE TABLE")&&!s.contains("QA_MISSING_INDEX")));assert!(partial.warnings.join(" ").contains("QA_MISSING_INDEX"));
serde_json::json!({"mainMissingWarnings":missing.warnings,"dependentMissingWarnings":partial.warnings})}
`);
fs.copyFileSync(production('adapters/dameng/ddl.rs'), path.join(dest, 'src/adapters/dameng/ddl.rs'));
const adapterMod = path.join(dest, 'src/adapters.rs');
fs.writeFileSync(adapterMod, fs.readFileSync(adapterMod, 'utf8').replace(JSON.stringify(production('adapters/dameng.rs')), JSON.stringify(adapterCopy.replace(/\\/g, '/'))));
write('acceptance.rs', String.raw`
use std::{sync::Arc,path::PathBuf,io::Cursor};use futures_util::FutureExt;
use crate::{adapters::{dameng::{DamengAdapter,ddl_failure_probe},ConnectionParams,DbAdapter,QueryContext,SqlParams},meta::{TableMeta,value::DbValue},error::{AppError,AppResult},services::dameng_script::{Script,Item}};
use sqlparser::{dialect::GenericDialect,tokenizer::{Token,Tokenizer}};
fn ident(s:&str)->String{format!("\"{}\"",s.replace('"',"\"\""))}
async fn scalar(a:&dyn DbAdapter,db:&str,sql:&str)->AppResult<i64>{let r=a.query_page(db,sql,0,100,&QueryContext::new()).await?;Ok(match &r.rows[0][0]{DbValue::Int(v)=>*v,DbValue::Decimal(v)=>v.parse().unwrap(),v=>panic!("unexpected {v:?}")})}
fn byte_offset(sql:&str,line:u64,column:u64)->usize{let(mut l,mut c)=(1,1);for(i,ch)in sql.char_indices(){if l==line&&c==column{return i;}if ch=='\n'{l+=1;c=1;}else{c+=1;}}assert_eq!((l,c),(line,column));sql.len()}
fn remap(sql:&str,owners:&[(String,String)])->String{let t=Tokenizer::new(&GenericDialect{},sql).tokenize_with_location().unwrap();let mut edits=vec![];for i in 0..t.len(){let next=t.iter().skip(i+1).find(|t|!matches!(t.token,Token::Whitespace(_)));if !next.is_some_and(|t|matches!(t.token,Token::Period)){continue;}if let Token::Word(w)=&t[i].token{if let Some((_,to))=owners.iter().find(|(from,_)|*from==w.value){let span=t[i].span;edits.push((byte_offset(sql,span.start.line,span.start.column),byte_offset(sql,span.end.line,span.end.column),ident(to)));}}}let mut output=sql.to_owned();for(start,end,value)in edits.into_iter().rev(){output.replace_range(start..end,&value);}output}
async fn replay(a:&dyn DbAdapter,db:&str,sql:&str)->AppResult<u64>{let mut r=Script::new(Cursor::new(sql.as_bytes()));let mut n=0;while let Some(item)=r.next()?{match item{Item::Sql(s)=>{a.execute_affected(db,&s.sql).await.map_err(|e|AppError::Database(format!("replay statement {} line {}: {e}",n+1,s.line)))?;n+=1;},Item::Client{..}=>panic!("DDL collector introduced a client directive")}}Ok(n)}
fn check_meta(source:&TableMeta,target:&TableMeta){assert_eq!(source.kind,target.kind);assert_eq!(source.primary_key,target.primary_key);assert_eq!(source.comment,target.comment);assert_eq!(source.columns.len(),target.columns.len());for(s,t)in source.columns.iter().zip(&target.columns){assert_eq!(s.name,t.name);assert_eq!(s.raw_type,t.raw_type);assert_eq!(s.nullable,t.nullable);assert_eq!(s.auto_increment,t.auto_increment);assert_eq!(s.comment,t.comment);}for name in ["QA_IX","QA_UIX","QA_EXPR"]{if source.indexes.iter().any(|i|i.name==name){assert!(target.indexes.iter().any(|i|i.name==name),"missing {name}");}}assert_eq!(source.foreign_keys.len(),target.foreign_keys.len());}
#[test]fn dm60_ddl_owner_remap_is_token_aware(){let sql="COMMENT ON TABLE \"S\".\"T\" IS '中文 ''引号''\r\nS.T'; -- S.T\r\nSELECT \"SYS\".\"DUAL\",\"S\"\"Q\".\"T\";";let output=remap(sql,&[("S".into(),"DST".into()),("S\"Q".into(),"DST\"Q".into())]);assert_eq!(output,"COMMENT ON TABLE \"DST\".\"T\" IS '中文 ''引号''\r\nS.T'; -- S.T\r\nSELECT \"SYS\".\"DUAL\",\"DST\"\"Q\".\"T\";");}
#[tokio::test]#[ignore="requires explicit local DM8 environment"]async fn dm60_ddl_real(){
let out=PathBuf::from(std::env::var("DBFOLIO_TEST_DM_OUTPUT").unwrap());let names:serde_json::Value=serde_json::from_str(&std::env::var("DBFOLIO_TEST_DM_NAMES").unwrap()).unwrap();let a=names["a"].as_str().unwrap().to_owned();let b=names["b"].as_str().unwrap().to_owned();let ta=names["ta"].as_str().unwrap().to_owned();let tb=names["tb"].as_str().unwrap().to_owned();for n in [&a,&b,&ta,&tb]{assert!(n.starts_with("DBFOLIO_DM60_"));assert!(n.chars().all(|c|c.is_ascii_alphanumeric()||c=='_'));}
let params:ConnectionParams=serde_json::from_value(serde_json::json!({"engine":"dameng","host":"127.0.0.1","port":std::env::var("DBFOLIO_TEST_DM_PORT").ok().and_then(|s|s.parse::<u16>().ok()).unwrap_or(15236),"username":"SYSDBA","password":std::env::var("DBFOLIO_TEST_DM_PASSWORD").unwrap(),"readOnly":false})).unwrap();let adapter=Arc::new(DamengAdapter::connect(&params).await.unwrap());let mut created=vec![];
let work=std::panic::AssertUnwindSafe(async{
for n in [&a,&b,&ta,&tb]{assert!(!adapter.list_databases().await?.iter().any(|d|d.name==*n));adapter.execute_affected("SYSDBA",&format!("CREATE SCHEMA {}",ident(n))).await?;created.push(n.clone());}
let fixture:serde_json::Value=serde_json::from_slice(&std::fs::read(out.join("fixture.json"))?).unwrap();for s in fixture["statements"].as_array().unwrap(){adapter.execute_affected("SYSDBA",s.as_str().unwrap()).await?;}
let mut snapshots=vec![];let owners=vec![(a.clone(),ta.clone()),(b.clone(),tb.clone())];let mut replayed=0;
for object in fixture["objects"].as_array().unwrap(){let owner=object["schema"].as_str().unwrap();let table=object["table"].as_str().unwrap();let source=adapter.introspect_table(owner,Some(owner),table).await?;assert!(source.ddl_warnings.is_empty(),"{} warnings {:?}",table,source.ddl_warnings);let ddl=source.raw_ddl.as_ref().unwrap();assert!(!ddl.is_empty());if table=="QA_PARENT"{assert!(ddl.contains("LOWER(\"TITLE\")"));assert!(ddl.contains("QA_IX")&&ddl.contains("QA_UIX"));assert_eq!(ddl.matches("CONSTRAINT \"QA_UQ\"").count(),1);assert_eq!(ddl.matches("CONSTRAINT \"QA_CK\"").count(),1);assert_eq!(source.comment.as_deref(),fixture["comment"].as_str());}if table=="QA_NO_INDEX"{assert!(!ddl.contains("CREATE OR REPLACE"));}
std::fs::write(out.join(format!("{table}.sql")),ddl)?;let mapped=remap(ddl,&owners);let target_owner=if owner==a{&ta}else{&tb};replayed+=replay(adapter.as_ref(),target_owner,&mapped).await?;let target=adapter.introspect_table(target_owner,Some(target_owner),table).await?;check_meta(&source,&target);assert!(target.ddl_warnings.is_empty(),"target {} warnings {:?}",table,target.ddl_warnings);snapshots.push(source);}
let p=format!("{}.\"QA_PARENT\"",ident(&ta));let c=format!("{}.\"QA_CHILD\"",ident(&tb));
adapter.execute_transaction(&ta,&[SqlParams{sql:format!("INSERT INTO {p}(CODE,ALT,TITLE,AMOUNT,STATE,BIN,BODY) VALUES(?,?,?,?,?,?,?)"),params:vec![DbValue::Text("C1".into()),DbValue::Text("A1".into()),DbValue::Text("T1".into()),DbValue::Decimal("1.25".into()),DbValue::Int(0),DbValue::Bytes(vec![0,127,128,255]),DbValue::Text("中文大文本".repeat(500))]}]).await?;
let id=scalar(adapter.as_ref(),&ta,&format!("SELECT ID FROM {p} WHERE CODE='C1'")).await?;assert_eq!(id,7);
for (label,sql) in [("named unique",format!("INSERT INTO {p}(CODE,ALT,TITLE,AMOUNT,STATE) VALUES('C1','A2','T2',1,0)")),("unnamed unique",format!("INSERT INTO {p}(CODE,ALT,TITLE,AMOUNT,STATE) VALUES('C2','A1','T2',1,0)")),("independent unique index",format!("INSERT INTO {p}(CODE,ALT,TITLE,AMOUNT,STATE) VALUES('C2','A2','T1',1,0)")),("unnamed check",format!("INSERT INTO {p}(CODE,ALT,TITLE,AMOUNT,STATE) VALUES('C2','A2','T2',-1,0)")),("named check",format!("INSERT INTO {p}(CODE,ALT,TITLE,AMOUNT,STATE) VALUES('C2','A2','T2',1,-1)"))]{assert!(adapter.execute_affected(&ta,&sql).await.is_err(),"{label} was not enforced");}
assert!(adapter.execute_affected(&tb,&format!("INSERT INTO {c} VALUES(1,-999)")).await.is_err());adapter.execute_affected(&tb,&format!("INSERT INTO {c} VALUES(1,{id})")).await?;assert!(adapter.execute_affected(&tb,&format!("INSERT INTO {c} VALUES(1,{id})")).await.is_err());adapter.execute_affected(&ta,&format!("DELETE FROM {p} WHERE ID={id}")).await?;assert_eq!(scalar(adapter.as_ref(),&tb,&format!("SELECT COUNT(*) FROM {c}")).await?,0);
let diagnostic=ddl_failure_probe(adapter.as_ref(),&a,&snapshots[0]).await;
Ok::<_,AppError>(serde_json::json!({"passed":true,"replayedStatements":replayed,"objects":snapshots.len(),"diagnostics":diagnostic,"cases":["native TABLE/VIEW and expression/ordinary/unique indexes","named and anonymous constraints without duplicates","Chinese quoted multiline comments and source schema literal preserved","cross-schema foreign keys both directions","identity seed/increment and BLOB/CLOB types","PK/UQ/CHECK/FK/cascade actually enforced","missing main/dependent native DDL produces diagnostics without fake fallback"]}))
}).catch_unwind().await;
let mut cleanup_errors=vec![];for n in [&tb,&ta,&b,&a]{if created.contains(n){if let Err(e)=adapter.execute_affected("SYSDBA",&format!("DROP SCHEMA {} CASCADE",ident(n))).await{cleanup_errors.push(format!("{n}: {e}"));}}}assert!(cleanup_errors.is_empty(),"cleanup failed {:?}",cleanup_errors);
match work{Ok(Ok(v))=>{std::fs::write(out.join("result.json"),serde_json::to_vec_pretty(&v).unwrap()).unwrap();println!("{}",v);},Ok(Err(e))=>panic!("{e}"),Err(e)=>std::panic::resume_unwind(e)}
}
`);
const summary = { manifest: path.join(dest, 'Cargo.toml'), output: out, names };
if (process.argv.includes('--prepare-only')) console.log(JSON.stringify(summary));
else {
  let password = process.env.DBFOLIO_TEST_DM_PASSWORD;
  if (!password) { const inspected = spawnSync('docker', ['inspect', 'platform-dm8'], { encoding: 'utf8', windowsHide: true }); assert.equal(inspected.status, 0, '需要运行中的 platform-dm8'); password = JSON.parse(inspected.stdout)[0].Config.Env.find(v => v.startsWith('SYSDBA_PWD='))?.slice('SYSDBA_PWD='.length); }
  assert(password, '未读取到本机测试容器凭据');
  const child = spawnSync('cargo', ['test', '--manifest-path', summary.manifest, '--offline', '--', '--include-ignored', '--test-threads=1', '--nocapture'], { stdio: 'inherit', windowsHide: true, env: { ...process.env, DBFOLIO_TEST_DM_PASSWORD: password, DBFOLIO_TEST_DM_NAMES: JSON.stringify(names), DBFOLIO_TEST_DM_OUTPUT: out } });
  if (child.error) throw child.error; process.exitCode = child.status ?? 1; console.log(JSON.stringify(summary));
}
