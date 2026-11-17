// 使用正式构建缓存直接编译生产元数据、参数构造及 MySQL 值解析；不连接数据库、不重复构建整套依赖。
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), assert = require('node:assert/strict');
const root = process.cwd(), dest = path.join(root, '.qa/mysql62-value-unit'), deps = path.join(root, 'src-tauri/target/release/deps');
fs.mkdirSync(dest, { recursive: true });
const read = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const rustPath = file => JSON.stringify(path.join(root, file).replace(/\\/g, '/'));
const section = (source, start, end) => { const from = source.indexOf(start), to = source.indexOf(end, from); assert(from >= 0 && to > from, start); return source.slice(from, to); };
const common = read('src-tauri/src/adapters/mod.rs'), mysql = read('src-tauri/src/adapters/mysql.rs');
const model = section(common, '#[derive(Debug, Clone)]\npub struct SqlParams', '#[async_trait]\npub trait DbAdapter');
assert(common.includes('fn escape_string('));
const sql = common.slice(common.indexOf('fn escape_string('));
const values = section(mysql, 'pub(crate) fn decode_cell(', '#[async_trait]\nimpl DbAdapter');
const mysqlTests = section(mysql, '#[cfg(test)]\nmod statistic_tests', '\nstruct ManualTx');
const mysqlImplementation = `use super::*;use chrono::{NaiveDate,NaiveDateTime};use sqlx::{Row,Column,MySql};use sqlx::mysql::MySqlRow;use sqlx::types::BigDecimal;use sqlx::mysql::types::{MySqlTime,MySqlTimeSign};use std::str::FromStr;use crate::meta::value::{preview_bytes,preview_json,preview_text};
pub struct MySqlAdapter;impl MySqlAdapter {pub(crate) fn for_sql_tests()->Self{Self}}
impl DbAdapter for MySqlAdapter {fn engine(&self)->Engine{Engine::Mysql}fn quote_ident(&self,name:&str)->String{format!("\u{0060}{}\u{0060}",name.replace('\u{0060}',"\u{0060}\u{0060}"))}fn placeholder(&self,_:usize)->String{"?".into()}fn null_safe_eq(&self,c:&str,p:&str)->String{format!("{c} <=> {p}")}}
${section(mysql, 'fn is_generated_column(', '\nfn map_ssl_mode(')}
${section(mysql, 'fn statistic_u64(', '\nfn u64_opt(')}
${values}\n${mysqlTests}`;
// ColumnInfo/QueryOutcome 是值解析结果容器；字段与生产定义保持一致。
const outcomes = section(common, '#[derive(Debug, Clone, Serialize)]\n#[serde(rename_all = "camelCase")]\npub struct ColumnInfo', '/// 查询取消上下文');
const meta = read('src-tauri/src/meta/mod.rs').replace('pub mod value;', `#[path=${rustPath('src-tauri/src/meta/value.rs')}]pub mod value;`).replace('pub mod data_types;', `#[path=${rustPath('src-tauri/src/meta/data_types.rs')}]pub mod data_types;`);
// release 缓存使用 panic=abort；将现有测试函数作为普通断言运行，避免重编 unwind 缓存。
const exposeTests = source => source.replace(/#\[test\]/g, '').replace(/\bmod (\w+) \{/g, 'pub mod $1 {').replace(/^(\s*)fn (\w+)\(\)/gm, '$1pub fn $2()');
const cases = ['meta::tests::generated_column_metadata_is_optional_and_preserves_false','meta::tests::auto_increment_metadata_preserves_exact_decimal_string','meta::tests::mysql_types','meta::tests::postgres_types','meta::tests::sqlite_types','adapters::mysql_value::tests::bit_accepts_exact_unsigned_values_and_legacy_binary','adapters::mysql_value::tests::bit_rejects_out_of_range_and_ambiguous_values','adapters::mysql_value::tests::year_uses_full_years_without_server_coercion','adapters::mysql_bit_write_tests::mysql_bit_parameters_are_numeric_in_every_write_position','adapters::mysql_bit_write_tests::mysql_bit_rejects_invalid_set_old_key_and_direct_values','adapters::mysql_bit_write_tests::mysql_json_parameters_use_json_comparison_without_changing_text','adapters::mysql::statistic_tests::mysql_time_preserves_intervals_and_microseconds','adapters::mysql::statistic_tests::generated_columns_do_not_include_expression_defaults','adapters::mysql::statistic_tests::decimal_statistics_support_scaled_and_large_integers','adapters::render_tests::values_are_not_placeholders','adapters::readonly_guard_tests::readonly_values_cannot_be_submitted'];
const source = exposeTests(`#![allow(dead_code)]
use serde::{Serialize,Deserialize};
mod error {#[derive(Debug)]pub enum AppError{InvalidInput(String),ReadOnly(String)}pub type AppResult<T>=Result<T,AppError>;}
mod meta {${meta}}
mod adapters {use super::*;use crate::error::{AppError,AppResult};use crate::meta::{Engine,value::DbValue};
mod mysql_value {${read('src-tauri/src/adapters/mysql_value.rs')}}
${model}\n${outcomes}
trait DbAdapter{fn engine(&self)->Engine;fn quote_ident(&self,name:&str)->String;fn placeholder(&self,index:usize)->String;fn null_safe_eq(&self,column:&str,placeholder:&str)->String;}
mod mysql {${mysqlImplementation}}\n${sql}}
`) + '\nfn main(){' + cases.map(name => `${name}();println!("PASS ${name}");`).join('\n') + '}';
const sourcePath = path.join(dest, 'actual.rs'), executable = path.join(dest, 'actual.exe'); fs.writeFileSync(sourcePath, source);
const libraries = name => fs.readdirSync(deps).filter(file => file.startsWith('lib' + name + '-') && file.endsWith('.rlib'));
const names = ['serde', 'serde_json', 'sqlx', 'chrono'];
const choices = names.map(libraries); assert(choices.every(list => list.length), '请先运行一次正式 app:build，提供可复用的依赖缓存');
let compiled = false, lastError = '';
// 已有缓存可能同时保留 build-script 与 app 的依赖特征组合，选择可一致链接的一组。
function* combinations(index = 0, picked = []) { if (index === choices.length) { yield picked; return; } for (const item of choices[index]) yield* combinations(index + 1, [...picked, item]); }
for (const files of combinations()) {
 const args = ['--edition=2021', '--cfg', 'test', '-C', 'panic=abort', sourcePath, '-L', 'dependency=' + deps, '-o', executable, ...names.flatMap((name, index) => ['--extern', name + '=' + path.join(deps, files[index])])];
 const result = cp.spawnSync('rustc', args, { encoding: 'utf8', windowsHide: true }); if (result.error) throw result.error;
 if (result.status === 0) { compiled = true; break; } lastError = result.stderr;
 if (!/E0460|E0463|multiple versions|different versions|trait bound.*Serialize|trait bound.*Deserialize|E0308/.test(lastError)) break;
}
assert(compiled, lastError);
const result = cp.spawnSync(executable, ['--nocapture'], { encoding: 'utf8', windowsHide: true }); if (result.error) throw result.error;
fs.writeFileSync(path.join(dest, 'result.txt'), result.stdout + result.stderr); process.stdout.write(result.stdout); process.stderr.write(result.stderr); assert.equal(result.status, 0);
