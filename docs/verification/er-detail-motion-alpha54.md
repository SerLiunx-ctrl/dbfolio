# alpha.54 ER 详情收起与过渡验收

日期：2026-11-04；版本：1.0.0-alpha.54；状态：本轮范围已交付，尚未提交或发布。

## 实现范围

- 同一表头再次点击收起详情，标题按钮与表头空白处共用切换；程序定位、搜索、关联选择保留强制展开语义。
- 详情展开/关闭均有 160ms 轻量出入过渡，退出时保留最后一帧内容并立即设为 inert、aria-hidden，退出结束释放内容；快速反向打开清理旧定时器。
- 关闭按钮将焦点返回表名按钮；隐藏按钮不再冒泡触发表头。拖动结束防误触标记只更新一次，避免 pointerup 在表头和画布之间二次冒泡而误收起。
- 支持减少动态效果设置。详情仍绝对定位于卡片下方，不改变字段行高、连线锚点、字段展开/折叠或布局保存格式。

## 已通过

- TypeScript 检查。
- 专项 `scripts/check-er-detail-motion.cjs`：MySQL/PostgreSQL/SQLite × light/dark/OLED × 1x/2x，共 18 组，以及 reduced-motion。
- 覆盖二次点击、Enter/Space、关闭按钮、画布 Escape、退场首帧的内容保留与交互禁用、快速 A→B→A、开/关状态拖动后保持与后续键盘切换、隐藏不冒泡、AI 输入保留且无意外取消、字段位置及连线 d 不变。首轮发现的 pointerup 二次冒泡缺陷修复后重跑通过。
- 原 18 组 AI 与详情共存、18 组缩放/快捷键/保存回归及 100 候选顶部采用检查通过。
- 深浅色截图目视确认：`.qa/er54-motion-light.png`、`.qa/er54-motion-dark.png`；专项结果 `.qa/er54-motion-result.json`，其他日志 `.qa/er54-details.log`、`.qa/er54-controls.log`。

## 正式交付与清理

- 正式 EXE 隔离 SQLite 通过：表头开关、退场首帧 inert/aria-hidden、焦点返回、AI 共存，真实外键与 PK/FK/BK、关联高亮、标注删除及保存重开。字段与连线 d 不因详情开关改变。原生记录：`.qa/er54-native-1793758505927/result.json`。
- `npm run app:build` 通过，安装包/完整便携目录/ZIP 位于 `release/1.0.0-alpha.54/`，107 项 SHA256、105 ZIP 文件、101 资源一致性、自检与启动、生产签名及篡改拒绝通过。未执行安装升级或发布索引。
- target 5.08 GiB，C 盘剩余 279.34 GiB。清理窄测试 crate 及过期 rmeta 共 0.14 GiB；清理本轮 WebView2 缓存、解包程序副本，保留截图/日志/JSON/配置/备份，.qa 约 62.5 MiB。未触及正式交付或用户数据，未跳过锁定项。
- 证据：`.qa/er54-package.log`、`.qa/er54-build-recovered.log`、`.qa/er54-disk.json`、`.qa/cleanup-er54-artifacts-result.json`。

PostgreSQL 实库继续按用户既有决定待验收，界面夹具不作为 PG 实库验证；R07 整项不提前勾选。既有 R06/R08 保留项、完成数 5/39 和下一规划 R09 不变。
