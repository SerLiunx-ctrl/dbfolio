# alpha.56 发布准备与验收

日期：2026-11-11；版本：1.0.0-alpha.56；最近实际公开基线：v1.0.0-alpha.55。

- 本次优先发布 MySQL SQL 文件 BIT、FLOAT、空间集合及历史日期的类型往返修复；完整根因与实库证据见[类型验收](sql-export-types-alpha56.md)，双语摘要见[更新说明](../releases/1.0.0-alpha.56.md)。CSV/JSON/XLSX 已知问题仍独立保留。
- 已核对 GitHub 最近公开版本 alpha.55，标签目标 812300b6e532cc74b296d2a7697168c00d50a9b3；开始时 master 与 origin/master 同步于 010a45cbe48b2214ff70d563992d28ebad7e7eb9。
- 复用已验收的正式双包：107 项校验、105 ZIP 文件、101 资源、实际启动、生产签名与篡改拒绝通过。本机 MySQL 8.4.6 正式 EXE 12 张类型表、29 次导出、51 份 SQL 实际导入及 73 次服务器逐列比较零差异。
- 提交推送及标签后，根据真实日志生成完整双语正文、可点击提交和比较链接；使用同一正文重签更新元数据并验签。草稿上传核对、公开资产完整下载及生产验签通过后，才发布预览索引。
- 不提交 .qa、release、target、用户配置、业务数据库或密码；稳定通道不变。正式安装升级、PG/MariaDB 实库和长时锁屏识别保留项不提前勾选，完成数 5/39，下一规划 R09。



## 实际发布结果

- 已公开预发布：[alpha.56](https://github.com/SerLiunx-ctrl/dbfolio/releases/tag/v1.0.0-alpha.56)；修复源码 [77052af](https://github.com/SerLiunx-ctrl/dbfolio/commit/77052afbc33ecd740e98d5e876484a87bfb5ba03) 与 v1.0.0-alpha.56 标签已推送 master。
- 最近实际公开基线为 [v1.0.0-alpha.55...v1.0.0-alpha.56](https://github.com/SerLiunx-ctrl/dbfolio/compare/v1.0.0-alpha.55...v1.0.0-alpha.56)；包含 1ef5dfd、010a45c、77052af 三条真实提交。正文保留提交原题，三个 commit 链接及比较链接均 HTTP 200。
- 8 项资产上传大小和 SHA256 digest 与本地一致；公开后逐项无认证完整下载，字节数与哈希全部一致。生产验证器对公开下载内容的包签名、元数据、解包及篡改拒绝验证通过。
- Release 正文与最终签名更新 notes 逐字一致，公开元数据与签名载荷一致；验证通过后复制预览索引，随本次发布索引提交推送，稳定通道保持原样。
- 本轮发布清理临时 target、下载安装包/ZIP 副本 0.152 GiB，无跳过项；target 5.61 GiB，C 盘剩余 258.18 GiB，.qa 约 70 MiB。保留 release 正式交付、源码、日志/截图/JSON/配置及备份。
- 证据：.qa/alpha56-public-verification.json、alpha56-public-signature-check.log、alpha56-links-verification.json、cleanup-alpha56-publish-artifacts-result.json、alpha56-publish-disk.json。索引推送后的 alpha.55 隔离客户端检查另记本地验收，不等同完整安装升级。
- SQL 范围已修复；CSV/JSON/XLSX 已知缺陷、PG/MariaDB 实库、完整升级和锁屏保留项不变，完成数 5/39，下一规划 R09。
