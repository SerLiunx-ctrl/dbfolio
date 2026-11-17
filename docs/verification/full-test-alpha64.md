# DBFolio 1.0.0-alpha.64 全面测试报告

测试时间为 2026-11-17～18（Asia/Shanghai）。被测平台为 Windows x64，数据库与消息服务由本机 Docker Desktop 或隔离 SQLite 文件提供。本轮验证的是发布前的 alpha.64 正式安装包和完整目录式便携版。公开下载与签名结果见[发布验收](release-alpha64.md)。

## 1. 结论与口径

已完成十种受支持数据库及消息系统的正式程序实库或实协议验收、主要桌面流程、Rust 与前端专项回归、安装包与便携版一致性、签名更新及回退检查。现有证据中的功能用例均通过。本轮发现并修正达梦多行冲突提示缺少失败项定位、25 个菜单项缺少图标、窄窗口数据页提交按钮换行三处问题。关系型与跨模块专项使用修复达梦后的正式构建；最终重包仅移除覆盖工具栏布局的三处主题样式，后端源码未变。非关系型、消息队列与十分钟桌面驻留使用本轮较早的 alpha.64 正式包。各构建的验证范围在下文分别注明。

“通过”表示下文列明的样本、操作和环境已验证，不表示所有数据库版本、集群拓扑或无限数据规模。先前 alpha.63 反馈的 14 项问题另见 `docs/verification/report-alpha64.md`；该报告中的 MySQL 8.4.6 的 118 项类型写入、PostgreSQL 18.6 的并发回滚、SQLite XLSX 整数精度及同步取消，本轮作为既有 alpha.64 证据引用，本报告重点扩展引擎覆盖和桌面、打包回归。

## 2. 被测产物与隔离方式

| 项目 | 记录 |
| --- | --- |
| 版本 | `1.0.0-alpha.64`，Windows x64 |
| 首轮正式程序 | `release/1.0.0-alpha.64/DBFolio_1.0.0-alpha.64_windows_x64_portable/DBFolio.exe` 的较早构建，SHA-256：`3c0a65b558ac17986964777088dc9c7defdefb79a196a13f165ca38eef3ce6c2`；用于 Redis、MongoDB、三种消息队列和十分钟桌面驻留 |
| 关系型补验构建 | 同一路径的正式构建，SHA-256：`48d627d4d238cfc5d73b5acade900f49262b4be8f7a6e51702ac0065b9d6e5aa`；用于五种关系型引擎、同步/事务、对象级 SQL 往返、触发器和配置迁移复验 |
| 最终交付程序 | 同一路径重新打包的正式构建，SHA-256：`17629b69bdc8c85313a6033e374fb53066fa4efc635ec66114567dc385b25dbb`；在上一构建后仅移除三处主题样式的换行覆盖，并完成最终双包完整性、签名、启动及窄窗界面验收 |
| 程序验证 | 使用正式便携版 EXE、隔离 `--startup-check` 配置与独立 WebView2 缓存；通过 Tauri IPC 执行实际命令，关键浏览和操作另用可见窗口与截图核对 |
| 数据隔离 | SQL 引擎使用随机测试库/模式或独立 SQLite 文件；Redis 使用随机键前缀；MongoDB 使用随机测试库；消息队列使用专用 Compose 栈和临时对象 |
| 凭据与清理 | 测试会话保存在独立本机配置中；测试脚本记录剩余会话为 0，并复查测试库、模式和临时键；不在报告中写入密码 |

桌面启动最初在受限命令沙箱返回 Windows `0xC0000409`，未进入前端就绪阶段。改用获准的桌面进程启动路径后，同一 SHA-256 的 EXE 正常显示窗口并创建前端 IPC 就绪标记；安装包解出的 EXE 也通过隔离启动。此现象归类为测试执行环境限制，不能据此判定发行包损坏。

## 3. 实库与实协议矩阵

