# alpha.55 发布准备与验收

日期：2026-11-04；版本：1.0.0-alpha.55；最近实际公开基线：v1.0.0-alpha.49。

- 本次汇总 alpha.50～55：任务中心、ER 布局与 AI 共存、范围限制移除、详情开关动画、独立触发器管理及 SQL 预览竞态修复。双语摘要见[更新说明](../releases/1.0.0-alpha.55.md)，各轮原始验收保留。
- 已读取 GitHub Releases 确认最近公开预发布为 alpha.49，标签目标 dc41ba3d0293277ad1ff405c4cab3695213907e9；master 与 origin/master 同步于 11a708b63ad76d14c4fd6808360c027b86025dba。
- 本轮应用代码未继续修改，复用已验收的 alpha.55 NSIS、完整 portable 与 ZIP。107 项校验、105 个 ZIP 文件、101 个资源、真实启动、生产签名/篡改拒绝、MySQL/SQLite 31 项原生检查及 UI 矩阵已通过，见[触发器验收](triggers-alpha55.md)。
- 流程：提交推送及标签 → 从真实 Git 日志生成最终双语正文及 commit/compare 链接 → 重签并验签更新元数据 → 草稿上传和校验 → 公开发布 → 无认证完整下载和生产验签 → 发布预览索引。最终提交与公开验证结果随索引提交记录，不追加单独文档提交。
- 不包含 .qa、release、target、本机会话、业务数据库或密码；不改稳定通道。PG/MariaDB 实库及既有升级/锁屏保留项不提前勾选，完成数 5/39、下一规划 R09 不变。

## 实际发布结果

- 已公开预发布：[alpha.55](https://github.com/SerLiunx-ctrl/dbfolio/releases/tag/v1.0.0-alpha.55)；源码 [812300b](https://github.com/SerLiunx-ctrl/dbfolio/commit/812300b6e532cc74b296d2a7697168c00d50a9b3) 和标签已推送 master。
- 比较基线为最近公开 [v1.0.0-alpha.49...v1.0.0-alpha.55](https://github.com/SerLiunx-ctrl/dbfolio/compare/v1.0.0-alpha.49...v1.0.0-alpha.55)，包含 11a708b 和 812300b 两条真实提交；正文保留原题与完整链接，两个提交及比较链接 HTTP 200。
- 8 项上传资产 API 大小和 SHA256 digest 与本地一致；公开后逐项无认证完整下载，字节数/哈希一致，生产验证器通过签名、元数据、资源解包与篡改拒绝验收。
- GitHub Release 正文与最终签名索引 notes 逐字一致，公开元数据与索引内签名载荷一致；公开验证通过后复制预览索引，随本发布索引提交推送，stable.json 保持原样。
- 清理发布验签临时 target 与下载的安装包/ZIP 副本 0.152 GiB，无跳过项；target 5.16 GiB、C 盘剩余 289.91 GiB，.qa 约 65 MiB。保留正式交付、截图/日志/JSON/配置/备份。
- 证据：.qa/alpha55-public-verification.json、alpha55-public-signature-check.log、alpha55-links-verification.json、cleanup-alpha55-publish-artifacts-result.json、alpha55-publish-disk.json。在线索引推送后的旧客户端检查另记本地验收；不把检查更新等同完整安装升级。
- PG/MariaDB 实库、完整升级与长时锁屏识别保留项不变，完成数 5/39，下一规划 R09。
