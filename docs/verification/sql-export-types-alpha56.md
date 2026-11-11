# alpha.56 SQL 文件类型往返验收

日期：2026-11-10；版本：1.0.0-alpha.56；状态：本轮 SQL 范围已交付，未提交/发布。

## 复现与根因

- 用户确认问题格式为 SQL 文件。本轮只在本机 MySQL 的 `dbfolio_export56_` 独立测试库中写入，隔离配置只读复用本机 root 会话凭据，不修改业务数据库或真实配置，不输出密码，也不删除被复用的原会话凭据。
- alpha.55 正式 EXE 的 `export_sql → sql_import_preview → sql_import_execute` 真实往返复现 BIT：0/1/5 等生成 `X'0'` / `X'1'` / `X'5'`，导入在 INSERT 报 1064。HEX(BIT) 是未补齐的数字十六进制，X 字面量要求偶数位；普通字节 BLOB 不受同一问题影响。
- 扩大矩阵后复现 FLOAT 6 行中 4 行原值与导入值不等；零日期/default 严格模式导入报 1292；GEOMETRYCOLLECTION 因信息架构返回 `geomcollection` 别名漏分流，导出在错误的 UTF-8 转换上返回 NULL，导致整个文件失败。
- 旧版实际材料：`.qa/sql-export56-native-1.0.0-alpha.55-1794315639615/`、`.qa/sql-export56-native-1.0.0-alpha.55-1794315803222/`。它们是旧版失败复现记录，不作为修复通过证据。
- 既有 SQL 验收确实覆盖大整数、Decimal、大文本、二进制、微秒日期与生成列，但缺少 BIT、浮点、零日期、完整空间类型矩阵；生成片段断言和模拟 UI 不能代替这条实际回放。

## 修复与候选验证

- 仅调整 SQL 文件 MySQL 适配层：BIT 单独输出位字面量；FLOAT 提升后转文本；补空间集合别名；导出专属会话及脚本临时使用兼容日期模式，保留无关严格检查并恢复原设置。
- 生成值异常明确给出表、列、类型，保持临时文件发布保护；不转成 SQL NULL。
- MySQL 实库候选验证：FLOAT 六行零差异；NULL、空/非空几何集合和 SRID 0/4326 保留；TRADITIONAL 展开、零日期及 2012-02-31 等历史日期/default 往返零差异，SQL_MODE 恢复与初始值一致。材料 `.qa/sql-export56-native-1.0.0-alpha.55-1794316027389/candidate-expression-probes.json`。
- TypeScript 检查及 `cargo check --release --features custom-protocol --tests --locked` 通过；Rust 新增真实服务器回归为显式环境变量启用，本轮主要端到端证据使用正式 EXE，不把编译检查表述为执行了所有 Rust 测试。

## 正式包验收

- 本机 MySQL 8.4.6 正式 EXE 验收通过：12 张类型表、29 次导出、51 份 SQL 实际导入、73 次服务器逐列精确对账，数值/字节/NULL 差异均为 0；逐表结构+数据/仅数据、整库表数据、分文件与两种 ZIP 均通过。107 项 SHA256、105 ZIP 文件、101 资源、启动与生产签名/篡改拒绝通过。测试库剩余 0，原会话配置未变，App/WebView 已退出；清理临时缓存 0.276 GiB，无跳过项，target 5.61 GiB、C 盘剩余 257.31 GiB，.qa 约 70 MiB。尚未提交/发布；完成数 5/39，下一规划 R09，既有保留项不变。
- BIT覆盖1/3/7/8/9/12/16/32/63/64位，包含NULL/0/1/最高位/最大值/奇数nibble；另覆盖整数各宽度signed/unsigned极值和超2^53值、Decimal(65,30)、FLOAT/DOUBLE含极小值、CHAR/VARCHAR/TEXT各容量类型、utf8mb3/latin1、NUL/引号/反斜杠/尾空格、BINARY/VARBINARY/BLOB、DATE/DATETIME/TIMESTAMP/TIME/YEAR、零日期/历史非法日历值/default、JSON与数字ENUM/SET、全部基础空间类型/SRID0和4326/空集合、生成/隐藏列和自增id0。
- 最终唯一正式包证据：.qa/sql-export56-native-1.0.0-alpha.56-1794316939856/result.json；同目录process-verification.json证明无本轮残留App/WebView，sql-export-table-ui.png仅记录真实SQL工作区参数，未自动执行原生保存框。
- 构建/检查：.qa/export56-build.log、export56-cargo-check-final.log、export56-ts.log、export56-package.log；正式安装包、目录式portable、ZIP及各自校验清单位于release/1.0.0-alpha.56/，未发布在线索引。
- 清理：.qa/cleanup-export56-artifacts-result.json与export56-disk.json；复用清理模板的日期常量已按本轮执行日期校正，清理数值与路径记录未变。
- 新增脚本 scripts/check-sql-export-types-native.cjs 可复现旧版并以 --expect-fixed 验证修复版；本机凭据只读复用或从环境传入，禁止写入脚本。

## 验证边界与后续项

- 数值在服务器使用 NULL-safe 相等比较，文本与二进制比较 HEX，空间比较 WKB 与 SRID，同时独立比较 SQL NULL。不使用两侧共享预览解码器或已舍入显示值来证明相等。
- MySQL 与 MariaDB 的未安装版本、向量/厂商扩展及特殊兼容模式不据此宣称通过；MariaDB 兼容组展开的 NO_FIELD_OPTIONS/NO_KEY_OPTIONS/NO_TABLE_OPTIONS 需另行验证完整 DDL 保留。
- 静态审查另发现非 SQL 的 CSV/JSON/XLSX 导出路径使用截断预览，以及 XLSX 大整数转 f64 的独立缺陷；本轮用户已明确 SQL 文件，保留为后续专项，不声称本轮覆盖或修复其他格式。
- PostgreSQL/SQLite 目前没有完整 SQL dump 适配；本轮未新增该能力，既有 PG 实库保留安排不变。完成数仍为 5/39，下一规划 R09。
