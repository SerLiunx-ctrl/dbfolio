# alpha.61 行复制、粘贴与复制 SQL 验收

日期：2026-11-17；版本：1.0.0-alpha.61。本轮功能说明见[复制与粘贴](../grid-clipboard.md)。

- 共享剪贴板测试通过：100 组 TSV 往返、引号/多行/空列、NULL/空串、大整数/Decimal/字节、深副本、过期剪贴板、单元格清理及写入竞争。脚本：scripts/check-row-clipboard.cjs。
- 四种引擎 SQL 单元测试通过：标识符、文本转义与 MySQL SQL_MODE 差异、整数/Decimal/BIT/二进制/JSON/时间、完整复合主键、重复和空主键、未知/重复结果列、自增/生成列、达梦原生 DDL 审查，以及不完整值拒绝。脚本：scripts/check-grid-row-sql.cjs。
- 真实 SQLite 3.49.1 内存执行生产生成的 SQL：4 行 INSERT、1 行复合主键 UPDATE，精确 int64、TEXT Decimal、NULL/空串、换行/Tab/引号/反斜杠/NUL/Unicode、BLOB/空 BLOB、生成列重算和自增 ID 分配均通过。SQLite NUMERIC 转 REAL 的自身精度限制单独记录，没有宣称任意精度往返。证据：.qa/grid61-row-sql-roundtrip.json。
- 数据网格四引擎真实组件交互通过：右键目标、空白菜单、追加、空表追加、NULL/空串与字节、普通主键编辑、整数/Decimal 覆盖、整批失败、INSERT/UPDATE 预览、只读保护和异步刷新拒绝；零立即写库。脚本：scripts/check-grid-clipboard-ui.cjs；证据：.qa/grid61-ui.json。
- 查询结果真实组件专项通过：右键目标与多选、空白处、隐藏和重排列、原样单元格、类型化行复制、目标表选择、只读复制、缺上下文与截断/剪贴板错误，无直接写库 IPC。脚本：scripts/check-result-grid-clipboard.cjs。
- 生成列生产元数据：MySQL/MariaDB 排除 DEFAULT_GENERATED 误判；PostgreSQL 通过 to_jsonb 兼容旧目录；SQLite xinfo hidden 2/3；序列化旧快照兼容。生产 Rust 片段验证与真实 SQLite 目录 SQL 通过，PG 目录表达式仅静态验证。达梦元数据未知保留缺省，不虚构目录标识。
- 原生预验收发现 SQLite substr 空 BLOB 变 NULL：原始 SELECT 返回 bytes 0x，表数据预览却为 NULL。修正服务端预览 SQL，真实 SQLite 执行生产 buildTableSelect 的结果与原始 NULL/空 BLOB/字节/空文本/含换行文本逐项一致；脚本 scripts/check-sqlite-empty-preview.cjs，证据 .qa/grid61-empty-preview.json。
- 单元格原文与多列 TSV 来源分开：修复双引号被剥掉、未闭合引号报错的问题。单元格带引号/Tab/换行按一个原值粘贴，SQL 复制单独清理类型化缓存；单元与实际网格交互通过。
- 无主键 TableDataPanel 新增预览仅包含 INSERT，原有行无法更新/删除；浅/深/OLED × 100/200% 六组菜单边界和滚动、稳定 SQL 预览及底部按钮检查通过，夹具初始化真实产品 palette，证据 .qa/grid61-boundaries.log。
- 本轮范围已交付：四引擎复制/SQL/粘贴专项、单元格原文与空 BLOB 回归、无主键新增和六组主题/缩放边界通过；最终正式 EXE 真实 SQLite 两次复制追加确认提交及 INSERT/UPDATE 复制通过，精确值、NULL/空串/空 BLOB/字节/新 ID/生成列均正确。正式双包 108 校验/106 ZIP/102 资源、真实启动与生产签名/篡改拒绝通过。 清理 .qa 临时缓存 0.347 GiB、构建残留 0.04 GiB，无跳过；target 4.91 GiB，C 盘剩余 262.08 GiB，.qa 0.083 GiB。隔离会话剩余 0，自有测试进程已退出；保留正式交付、脚本、日志、截图、JSON、配置及测试数据库。尚未提交/公开发布，完成数 5/39，下一规划 R09，既有待验收项不变。

## 最终正式程序证据

- 最终正式构建：.qa/grid61-build-final.log，release LTO 17m27，包含单元格原文和 SQLite 空 BLOB 修复；不复用早期中间包。
- 原生结果：.qa/alpha61-sqlite-native-1794884939041/result.json；真实系统剪贴板、未改写 IPC，独立 SQLite/新配置；两轮逐行新增后服务器 ID 为 3/4，Python 从磁盘核对 4 行原始值一致。
- 实际 EXE SHA256：ac8822cb3f8caaf3446e02e2fc156b08ab6e4a3bc444c3539bcf83021dccc8f7；与最终 portable 一致。SQL 复制未执行，测试会话已删除，真实用户配置和业务库未读取。
- 包结果：.qa/grid61-package-verification.json、grid61-package.log；NSIS 及便携目录真实 EXE 启动、102 资源一致、106 ZIP 文件与 108 项校验、生产签名与篡改拒绝通过。
- 收尾：.qa/cleanup-grid61-artifacts-result.json、grid61-disk.json。本轮仅在本地交付 alpha.61，在线公开索引仍为 alpha.60，未擅自发布。MySQL/MariaDB/PG/DM 本轮 SQL 复制按纯序列化与 UI 适配验证，未将其写为全部实库往返；完整安装覆盖升级和既有保留项不在本轮扩大认定。
