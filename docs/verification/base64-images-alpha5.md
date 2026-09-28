# PNG / 高分辨率预览与原图导出验收

版本：1.0.0-alpha.5；日期：2026-09-28。

## 改动与边界

- 旧版最大 2400 万像素、8 Mi 字符可能拒绝高分辨率或较大 PNG；本次放宽为 1 亿像素、单边 32768、64 Mi 字符，自动补读上限 2 Mi 字符。
- PNG 按块识别，兼容末尾附加内容、image/x-png 和 Data URL 参数；不替代浏览器完整解码校验。
- 缩略图长边 96、适应窗口长边 2048；显示真实原图尺寸，可切换原始尺寸。GIF 详情保留动画，缩略图可能显示首帧。Blob URL 在不用时回收。
- “导出原图”保存解码后的原始位图字节，不采用画布截图或重新压缩；支持 PNG / JPEG / GIF / WebP / BMP。取消不写文件，格式与扩展名不符时拒绝，临时文件完成后原子替换。
- 超过像素限制但仍在文本上限内的已识别图片可导出；超过 64 Mi 字符、截断查询结果及无主键无法补读时仍显示原文。SVG、URL、BLOB、嵌套 JSON 不在本次范围。
- 未获得用户原始问题 PNG；浏览器回归使用真实生成的合成 PNG 与模拟 IPC，Rust 测试使用真实临时 SQLite 和文件系统，不宣称连接真实 MySQL/PostgreSQL 进行本次验收。

## 验证

- npm run build：TypeScript 与前端资源构建通过。
- cargo test --offline image --lib：2 项通过（SQLite 限长读取、原图字节保留与失败不覆盖文件）。
- scripts/check-image-preview.cjs：MySQL / PostgreSQL / SQLite 三引擎及浅色/深色/OLED，缩略图 28px 行高、原始尺寸/原文、截断读取/并发、无主键/只读/查询、损坏内容/误识别/刷新竞态通过。
- scripts/check-image-highres.cjs：8000×4000 PNG（3200 万像素），96px 缩略图 / 2048px 适应窗口 / 原始 8000px；9 Mi 字符 PNG、IEND 末尾附加字节、MIME 别名/参数、导出原始 Base64 一致性、取消不写文件、失败提示及快速切换模式、Blob 回收通过。
- 已查看高分辨率 PNG 详情截图：控件紧凑、原图尺寸标识正确、图片完整显示。

## 交付

npm run app:build 正式构建成功；交付位于 release/1.0.0-alpha.5/：

- DBFolio_1.0.0-alpha.5_windows_x64_setup.exe
- DBFolio_1.0.0-alpha.5_windows_x64_portable/
- DBFolio_1.0.0-alpha.5_windows_x64_portable.zip
- DBFolio_1.0.0-alpha.5_windows_x64_setup_SHA256SUMS.txt
- DBFolio_1.0.0-alpha.5_windows_x64_portable_SHA256SUMS.txt

便携目录与 ZIP 共 104 个文件逐项 SHA256 一致，NSIS 110 个文件通过完整性检查，两份清单均通过；安装包解压后 101 个 web 文件与便携版及最终 dist 一致。两个 EXE 仅相差 Tauri 的 NSS / UNK 安装类型标记，安装版与便携版资源自检通过。版本目录恰有以上五项。

代码尚未提交。
