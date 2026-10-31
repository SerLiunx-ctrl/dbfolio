# alpha.43 公开发布与更新索引

日期：2026-10-31；版本：1.0.0-alpha.43；公开预发布：[GitHub Release](https://github.com/SerLiunx-ctrl/dbfolio/releases/tag/v1.0.0-alpha.43)。

- 本次汇总 alpha.34～43。最近实际公开基线为 v1.0.0-alpha.33，源码目标为 [7a3700e](https://github.com/SerLiunx-ctrl/dbfolio/commit/7a3700ee5ef69c762fa569197097816de8be57c3)；该目标已推送到 master，v1.0.0-alpha.43 指向该提交。
- 已核对真实范围 v1.0.0-alpha.33...v1.0.0-alpha.43：包含 fe8d5a8 与 7a3700e 两条提交，最终正文保留原题并提供完整 SHA 链接，三个提交/比较页面 HTTP 200，无占位记录或空贡献者栏目。
- Release 正文依次为中文、English、提交记录 / What's Changed、Full Changelog。最终正文与签名更新说明逐字一致；重新生成并验证最终签名元数据，未修改已验收的 EXE、web 资源、安装包或 ZIP。
- 发布前 107 项校验、105 个 ZIP 文件、101 个安装版/便携版资源一致性、真实 EXE 启动和 IPC、生产验签与篡改拒绝通过。
- 8 个资产上传后核对 GitHub API 大小及 SHA256 digest；公开发布后使用无认证下载地址逐项下载完整字节并与本地 SHA256 比对，全部通过。生产 update_package.rs 校验器再次验证公开安装包、ZIP、最终元数据、资源解包及篡改拒绝，通过。
- 公开资产验证完成后才将最终签名索引写入 updates/preview.json。此记录及索引随实际发布索引提交推送；客户端地址的在线复核结果另记本地发布材料。stable.json 不变。
- 未执行日常用户环境中的完整安装升级；PG 实库按约定待补验，持续锁屏识别仍不可靠，不宣称 OOM 根治。R06/R07 不勾选，完成 5/39，下一项仍为 PG 补验后 R08。
- 临时验签编译目录已清理；target 4.25 GiB，C 盘剩余 290.91 GiB。保留正式交付、源码和用户数据。

原始下载、摘要和验签材料在本地 .qa/ 下，不将测试配置或业务库内容上传到仓库。
