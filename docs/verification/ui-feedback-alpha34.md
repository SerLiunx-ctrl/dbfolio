# alpha.34 界面反馈验收

日期：2026-10-28。范围：更新说明排版、外键两端字段定位、网格/详情图标及普通文本校验。

## 已通过

- TypeScript 检查。
- MySQL、PostgreSQL、SQLite × 浅色、暗色、OLED × 100%/200%：外键本地字段、跨库/Schema 引用字段、自引用、键盘定位、滚动/焦点/高亮及页签复用；名称包含中文、点号、引号和方括号。
- 已有目标表结构重命名草稿在引用跳转后保留，元数据调用数不增加；只读仍可定位；三引擎建表草稿的本地/引用/自引用跳转保留 70 个字段；引用不可访问时原表和草稿保留，未发起写入。
- 定位后切换到索引、离开再返回目标页签保留索引页；新的外键定位请求仍可再次定位并保留重命名草稿，旧请求不会重放。
- 三引擎/三主题/双缩放：列管理、单元格详情、停靠与关闭均为有中文提示和无障碍名称的图标；上下间距、图标尺寸和实际切换检查通过。
- 普通中文、[中文说明]、{中文说明} 及 JSON 样式文本均维持 plaintext、无 JSON 诊断标记、正常进入文本待提交；真正的 JSON 字段保留校验，JSON→文本切换不残留标记。
- 文本内有效 JSON 的主动格式化只编辑空白，大整数 9007199254740993123456789 的原文字面量保持。采用 jsonc-parser 的词法编辑，不用 JSON.stringify 重建数据，也不将普通文本模型切成 JSON。
- 更新页三主题/双缩放：Markdown 标题、列表、强调、代码与链接排版；链接经系统浏览器打开，当前应用不跳转；原始 HTML、脚本、图片自动加载和非 http/https 链接被阻止。使用 react-markdown，不启用原始 HTML 扩展。
- 既有网格类型/无效缓冲/列布局/复制粘贴/迟到请求、真实表数据页与提交预览联调、三引擎建表草稿/编辑/关闭保护、索引定位及设置/关于/更新代理下载回归通过。

## 验证边界

浏览器使用真实 React/Fluent/AG Grid/Monaco 组件和隔离 IPC 夹具，不读取用户会话凭据或连接用户数据库；跨库/Schema 检查核对精确目标参数。实际数据库写入与完整跨版本安装升级未在本轮执行。JSON 字段和 MongoDB 文档继续使用 JSON 语法，不将裸中文当作合法 JSON。

## 入口与材料

- scripts/check-foreign-navigation.cjs：关系两端定位、草稿/只读、已有未保存结构和权限失败。
- scripts/check-feedback-ui.cjs：文本语言/精度、图标及间距、更新 Markdown 与外链行为。
- scripts/check-grid-workbench.cjs、check-grid-workbench-commit.cjs、check-create-table.cjs、check-settings-preview.cjs、check-index-navigation.cjs：既有功能回归。
- 忽略目录 .qa/alpha34-* 保存执行日志与截图。正式包构建与签名验收结果在设计文档第 20 节记录。

## 正式交付验收

- npm run app:build 正式构建通过，版本 1.0.0-alpha.34，安装包、完整便携目录及 ZIP 和独立 SHA256 清单齐备。
- 107 条 SHA256、105 个 ZIP 文件与目录一致、101 个安装/便携前端资源一致；两套真实 EXE 资源自检、可见启动与 IPC 就绪通过。
- 使用生产 update_package 模块验签实际安装包、ZIP 和更新索引元数据，篡改拒绝检查通过；未执行完整跨版本安装升级。
- 无编译进程时清理本轮临时 debug 缓存；target 约 3.15 GiB，C 盘剩余约 295.30 GiB，正式 release 产物及用户数据保留。
- 尚未提交或公开发布；updates/preview.json 保持 alpha.33。
