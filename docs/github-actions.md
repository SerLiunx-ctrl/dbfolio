# Windows 与 macOS 云构建

GitHub Actions 的 **Desktop build** 工作流位于 `.github/workflows/desktop-build.yml`。在仓库的 **Actions → Desktop build → Run workflow** 中选择分支和平台：`all`、`windows`、`macos`。相关源码、构建脚本或离线文档更新到 `master`，以及相应 Pull Request，也会自动构建。

## 构建矩阵与产物

| 平台 | GitHub runner | 产物 |
|---|---|---|
| Windows x64 | `windows-2025` | NSIS 安装包、完整便携版 ZIP、分别对应的 SHA256 清单、构建信息 |
| macOS Apple Silicon | `macos-15` | DMG、保留权限与签名结构的完整 .app ZIP、SHA256 清单、使用说明、构建信息 |
| macOS Intel | `macos-15-intel` | 同上，独立 x64 产物 |

工作流固定 Rust 1.98.1、Node.js 24；npm 与 Cargo 使用已检入的锁文件。Rust 依赖按平台缓存。三个平台独立完成，一个失败不会中止其他平台。

打开某次运行，在底部 **Artifacts** 下载对应平台的包；产物保留 **14 天**。若启动检查失败，可下载保留 7 天的 `diagnostics-*`。下载的 Artifact 外层 ZIP 中包含安装包、便携包及校验清单，Windows 便携包需再次完整解压。

云构建只上传 Actions 产物，不创建 GitHub Release、不修改版本号、不上传更新索引。包内构建信息记录源码提交和运行链接，方便区分同版本的不同构建。后续正式发布需经过验收并沿用现有发布流程。

## Windows

复用 `npm run app:build`，包含正式优化编译、NSIS、完整便携目录打包、资源校验及隔离的 WebView2 启动/前端 IPC 检查。云 runner 无本机更新密钥，初始工作流不配置任何签名 Secrets，因此不生成签名在线更新包或修改在线更新通道。Windows 代码签名也未配置。

## macOS

本地 macOS 可运行：

```sh
npm ci
npm run app:build:macos
# 原生对应架构的 target 也可显式指定：
npm run app:build:macos -- --target aarch64-apple-darwin
```

`src-tauri/tauri.macos.conf.json` 使用 Tauri 的平台配置合并机制，覆盖 app/DMG、关闭 Windows Mica 与透明窗口，并使用 ad-hoc 签名。前端资源从 `DBFolio.app/Contents/Resources/web` 加载，密码使用 Keychain。

打包脚本会执行实际 .app 二进制的 `--verify-resources`，核对所有资源摘要、CPU 架构及代码签名结构；工作流另用全新的隔离配置运行应用，确认版本和前端 IPC 就绪后结束该测试进程。

这些检查不代表 macOS 桌面功能已全面验收。Command 快捷键、菜单、剪贴板、Keychain 授权、文件选择、数据库连接、休眠恢复、安装/升级等仍需可交互 Mac 验收。现阶段 macOS 在线更新入口返回明确的暂不支持提示，避免下载 Windows 安装包；使用手动替换完整 .app 升级。

ad-hoc 测试包没有经过 Apple Developer ID 签名或公证，下载后可能被系统拦截。正式对外分发时再接入 Developer ID 证书与公证凭据，使用 GitHub Secrets 管理，不将密钥写入仓库。

## 参考

- [Tauri GitHub Actions 构建](https://v2.tauri.app/distribute/pipelines/github/)
- [GitHub runner 镜像与架构](https://github.com/actions/runner-images)
- [Tauri macOS 签名与公证](https://v2.tauri.app/distribute/sign/macos/)

## 发布 Windows 版本

更新应用版本并提交发布说明。在对应源码提交的 **Desktop build** 运行中下载 Windows x64 产物，核对 `build-info.json` 的版本、提交和架构。将安装包、便携 ZIP 和两份校验清单放到 `release/<版本>/`，再原样解压便携 ZIP 到该目录。

在有现有更新签名私钥的 Windows 机器上，使用最终双语说明执行 `scripts/create-update-feed.ps1 -Version <版本> -NotesPath <说明文件>`，再运行 `scripts/check-update-release.ps1 -Version <版本>`。建立 GitHub Release 草稿，把目标指定到构建的完整提交 SHA，上传两个包、两份 SHA256、两个包签名、更新元数据及其签名。草稿正文使用同一份说明。预发布版本应标为 prerelease。

在 **Actions → Publish Windows release → Run workflow** 选择 `master` 并输入版本。工作流校验草稿、标签目标、签名及包的校验和，公开 Release 后重新匿名下载全部资产，通过 SHA256 对比后将签名索引写入对应通道。如果公开下载校验失败，可以修复后重跑同一版本。签名私钥留在本机。
