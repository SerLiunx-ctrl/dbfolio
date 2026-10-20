# 受限 MySQL 迁移脚本验收

版本：1.0.0-alpha.14；日期：2026-10-20。

## 问题与修复

查询页将选中的多条 SQL 直接交给单句数据库范围检查，因而显示“不能通过多语句切换数据库”，即使脚本没有 USE。逐条手动执行也不能解决：SET/PREPARE/EXECUTE 在受限会话被拒绝，普通查询连接池也不能保证变量和准备语句跨请求共享连接。

新增独立连接的查询脚本执行通道。先拆句并整体预检，再逐条顺序执行；不关闭数据库白名单，也不直接把动态字符串交给服务器执行。原有低层单句入口保持严格限制，报错改为提示在查询页选中完整脚本执行。

## 使用方式与支持范围

在 MySQL 查询页选中完整的 SET、PREPARE、EXECUTE、DEALLOCATE 段落，使用 Ctrl+Enter、“执行当前语句”（有选区时执行选区）或右键“执行选中 SQL”。未选中时仍执行光标所在的一条语句。手动事务需先结束，不在事务中运行此迁移脚本。

支持如下模式（字段和 SQL 内容仅为示例，不由验收脚本修改业务表）：

```sql
SET @ddl = IF(
  EXISTS(SELECT 1 FROM information_schema.columns
         WHERE table_schema = DATABASE()
           AND table_name = 'knowledge_base'
           AND column_name = 'chunk_count'),
  'SELECT 1',
  'ALTER TABLE knowledge_base ADD COLUMN chunk_count BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT ''供应商切片总数'''
);
PREPARE migration_stmt FROM @ddl;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;
```

- 动态源支持单引号固定 SQL 字符串，以及上述 IF/EXISTS 模式；元数据表支持 columns、statistics、tables。
- 元数据条件必须由 AND 连接等值条件，包含当前数据库的 table_schema（DATABASE() 或当前库字面量）和 table_name；可按元数据表添加 column_name 或 index_name。
- 包装语句在受限解释器内处理，元数据探测使用固定 SQL 和绑定参数；用户提供的任意表达式不在服务器上求值。IF 两个分支均检查数据库范围、只读和危险操作，不因当前分支未选中而放过跨库 SQL。PREPARE 保存当时变量值的快照，DEALLOCATE 释放脚本内准备状态。
- 最多 16 MiB/1000 条语句；固定选中的数据库。变量和准备状态只在本次整段执行中有效。
- 不支持 CONCAT/任意函数拼接、EXECUTE USING、PREPARE FROM 直接字面量、通用会话变量读写、系统变量、USE、显式事务控制、存储程序定义及特殊 SQL_MODE（ANSI_QUOTES/NO_BACKSLASH_ESCAPES）。不放宽原有 SQL 文件导入的范围校验。
- PostgreSQL/SQLite 保持已有单语句及手动事务能力；本轮仅补充 MySQL 迁移模式，不把 R13 批量脚本增强整体标记完成。

## 执行与结果语义

预检发现脚本结构/范围/只读限制问题时整段未执行；高风险 SQL 沿用现有危险操作确认。不能完整解析的实际 SQL 也需确认，不承诺强制确认后的脚本一定不会在服务器上遇到语法或约束错误。

执行失败报告第几条、原始起始行和后续停止位置。此前已完成的写入与 DDL 不会自动回滚，不自动重试。取消既尝试中断当前服务器查询，也设置显式取消标记，在语句前后检查，避免 MySQL SLEEP 被中断后返回成功值而继续执行。超时停止等待时需要核对服务器结果。

完成后显示已处理条数，保留末条实际 SQL 的有限结果（最多当前查询页大小，上限 5000 行）和累计影响行数。控制语句不覆盖上一个实际 SQL 结果。脚本结果不允许分页、服务端排序及按原 SQL 重新查询式导出；复制和快照绘图可用，绘图不携带迁移 SQL，避免重放写入。重新执行普通查询后恢复普通分页能力。

## 验证结果