| 引擎 | 本轮服务端版本 | 实测重点 | 结果 |
| --- | --- | --- | --- |
| MySQL | 9.7.4 | 表/视图与元数据；BIT(1/64)、负 TIME、精确 DECIMAL、JSON、二进制；分页、冲突回滚、只读；SQL 导出后执行 20 条导入语句并逐值核对 | 3/3 组通过 |
| MariaDB | 11.8.9 | 表/视图、外键、DDL；复杂类型、分页、CSV/JSON 导出；增改删、冲突回滚、只读；SQL 文件预览及执行 | 4/4 组通过 |
| PostgreSQL | 18.4 | schema、表/视图、外键、DDL；NUMERIC/JSONB/BYTEA、分页、CSV/JSON 导出；增改删、冲突回滚、只读 | 3/3 组通过 |
| SQLite | 独立临时文件 | 表/视图、外键、DDL、分页；增改删、冲突回滚、只读；CSV/JSON 导出及 CSV 导入、手动事务 | 4/4 组通过 |
| 达梦 DM8 | 8.1.4.80 | 独立模式、DDL 草稿、索引/外键/视图、精确类型；分页、CSV 导入导出、网格增改删与回滚；SQL 文件预览及执行、手动事务 | 5/5 组通过；深度 DDL 31/31 |
| Redis | 8.10.1 | 七种键值场景、空串及非 UTF-8 字节、SCAN、251 项分页、TTL/重命名、只读与危险命令确认、实际页面 | 通过 |
| MongoDB | 8.3.11 | 54 文档两页读取、Extended JSON、精确整数/日期/二进制、筛选投影、并发保护、索引聚合、JSON/JSONL 导入导出及实际页面 | 通过 |
| Kafka | 镜像 `apache/kafka:4.3.1` | Topic、发送读取、offset、空消息与二进制、诊断、只读、JSON/JSONL 导出及实际页面 | 通过 |
| RabbitMQ | 4.2.9 | Queue/Exchange、路由、取样确认与重新入队、只读、导出及实际页面 | 通过 |
| RocketMQ | 镜像 `apache/rocketmq:5.3.3`，Dashboard 2.1.0 | Topic、文本消息、Key/消息 ID 定位、诊断、只读、导出及实际页面 | 通过 |

五种关系型引擎共 **19/19 组**正式 EXE 结构化用例通过。MySQL 9.7 SQL 往返包含 3 行样本和 20/20 条导入语句，核对 BIT(64)、负 TIME(6)、JSON、二进制与原库相同。达梦 DDL 在隔离实例上回放 12 条原生定义，覆盖表达式索引、跨模式外键、命名/匿名约束、中文注释、identity、BLOB/CLOB；专项最终 31/31 通过。达梦与 MariaDB 的 SQL 文件导入、SQLite 与达梦的 CSV 导入均有实际结果回读。SQL 文件专用导入并非 PostgreSQL/SQLite 当前能力，不计为失败。

同引擎同步和手动事务补验在关系型补验构建上 **10/10 组**通过：MySQL 9.7 与 PostgreSQL 18.4 均完成独立源/目标库的结构比较、预览、目标表创建，以及包含 2 新增、1 修改、1 删除的数据同步和逐值回读；只读目标、同库与跨引擎同步请求被拒绝。两种引擎的手动事务回滚、提交和断线自动回滚通过，SQLite/达梦的手动事务也完成提交与回滚实测。同步备份的 README 和 SQL 文件保留在 `.qa/fulltest64/relational-sync-backup-evidence/`，本轮没有修改用户业务库。

另有同一构建 **6/6 组跨模块补验**：MySQL 9.7 的对象级 SQL 文件包含 2 表、视图、存储过程、函数、触发器和禁用事件，68/68 条导入独立目标库成功；定义回读、函数/过程执行、触发器行为及中文 BIT(1) 数据通过。MySQL/SQLite 的触发器新增、执行、错误编辑保旧、删除通过；两套隔离配置 A→B 迁移的密码排除、过期预览拒绝、合并/跳过/复制与重复导入幂等通过。事件保持禁用，未开启调度器，不把定时触发行为列为已测。

Redis/MongoDB 的结构化实测为 20 项通过。Redis 251 项列表分批续读无漏项，非 UTF-8 原始字节安全显示为十六进制；MongoDB JSON 与 JSONL 各导出并导入 3 条，长整数 `9007199254740993`、日期和二进制仍保留类型。三种消息系统均完成独立会话、临时对象创建、发送/取样或读取、确认和只读保护、容量与取消、JSON/JSONL 导出及实际页面操作。各引擎只验证产品当前开放的能力，RocketMQ 不按 Kafka 的空消息/二进制发送能力判定。

