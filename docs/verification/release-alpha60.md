# alpha.60 发布准备与验收

日期：2026-11-12；版本：1.0.0-alpha.60；最近实际公开基线：v1.0.0-alpha.56。

- 本次按用户要求汇总 alpha.57～60：操作通知生命周期修复、达梦原生支持、SQL 文件导入与查询脚本、原生 DDL 和共享语法高亮；双语摘要见[更新说明](../releases/1.0.0-alpha.60.md)，专项证据见[通知](toast-lifecycle-alpha57.md)、[达梦](dameng-alpha58.md)、[脚本](dameng-import-alpha59.md)、[DDL](dameng-ddl-alpha60.md)。
- 已核对 GitHub 最近公开版本为 alpha.56，标签目标 77052afbc33ecd740e98d5e876484a87bfb5ba03；开始时本地 master 与远程 master 同步于 6482c24a3de6a2ead41d1929db5edd9b58d15884。alpha.57～60 尚未单独公开，本次比较范围直接从 alpha.56 起算。
- 复用本轮已完成正式构建和验收的 alpha.60 安装包、完整 portable 目录与 ZIP：108 项校验、106 ZIP 文件、102 资源、实际 EXE 启动与生产签名/篡改拒绝通过。27 项 DDL 后端测试、真实 5 对象/12 条 DDL 回放、正式 EXE 5 组检查（含解锁后的实际复制）通过；脚本原文件副本 502 条 SQL 成功。
- 提交推送及标签后，按真实日志生成最终双语正文、可点击提交记录与 Full Changelog；同一正文用于 Release 和签名更新说明。草稿资产核对、公开无认证完整下载及生产验签通过后，才更新预览索引。
- .qa、release、target、用户配置、业务数据库、原始业务 SQL 和私钥不进入提交。R37 仍为部分完成，PG/MariaDB 既有待验收、R06 完整升级与锁屏识别、已记录的 metadata 行高边界和状态栏路径偏差不提前标记修复；完成数 5/39，下一规划 R09。

## 实际发布结果

- 已公开预发布：[alpha.60](https://github.com/SerLiunx-ctrl/dbfolio/releases/tag/v1.0.0-alpha.60)；功能源码 [8813360](https://github.com/SerLiunx-ctrl/dbfolio/commit/881336017e8a678d6747dc8a6ae9f22c3ee2e7b1) 与 v1.0.0-alpha.60 标签已推送 master。
- 实际比较范围：[v1.0.0-alpha.56...v1.0.0-alpha.60](https://github.com/SerLiunx-ctrl/dbfolio/compare/v1.0.0-alpha.56...v1.0.0-alpha.60)；包含 6482c24、8813360 两条真实提交。提交原题、完整 SHA 链接及比较链接均核对，三个页面 HTTP 200。
- 8 项资产上传大小和 SHA256 digest 与本地一致；公开后逐项无认证完整下载，字节数和哈希全部一致。公开下载的安装包、ZIP 和更新元数据经生产验证器验证，解包、签名与篡改拒绝通过。正式包原始字节与发布前一致。
- Release 正文、最终更新 notes 与签名元数据逐字一致；验证通过后复制预览索引，随本次发布索引提交推送，稳定通道不变。
- 清理 .qa 临时 target 和重复下载产物 0.153 GiB，另清理构建残留 0.09 GiB，无跳过项；target 4.83 GiB、C 盘剩余 261.87 GiB，.qa 0.079 GiB。保留 release 正式交付、源码、脚本、日志、截图、JSON、测试配置、数据库与备份。
- 证据：.qa/alpha60-release-range.json、alpha60-draft-verified.json、alpha60-public-verification.json、alpha60-public-signature-check.log、alpha60-links-verification.json、cleanup-alpha60-publish-artifacts-result.json、alpha60-publish-disk.json。完整安装升级、PG/MariaDB 保留验收、长时锁屏、metadata 行高边界和状态栏路径偏差不以本次发布代替验收；5/39，下一规划 R09。
