# 2K 数据网格滚动性能验收

版本：1.0.0-alpha.13；日期：2026-10-19。

## 定位结论

用户反馈表数据页在 2K 屏幕滚动卡顿。代码检查确认已有行、列虚拟化；后台无修改表页在 300ms 后卸载网格，30 秒后释放行数据，查询后台也卸载结果网格。本轮没有将多标签页直接认定为根因。

确认并消除的可见单元格额外开销：

1. 所有单元格原先都创建 React 图片组件，普通字符串进入 Base64 判断和全文扫描；表格还逐格查找主键、建立补读闭包。高分辨率下可见单元格更多，滚动过程中会反复创建这些对象。
2. 日志和 JSON 虽然被 CSS 省略，完整文本仍进入 DOM 和文字布局。
3. 原先 data URI 判断会将整个大字符串转换为小写，而实际上只需检查前五个字符。

改为普通值原生文本渲染、图片签名快速筛选后按需挂载图片组件、主键位置按列缓存、展示文本最多 256 个 UTF-16 单位（不切断代理对）。保留完整底层值、编辑/提交、复制、详情和应用导出路径，维持既有虚拟化及紧凑行高。

## 生产构建基准

- 工具：同机无头 Microsoft Edge 155.0.4283.62 + Playwright/CDP，Vite 生产构建；禁用浏览器后台节流。只使用合成数据，不访问业务数据库。
- 视口：2560×1440；网格左侧留 370px、顶部留工具栏位置；570 行 × 20 列，包含 UUID、日期、数值和长日志/JSON，OLED 主题。
- 每次沿纵向滚动 180 个动画帧，每步 130px，先下后上；表数据/SQL 结果各三次，下面为中位数。计时包含滚动期间主线程工作及采样开销。
- 基线在修改前独立构建并固定输出目录；优化后使用另一个目录，避免开发热更新或源码改变影响基线。

| 指标 | 表数据：之前 → 之后 | 查询结果：之前 → 之后 |
|---|---|---|
| 主线程任务耗时 | 1639.6 → 1382.5ms（减少约 16%） | 1784.4 → 1439.7ms（减少约 19%） |
| JavaScript 耗时 | 746.1 → 645.6ms | 861.8 → 699.9ms |
| 布局耗时 | 254.2 → 143.7ms（减少约 44%） | 274.2 → 143.1ms（减少约 48%） |
| 结束时页面 DOM 节点 | 2831 → 1811 | 2833 → 1813 |
| 滚动期间 Base64 解码调用 | 12375 → 0 | 12375 → 0 |
| 最大渲染行/单元格数 | 57 / 1197，前后相同 | 57 / 1197，前后相同 |
| 数据库 IPC 调用 | 0 → 0 | 0 → 0 |

原始数据：[优化前](grid-scroll-before.json)、[优化后](grid-scroll-after.json)。本机合成场景前后均未出现超过 50ms 的长任务，帧间隔 P95 约 14ms；因此本次证明减少了渲染开销，**没有在真实 WebView2 中复现并量化用户现场掉帧**。实际数据、缩放、显示刷新率、显卡/驱动和其他进程负载仍会影响体验，不能将这些百分比宣称为用户帧率提升。

## 功能回归

- `npm run build`：通过（包含 TypeScript 检查）。
- `scripts/check-grid-rendering.cjs`：通过。MySQL/PostgreSQL/SQLite、浅色/暗色/OLED、长文有界展示、HTML 字符按文本显示、完整原文编辑/复制/详情、保存值不被展示截断、文字转图片及刷新卸载。
- `scripts/check-image-preview.cjs`：通过。三引擎图片预览、截断限量补读、并发上限、原图与原文复制、无主键/只读/查询结果、误识别、刷新竞态。
- `scripts/check-image-highres.cjs`：通过。3200 万像素缩略图、9Mi 字符 PNG、参数/MIME 别名、原图导出/取消/失败和 Blob 回收。
- `scripts/check-value-colors.cjs`：通过。类型色、主题变化、NULL 斜体与类型优先级。
- `scripts/check-data-preview.cjs`：通过。修改/新增/删除、部分提交、废弃与失败预览保护。
- 本轮仅调整前端渲染，不修改数据库适配或 SQL；引擎界面回归采用模拟 IPC，不表示重新执行了三个引擎的实库验收。

## 复现

安装项目依赖后，构建独立生产夹具：

```powershell
npx vite build --config scripts/vite-grid-benchmark.config.mjs
npx vite preview --config scripts/vite-grid-benchmark.config.mjs --host 127.0.0.1 --port 1426 --strictPort
```

另一个终端运行（需可用的 Playwright 和 Microsoft Edge）：

```powershell
# 若 Playwright 不在默认模块路径，用 PLAYWRIGHT_MODULE 指向已安装模块。
$env:GRID_BENCH_URL='http://localhost:1426'
$env:GRID_BENCH_REPORT='.qa/grid-measurement.json'
node scripts/check-grid-scroll.cjs
```

`GRID_BENCH_OUT` 可为前后版本指定独立构建目录，构建及 preview 使用相同值；不把耗时阈值当成跨机器硬断言。功能回归需先在 1425 端口启动 Vite 开发服务。

## 正式交付

`npm run app:build` 已完成正式 LTO 构建与 NSIS 打包；EXE 自检外置资源通过。独立复核两份 SHA256SUMS 共 107 条、ZIP 内 105 个文件与 portable 目录一致。版本源文件、资源清单和 distribution.json 均为 1.0.0-alpha.13。本轮尚未提交或推送。

产物目录：`release/1.0.0-alpha.13/`。

- 安装包：`DBFolio_1.0.0-alpha.13_windows_x64_setup.exe`，11427856 字节。
- 便携目录：`DBFolio_1.0.0-alpha.13_windows_x64_portable/`（EXE + web/ 等完整资源）。
- 便携 ZIP：`DBFolio_1.0.0-alpha.13_windows_x64_portable.zip`，16241909 字节。
- 两份独立清单：`DBFolio_1.0.0-alpha.13_windows_x64_setup_SHA256SUMS.txt` 与 `DBFolio_1.0.0-alpha.13_windows_x64_portable_SHA256SUMS.txt`。

安装包 SHA256：`0a37ff6bc9050902010a94664e02dd5201b9c69702d7de535f0ad7459d779b49`。

便携 ZIP SHA256：`77ede84040f5f1db85cf30e8dcd8d5b0b50c165a7ab1d4ecffc26c8ce8cbf2d6`。
