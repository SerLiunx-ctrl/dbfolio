# 达梦 DM8 首批兼容验收

版本：1.0.0-alpha.58；实施：2026-11-11；正式 EXE 验收完成：2026-11-12。

## 环境与范围

- Windows x64，本机 Docker DM8 8.1.4.80，映射端口 15236，实例 DMSERVER；SYSDBA、UTF-8、COMPATIBLE_MODE=0。
- 凭据只从本机环境读取，不写入源码、报告、命令行或业务配置。测试使用唯一前缀的专用模式，既有业务表与用户会话未修改。
- 采用 dm-rust 0.1.1 原生异步连接，驱动固定版本及授权文本已纳入依赖和交付资源。

## 已完成检查

- TypeScript 类型检查通过；Rust 正式配置检查通过。清理项目自身旧 release 缓存后，Tauri 宏环境检查正常；保留既有 SQLx 依赖警告，不当作新增失败。
- `scripts/check-dameng-backend.cjs`：10 项测试通过，含生产适配器、统一元数据值、版本类型回归和实际 DM8 用例。未使用模拟驱动代替实库。
- 实库覆盖：新建模式/表、主键与 IDENTITY、中文表/列注释、原始 DDL；参数化增改删、精确大整数和 Decimal、BIT、日期时间、二进制与 CLOB；可空旧值匹配、乐观锁冲突整批回滚；重命名、类型、默认值、NOT NULL、注释、追加列和倒序索引；外键与真实更新/删除规则、视图；手动提交/回滚、分页、执行中取消、连接恢复及只读写保护。
- CSV 风格的时间文本使用 PREPARE 返回的真实参数类型转换，日期时间往返一致；普通 VARCHAR 内容不按正则猜测日期类型。
- BLOB 数据页预览专项：原通用 SUBSTR 会把 `00 7F 80 FF` 隐式转换成带替换字符的文本；改用 DBMS_LOB.SUBSTR 后返回相同的原始字节。CLOB 继续使用字符截断并标为截断预览。`scripts/check-dameng-grid.cjs` 检查生产 TypeScript 生成的模式限定、二进制/文本预览 SQL 和精确数值编辑，实库后端再次验证返回类型与字节一致。
- 普通导出从数据页的预览 SQL 改为完整字段 SQL，保留筛选与排序；达梦使用完整值页读取，实库 CLOB/二进制完整值与原输入一致。通用默认路径拒绝截断值；其他适配器的完整大字段读取尚未在本轮适配，不能把达梦用例的成功视为所有引擎完整导出通过。
- 实测修正两处元数据差异：列注释以 SCHNAME/TVNAME/COLNAME 联合定位；外键更新规则从 SYSCONS.FACTION 读取，避免把实际 CASCADE 显示成 NO ACTION。原始数据类型按统一大小写处理，保留长度和精度。
- `scripts/check-create-table.cjs`：MySQL 浅色、PostgreSQL 深色、SQLite OLED、达梦浅色/OLED 五组共用工作区回归通过。覆盖双击行内编辑、类型下拉、属性/索引/外键草稿、引用改名、页签切换保留、关闭保护、失败保留、保存后原页签转为正式表并显示数据及只读。已检查达梦截图布局。
- 测试模式已清理；一次测试数据切片断言中断残留的模式，经唯一前缀和对象清单核对后单独清理，共 1 个。没有删除业务对象。

## 正式交付验收

- `npm run app:build` 正式 LTO 编译及 NSIS/portable 生成通过。11 月 12 日修正验收脚本的 IPC 字节格式、SQLite 夹具和模式清理上下文后，应用源码未变，执行 `npm run app:build -- -ReuseBuild` 复用已验收的正式编译重新生成最终资产；前后 EXE SHA256 均为 `12cb98659bb8f96cc4ab22459693d6d2990e5d2198a6d80929d08db2f2573e10`。
- 正式 EXE 的 11 组端到端检查全部通过：新建会话类型/默认用户/端口/模式与协议选项、原生认证及类型目录、建表/网格读写、字段/索引/外键管理、视图/字典、只读、实际界面与 ER、CSV 精确值及完整 BLOB/CLOB 导出、CSV Decimal/BIT/微秒时间导入、SQLite 通用截断值拒绝落盘与小结果正常导出。隔离配置测试会话剩余 0，本轮测试模式已删除。
- 最终产物再次校验通过：109 项 SHA256、107 个 ZIP 文件、103 个安装资源；安装版与便携版真实 EXE 资源自检、可见窗口/前端 IPC 启动、安装包/ZIP/索引元数据生产签名以及篡改拒绝均通过。完整安装升级未在本轮执行，公开索引未发布。
- 早期脚本失败残留的 2 个 `DBFOLIO_NATIVE58_` 专用模式，经固定前缀、对象清单及表注释核对后清理；最终 `DBFOLIO_DM58_` / `DBFOLIO_NATIVE58_` 模式剩余 0。未创建额外 Docker 容器，原本机 platform-dm8 恢复后用于验收并保留运行。
- 临时缓存清理 1.131 GiB，跳过 0；`.qa` 最终约 0.071 GiB，`src-tauri/target` 约 4.78 GiB，C 盘剩余约 273.52 GiB。测试 App/WebView、编译进程均为 0。只删除同版本同 EXE 的重复 `.previous` 便携目录，正式交付、源码、报告和用户数据保留。
- 证据位于忽略目录：`.qa/dm58-native.log`、`.qa/dm58-isolation-verification.json`、`.qa/dm58-final-database-cleanup.log`、`.qa/dm58-package-verification.json`、`.qa/dm58-tested-exe-identity.json`、`.qa/cleanup-dm58-artifacts-result.json`、`.qa/dm58-disk-final.json`；失败的早期记录仍保留，未把失败运行标记为通过。
- 产物位于 `release/1.0.0-alpha.58/`，包含 NSIS 安装包、完整 portable 目录、ZIP、两份 SHA256SUMS 及本地签名更新材料。尚未提交或公开发布。

## 保留边界

- 本轮未覆盖其他 DM8 版本、Oracle/MySQL 等其他兼容模式、普通业务角色、SSH、TLS 或客户端证书。首版明确不支持客户端证书认证。
- 已知展示偏差：表标题可能重复显示同名 database/schema 标识；SQL 定位使用正确的模式限定，未把标题去重列为本轮已完成项。
- 触发器管理、结构/数据同步、数据生成、可视化执行计划、SQL 文件转储/恢复未开放；已建列 IDENTITY、列顺序和复杂类型通过 SQL 管理。带时区/Interval/复杂值只读展示。
- DDL 可能隐式提交，不能保证多语句结构修改整批回滚；数据事务冲突回滚是单独验证的行为。完整安装升级、历史锁屏、PostgreSQL 保留验收项未因本轮通过而改为完成。
- 路线图 R37 仍为部分完成，总计 5/39，下一规划 R09。
