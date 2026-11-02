# alpha.49 发布准备与验收

日期：2026-11-02。版本：1.0.0-alpha.49；最近实际公开基线：v1.0.0-alpha.43。

- 本次汇总 alpha.44～49：AI 模型配置、数据字典、MariaDB、Kafka/RabbitMQ/RocketMQ、视图适配与 ER 卡片交互；完整双语摘要见 [更新说明](../releases/1.0.0-alpha.49.md)。原始功能及包验证记录保留。
- 已确认 master 与 origin/master 同步，上一公开标签对应源码 7a3700ee5ef69c762fa569197097816de8be57c3。准备以本轮源码提交作为新标签目标；最终正文由实际 Git 日志生成提交链接和比较链接，不提交占位 SHA。
- 复用已验收的正式 NSIS、完整 portable 目录和 ZIP，应用代码未继续修改；版本与资源保持一致。更新说明使用最终 Release 正文重新生成签名元数据并验签，不修改 EXE/web 资源。
- 发布顺序：提交推送与标签 → 草稿 Release 及上传 → 核对资产 → 公开发布 → 无认证完整下载和生产验签 → 发布在线预览索引。具体结果随实际索引发布提交追加。
- 107 项校验、105 个 ZIP 文件、101 个资源一致性、实际 EXE 启动、生产签名/篡改拒绝及正式 SQLite ER 验收已通过；再次验签使用窄范围临时编译，不生成完整 debug 构建。
- PG 实库、完整升级及长期锁屏识别保留待验收，完成数 5/39，下一规划 R09。没有将本机测试会话、凭据、业务数据库或 .qa/release 临时材料纳入提交。

## 实际发布结果

- 已公开预发布：[alpha.49](https://github.com/SerLiunx-ctrl/dbfolio/releases/tag/v1.0.0-alpha.49)；源码目标 [dc41ba3](https://github.com/SerLiunx-ctrl/dbfolio/commit/dc41ba3d0293277ad1ff405c4cab3695213907e9) 与标签均已推送 master。
- 比较范围为 [v1.0.0-alpha.43...v1.0.0-alpha.49](https://github.com/SerLiunx-ctrl/dbfolio/compare/v1.0.0-alpha.43...v1.0.0-alpha.49)，仅包含 2093269 和 dc41ba3 两条真实提交；最终双语正文附原题与完整提交链接，链接 HTTP 200。
- 8 个上传资产的 API 大小、SHA256 digest 与本地一致；公开后逐项无认证下载完整字节，大小与 SHA256 全部一致。下载的安装包、ZIP 与签名更新元数据经生产验证器验签、资源解包校验及篡改拒绝通过。
- Release 正文与最终签名索引 notes 严格逐字一致；公开元数据与索引内签名载荷字节一致。公开验证完成后才复制索引到 updates/preview.json，随本发布索引提交推送；stable.json 保持不变。
- 原始材料：本地 .qa/alpha49-public-verification.json、alpha49-public-signature-check.log 和最终正文；本机测试会话与密码未提交。在线索引推送后的客户端复核另记本地验收。
- 发布验签临时编译缓存已清理 0.12 GiB；target 4.79 GiB，C 盘剩余 283.60 GiB。既有 PG/完整升级/锁屏保留项与 5/39 不变。