关系型证据：`.qa/fulltest64/relational-results.json`、`relational-extra-results.json`、`relational-sync-tx-results.json`、`relational-dm-conflict-regression.log`、`relational-report.md` 及同目录导入/导出样本。跨模块证据：`.qa/fulltest64/cross-features-results.json`、`cross-features-report.md`。非关系型证据：`.qa/fulltest64/nonrelational-summary.md`、`nonrelational-mq-native-1794924883740/result.json`、`nonrelational-kv-native-1794931680511/result.json` 及同目录五引擎截图。

## 4. 桌面交互与浏览器专项

首轮正式 EXE 的隔离桌面主流程 8/8 组通过（其中一组为十分钟驻留巡检）：SQLite 会话新建、测试、编辑和连接；对象树及表/视图；结构、索引、外键和 DDL；查询结果右键、错误与历史；ER 图开启 AI 面板后的实体详情；数据字典与触发器；首选项、主题、快捷键和 900 像素宽布局。退出后隔离配置中的会话为 0，测试进程已退出，没有记录到 JavaScript 页面异常。结构化证据：`.qa/fulltest64/ui-desktop-1794931489961/result.json`。

最终交付 EXE 又在真实 WebView 中通过 8/8 组桌面复验；其中紧凑、Aurora、Studio、OLED 各在 1280/900 像素下实测工具栏计算样式为 `flex-wrap: nowrap`，刷新、放弃与提交同排，按钮中文不裁切，草稿状态可操作。900 像素下右键菜单的详情、复制、复制 SQL、粘贴及 INSERT 子项图标可见；废弃草稿后数据库原值未变。JavaScript 异常 0，退出后隔离会话和进程均为 0。证据：`.qa/fulltest64/ui-final-narrow-1794937883070/result.json` 和同目录八张主题/宽度截图及 `right-menu-900.png`。

浏览器夹具用于补足可重复的菜单、键盘、主题、缩放和异常路径。更新界面的检查/下载/取消/跳过、执行中安装保护和网络错误通过；任务中心 12 组主题、缩放、窄窗、进度间距与失败恢复通过；数据表和查询结果的二级右键菜单、键盘焦点、空白处多选、复制 SQL、只读限制及三主题多比例边界通过；查询脚本的选区、防重放、失败清除旧结果和达梦语句边界通过；设置无障碍专项覆盖亮色/暗色/OLED、两种强调色及 900/1024/1280 宽度的 100%/200% 布局，实测主按钮对比度最低 4.68∶1。

旧夹具初跑还有断言失配：早期网格复制脚本按未转义 JSON 文本比较，当前 TSV 正确输出 `"{""k"":2}"`，修正隔离断言后 MySQL/PostgreSQL/SQLite 场景全过；数据预览旧脚本把字符串写入整数主键，当前输入校验正确拒绝，改为 `id=4`、`name=inserted` 后全过。查询分页和布局夹具均漏传当前必需的 `active` 属性，分别使请求数为 0 和 Monaco 未挂载；设置预览脚本仍硬编码 alpha.43。这三项列为旧夹具维护项，相应产品行为已由正式版桌面流程、现行查询脚本与设置无障碍专项验证。初跑与复验材料归档于 `.qa/fulltest64/ui-fixtures/`。

## 5. 自动化、更新与交付

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 完整 Rust 单元测试 | 207 通过、0 失败、28 个需专用环境或签名样本的用例默认跳过；DM8 修复后复跑仍为 207/207 | `.qa/fulltest64/cargo-test-final.log` |
| Windows 凭据管理器专项 | 随机测试会话的 SSH 凭据复制、清除、删除 1/1 通过 | `.qa/fulltest64/credential-test.log` |
| 达梦窄模块与实库专项 | 后端 15/15、SQL 导入 28/28、DDL 与冲突实库 31/31 | `.qa/fulltest64/check-dameng-backend.log`、`check-dameng-import-backend.log`、`relational-dm-conflict-regression.log` |
| 无浏览器依赖的前端专项脚本 | 修正旧脚手架后 32/32 通过；菜单定位 7 场景，122 个菜单项均有图标 | `.qa/fulltest64/node-pure-checks-final.log`、`scripts/check-context-menus.cjs` |
| 最终正式包完整性 | NSIS 安装包与完整目录式 portable 均交付；两份 SHA256SUMS 合计 **215 项**；便携 ZIP **213 个文件**逐一与目录比对；NSIS 解包与便携版 **209 项资源**一致；两版 EXE 资源自检及隔离窗口/IPC 启动通过 | `.qa/fulltest64/update-release-final-4.log`、`.qa/updater-release-verification.json` |
| 签名更新 | 正式产物签名与更新元数据验签、篡改拒绝；隔离签名探针的替换、启动前失败回退、数据打开后失败保留均通过；公开更新索引另见发布验收 | `.qa/fulltest64/update-release-final-4.log`、`update-helper.log` |

