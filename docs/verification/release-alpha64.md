# alpha.64 公开发布验收

2026-11-18。Windows x64 预发布。

- [v1.0.0-alpha.64](https://github.com/SerLiunx-ctrl/dbfolio/releases/tag/v1.0.0-alpha.64) 指向 [548ae4c](https://github.com/SerLiunx-ctrl/dbfolio/commit/548ae4c4177d4726cd157129e524558053fe66e9)。上一公开版本为 alpha.63，[完整变更](https://github.com/SerLiunx-ctrl/dbfolio/compare/v1.0.0-alpha.63...v1.0.0-alpha.64) 覆盖两条提交。发布前确认两条提交链接和比较链接均返回 HTTP 200。
- 安装包与完整便携 ZIP 沿用已验收的正式构建。8 项资产从公开地址匿名下载成功，大小及 SHA-256 与本地文件和 GitHub 记录逐项一致。两份清单共 215 项通过。生产验证器验签通过，并拒绝篡改的更新元数据、安装包和 ZIP。GitHub 匿名 API 限流时，使用匿名 Release 页面和资产地址检查公开下载，并通过只读 API 核对远端元数据。
- Release 正文与签名更新说明逐字一致，包含中英文摘要、提交链接及完整版本比较链接。公开下载和验签通过后提交 `updates/preview.json`。
- 功能验收见[报告修复](report-alpha64.md)和[全面测试](full-test-alpha64.md)。真实长时锁屏、已有安装的原位升级、macOS 和外部集群仍待独立验收。
