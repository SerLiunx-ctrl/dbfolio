# SQLx MySQL 文本类型识别补丁

- 来源：crates.io `sqlx-mysql 0.8.6`，保留原始 MIT / Apache-2.0 许可证与 Cargo 清单。
- 功能修改：`src/type_info.rs` 的 `MySqlTypeInfo::from_column`；另清理 `src/testing/mod.rs` 上游遗留的一处行尾空格。
- 原因：上游使用 `BINARY` 标志区分文本和二进制，但 MySQL 的 `_bin` 文本排序规则也可能设置此标志，使 `CHAR/VARCHAR/TEXT` 被判为 `BINARY/VARBINARY/BLOB`。
- 修复：仅对字符串协议类型，依据返回列的字符集/排序规则编号是否为 `63` 设置类型信息中的二进制标志；保留其他标志及非字符串类型。真正的二进制内容即使恰好是合法 UTF-8，仍按字节处理。
- 依据：[MySQL 官方类型说明](https://dev.mysql.com/doc/c-api/8.0/en/c-api-data-structures.html)。
- 回归：主项目的 `mysql_text_binary_decoding`，覆盖预处理和文本协议、二进制排序规则的中文文本、普通文本、NULL、空串、长文本预览及二进制值；`mysql_r01_r03_roundtrip` 覆盖导入导出。
- 维护：后续升级 SQLx 时核对上游是否已有同等修复，确认后移除本目录及 `[patch.crates-io]` 配置；不能只删除补丁而保留旧版驱动。
