# alpha.48 视图适配与对象树快捷操作验收

日期：2026-11-01。状态：本轮首批界面及正式双包已交付；PostgreSQL 实库依既有决定待验收，尚未提交或发布。

范围：MySQL/MariaDB、PostgreSQL、SQLite 视图页面、对象图标、数据库行快捷按钮；Redis/MongoDB/MQ 不提供关系型视图开关。普通视图与物化/实际索引能力区分，不将有真实索引的对象统一隐藏。

- 组件：MySQL/PostgreSQL/SQLite × 浅色/暗色/OLED × 1x/2x 共 18 组通过；视图无写入入口、只读结构、信息字段裁剪、类型配色、独立图标、旧索引/外键页签纠正、PG 带注释定义的物化视图索引、按库显隐持久化和快捷按钮事件隔离通过。结果：.qa/views48-ui/result.json。
- 共用表功能回归：三引擎建表页、双击字段、属性/索引/外键草稿、引用改名、保存/失败/关闭保护通过；外键三引擎/三主题/双缩放导航、跨库/schema、自引用、已有未保存编辑保留、只读/无权限处理通过。记录：.qa/views48-create.log、.qa/views48-foreign.log。
- 长中文数据库名称、OLED/2x 下三个按钮右对齐、不重叠；缺少视图定义时明确提示且禁止打开伪造 SQL 专项通过。
- 三引擎视图列宽拖动、双缩放、表头与单元格对齐、重载恢复通过；偏好与普通表结构独立。结果：`.qa/views48-resize.json`。
- TypeScript 检查、正式前端构建、版本一致性及 Git diff 空白检查通过。
- 原生：正式 EXE 的 MySQL 8.4.6 `sys.memory_by_host_by_current_bytes`、MariaDB 11.8.9 可更新视图和 SQLite 3.46.0 带 INSTEAD OF INSERT 触发器的视图通过。均检查独立图标、只读数据/结构、精简信息/页签、DDL、显隐/刷新不折叠与实际保存/前端重启恢复。
- MariaDB 与 SQLite 的网格预览/提交均由应用后端拒绝，基础表未变化；普通表网格预览/插入/删除回归与查询页显式写入视图通过，证明保护并非依赖数据库天然拒绝。
- 原生使用独立 startup-check 配置和 WebView 数据目录。用户本地配置只读查询，MySQL 会话复制到测试配置并设为只读，不删除原凭据、不修改用户业务表；MariaDB 限专用测试库，新增会话及测试对象已清理。结果及截图：`.qa/views48-native-1793534159339/result.json`；脚本：`scripts/check-view-adaptation-native.cjs`。
- PostgreSQL 物化/普通视图由组件元数据夹具覆盖，沿用用户此前 PG 真实环境暂缓的决定，本轮不将 R07/R08 的 PG 验收标为完成。
- `npm run app:build` 完成；版本统一 `1.0.0-alpha.48`，NSIS、完整 portable 目录/ZIP、两份独立 SHA256SUMS 和更新签名材料位于 `release/1.0.0-alpha.48/`。
- 107 项 SHA256、105 个 ZIP 文件与目录逐文件一致、101 个安装/便携资源一致；两种实际 EXE 的资源自检、可见窗口及前端 IPC 启动通过。生产签名、更新索引元数据及篡改拒绝通过。记录：`.qa/updater-release-verification.json`。完整安装升级仍属于 R06 保留项；公开索引仍 alpha.43，本轮未推送/发布。
- 确认无编译进程，核对绝对路径及重解析点后清理临时签名验收缓存 0.12 GiB；`src-tauri/target` 总计 4.76 GiB，C 盘剩余 287.52 GiB。记录：`.qa/views48-disk.json`。完成数保持 5/39，下一规划 R09；不扩大完成范围。
