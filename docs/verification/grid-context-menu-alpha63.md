# alpha.63 网格右键二级菜单验收

日期：2026-11-17；状态：本轮范围已交付；尚未提交/公开发布。

## 范围

- 数据页与查询结果共用菜单根容器和子菜单；复制、复制 SQL、粘贴按用途分组，保留原有能力与叶子动作。
- 数据页保持详情、关联、按值筛选、复制为新行和 NULL 的原有上下文；不新增 SQL DELETE/SELECT 功能。查询结果保持只读，不添加写入入口。
- 检查鼠标悬停/点击、方向键进入/返回、Esc 分层关闭、叶子执行后关闭、外部点击和焦点恢复。
- 检查右下边界、宽窄窗口、主题及界面缩放；子菜单通过 Portal 展示，不能被原网格/菜单滚动容器裁切。
- 保留多选、未选行右键目标、空白处和只读/视图保护；原复制精确值、SQL预览、追加/覆盖与待提交回归不能因为菜单重排退化。

## 交付

正式 npm run app:build 成功；LTO编译11分55秒，六处版本一致。

- 共用菜单专项11组：真实悬停/叶子动作、方向键与逐级Esc、外部关闭、空白多选、常用一级动作、只读与缺上下文保护。浅色100%/深色125%/OLED200%下两类网格共6种场景、15次子菜单定位均在窗口内，右侧边界向左翻转；根/子背景不透明、祖先opacity及标签未横向裁切断言通过。
- 原复制粘贴四引擎回归、查询结果复制/目标表预览、6组字段入口、三引擎/三主题文本显示回归通过。旧滚动末行右下边界及SQL弹窗在light/dark/OLED×100%/200%六组通过，无主键新增仍经预览进入待提交。
- 最终标准portable真实EXE与独立新profile、SQLite的5组验收通过：表菜单键盘与焦点恢复；系统剪贴板的单元格与INSERT/UPDATE复制；空白多选复制粘贴2行→待提交→预览→确认→精确回读；实际QueryWorkspace结果目标表选择与SQL复制；真实只读会话隐藏写菜单。NULL/空串/多行与新自增ID正确，SQL复制本身不执行。
- 最终EXE SHA256：06c9d534d8e7792d8378d34ccd21757d634577b9819fb3941d7a9069bcb1daa6。原3种图片剪贴板格式恢复，keeper与测试进程退出；隔离会话剩余0，前端异常0。保留专属SQLite文件作为验收证据，不涉及业务数据。
- 双包108项SHA256、106个ZIP文件、102项安装/便携资源一致；两份真实EXE自检、正常启动/可见主窗口/前端IPC通过，生产签名和篡改拒绝通过。未执行隔离安装升级，R06保留。
- 清理.qa临时WebView/解包/窄验证编译产物0.229 GiB，无跳过；target总占用5.03 GiB，C盘剩余256.23 GiB，.qa保留0.091 GiB。保留源码、脚本、日志、截图、JSON、配置与SQLite/备份、release与用户数据。

夹具/工具诊断：旧table夹具的document zoom改为实际App的transform scale并初始化真实palette，保留125%/200%断言及完整动画。旧边界用例按不存在的自定义class等待而误报，截图/命中/ARIA证明菜单正常；改用真实ARIA根菜单定位后保留原滚动、边界、预览和可读性断言全过。原生脚本的查询按钮选择器按实际Tooltip标签调整，未更改生产行为或放松数据断言。

证据：.qa/grid-context-menu-ui.json、.qa/grid-context-regression-grid.log、.qa/grid-context-regression-result.log、.qa/grid-context-regression-fields.log、.qa/grid-context-regression-rendering.log、.qa/grid63-result-boundaries.log、.qa/alpha63-grid-menu-native-1794903100554/result.json、.qa/grid63-package-verification.json、.qa/cleanup-grid63-artifacts-result.json、.qa/grid63-disk.json。

本轮只调整菜单组织和交互，不新增SQL DELETE/SELECT能力，不将组件兼容验证冒充其他引擎实库补验；此前PG实库及R06完整升级等待项保留。当前未提交/公开发布，5/39，下一规划R09。
