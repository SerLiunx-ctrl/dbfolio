# 列名与新增列注释修复验收

- 日期：2026-10-19
- 版本：1.0.0-alpha.11
- 状态：修复与正式双包交付完成；PostgreSQL 本轮实库验证受服务连接限制，详见下文；尚未提交。

## 问题与处理

1. 截图中的目标列名为 `index_progress `，末尾包含空格。行内编辑过去直接提交原文，MySQL 拒绝该列名。共享字段编辑组件现在在结束编辑时清理首尾空白，保存预览也执行相同规范化；内部空格保留。新增列沿用原有 trim，新建表草稿同时规范化列名及对应的索引/外键引用。后端对空名称、NUL、MySQL 尾部空格和超过 64 字符的名称提前返回中文错误，并对批量改名检查重复名称。
2. 新增列行之前没有注释输入控件，提交固定为 `comment: null`。MySQL/PostgreSQL 现在可在该行填写注释；SQLite 显示不支持列注释元数据，后端拒绝携带注释的 SQLite 添加请求，避免静默丢弃。
3. PostgreSQL 新增列过去未生成 `COMMENT ON COLUMN`。现在新增列与注释在同一事务执行，标识符与注释分别转义。
4. MySQL 实库回归还复现了特殊注释导致改名失败/反斜杠丢失的问题：SQL 解析器的 COMMENT 显示格式未转义，SHOW CREATE 与解析器对反斜杠解释也有差异。保留注释改为以元数据原文为准，单独转义序列化，并用解析后的列定义检查语义往返。
5. PostgreSQL/SQLite 新增行的“只能追加到末尾”说明原本放在窄键列中，会挤入注释列。改为悬浮说明，保持新增行各列对齐。

## 验证

### 后端

- `cargo test --lib`：140 项通过，15 项外部依赖测试默认跳过。
- 专项单元验证：尾部空格拒绝、MySQL 64 字符边界、改名保留原类型/默认值/注释、PostgreSQL 注释中的中文/引号/反斜杠/换行及标识符转义。
- 本机 MySQL 专项测试 `local_mysql_added_comment_and_rename`：通过。仅在随机 `dw_column_qa_` 测试库创建空表，新增带特殊字符注释的列、重命名、读取元数据核对，完成后清理。修复前失败测试遗留的空测试库也已核对并清理，无本轮临时库残留。
- PostgreSQL 实库测试尝试连接时收到 `os error 10061`（服务拒绝连接），尚未完成本轮实库验收。SQL 生成和界面验证通过，不将它记为实库通过。
- SQLite 原有行内编辑、重建/回滚/只读测试随完整 Rust 回归通过。

### 前端

- 正式构建中的 `npm run build` 通过。先前受限沙箱构建发生 Monaco 资源 realpath EPERM，改用正常权限的正式构建后通过。
- `node scripts/check-column-name-comment.cjs`：MySQL/PostgreSQL/SQLite、浅色/OLED、100%/200% 缩放通过；覆盖改名去首尾空白、预览负载、废弃、新增注释负载、只读、SQLite 能力提示、列数对齐、新建表的索引/自引用外键联动和草稿不被预览修改。
- `node scripts/check-create-table.cjs`：三引擎新建表、双击编辑、字段/索引/外键草稿、切换保留、关闭保护、失败保留、保存后转表详情和只读回归通过。
- UI 使用真实组件与模拟 IPC；实际 MySQL 执行由上面的专项 Rust 测试覆盖。截图 `.qa/column-comment-*.png` 已人工检查，注释输入框可见且中文未裁切，窄屏/高缩放使用表格横向滚动。

## 交付

正式构建：`npm run app:build`，产物目录 `release/1.0.0-alpha.11/`。构建成功，交付如下：

- `DBFolio_1.0.0-alpha.11_windows_x64_setup.exe`：11,419,502 字节。
- `DBFolio_1.0.0-alpha.11_windows_x64_portable/`：完整 EXE + 外置 web 目录。
- `DBFolio_1.0.0-alpha.11_windows_x64_portable.zip`：16,230,977 字节。
- 独立 `setup_SHA256SUMS.txt` / `portable_SHA256SUMS.txt` 共 107 条，逐项重新计算一致。
- ZIP 内 105 个文件逐项与便携目录 SHA256 一致，资源自检通过，源码六处和分发版本均为 1.0.0-alpha.11。
- 本轮未安装覆盖用户现有程序，未提交、推送或创建远程 Release。


## 参考

[MySQL 8.0 标识符规则](https://dev.mysql.com/doc/refman/8.0/en/identifiers.html)：数据库、表和列名不能以空格结尾。

## 提交归档

2026-10-20：本项实现与 alpha.10～alpha.14 的相关变更统一归档至 [05ac694](https://github.com/SerLiunx-ctrl/dbfolio/commit/05ac6942eb1587e6c1663c79b28ca79d14db1606)。本节补录提交，不覆盖前述历史验收和分发边界。
