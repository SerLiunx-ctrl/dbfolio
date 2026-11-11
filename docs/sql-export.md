# MySQL SQL 文件导出与类型保真

版本：1.0.0-alpha.56；日期：2026-11-10。

SQL 文件使用服务端完整值生成可执行 SQL，不经过数据网格的截断预览或 JavaScript 数值转换。文件菜单及对象树的「导出 SQL 文件」共用此路径；CSV、JSON、Excel 使用另一套数据导出接口。

| 类型 | SQL 文件中的表示 |
| --- | --- |
| SQL NULL | `NULL`，与空字符串、JSON null 分开 |
| BIT | `b'0'`、`b'1'`、`b'101'` 等位字面量，支持至 64 位 |
| 整数、Decimal、Double、Year | 服务端生成的数字文本，不经浮点中转处理精确数值 |
| FLOAT | 先把已存值提升为 DOUBLE 表达式再转文本，避免有效位不足 |
| 字符串、日期时间、JSON、ENUM、SET | UTF-8 十六进制加 `CONVERT(... USING utf8mb4)`，保留引号、反斜杠、中文及控制字符 |
| BINARY、VARBINARY、BLOB | `X'...'` 字节字面量，空二进制为 `X''` |
| 空间类型 | `ST_GeomFromWKB(X'...', SRID)`，同时识别 `geomcollection` / `geometrycollection` |

- 生成列不写入 INSERT；隐藏列按明确列名导出，避免 `SELECT *` 漏列。
- 导出头保存导入连接的模式、时区、字符集和外键设置；临时兼容零日期、部分零日期及历史无效日历日期，同时保留其他严格校验。文件结尾恢复原设置，不修改数据库全局 SQL_MODE。
- BIT 旧版可能生成 `X'0'`、`X'1'`、`X'FFF'` 等奇数位十六进制，不能执行。升级后应重新导出，再在目标库导入；不对旧 SQL 文件进行盲目全局替换。
- 无法生成完整 SQL 值时，报错包含表名、字段和类型，保留既有目标文件；不将异常值悄悄替换为 NULL。
- 本轮验收以本机 MySQL 为准；具体类型、模式、数据和文件组织覆盖见[验收记录](verification/sql-export-types-alpha56.md)，不据此声明所有服务器版本及厂商扩展均已验证。

依据：[MySQL 位字面量](https://dev.mysql.com/doc/refman/8.4/en/bit-value-literals.html)、[十六进制字面量](https://dev.mysql.com/doc/refman/8.4/en/hexadecimal-literals.html)。
