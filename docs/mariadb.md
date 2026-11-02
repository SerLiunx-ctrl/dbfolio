# MariaDB 首批兼容

DBFolio 复用 MySQL 协议连接 MariaDB，不新增重复的引擎配置。新建会话选择「MySQL / MariaDB」，连接后按服务器版本识别 MariaDB；会话、只读保护、数据库范围、结构编辑、查询、ER 和数据字典共用原有交互。

## 本机隔离实例

本轮使用 Docker 官方镜像 `mariadb:11.8`，实际服务器为 **11.8.9-MariaDB-ubu2404**。容器 `dbfolio-mariadb`，仅监听 `127.0.0.1:13306`，数据卷 `dbfolio-mariadb-data`，不会占用本机 MySQL 的 3306。数据库 `dbfolio_compat`，普通用户 `dbfolio`；随机密码保存在未跟踪的 `.qa/mariadb.env` 和 `.qa/mariadb-connection.json`，不得提交到 Git。

可复用 `scripts/docker/mariadb.compose.yaml`；将 `mariadb.env.example` 复制为本地忽略文件并填入两个独立的强密码，再运行：

```powershell
docker compose --env-file .qa/mariadb.env -f scripts/docker/mariadb.compose.yaml up -d
docker inspect --format '{{.State.Health.Status}}' dbfolio-mariadb
```

停止容器保留数据：`docker compose --env-file .qa/mariadb.env -f scripts/docker/mariadb.compose.yaml stop`。重启使用 `up -d`。不要在保留数据时执行 `down -v`。

## 能力与差异

- 复用连接、服务器发现的字符集/排序规则/引擎、数据库和表/视图列表、字段、索引、外键与原始 DDL；保留 MariaDB 原始默认值表达式，区分字符串 `'NULL'`、空串和 SQL NULL。
- 类型下拉依据服务器厂商和版本提供 JSON、UUID、INET4、INET6、VECTOR；MySQL 不会看到 MariaDB 专属类型。JSON 在 MariaDB 是 LONGTEXT 与 JSON_VALID 校验的组合，因此结构中的服务器原始类型仍可能显示 LONGTEXT，不伪造为原生 JSON。
- 普通字段修改仅解析目标列，其他字段的生成列、INVISIBLE、CHECK、IGNORED 等定义不应连带阻止普通字段编辑。目标字段本身含解析器不能安全保留的属性时，明确拒绝并提示用 SQL 管理；不降级丢弃属性。
- 前缀、带注释、特殊方法及 MariaDB IGNORED 索引暂不允许可视化重建，避免属性损失；仍可查看或通过 SQL 管理。普通 BTREE 索引与外键沿用统一操作。
- SQL 导出优先使用服务器原始 DDL，排除生成列 INSERT，包含隐藏列；VECTOR 按二进制字面量保真导出。UUID/IP 按服务器文本值导出。向量浏览当前展示十六进制，不包含向量索引/相似度查询专用设计器。
- 同步暂限同厂商：MariaDB→MariaDB、MySQL→MySQL；拒绝 MySQL↔MariaDB，避免两者共享协议却直接复用不兼容 DDL。跨厂商迁移不属于本轮承诺。

本轮针对 MariaDB 11.8.9 与本机 MySQL 回归验收，不代表所有 MariaDB 历史版本、集群、TLS/SSH 组合均已实测。版本门控保证不主动展示未来类型，特殊服务器定义以 SQL 管理提示为准。完整结果见 [MariaDB 验收记录](verification/mariadb-alpha46.md)。

参考：[MariaDB JSON](https://mariadb.com/docs/server/reference/data-types/string-data-types/json)、[INFORMATION_SCHEMA.COLUMNS](https://mariadb.com/docs/server/reference/system-tables/information-schema/information-schema-tables/information-schema-columns-table)、[Ignored Indexes](https://mariadb.com/docs/server/ha-and-performance/optimization-and-tuning/optimization-and-indexes/ignored-indexes)。

补充修复：使用稳定的 information_schema 别名发现存储引擎；MySQL 协议的 SHOW/DESCRIBE/EXPLAIN 不再包装为派生表，普通查询按流式截取页窗口；MariaDB JSON 列的 CHECK 放在属性末尾，改名同步更新 CHECK 中的列引用。
