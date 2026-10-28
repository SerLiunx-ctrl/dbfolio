# DBFolio

## 文档规则

- 设计文档：`docs/design.md`。任何功能调整、新增功能、决策变更，必须同步更新设计文档，并在「21. 变更记录」追加条目（版本号、日期、变更内容）。
- 实现完成后需在「20. 实现状态」更新对应模块状态与已知偏差。
- 文档与 UI 文案使用中文，代码标识符使用英文；GitHub Release 及对应对外发布说明按下方发版规则提供中英文双语。
- 功能实施顺序与状态统一维护在 `docs/roadmap.md`。默认按 R01 起的编号顺序推进，用户最新指定的任务优先；开始时更新状态，完成对应范围及验收后勾选并记录日期、版本、验证结果和提交，不把部分实现标记为完成。每次同步更新当前项、下一项和完成数量；调整顺序需记录原因。

## UI 设计原则

- 紧凑是贯穿全软件的设计原则：默认使用小号控件、短间距和紧凑行高；避免无意义的大留白和说明文字。
- 同排控件高度一致，禁止多行字段拉伸其他控件；中文在缩放后也不得裁切。
- 枚举及服务器可发现的选项优先使用下拉选择，关联项需联动；长文本独立排布。
- 跨数据库保持统一设计语言和操作逻辑：同类功能共用交互组件与保存/废弃流程，不得只为某一引擎更新界面。引擎差异通过能力开关、明确说明和后端适配体现；验收覆盖所有适用引擎。

## Git 提交规则

- 提交消息统一使用 Conventional Commits 风格：`类型: 中文说明`，例如 `feat: 新增安装包与便携版构建`、`fix: 修复资源加载失败`。
- 新功能使用 `feat:`，缺陷修复使用 `fix:`；按改动内容选择 `refactor:`、`test:`、`build:`、`ci:` 或 `chore:` 等类型。禁止省略类型前缀。
- 功能说明、设计记录、路线图、验收记录及发布摘要，随对应的 `feat:` / `fix:` 等实际改动一并提交，不再单独使用 `doc:` / `docs:` 或追加一条文档提交。独立的文档/规范新增使用 `feat:`，修正使用 `fix:`，提交说明如实描述文档或规范内容；既有历史提交保留。
- 提交说明概括本次实际改动，保持简洁；推送到当前任务约定的分支，不擅自强制推送。

## 发版说明规则

- 每次正式或预发布的 GitHub Release，正文按「中文」「English」「提交记录 / What's Changed」「Full Changelog」的顺序编写。中英文均需完整说明本版新增、修复、调整及必要的兼容性变化，内容对应，面向用户描述实际效果。
- 更新说明后附本版对应的真实提交记录：保留提交标题，每条提供可点击的 GitHub commit 链接（`https://github.com/SerLiunx-ctrl/dbfolio/commit/<完整SHA>`，显示短 SHA 即可）；有对应 PR 时可补充 PR 链接，不能只列不可点击的哈希或仅放概括性文字。
- 末尾必须附 **Full Changelog** 比较链接：`https://github.com/SerLiunx-ctrl/dbfolio/compare/<上一发布标签>...<本次发布标签>`。基线采用最近一次实际已公开发布的版本，不能直接取版本号减一或引用未发布标签；跨发布线时明确比较基线。首次发布无上一标签时，改为本次标签的完整提交历史链接并说明。
- 提交列表从已核对的 Git 日志范围生成，只列本次发布包含的提交；核对发布标签、目标提交及比较范围。涉及贡献者/PR 的信息必须真实存在，没有新增贡献者时无需添加空的贡献者栏目。
- 双语摘要随功能或修复提交；发布时基于已形成的提交生成最终 GitHub Release 正文和提交链接，无需为回填提交哈希再追加文档提交。上传前核对链接可访问，禁止发布占位 SHA、占位标签或模板文字。
- Release 正文与在线更新说明使用同一份最终发布说明生成；签名后修改更新说明时重新生成并验签索引。公开资产验证通过后再发布更新索引，沿用现有安装包、便携版、校验清单和签名验收规则。

## 已锁定决策

- 技术栈：Tauri 2 + React + TypeScript + Fluent UI v9；Rust 侧 sqlx 驱动 MySQL / PostgreSQL / SQLite。
- 同步功能：首版仅同引擎同步（同引擎 A→B），统一元数据模型预留跨引擎能力。
- 本地存储：SQLite（配置/历史，`%APPDATA%/data-workbench/app.db`）+ Windows 凭据管理器（密码）。旧目录及凭据服务名保留，用于兼容更名前的数据。
- 分发：前端资源外置到 EXE 同目录 `web/`；正式版和测试版均输出完整目录式 portable，禁止恢复单文件 EXE 分发。安装版使用 NSIS；更新需整体替换版本匹配的 EXE 和资源，本地用户数据不随包替换。

## 构建交付规则

- 构建收尾必须检查 `src-tauri/target` 的总占用与磁盘剩余空间，记录本轮结果；超过 20 GiB 时检查并清理过期增量缓存、旧测试产物和不再使用的构建配置，不能长期放任增长。清理前确认没有编译进程、目标路径位于项目构建目录内；保留源码、`release/` 正式交付和用户数据。避免无关的多配置重复编译，验证所需的临时缓存验收后清理。

- 每次代码有改动，完成验证后必须执行 `npm run app:build`，同时交付 NSIS 安装包与完整目录式 portable（目录和 ZIP）；不能只提供测试便携包。纯文档修改无需重打包。
- `portable-fast` 仅用于开发验证，不能替代本次代码变更的正式安装包与便携版交付。
- 所有产物统一放在 `release/<版本号>/`：安装包、完整 portable 目录、portable ZIP，以及各自独立的 `setup_SHA256SUMS.txt` 和 `portable_SHA256SUMS.txt`（文件名带产品/版本/平台前缀）。测试包同样进入对应版本目录，使用 `portable-fast` 后缀及独立校验清单。
- 对外版本从 `1.0.0-alpha` 起算；后续预发布按 `1.0.0-alpha.1`、`1.0.0-alpha.2` 递增，进入 beta/正式阶段再显式调整。package.json、package-lock.json、Cargo.toml、Cargo.lock、tauri.conf.json 和界面显示版本必须保持一致；历史版本记录保留。

## 开发命令

- 开发运行（热重载）：`npm run tauri dev`（需 `%USERPROFILE%\.cargo\bin` 在 PATH）
- 正式构建（LTO）：`npm run app:build` → `release/<版本>/DBFolio_<版本>_windows_x64_setup.exe`、`DBFolio_<版本>_windows_x64_portable/`、对应 ZIP 与两份 SHA256SUMS
- 仅正式便携版：`npm run app:portable`；测试便携版（无 LTO）：`npm run app:build:fast` → 独立 `portable-fast/` 和 `portable-fast.zip`，不覆盖正式版
- 前端构建：`npm run build`
- Rust 检查：`cargo check` / `cargo test`（在 `src-tauri/` 下）
- Rust 工具链：stable 1.98.1（MSVC）；crates.io 与 rustup 均配置 rsproxy.cn 镜像

## 注意事项

- 不要对项目根目录执行 `npm create tauri-app --force` 之类会清理目录的脚手架命令；docs/ 与 AGENTS.md 必须保留。
- 重要文档修改后建议提交 git，避免被工具误删。
