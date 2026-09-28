# Base64 图片预览验收（1.0.0-alpha.4）

日期：2026-09-28。按用户最新要求优先实施；路线图仍完成 4/39，下一项 R05，未把 R15 的部分能力标记为整体完成。

## 行为与范围

- SQL 表数据与查询结果使用同一图片单元格组件。识别成功显示 42×22 像素缩略图，保持 28 像素行高；单击打开完整图片，默认适应窗口，可切换原始尺寸滚动查看。图片详情可切换原始文本并复制，预览不改写字段。
- 支持 PNG、JPEG、GIF、WebP、BMP 的 `data:image/...;base64,` 和无前缀 Base64；兼容换行、空白、URL-safe 字符及省略末尾填充。通过文件签名、尺寸及完整性特征识别，最终由浏览器解码；不是仅凭字段名或 MIME 文案猜测。
- 不支持的格式、普通 Base64、非图片文本和解码失败内容保持文本。SVG、远程图片 URL、嵌套 JSON 内部图片、二进制 BLOB 不在本次自动图片识别范围，不加载外部图片地址。
- 大字段截断值只有在可见、有主键、当前行为已保存数据的表格中才尝试补读，自动读取并发最多 2 个，单值最多 512 Ki 字符。超出自动读取大小时保留「图片 · 点击查看」入口，点击按主键最多读取 8 Mi 字符。SQL 在服务器侧判断长度，过大值返回 NULL，避免自动传回整段大字段。
- 完整图片识别上限为 8 Mi 字符、边长 16384、总像素 2400 万；超限内容回退文本。边界为尽力预览策略，不改变原始内容，也不阻止原有完整值编辑入口。
- 查询结果无可靠的表/主键定位，不补读截断内容；无主键表同样保留截断文本。完整值仍可直接显示图片。只读会话可看图，但不会启用编辑；刷新后废弃旧请求结果。
- 现有「查看/编辑完整值」及复用 `ValueEditor` 的纯文本详情也提供图片/原文切换；MongoDB 文档中的嵌套 JSON、Redis 专用值编辑器未扩展为图片画廊。

## 验证证据

- `npm run build` 通过。
- Rust `commands::query::image_read_tests::bounded_image_read_preserves_text_and_skips_large_values`：真实内存 SQLite 验证长度限制、完整文本保留及 NULL；MySQL/PostgreSQL 验证生成 CHAR_LENGTH 与上限。原有未传上限的完整值读取保持原行为。
- `scripts/check-image-preview.cjs`：MySQL/浅色、PostgreSQL/深色、SQLite/OLED 的合成 IPC 界面回归；PNG/JPEG/WebP 显示、GIF/BMP 识别、纯 Base64/URL-safe/换行、截断补读、可见范围、并发限制、原图/原文复制、固定行高、只读、无主键、查询结果及刷新竞态。
- 负例：普通文本、普通 Base64、SVG、URL、截断/损坏 PNG、超大字符串和异常尺寸图片。前端使用本地生成的测试图片，未读取或修改用户业务库。
- 前端跨引擎回归使用合成 IPC，并非 MySQL/PostgreSQL 图片列真实服务器验收；后端实际长度执行测试覆盖 SQLite。
- WebP 头部尺寸读取依据 [官方 RIFF 容器说明](https://developers.google.com/speed/webp/docs/riff_container)及[无损格式说明](https://developers.google.com/speed/webp/docs/webp_lossless_bitstream_specification)。
- `npm run app:build` 正式构建通过；`release/1.0.0-alpha.4/` 中安装包、完整 portable 目录/ZIP 和两份 SHA256SUMS 已交付。内置资源校验、104 个目录/ZIP 文件摘要、NSIS 110 个资源完整性及两份清单全部通过。
- 代码尚未提交。
