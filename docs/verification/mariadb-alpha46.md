# MariaDB 首批兼容验收（alpha.46）

日期：2026-11-01。当前状态：MariaDB 首批范围已完成验收与正式双包交付；整个 R37 仍为部分完成，不勾选。

## 环境与隔离

- Docker Desktop 4.83.0 / Engine 29.6.2；官方 `mariadb:11.8`，实际 11.8.9-MariaDB-ubu2404，镜像摘要 `sha256:c4124d1afa875e47f2892edf26b482fa54f796e2f342d3717a04ca091a22a9bd`。
- `dbfolio-mariadb`，`127.0.0.1:13306`，独立卷 `dbfolio-mariadb-data`，普通用户 `dbfolio`。只在 `dbfolio_compat`、`dbfolio_restore` 两个隔离库写入；密码不进入源码/验收结果。
- 原生程序使用 `--startup-check` 隔离配置和 WebView 目录，不变更日常会话。本机 MySQL 仅只读回归。

## 已完成

- 引擎类型目录及 DDL 目标定位专项 11 项 Rust 测试通过：MySQL/MariaDB 版本门控、UUID/IP 专属类型、中文位置/转义/注释/嵌套括号、默认值含逗号/引号、未知列拒绝。
- `npm run build` 通过，包含已有 chunk 体积提示，无新增编译错误。
- 旧正式 EXE 原生探针复现：MariaDB 连接与基本查询成功；含 INVISIBLE 的表在普通列改名时被整表解析阻断。修复为仅解析目标列，保留无关厂商定义。

## 正式程序与交付验证

- `scripts/check-mariadb-native.cjs` 正式 EXE 原生 IPC 的 **12 组实库验收全部通过**；结果保存在 `.qa/mariadb46-native-1793508654786/result.json`，脚本支持通过忽略的连接 JSON 重复执行，不写入日常数据库配置。
- 覆盖：服务器能力发现、SHOW/DESCRIBE/EXPLAIN 与 SHOW 页窗口、默认表达式/NULL/空串、隐藏/生成列、JSON CHECK/改名、UUID/IP/VECTOR 类型；统一建表草稿、字段增改与精度、表选项、索引/外键增改删、IGNORED/前缀保护；大整数、Decimal、JSON 的网格增改删及文本数值转换、启停筛选、事务回滚与管理命令拒绝。
- 真实创建、读取并导出视图、过程、函数、触发器及禁用事件。**5 张表、5 行数据、6 个对象**导出后，经应用自己的流式预检与导入执行还原至隔离目标库；导入无失败或不确定结果，精确整数/Decimal/JSON、隐藏/生成列、UUID/IP 和 VECTOR 原始字节往返一致。
- 字典采集与 ER 所需主外键元数据、正式表结构导航、MariaDB 状态栏标识、只读及数据库范围保护通过。本机 **MySQL 8.4.6** 仅只读回归：目录/元数据/类型负向门控通过，MySQL↔MariaDB 同步拒绝，MariaDB 同厂商结构比较通过。未扩展为完整同步执行专项。
- 生产类型目录输出用于真实类型选择组件，浅色/OLED、100%/200% 下 UUID/INET6/INET4/VECTOR 下拉选择及中文说明通过；连接选项显示 MySQL / MariaDB。已有会话保存/复制及三引擎 Monaco 补全回归通过。
- `npm run app:build` 正式 LTO 构建完成：NSIS 安装包、目录式 portable、ZIP、独立 setup/portable SHA256SUMS 位于 `release/1.0.0-alpha.46/`。两者 EXE 与外置 `web/` 一起分发。
- **107 项 SHA256、105 个 ZIP 文件、101 个安装/便携资源一致性**通过；便携 EXE 和 NSIS 解包 EXE 的资源自检、真实启动、窗口与前端 IPC 就绪通过。生产 `update_package.rs` 对正式安装包/ZIP/索引签名与篡改拒绝验证通过；未执行系统安装升级。本地候选索引未发布到公共更新通道。
- 存储收尾：确认无 cargo/rustc/link/cl/MSBuild 编译进程后，清理本轮两个窄测试 crate 的 target（0.32 GiB），保留测试源码、日志、正式产物和用户数据；首次候选包保留到 `.qa/mariadb46-superseded-a8766cad`。`src-tauri/target` **4.45 GiB**，C 盘剩余 **290.23 GiB**，未超过 20 GiB 门槛。
- 容器结束时保持 healthy；独立数据卷保留，其他 Docker 容器及本机数据库未改动。

## 已知边界

只对上述 MariaDB 11.8.9 环境与本机 MySQL 进行本轮真实验收。特殊目标列属性、向量索引/相似度专用交互、历史全版本、MariaDB 集群及独立 TLS/SSH 组合未额外实测；本轮不承诺跨 MySQL/MariaDB 同步。其他 R37 引擎未实施；R07/R08 的 PostgreSQL 待验收状态不因 Docker 已启动而自动完成。当前 5/39，尚未提交/发布。
