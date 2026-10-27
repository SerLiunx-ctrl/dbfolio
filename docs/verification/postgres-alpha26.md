# PostgreSQL 结构兼容验收（alpha.26）

日期：2026-10-27。范围按用户反馈限定为建表、字段修改、索引和外键；不是 R21 全量深化验收。

## 环境与数据隔离

- 使用本机已有镜像启动独立 PostgreSQL 16 和 18 服务，分别仅绑定 127.0.0.1:55427 / 55426。
- 测试显式要求 `DBFOLIO_TEST_PG_PORT`，会话配置使用临时目录，每项实库测试创建随机 Schema；包含带点的 Schema 名以验证独立标识符引用。服务没有挂载现有数据库目录，验收后停止并删除临时容器。
- 不读取用户已保存会话的密码，不修改现有 PostgreSQL 服务或业务表。

## 发现与修复

| 问题 | 证据及处理 |
|---|---|
| 编辑索引、添加/修改外键请求参数不匹配 | 基线使用真实前端 camelCase JSON 输入，反序列化要求 `old_name` / `ref_table` 而失败；修复 `DdlSpec` 字段命名，旧 snake_case 通过别名兼容，补充往返契约测试 |
| 外键目标 Schema 丢失 | 旧接口无 refSchema，界面以表名作唯一键；现用 Schema+表名选择，完整传递引用 Schema 并分别引用，引用列联动且拒绝过期响应 |
| 字段改名忽略大小写 | 基线中 `Code`、`code` 共存后将 `Code` 改为 `CODE` 被错误拒绝；现按 PostgreSQL 引号名称语义比较，建表的索引/外键名称同步修正 |
| 索引方法、方向和 INCLUDE 混淆 | 基线读取的 method 为空、desc 恒为 false；现读取 pg_am、indoption 和 pg_get_indexdef，以 indnkeyatts 区分键列，展示 DDL 保留原定义 |
| 特殊索引可能被简化重建 | 条件、表达式、INCLUDE、约束、非默认方法/排序/操作符类等不进入简易编辑；前端和后端双重限制，并保留 SQL 入口 |
| 替换索引/外键缺少回滚 | 旧执行路径逐条执行“删/建”；现 PostgreSQL 结构变更统一事务。通过真实的成功替换和故意失败的新定义，确认原索引/外键仍存在 |

## 已通过验证

- PostgreSQL 16 和 18：各 6 项专项测试通过，源文件 `src-tauri/src/services/postgres_compat_tests.rs`。包含 IDENTITY 建表、字段名大小写/类型/注释/默认值、索引名大小写、跨 Schema 外键、成功更新及失败回滚、真实索引元数据与复杂定义保护；新增列覆盖 numeric(18,6)、boolean、timestamp(3) with time zone、jsonb、uuid、空字符串默认值与注释。
- `cargo test --lib`：162 通过，24 项依赖外部服务/特殊环境的测试默认忽略；其中 6 项 PG 专项已在上述两个隔离服务另外显式执行。
- TypeScript 检查通过。
- `scripts/check-postgres-compat.cjs`：浅色/OLED 的同名不同 Schema 引用、引用列清空/重新加载/异步响应、已有外键 Schema 保留、复杂索引禁用简易编辑及原始 DDL；MySQL 不支持的 SET DEFAULT 隐藏，通过。
- 既有三引擎建表草稿、行内字段修改、完整属性和默认值联动、失败保留/废弃/只读、主题/缩放与设置/关于版本显示回归通过。
- 正式 `npm run app:build` 完成：NSIS 安装包、完整便携目录/ZIP 与两份独立 SHA256 清单位于 `release/1.0.0-alpha.26/`；107 条校验、105 个 ZIP 文件、101 个双包 web 资源一致性通过。便携版与 NSIS 解包 EXE 的真实启动/可见窗口/前端 IPC、更新签名与篡改拒绝通过，未执行完整安装升级。

## 保留边界

- 已有列 IDENTITY/序列变更、任意默认表达式、复杂索引编辑以及需要 USING 的类型转换仍通过 SQL 管理，不自动强制转换业务数据。
- PostgreSQL 整表 DDL 仍是统一元数据重建；本次保留索引原定义不代表已完整克隆 CHECK、分区、全部生成属性等原生特性。
- 本轮未覆盖其他 PostgreSQL 大版本、扩展与所有特权角色；数据网格写入/备份/同步的完整深化不在本轮验收范围。
- R06 完整跨版本安装升级、R21 全量能力均未标记完成；公开预览通道不变。

参考：[PostgreSQL pg_index](https://www.postgresql.org/docs/current/catalog-pg-index.html) 对键列数和属性标志的定义；[ALTER TABLE](https://www.postgresql.org/docs/current/sql-altertable.html) 对类型转换及显式 USING 的说明。
