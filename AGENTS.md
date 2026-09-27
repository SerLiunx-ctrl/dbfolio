# DBFolio

## 文档规则

- 设计文档：`docs/design.md`。任何功能调整、新增功能、决策变更，必须同步更新设计文档，并在「21. 变更记录」追加条目（版本号、日期、变更内容）。
- 实现完成后需在「20. 实现状态」更新对应模块状态与已知偏差。
- 文档与 UI 文案使用中文，代码标识符使用英文。
- 功能实施顺序与状态统一维护在 `docs/roadmap.md`。默认按 R01 起的编号顺序推进，用户最新指定的任务优先；开始时更新状态，完成对应范围及验收后勾选并记录日期、版本、验证结果和提交，不把部分实现标记为完成。每次同步更新当前项、下一项和完成数量；调整顺序需记录原因。

## UI 设计原则

- 紧凑是贯穿全软件的设计原则：默认使用小号控件、短间距和紧凑行高；避免无意义的大留白和说明文字。
- 同排控件高度一致，禁止多行字段拉伸其他控件；中文在缩放后也不得裁切。
- 枚举及服务器可发现的选项优先使用下拉选择，关联项需联动；长文本独立排布。

## Git 提交规则

- 提交消息统一使用 Conventional Commits 风格：`类型: 中文说明`，例如 `feat: 新增安装包与便携版构建`、`fix: 修复资源加载失败`。
- 新功能使用 `feat:`，缺陷修复使用 `fix:`；按改动内容选择 `docs:`、`refactor:`、`test:`、`build:`、`ci:` 或 `chore:` 等类型。禁止省略类型前缀。
- 提交说明概括本次实际改动，保持简洁；推送到当前任务约定的分支，不擅自强制推送。

## 已锁定决策

- 技术栈：Tauri 2 + React + TypeScript + Fluent UI v9；Rust 侧 sqlx 驱动 MySQL / PostgreSQL / SQLite。
- 同步功能：首版仅同引擎同步（同引擎 A→B），统一元数据模型预留跨引擎能力。
- 本地存储：SQLite（配置/历史，`%APPDATA%/data-workbench/app.db`）+ Windows 凭据管理器（密码）。旧目录及凭据服务名保留，用于兼容更名前的数据。
- 分发：前端资源外置到 EXE 同目录 `web/`；正式版和测试版均输出完整目录式 portable，禁止恢复单文件 EXE 分发。安装版使用 NSIS；更新需整体替换版本匹配的 EXE 和资源，本地用户数据不随包替换。

## 开发命令

- 开发运行（热重载）：`npm run tauri dev`（需 `%USERPROFILE%\.cargo\bin` 在 PATH）
- 正式构建（LTO）：`npm run app:build` → `release/DBFolio_<版本>_windows_x64_setup.exe` 与 `portable/`、`portable.zip`
- 仅正式便携版：`npm run app:portable`；测试便携版（无 LTO）：`npm run app:build:fast` → 独立 `portable-fast/` 和 `portable-fast.zip`，不覆盖正式版
- 前端构建：`npm run build`
- Rust 检查：`cargo check` / `cargo test`（在 `src-tauri/` 下）
- Rust 工具链：stable 1.98.1（MSVC）；crates.io 与 rustup 均配置 rsproxy.cn 镜像

## 注意事项

- 不要对项目根目录执行 `npm create tauri-app --force` 之类会清理目录的脚手架命令；docs/ 与 AGENTS.md 必须保留。
- 重要文档修改后建议提交 git，避免被工具误删。