- `npm run build`：通过，正式构建再次执行类型检查及前端构建。
- `cargo test --lib`：146 通过、0 失败、16 个外部服务用例默认忽略。
- `query_script::tests::migration_preflight`：通过。普通多语句、引号内分号、固定字符串、IF 元数据条件、索引探测与其他引擎原路径。
- `query_script::tests::blocks_scope_bypasses_and_unsupported_expressions`：通过。跨库分支、未选中分支、嵌套多语句、缺少当前库条件、OR/函数探测、系统变量、未知准备语句、只读和危险操作预检。
- 显式运行 `mysql_migration_real --ignored`：通过。在随机 `dbfolio_script_*` 数据库创建隔离表，连续执行两次同类列/时间字段/索引迁移，确认不重复创建；验证中途失败、限行后继续执行、累计影响行数、同一连接 ID、变量隔离和取消阻止后续 DDL。测试结束清理随机数据库，未修改用户业务库。
- `scripts/check-query-script.cjs`：通过。实际 QueryWorkspace + Monaco、模拟 IPC；完整选区一次发送、完成条数、排序/分页/导出不重放、原始错误显示和普通查询恢复。
- 前端截图：`.qa/query-script-result.png`（本地验收材料，不作为发布资源）。

## 正式交付

`npm run app:build` 已完成正式 LTO 与 NSIS 构建，EXE 外置资源自检通过；两份 SHA256SUMS 共 107 条校验通过，ZIP 内 105 个文件与完整 portable 目录匹配。五份版本源文件、前端资源清单和 distribution.json 均为 1.0.0-alpha.14。

产物位于 `release/1.0.0-alpha.14/`：

- `DBFolio_1.0.0-alpha.14_windows_x64_setup.exe`，11446880 字节。
- `DBFolio_1.0.0-alpha.14_windows_x64_portable/`，包含 EXE、web/ 和配套资源。
- `DBFolio_1.0.0-alpha.14_windows_x64_portable.zip`，16269238 字节。
- `DBFolio_1.0.0-alpha.14_windows_x64_setup_SHA256SUMS.txt`。
- `DBFolio_1.0.0-alpha.14_windows_x64_portable_SHA256SUMS.txt`。

安装包 SHA256：`64f95489720f72d651716053289eb751063f6cc01b9d32c573a503a81e3fae24`。

便携 ZIP SHA256：`92103f090aefa4b1de284591b6ffd1fd501ef9029db9864e145aa141c2affb94`。

实现提交：[05ac694](https://github.com/SerLiunx-ctrl/dbfolio/commit/05ac6942eb1587e6c1663c79b28ca79d14db1606)，远程推送随本次汇总完成。

## 提交归档

2026-10-20：本项实现与 alpha.10～alpha.14 的相关变更统一归档至 [05ac694](https://github.com/SerLiunx-ctrl/dbfolio/commit/05ac6942eb1587e6c1663c79b28ca79d14db1606)。本节补录提交，不覆盖前述历史验收和分发边界。

## 提交前重打包（2026-10-20）

统一发布版本常量后再次执行 `npm run app:build`，前端与正式 Rust LTO、NSIS 构建成功。替换原 portable 目录时，用户正在运行其中的 DBFolio.exe，导致原打包脚本清理部分资源后失败；已从此前校验通过的 ZIP 恢复缺失资源，原目录两份清单 107 条和 ZIP 105 个文件重新核验一致，保留运行中的会话。

使用本次正式构建输出组装独立 `rebuilt` 版本，避免覆盖运行目录。EXE 资源自检、两份校验清单 107 条及 ZIP 105 个文件匹配全部通过。原分发包保留，最新重打包产物为：

- `DBFolio_1.0.0-alpha.14_windows_x64_setup-rebuilt.exe`，11449124 字节。
- `DBFolio_1.0.0-alpha.14_windows_x64_portable-rebuilt/`。
- `DBFolio_1.0.0-alpha.14_windows_x64_portable-rebuilt.zip`，16624854 字节。
- `DBFolio_1.0.0-alpha.14_windows_x64_setup-rebuilt_SHA256SUMS.txt`。
- `DBFolio_1.0.0-alpha.14_windows_x64_portable-rebuilt_SHA256SUMS.txt`。

安装包 SHA256：`873bf24281abddfa4a5bfcb05e9f53d670c970fb3b372faad019bd0f57e3d1b9`。

便携 ZIP SHA256：`b318689eb255e194c192fdc27d71effe0a14db9a0d7c767f737c2a6930ee2471`。

本次未修改打包脚本遇到占用目录时的清理行为；后续覆盖同名便携目录前需先退出其中的程序。代码归档于 [05ac694](https://github.com/SerLiunx-ctrl/dbfolio/commit/05ac6942eb1587e6c1663c79b28ca79d14db1606)。
