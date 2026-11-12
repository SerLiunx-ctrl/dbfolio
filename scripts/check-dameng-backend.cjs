// 直接编译生产达梦适配器及元数据/DDL 模块，避免为专项验证重复构建整套桌面依赖。
const fs=require('node:fs'),path=require('node:path');
const root=process.cwd(),dest=path.join(root,'.qa/dm58-backend-check');fs.mkdirSync(dest+'/src/services',{recursive:true});
const read=p=>fs.readFileSync(p,'utf8').replace(/\r\n/g,'\n'),write=(p,s)=>fs.writeFileSync(dest+'/src/'+p,s);
fs.writeFileSync(dest+'/Cargo.toml',`[package]\nname="dbfolio-dm58-check"\nversion="0.1.0"\nedition="2021"\n[dependencies]\nasync-trait="0.1"\nthiserror="2"\nserde={version="1",features=["derive"]}\nserde_json="1"\ntokio={version="1",features=["rt-multi-thread","macros","time","sync"]}\ndm-rust={version="=0.1.1",features=["pool"]}\nchrono="0.4"\nsqlparser="0.59"\nuuid={version="1",features=["v4"]}\n[profile.dev]\ndebug=0\nincremental=false\n`);
let a=read('src-tauri/src/adapters/mod.rs');a=a.slice(a.indexOf('use async_trait'),a.indexOf('pub async fn connect('))+a.slice(a.indexOf('pub fn connect_timeout'),a.indexOf('#[cfg(test)]'));
a=a.replace(/    async fn mysql_connection[\s\S]*?\n    }\n/,'');
write('adapters.rs',`pub mod message_queue {pub struct MessageQueueAdapter;}\n#[path="${root.replace(/\\/g,'/')}/src-tauri/src/adapters/dameng.rs"] pub mod dameng;\n`+a);
write('error.rs',read('src-tauri/src/error.rs').split('impl From<sqlx::Error>')[0]);
for(const p of ['connection_config','column_edit','create_table','dameng_schema'])write('services/'+p+'.rs',read('src-tauri/src/services/'+p+'.rs').split('#[cfg(test)]')[0]);
let ddl=read('src-tauri/src/services/ddl.rs');write('services/ddl.rs','use serde::{Serialize,Deserialize};\n'+ddl.slice(ddl.indexOf('#[derive(Debug'),ddl.indexOf('fn option_word'))+'\n#[derive(Clone,Debug,Serialize,Deserialize)]\n#[serde(rename_all="camelCase")]\n'+ddl.match(/pub struct ColumnFlags \{[^\n]+/)[0]+'\npub struct DdlSpec;\n');
write('services/mod.rs',`pub mod connection_config;pub mod ddl;pub mod column_edit;pub mod create_table;pub mod dameng_schema;\npub mod sql_export {pub struct SqlExportRequest;pub struct SqlExportResult;}\npub mod manual_transaction {use crate::{adapters::{QueryContext,QueryOutcome},error::AppResult};#[async_trait::async_trait] pub trait ManualTransaction:Send {async fn run(&mut self,sql:&str,rows:bool,ctx:&QueryContext)->AppResult<QueryOutcome>;async fn finish(self:Box<Self>,commit:bool)->AppResult<()>;}}\n`);
write('lib.rs',`#![allow(dead_code)]\n#[path="${root.replace(/\\/g,'/')}/src-tauri/src/meta/mod.rs"]pub mod meta;\npub mod adapters;pub mod services;pub mod error;\n`);

const {spawnSync}=require("node:child_process");
const args=["test","--manifest-path",path.join(dest,"Cargo.toml"),"--offline","--",...(process.env.DBFOLIO_TEST_DM_PASSWORD?["--include-ignored"]:[]),"--nocapture"];
const result=spawnSync("cargo",args,{stdio:"inherit",windowsHide:true});if(result.error)throw result.error;process.exitCode=result.status??1;
