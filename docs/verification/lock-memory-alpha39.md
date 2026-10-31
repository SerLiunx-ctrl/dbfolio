# alpha.39 长时锁屏 OOM 防护验收

日期：2026-10-29。

## 已确认与限制

用户反馈近期版本、MySQL 数据页、没有未提交修改或运行任务，长时间锁屏后再次出现 WebView Out of Memory。既有日志没有 WebView 退出原因，不能证明具体分配源；当次内存曲线与转储缺失。旧资源回收依赖切换页签，锁屏没有改变活动页签，属于已确认的覆盖缺口。当前系统内存快照不能代表出错时状态。

Windows 原生线程只读探测输入桌面与应用桌面，安全桌面/锁屏访问受限时标记非交互。两秒检查、仅状态变化发事件；前端结合 visibilitychange，将当前关系型表/查询也转为非活动资源策略。清洁表格卸载网格、30 秒后释放行数据；未提交和无效输入不回收。WebView2 MemoryUsageTargetLevel 只是内存目标提示，不保证立即回收或消除泄漏。不使用全局 TrySuspend，以免暂停任务协调与状态保存。

原生 ProcessFailed 记录类别、原因、退出码、版本；渲染进程退出后由原生线程提供确认恢复，未确认不刷新，不重做 SQL。恢复未保存的网格编辑尚无跨渲染进程保证，确认框明确提示。

## 受控验证

- scripts/check-lock-idle.cjs：MySQL/PG/SQLite 模拟活动数据页锁屏；清洁页面卸载/超时回收、解锁单次重新读取通过；有效待提交、含无效输入及仅无效输入的 30 秒保护通过，没有写入 IPC。
- 使用真实 React/AG Grid/Monaco 与隔离 IPC；没有锁定用户电脑、读取凭据或写入用户数据库。模拟计时不等于真实数小时锁屏复现。
- TypeScript 与正式配置 Rust 库检查通过。首次默认开发检查的依赖进程异常退出；改为限制并发、正式配置库检查通过，正式包仍走完整构建。

## 原生与正式交付

- scripts/check-webview-crash.ps1 启动独立本地配置与 WebView 缓存，只终止核验父子关系/创建时间的隔离渲染进程；收到 ProcessFailed 日志，检测到所属主进程原生确认框，未确认没有前端重新初始化。此为受控终止，不是真实 OOM。
- npm run app:build 正式构建通过；107 项校验、105 个 ZIP 文件、101 个安装/便携资源匹配通过；两套真实 EXE 启动、IPC、生产签名与篡改拒绝通过。
- 无编译进程时清理临时 debug 及正式配置检查产生的孤立 rmeta；target 约 3.56 GiB，C 盘剩余约 286.32 GiB。保留正式交付、有效 rlib 与用户数据。
- 尚未提交或公开发布；完整安装升级未执行。真实长时间锁屏和实际 OOM 复现仍待复测。

参考：[WebView2 性能与内存建议](https://github.com/MicrosoftDocs/edge-developer/blob/main/microsoft-edge/webview2/concepts/performance.md)、[进程异常事件](https://github.com/MicrosoftDocs/edge-developer/blob/main/microsoft-edge/webview2/concepts/process-related-events.md)。
