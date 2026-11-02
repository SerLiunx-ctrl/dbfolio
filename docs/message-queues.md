# 消息系统连接与使用

DBFolio alpha.47 首批接入 Kafka、RabbitMQ、RocketMQ，复用会话、凭据管理器、连接诊断与只读模式；对象及消息使用独立工作区。不会给消息系统展示 SQL、表结构、同步或数据生成入口。

## 连接方式

| 系统 | 接口与默认端口 | 认证与前提 |
|---|---|---|
| Kafka | 原生 Kafka 协议，9092 | 无认证、SASL PLAIN、SCRAM-SHA-256/512；可选 TLS/CA/客户端证书。必须能够访问所有 advertised.listeners 广播地址 |
| RabbitMQ | Management HTTP API，15672 | 启用 management 插件，账号/密码及 VHost 权限；不是 AMQP 5672 |
| RocketMQ | Dashboard 2.x HTTP API，通常 8082 | Dashboard 能访问 NameServer/Broker；支持登录 Cookie、CSRF 令牌和可选 HTTPS；不是 NameServer 9876、Broker 10911 或 Proxy gRPC |

主机只填 IP/主机名，HTTP 路径前缀另填；密码不放到 URL。HTTP 管理连接使用直连，不沿用应用更新代理。首版不支持 MQ SSH 隧道及 TLS 服务器名覆盖，保存/连接时明确拒绝。Kafka 不支持 OAuth/Kerberos、Schema Registry 或自定义反序列化器。TLS/SASL 配置已接线，当前本机实测为无认证 Kafka、RabbitMQ Basic 和不要求登录的 Dashboard；完整认证部署矩阵仍待补验。Dashboard 3.x Studio 接口不属于本版兼容范围。

## 共用交互

- 左侧搜索 Topic、队列、交换机；按服务器发现 VHost、分区、集群和交换机，隐藏/显示系统对象。对象概览最多显示 500 项，每类别最多 500 项，搜索在已取得的至多 5000 项目录内进行。
- 消息按明确范围手动读取，一次 1～200 条。支持文本、显式 JSON、Base64、属性/Headers；NULL、空串和二进制分开显示。Offset 使用十进制字符串，避免超过 JavaScript 安全整数范围后失真。
- Ctrl+F（可修改快捷键）搜索本批已加载消息。导出 JSON/JSONL 带引擎、命名空间、对象及截断标记，只导出已加载条目，不是全量队列备份。JSON 包含 version/source/messages；JSONL 每行包含 version/source/message。正文和 Key 同时提供文本与 Base64；属性以 JSON 文本保存，保留大整数。
- 测试发送、创建/绑定、删除/清空都经过确认；删除/清空需输入完整对象名。只读会话由前后端同时禁止写入；不绕过服务端账户授权。发生超时或存储确认异常，不能据此断定消息没有写入，先核对再重发。
- 单条正文预览和测试发送上限 256 KiB，Key 预览最多 8 KiB，一批预览累计约 4 MiB；HTTP 响应最多 8 MiB。截断消息禁止直接复制正文后发送。后台页签卸载编辑器，30 秒后释放已加载消息/诊断；未发送弹窗草稿在临时非活动期间保留。没有后台轮询或自动消费。

## 各引擎能力与边界

### Kafka

Topic/分区发现、最新/最早/Offset/时间定位、下一批、分区位点诊断、创建/删除 Topic、指定分区发送文本或二进制/空值消息。预览不加入业务消费组，不提交消费位点。位点区间可能有空洞，不能当作消费组积压；首版不提供消费组列表/重置、实时跟随、事务隔离配置。Headers 在 SDK 中按键保存，重复同名项只保留最后一项；读取的值以 Base64 展示，发送表单接受字符串键值 JSON。SDK 的连接/限流处理不构成端到端幂等保障，应用不会因写超时自动补发。

### RabbitMQ

VHost、队列、交换机发现，队列/绑定/消费者诊断；新建队列/交换机、绑定、发送、清空和安全删除。默认交换机显示为 amq.default，发送到队列时使用默认交换机及队列名路由，未路由返回失败。

**诊断取样使用 ack_requeue_true，取出后重新入队。它可能影响顺序、redelivered 标记及与业务消费者的竞争，并非无副作用的只读浏览。** 只读会话禁止取样，每次取样先确认；停止等待不会撤销已发生的取样。普通刷新/诊断不会隐式取样。删除队列只允许未使用且为空，清空需单独确认；不提供自动 ACK、业务消费或自动重发。

### RocketMQ

通过 Dashboard 查询 Topic、路由、统计、消费者信息；按时间（最多 24 小时，结束时间包含所选分钟的末尾）、Key、消息 ID 查询，创建/删除 Topic、文本测试发送及 Key/Tag。创建时选择发现的目标集群。Dashboard 查询使用它自己的管理拉取消费者，不重置/提交业务消费组位点，不调用直接消费业务消息的接口。二进制保真受 Dashboard 返回文本形式限制。首版不支持事务/延迟消息、消费组修改与重置、DLQ 重投、RocketMQ 5.4 ACL2 或 Dashboard 3.x Studio。

## 本机隔离 Docker 环境

配置：[Compose](../scripts/docker/message-queues.compose.yaml)、[环境变量示例](../scripts/docker/message-queues.env.example)。实际本机凭据位于忽略的 `.qa/message-queues-connection.json` 与 `.qa/message-queues.env`，不要提交到仓库。

| 系统 | 本机地址 | 实测镜像版本 |
|---|---|---|
| Kafka | 127.0.0.1:19092 | apache/kafka:4.3.1，单节点 KRaft |
| RabbitMQ Management | 127.0.0.1:15673 | rabbitmq:4.2-management，实际 4.2.9；用户 dbfolio，密码见本机忽略文件 |
| RocketMQ Dashboard | 127.0.0.1:18082 | RocketMQ 5.3.3 + Dashboard 2.1.0 |

```powershell
docker compose --env-file .qa/message-queues.env -f scripts/docker/message-queues.compose.yaml up -d
```

公开的环境变量示例不含密码，需要自行生成后再启动。所有公开端口仅绑定本机回环；本机 Dashboard 关闭账号登录，用于隔离开发验收，不能照搬为公网部署。独立 named volumes 保留测试数据；初始化容器仅修正本项目新 volume 的所有者。已有数据库/旧 Kafka 容器不受影响。

验证记录见 [alpha.47 验收](verification/message-queues-alpha47.md)。
