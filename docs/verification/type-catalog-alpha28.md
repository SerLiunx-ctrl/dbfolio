# 类型能力目录验收（alpha.28）

日期：2026-10-27。用户要求核对 MySQL/PG 版本与 PG 扩展适配，并为类型选项添加中文说明。

## 变更与原则

旧选择器主要依据固定数组。现由后端 `meta_column_types` 返回类型目录，包含 SQL 值、显示名称、中文说明、分类和参数能力；前端固定基础列表只作未核验降级。新增列、行内改列、新建表及旧字段编辑入口共用目录，结构/建表面板支持手动刷新。切库/重连清理旧结果，每个面板一次读取。

- MySQL：原生 JSON 5.7.8+、VECTOR 9.0+、时间小数秒 5.6.4+；MariaDB 单独识别 5.5.5 兼容前缀，JSON 10.2.7+、VECTOR 11.7.1+。预览阶段再次检查受限类型/参数。类型描述明确布尔别名、定点数、时间精度等差异。
- PG：当前数据库 pg_type / pg_namespace / pg_depend / pg_extension 的真实注册结果，并检查 Schema/类型 USAGE 权限。pgvector 类型取决于安装结果，扩展名称/版本来自服务器；枚举、域和范围等类型同样可发现。Schema、类型名分别引用，友好标签不作为 SQL 拼接来源。
- 已有声明保持，包括大小写、引号、别名和未识别声明；不存在于可用目录的当前声明明确保留，不转为 varchar。扩展移除或换到无扩展库时不继续推荐扩展类型。读取失败显示未核验并支持重试。

## 验证结果

| 环境/检查 | 结果 |
|---|---|
| 独立 PG18 / pgvector 0.8.5 | 类型发现、未安装数据库隔离、`vectors.qa` Schema、vector/halfvec/sparsevec(3) 建表/回读、扩展移除、枚举/域发现通过 |
| 独立 PG17 / pgvector 0.8.0 | 同一专项通过，验证目录依据实际注册类型而非假设插件最新版 |
| MySQL/MariaDB 版本规则 | JSON/VECTOR 边界、MariaDB 兼容版本前缀、时间精度及未知版本降级通过；未逐一实库执行 |
| 类型模型 | SQL 值/说明分离、限定名称/引号/括号、别名和当前声明保留通过 |
| 真实组件与实库导出目录联测 | 浅色/OLED、中文描述、非 public 向量维度/预览参数、跨库选项、四入口、移除扩展刷新、失败降级、无逐输入重复请求通过 |
| 三引擎回归 | 建表草稿、行内保存/废弃/失败保留/只读、完整属性与默认值联动、主题/缩放、设置/关于版本通过 |
| TypeScript / Rust | TypeScript 通过；Rust 163 通过、25 项外部测试默认忽略，其中 PG 类型专项已在上述两个隔离服务显式运行 |
| 正式双包 | `npm run app:build` 完成安装包、完整便携目录/ZIP 与两份独立校验清单；107 条 SHA256、105 个 ZIP 文件、101 个双包 web 资源、两个真实 EXE 启动/前端 IPC、更新签名及篡改拒绝通过，未执行完整安装升级 |

使用本机已有镜像建立独立容器、随机临时数据库和临时配置，不读取用户会话密码、不修改业务数据库。测试结束后容器已停止并自动删除。

界面专项 `scripts/check-type-catalog.cjs` 使用实库导出的目录：先显式设置隔离服务端口 `DBFOLIO_TEST_PG_PORT` 和仓库内目录 `DBFOLIO_TYPE_FIXTURE_DIR=<仓库>/.qa/alpha28-types`，运行 `cargo test --lib pg_types_ -- --ignored --nocapture` 生成目录，再在 Vite 1425 端口运行界面脚本。MySQL 示例目录由同一后端版本规则生成，不代表对应版本已做实库执行。

## 边界

只列出已注册且可用的类型，不主动安装扩展。数组、复合类型、复杂扩展类型修饰参数与向量索引专属选项仍通过 SQL 管理。PG 普通内置类型以实际目录存在性适配版本，但未逐一测试所有历史 PG 大版本；MySQL 兼容分支及厂商回移功能需要各自验证。可选择类型不代表任意值编辑/类型转换均已实现。

参考：[MySQL 5.7 新功能](https://docs.oracle.com/cd/E17952_01/mysql-5.7-en/mysql-nutshell.html)、[MySQL VECTOR](https://dev.mysql.com/doc/refman/9.0/en/vector.html)、[MariaDB 向量](https://mariadb.com/docs/server/reference/sql-structure/vectors/vector-overview)、[pgvector](https://github.com/pgvector/pgvector)、[PG 扩展依赖目录](https://www.postgresql.org/docs/current/catalog-pg-depend.html)。
