# alpha.47 消息系统首批验收

日期：2026-11-01。范围：Kafka / RabbitMQ / RocketMQ 首批连接与消息管理。状态：首批范围已交付并验收；未提交、未发布，R37 整体仍部分完成，不整项勾选。

- 实际服务：Kafka 4.3.1 单节点 KRaft、RabbitMQ 4.2.9 Management、RocketMQ 5.3.3 + Dashboard 2.1.0；回环端口 19092 / 15673 / 18082，独立命名 volume。
- 实际源适配器专项运行：三服务创建、目录发现、中文正文/Key 发送、范围读取、诊断、删除通过；RabbitMQ 重复取样仍存在、非空删除拒绝、清空后删除通过；RocketMQ 时间和 Key 查询通过。发现并修复 Dashboard 镜像 CSRF Cookie/令牌校验及首次分页 taskId 必须为空串的问题。
- 真实返回格式补验：RocketMQ Key/Tag 从 properties.KEYS/TAGS 解析；补齐实际 Key 返回断言。UI 结束分钟边界专项通过；RabbitMQ 精简目录请求补充 enable_queue_totals，否则服务器不返回队列数量；实 HTTP 请求对比确认。空 Key/ID 拦截；非活动期间迟到结果不会挂载详情或覆盖预览。
- Rust 源模块专项：10 项（含 2 项消息二进制/空值/截断/容量测试）通过。TS 和 Rust release lib 检查通过；最终变动已随正式 app:build 编译通过。
- 组件界面：18 组引擎×主题×缩放交互、3 引擎只读、查找/精度/导出、后台释放与未发送草稿保留通过；新增 3 引擎实际创建/发送/删除弹窗与参数、删除名称确认、空 Key 拦截专项通过。原有会话编辑/SQL 补全和服务器类型目录回归通过。
- 第一轮正式 EXE：Kafka/RabbitMQ 全流程、三引擎原生 CRUD/消息/只读/导出均通过；RocketMQ 默认时间范围 UI 暴露结束时间截到分钟起点，漏掉当前分钟的消息。已修正为包含该分钟末尾；不能使用调整测试条件掩盖此问题，最终包已重新生成，默认范围实际读取与 Key/Tag 映射通过。
- 第一轮包完整性：107 校验/105 ZIP/101 资源、双 EXE 启动、签名及篡改拒绝通过。该候选包因时间边界问题已撤出正式交付目录，最终包已按同一标准全部复验通过。
- 已知范围：Kafka 消费组管理未开放；无连续消费、业务 ACK/位点提交、事务消息、DLQ 重投；RocketMQ 仅 Dashboard 2.x，二进制受管理接口限制。TLS/SASL 和登录模式需在对应部署补验，不用明文单机结果代替认证验证。
- 构建收尾：target 4.71 GiB，C 剩余 288.48 GiB；无编译进程后验证路径无重解析点，清理本轮两项专项 target 和参考 JAR 共 0.86 GiB，保留源码、正式 release 和用户数据。

## 最终验收与交付

三引擎正式 EXE 全流程及隔离 Docker 实测、18 组引擎/主题/缩放、实际操作弹窗、只读/确认、容量/取消、中文/二进制/空值、查找、精确导出、后台释放与草稿保留通过；正式双包 107 校验/105 ZIP/101 资源、启动及生产签名/篡改拒绝通过。target 4.71 GiB、C 盘剩余 288.48 GiB，清理本轮临时缓存 0.86 GiB。

- 原生测试：`scripts/check-message-queue-native.cjs`；三引擎实际会话创建、凭据重连、对象 CRUD、测试发送、读取与诊断、只读/确认/预取消、SQL 拒绝、超出 256 KiB 发送及超出 200 条读取的拦截、JSON/JSONL 往返一致、正式界面与 Ctrl+F 均通过。RabbitMQ 非空删除保护、绑定与含中文/斜线/问号/百分号的交换机路径、取样重新入队及 4 条消息计数通过；RocketMQ 时间/Key/ID 定位和 Key 实际显示通过。测试对象与隔离会话已清理。
- 组件测试：`scripts/check-message-queue.cjs`、`scripts/check-message-queue-actions.cjs`，另补结束分钟边界和迟到结果专项。测试脚本通过 PLAYWRIGHT_MODULE 指定验证环境的 Playwright，未写入个人绝对路径。
- 原始结果：`.qa/mq47-native-1793529588810/result.json`；三张实际界面截图、导出样本保留在同目录。签名/资源结果：`.qa/updater-release-verification.json`；磁盘记录：`.qa/mq47-disk.json`。
- 交付目录：`release/1.0.0-alpha.47/`，安装包 12392472 字节、便携 ZIP 17584940 字节，另含完整 portable 目录、两份独立 SHA256SUMS、签名与本地更新索引。公开更新索引仍 alpha.43，未推送或发布 alpha.47。
- 保留边界：TLS/SASL/登录部署矩阵及 Kafka 消费组等高级管理仍按上方范围说明，不把明文单机验收等同完整认证覆盖。未执行真实安装升级，本轮不改变 R06、R07/R08 既有待验收状态；完成数 5/39，下一规划项 R09。
