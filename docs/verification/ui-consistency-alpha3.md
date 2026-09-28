# 跨引擎交互一致性检查（1.0.0-alpha.3）

日期：2026-09-28。用户反馈优先，未开始 R05，路线图仍完成 4/39。

## 原因与统一原则

此前结构页以 `engine === 'mysql'` 分成行内编辑与旧式弹窗两条渲染路径，SQLite/PostgreSQL 未同步到新交互。这是客户端适配遗漏，不能用数据库语法差异解释。

三种 SQL 引擎现在共用 `InlineColumnRow`、修改草稿和保存/废弃流程。默认显示文本，双击或 Enter 激活当前单元格；可空等布尔属性使用勾选框；保存先预览 SQL，失败保留草稿。后端负责语法差异，前端通过明确能力开关处理不适用属性。此规则已写入 AGENTS.md。

## 检查结果

本轮检查覆盖以下入口的代码与能力分支；自动交互验收集中在改动涉及的结构、元数据页。代码检查不等同于全部引擎、全部功能的真实服务器回归。

| 入口 | 结论与处理 |
|---|---|
| SQL 结构列表 | 修复：MySQL、PostgreSQL、SQLite 共用双击行内编辑、字段类型配色、长度/集合、保存/废弃、右键菜单；去掉旧编辑铅笔和弹窗入口 |
| 列新增与排序 | 修复：SQLite/PostgreSQL 菜单明确为「追加列」，避免上方/下方插入的误导；MySQL 保留指定位置，SQLite 支持事务重排，PostgreSQL 调整顺序禁用并说明 |
| SQLite 修改执行 | 改类型、默认值、可空性或顺序按原 CREATE TABLE 语法树重建；保留约束、索引、触发器、视图引用、生成列、STRICT/WITHOUT ROWID、可保留的 rowid、自增序列。独立连接事务及外键检查，失败回滚；改名/删列使用原生 ALTER |
| PostgreSQL 修改执行 | 补齐名称、类型、长度、默认值、可空、注释；批量原生 ALTER/COMMENT 在同一事务执行。无默认强制 USING 转换；服务器不接受的数据转换明确失败 |
| 表信息与选项 | 已共用紧凑表名、预览/废弃流程；注释按能力提供；存储引擎、字符集、行格式属于 MySQL 能力，不复制到不支持的数据库 |
| 索引、外键、DDL | 共用组件、字段配色、操作横排、预览确认；DDL 共用查询编辑器主题。SQLite 外键编辑仍需后续重建支持，现有界面说明限制 |
| SQL 表数据、筛选、查询、分析 | 共用网格/筛选/查询页/分析组件，默认行数、当前已加载值建议、保存预览等不另建 SQLite 版本；驱动差异位于 SQL/值适配层 |
| 对象浏览器 | 修复重复的 MySQL SQL 导入/数据库对象菜单项；关系型对象树共用渲染，Redis 键/MongoDB 集合保持相应模型 |
| MongoDB 文档、Redis 字符串 | 补上编辑区显式「废弃」按钮，与保存相邻，复用已有草稿基线；忙碌或写入结果不确定时仍按原保护规则禁用 |
| 连接与任务 | 五引擎共用会话安全选项与连接诊断；任务中心按后台作业用途分类，而非按引擎分类 |
| 传输、同步、生成 | CSV/表数据导出、同引擎 SQL 同步、规则生成等共用工作流；Redis/MongoDB 专属数据模型由适配器处理。完整 SQL 导入/导出、数据库对象管理当前仍为 MySQL 功能范围，不宣称已扩展到其他引擎 |

## 能力边界

- SQLite 不支持 UNSIGNED、ON UPDATE 列属性及原生列注释；前两列隐藏，注释显示不可编辑的原因。
- SQLite AUTOINCREMENT 仅支持普通表内联声明的单列 INTEGER 主键；未启用该关键字的 INTEGER 主键仍可能自动分配 rowid，界面不再把两者混为一谈。表级主键转 AUTOINCREMENT、生成列修改、解析器不支持的特殊 CREATE 语法均明确拒绝，需通过 SQL 管理。
- SQLite 更改类型可能触发类型亲和性转换；VARCHAR(n) 不等同于 MySQL 长度约束。STRICT 表仍由 SQLite 校验合法类型。外键检查发现既存违规数据也会阻止本次保存。
- PostgreSQL IDENTITY/序列属性、任意默认表达式及需要 USING 的类型转换仍通过 SQL 管理。不能调整原生列顺序。
- 本次完善的是结构页列编辑；SQLite **结构同步**中的自动重建、外键可视化修改、维护工具仍属 R22，不能据此把 R22 标记完成。PostgreSQL 深化仍属 R21。
- SQLite 重建依据官方推荐的事务重建步骤，结合依赖对象保留与外键检查：[SQLite ALTER TABLE](https://www.sqlite.org/lang_altertable.html)。

## 验证

- `cargo test --lib`：123 项通过、0 失败、13 项需要专用环境的集成测试默认跳过。包含 SQLite 真实文件数据库的约束、部分/表达式索引、触发器、视图、生成列、STRICT/WITHOUT ROWID、rowid、自增历史值、只读、外键失败及批量回滚；PostgreSQL SQL 解析/转义与未修改属性保留。
- `scripts/check-inline-engines.cjs`：三 SQL 引擎的默认文本、双击编辑、暂存、预览、保存、废弃、能力限制、菜单、只读及保存失败保留草稿。
- 原列菜单/索引加入、布尔属性暂存、三引擎三主题结构配色、元数据三主题与缩放回归全部通过；截图检查 SQLite OLED 下的紧凑行高与横排操作。
- `npm run build` 通过。
- 真实 PostgreSQL 专项已加入显式集成测试 `local_postgres_inline_acceptance`，只操作随机验收 schema；本机 127.0.0.1 服务拒绝连接（10061），本轮未完成真实 PostgreSQL 执行验收，也未创建测试 schema。不得将 SQL 生成/界面测试表述为服务器实测。
- `npm run app:build` 正式构建通过，交付目录 `release/1.0.0-alpha.3/` 包含安装包、完整 portable 目录、ZIP 及独立 setup/portable SHA256SUMS 共五项；内置资源校验、104 个目录/ZIP 文件摘要、NSIS 110 个资源完整性及两份清单全部通过。
- 代码提交 [830bec9](https://github.com/SerLiunx-ctrl/dbfolio/commit/830bec9d308f55f4dc13710ee1906c0ae85d8616)。