初次 35 个无浏览器依赖脚本中有 6 项未通过，其中两项是达梦窄测试脚手架未引入新 `mysql_value` 模块、一项需要运行中的达梦实例、一项 MongoDB 脚手架未解析新增相对模块、一项查询文本脚手架未加载达梦语句模块；余下一项菜单扫描实际发现 25 个缺失图标。脚手架已修正，达梦实库脚本在隔离实例复验通过，菜单图标源码已补齐，32 项普通脚本重跑全绿。上述初次失败及其处理均保留原始日志 `.qa/fulltest64/node-pure-checks.log`，避免只呈现最终结果。

## 6. 稳定性、缺陷与范围

正式 EXE 的多页签驻留巡检持续 600155 毫秒、采样 19 次，在表、视图、ER、字典、触发器、查询间切换；8 个关联进程的总工作集由 860119040 字节降至 752820224 字节，私有内存由 641167360 字节降至 515215360 字节，期间没有渲染崩溃。原始样本：`.qa/fulltest64/ui-desktop-1794931489961/soak-samples.json`。此观察不足以证明长时锁屏或高负载下不会再触发 WebView2 内存不足。

本轮确认并修正三处产品表现：达梦网格多行提交遇到第二项目标行丢失时，原程序整批回滚但只显示通用提示；改为返回失败项和实际影响行数，由网格层附主键定位，关系型补验构建严格核对“第 2 项”和 `id=2`。实际右键及工具下拉共 25 个菜单项缺少图标，已统一补齐，122 个菜单项复扫全通过。1280×800 窗口且左栏约 300 像素时，表数据“提交”按钮曾单独换行；组件分组与 Vite 初验通过后，正式 EXE 仍复现换行，追查为 `compact.css` 和 `styles.css` 的紧凑、Aurora、Studio 规则覆盖了组件的 `nowrap`。移除三处覆盖后，Vite 的四主题 × 两宽度 8/8 和最终 EXE 同样的 8/8 均通过，源码证据 `.qa/fulltest64/ui-toolbar-themes-result.json`，正式包证据见第 4 节。中间失败截图 `.qa/fulltest64/ui-final-narrow-1794936347094/failure-5.png` 保留，避免只展示通过结果。此轮修复随 alpha.64 源码提交。

仍需独立环境或长期观察的范围：真实一小时以上锁屏及唤醒后的 OOM 复测；现有安装上原位 NSIS 升级和旧版到新版完整用户数据迁移；macOS 实机；外部数据库集群、TLS/SASL/ACL、节点故障切换；数百万行长时压力；外部 AI 模型质量及实际 Narrator/NVDA 语音播报。隔离签名探针验证更新回退机制，不能代替现有安装的原位升级。

## 7. 收尾核对

关系型测试库/模式及程序内会话、Redis 随机键、MongoDB 随机库均已核对清理；四个专用关系型测试容器、达梦专用卷、临时测试凭据与三种消息队列专用 Compose 栈已删除或停止，Redis/MongoDB 原有容器保持运行。跨模块两套隔离配置和测试库/文件也已清理。清理记录在 `.qa/fulltest64/relational-results.json`、`relational-extra-results.json`、`relational-sync-tx-results.json`、`cross-features-results.json`、`nonrelational-postcheck.json`。构建留下的 `.previous-*` 旧便携包备份已在确认无构建/应用进程后删除；正式交付和测试证据保留。

构建目录与磁盘按项目规则收尾：最终构建后 `src-tauri/target` 为 **17.18 GiB**，低于 20 GiB 清理阈值；C 盘剩余 **346.15 GiB**（`.qa/fulltest64/disk-final.json`）。本轮仍保留源码、正式 `release/` 交付以及无凭据的测试脚本、日志、截图和结果文件。打包内离线报告为构建时快照，此文件包含打包后的最终测试记录。
