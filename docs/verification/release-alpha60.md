# alpha.60 发布准备与验收

日期：2026-11-12；版本：1.0.0-alpha.60；最近实际公开基线：v1.0.0-alpha.56。

- 本次按用户要求汇总 alpha.57～60：操作通知生命周期修复、达梦原生支持、SQL 文件导入与查询脚本、原生 DDL 和共享语法高亮；双语摘要见[更新说明](../releases/1.0.0-alpha.60.md)，专项证据见[通知](toast-lifecycle-alpha57.md)、[达梦](dameng-alpha58.md)、[脚本](dameng-import-alpha59.md)、[DDL](dameng-ddl-alpha60.md)。
- 已核对 GitHub 最近公开版本为 alpha.56，标签目标 77052afbc33ecd740e98d5e876484a87bfb5ba03；开始时本地 master 与远程 master 同步于 6482c24a3de6a2ead41d1929db5edd9b58d15884。alpha.57～60 尚未单独公开，本次比较范围直接从 alpha.56 起算。
- 复用本轮已完成正式构建和验收的 alpha.60 安装包、完整 portable 目录与 ZIP：108 项校验、106 ZIP 文件、102 资源、实际 EXE 启动与生产签名/篡改拒绝通过。27 项 DDL 后端测试、真实 5 对象/12 条 DDL 回放、正式 EXE 5 组检查（含解锁后的实际复制）通过；脚本原文件副本 502 条 SQL 成功。
- 提交推送及标签后，按真实日志生成最终双语正文、可点击提交记录与 Full Changelog；同一正文用于 Release 和签名更新说明。草稿资产核对、公开无认证完整下载及生产验签通过后，才更新预览索引。
- .qa、release、target、用户配置、业务数据库、原始业务 SQL 和私钥不进入提交。R37 仍为部分完成，PG/MariaDB 既有待验收、R06 完整升级与锁屏识别、已记录的 metadata 行高边界和状态栏路径偏差不提前标记修复；完成数 5/39，下一规划 R09。
