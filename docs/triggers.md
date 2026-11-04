# 触发器管理

版本：1.0.0-alpha.55；日期：2026-11-04。

- 从表页顶部的闪电「触发器」或对象浏览器数据库/表右键进入独立页签；表入口默认仅显示当前表，支持打开全库列表。页签按会话、数据库、表和 schema 去重，可随工作区恢复。
- 列表可搜索名称、对象、时机和事件，调整列宽；选择条目查看 SQL 语法高亮定义，可复制或在查询中打开。
- 新增时填写名称并选择对象、时机、事件；MySQL/MariaDB 和 SQLite 编辑 BEGIN…END 主体，PostgreSQL 选择已有的无参 trigger 函数。PostgreSQL 页面提供查询中的函数模板入口，由用户自行编辑执行。
- 普通可完整还原的定义可结构化编辑；复杂语法、特殊属性或禁用态等不能保证保真的对象保持只读并说明原因，避免保存丢失原属性。可以查看、复制或明确确认删除。
- 保存/Ctrl+S 和删除先显示服务器生成的 SQL 预览，需明确确认；关闭/切换条目时进入统一保存/废弃保护，生产会话沿用额外输入确认。只读会话禁止写入；MySQL/MariaDB 限定数据库范围的会话继续禁止触发器写入。
- PostgreSQL/SQLite 在事务内替换；MySQL/MariaDB DROP + CREATE 不保证整体回滚，失败时以后台报告的恢复情况为准。执行前乐观核对原定义，检测到其他客户端修改时拒绝覆盖；不等于锁住其他客户端，不自动重试不确定的写入。

MySQL 8.4.6 与 SQLite 已通过正式 EXE 的创建、实际触发、修改、失败保旧/回滚和删除验收。PostgreSQL 实库按用户既有决定仍待验收，本次不启动或创建该实例；MariaDB 容器本轮未运行，实库补验保留。详见[验收记录](verification/triggers-alpha55.md)。

语法依据：[MySQL CREATE TRIGGER](https://dev.mysql.com/doc/refman/8.0/en/create-trigger.html)、[PostgreSQL CREATE TRIGGER](https://www.postgresql.org/docs/current/sql-createtrigger.html)、[SQLite CREATE TRIGGER](https://www.sqlite.org/lang_createtrigger.html)。
