# 关系型数据库标签页建表验收

版本：1.0.0-alpha.6；日期：2026-09-28。

## 功能

- MySQL / PostgreSQL / SQLite 从数据库菜单打开“新建表*”独立标签页。信息、结构、索引、外键、DDL 一致布局，首次保存前不显示数据页。
- 信息和字段编辑复用现有组件，默认紧凑文本、双击编辑；主键/可空/无符号/自动增长依引擎能力提供，长度/集合独立列。索引、外键行内暂存，引用列支持元数据下拉选择，自引用随表名生成。
- 保存统一提交完整定义；成功替换原页签并刷新对象列表，失败保留草稿。切换、关闭未保存保护、只读、废弃及保存并发保护复用现有机制。
- MySQL 新表默认选择 InnoDB，包含外键时仅接受 InnoDB，拒绝默认引擎不明或 MyISAM 等选择以防约束被忽略；单条 CREATE TABLE；SQLite / PostgreSQL 多条 DDL 在事务中执行。SQLite 不支持注释，PostgreSQL 不显示 MySQL 专有选项。

## 验证

- npm run build：TypeScript 与前端构建通过。
- cargo check --offline：通过。
- cargo test --offline --lib：127 通过，13 忽略（依赖外部数据库等服务）。
- create_draft_three_dialects_and_validation：三种方言建表、主键、自增、默认值、索引、外键、注释的 SQL 解析；重复字段、无效类型/规则、索引缺失列、SET NULL 与非空冲突、不适用自增、MySQL 非 InnoDB 外键等拒绝验证。
- create_draft_sqlite_roundtrip_and_atomic_failure：真实临时 SQLite 建表/自增/引号默认值/唯一索引/外键约束及 SET NULL 行为；索引名冲突导致建表事务完整回滚，重复建表不覆盖已有数据。
- scripts/check-create-table.cjs：隔离模拟 IPC，三引擎及浅色/深色/OLED；首次无弹窗/无数据页、双击编辑、属性联动及恢复默认值、索引唯一性、外键选择、字段改名/依赖删除保护、DDL 预览不写库、多草稿切换、关闭取消/废弃、失败保留、保存成功原页签转为表详情与只读通过。
- scripts/check-inline-engines.cjs：既有三引擎字段行编辑、暂存、预览、保存/废弃、菜单、只读与失败保留回归通过。
- 已查看建表列表截图：紧凑行高、类型颜色和操作横排正确。MySQL/PostgreSQL 本轮没有真实服务端执行验收，SQL 语法/语义仍受服务器版本、权限和对象约束影响。

## 边界

草稿仅驻留当前进程，退出前由未保存提示处理；不提供跨数据库创建、自定义表达式索引、分区或完整任意 DDL 编辑。服务端连接中断导致结果不确定时不自动重试，应刷新目标核对。未把 R21/R22 整项标为完成。

## 交付

正式 `npm run app:build`（LTO + NSIS）通过，产物位于 `release/1.0.0-alpha.6/`：安装包、完整 portable 目录、ZIP 及两份独立 SHA256SUMS，目录恰好五项。便携目录/ZIP 内 104 个清单文件摘要、两份 SHA256SUMS 全部条目通过；NSIS 110 个文件完整性检查通过，安装包与便携版/最终 dist 的 101 个 web 文件一致，EXE 仅有预期 Tauri 分发标记差异，解包安装版内置资源校验通过。代码尚未提交。
