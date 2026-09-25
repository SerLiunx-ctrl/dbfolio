# DBFolio

## 文档规则

- 设计文档：`docs/design.md`。任何功能调整、新增功能、决策变更，必须同步更新设计文档，并在「21. 变更记录」追加条目（版本号、日期、变更内容）。
- 实现完成后需在「20. 实现状态」更新对应模块状态与已知偏差。
- 文档与 UI 文案使用中文，代码标识符使用英文。

## UI 设计原则

- 紧凑是贯穿全软件的设计原则：默认使用小号控件、短间距和紧凑行高；避免无意义的大留白和说明文字。
- 同排控件高度一致，禁止多行字段拉伸其他控件；中文在缩放后也不得裁切。
- 枚举及服务器可发现的选项优先使用下拉选择，关联项需联动；长文本独立排布。

## 已锁定决策

- 技术栈：Tauri 2 + React + TypeScript + Fluent UI v9；Rust 侧 sqlx 驱动 MySQL / PostgreSQL / SQLite。
- 同步功能：首版仅同引擎同步（同引擎 A→B），统一元数据模型预留跨引擎能力。
- 本地存储：SQLite（配置/历史，`%APPDATA%/data-workbench/app.db`）+ Windows 凭据管理器（密码）。旧目录及凭据服务名保留，用于兼容更名前的数据。

## 开发命令

- 开发运行（热重载）：`npm run tauri dev`（需 `%USERPROFILE%\.cargo\bin` 在 PATH）
- 生成免安装可执行文件（正式，LTO）：`npm run app:build` → 输出 `release\DBFolio.exe`
- 生成免安装可执行文件（快速迭代，无 LTO）：`npm run app:build:fast` → 同一路径，首次约 2 分钟、之后增量约 30-60 秒；运行时性能略低于正式版
- 前端构建：`npm run build`
- Rust 检查：`cargo check` / `cargo test`（在 `src-tauri/` 下）
- Rust 工具链：stable 1.98.1（MSVC）；crates.io 与 rustup 均配置 rsproxy.cn 镜像

## 注意事项

- 不要对项目根目录执行 `npm create tauri-app --force` 之类会清理目录的脚手架命令；docs/ 与 AGENTS.md 必须保留。
- 重要文档修改后建议提交 git，避免被工具误删。
