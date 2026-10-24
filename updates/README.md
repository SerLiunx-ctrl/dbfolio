# 更新索引发布

2026-10-24：alpha.16 [预发布](https://github.com/SerLiunx-ctrl/dbfolio/releases/tag/v1.0.0-alpha.16) 与 `preview.json` 已公开，实际客户端检查通过。使用 alpha.16 时选择「预览版」通道；当前同版本会显示「当前没有可用的新版本」。稳定通道等待首个正式版索引，完整跨版本升级仍待验收。

此目录保存实际已发布版本的 `stable.json` / `preview.json`。没有可下载的签名发布包时不放占位索引，以免把“未发布”误报成“已是最新版”。

1. 执行 `npm run app:build`，生成正式安装包、完整 portable 和 ZIP、独立校验清单；构建必须通过隔离的真实启动检查（可见窗口与前端 IPC 就绪）。再执行 `scripts/check-update-release.ps1`，核对签名、安装器资源及安装/便携两个入口的真实启动，资源自检不能替代启动验收。
2. 有签名私钥时，构建自动执行 `scripts/create-update-feed.ps1`；也可传 `-NotesPath` 使用中文发布说明重新生成索引。
3. 上传 `release/<版本>/` 的安装包、portable ZIP、两个 `.sig`、校验清单和 `release-metadata.json` / `.sig` 到对应 GitHub Release（标签 `v<版本>`）。
4. 从实际下载地址核对文件和签名后，将生成的 `preview.json`（预发布）或 `stable.json`（正式版）复制到本目录并提交推送。**最后发布索引，禁止先放索引后传包。**
5. 用已安装的前一版完成真实检查、下载、签名、退出保护、升级与就绪验证。没有完成这一步，R06 保持待验收。

客户端地址在 `src-tauri/update-config.json`。索引是 Tauri 静态 JSON，额外包含签名元数据，绑定版本、地址、包签名及更新说明。私钥不得进入仓库，索引生成脚本不会自动上传或推送。

本机加密私钥保存于 `%USERPROFILE%/.dbfolio-signing/updater.key`，随机密码由同目录 `password.dpapi` 使用 Windows 当前账户保护。Windows DPAPI 文件不能作为跨电脑备份；发布者需要另行离线备份私钥与解密密码。其他机器/CI 显式提供 `TAURI_SIGNING_PRIVATE_KEY` 和 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。私钥丢失可能导致现有客户端无法接收后续签名更新。

普通本地构建无私钥时仍可生成手动分发包，但不会生成在线更新索引。更新签名不是 Windows Authenticode 代码签名，不能替代后者改善系统安装信任提示。

便携版缓存位于 `%APPDATA%/data-workbench/updates/<任务ID>/`，包含 `plan.json`、`journal.json`、失败时的 `error.json`、完整更新包和 `app-before-update.db`。旧程序保留为原目录同级 `.dbfolio-old-<任务ID>`；不自动清理备份。失败后可在完全退出应用时执行缓存内 `DBFolio-update.exe --recover-update "<缓存路径>/plan.json"` 恢复程序目录。若已出现 `data-opened.json`，说明新版访问过本地数据，必须先确认数据库结构兼容，不能只恢复旧 EXE 或自动覆盖用户的 app.db。远程数据库及用户 SQLite 文件从不由更新器恢复。

安装版安装前在相同缓存下生成 `installed-before-<ID>/`，保存旧 EXE、验证过的 web 和 `recovery.json`。数据库快照在缓存根目录；多次安装尝试保留不同快照，不覆盖第一次备份。旧程序资源可供修复，但不等同于恢复 NSIS 安装登记；需要完整回退安装状态时使用对应旧版安装包，并先核对本地数据兼容性。
