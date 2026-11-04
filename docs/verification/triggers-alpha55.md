# alpha.55 独立触发器管理验收

日期：2026-11-04；版本：1.0.0-alpha.55；状态：本轮实现与可用环境验收已交付，PG/MariaDB 实库待补，尚未提交或发布。

## 实现范围

- 表页、数据库/表右键、工作区页签使用闪电图标，打开独立触发器页。旧 MySQL 对象管理中的触发器入口也进入同一工作区。
- 按会话、数据库、表及 schema 去重与恢复；全库/单表列表、搜索、可调列宽、SQL 高亮定义、复制及查询打开。
- 结构化新增、受支持定义编辑、删除、SQL 预览确认、Ctrl+S 和统一保存/废弃保护。只读/库范围/生产写入确认沿用统一规则。
- MySQL/MariaDB 单事件行触发器、SQLite 普通表与视图触发器、PostgreSQL 多事件/执行粒度/已有无参 trigger 函数选择。复杂定义保留原属性，仅查看、复制或确认删除。
- 执行前乐观核对原定义；PostgreSQL/SQLite 事务替换，MySQL/MariaDB 非原子替换并在失败后尝试恢复，结果不确定时需刷新核对。原定义核对不等于锁住其他客户端。

## 已通过的组件与服务验证

- `npx tsc --noEmit` 与 `cargo check --release --features custom-protocol --locked` 通过。
- `scripts/check-triggers.cjs`：MySQL/PostgreSQL/SQLite × light/dark/OLED × 1x/2x，共 18 组；列表/搜索/SQL 高亮/列宽、新增联动、Ctrl+S/预览确认、废弃/删除，以及只读、受限、空态、失败保留重试、PG 函数模板与单表范围通过。
- 新增边界专项 11 项通过：StrictMode 首载、定义请求中禁止切换/关闭、残缺草稿废弃、取消慢预览后旧响应隔离、范围去重、工作区恢复类型/引擎/数据库权限验证等。
- 审查发现的 StrictMode 首载空列表、已取消旧预览覆盖新 SQL 两处已修复并复测；公共 SQL 预览弹窗丢弃已失效请求的成功/失败/结束回调。
- 窄模型 crate 7 项通过；生产服务窄 crate 9 项通过（含模型测试，实际 sqlx SQLite 连接，既有 AppState/helper 边界为 stub）。生成 SQL 另经 Node SQLite 执行验证 6 类行为；不把 stub 验收当作正式 EXE 实库验收。
- 目视深浅色截图无按钮贴合、文本裁切；证据 `.qa/triggers-ui-result.json`、`.qa/triggers-boundary-result.json`、`.qa/triggers55-service-test.log`、`.qa/triggers55-model-sqlite-result.json` 及 `.qa/triggers-*-light.png` / `dark.png`。

## 正式 EXE、交付与清理

- `scripts/check-triggers-native.cjs` 使用正式 alpha.55 EXE，31 项检查通过：SQLite 创建/编辑/删除及实际触发、中文标识符、失败回滚、乐观校验、复杂定义只读、视图 INSTEAD OF 与虚拟/影子表排除；MySQL 8.4.6 专属库创建/编辑/删除和实际触发、失败保旧、DEFINER 保留、只读/白名单与多触发器顺序保护。
- 真实 SQLite 界面通过：表工具栏闪电图标 → 独立触发器页 → 表单及 Monaco 输入 → SQL 预览与明确确认 → 保存/高亮定义 → 实际触发 → UI 删除。MySQL 专属测试库已删除、隔离 App/WebView 已关闭；真实配置只读复用，未修改原会话或凭据。
- 原生结果：`.qa/triggers55-native-1793764077830/result.json`；同目录 `sqlite-ui-create-preview.png`、`sqlite-ui-definition.png`、`sqlite-ui-deleted.png`。早期测试输入定位到 Monaco native EditContext 后修正脚本，未为测试更改产品编辑器。
- `npm run app:build` 通过：NSIS 安装包、完整便携目录、ZIP 和独立校验清单位于 `release/1.0.0-alpha.55/`。107 项 SHA256、105 个 ZIP 文件、101 个安装/便携资源一致性、真实 EXE 资源自检及前端启动、生产签名和篡改拒绝通过；未执行安装升级或发布索引。证据 `.qa/trigger55-build.log`、`.qa/trigger55-package.log`。
- 已确认无编译进程并校验清理路径；清理 .qa 窄测试 target、WebView 缓存、解包副本 0.928 GiB，无跳过项；另清理构建残留 0.02 GiB。保留脚本/截图/结果/配置/备份与正式交付。target 5.16 GiB、C 盘剩余 278.36 GiB，.qa 约 65 MiB。证据 `.qa/trigger55-disk.json`、`.qa/cleanup-trigger55-artifacts-result.json`。
- MariaDB 复用 MySQL 连接及管理协议；已有 Docker Desktop/13306 服务本轮未运行，未宣称完成本次 MariaDB 实库验收。

PostgreSQL 实库继续按用户既有决定待验收，本次不启动或创建该实例。路线图完成数保持 5/39，下一规划 R09，既有 R06/R07/R08 保留项不变。
