# DBFolio 设计文档

| 项目 | 内容 |
|---|---|
| 版本 | v1.0.0-alpha.7（SQLite 文件拖入快速建会话） |
| 日期 | 2026-09-29 |
| 状态 | R01～R04 已完成；SQLite 文件拖入已完成；回归、桌面事件联调、正式安装包与便携版校验通过；路线图完成 4/39，下一项 R05 |
| 维护规则 | 任何功能调整、新增、决策变更必须同步更新本文档，并记录到「21. 变更记录」 |

---

## 1. 项目概述

### 1.1 定位

DBFolio 是一款面向开发者的 Windows 桌面 SQL 客户端，采用 Windows 11 设计语言（Fluent 2 / Mica），
支持 MySQL、PostgreSQL、SQLite 三种关系型数据库、Redis（键值数据库）以及 MongoDB（文档数据库），核心差异化能力是**两个会话之间的数据库/数据表结构与数据同步**。

### 1.2 目标用户与核心场景

- 开发者在本地开发库与测试库之间同步结构与数据
- 运维/DBA 做跨环境（开发→测试）的只读对比与按需同步
- 个人开发者管理 SQLite 文件库与远程库

### 1.3 设计原则

1. **安全第一**：密码不出本机、默认 dry-run、破坏性操作默认关闭、执行前必有预览
2. **先看后做**：所有结构变更与同步操作先展示差异与生成的 SQL，再允许执行
3. **引擎无关**：统一元数据模型与统一值模型，同步引擎与具体数据库解耦
4. **原生观感**：Mica、Segoe UI Variable、Fluent 动效与圆角，遵循 Win11 交互习惯
5. **可回滚**：同步与批量编辑提供回滚脚本/快照，失败可恢复

### 1.4 非目标（当前阶段）

- 不做 Web 版、不做团队协作/云端存储
- 数据分析首期实现查询结果绘图与可保存分析方案；暂不做团队 BI 平台、共享仪表盘和定时推送
- 首版不做跨引擎同步（架构预留，见 ADR-003）

---

## 2. 技术选型

### 2.1 决策记录（ADR）

| 编号 | 决策 | 理由 | 备选方案 |
|---|---|---|---|
| ADR-001 | 前端 Tauri 2 + React + TypeScript + Fluent UI v9 | Fluent UI React v9 即微软官方 Win11 设计语言实现；Tauri 支持 Mica 且安装包小；WebView2 系统自带 | Electron（包体大）、WinUI 3（数据网格/差异 UI 开发量大） |
| ADR-002 | Rust 侧使用 sqlx 统一驱动三种数据库 | 单一 API + 编译期/运行期查询 + 异步 + 连接池 + 流式读取 | 每引擎单独 crate（重复工作），或 Node 驱动（放弃 Rust 数据层） |
| ADR-003 | 同步首版仅同引擎，架构引擎无关 | 跨引擎类型映射复杂，先降低风险，差异模型统一后可扩展 | 首版跨引擎（风险高） |
| ADR-004 | 本地元数据存 SQLite，凭据存 Windows 凭据管理器 | 查询简单、无外部依赖；凭据交给系统级安全存储 | 全部自加密文件（需自管密钥） |
| ADR-005 | 数据网格使用 AG Grid Community（MIT） | 成熟虚拟滚动、可编辑、列管理能力强 | TanStack Table（自研量大）、Glide Data Grid（React 生态适配风险） |
| ADR-006 | 分析使用统一 Dataset / AnalysisPlan 与 Apache ECharts；SQL / MongoDB 各自提供受限查询 | 绘图和统计共用实现，方案可重用且明确数据范围；图表包延迟加载 | 各引擎单独实现图表、一次性读取全库 |

### 2.2 依赖清单

**前端**

| 依赖 | 用途 | 状态 |
|---|---|---|
| @fluentui/react-components、@fluentui/react-icons | Win11 风格 UI 组件与图标 | 已引入 |
| zustand | 轻量状态管理 | 已引入 |
| @tauri-apps/plugin-dialog | 文件选择（SQLite 路径） | 已引入 |
| @monaco-editor/react | SQL 编辑器（高亮、多光标、后续 IntelliSense） | M2 引入 |
| ag-grid-community / ag-grid-react | 结果集与数据编辑网格 | M2 引入 |
| echarts | 查询结果图表、缩放、系列图例、PNG 导出；按模块导入、延迟加载 | A1＋A2 引入 |
| vitest + @testing-library/react | 前端测试 | M4 引入 |

**Rust（src-tauri）**

| 依赖 | 用途 | 状态 |
|---|---|---|
| tauri 2、tauri-plugin-dialog / opener | 应用框架、文件对话框 | 已引入 |
| sqlx（runtime-tokio + rustls-ring + mysql/postgres/sqlite） | 数据库驱动与连接池 | 已引入 |
| redis 1.7（tokio-comp + connection-manager + tokio-rustls-comp） | Redis 驱动（连接管理器、TLS） | Redis R1 引入 |
| tokio | 异步运行时 | 已引入 |
| serde / serde_json | IPC 序列化 | 已引入 |
| keyring（windows-native） | Windows 凭据管理器读写 | 已引入 |
| tracing / tracing-appender | 日志（`%APPDATA%/data-workbench/logs`） | 已引入 |
| thiserror / anyhow / async-trait / uuid / chrono / dirs | 基础工具 | 已引入 |
| csv、calamine、rust_xlsxwriter | 导入导出（M4） | 未引入 |

---

## 3. 总体架构

### 3.1 分层架构

```
┌───────────────────────────────────────────────────────┐
│ 表现层（WebView2）React + Fluent UI v9                 │
│  Shell / 会话浏览器 / SQL 编辑器 / 数据网格 /          │
│  表设计器 / 同步向导 / 日志面板                        │
├────────── Tauri IPC：invoke 命令 + event 事件 ─────────┤
│ 应用服务层（Rust）                                     │
│  SessionService  ConnectionPoolManager  MetadataService│
│  QueryService    DdlService             TransferService│
│  SyncService ── SchemaDiffer / DataDiffer /            │
│                PlanBuilder / SyncExecutor              │
├───────────────────────────────────────────────────────┤
│ 适配层：DbAdapter trait                                │
│  MySqlAdapter        PostgresAdapter      SqliteAdapter│
├───────────────────────────────────────────────────────┤
│ 存储层                                                 │
│ 本地 SQLite：会话配置、SQL 历史、同步配置、设置         │
│ Windows 凭据管理器：数据库密码 / SSH 凭据（DPAPI 兜底） │
└───────────────────────────────────────────────────────┘
```

### 3.2 模块职责

| 模块 | 职责 | 状态 |
|---|---|---|
| SessionService | 会话 CRUD、连接测试、凭据读写、只读模式判定 | M1 完成 |
| ConnectionPoolManager | 每会话连接池生命周期、断开与重连、连接数限制 | M1 完成（`AppState.connections` + 适配器内池） |
| MetadataService | 元数据内省、统一模型归一化、按会话/库缓存与失效 | M1 完成（内省；前端按库缓存，后端缓存待做） |
| QueryService | SQL 执行、分页、取消、执行历史、危险语句确认、只读拦截 | M2 完成（取消仅 MySQL/PG，SQLite 暂不支持） |
| DdlService | 建/删库、建/删表、列增删改，先预览后执行 | M2 完成（视图编辑暂不支持） |
| SyncService | 同步全流程：对比 → 计划 → 预览 → 执行 → 报告/回滚 | M3 |
| TransferService | CSV/JSON/Excel 导入导出 | M4 |
| Store | 本地 SQLite 读写、凭据存取、日志落盘 | M1 完成（M2 增加查询历史写入/清理） |

### 3.3 关键数据流

**执行查询**：UI `query.execute(sql, tabId)` → QueryService 判定语句类型 → 包装分页或直接执行 →
结果页（列元数据 + 行数据）经 `DbValue` 规范化 → IPC 返回首页；后续页 `query.fetch_page`。

**同步**：`sync.compare(source, target, objects, options)` → 双方内省 → SchemaDiffer/DataDiffer →
差异树 + 摘要返回 UI → 用户确认 → `sync.execute(plan_id)` → PlanBuilder 排序 → SyncExecutor
分批执行 → 事件 `sync:progress` 推送 → 结束生成报告与回滚脚本。

---

## 4. 统一元数据模型

### 4.1 设计目标

- 屏蔽三种引擎元数据差异，作为 diff、DDL 生成、同步计划的唯一输入
- 保留 `raw` 原始信息，保证同引擎同步时可 1:1 还原（如 MySQL 的 charset/collation/engine）

### 4.2 结构定义（Rust 实现：`src-tauri/src/meta/mod.rs`）

```rust
struct CatalogRef { session_id: String, database: String, schema: Option<String> }

struct DatabaseMeta { name: String, charset: Option<String>, collation: Option<String>, comment: Option<String> }

struct TableMeta {
    name: String,
    schema: Option<String>,
    kind: TableKind,                 // Table | View
    columns: Vec<ColumnMeta>,
    primary_key: Vec<String>,        // 列名有序
    indexes: Vec<IndexMeta>,
    foreign_keys: Vec<ForeignKeyMeta>,
    comment: Option<String>,
    row_estimate: Option<u64>,
    engine_options: Option<serde_json::Value>,  // 预留：MySQL ENGINE/CHARSET 等原始项
    raw_ddl: Option<String>,                    // MySQL: SHOW CREATE TABLE；SQLite: sqlite_master.sql
}

struct ColumnMeta {
    name: String,
    ordinal: u32,
    raw_type: String,                // 引擎原始类型文本
    canonical: CanonicalType,        // 归一化类型（见 4.3）
    nullable: bool,
    default_value: Option<String>,   // M1 存原始文本；M2 归一化为 DefaultValue 枚举
    auto_increment: bool,
    unsigned: bool,
    charset: Option<String>,
    collation: Option<String>,
    comment: Option<String>,
}

struct IndexMeta { name: String, columns: Vec<IndexColumn>, unique: bool, primary: bool, method: Option<String>, comment: Option<String> }
struct IndexColumn { name: String, desc: bool, prefix_len: Option<u32> }
struct ForeignKeyMeta { name: String, columns: Vec<String>, ref_table: String, ref_columns: Vec<String>, on_delete: String, on_update: String }
```

### 4.3 类型规范化

`CanonicalType` 是 diff 与跨引擎映射的基准（已实现三种引擎的解析与单元测试）：

```rust
enum CanonicalType {
    Bool,
    Int { bits: u8, unsigned: bool },
    Decimal { precision: Option<u8>, scale: Option<u8> },
    Float { bits: u8 },
    String { len: Option<u32> },      // None = 无界（TEXT/CLOB）
    Binary { len: Option<u32> },
    Date, Time { precision: Option<u8>, tz: bool }, DateTime { precision: Option<u8>, tz: bool },
    Json, Uuid,
    Enum { values: Vec<String> },
    Unknown { raw: String },
}
```

**映射矩阵（生成 DDL / 跨引擎时使用）**

| Canonical | MySQL | PostgreSQL | SQLite |
|---|---|---|---|
| Bool | TINYINT(1) | BOOLEAN | INTEGER（0/1） |
| Int(8/16/32/64, signed) | TINYINT/SMALLINT/INT/BIGINT | SMALLINT/INTEGER/BIGINT | INTEGER |
| Int(unsigned) | TINYINT UNSIGNED 等 | SMALLINT/INTEGER/BIGINT + CHECK >= 0 | INTEGER |
| Decimal(p,s) | DECIMAL(p,s) | NUMERIC(p,s) | NUMERIC |
| Float(32/64) | FLOAT/DOUBLE | REAL/DOUBLE PRECISION | REAL |
| String(n) | VARCHAR(n) | VARCHAR(n) | TEXT |
| String(None) | TEXT/LONGTEXT | TEXT | TEXT |
| Binary | BLOB/VARBINARY | BYTEA | BLOB |
| Date/Time | DATE/TIME(n) | DATE/TIME(n) | TEXT/INTEGER |
| DateTime | DATETIME(n)/TIMESTAMP | TIMESTAMP/TIMESTAMPTZ | TEXT/INTEGER |
| Json | JSON | JSONB | TEXT（+CHECK json_valid） |
| Uuid | CHAR(36)/BINARY(16) | UUID | TEXT |
| Enum(vals) | ENUM(...) | VARCHAR + CHECK | TEXT + CHECK |

**有损转换告警**（同步预览中必须展示）：`String(None)→String(n)`（截断风险）、
`Int(unsigned)→signed`（范围收缩）、`DateTime(tz)→无时区`、`Enum` 值集合不一致、`Float(64)→Float(32)`。

**统一值模型 `DbValue`**（查询结果、数据对比共用，IPC 紧凑序列化 `["int", 123]`；超出 JavaScript 安全整数范围时用 `["int", "9007199254740993"]` 等十进制文本保留精度）：

```rust
enum DbValue {
    Null, Bool(bool), Int(i64), UInt(u64), Float(f64),
    Decimal(String), Text(String), Bytes(Vec<u8>),
    Date(String), Time(String), DateTime(String),   // ISO-8601 文本
    Json(String), Uuid(String),
}
```

大数据字段（BLOB/长文本）默认截断预览，提供「加载完整值」操作；BLOB 以 `0x` 十六进制传递。

---

## 5. 会话与连接管理

### 5.1 会话模型

| 字段 | 说明 |
|---|---|
| id / name / engine | UUID / 显示名 / mysql \| postgres \| sqlite |
| host / port / username / database | 网络库连接信息 |
| file_path | SQLite 文件路径（必须已存在） |
| ssl_mode | disable / prefer / require / verify-ca / verify-full |
| read_only | 只读会话：禁止一切写操作与作为同步目标 |
| group / color / tags | 分组与标识色（字段已留，UI 后续） |
| connect_timeout / query_timeout / pool_max | 连接参数（超时使用 sqlx acquire_timeout，默认 10s） |
| ssh_tunnel | 预留（M4+） |

### 5.2 本地存储 Schema（`%APPDATA%/data-workbench/app.db`，已建立）

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, engine TEXT NOT NULL,
  host TEXT, port INTEGER, username TEXT, database TEXT, file_path TEXT,
  ssl_mode TEXT, read_only INTEGER NOT NULL DEFAULT 0,
  group_name TEXT, color TEXT, options_json TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE query_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
  database TEXT, sql TEXT NOT NULL, success INTEGER NOT NULL,
  rows_affected INTEGER, duration_ms INTEGER, error_code TEXT,
  executed_at TEXT NOT NULL
);
CREATE INDEX idx_history_session_time ON query_history(session_id, executed_at DESC);
CREATE TABLE sync_profiles (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  source_json TEXT NOT NULL, target_json TEXT NOT NULL, options_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
```

历史记录上限默认 500 条（M2 实现写入与清理）。

### 5.3 凭据安全（已实现）

- 密码写入 **Windows 凭据管理器**（keyring，服务名 `data-workbench`，账户为会话 id）
- 凭据只存在于 Rust 进程内存与系统凭据库，**永不进入日志、IPC 返回、错误信息**
- 更新会话时密码语义：缺省/null = 不变；空字符串 = 删除；非空 = 覆盖
- 删除会话时同步清除凭据

### 5.4 连接池（已实现）

- 每会话一套适配器实例；MySQL max 5 / SQLite max 1；PG 每库一个池（`pools` 缓存）且默认连到会话默认库（缺省 `postgres`）
- SQLite 打开设置 `busy_timeout=5000`，文件不存在直接报错
- 会话编辑/删除时自动断开；断线重连策略 M2 完善

---

## 6. 数据库适配层

### 6.1 DbAdapter trait（已实现，`src-tauri/src/adapters/`）

```rust
#[async_trait]
trait DbAdapter: Send + Sync {
    fn engine(&self) -> Engine;
    async fn ping(&self) -> AppResult<()>;
    async fn server_version(&self) -> AppResult<String>;
    async fn list_databases(&self) -> AppResult<Vec<DatabaseMeta>>;
    async fn list_tables(&self, database: &str) -> AppResult<Vec<TableRef>>;
    async fn introspect_table(&self, database: &str, schema: Option<&str>, table: &str) -> AppResult<TableMeta>;
}
```

M2 扩展：`execute / fetch_page / stream / begin / commit / rollback / cancel`。
DDL 生成独立为 `DdlRenderer`（每种方言一个实现），数据同步执行使用参数化语句，导出脚本时才用 `LiteralEncoder`。

### 6.2 元数据内省来源（已实现）

| 引擎 | 主要来源 |
|---|---|
| MySQL | `information_schema.TABLES/COLUMNS/STATISTICS/KEY_COLUMN_USAGE/REFERENTIAL_CONSTRAINTS` + `SHOW CREATE TABLE`（raw_ddl） |
| PostgreSQL | `pg_catalog`（pg_class / pg_attribute / pg_index / pg_constraint / pg_type + `format_type()`、`col_description()`）；raw_ddl 待补 |
| SQLite | `sqlite_master.sql` + `pragma_table_xinfo / index_list / index_xinfo / foreign_key_list` |

系统对象过滤：MySQL 过滤 information_schema/mysql/performance_schema/sys；PG 过滤 pg_catalog/information_schema 与模板库；SQLite 过滤 `sqlite_%`。

### 6.3 方言差异与 DDL 能力矩阵

| 操作 | MySQL | PostgreSQL | SQLite |
|---|---|---|---|
| 建库/删库 | CREATE/DROP DATABASE | CREATE/DROP DATABASE（不可在事务内） | 新建/删除文件（须先关闭连接） |
| 改库名 | 不支持，走「建新库 + 迁移」 | ALTER DATABASE RENAME | 文件重命名（须先关闭连接） |
| 改列类型 | MODIFY COLUMN | ALTER COLUMN TYPE（可带 USING） | 不支持，重建表 |
| 加/删/改列名 | 原生支持 | 原生支持 | 加列支持；改名 3.25+；删列 3.35+ |
| 加外键/约束 | 原生支持 | 原生支持 | 不支持，重建表 |
| DDL 事务 | 否（隐式提交，需备份） | 是 | 是 |

SQLite 表结构变更统一走**重建表流程**（官方 12 步）：创建新表 → 复制数据 → 删除旧表 → 重命名 →
重建索引/触发器，全程在事务内并临时关闭 `foreign_keys`。

### 6.4 Redis 适配（R1 已实现）

设计要点：

- **引擎族**：`Engine` 新增 `Redis`，并以 `Engine::is_sql()` 区分关系型引擎；同步引擎等 SQL 专属能力只接受 SQL 引擎。
- **适配接口**：新增与 `DbAdapter` 平级的 `KeyValueAdapter` trait（`ping / server_info / list_databases / command`）；`RedisAdapter` 同时实现两个 trait，SQL 相关方法统一返回「不支持」，从而复用既有会话连接流程（`ConnectedSession` 同时持有 `sql` 与 `key_value` 两个可选适配器）。
- **连接**：会话新增 `redisDb`（默认逻辑库 0）与 `tls` 字段（`rediss://`）；连接串由主机/端口/用户名/密码/逻辑库拼装（特殊字符 percent-encode），驱动使用 `redis` crate 的 `ConnectionManager`，每个逻辑库一个独立管理器（连接时 `SELECT` 库）。
- **服务器信息**：解析 `INFO` 为「分节键值对」`InfoEntry { section, key, value }`；`CONFIG GET databases` 获取逻辑库数量（无权限时回退 16），`DBSIZE` 得到各库键数，组成 `RedisDatabaseInfo { index, keys }`。
- **前端**：会话表单新增「逻辑库（0-15）」与「使用 TLS」；对象浏览器在 Redis 会话下把逻辑库渲染为叶子节点（显示键数），点击打开 Redis 概览页签（版本/模式/运行时间/连接数/内存/命中率卡片 + INFO 分节，逻辑库切换在「键浏览」工具栏）。
- **路线图**：R2 键浏览（SCAN 分页 + 前缀树，禁用 KEYS）、R3 六类型值编辑器（String/List/Set/ZSet/Hash/Stream）、R4 命令控制台、R5 JSON 导入导出 + Redis 间同步；批量删除已在 R2/R3 阶段提前实现（v0.70）；MongoDB 排在 Redis 之后。

### 6.5 Redis 键浏览（R2 已实现）

- **SCAN 分页**：`scan_page` 使用 `SCAN cursor MATCH pattern [TYPE type] COUNT n`（禁用 `KEYS`），返回 `{ cursor, keys }`；`cursor=0` 表示迭代结束。前端「继续扫描」按游标追加，分页期间不重复。空页但游标非 0 时前端自动续扫（最多 20 轮）。
- **键摘要**：每页对键做 `TYPE / PTTL / MEMORY USAGE` 命令管道（pipeline，一轮往返），得到 `RedisKeyInfo { key, kind, ttlMs, size }`；类型过滤使用 Redis 6+ 的 `SCAN ... TYPE`（服务端过滤，避免空页偏移）。
- **键预览**（只读，`key_preview`）：先取 `TYPE/PTTL/MEMORY USAGE/OBJECT ENCODING`，再按类型取前 100 项：string `STRLEN + GETRANGE`（截断标记）、list `LLEN + LRANGE`、set `SCARD + SSCAN`、zset `ZCARD + ZRANGE WITHSCORES`、hash `HLEN + HSCAN`、stream `XLEN + XRANGE COUNT`；值非法 UTF-8 时按十六进制展示并标记 `binary`。
- **前端**：Redis 页签分「键浏览 / 服务器概览」子页签。键浏览为三栏布局（前缀树 / 键表格 / 预览面板，两侧分隔条可拖拽调宽并持久化到设置 `ui_redis_tree_width`、`ui_redis_preview_width`）：左侧前缀树（按 `:` 分段、紧凑行高与缩进、无子前缀的节点不带展开箭头、显示当前已加载页内计数，点击节点执行**本地前缀筛选**，树保持完整并自动展开该节点，不改变搜索模式）、中间键表格（键名/类型/TTL/大小，类型按颜色徽标）、右侧预览面板（类型/TTL/编码/元素数/内存 + 值预览 + 复制键名 + 刷新）。逻辑库选择在对象浏览器：点击某个逻辑库打开**该库的独立页签**（工具栏显示当前库徽标）；搜索模式、类型过滤、刷新、继续扫描在工具栏；底部说明 SCAN 语义。
- **边界**：预览仅只读（编辑在 R3）；键删除在 R3、批量删除在 v0.70 完成；前缀树计数为「当前已加载键」范围内统计。

### 6.6 Redis 值编辑与键管理（R3 已实现）

- **编辑操作模型**：`RedisEditOp`（serde tag = `op`）覆盖六类型 —— `setString`（`SET ... KEEPTTL` 保留 TTL）、`listPush/listSet/listRemove`、`setAdd/setRemove`、`zAdd/zRemove`、`hashSet/hashRemove`、`streamAdd`；键级操作单独命令：`redis_delete_key`（DEL）、`redis_rename_key`（RENAMENX，目标存在即拒绝）、`redis_key_ttl`（PEXPIRE / PERSIST，返回新 PTTL）。
- **只读保护**：所有写命令先查会话 `read_only`，命中返回 `E_READONLY`（与 SQL 侧一致）。
- **键创建**：`redis_edit(..., create=true)` 先 `EXISTS` 校验，已存在返回 `E_INVALID`；类型由首个编辑操作决定（Redis 语义，创建后不可改类型）。
- **编辑面板**：右侧预览面板升级为编辑面板 —— 头部提供重命名 / TTL / 复制键名 / 刷新 / 删除；String 使用 Monaco 编辑器（**自动识别 JSON/XML 并格式化高亮**，类 JSON 回退 JavaScript 高亮，提供「格式化 / 压缩(JSON)」与解析错误提示，保存时保留原 TTL，显示字符数与语言徽标）；List 支持头部插入、尾部追加、按索引改写（LSET）、按值删除（LREM）；Set/ZSet 支持成员增删（ZSet 可改分值）；Hash 支持字段设置/删除；Stream 支持按 `field=value` 行追加条目；每次写入后自动重载预览并刷新键列表（保留前缀筛选与选中态）。
- **字符串完整值**：编辑面板对 String 单独拉取完整值（预览阶段先用 100 字节探测，截断时再按 1 MB 上限加载）；超过 1 MB 时提示并禁用保存，避免用截断内容覆盖原值。
- **键列表右键菜单**：查看/编辑、复制键名、重命名、设置 TTL、刷新列表、删除（删除/重命名/TTL 复用同一套对话框，在编辑面板与右键菜单间共享）。
- **树形图标**：无下级前缀的节点使用「多把钥匙堆叠」图标（KeyMultiple），有下级前缀的节点使用文件夹图标。

---

## 7. 查询执行（M2）

### 7.1 分页策略

1. **包装分页**（默认）：对可返回结果集的语句做 `SELECT * FROM (<原始SQL>) AS _dw_sub LIMIT n OFFSET m`（三种引擎均支持；执行前去除尾部 `;`）
2. **键集分页**（表数据浏览优先）：有主键时 `WHERE (pk...) > (last...) ORDER BY pk LIMIT n`，避免深偏移性能问题；复合主键使用行值比较；NULL 值存在时回退包装分页
3. 非结果集语句（INSERT/UPDATE/DDL）直接执行，返回受影响行数与耗时

### 7.2 流式与取消

- 大数据量导出使用 `stream()` 分批读取，避免全量入内存
- 取消实现：
  - MySQL：独立连接执行 `KILL QUERY <connection_id>`（连接 id 由 `SELECT CONNECTION_ID()` 获得）
  - PostgreSQL：独立连接 `SELECT pg_cancel_backend(<pid>)`（pid 由 `pg_backend_pid()` 获得）
  - SQLite：本地执行，通过 drop future + 语句级 `progress_handler` 中断
- 查询超时默认 30s（会话级可覆盖，0 = 不限）

### 7.3 事务

- 查询页签可选「事务模式」：手动 BEGIN / COMMIT / ROLLBACK
- 网格编辑提交自动使用事务
- 默认自动提交模式

---

## 8. 数据网格与编辑（M2）

### 8.1 变更集模型

```ts
interface CellChange { rowKey: PkValue[]; column: string; oldValue: DbValue; newValue: DbValue }
interface RowChange { kind: 'insert' | 'update' | 'delete'; pks: DbValue[]; changes?: CellChange[]; newRow?: Record<string, DbValue> }
```

- 主键唯一确定行；无主键结果集**只读**（仅允许复制与导出）
- 并发保护（默认开启）：`WHERE pk=? AND col1 IS [NOT] DISTINCT FROM old1 ...`，更新 0 行时提示冲突
- 提交前展示 SQL 预览，确认后单事务执行；失败自动回滚并定位首个错误行

### 8.2 编辑器控件映射

| 类型 | 编辑控件 |
|---|---|
| Bool | 开关（Switch） |
| 数值 | 数字输入，越界即时校验 |
| Date/Time | Fluent DatePicker / 文本（精度到秒/毫秒） |
| Enum | 下拉选择 |
| Json | 弹出多行编辑器 + 校验 |
| 长文本/BLOB | 弹出编辑，默认只读截断预览 |
| NULL | 独立开关/快捷 `Ctrl+0` 置空 |

### 8.3 导出（M4）

结果集与网格支持导出 CSV / JSON / Excel。导出流式写文件，不阻塞 UI。
编码默认 UTF-8 with BOM（兼容 Excel），CSV 分隔符/引号策略可配置。

### 8.4 列宽与可用空间（v0.115）

数据表与 SQL 结果网格的数据列默认等比例分配容器宽度，单列最小 110px；列宽总和超出可用区域时横向滚动。勾选列保持固定宽度。用户拖动的列改为手动宽度，其余列继续填充分配空间；刷新、排序和窗口变化不重置手动宽度。行高仍保持紧凑，不通过拉伸行高填充空白。

---

## 9. 库/表管理（DDL，M2）

### 9.1 功能范围

- 库：新建、删除、改名（按 6.3 能力矩阵差异化实现/提示）
- 表：新建表向导（列、主键、索引、外键）、删除表、改表名、列增删改、索引与外键管理
- 视图：查看定义（首版只读）
- 全部操作遵循「**生成 SQL → 预览确认 → 执行**」；执行后刷新对象树

### 9.2 预览与安全

- 破坏性操作（删库/删表/删列/改类型）红色警示 + 输入确认（可选强化：输入对象名）
- SQLite 重建表流程与 MySQL 隐式提交在预览中明确提示「不可回滚」
- 表设计器支持「导出变更脚本」不执行

---

## 10. 数据同步引擎（核心，M3）

### 10.1 流程总览

```
① 选择端点        ② 选择对象          ③ 差异对比            ④ 执行与报告
源/目标会话+库  →  库/表多选         →  SchemaDiffer          → PlanBuilder 排序
（可创建缺失库）    （整库/多表）        DataDiffer             SyncExecutor 分批
                                      选项 + SQL 预览         进度事件 + 回滚脚本
```

### 10.2 SchemaDiffer

- 表匹配：默认按名称精确匹配（可配置忽略大小写）
- 表状态：`仅源存在 / 仅目标存在 / 双方存在 / 同名不同类型`
- 列差异：新增列 / 缺失列 / 类型变更（canonical 比较 + raw 差异记录）/ 可空性 / 默认值 / 自增 / 注释
- 索引与外键差异：新增 / 缺失 / 定义不一致
- 输出 `SchemaDiff` 树，每个节点带 `action`：Create / Drop / Alter / Noop / Warn
- 重命名不自动推断（add+drop 语义），首版在 UI 中以「疑似重命名」提示人工选择

### 10.3 DataDiffer

**前置条件**：表必须有主键或用户指定对比键；否则进入 10.9 特殊策略。

- 先取双方行数做快速估算；再按主键排序分块（默认块 5,000 行）拉取对比
- 行对比使用**规范化行哈希**（对 `DbValue` 序列化后哈希）：相等跳过，不等进入明细
- 明细分类：`待插入`（源有目标无）、`待更新`（主键同、内容不同）、`待删除`（目标有源无，仅当开启「删除多余行」）
- 内存策略：全量行数据不驻留内存，仅存差异摘要与计数；执行阶段按块重新拉取
- 冲突策略：`skip`（保留目标）/ `overwrite`（以源为准）/ `fail`（该表报错停止）

### 10.4 PlanBuilder

将 SchemaDiff + DataDiff 编译为有序操作计划：

1. 建目标库（如缺失且开启）
2. 建表（外键拓扑序排序，避免依赖错误）
3. 列变更（新增 → 改类型 → 可空性/默认值）
4. 删除多余列（默认关闭，单独放最后并强提示）
5. 索引与外键变更
6. 数据操作：插入 → 更新 → 删除（先插入减少外键断链；删除默认最后）
7. 每步携带：目标库/表、SQL（参数化模板）、预估影响行数、风险标记

外键相关可选优化：执行期间临时关闭外键检查（MySQL `SET FOREIGN_KEY_CHECKS=0`、SQLite `PRAGMA foreign_keys`、PG 使用 `SET CONSTRAINTS ALL DEFERRED`，不可行时按拓扑序执行），结束后恢复。

### 10.5 SyncExecutor

- 模式：`dry_run`（仅生成脚本，默认）/ `execute`
- 分批执行：默认 1,000 行/批，批内事务；MySQL 的 DDL 无事务需逐条确认
- 写入方式：批多行 INSERT（注意 MySQL 参数上限）→ 后续优化 PostgreSQL `COPY`、SQLite 预编译循环
- 错误策略：`continue_on_error`（默认关）→ 跳过并记录，否则停止
- 进度事件：`sync:progress { plan_id, table, phase, done_rows, total_rows, error_count }`
- 执行前快照（默认开）：将被更新/删除的目标行写入目标库 `_dw_undo_<table>_<ts>` 临时表

### 10.6 同步选项清单

| 选项 | 默认 | 说明 |
|---|---|---|
| sync_mode | schema_and_data | schema_only / data_only / schema_and_data |
| create_missing_tables | 开 | 目标缺失表时创建 |
| create_missing_database | 开 | 目标库不存在时创建（同引擎） |
| add_missing_columns | 开 | 源有目标无的列，动态加列 |
| alter_changed_columns | 开 | 类型/可空/默认差异修正 |
| drop_extra_columns | **关** | 目标多余列，危险 |
| drop_missing_tables | **关** | 目标多余表，危险（与删除多余行独立） |
| insert_missing_rows | 开 | 目标缺失行插入 |
| update_changed_rows | 开 | 差异行更新 |
| delete_extra_rows | **关** | 目标多余行删除（危险） |
| conflict_policy | overwrite | skip / overwrite / fail |
| batch_size | 1000 | 行/批 |
| dry_run | **开** | 仅生成 SQL 预览 |
| snapshot_before_write | 开 | 写入前快照，支持回滚 |
| continue_on_error | 关 | 出错继续 |
| fk_checks_off | 开 | 执行期间临时关闭外键检查 |

破坏性开关需在 UI 中显式二次确认，并在最终执行确认页以红色摘要展示。

### 10.7 回滚与备份

- **DML 回滚**：基于快照表生成反向语句（更新回旧值、删除回被删行、插入行按主键删除）
- **DDL 回滚**：执行记录反演（CREATE→DROP、ADD COLUMN→DROP COLUMN、ALTER→恢复原定义；删列/删表因 MySQL 无法回滚，依赖执行前备份 + 明确警告）
- 执行结束可导出：`rollback_<ts>.sql`、执行报告 `sync_report_<ts>.md|csv`
- 快照表默认执行后保留，提供「清理快照」按钮；可在选项中改为自动清理

### 10.8 大表与性能

- 对比与执行全程分块流式，内存占用与表大小无关
- 目标吞吐：本地 SQLite → SQLite ≥ 5,000 行/秒；远程批大小可自适应降级
- 超时/断线：记录断点（表 + 最后主键），支持「继续上次同步」（配置保存）
- 对比进度同样以事件推送，支持取消

### 10.9 无主键/无对比键表策略

- UI 显著警告并单独分组
- 数据同步仅允许两种策略（用户选择）：
  1. **只插入**：全量拉取源行与目标行做存在性对比（按全列哈希）
  2. **全量替换**：清空目标表后整体重建（危险，需强确认）
- 默认不参与数据同步，仅做结构同步

### 10.10 边界与失败处理

- 同步中会话断线：暂停 → 可重试当前批（幂等保证：插入用 upsert 或先查 PK，更新为幂等赋值，删除幂等）
- 目标只读会话：直接拒绝作为目标
- 源与目标为同一库：拒绝并提示
- 引擎不一致（首版）：在步骤①即拦截并提示（架构预留映射层）

---

## 11. UI / 交互设计

### 11.1 Windows 11 设计语言规范

| 项目 | 规范 | M1 状态 |
|---|---|---|
| 窗口背景 | Mica（Win11）；标题栏自绘并支持拖拽、双击最大化、贴边 | 已实现（transparent + windowEffects.mica） |
| 组件库 | Fluent UI v9（Fluent 2 token）：半透明背景适配 Mica | 已实现（自定义 Mica 主题 token） |
| 字体 | Segoe UI Variable（界面）；Cascadia Mono / Consolas（SQL 与数据） | 已实现 |
| 圆角 | 卡片/面板 8px，控件 4px | 已实现（Fluent 默认） |
| 图标 | Fluent System Icons（Regular/Filled） | 已实现 |
| 主题 | 跟随系统深浅色 | 已实现（matchMedia 监听） |
| 动效 | Fluent 缓动曲线，150–300ms | 使用 Fluent 默认 |
| 交互 | 右键上下文菜单、快捷键面板 | M2/M4 |

### 11.2 主窗口布局（已实现）

界面风格（v0.76）：设置 → 外观提供「经典简洁」「流光层次」「专业工作台」三种带缩略预览的风格。默认流光层次：表标题渐变卡片、工具栏分区、网格留白与阴影、彩色字段类型标签；专业工作台使用清晰列边框和等宽数据；经典简洁保留平面布局。风格与亮/暗/跟随系统、强调色独立组合，使用本地设置键 `ui_interface_style` 持久化，保存成功后立即切换，失败显示错误。旧配置缺省或未知值回退流光层次。网格保持 28px 行高，增强风格表头为 46px（经典 38px），不改变数据编辑或排序逻辑。

```
┌ 标题栏（拖拽区 + 应用名 + 窗口按钮）────────────────────────────┐
│  ┌──────────┬──────────────┬──────────────────────────────────┐ │
│  │ 会话列表  │ 对象浏览器    │ 主区域（表结构详情 / 欢迎页）     │ │
│  │ 260px    │ 280px        │                                  │ │
│  └──────────┴──────────────┴──────────────────────────────────┘ │
│ 状态栏：连接数 | 活动会话+版本 | 当前对象 | 里程碑               │
└──────────────────────────────────────────────────────────────────┘
```

M2 起在会话列表右侧增加页签区（查询/数据/设计/同步）。

### 11.3 同步向导（M3，独立页签）

- **步骤① 端点**：源/目标两张卡片（会话下拉 + 库下拉，库不存在显示「将创建」徽标），中央交换按钮；引擎不一致即时警告
- **步骤② 对象**：树形勾选（整库/表），显示行数估算；搜索与批量全选；无主键表带警示图标
- **步骤③ 对比**：左「结构差异」树（新增/变更/缺失图标 + 行内详情），右「数据摘要」表格（源/目标行数、待插入/更新/删除、冲突数）；下方选项折叠面板；按钮「生成 SQL 预览」→ 脚本查看器（复制/导出/排除单条）
- **步骤④ 执行**：总进度 + 每表状态列表 + 实时日志；完成后展示报告卡（分类计数、耗时、告警）、导出报告、导出回滚脚本、查看/清理快照
- 同步配置可保存为「同步配置（sync_profiles）」，下次一键载入

### 11.4 前端目录结构（已实现）

```
src/
├─ app/                 # TitleBar / StatusBar / toast（Shell）
├─ features/
│  ├─ sessions/         # 会话列表、会话表单、引擎元数据
│  ├─ explorer/         # 对象树（懒加载）
│  ├─ detail/           # 表结构详情（列/索引/外键/DDL）
│  ├─ query/            # M2：SQL 编辑器与结果页签
│  ├─ grid/             # M2：数据网格与编辑、导出
│  ├─ designer/         # M2：表设计器
│  └─ sync/             # M3：同步向导（4 步）
├─ components/          # 通用组件（M2+）
├─ ipc/                 # Tauri invoke 类型化封装 + 类型定义
├─ stores/              # zustand：useSessionStore / useExplorerStore
└─ i18n/                # 文案（M4，zh-CN 先行）
```

### 11.5 状态管理（已实现）

- `useSessionStore`：会话列表、连接状态、活动会话、CRUD/连接动作
- `useExplorerStore`：按会话缓存数据库/表、加载状态、当前选表与表详情
- 服务端状态（元数据/结果页）不进全局 store 之外的持久化，按需缓存并随断开清理

---

## 12. IPC 接口设计

### 12.1 命令清单（Tauri commands）

| 域 | 命令 | 状态 |
|---|---|---|
| session | `session_list` `session_create` `session_update` `session_delete` `session_test` `session_connect` `session_disconnect` `session_set_group` `session_statuses` | M1/M2.2 完成 |
| meta | `meta_databases` `meta_tables` `meta_table_detail` | M1 完成 |
| query | `query_execute` `query_fetch_page` `query_cancel` `query_history_list` | M2 完成 |
| grid | `grid_preview_changes` `grid_commit` `grid_export`（M4） | M2 完成（导出待做） |
| ddl | `ddl_preview` `ddl_apply` `ddl_create_database` `ddl_drop_database` `ddl_rename_database`（暂缓） | M2 完成（改库名暂缓） |
| sync | `sync_compare` `sync_preview_sql` `sync_execute` `sync_cancel` `sync_report` `sync_rollback_script` `sync_profiles_*` | M3 |
| redis | `redis_server_info` `redis_databases` `redis_command` `redis_scan_keys` `redis_key_preview` `redis_edit` `redis_delete_key` `redis_delete_keys` `redis_rename_key` `redis_key_ttl` | R1/R2/R3 完成（控制台命令在 R4） |
| info | `meta_server_info` `meta_database_info` | R2.5 完成（SQL 三引擎 + Redis INFO 复用） |
| app | `settings_get` `settings_set` `app_logs_open`（待做） | M2.2 完成（设置读写） |

### 12.2 事件

已实现：无（M2 采用命令返回值与前端状态；进度类事件在 M3 同步中引入）
规划：`sync:progress`、`sync:finished`（M3）、`app:toast`（M4）

### 12.3 错误模型（已实现）

```ts
interface AppError {
  code: 'E_CONN' | 'E_AUTH' | 'E_TIMEOUT' | 'E_CANCELLED' | 'E_SQL_SYNTAX'
      | 'E_SQL_EXEC' | 'E_CONFLICT' | 'E_PERMISSION' | 'E_SYNC_PLAN'
      | 'E_READONLY' | 'E_DANGEROUS' | 'E_INVALID' | 'E_NOT_FOUND'
      | 'E_SECRET' | 'E_INTERNAL' | 'E_MESSAGE';
  message: string;          // 用户可读（中文本地化）
  detail?: string;          // 引擎原始信息
  sqlState?: string;        // 预留：如 42P01 / 1064
  statement?: string;       // 预留：出错语句（脱敏后）
}
```

前端 `normalizeError()` 统一降级处理非结构化错误；`E_DANGEROUS` 触发前端危险确认后以 `force=true` 重试。

---

## 13. 安全设计

1. 凭据仅存 Windows 凭据管理器；IPC 与日志均无明文密码（已实现）
2. 只读会话：在适配层拦截写语句与 DDL（语句分类器，M2），同步中拒绝作为目标（M3）
3. SQL 编辑器危险语句检测（无 WHERE 的 UPDATE/DELETE、DROP/TRUNCATE）默认弹确认（M2）
4. 同步：破坏性选项默认关闭、默认 dry-run、执行前显示影响摘要、可选快照（M3）
5. 本地 app.db 仅存配置，不含业务数据；日志按级别记录，可一键清理（M2）
6. R04：SSH 主机 SHA256 指纹必须显式核对并信任；TLS 按引擎提供 CA、客户端证书与服务器名校验，MySQL/PG 通过 verify-full 强制身份校验。密码与私钥口令不写入本地 SQLite。

---

## 14. 性能指标

| 指标 | 目标 |
|---|---|
| 冷启动 | < 2s（WebView2 已安装） |
| 网格渲染 | 10 万行虚拟滚动 60fps |
| 分页查询 | 单页（1,000 行）< 300ms（本地/局域网） |
| 同步吞吐 | SQLite→SQLite ≥ 5,000 行/s；远程 ≥ 1,000 行/s |
| 大表对比 | 100 万行对比全程内存 < 300MB，可取消 |
| 安装包 | < 30MB（不含 WebView2 Runtime） |

---

## 15. 日志与诊断（已实现基础）

- `tracing` 分级输出到 `%APPDATA%/data-workbench/logs/app.log.YYYY-MM-DD`，默认 INFO（`sqlx=warn`），可经 `RUST_LOG` 调整
- 查询历史与同步执行记录分别入库（M2/M3 写入），日志面板可一键导出诊断包（M4）
- 慢查询（> 1s）记录耗时与 SQL 摘要（M2）

---

## 16. 测试策略

| 层 | 方式 | 状态 |
|---|---|---|
| 类型系统 | Rust 单元测试：CanonicalType 三引擎解析 | 已实现 |
| 同步引擎 | Rust 单元测试：schema diff、计划排序、字面量编码、幂等性（对拍两次 diff 为空） | M3 |
| 适配层 | Docker 起 MySQL/PostgreSQL + 临时 SQLite 文件做集成测试（CI 可跑） | M3 |
| 前端 | vitest 覆盖 stores/工具/向导步骤逻辑；组件测试重点在网格编辑与差异树 | M4 |
| 手工验收 | 每里程碑按「17. 里程碑」验收标准逐项走查 | 持续 |

---

## 17. 里程碑与验收

| 里程碑 | 内容 | 验收标准 | 状态 |
|---|---|---|---|
| M1 骨架 | Tauri 工程、Fluent Shell、会话管理、三库连接、对象树 | 可创建/保存/连接三种会话，断开重连正常，对象树可浏览表结构 | 完成 |
| M2 查询与编辑 | SQL 编辑器、分页结果、网格编辑提交、库表 DDL | 执行 SQL 正确分页显示；改单元格生成 SQL 并事务提交；可视化建表/删表/加列成功 | 完成 |
| M3 同步核心 | Schema/Data Diff、计划、预览、执行、报告、回滚 | SQLite→SQLite、PG→PG、MySQL→MySQL 全流程通过；dry-run 脚本可手工执行；快照回滚验证成功；重复同步幂等 | 完成（回滚脚本待做） |
| R1–R5 Redis | 连接管理、键浏览、值编辑、命令控制台、导入导出/同步 | 连接与服务器信息可用；SCAN 分页浏览；六类型值编辑；命令控制台 | R1–R3 完成 |
| M4 打磨 | 导入导出、主题、快捷键、安装包、SSH 预留 | MSIX/NSIS 安装包可用；深浅色与 Mica 正常；导出 CSV/Excel 打开无乱码 | 进行中（导入导出已完成） |

---

## 18. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 三引擎类型语义差异 | 同步失真 | 统一 canonical 模型 + 有损转换告警 + 矩阵化测试 |
| 大表对比耗时高 | 体验差 | 分块流式 + 行哈希 + 可取消 + 断点续传 |
| MySQL DDL 无事务 | 失败难回滚 | 执行前快照 + 逐条确认 + 报告明确标注不可回滚项 |
| SQLite 表结构变更需重建 | 数据风险 | 官方 12 步流程 + 事务 + 外键关闭 + 备份原表 |
| Tauri 与 Fluent 在 Mica/自绘标题栏的兼容问题 | 观感 | M1 已验证 Mica + 自绘标题栏可用；保留纯色回退方案 |
| sqlx 动态类型解码复杂度 | 稳定性 | 统一 `DbValue` 解码层 + 每引擎解码测试集 |
| 脚手架/工具误删未提交文件 | 数据丢失 | 重要文档纳入 git 提交；脚手架操作前先提交或备份 |

---

## 19. 未来路线图（Backlog）

- 跨引擎同步（启用 4.3 映射矩阵与告警体系）
- 多跳 SSH、代理链与系统 SSH agent（单跳 SSH/TLS 已由 R04 实现）
- 增量同步（时间戳/自增 ID 水位线）、定时同步任务
- 视图/函数/触发器/序列等对象同步
- ER 图、执行计划可视化、SQL 智能补全与格式化
- 更多引擎：SQL Server、Oracle、ClickHouse
- 多语言（zh-CN / en-US）、自动更新、深色 Mica 微调
- 插件系统（自定义导出器/比较器）

---

### 19.1 数据生成 G1–G3 设计（v0.106）

#### 统一流程与扩展点

- 入口：SQL 表右键「生成测试数据」、表/集合/Redis 工具栏「数据生成」、底部工作区菜单、Ctrl+P 的 `> 数据生成`。
- 独立生成页签：目标 → 规则与模板 → 冻结批次预览/写入 → 执行结果。规则、目标、数量、种子、参数和 AI 服务引用保存在工作区快照，重启可继续配置；冻结数据及写入结果只保留本次运行，不会重启自动写入。
- Rust `DataGenerationAdapter` 统一提供目标描述、能力/方案校验、逐行校验、唯一校验、类型规范化和写入。SQL 层复用各引擎 DbAdapter 的真实元数据与参数化事务；MongoDB/Redis 各有独立生成适配器。
- 方案版本固定为 1；未知规则/字段格式拒绝执行。执行流程不接受 AI SQL 或任意脚本，不使用 eval。模板保存规则和参数，不包含连接对象、账号或 AI 密钥。

#### G1：AI 设置与基础接口

- 设置新增「AI 服务」：最多 20 个服务；名称、Base URL、API Key、默认服务、模型、超时（5–300 秒）、输出上限（128–32768 tokens）、输出格式以及上限参数名。
- `GET {base}/models` 获取/排序/去重模型 ID，支持手动输入；`POST {base}/chat/completions` 测试与生成。请求不自动重试，不跟随重定向；支持本地无密钥 HTTP 服务。默认 JSON 模式；可选普通文本、JSON Schema。可选 max_tokens / max_completion_tokens，适配不同兼容服务。
- 测试请求可使用严格 JSON Schema；规则和内容生成因字段动态变化，Schema 模式回退 JSON 对象模式，再进行本地字段与类型校验。模型列表不视为能力探测。
- 非敏感配置存 app.db 的 `ai_providers_v1`。密钥使用 Windows 凭据管理器服务 `data-workbench-ai`，以服务 UUID 区分；前端只能得到 hasKey，密钥输入仅暂存在表单。保存失败尽力恢复原凭据；删除服务同时移除其凭据。
- 请求在 Rust 后端发出，不依赖前端 CORS；HTTP 错误在任务提示中只返回分类信息。v0.110 数据生成的专用响应查看器可查看服务正文，并隐藏当前请求密钥。普通 HTTP 响应最多 2 MiB；SSE 传输最多 32 MiB、AI 正文最多 2 MiB、单个事件/未结束行最多 2 MiB。同时最多 2 个 AI 请求，支持任务中心取消。服务返回的实际 token 用量才计入统计，缺失显示“未报告”，不估算价格。
- 接口依据：[模型列表](https://developers.openai.com/api/reference/resources/models/methods/list)、[Chat Completions](https://developers.openai.com/api/reference/resources/chat)、[结构化输出](https://developers.openai.com/api/docs/guides/structured-outputs)。第三方兼容服务可手动调整协议参数。

#### G2：本地规则、模板与安全写入

- 规则：省略/数据库默认、NULL、固定 JSON 值、整数序列、随机整数、定点小数、布尔、候选值、文本模板、UUID、ObjectId、日期、中文姓名、测试邮箱、测试公司、字段拼接/整数加乘、AI 内容字段。
- 文本支持 `{n}` 行号、`${参数名}`；参数按字面值替换，不嵌套执行。计算字段按依赖排序，拒绝不存在字段、引用默认生成字段及循环依赖。普通字段可指定空值比例、批次内唯一。AI/计算/省略规则不支持随机空值比例。
- 随机种子驱动固定算法；相同的可复现本地规则、字段顺序与种子复现相同结果。新随机 UUID、任务批次号、当前时间、AI 结果、数据库默认值和省略的 MongoDB `_id` 不承诺跨批次复现。金额使用定点整数生成，大整数以字符串或 EJSON 跨前端传输，避免 JavaScript 精度丢失。
- 模板库 `generation_templates_v1`：最多 100 份 / 2 MiB，支持新增、更新、复制、删除、JSON 导入导出；导入单文件最多 128 KiB。模板按引擎筛选，字段复用后再次校验。字段可多选批量应用规则。库保存串行化，失败保留当前内存状态。
- 上限：每次 1–100000 条、1–200 个字段，方案 128 KiB；每条生成结果最多 1 MiB、单批次 64 MiB。后端最多同时生成 2 份，使用临时 JSONL 文件和偏移索引，预览每页 50 条；最多 8 份缓存 / 128 MiB，新批次加入时清理已超过 2 小时且不在写入的缓存。关闭页签释放缓存。
- 冻结批次有独立 ID。预览、导出、写入读取同一文件；改规则使预览失效。提交前检查只读、连接配置签名与结构指纹。原子状态从 ready → writing → consumed，同一批次仅允许一次提交；读/校验失败且尚未提交时可修正连接后重试。
- SQL：真实列类型/长度/精度、NULL、生成列/identity、自增、主键/唯一索引校验；MySQL DEFAULT_GENERATED 默认时间戳允许覆盖，TIMESTAMP 使用会话本地时间输入，PG 带时区时间类型要求偏移；SQLite 复合主键不当作自增列；每 100 行一个参数化事务。MySQL 首轮只对 InnoDB 开放写入，其他引擎表可预览导出。外键引用由用户用固定值/候选值提供，不自动读取业务数据。未知类型、二进制、向量写入暂不支持，可使用允许的默认/NULL。
- MongoDB：仅读取集合验证器和索引，不采样现有记录。支持点路径嵌套、EJSON 常量/候选值；整数规则转 BSON Int64，小数转 Decimal128，日期转 UTC Date。省略 `_id` 时在冻结批次生成 ObjectId；每个文档明确提交，集合完整验证器/唯一索引由数据库最终校验。目标集合需已存在。
- Redis：首轮 String/Hash，配置 key/value、TTL；String 值为文本，Hash 为非空字符串键值对象。每个键由 Lua 原子检查不存在并创建/设 TTL；遇到已有键停止，不覆盖。需要账号允许 EVAL 及对应命令。
- 执行确认展示会话、环境、主机/文件、库/对象和条数。取消仅停止后续批次；已提交部分保留。明确返回失败、结果不确定、未尝试分别统计；网络/超时结果不确定不自动重试，提示核对目标。任务中心显示进度、结果、取消和来源页签。
- 导出 JSON/JSONL；SQL/Redis 另支持 CSV。MongoDB 不导出 CSV，以保留嵌套结构和 BSON 类型。CSV 本身不保留类型，要求无损时用 JSON。文件先写临时文件再替换目标，取消/失败不破坏已有导出文件。

- v0.112 本地文本模板扩展：支持 `{uuid}`、`{uuid32}`（同一行各文本字段共享新随机 UUID）、`{seeded_uuid}`（按种子复现）、`{run_id}`（整个生成任务共享随机批次号）、`{n}` / `{n:6}`（全任务连续行号，可补零）、`{date}` / `{date:yyyyMMdd}` / `{date:yyyy-MM-dd}` / `{date:HHmmss}` / `{date:yyyyMMddHHmmss}`、`{timestamp}` / `{timestamp_ms}`（任务开始时的 UTC 日期时间）、`{int:下限:上限}` / `{hex:长度}` / `{alnum:长度}`（按种子生成、可能重复）。时间和随机 UUID 不受种子影响，随机串每次出现分别取值。
- 原 `${参数名}` 和 `{n}` 保持兼容，参数内容不递归展开。未识别花括号保留原文以兼容 Redis hash tag、JSON 等文本；已知变量格式错误在方案校验时拒绝，避免先调用 AI。补零宽度 1–20、随机串长度 1–128、整数为有符号 64 位闭区间；单字段展开仍最多 1 MiB。仅处理本地“文本模板”字段，不扫描或改写 AI 返回内容。
- 新增独立 `random_uuid` 规则；原 `uuid` 保持算法和种子行为，UI 明确标注“按种子复现”，防止旧方案失去可复现性。新建议规则的 UUID 字段使用随机 UUID，Redis 默认键改为 `test:${prefix}:{uuid}`；旧方案/已保存模板不自动改写。生成预览冻结最终值，写入和导出不再次展开；保留任务内唯一检查及 Redis 原子不覆盖检查。
- 模板参数编辑提供可插入变量、中文说明及常用模板。用随机 UUID 或批次号加行号降低重复运行冲突，不承诺随机字符串/时间戳全局唯一，Redis 已存在键仍报告冲突。

#### G3：AI 协助生成

- v0.108 默认使用 Chat Completions SSE 流式内容生成，可在生成页关闭流式以兼容其他服务；规则建议和连通性测试仍使用非流式。协议处理 `delta.content`、`finish_reason`、末尾 usage 和 `[DONE]`，支持跨网络分块的 UTF-8 / CRLF / 心跳；不显示服务的推理字段。兼容服务忽略 stream 而返回普通 JSON 时按完整响应处理，不会伪装逐字输出；HTTP 不支持时明确失败，可手动关闭流式，不自动重发请求。
- 协议依据：[Chat Completions streaming events](https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events)。流式请求使用 `stream: true` 和 `stream_options.include_usage`；只统计服务实际报告的用量，缺失不估算。
- 生成时自动打开过程面板，可收起并从当前页再次打开。展示当前行区间、耗时、接收字符数、已校验数量与已完成请求用量。通过独立 Tauri Channel 传递当前任务事件，不把数据正文存进任务中心或工作区快照。前后端约 80 ms 合并更新，首段及时展示；v0.110 将 SSE 协议传输上限与 AI 正文上限分开计算，避免协议包装提前触发限制。
- v0.110 在请求结束、失败或取消时发送已接收响应快照；数据生成错误条、错误弹窗及过程面板提供“查看 AI 响应”。可选择批次、分页查看与复制正文，显示 HTTP 状态、传输/正文大小、截断标记和服务错误事件；非流式无法解析或 HTTP 失败时保留原始返回正文。响应只在当前生成页内存中保留，最多最近 20 批及 4 Mi 个 UTF-16 代码单元（约 8 MiB 文本内存），超额移除最早批次并提示；每页显示 32768 个代码单元。旧版本未保留的响应无法追溯，重试会替换现场。
- 通道有显式结束事件，命令结果返回后等待最后事件交付（异常通道最多等待 1.5 秒），再固定成功/失败状态；前端每次生成分配独立序号，迟到内容不进入下一次任务。流式 `[DONE]` 到达即可结束读取，不等待服务保持连接后的超时。
- 流式文本与已校验预览分开：当前批次文本保留末尾 65536 个字符；每个最多 10 条的响应完整返回后校验，逐行追加前 100 条样本（单元格最多 500 字符）。失败/取消后保留此次面板内容和出错行（JSON 展示最多 32768 个字符），不产生可写入批次。成功后完整数据仍来自冻结批次，不会重新调用模型。
- 结果提醒：生成成功/失败/取消有全局通知和过程面板；其他生成相关操作失败显示独立原因弹窗，页面保留醒目的固定错误条。分批写入失败仍展示已提交/失败/未尝试数量，不宣称整个写入回滚。
- 唯一性诊断包含当前生成行号、唯一索引名与字段名，并展示失败候选行。后续请求带上本次已生成的唯一值（仍受 128 KiB 提示词上限约束），减少跨批次重复，不发送数据库已有记录；重复时不自动修改值、不跳行、不重试付费请求。此处检查的是生成批次，数据库已有值和排序规则仍由实际写入再次校验。
- v0.107 将 AI 区域置于字段规则之前，提供独立主按钮“AI 直接生成数据”：选择服务、填写要求后自动将业务字段改为 AI 内容规则，立即调用生成接口并打开冻结预览，无需先运行规则建议。默认服务或唯一服务自动选中，可手动切换。
- 自动选择范围在提交前显示。保留数据库生成列、显式省略/NULL、序列、UUID、ObjectId、计算规则及 Redis key；未知/二进制字段不自动转换。其他业务字段交给 AI，原数值/候选值/日期规则仅作为未指定要求时的参考，已有 AI 字段要求与唯一标志保留。直接生成将更新当前方案，后续可调整字段规则。
- 没有服务、要求为空、条数不在 1–2000、没有可生成字段时明确报错，不回退本地生成。后端在请求前报告行区间与字段数；提示词携带总数、起始行号、引擎与 Redis 类型。返回错误、条数/字段/类型不符或截断仍拒绝生成可写入批次。
- 规则建议入口更名“仅建议生成规则…”。底部按钮按配置显示“按本地规则生成”或“按当前规则生成（含 AI）”，提示是否调用 AI；预览显示来源及实际请求/token 数。直接生成仍不写入数据库，写入需单独确认。
- “根据要求建议规则”发送用户要求、字段名称/类型/注释、规则目录；返回规则经本地解析与适配器校验后，先展示给用户，明确“应用建议”才覆盖当前配置。
- 将选定字段设为“AI 生成内容”后，每批最多 10 条，发送这些字段的要求、目标字段信息和本批本地生成值；要求返回相同条数且只包含所选字段，之后执行依赖计算、约束校验和冻结。一次含 AI 字段的任务最多 2000 条。
- 不自动发送已有业务记录；界面可展开查看字段上下文与发送范围。显式生成/建议操作才访问服务。AI 内容只作为数据，不执行其中指令、SQL 或代码；拒绝多/少行、字段不符、截断、拒答、非法 JSON 与目标类型不符等结果。
- 后续 G4：多表依赖与自动引用、其他 Redis 类型、可编程扩展、语义向量/embedding、跨进程恢复冻结批次与断点续写。本轮不实现。


---

### 19.2 数据分析 A1＋A2 设计（v0.114）

#### 入口与统一模型

- 数据分析是独立工作区：状态栏「数据分析」和欢迎页「数据分析：新建 / 打开方案」为显式入口，工作区菜单入口保留。选择 SQL / MongoDB 会话和数据库，即可自行编写查询、保存或打开方案，无需先执行普通查询。新建/打开时按需建立连接，但不执行分析查询；Redis 暂不支持。
- 表/视图页和 MongoDB 集合页提供「新建分析」：仅预填会话、数据库及表 SQL / 集合，不沿用当前列表结果、分页或筛选；表 SQL 按引擎引用数据库/schema 与表名。
- 查询结果与 MongoDB 聚合结果的辅助入口统一命名「用此结果绘图」，复制当前结果为一次性内存快照，记录实际执行的 SQL / 管道和数据库；分析页后续修改或执行不与来源页联动。
- 独立分析页签按会话归属，工作区恢复只恢复配置，首次打开和重启恢复均不自动执行查询。入口的默认数据库仅取同一会话的活动页签，避免跨会话误带数据库。
- `AnalysisPlan` 保存版本、ID、名称、会话 ID、数据库、SQL / 管道、集合、参数、图表配置，以及可选的备注来源表和名称关联配置；不保存连接密码、AI 配置或结果数据。`Dataset` 保存列、行、范围、采集时间和数据质量提醒，仅驻留内存。
- SQL 列 ID 按名称＋同名序号生成，查询重排字段不会绑定错误的 Y 轴；MongoDB 路径使用独立分段编码，字面量含点字段与嵌套字段不冲突。MongoDB 展开最多 8 层 / 200 个字段，数组以文本展示，支持 Canonical Extended JSON 数值、日期和 ObjectId。

#### 绘图与统计

- 柱状、条形、折线、面积、饼、环、散点、直方图、指标卡；支持分类、单个数值字段、分组系列、求和/平均/记录数/最小/最大、结果顺序或数值排序、Top N。分类数较多时提供坐标缩放，分类/系列图例采用可搜索、独立滚动的侧边明细；图表响应容器尺寸、深浅色和强调色。
- 分类上限 200、系列上限 12，裁剪明确提示，不把剩余分类隐式合并。直方图支持 2–100 箱，包含最大边界；饼图拒绝负数，全零不绘制虚假等分扇区。空值不变成数值 0，缺失与同名字面量分类不混淆。
- 数据页每页 100 行并支持横向滚动；字段概况包含行数、空/缺失数、非空不同值数、有效数值数、最小/最大/平均。统计仅覆盖当前 Dataset；日期分桶和跨字段计算在 SQL / 管道中完成。
- 数值图表采用浮点近似，非精确财务计算。新 SQL 分析命令在 IPC 前把超出 JavaScript 安全整数范围的整数转为十进制文本，保留原值但不参与绘图；从旧查询页带入的已不安全整数按缺失值处理并提示重新执行。截断、二进制与只读扩展单元格不参与统计。

#### 字段备注、名称关联与图例（v0.117）

- SQL 分析新增「字段备注与名称关联」。备注从用户选择的表结构读取，按唯一同名输出字段匹配；从表页新建分析自动预选该表，任意 SQL 可手动选择。重复字段名、别名和计算字段不推测血缘，查询修改后应检查来源表。备注读取失败只给提醒，不丢弃已查询数据。
- 名称关联支持同会话、同数据库的 MySQL / PostgreSQL / SQLite 表或视图，可跨 PG schema；配置分析字段、名称表、键字段、名称字段，无需物理外键。仅增加名称列，不覆盖原 ID、不扩增事实行数。分类轴/系列原本选中该 ID 时自动切换名称列；散点图保留数值字段。配置随方案和工作区草稿保存，旧方案兼容。
- 名称表通过现有只读分析命令查询（标识符按引擎转义），上限 5,000 行 / 8 MiB。超限、同键异名或分析字段消失时停止刷新并保留之前数据。相同键的相同名称可去重；NULL 不匹配；未匹配/无名称 ID 给提示并保留 ID。大整数文本保持精度；不同 ID 同名时附 ID 区分，显示标签碰撞不会合并分类。
- 该配置是结果名称映射，不要求改变主查询；主结果、备注和名称表分次读取，并非同一事务快照。多条件、一对多、跨库等复杂关联应在分析 SQL 中自行 JOIN；MongoDB 本轮不提供此名称表配置。
- 饼/环图悬浮提示和图例明细显示一位小数百分比，分母明确为当前展示分类合计；Top N 外的数据不计入，并非全库占比。四舍五入后的百分比可能不严格合计 100%。全零无虚假扇区，负数仍拒绝饼图。最多 5 个分类显示外部标签，更多分类使用完整侧边明细避免重叠；环形中央显示当前展示合计。
- 图例右侧独立滚动、搜索、高亮定位，不隐藏数据或改变占比分母；窄窗口移到图表下方。PNG 导出绘图区与所有当前展示分类/系列的图例，忽略屏幕搜索词及滚动位置；长名称在图片中截断，完整名称保留在图表 CSV / 数据 JSON。
- 图形能力参考 [Apache ECharts 饼图标签文档](https://apache.googlesource.com/echarts-doc/+/95b341a730ff89b4bb7cb7c19d3d2641fe88958a/en/option/series/pie.md)。

#### 查询范围、参数和持久化

- 从查询结果进入时标明「当前查询页、非全量」。点击执行按分析页当前 SQL 重新读取，不继承来源页码及表头临时排序。
- SQL 使用新的 `analysis_query`：单条 SELECT / 只读 WITH 语句校验，拒绝多语句、写入 CTE、INTO、锁定和可执行注释；对结果最多取 5001 行探测截断，展示最多 5000 行，序列化后结果超过 8 MiB 则拒绝，超时 60 秒。SQL 校验是语句级约束，不能代替服务端只读权限或判断自定义函数副作用；不支持 PG dollar quote 与有歧义的反斜杠转义语句。
- MongoDB 复用已有只读阶段白名单与 `mongo_inspect`：最多 500 条 / 8 MiB。两类查询复用连接、任务中心、取消和错误提示；SQLite 查询可能需等待当前语句结束，取消完成后不采用结果。
- SQL `:name` 参数复用后端类型化 literal 渲染；提供文本、数值、日期、NULL，日期作为数据库可解释的文本值。MongoDB 使用完整字符串占位符 `":name"`，只替换值；数值以 Decimal128 Extended JSON 传递、日期转换为 UTC。参数不替换字段名或 SQL 片段。
- 方案存储于本地 SQLite 设置 `analysis_plans_v1`，上限 100 项 / 2 MiB，串行持久化且写入成功才更新内存。支持保存、修改名称、另存副本、确认删除；关闭未保存方案走统一编辑保护，查询/保存过程中不关闭页签。
- 修改查询或参数后保留上一份结果并提示待刷新；失败保留现场与醒目错误。工作区自动恢复草稿及配置，但不恢复结果，不自动连接或执行分析。

#### 导出与后续范围

- PNG 包含图表、范围及分类/系列裁剪说明；CSV 导出当前图表聚合数据，附范围与采集时间并处理公式注入字符；JSON 导出规范化数据、列、来源查询、图表配置和提醒。文件经过格式和 16 MiB 上限校验，同目录临时文件写完才替换。
- 首期不接入 Redis 分析、不跨连接联表、不自动定时刷新、不保存或导入结果快照；每张图一个数值字段，可按分类字段分系列。SQL 原始数据中的精度问题不通过图表假装修复。
- A3：AI 协助生成分析查询及解释图表；A4：多图看板与全局筛选。均不属于本轮。

### 19.3 AI 查询助手 Q1＋Q2（v0.118）

- 入口：SQL 查询页与表/视图标题栏「AI 查询助手」。支持 MySQL / PostgreSQL / SQLite；表页默认选中该表，查询页优先使用同会话同数据库的对象浏览器选中表。MongoDB 管道生成不在本轮。
- 可搜索并选择最多 20 张表，显式读取结构后才允许发送。上下文只包含表名/schema/备注、字段名/类型/备注/可空、索引、外键；不读取数据行，不发送连接地址、账号或密码、原始 DDL。发送区显示上下文、对话、SQL 和错误，SQL/错误可编辑。数据库方言及服务器版本由后端当前连接提供。
- 复用设置中的 AI 服务和默认模型；本次模型可覆盖，支持前往设置。Chat Completions 兼容传输、凭据读取、超时、响应体限制、错误密钥遮蔽复用现有服务。支持流式与非流式；正文增量每 80ms 刷新，实时尾部最多 64K 字符；完整保留响应受既有 2 MiB 限制并分页查看。正常结束、解析失败、取消均保留可用响应。
- 四种操作：生成、修改、解释、修复。生成/修改/修复返回独立 SQL 候选、中文解释及关联依据、假设、待补充问题；解释只返回说明，不产生可应用 SQL。继续追问携带本助手最近 8 条消息，可清空；内容仅驻留页签内存，不写入 SQL 历史。修复带入实际失败的 SQL（包含选中执行/当前语句），不会用上次成功 SQL 代替。
- 模型不得把备注/错误/SQL 当系统指令，不得编造字段；未加载的关联表应请求加入上下文。外键作为明确关系，推测关系列为假设。用户勾选接受假设后才能应用；有待补充问题时先回答。Q3 的共享逻辑关联库、业务口径尚未实现。
- 候选复用 analysis_sql 单条 SELECT/只读 WITH 词法校验；禁止写入、多语句、写入 CTE 等候选应用。该校验不证明语法、字段存在性、函数无副作用或业务正确性，不自动 EXPLAIN/执行，不代表数据库只读权限。
- 用户可通过 Monaco 差异对比确认替换、在编辑器选区/光标插入、打开新查询页或转入数据分析。全部操作只填入 SQL，不执行。应用到原页前比较生成时完整编辑内容及数据库，变化时拒绝覆盖，仍可新建查询页。候选不能绕过原 SQL 执行时的既有确认与权限控制。
- 请求进入任务中心，可取消；助手生成期间阻止关闭发起页签。编辑保护增加独立 registryKey，使 AI 忙状态与同一页签的 SQL 未保存状态共存。Monaco 差异模型在控件卸载后释放，避免模型提前释放异常。
- 输入限制：需求 16KB，SQL 64KB，错误 16KB，模型 ID 200 字符，总提示 128KiB。超限显式失败，不自动删减用户上下文或发送其他表。未对真实用户服务发起验收请求；接口兼容仍由用户配置的服务决定。
- 接口依据：[OpenAI 官方 Chat Completions 文档](https://developers.openai.com/api/reference/resources/chat)，继续沿用已有兼容接口。

### 19.4 AI 交互式澄清（v0.119）

- AI 问题支持结构化题目、单选/多选及必填具体值；兼容旧接口字符串问题为文本输入，不预选、不自动提交。
- 收到问题自动打开有界滚动弹窗；可稍后回答并重新打开。自由补充始终可用，具体 ID/日期等问题需填写后继续。
- 提交携带原始请求、累积问题与答案继续生成，独立于最近 8 条对话截断；不执行 SQL。失败保留回答供重试。
- 会话/数据库切换清除旧问题；需求、操作或结构范围变化禁止继续旧问题，需重新发送。需求与累计回答仍受 16 KB 请求上限约束。

### 19.5 分析 SQL 编辑器（v0.120）

分析 SQL 使用 Monaco，复用普通查询页的 SQL 补全提供器，支持关键字、表名、schema、别名字段与字段类型/备注提示。补全按当前会话和分析数据库读取元数据，切库后不复用旧库结果；组件卸载释放提供器。编辑器跟随应用主题，显示行号、语法高亮，支持 Ctrl+Space 手动触发。保留分析参数绑定、方案保存和显式执行流程；执行期间只读。MongoDB 管道输入不受本次改动影响。

### 19.6 分析页紧凑布局与补全定位（v0.121）

- 分析 SQL 的补全浮层采用编辑器内绝对定位，避免固定浮层在应用 transform 缩放容器内重复应用坐标；外层允许补全浮层溢出，不裁切候选。
- 分析页与分析库的字段、输入、选择和按钮统一使用 small 尺寸；收紧页边距、区块间距、表格行、图例明细及关联配置。SQL 默认高度 156px，保持内部滚动。
- 图形画布原有高度、最小高度和响应式布局保持不变；窄窗口仍自动换行。

### 19.7 同步指定表选择（v0.122）

- 修复加载表列表后错误跳至第三步：端点 → 选择对象 → 对比与执行。
- 表默认不选；支持按表名/备注搜索、选择筛选结果及清空，未选择禁止继续。第三步展示所选表名。
- 结构/数据对比、结构脚本预览及两类执行沿用同一所选表范围，分别确认执行；目标缺表时先结构同步再数据同步，无主键表仍按原规则跳过数据同步。
- 返回重选清除旧差异；数据库加载时锁定端点选择；会话列表只显示已连接的 SQL 引擎会话。同一会话可选不同库。
- 本次不改变后端同步协议及现有 schema 解析范围；跨 schema 映射与跨引擎同步不在本次范围。

### 19.8 MySQL BIT 默认值同步（v0.123）

MySQL 元数据返回 BIT 字段默认值如 b'0'，同步建表/修改列应保留为位字面量，而非再次作为字符串转义。按列类型识别 BIT，验证位内容后保留 b'...'；兼容 B'...'、0b... 输入。普通文本列不使用此特殊规则。结构同步返回失败时显示失败提醒，不再提示同步完成。

### 19.9 同步 SQL 的端点数据库限定（v0.124）

MySQL 表元数据 schema 保存所属数据库，不能覆盖当前同步端点。统一限定规则：MySQL 使用操作端点 database，PostgreSQL/SQLite 保留库内 schema。覆盖同步建表、索引、改表、扫描、数据增删改及回滚材料；MySQL 外键引用显式指向目标库。表名、库名继续通过标识符引用转义，不做原始 SQL 字符串替换。跨库外键映射不在首版统一模型能力内。

### 19.10 全局同步页签与源数据筛选（v0.125）

- 同步工作区使用独立 sync 标签类型（全局，不绑定会话）。每次新建生成独立页签，多页配置、比较结果、日志和任务来源隔离。任何会话下均可访问全局同步页，运行期间禁止关闭对应页签。
- 源/目标、所选表、同步选项与筛选条件随工作区持久化；恢复后从端点步骤重新加载，不恢复执行中状态、不自动比较或写入。快速打开、重开关闭页签与任务中心返回支持全局同步。
- 任务通过明确的发起页签 ID 关联，避免切页后归属改变；后台同步确认框随页签隐藏，执行期间可切换到其他同步页。
- 每张所选源表可配置最多 50 条字段条件，AND/OR 组合，支持等于、不等于、大小比较、包含、NULL 与区间。复用后端白名单操作符、列名校验和方言字面量转义；不接受原始 WHERE SQL。
- 源端主键分页每页均包含相同筛选，OR 条件整体括号化后与游标条件 AND 合并。对比与执行共享筛选；结构同步不受影响。无条件的表仍读取全部源行。
- 目标端按主键扫描匹配，只新增/更新匹配源行；筛选模式 UI 关闭删除目标多余行且后端强制拒绝该组合，目标未匹配行不计为待删除。目标行数表示扫描行数，未实现仅按命中键查询目标的性能优化。
- 保留首版同引擎、主键要求与现有 schema 范围；本次没有新增跨 schema 映射或自动执行任务调度。

### 19.11 内嵌智能生成（v0.128）

- 查询和 SQL 分析编辑器通过「智能生成」展开左右各半区域；窄窗口上下排列。原 SQL 保留，右侧需求输入、流式内容和最终预览在同一区域。表页移除独立助手弹窗入口。
- 使用默认 AI 服务（未指定默认时采用首个已保存服务），固定流式请求，无服务/模型选择与流式开关；没有配置时显示设置入口。
- 需求编辑器输入 @ 补全表名，表名后点号补全字段，候选显示备注；Ctrl+Space 也可触发。提交自动读取需求/原 SQL 引用的表、当前对象及外键关联表结构。最多 20 张；小库可使用全库结构，大库无法匹配时要求在需求引用表，不任意猜选。
- 澄清面板从底部滑入居中，支持单选、多选和具体值，允许暂存/继续回答；只在当前页签且面板展开时显示。
- 确认后追加到当时最新 SQL 的末尾，补充语句分隔符，不替换选中内容、不执行 SQL；同一结果防止重复追加。只读校验和关联假设确认沿用。
- 收起保留需求及生成任务，任务绑定发起页签；切换数据库不混用旧上下文。失败保留响应；停止后丢弃迟到结果。

### 19.12 智能生成纯 SQL 输出（v0.130）

- 取代 v0.128 的确认追加交互：生成区仅显示逐步解码的 SQL，隐藏 JSON 包装、假设确认、解释与原始响应。成功完成且不需澄清时自动追加到最新编辑内容末尾，不执行。错误/取消仅保留当前部分输出，不自动追加。
- 固定显示「内容由 AI 生成，涉及修改的语句请仔细甄别！」。用户明确要求时允许生成修改 SQL；生成阶段不再以只读检查阻止输出，实际执行入口原有权限、危险语句检查与分析只读限制继续生效。
- 停止按钮固定在生成栏头，不挤占提示词下方区域。必要业务澄清继续通过原滑入面板回答。
- 查询和分析页新增中间分隔条；宽窗口调左右比例，窄窗口调上下比例，范围 25%–75%，支持键盘、双击恢复和配置库持久化。

### 19.13 编辑区视觉精简（v0.131）

查询与分析共用的 SQL / 智能生成编辑区移除栏头、结果、提醒的重复分割线；以轻微底色与留白分区。左右及上下拖动条去掉双边框，保留低对比短手柄，悬浮或键盘聚焦时强调。

### 19.14 轻边界与生成风险（v0.132）

编辑面板使用单层低对比圆角边框、栏头单线和独立提示词框；行号区沿用编辑区底色。AI 提醒仅在 SQL 非空时出现。模型返回 risk.level（none/yellow/red）和中文原因，本地词法检查排除字符串和注释并检查查询范围、修改与 DDL；两者取高等级。全表查询、数据/表修改黄底提示，DROP/TRUNCATE/索引调整红底提示。多语句及 CTE 一并检查。风险评估仅为启发式提示，不代表安全保证；执行入口权限与确认不变。

### 19.15 只读加固与生产默认保护（v0.136）

- 普通 SQL 执行、分页及执行计划统一检查完整语句：拒绝未知命令、多语句、可执行注释、修改型 WITH、锁定读取、PRAGMA 和部分具有副作用的函数。force 确认不能绕过只读。保守词法规则会拒绝部分合法复杂 SQL，不支持的语法需明确关闭只读后使用。
- 结构/数据同步目标必须可写；结构每条语句、数据每批提交前复查。只读源仍可比较、预览、读取。界面禁用只读目标的执行按钮。切换只读不能回滚已经发送或提交的操作。
- SQLite 使用只读连接；MySQL 新连接设置 SESSION TRANSACTION READ ONLY；PostgreSQL 设置 default_transaction_read_only。应用保存会话配置后断开旧连接，重连应用新模式。Redis/MongoDB 保留各写入接口后端校验与命令白名单。
- 选择生产环境默认开启只读；关闭只读必须确认危险操作，取消保留只读。生产可写状态常驻红字提示。升级时仅一次将既有生产会话设为只读，后续保留用户确认后的选择；迁移与标记使用本地 SQLite 事务。
- 只读仍是防误操作机制：无法替代数据库账户授权，尤其是自定义函数、外部副作用、临时对象或高级管理权限。生产账号建议保持数据库侧最小权限。

## 20. 实现状态

### v1.0.0-alpha.7 README 双语与界面示例（2026-09-30）

- 已完成：保留中文 README 作为默认入口，新增英文版 `README.en.md`；两版页首互相切换，并提供相同顺序的章节目录与稳定锚点。
- 已完成：两版均加入表结构、表数据、SQL 编辑器、MongoDB 文档、Redis 概览五张仓库内截图及简述。MongoDB 截图的凭据摘要和文档原文已由示例内容替换，原始截图未入库。
- 已验证：目录目标、双语互链、五张图片路径与文件存在，Markdown 差异无空白错误。本次仅改文档与图片资源，应用版本和构建产物不变；下一功能项仍为 R05，路线图完成 4/39，随本次提交归档。

### v1.0.0-alpha.7 SQLite 文件拖入快速建会话（2026-09-29）

- 拖入 SQLite 数据库文件后打开已有的新建会话表单，自动选择 SQLite、填写规范化文件路径和会话名；同名会话追加编号，手动输入的名称保留，点击保存才创建会话，不自动连接。
- 后端以只读方式识别 SQLite 文件头与页大小，兼容中文/空格、无扩展名文件；不复制、不改写文件，拒绝目录、不存在、空白/加密/非 SQLite 文件。文件头检查不等于数据库完整性验证。
- 一次一个文件，拒绝覆盖已有会话编辑、复制、测试/保存中的表单或其他对话框；异步识别绑定编辑上下文，取消不创建，失败保留输入。
- 使用 Tauri 原生文件拖放。Windows HTML5 拖放与原生文件拖放冲突，因此页签排序改为指针拖动，保留插入标记、滚动、点击、关闭与取消行为；现有浏览器文件导航保护继续生效。新增会话表单和空会话列表提供紧凑提示。
- 验证：128 项 Rust 测试、前端构建及浅色/OLED 会话交互和标签排序回归通过；桌面原生事件及路径联调、正式安装包/便携目录/ZIP 与两份 SHA256SUMS 校验通过。记录见 [SQLite 拖入验收](verification/sqlite-drop-alpha7.md)。本项优先于 R05，路线图仍完成 4/39；随本次提交归档。


- 2026-09-28 提交归档：R04、alpha 发布规范及 alpha.1～alpha.6 已汇总提交为 [830bec9](https://github.com/SerLiunx-ctrl/dbfolio/commit/830bec9d308f55f4dc13710ee1906c0ae85d8616)；127 项 Rust 测试与三引擎 UI 回归通过，正式安装包/便携版及摘要已验证。版本保持 1.0.0-alpha.6，路线图完成 4/39，下一项 R05。

### v1.0.0-alpha.6 关系型数据库标签页建表（2026-09-28）

- 数据库菜单“新建表”打开独立的“新建表*”草稿页签，移除旧建表弹窗。可同时打开多份草稿，切换保留输入，首次保存前不查询新表元数据或显示数据页。
- 新建与查看表共用子页签导航、信息属性表单和字段行编辑器：信息页填写表名/注释；MySQL 引擎/字符集/排序规则联动选择；PostgreSQL 可填写 schema；SQLite 隐藏不支持的属性。结构页双击编辑名称/类型/长度集合/默认值/注释，复用类型颜色，主键/可空/自增等使用选择框。右键支持插入、移动、删除、创建/加入索引。
- 索引及外键在紧凑列表内双击编辑，列从草稿选择，外键引用表和列读取真实元数据，支持复合字段选择顺序与自引用。字段改名联动引用；删除受依赖的列先提示移除索引/外键引用。DDL 页按当前完整草稿生成 SQL 并复用编辑器高亮。
- 保存统一提交信息、字段、主键、索引和外键；MySQL 包含外键时要求显式选择 InnoDB，防止其他引擎静默忽略约束；使用单条 CREATE TABLE 包含索引/约束/表选项，SQLite/PostgreSQL 建表及后续索引/注释在事务中执行。后端检查空名/重复字段、类型注入、引用字段、外键规则、自动增长及引擎能力。只读禁止提交，保存过程中阻止重复保存及关闭，失败保留草稿；成功后在原页签切换为表详情、显示数据页并刷新对象树。
- “废弃”重置草稿，关闭/断开沿用统一未保存保护；草稿驻留当前进程，不承诺退出后恢复。不能确定服务端写入结果的错误不自动重试；用户可刷新对象列表核对。
- 验证：127 项 Rust 测试通过、13 项需外部服务测试忽略；三方言 SQL 解析、真实临时 SQLite 建表/约束/默认值/索引/事务回滚通过，三引擎三主题 UI 与既有行内编辑回归通过。MySQL/PostgreSQL 本轮未连接真实服务端执行建表。记录见 [标签页建表验收](verification/create-table-alpha6.md)。正式安装包、便携目录/ZIP 及两份 SHA256SUMS 已生成并校验通过，代码提交 [830bec9](https://github.com/SerLiunx-ctrl/dbfolio/commit/830bec9d308f55f4dc13710ee1906c0ae85d8616)，R21/R22 不标记整体完成。


### v1.0.0-alpha.5 PNG / 高分辨率预览与原图导出（2026-09-28）

- PNG 改为按块识别完整 IHDR / IDAT / IEND，兼容 IEND 后附加字节、image/x-png 及带参数的 Data URL；格式仍以文件签名为准。
- 图片读取上限提高到 64 Mi 字符，自动补读最多 2 Mi 字符、并发 2；最多预览 1 亿像素且单边不超过 32768。超过尺寸限制的已识别图片明确提示并可导出；超过文本上限则保留文本。
- 缩略图按长边 96 像素解码，适应窗口按长边 2048 像素准备位图；原始尺寸按需加载。改用 Blob URL，切换/关闭/刷新时释放；GIF 详情保留动画，缩略图可为首帧。
- 详情和完整值编辑共用“导出原图”：按真实格式提供扩展名，经原生保存对话框保存解码后的原始字节，不重编码缩略图。预览失败或尺寸超限时仍可导出，失败显示原因；后端使用同目录临时文件原子替换。
- 验证：8000×4000 PNG、9 Mi 字符 PNG、三引擎三主题合成 UI、原图/原文切换、导出取消/失败/字节一致性、Blob 回收、Rust 限长读取与原子写文件测试通过；见 [验收记录](verification/base64-images-alpha5.md)。代码提交 [830bec9](https://github.com/SerLiunx-ctrl/dbfolio/commit/830bec9d308f55f4dc13710ee1906c0ae85d8616)，正式安装包、便携目录/ZIP 及两份 SHA256SUMS 已生成并校验通过。
- 已知边界：未取得用户出现问题的原始 PNG 文件，以合成图片覆盖已发现限制；损坏或浏览器不支持的编码仍可能无法预览。无主键/查询截断结果不猜测来源补读，SVG/URL/BLOB/嵌套 JSON 范围不变；R15 仍部分完成。


### v1.0.0-alpha.4 Base64 图片预览（2026-09-28）

- SQL 表数据与查询结果共用 Base64 图片识别、紧凑缩略图和详情预览；单击查看完整图片，支持适应窗口、原始尺寸与原始文本切换。现有完整值编辑也可在图片和原文间切换，保存、复制仍使用原始字符串。
- 尝试 PNG/JPEG/GIF/WebP/BMP 的 Data URL 和纯 Base64，校验签名、文件完整性特征及尺寸；无法识别、过大或解码失败时退回文本，不执行外部资源请求。
- 截断值按可见单元格及主键补读：自动最多 512 Ki 字符、并发 2；点击最多 8 Mi 字符。后端在 MySQL/PostgreSQL/SQLite 分别使用 CHAR_LENGTH/LENGTH 判断上限；无主键或查询截断结果不猜测来源补读。异步结果绑定当前值，刷新不显示旧图片。
- 已知边界：SVG、外部 URL、BLOB、JSON 嵌套字段及超过大小/像素限制的内容不自动预览；仍可查看文本。本次只覆盖 R15 的部分图片体验，不将整项标记完成。
- 验证与交付记录见 [Base64 图片验收](verification/base64-images-alpha4.md)；前端构建、SQLite 限长读取及三引擎合成界面回归已通过，正式安装包、便携目录/ZIP 及两份 SHA256SUMS 已交付并校验；104 个目录/ZIP 文件与 NSIS 110 个资源完整。代码提交 [830bec9](https://github.com/SerLiunx-ctrl/dbfolio/commit/830bec9d308f55f4dc13710ee1906c0ae85d8616)。

### v1.0.0-alpha.3 跨引擎行内结构编辑一致性（2026-09-28）

- 修复仅 MySQL 采用新结构交互的遗漏：MySQL、PostgreSQL、SQLite 共用列行组件，默认显示文本，双击/Enter 激活编辑，长度/集合单独列；修改统一暂存、SQL 预览、保存/废弃。保留右键创建/加入索引、删除及可用的调整顺序操作，取消旧列编辑弹窗入口。
- SQLite 支持改名、声明类型/长度、默认值、可空和可用的 AUTOINCREMENT。必要重建基于原 CREATE TABLE 语法树，在独立连接事务中保留约束、索引、触发器、视图引用、生成列、STRICT/WITHOUT ROWID、可保留的 rowid 与自增序列，外键检查失败整批回滚。改名/删列采用原生 ALTER，修复元数据把普通 INTEGER 主键误标为显式 AUTOINCREMENT。
- PostgreSQL 补齐名称、类型、长度、默认值、可空和注释批量保存，原生 ALTER/COMMENT 在事务内执行；默认值与注释转义支持反斜杠和单引号。未修改的属性保持原定义。
- 全软件共同入口能力分支检查：移除对象树重复的 MySQL 菜单；SQLite/PostgreSQL 添加列菜单改为准确的「追加列」；MongoDB 文档与 Redis 字符串编辑补齐显式废弃按钮。通用交互共用组件、引擎差异通过能力开关体现的规则写入 AGENTS.md。
- 已知限制：SQLite 外键编辑、生成列修改、特殊 CREATE 语法及结构同步重建尚未扩展；PostgreSQL IDENTITY/序列、任意默认表达式、需 USING 的类型转换仍通过 SQL 管理。SQL 文件完整导入导出和对象管理仍为 MySQL 功能范围，不将 R21/R22 标记完成。详细检查矩阵见 [跨引擎一致性验收](verification/ui-consistency-alpha3.md)。
- 验证：123 项 Rust 自动测试通过，13 项环境相关测试默认跳过；三 SQL 引擎行内编辑/预览/保存/废弃/菜单/只读/失败草稿、已有配色与元数据三主题及缩放回归通过，前端构建通过。SQLite 使用真实临时文件数据库；本机 PostgreSQL 10061 拒绝连接，新增真实执行专项尚未完成服务器验收。正式安装包、便携目录/ZIP 已交付，104 个文件摘要、NSIS 110 个资源及两份 SHA256SUMS 校验通过；代码提交 [830bec9](https://github.com/SerLiunx-ctrl/dbfolio/commit/830bec9d308f55f4dc13710ee1906c0ae85d8616)。

### v1.0.0-alpha.2 元数据配色与后台任务职责（2026-09-28）

- 索引类型、方法与外键删除/更新规则使用主题语义色；本地与引用列按真实数据类型配色，并附小号类型提示。引用表元数据按目标库/模式/表去重、最多四路并发；切换目标忽略过期结果，无权限时保留名称和“类型未获取”提示，不推测类型。
- DDL 使用与查询页相同的 Monaco SQL 语言、编辑器主题、字号与换行配置，提供只读选择/复制/查找，支持浅色、深色及 OLED。
- 任务中心仅展示导入、导出、同步、数据生成、AI 及允许收起的 MongoDB 工具作业。普通 SQL（含事务、分页、执行计划）、分析查询、MongoDB 浏览与单条修改、存储过程调用保留前台执行跟踪，不进入任务中心；完成后释放前台记录。后台记录不再被浏览查询挤占。
- 查询仍保留后端任务 ID、取消、连接占用和退出保护；停止查询按发起页签定位，避免同会话多查询互相干扰。普通查询结果和 SQL 历史继续由原查询页面管理。本节职责更新取代历史版本中“所有查询进入任务中心”的描述。
- SQLite/PostgreSQL 结构操作列、新增列确认/取消、索引与外键操作统一使用固定宽度及不换行的横排容器；修复全局按钮尺寸覆盖导致的行高膨胀。代码扫描未发现其他 TableCell 直接并列多个未包裹按钮。
- 验证：前端构建；元数据三主题、引用目标去重/权限失败/异步竞态、DDL SQL 高亮及只读；SQLite/PostgreSQL 80%～150% 缩放横排；三引擎原结构配色/行内编辑回归；前台成功/失败/取消清理、按页签取消和后台历史；原任务中心悬浮/键盘/缩放交互全部通过。独立无界面 Edge 使用合成元数据及 IPC，不读写用户数据库。正式安装包、完整便携目录及 ZIP 已构建：内置资源校验、104 个目录/ZIP 文件摘要、NSIS 110 个资源完整性、两份独立 SHA256SUMS 和 EXE 版本全部通过，产物位于 release/1.0.0-alpha.2/。代码提交 [830bec9](https://github.com/SerLiunx-ctrl/dbfolio/commit/830bec9d308f55f4dc13710ee1906c0ae85d8616)。
- 已知限制：引用目标不可访问或返回列类型缺失时不显示类型配色；任务中心历史仍只保存在本次进程内。


### v1.0.0-alpha.1 任务中心执行状态样式（2026-09-28）

- 底部任务中心在运行/取消等待期间使用静态 1px 强调色描边，图标改为固定任务列表；取消入口旋转圆圈、品牌底色、底部内阴影和加粗文字，数量徽标使用描边样式。
- 无活动任务时边框透明；两种状态保留相同边框尺寸，避免行高变化。配色使用主题强调色 token，跟随浅色、暗色、OLED 与自定义强调色。
- 继续显示进行中状态、任务数、悬浮真实进度和完整任务中心。原有来源页签及任务详情进度的交互保持可用。
- 验证：原任务中心悬浮、键盘、来源页签、结束状态、80%～150% 缩放与窄窗口回归通过；三主题检查入口无运行中的动画、背景透明、无阴影、普通字重及状态切换行高稳定。正式安装包、便携目录与 ZIP 已构建；内置资源校验、NSIS 110 个资源完整性、104 个清单文件的目录/ZIP 摘要和两份 SHA256SUMS 全部通过，产物位于 release/1.0.0-alpha.1/。
- 本项为用户界面反馈修复，路线图仍完成 4/39，下一项 R05。


### v1.0.0-alpha 版本与发布目录规范（2026-09-28）

- 公开预发布版本从 1.0.0-alpha 起算，后续 alpha 使用 alpha.1、alpha.2；统一前端、npm 锁文件、Rust 包/锁文件和 Tauri 版本。此前 v0.x 记录保留，不改写历史功能完成版本。
- 构建统一输出到 release/<版本号>/：NSIS 安装 EXE、完整 portable 目录、portable ZIP、安装版 SHA256SUMS、便携版 SHA256SUMS。文件名继续带产品、版本和 Windows x64 前缀。
- 安装版校验清单只列安装 EXE；便携版清单列 ZIP 和目录内所有文件（包括 distribution.json），使用相对版本目录的路径。便携清单采用无 BOM UTF-8，支持中文文件名。
- portable-fast 同样按版本归档，保留独立后缀与校验清单，不覆盖正式包。版本字符串在用作目录名之前校验，不允许路径分隔符。
- 原有 0.181.0 产物已移至 release/0.181.0/，EXE 和 ZIP 摘要不变，拆分补齐两份校验清单。前端资源继续外置，用户数据位置不变。
- 验证：正式 LTO/NSIS 构建、内置资源校验、NSIS 110 个资源完整性检查通过；目录/ZIP 内 104 个清单文件摘要一致，两份 SHA256SUMS 全条目通过，目录恰好包含约定五项。规则同步写入 AGENTS.md 与 README。本轮为发布规范调整，路线图完成数仍为 4/39，下一项 R05。

### v0.181 R04 连接安全与诊断（2026-09-27）

- 会话增加 network_config JSON，旧数据按默认值迁移；连接默认 15 秒、查询默认 60 秒，范围分别为 1～120 / 1～3600 秒。SQLite 仅使用查询超时。
- 单跳 SSH 支持密码与加密私钥：SHA256 指纹显式获取、核对、信任；地址变化清除信任，指纹变化拒绝连接。密码和私钥口令使用独立 Windows 凭据条目，支持复制、保留、清除、删除，不向 UI 回传秘密。
- 隧道仅监听 loopback 临时端口，共享 SSH 连接按驱动连接建立转发通道；失败、取消等待、断开会话和退出释放守卫并关闭监听/通道，隧道失联停止转发，不自动重连或重放 SQL。
- MySQL/PG 使用原生 SQLx TLS；本地补丁增加 tls_server_name，保证 SSH 本地端点与远端数据库身份分离。Redis/MongoDB 单主机使用验证证书链与服务器名的本地 TLS 桥接，支持客户端证书。MongoDB URI/SRV 走原生驱动，仅直连，客户端证书要求包含私钥的 PEM。
- 会话表单折叠显示紧凑安全配置；测试结束分步展示地址、网络、SSH、TLS、认证及默认库访问的成功/失败/跳过、说明与耗时。驱动协议将 TLS 和数据库认证合并握手时，按错误归类；不是逐包诊断或实时阶段流。
- 查询等待超时接入 SQL 读取、Redis 响应、MongoDB 读取；不将超时解释为回滚，不替代导入、同步等长任务独立策略。库访问检查不等于所有对象权限验证。
- 边界：单跳、不支持 SSH agent/复杂代理；TLS PEM 私钥不支持交互口令（SSH 私钥口令支持）。MongoDB 隧道限定单服务器。其他数据库服务当时未运行，实库联通重点验收 MySQL 8.4.6；不宣称已实测 PostgreSQL/Redis/MongoDB 的 TLS 集群。
- 验证与产物见 [R04 验收记录](verification/r04.md)。交付规则写入 AGENTS.md：每次代码改动验证后必须生成正式 NSIS 安装包和完整 portable 目录/ZIP。


- 2026-09-27 提交归档：R01～R03、结构类型配色与 MySQL 文本解码修复已提交为 [a07fa00](https://github.com/SerLiunx-ctrl/dbfolio/commit/a07fa00699a26922cdb833dae7793bff7cf0e819)；版本 0.180.0。

### v0.180 MySQL 文本与二进制类型识别（2026-09-27）

- 已实现：修正 SQLx 0.8.6 将带 BINARY 标志的 `_bin` 排序规则文本当作二进制的判断。仅对协议字符串族，根据返回列字符集/排序规则编号 63 判定二进制，保留其他标志；CHAR、VARCHAR、TEXT 正常显示文字，BINARY、VARBINARY、BLOB 保留字节值。
- 查询结果、表数据、长值读取和过程结果共用修正后的驱动类型信息；不按字节是否可转 UTF-8 猜测类型，也不修改服务器结构、排序规则或用户数据。
- 依赖决策：`src-tauri/vendor/sqlx-mysql` 保存上游 0.8.6 源码和许可证，Cargo 路径补丁仅修改 `type_info.rs`；已记录来源与升级时的移除条件。
- 验证：本机 MySQL 临时表先复现失败，再验证预处理/文本协议、中文/emoji、普通文本、NULL、空串、长文本预览及全值读取、真实二进制通过；Rust 108 项通过。MySQL 8.4.6 导入导出/对象管理专项回归通过；前端与 v0.180.0 目录式 portable-fast 构建、内置资源校验通过。
- 已知偏差：保留原有连接编码策略；SQLx 升级时需复核此本地补丁。路线图完成仍为 3/39，R04 未开始。

### v0.179 结构列表字段类型配色（2026-09-27）

- 已实现：结构页字段名、类型，以及 MySQL 的长度/集合复用数据网格的类型分类与主题色；数值蓝色、文本绿色、日期时间紫色、布尔橙色、JSON/二进制金色。
- MySQL 暂存修改字段类型后即时切换颜色，废弃修改后恢复；保留紧凑布局、双击编辑、只读限制，空占位符与操作控件不按字段类型着色。PostgreSQL、SQLite 结构列表同步接入。
- 验证：三引擎结构 UI × 浅色/深色/OLED 配色检查通过；行内编辑、类型切换/废弃、只读回归通过；前端构建和 v0.179.0 目录式 portable-fast 构建、内置资源校验通过。
- 已知偏差：无新增；未识别的字段类型沿用数据页文本颜色。路线图保持完成 3/39，R04 未开始，代码提交 [a07fa00](https://github.com/SerLiunx-ctrl/dbfolio/commit/a07fa00699a26922cdb833dae7793bff7cf0e819)。

### v0.178 R01–R03：SQL 文件与 MySQL 对象管理（2026-09-26）

- R01：独立导入页选择会话/数据库/编码；流式解码和语句拆分支持字符串、注释、可执行注释及 DELIMITER。预检固定临时快照（最多 8 份、30 分钟），执行消费一次，防止文件修改与重复点击改变已核对内容；单条 SQL 上限 64 MiB，预览只保留前 200 条/每条 400 字。
- 导入采用专用连接，逐语句记录 `pending` 与结果到用户选择的 JSONL 报告，刷盘后才发送 SQL。默认失败即停；显式事务内错误、存储程序部分失败、断线和不确定结果始终停止。取消在语句边界生效，单语句超时 300 秒；结束时回滚未提交事务，不能撤销 DDL/自动提交。客户端命令不执行，数据库白名单与只读检查在后端落实。
- R02：MySQL 视图/过程/函数/触发器/事件的分类搜索与定义读取、创建/替换/删除、Monaco 差异预览、静态依赖、视图数据入口、过程 IN/OUT/INOUT 参数和多结果、事件计划与调度器状态、表内触发器入口。目标切换与未保存编辑/运行任务互斥。
- 对象变更使用固定原定义做漂移校验；可预编译的定义先检查，MySQL 不支持预处理的存储程序走普通协议并检查单条定义边界。替换采用 DROP + CREATE，创建失败不自动重试或假装回滚，编辑器保留旧定义。过程调用需要单独确认并拒绝只读/无法校验范围的白名单会话，最多保留 20 组、每组 200 行、合计 8 MiB 结果；取消/超时/异常提示核对部分写入。
- R03：普通表导出增加五类对象，顺序为表结构/数据 → 函数 → 过程 → 依赖排序的视图 → 触发器 → 事件；保留创建 SQL_MODE/字符集环境，提供建库字符集/排序规则、DEFINER 保留或当前用户、目标库限定名映射、单文件/拆分/ZIP。对象定义变化阻止发布；沿用临时文件原子替换，取消不覆盖已有文件。
- 导入/导出方案使用本地设置持久化，保存目标与选项；不保存密码、文件内容和筛选值。过期表/字段重验，导入方案目标不一致需手动核对；不会自动执行方案。
- 已修复实测兼容问题：MySQL 存储程序和快照事务的预处理协议限制、SHOW CREATE 定义与导出表达式的 VARBINARY 解码、差异编辑器卸载时模型提前释放。
- 支持与偏差：已在 MySQL 8.4.6 验证；其他 MySQL 版本/MariaDB 未全面验收。暂不支持 NO_BACKSLASH_ESCAPES / ANSI_QUOTES、任意断点续传、自动整文件回滚；不重写动态 SQL 字符串。依赖为静态提示；空结果集的列名受驱动多结果 API 限制。ZIP 需先解压，拆分文件按编号导入。
- 验证过程、边界及最终产物见 [R01–R03 验证记录](verification/r01-r03.md)；实现状态按 [路线图](roadmap.md) 统一打标。
- 最终验证：前端构建通过；Rust 108 项通过，MySQL 专项独立通过；浅/深色交互及 100%～200% 控件缩放检查通过；v0.178.0 portable-fast 资源检查与 ZIP 内 104 文件摘要校验通过。R01～R03 已勾选，完成 3/39，下一项 R04，代码提交 [a07fa00](https://github.com/SerLiunx-ctrl/dbfolio/commit/a07fa00699a26922cdb833dae7793bff7cf0e819)。

### v0.177 文档修订 R1：有序功能路线图（2026-09-26）

- 新增 [功能路线图](roadmap.md)，将后续方案拆为 R01–R39，按 P0–P3 和依赖确定默认执行顺序；首项为 MySQL SQL 文件导入。
- 每项记录范围、现有基础及验收条件；开始时更新状态，验收完成后勾选并附日期、版本、验证和提交。规则同步写入 AGENTS.md。
- 当前完成 0/39 项，尚未开始功能实现。本轮仅修改规划文档，应用版本仍为 0.177.0；不因加入长期路线图而改变目前仅同引擎同步、无账号依赖等运行边界。

### v0.177 安装包与外置资源便携版
- 项目协作约定：Git 提交消息采用 `类型: 中文说明`，功能与修复分别使用 `feat:`、`fix:`，其余改动按实际内容选择类型；规则持久记录在 `AGENTS.md`。
- 分发决策：Windows x64 正式构建产出 NSIS 安装包与目录式 portable ZIP；日常测试同样输出 portable-fast 目录和 ZIP，不再输出单文件 EXE。正式版启用 LTO，测试版使用 release-fast。
- 前端 HTML/CSS/JavaScript、Monaco workers 等文件存放在 EXE 同目录 `web/`。通过 Tauri 自定义 Assets 保留原有应用协议与 IPC；正式构建不嵌入前端文件，仅内置 SHA-256 清单。路径以 EXE 所在目录为准，不依赖启动工作目录。
- 启动时检查全部资源，每次读取复核摘要；拒绝未登记文件和越界路径。缺失、损坏或版本不一致时提示完整解压/重新安装；`--verify-resources` 可独立验证包，不启动窗口或访问用户数据库。开发热重载仍使用 Vite。
- 打包脚本输出版本化目录、ZIP、LICENSE、使用说明、文件摘要清单与压缩包/安装包校验值。NSIS 使用当前用户安装、中英文界面；缺失 WebView2 时下载运行时。测试包与正式包分开命名。
- 本地配置、会话、历史与凭据继续使用原目录/服务标识。便携仅指免安装，不代表数据随目录移动。便携更新要求退出后完整替换程序目录；安装更新可沿用 NSIS。
- 已验证：前端构建、Rust 测试（100 项通过、4 项外部服务测试跳过）、LTO 正式包与 release-fast 便携包；ZIP 完整性及文件摘要检查、NSIS 解包后的资源校验均通过。资源损坏、缺失、越界及版本不符会被拒绝，任意工作目录启动校验通过。安装版/便携版的 Tauri 分发标识分别为 NSIS/未安装类型；没有对用户环境执行实际安装、卸载或升级验收。
- 分发构建显式启用 `custom-protocol`；缺少该开关的非调试构建直接编译报错，避免回退为内嵌资源或开发模式。
- 已知边界：当前仅提供 Windows x64 打包脚本；尚未实现在线版本检查、签名更新、便携替换/回滚，也未配置 Windows 代码签名。资源摘要用于完整性与版本匹配，不等同于更新签名。

### v0.176 项目更名为 DBFolio
- 对外名称统一为 DBFolio：窗口标题、欢迎页、菜单与关于标题、浏览器标题、MongoDB 客户端标识、SQL 导出标头、README 及构建产物 `release/DBFolio.exe`。
- npm/Cargo 包、Rust lib 和 Tauri 产品名/标识同步更新为 `dbfolio` / `com.dbfolio.app`；版本升级为 0.176.0。构建脚本改为复制新的 Rust 可执行文件。
- 为确保更名前的会话、查询历史、设置和密码继续可用，本地目录 `%APPDATA%/data-workbench`、Windows 凭据服务名 `data-workbench` 和 AI 凭据服务名 `data-workbench-ai` 不变；无需迁移。历史验收文档中的旧名称与产物路径保持当时记录。
- 已验证：前端生产构建、Rust 测试（99 项通过、4 项外部服务测试跳过）及 release-fast 桌面构建；产物 `release/DBFolio.exe` 的 Windows 产品名、文件说明和文件版本分别为 DBFolio、DBFolio、0.176.0。
- 已知偏差：兼容存储标识仍含旧名称；不会自动重命名用户机器上已有的旧版可执行文件。

### v0.175 图表默认视觉与 SQLite 删除修复
- 图表统一调整配色、文字层次、提示框、坐标轴和网格线；柱/条/直方图从零轴起绘制，少量分类显示数值，超过 40 个分类才展示缩放条。折线、面积、散点和指标卡同步调整默认样式；图例保持紧凑并显示当前合计。饼/环图为扇区留白，最多 5 类显示外部标签，更多分类通过侧边图例读取；环形中央显示合计。PNG 导出沿用新底色与图例颜色。
- 整数型 `DbValue` 超出 JavaScript 安全范围时以原始十进制字符串经 IPC 传递，写回时解析为完整 i64/u64；网格整数输入也保留大整数文本。SQLite 网格事务逐条要求影响恰好 1 行，目标行未命中或异常多行时回滚并保留界面草稿；成功提示使用实际影响行数，删除按钮说明需再点击提交。
- 已验证：前端构建、分析页九种图表与 PNG/CSV 回归、亮暗图表截图；临时 SQLite 大整数主键删除与过期主键事务回滚测试。
- 已知边界：图表仍只绘制当前分析范围，浮点统计不用于精确财务计算；MySQL/PostgreSQL 的逐条影响行数暂沿用各自现有事务语义，本轮未连接真实服务器验证。

### v0.174 数据库概览行数比例条清晰度
- 估算行数改为数字与比例条分离，独立显示 8px 高的底轨和实色强调填充；零行显示空底轨，无估算值仅显示破折号。暗色主题下表格文字继承主题前景色。
- 比例仍以当前数据库最大估算行数为基准，极小但非零的估算保留 2px 可见填充；数字不再被色块覆盖，保持概览表原有紧凑行高。
- 已知边界：元数据行数为数据库估算值，比例条表示相对规模，不代表精确计数或加载进度。

### v0.173 数据修改预览与危险 SQL 防护
- 表数据提交展示新增/修改/删除统计、逐行字段前后差异及所选 SQL，支持勾选部分行提交；删除展示已加载原值，长值省略并可悬停查看。后端仍按事务执行所选变更。
- 部分提交后已提交项从待办中移除，未选修改保持暂存；废弃只影响剩余草稿，不能撤销已经提交的操作。已提交新增行在统一刷新前暂不可编辑，服务器生成值在其余修改提交/废弃后加载。
- 普通 SQL 与手动事务使用统一方言解析检查，识别外层 UPDATE/DELETE 缺少 WHERE、常见恒真条件、DROP/TRUNCATE；注释、字符串、子查询中的 WHERE 不再绕过检查。MySQL 可执行注释、解析不完整语句及可识别的嵌套写入要求额外核对。
- 查询危险确认显示待执行 SQL；生产会话需输入数据库名，数据提交亦需输入数据库名。通用 SQL 执行确认需输入生产会话名称，离开页面的保存保护对生产写入增加文字确认。只读后端拦截优先于强制执行。
- 已验证：临时 SQLite 执行前拦截/确认后执行、三引擎解析用例，浏览器差异/选择性提交、混合新增删除、废弃基线、预览失败及只读保护。未对真实 MySQL/PostgreSQL 服务执行写入测试。
- 已知边界：这不是完整 SQL 风险证明或影响行数估算；复杂恒真表达式、过程/函数内部副作用不能全部识别。服务端仍决定事务与存储引擎的实际原子性，SQL 解析不支持的方言会要求人工确认；完整逐行差异入口在表数据提交，离开页面保护继续展示 SQL 汇总。


### v0.172 用户数据库优先排序
- 对象树中 MySQL 用户数据库排在前面，information_schema、mysql、performance_schema、sys 统一置后；两组内部保留原有排序。
- 仅调整显示顺序，不修改数据库可见范围；其他引擎排序保持不变。


### v0.171 结构按需编辑与索引快捷操作
- MySQL 结构列表默认以紧凑文本显示名称、类型、长度/集合、默认值、ON UPDATE 和注释；双击或聚焦单元格按 Enter 进入编辑，失焦/Escape 收起控件，修改仍暂存并通过保存/废弃统一处理。布尔列保留复选框。
- 字段右键保留复制、上下插入、上下移动、移除，移除编辑入口；新增创建索引（预选当前列）、加入索引（追加到已有列末尾），沿用 SQL 预览及只读保护。
- 未保存列修改时禁用结构操作。加入索引仅支持无前缀、无表达式、无备注的非主键普通/唯一 B-tree 索引，避免重建时丢失未支持的属性；完整字段行内编辑仍限 MySQL。


### v0.170 MySQL 结构行内编辑

- MySQL 结构行内编辑字段名、类型、独立长度/集合、可空、无符号、默认值、自动增长、ON UPDATE、注释，取消 MySQL 列编辑弹窗。顶部保存/废弃统一处理。
- 默认值区分保持、无默认、NULL、自定义字面值、CURRENT_TIMESTAMP；自动增长与 ON UPDATE 单独设置。长度支持精度/小数位，ENUM/SET 集合使用 SQL 引号列表。
- 基于原始列定义生成单条 ALTER TABLE，类型解析限制额外声明，输出做往返校验，不能安全保留时拒绝执行。
- 已知限制：本轮完整行内编辑针对 MySQL；其他引擎保留现有编辑方式，任意默认表达式暂通过 SQL 设置。服务器负责数据兼容性、索引及自增约束校验。


### v0.169 结构布尔属性勾选

- 结构列表可空字段改成复选框；MySQL 数值列加入无符号复选框。顶部保存/废弃，修改暂存并登记未保存状态，保存先预览后执行单条 ALTER TABLE。
- 主键/自增列不能设为可空，只读和视图禁用修改；存在待保存勾选时禁用其他结构操作。
- MySQL 从原始建表定义解析修改列，保留其余属性，解析失败拒绝执行；PostgreSQL 支持可空切换。SQLite 暂只展示布尔状态，禁用直接切换以避免不完整重建表。


### v0.168 紧凑表属性及下拉选项

- 将紧凑优先写入 AGENTS.md，作为全软件 UI 原则：小号控件、短间距、减少说明、同排等高、不裁切文字，长文本独立排布。
- 表属性重新分组：表名/注释基本区与独立选项区，注释默认一行，可纵向调整高度，不再撑高旁边输入框。
- 引擎读取 MySQL SHOW ENGINES 的 YES/DEFAULT 项；字符集读取服务端支持列表，排序规则按字符集联动并默认选用该字符集默认排序规则；异步结果防串用，保留已有值。


### v0.167 表属性编辑

- 信息页新增属性编辑区：关系数据库表名，MySQL/PostgreSQL 表注释；MySQL 引擎、默认字符集、排序规则、自增起始值、记录行格式。
- 采用结构化 DDL 预览与执行，后端只读和数据库范围限制仍生效；名称与其他属性分开保存，重命名同步更新表标签，登记未保存修改。
- 引擎/字符集/排序规则使用安全标识符校验，实际能力与兼容性由服务器确认；自增值按十进制正整数处理。
- 已知限制：暂未提供转换已有列字符集、平均/最大行数、校验和、MERGE 表等高级选项；行格式默认保持现状。修改引擎/行格式可能重建并锁表，执行前预览提示。


### v0.166 数据库表概览

- 连接后点击关系数据库节点，主区域显示表/视图概览；保留已打开标签，可随时切回。概览支持名称/注释搜索、列排序、刷新、打开表、新建查询。显示名称、估算行数及比例条、大小、引擎、注释、类型。
- MySQL 数据库枚举移除系统库固定排除，仍遵守服务端账号权限和客户端会话数据库白名单；系统库不获得任何权限豁免。
- 已知限制：行数来自元数据估算；暂无批量创建/修改时间元数据，不展示虚构时间；仅支持关系数据库概览。


### v0.165 下拉框文字裁切修复

- 修复紧凑密度 small Select 的固定 24px 高度与全局 18px 行高、8px 上下内边距冲突，造成文字底部裁切。
- Select 独立设置自动高度、最小 28px、20px 行高和上下各 3px 内边距，包含边框所需空间；维持 v0.164 的圆角与焦点样式。验证包含 small 控件与放大缩放场景。


### v0.164 表单控件圆角修复

- 输入、下拉、组合框、多行输入和数字微调控件局部统一 5px 圆角令牌，使外框、Select 原生内框及 Fluent 焦点伪元素保持一致，不影响主题卡片圆角。
- 修复紧凑密度仅覆盖外层圆角而主题内层使用另一半径的错位；Select 普通状态底边使用统一描边，保留焦点强调、错误和禁用反馈。覆盖分析页及其他页面共用控件。


### v0.163 选区 AI SQL 编辑

- SQL 右键菜单增加 AI 格式化 SQL、AI 优化 SQL，仅在有选区时启用。先由本地 sqlparser 按 MySQL/PostgreSQL/SQLite 方言解析选区，失败直接提示且不调用 AI、不执行 SQL。
- 使用默认 AI 服务，流式显示候选；格式化保留语义与注释，优化读取 SQL 中引用的相关表结构与索引。返回 SQL 再次校验，通过后可替换原选区，支持撤销。编辑内容或数据库变化时拒绝覆盖。
- 后端同样强制校验编辑模式的输入与输出，所有流程仅编辑文本。
- 已知限制：解析器不等同服务器版本的完整语法支持；部分厂商扩展可能被拒绝，不校验表字段是否存在，语法通过不保证 AI 改写语义等价或性能改善，需人工审阅。


### v0.162 可配置查询分页

- 首选项 → 数据网格支持每页最大查询行数，默认 200，可输入 1～5000 的整数，持久化为 query_page_size。
- 表数据刷新、新查询（含手动事务）采用当前设置；已有结果翻页、导出分页和分析快照使用该结果的实际页大小，避免设置变化导致跳行。
- 设置修改不自动重查，也不清除表内待保存编辑。筛选候选继续只取当前已加载行。


### v0.161 数据筛选交互优化

- 筛选方案折叠收纳，条件按字段、关系、值对齐；字段框维持原宽度，缩小字号，备注可换行展示。
- 关系使用符号或 SQL 运算符配中文括注。
- 候选值仅取当前已加载页的对应列，去重并标记出现次数，支持搜索完整值；长值缩略展示但保留完整选值。最多展示 200 个候选，搜索覆盖全部已加载值。
- NULL、空字符串分别处理；截断、二进制等不可直接筛选的预览值禁选，普通比较保留候选的原始类型。无额外数据库查询。
- 已知限制：IN 保持逗号分隔输入，包含逗号的候选不可直接选取；候选不代表数据库全部值。


### v0.160 外键操作列布局修复

- 外键操作列原为 60px，两个按钮未加不换行容器，缩放或可用宽度不足时换行。改为 88px 操作列及 inline-flex/nowrap 容器，编辑和删除按钮始终单排。
- 浏览器验证宽窄视口、零/单/多条记录及只读入口；前端构建。


### v0.159 结构列表紧凑化

- 结构、索引、外键三个列表统一使用 12px 常规字重，表头和字段名不加粗；基础行高 26px，上下内边距 2px，标签和行操作按钮同步缩小。长内容仍允许撑高，保留单排操作布局和右键菜单。
- 样式仅限三个元数据列表，不影响数据网格或其他页面。前端构建及现有索引/外键空列表、只读入口回归验证。


### v0.158 数据值类型配色

- 表编辑网格及共享查询结果网格按字段类型给值着色：数值蓝、文本绿、日期时间紫、布尔橙、JSON/二进制金色；元数据不足时按值类型回退。文本字段中的数字仍按文本显示，tinyint 按数值处理。
- NULL 使用灰色斜体，截断/扩展只读值保留琥珀色斜体。每次更新显式还原普通值的 fontStyle，避免复用单元格残留斜体。亮色与暗色/OLED 使用独立语义色，强调色不改变值类型配色。
- 不改变内容、复制、编辑或行状态标记；前端构建及类型映射/主题切换回归检查。


### v0.157 会话列表字号调整

- 会话名称改为 12px/16px，分组标题和数量为 11px，只读标记和会话环境标签为 10px；地址仍为 10px，避免过小。环境标签缩小仅作用于会话列表，其他位置不变。保留现有分组动画与交互。
- 本次为局部样式调整，验证前端构建与快速 EXE 打包。


### v0.156 会话分组展开动效

- 会话分组展开/收起采用 320ms 非线性高度过渡，下方分组随之移动，箭头旋转使用相同时长。列表保持挂载，快速反向点击从当前高度继续。折叠内容设置 inert/aria-hidden，避免隐藏操作获取焦点。
- 完整模式启用，减弱与关闭时即时折叠；取消分组容器收缩，保留溢出滚动。使用实际 SessionList 的模拟会话验证展开/收起中间高度、反向切换及关闭动效，前端构建通过。


### v0.155 增强可感知动效

- 完整模式下工作区切换增加 16px / 320ms 的非线性短距离滑入，始终不透明；采用 relative top 而不是 transform，不创建新的 fixed 包含块。补全候选框显示时直接落位。
- 标签指示条延长为 320ms，菜单进入为 260ms，弹窗/浮层使用 300ms 的淡入与轻量裁切展开。减弱及关闭沿用原策略，不添加等待。
- 浏览器逐帧验证切换中间位移、结束位置、持续不透明以及关闭模式；前端和 EXE 构建。


### v0.154 标签切换动效修复

- 修复 v0.153 将工作区从 opacity:0 淡入造成标签切换闪底的问题。工作区保持完全不透明，不对编辑器祖先进行位移。其他内容进入从 0.96 开始，避免整块内容消失。
- 顶部标签改为共享选中指示条，在完整动效下以 240ms 非线性过渡移动和调整宽度；连续点击由当前位置继续，减弱与关闭时即时定位。通过 ResizeObserver 和选中状态观察支持换行、关闭及尺寸变化；采用布局坐标兼容界面缩放。
- 浏览器检查指示条中间位置、连续切换、减弱/关闭定位及工作区保持不透明；构建验证。


### v0.153 统一界面动效

- 首选项外观增加「界面动效」：跟随系统（默认）、完整、减弱、关闭，保存到 ui_motion；监听系统减少动态效果设置的实时变化。
- 统一快速收尾的非线性曲线，按钮按压、菜单揭示、弹窗和面板淡入、标签指示条出现、任务浮层淡入；AI 提问面板改为 28px 短距离轻回弹，替换 60vh 大幅滑动。
- 编辑器祖先不使用位移或缩放，避免补全弹层错位；不插入退出等待，不对网格行和拖动尺寸添加动画。减弱模式仅保留短淡入和颜色变化，关闭模式禁用 CSS 动画/过渡，图表同步禁用动画。
- 本轮采用 CSS 与现有 Fluent 主题时长，无新依赖。侧栏宽度插值、标签拖动让位与跨标签共享指示条暂未实现，保留当前即时布局行为。验证动效选择、持久化、系统变化、减弱/关闭和连续切换；前端与 EXE 构建。


### v0.152 OLED 纯黑主题

- 首选项外观新增「纯黑（OLED）」配色模式，独立持久化为 oled；按暗色处理原生窗口和语法主题。覆盖原有风格底色为不透明 #000000，保留用户选择的风格以便切回。
- 主界面、侧栏、面板、数据网格、Monaco 编辑器和分析图表使用纯黑底；中性色边框及悬停提供必要层次。品牌按钮、选择高亮与图表系列保留强调色；修改强调色不改变纯黑底色。
- 验证前端构建及模拟界面的模式切换、强调色独立性与主题持久化；无业务数据迁移。


### v0.151 会话列表密度调整

- 会话行上下内边距从 4px 调整为 2px，地址行行高从 13px 调整为 12px；缩小分组标题上下间距和行内图标间距。保留双行信息、原有字号、完整名称提示、环境标签、只读标记及操作按钮。
- 本次仅调整会话列表样式，不改变连接和右键菜单行为。


### v0.150 首选项与本机数据管理

- 应用菜单、页面标题、快捷键说明和跳转入口统一称为「首选项」。新增「本机数据」分类，显示本地 SQLite 实际路径、主文件/辅助文件大小、已保存会话与查询历史数量，支持刷新。
- 查询历史默认仍按会话保留最近 500 条，允许调整上限或关闭自动清理；保存策略不立即删除，各会话下次记录查询时按新上限执行。
- 手动清理支持 7/30/90/180/365 天前或全部历史，执行前明确确认；仅删除 query_history，收藏、草稿、会话与业务库不受影响。增加本地 VACUUM 空间回收，单独操作并刷新统计。
- 使用临时 SQLite 验证保留上限、关闭自动清理、日期清理、全部清理及独立设置保留；浏览器模拟 IPC 验证设置保存和清理确认。数据库大小不含日志，未提供日志删除或凭据清除；不对用户实际本地库执行清理验收。


### v0.149 只读交互检查与补全

- 开源首页：README 从脚手架模板替换为中文项目说明，覆盖功能、各数据库支持边界、Windows 运行与源码构建步骤、本地存储、AI 数据处理与只读边界、反馈贡献及作者信息。未添加未发布的下载地址、未经脱敏的截图或未经验证的跨平台承诺；本次为文档调整，不变更应用版本。

- 开源准备：采用标准 MIT 协议，版权归属为 `Copyright (c) 2026 SerLiunx`；根目录添加 LICENSE，README 添加协议入口，npm 与 Rust 包元数据同步声明 MIT。允许使用、修改、分发及商用，保留标准版权及许可声明要求，不添加额外限制。第三方依赖仍遵循各自许可证；依赖许可审查、完整开源 README 与 GitHub 发布尚未完成。本次仅修改文档和包元数据，不变更应用版本。

- 修复对象浏览器未读取会话只读状态的问题：只读时右键隐藏新建表/数据库、删除表/数据库，固定建库按钮禁用；查看、刷新、复制及导出保留。数据生成允许本地预览/导出，原有写入按钮继续受只读限制。
- Redis：键列表隐藏重命名、TTL 和删除右键菜单，新建/批删禁用；详情面板禁止重命名、过期时间、字符串保存和成员增删改，编辑器只读。复制键名、刷新、成员查询与翻页保留。新建及操作弹窗提交增加只读校验；控制台只读时写命令按钮禁用，Ctrl+Enter 也不提交写命令。
- 最终确认层：建库、建表、字段、索引、外键、导入、通用 SQL 确认、结构同步计划、MongoDB 文档及工具确认按钮再次检查当前会话只读状态；已打开弹窗在状态变化后不能继续写入。完整值查看入口在只读时去掉“编辑”措辞。
- 后端检查：原有 DDL、行编辑、SQL、Redis 写操作、MongoDB 文档/索引/导入、数据生成和同步写入已有只读拦截；不将界面隐藏作为权限边界。补充只读 DDL 删除（包括 force=true）及建库/删库在连接操作前被拒绝的回归。
- 验证：浏览器模拟 IPC 验证只读/可写 SQL 菜单、Redis 列表及详情、命令快捷键、弹窗状态变化，确认读取与复制可用；Rust 全量测试、前端及快速 EXE 构建。未针对真实 MySQL、Redis、MongoDB 服务执行写入验收。

### v0.148 复制会话

- 会话右键增加「复制会话」，打开预填表单，名称追加「-副本」，允许继续修改后保存；取消不创建任何记录。适用于所有会话引擎。
- 保留连接参数、认证库、SSL/TLS、默认数据库、数据库白名单、只读状态、分组、颜色及环境标记。保存创建独立 ID，不复制查询历史、页签、运行任务或连接状态，不修改或断开来源会话。
- 已保存密码默认仅在后端读取并存入新会话的独立凭据项，不向前端返回密码；支持输入新密码覆盖或选择「不复制密码」。测试连接沿用来源凭据的现有安全处理。来源会话已删除时拒绝复制。
- 验证：临时本地存储检查新 ID、来源记录不变、只读及白名单继承；浏览器模拟 IPC 检查右键入口、表单预填、取消、保存、环境继承、源连接保持；前端构建及快速 EXE 打包。未针对真实数据库或 Windows 凭据管理器执行带密码的复制连接验收。

### v0.147 会话数据库范围与结构操作按钮

- 索引/外键：新增操作不再因只读或不支持编辑而从工具栏消失；始终展示，禁用时提供只读/视图/SQLite 限制原因。结构面板明确占满可用宽度并采用 border-box，零条、单条及多条列表的操作位置一致。
- MySQL 会话增加「仅允许指定数据库」：默认关闭，旧会话保持原行为。启用后填写完整名称（每行一个，精确匹配，无通配符，最多 500 个），可从当前连接可见数据库中勾选；白名单不能为空，默认数据库必须在名单内或留空。名单存入本地 SQLite 新列，向后兼容旧数据。
- 范围执行：MySQL 适配器统一过滤数据库发现、校验元数据与数据连接目标；普通 SQL、字段完整值、参数化写入、结构批处理、手动事务、同步及 SQL 导出均受范围约束。SQL 对明确的库限定、嵌套查询、逗号联表、别名与外键引用进行检查；受限模式拒绝 USE/SHOW、多语句、动态 SQL、数据库/服务器管理、可执行注释及无法明确校验的扩展语法，数据库切换使用选择器。
- 配置变化：保存断开当前连接，清理对象树缓存并丢弃已过期的异步数据库/表列表响应。已打开的被排除数据库页签显示范围提示，停止展示其缓存数据；恢复旧页签也适用。运行中的会话任务按既有编辑保护阻止修改连接。
- 验证：临时 SQLite 保存/更新/旧字段兼容、默认库检查、白名单 SQL 绕过回归及所有 MySQL 适配器入口在连接前拒绝越界；浏览器模拟 IPC 验证索引/外键 0/1/多条与只读按钮、名单勾选/保存/回显/断连/缓存失效；SQL 导出回归、前端及快速 EXE 构建。
- 边界：本期数据库范围仅支持 MySQL。它是本客户端防误操作措施，不等于数据库账号权限；允许库中的视图、触发器、存储函数、外键级联等服务器间接依赖不作递归隔离，也不能撤销已获取的数据或其他客户端权限。保守的 SQL 检查可能拒绝合法的复杂语法（如含反斜杠转义的文本，建议使用绑定参数）；不宣称完整 SQL 沙箱。未使用真实生产/测试 MySQL 进行访问或写入验收。

### v0.146 MySQL SQL 导出与桌面操作修复

- 第一阶段：文件菜单增加「导出 SQL 文件」，MySQL 数据库/表右键提供同一入口。使用独立全局标签页，允许配置多个导出任务并保存草稿；默认带入当前连接、数据库和表。
- 范围与选项：选定表或整个数据库的全部普通数据表，结构/数据/结构和数据三种模式；单 SQL 文件或按表分文件（编号文件名及 manifest.json 映射）。支持逐表筛选、批次行数/字节数、一致性快照；CREATE DATABASE/USE 和 DROP TABLE 默认关闭，后者须明确确认，仅数据模式禁用 DROP。
- SQL：SHOW CREATE TABLE 保留 MySQL 原生结构；默认不添加源库限定，显式跨库引用保持原样。读取完整字段值，数值不经过 JS/f64，文本/二进制采用十六进制字面量，保留 NULL、大整数、Decimal、BIT、空间值；INSERT 显式列名并排除生成列。统一 UTC，保存并恢复脚本执行会话的字符集、SQL_MODE、时区、外键检查。
- 执行：后端流式读取与分批写盘，任务中心报告表/行/字节进度并允许取消；独立连接持有 InnoDB 一致性只读快照，其他存储引擎必须关闭快照。临时文件/目录完成后发布，取消或失败不会覆盖原有输出；导出末尾检查结构漂移。
- 浏览器行为：Windows WebView2 禁用浏览器默认菜单、浏览器快捷键、开发者工具、原生缩放/手势导航、自动填充及密码保存。前端启动时拦截 F5/刷新、打印、网页另存为、浏览器窗口/标签操作、历史导航、文件拖入导航和链接默认导航；事件继续传递，保留程序快捷键与 Monaco 自定义菜单。修复旧规则对全部 input 放行，导致复选框右键出现浏览器菜单的问题。
- 验证：Rust 全量测试及取消后原文件保留/临时文件清理；前端构建；浏览器模拟 IPC 验证导出入口、范围、模式、路径、DROP 确认、任务归属，以及 F5/刷新拦截、复选框菜单抑制、Monaco 右键/查找和布局拖动回归。
- 已知边界：首期只包含普通数据表，不含视图、触发器、过程、函数、事件；SQL 文件导入和独立数据导出扩展留待后续阶段。单行 SQL 上限 64 MiB，服务器 packet 限制仍可能提前报错；不自动导出未选中的外键依赖表。快照不能阻止其他客户端 DDL，末尾校验不能替代运维期间的结构冻结。尚未连接真实 MySQL 做导出/恢复往返验证，原生桌面快捷键及窗口行为仍需 Windows 实机验收。

### v0.145 表结构同步完善

- 范围：继续采用同引擎 A→B。对象列表包含源/目标表的并集，支持选中目标独有表；视图拒绝按表执行，多 schema 同名对象明确报歧义，不隐式选取。
- 读取与比较：先读取对象清单确认存在，再读取完整元数据；权限/连接/读取错误直接失败，不再吞为缺表。补充主键、表注释、MySQL 引擎和字符集/排序规则差异；索引比较包含方法、顺序、前缀长度、唯一性和注释，外键比较包含引用范围及 UPDATE/DELETE 动作；展示目标多余索引/外键，不再显示“结构完全一致”。MySQL 复合主键顺序按索引顺序读取。
- MySQL 生成：从 SHOW CREATE TABLE 保留完整字段定义，覆盖生成表达式、默认表达式、自动更新及字段注释；新表保留主键、表引擎、字符集、排序规则、注释，索引在建表内生成。已有表支持索引重建、主键调整、可选表属性和删除多余索引/外键；字段、主键、索引与属性合并为单条 ALTER，避免自增列在中间步骤失去索引。新增主键/表属性/删除选项默认关闭。
- 逐项选择：MySQL 差异列表可排除单个字段、索引、外键以及主键/表属性；仍受结构类别开关控制。计划中按表选择，存在外键操作时整组选择；未同步字段依赖、未选中的入向外键及缺少引用表会阻止生成，避免越过勾选范围。
- 外键依赖：先移除受影响的已选表外键，再创建/修改表，最后统一恢复/新增外键；保留动作和明确的跨库引用，源库内引用映射目标库。PostgreSQL 新外键延后创建并带 schema 和动作，SQLite 建表是否带外键遵循选项。
- 固定计划：后端保存 SQL、请求及结构快照，前端只提交计划 ID 和所选操作编号，不接受客户端 SQL。计划最多缓存 64 个，30 分钟过期，一次消费；生成前后及执行前校验结构快照（包含目标入向依赖，忽略 MySQL 自增计数和估算行数）。同目标会话执行串行，逐条只读检查，失败停止并显示已执行数量；不自动回滚 DDL。预览后任一结构变化须重新生成确认。
- 界面：独立确认计划弹窗，SQL 可折叠查看，依赖组不能拆开执行；未支持差异单列提示，空计划不可执行，失败后必须重新预览，原有数据同步确认流程不变。
- 验证：Rust 全量测试、临时 SQLite 实际建表/对比/只读阻止、MySQL 模拟适配器的固定计划/结构漂移/重复消费/索引主键/外键顺序/失败停止；浏览器检查选表和旧数据同步流程、计划组选取、确认及重试；前端与快速 EXE 构建。
- 已知边界：MySQL CHECK、分区、不可见等未覆盖属性明确拒绝自动同步，不能承诺完整原生 DDL 克隆。PostgreSQL/SQLite 现有主键或索引/外键重建仍需手动处理，SQLite 不自动重建表；未实现 schema 映射和跨引擎转换。未连接真实 MySQL/PostgreSQL 服务进行执行验收。快照检查后无法锁住其他客户端 DDL，数据冲突/服务器版本限制仍可能使执行失败；已执行 DDL 和临时移除的外键不会自动恢复，需检查目标并重新生成计划。结构同步不提供数据备份或自动反向脚本。


### v0.144 关于页精简

- 已完成：关于页仅展示作者 SerLiunx、邮箱 root@serliunx.com、主页 https://www.serliunx.com；主页通过系统浏览器打开。移除版本、更新说明、快捷键、诊断复制和存储路径，弹窗收紧为 420px。
- 验证：前端构建与快速可执行文件打包；无已知实现偏差。


### v0.143 全局菜单栏

- 已完成：标题栏内加入文件、视图、工具、帮助菜单；设置归入文件，数据同步归入工具，工作区布局/侧栏/专注模式归入视图；会话栏移除同步与设置图标，仅保留连接相关操作和折叠。
- 菜单处于窗口拖动区域之外，使用 Fluent 菜单浮层与键盘操作；收起侧栏或打开设置时仍可访问。既有快捷键、状态栏入口和同步多页签行为保持兼容。
- 验证：菜单交互与浅色/深色、小窗口布局检查，前端构建和快速可执行文件打包。Windows 标题栏原生拖动手感待桌面验收。


### v0.142 简约镂空图标

- 已完成：应用标识改为透明背景、单色蓝色描边的数据库轮廓，统一圆角线条；标题栏、关于、WebView 与可执行文件共用 SVG 源图及生成资产。
- 验证：检查浅色/深色背景与小尺寸图标，前端构建及快速可执行文件打包。
- 已知边界：Windows 可能缓存旧快捷方式图标；不改变现有快捷方式。


### v0.141 关联浏览、查询结果对比与手动事务

- **关联记录**：表数据单元格右键「查看关联记录」，在同页右侧只读浏览匹配结果；自动识别外键（含复合键、MySQL 目标库和 PostgreSQL 目标 schema）。NULL、截断值不发起错误匹配。使用实际元数据构建带精确条件的 SELECT，每页 100 行。
- **业务关联**：可手动选择同库目标表、关联键和可选名称字段，不修改数据库外键。配置通过 SQLite settings 的 `business_relations_v1` 保存，按会话、库、schema、表区分。支持移除；分析页可复用单字段名称关联。首版手动配置为单字段关联，查询别名仍需显式映射；尚未自动接入网格名称替换、AI 上下文和数据生成。
- **结果对比**：查询结果栏和表数据底栏提供固定/替换基准、对比结果。快照限当前已加载结果，保留来源、行范围和采集时间，支持跨页签、跨会话；按单键或复合键对比新增、删除、修改、相同行。字段顺序可不同，字段名必须一一对应。大整数与 Decimal 采用字符串规范化，不转浮点；NULL 与空串区别处理，拒绝重复/NULL 键、重名列、截断值及不可比较类型。差异分页展示前后值。
- **对比范围**：单个快照最多 5,000 行 / 8 MiB，仅驻留本次进程内存；不自动读取完整查询、不写入目标库。清除基准或退出后释放。不会把当前页差异解释为全表差异。
- **手动事务**：MySQL / PostgreSQL / SQLite 的 SQL 查询页提供开启、提交和回滚按钮。每个事务使用独立连接，后端以事务 ID + 会话校验归属；执行、分页与排序始终走同一事务。不同页签可分别持有事务，同会话的事务操作串行化；切换数据库须先结束事务。
- **事务边界**：首版允许单条 SELECT / 只读 WITH / INSERT / UPDATE / DELETE；拒绝 DDL、直接事务控制、管理命令、RETURNING，MySQL 写入仅允许无触发器的单表 InnoDB 基表。语句边界解析采取保守规则（不接受 dollar-quoted 和反斜杠转义字符串）。普通连接池查询提示使用事务按钮，禁止直接 BEGIN/COMMIT 等及 SET 事务模式。存储函数外部副作用、序列/自增号消耗不保证回滚。
- **失败及退出**：执行错误、执行中取消或超时会尝试回滚整个事务；本地校验失败不结束事务。提交/回滚结果不确定时明确提示核对数据库，绝不自动重试。断开连接清理并回滚该会话事务；关闭页签/应用通过统一未保存保护让用户选择提交或回滚，异步回滚完成后才继续。事务页不被数量上限自动关闭；事务不跨应用重启恢复。
- **结果与历史**：事务内结果标注为未提交快照，可用于对比；暂不允许在其他连接重跑导出/分析。事务结束后旧结果不能继续分页/排序，需重新执行。历史中的事务语句注明「不代表已提交」；执行纳入任务中心。事务失效后必须显式结束事务模式，不会静默改用自动提交。
- **验证与偏差**：前端构建通过，Rust 测试 76 项通过、4 项服务集成测试跳过。模型检查与浏览器模拟覆盖对比精度、关联右键、跨 schema 目标、业务配置保存、事务执行路由、关闭回滚及失效拦截；Rust 使用隔离的临时 SQLite 实测提交、回滚、读隔离、错误回滚、断开清理。MySQL / PostgreSQL 事务实现完成但本轮未连接真实服务验收，未访问用户业务数据库。



### v0.140 表页签计数对齐

- 结构、索引、外键页签的文字和计数徽标使用行内弹性布局居中对齐，统一 4px 间距，数字采用等宽数字样式。
- 无功能逻辑变化。


### v0.139 页签排序与索引交互

- 索引操作按钮单排显示；行右键支持复制名称、列名及编辑、删除，保留只读和主键限制。
- 工作区页签可拖动排序，会话标识固定；顺序随工作区保存。置顶时移到前方，之后允许手动移动。
- 设置新增「页签超出宽度时换行」，默认关闭，持久化键 `ui_wrap_tabs`。
- 关闭窗口原生文件拖放拦截，允许 WebView 内 HTML 页签拖放。
- 历史标注「后端查询」，结果栏标注「请求总耗时」，悬浮说明统计范围；二者均不是数据库服务端独立计时。
- 验证：前端构建、release-fast 打包、页签排序与设置恢复检查、页签滚动回归、浏览器索引同排及右键权限检查通过。
- 已知偏差：本次未连接实际数据库验证性能，未改变查询计时逻辑；桌面原生拖动尚未人工复测。


### v0.138 精简恢复提示

- 移除状态栏“已恢复 N 个页签”按钮及其状态订阅；启动页签与草稿恢复逻辑不变。前端构建通过。


### v0.137 表工具栏按钮统一

- 表页右上角的新建查询、新建分析、数据生成、刷新统一使用 Fluent 小尺寸按钮，消除默认尺寸混用导致的字号和字重差异。
- 核对组件库样式确认 small 使用常规字重、默认 medium 使用半粗字重；前端构建通过。


### v0.136 只读加固与生产默认保护

- 已实现后端执行/分页/同步防护、SQL 连接只读设置、生产默认只读及关闭确认、一次性升级迁移。
- 验证：Rust 73 项通过、4 项需外部服务测试忽略；隔离 SQLite 验证驱动拒绝建表、后端同步拒绝只读目标、分页拒绝多语句；生产迁移只运行一次。浏览器验证默认勾选、取消和确认关闭、重选生产恢复只读。
- 已知偏差：MySQL / PostgreSQL 连接级设置已编译检查，未连接真实服务器验证；不追溯回滚切换前已提交操作。


### v0.135 分析数据范围文案

- 查询结果转分析不再无条件标记非全量；首页不足一页时显示查询结果行数，否则客观标记当前页范围。图表去掉重复范围副标题及非全库断言，仅实际受限结果、分类/系列裁切保留提示；百分比分母说明收纳于图例信息提示。
- 验证：前端构建、结果范围及大数据量提醒检查通过；分析图表、导出、分页与截断提示回归通过。
- 5,000 行以上数据提示分析绘图可能耗时较长。采用本次需求的文案修正方案；独立分析现有读取上限与真实截断提示保留。


### v0.134 会话环境标签修复

- 会话名称、环境标签和只读标识独立布局；省略号仅作用于名称文本，环境标签不参与截断，悬浮名称显示全文。
- 修复长会话名下环境标签被父级 text-overflow 裁切成空框的问题。
- 验证：前端构建通过；220/260/340px 侧栏中生产、测试、开发标签及只读标识显示检查通过，并核对截图。


### v0.133 补全菜单裁切修复

- 智能生成提示词框、面板及侧栏允许补全层溢出；编辑内容和结果仍由各自滚动区承载。保留低对比边框与圆角，聚焦时提高侧栏层级，防止被相邻内容盖住。
- 保持 Monaco 原有局部定位，避免应用缩放时固定定位产生偏移。
- 验证：前端构建通过；30 项候选超框命中、菜单滚动、键盘选中和 80% 缩放定位回归通过。


### v0.132 轻边界与 SQL 风险提示

- 已实现编辑面板轻边界、统一行号底色、仅有 SQL 时显示提醒、模型与本地双重分级提示。
- 验证：前端构建、风险分级测试、3 项后端候选协议测试、流式追加与分栏回归通过；空白无提醒、黄色修改提醒与模型红色提醒均已核验。测试使用模拟 AI，不访问真实服务。
- 已知偏差：本地检查不替代完整 SQL 语义分析或执行计划；模型缺失风险字段时继续使用本地结果。


### v0.131 编辑区视觉精简

- 已完成共享编辑区边框精简与拖动手柄弱化；保留可拖动命中范围与键盘焦点。
- 不改变 SQL 生成、追加和执行逻辑。
- 验证：前端构建通过；拖动、键盘调节、尺寸记忆、双栏对齐及缩放回归通过，并检查界面截图。


### v0.130 SQL 流式输出与分栏调节

- 已实现双入口分栏调节、顶部停止、纯 SQL 流式解码、无确认自动追加和常驻 AI 提醒。
- 已验证换行、引号、反斜杠及 Unicode 断包；失败/取消不追加，修改 SQL 仅生成不执行；鼠标/键盘分隔条与比例边界检查通过。
- 内部仍使用结构化响应以支持必要澄清，不向用户展示包装字段；输出未完成时只预览，不写入编辑器。


### v0.129 查询编辑区布局与拖动

- 打开表查询页不再发送成功 Toast；查询/分析 SQL 区底部提供拖动分隔条，支持缩放补偿、键盘微调、双击恢复和本地高度记忆，查询页限制高度以保留结果区。
- 查询工具栏合并文件操作菜单，草稿名称/保存状态移入 SQL 栏头；SQL 与智能生成栏头对齐，生成按钮靠右，提示词与滚动预览分区，确认追加固定在预览标题右侧。
- 提示词关闭 SQL 编辑器式边栏、当前行底色及中文标点警示，保留表/字段补全。打开智能生成不再强制改变已设置高度；窄窗口堆叠时保留必要最小高度。
- 验证：前端构建与智能生成/分析回归；实际查询组件验证拖动、键盘、高度恢复、缩放和栏头对齐。未执行真实数据库写入。


### v0.128 内嵌智能生成

- 已实现查询/分析双入口、自动结构上下文、默认服务固定流式、提示词补全、下方预览与确认追加、滑入澄清面板。
- 表范围采用本地匹配而非全库语义检索；超过 20 张表或大库无匹配时提示引用相关表。暂不生成 MongoDB 聚合管道。
- 验证：前端构建、内嵌生成流程/补全/分析集成回归通过；Rust 查询候选与澄清校验 2 项测试通过。使用隔离 IPC 模拟，不调用真实 AI、不执行真实数据库写入。


### v0.127 全局说明文案精简

- 已检查各功能页面与二级弹窗：数据生成/分析、SQL 查询、Redis/MongoDB、会话设置、主题布局、同步、导出和历史工具；静态帮助统一使用 InfoHint，支持悬浮与键盘聚焦。
- 删除重复操作引导、缩短空态和重复状态；执行错误、实时进度、截断/过期结果、写入/删除确认、计费与取消后数据保留提示直接显示。
- 保留实际数据、字段备注、模型回答和诊断内容；本轮只调整展示，不更改数据库和 AI 行为。
- 验证：前端构建、查询助手/同步/分析回归通过；信息提示通过明暗主题、悬浮、键盘聚焦和 Escape 关闭检查。未连接真实数据库执行写入。


### v0.126 AI 查询窗口精简

- 服务选择与设置按钮合并为一行，窄窗口按字段换行。
- 删除重复操作引导；发送范围、流式兼容性、候选校验说明改为可键盘聚焦的信息图标提示。错误、进度、问题与未执行标记保持可见。
- 澄清窗口去除重复引导；本轮仅调整查询助手展示，不改变请求、确认和执行逻辑。


### v0.125 全局同步页签与源数据筛选

- 已完成全局多页签、配置恢复、独立任务归属/取消/返回/关闭保护，以及按源表字段筛选。
- 验证：前端构建；浏览器验证两页配置隔离、运行时切页、确认框随页隐藏、恢复草稿及筛选请求范围；Rust SQLite 隔离集成测试覆盖 1,101 条匹配源行跨分页 OR 条件、插入/更新与保留未匹配目标行、非法字段及筛选+删除拒绝。
- 未对用户数据库执行同步；重启不续跑任务，目标端目前仍需全表主键扫描。



### v0.124 同步目标库限定修复

- 已修复源 MySQL schema 覆盖目标数据库，结构预览与执行、数据写入与回滚均使用所选目标库。
- 回归验证使用 source_a 元数据和 target_b 端点，检查建表、索引、外键、INSERT/UPDATE/DELETE 及逆向语句，兼顾特殊标识符转义与 PostgreSQL/SQLite schema。
- 测试只生成 MySQL SQL，不连接或写入用户数据库；前端构建与全量 Rust 测试。旧脚本需重新预览。



### v0.123 MySQL BIT 默认值同步修复

- 已完成 BIT 类型默认值识别，覆盖同步建表和修改列；修正结构同步失败提醒。
- 验证：Rust 默认值回归（单比特、多比特、大小写、二进制形式、数值默认值、同形文本、非法位内容及时间默认值）、全量 Rust 测试和前端构建。
- 未在用户数据库执行同步或更改业务表；需要重新生成预览，旧预览脚本不会自动修改。



### v0.122 恢复同步选表流程

- 已完成跳步修复、搜索与显式勾选、选定范围展示、重选差异失效及连接状态过滤。
- 验证：前端构建及无界面浏览器完整选表流程，断言结构/数据对比、结构预览和数据确认预览只发送所选表；空选择禁止继续，重选清除旧结果。
- 测试使用隔离模拟接口，没有向真实数据库执行同步写入。



### v0.121 分析页紧凑布局与补全定位

- 已完成定位修复与分析工作区/分析库/名称关联的紧凑样式。
- 验证：前端构建，无界面浏览器 80% / 100% / 125% / 150% 缩放及滚动时补全坐标、表与字段补全、切库和保存；分析页图表、导出、参数及窄窗口回归。未操控用户桌面。



### v0.120 分析 SQL 编辑器补全

- 已完成分析 SQL 文本框替换、共享补全与主题、元数据上下文更新及卸载清理。
- 验证：前端构建、无界面浏览器的表名/别名字段/切库补全、编辑保存、不自动执行和窄窗口，以及分析页回归。
- 边界：沿用普通查询区现有补全能力，不新增复杂 CTE 推导；未调用真实数据库，不操控用户桌面。



### v0.119 AI 交互式澄清

- 已实现结构化问题解析、单选/多选/文本弹窗、延后与重开、失败回答保留、多轮上下文及必填校验。
- 验证：前端构建、Rust 问题格式/边界测试，以及无界面浏览器的旧格式、多选、具体值、暂存重开、失败重试、连续问答与不自动执行回归。
- 已知边界：选项由模型提供；不能结构化的旧问题使用文本回答。本轮不调用真实付费模型，不操控用户桌面，原生视觉体验由用户验收。


### v0.118 AI 查询助手 Q1＋Q2

- 已完成表结构选择与预览、引擎/版本上下文、流式生成、继续追问、解释/修复、假设确认、只读候选校验、差异确认/插入/新查询/分析，以及失败响应保留和取消。
- 已修复 AI 生成忙状态覆盖 SQL 草稿保护的问题，两者独立登记；实际失败 SQL 与错误配对，应用前检测编辑器变化，差异编辑器模型按顺序释放。
- 验证：类型检查、前端构建、Rust 测试及无界面 Edge 模拟验收；覆盖上下文白名单、流式、只读拦截、覆盖保护、假设确认、差异应用不执行、错误响应与取消、草稿保护保留。未控制桌面、未调用真实付费 AI 服务；真实模型生成质量由用户自行验收。
- 已知边界：表/字段血缘与关联仍需用户检查，候选不作数据库语义验证；本轮上下文/候选不持久保存，关闭页签后清空；MongoDB 与共享业务关系库留待后续。


### v0.117 分析名称关联与图例

- 已完成无需外键的 SQL 名称关联、真实字段备注选项、饼/环图百分比，以及搜索/滚动/高亮图例；窄窗口响应布局，PNG 导出包含完整图例。
- 关联配置支持保存与重开；原 ID 保留，空值/未匹配/同名不同 ID/键冲突/超限均显式处理。旧方案兼容，备注权限错误可降级。
- 验证：类型检查、前端构建、分析模型回归及独立无界面 Edge 验证通过，覆盖备注、50 分类图例、占比、搜索不改变统计、保存重开、冲突/超限保留原图、PNG、深色窄窗口及既有九种图表功能。未控制用户桌面或访问真实用户数据库。
- 范围：名称关联配置限 SQL 同库，读取非事务快照；任意查询的字段来源不能可靠自动推断，需显式选择备注表。真实数据库验收由用户进行。


### v0.116 独立数据分析入口

- 已将数据分析提升为状态栏和欢迎页的独立入口；表/视图、MongoDB 集合支持直接新建独立分析，自动带入对象上下文，无需先查询出结果。
- 结果辅助入口统一为「用此结果绘图」，明确一次性快照、查询独立编辑且不与来源联动；修正跨会话默认数据库，Redis 不会默认带入分析器。
- 验证：前端构建、分析回归和独立无界面 Edge 检查；新建/重开方案不自动查询，原有参数、保存、绘图和导出仍可用。未操作用户桌面；真实数据库及原生界面由用户自行验收。


### v0.115 数据列表自动铺满

- 数据表浏览及 SQL 查询结果采用共享列宽策略：数据列初始弹性等分可用空间，最小宽度 110px；少列时铺满，列多或窗口较窄时使用横向滚动，复选框列保持固定宽度。
- 使用初始列宽/初始弹性配置，避免排序、刷新数据和重新传入列定义时覆盖手动宽度。拖动过的列保持用户宽度，其余弹性列继续分配空间；窗口、侧栏及页签显隐变化由网格自动计算。用户将所有列都改为手动宽度后，不强行覆盖其选择。
- 验证：前端构建通过；独立无界面 Edge 使用真实 EditableDataGrid / ResultGrid 检查少列填满、单列填满、多列滚动、手动拖动后刷新/调整窗口保持、隐藏后恢复。仅调整前端布局，未访问数据库或控制用户桌面。


### v0.114 数据分析 A1＋A2

- 已实现 SQL 结果与 MongoDB 聚合结果绘图入口、独立分析页签、九种图表、聚合/排序/Top N/系列、数据分页、字段概况、参数化方案保存/副本/删除及重启恢复、PNG/CSV/JSON 导出。
- 已实现明确范围标识、受限读取、旧结果提示、任务中心/取消接入、失败提示、保存失败不覆盖内存，以及大整数/空值/同名字段/嵌套路径的边界处理。
- 验证：前端构建、分析模型与持久化回归、工作区/查询参数/任务状态回归通过；64 项 Rust 测试通过，4 项需要显式服务器的测试跳过。新增临时 SQLite 集成验证 5000/5002 行边界、空结果、聚合及超大整数原文保留。
- 独立无界面 Edge 验证九种图表切换、PNG/CSV 导出、分页、字段概况、参数替换、失败保留现场、范围提示、方案重开不自动执行、MongoDB 模拟结果、深色和窄窗口；未操作用户桌面或访问用户数据库。原生 Tauri 与真实 MySQL/PG/MongoDB 服务器验收由用户进行。
- 已知边界见 19.2；新增依赖延迟加载，现有主包体积告警仍存在。人工验收步骤见 `docs/analysis-acceptance.md`。

### v0.113 Redis 键列表密度

- 中间键列表使用独立密度样式：紧凑模式行高 28px、舒适模式 32px，表头同步收紧；减少复选框外边距并保留 24px 点击区域。
- 修复全局表格单元格留白优先级高于局部设置、复选框默认边距撑高行高的问题。范围仅 Redis 中间键表；保留键名单行省略、横向滚动、类型徽标、选中/斑马纹和现有功能。
- 验证：前端构建通过；无界面 Edge 使用实际 Fluent Table / Checkbox 及全局样式测量两档行高为 28px / 32px，勾选正常。纯样式调整，未访问数据库或控制用户桌面，原生界面由用户自行验收。

### v0.112 本地文本模板扩展

- 已完成统一文本模板的 UUID / 批次号 / 补零序号 / UTC 日期时间 / 随机整数及字符串变量，所有数据库文本规则共用；同一行 UUID 共享、任务时间固定、最终预览冻结及边界校验。
- 新增随机 UUID 规则与清晰的可复现 UUID 标签；新 Redis 建议键使用随机 UUID。模板编辑器支持光标位置插入、选区替换、常用模板及悬浮说明；仍可手写参数。
- 验证：61 项 Rust 测试通过，4 项显式服务器测试跳过；覆盖 205 行跨批次标识、相同种子再次生成、时间固定、随机规则可复现、参数不递归、旧语法/JSON/hash tag 兼容、非法参数及 SQLite 隔离数据库中的冻结预览与重复生成写入。前端生成回归与构建通过。未访问用户数据库或真实 AI 服务，未控制用户桌面。
- 范围：本轮丰富第一种“本地模板＋AI 业务内容”方式；自定义命名动态变量、AI 返回 JSON 指定路径替换仍未实现。旧模板中的字面量 `{uuid}` 等新保留语法现在会展开，其他未知花括号保留。

### v0.111 页签任务动画与悬浮修复

- 数据生成页签根据任务中心的来源页签 ID 显示小型加载动画；生成、规则建议、写入与导出期间持续显示，取消中保留动画及“正在停止”说明，成功/失败/取消结束后恢复普通图标。切换到其他页签不影响后台动画，其他页签不会因同一会话而误显示忙碌状态。
- 图标占位固定，不改变标签宽度；悬浮与辅助技术可读取当前任务名称，跟随主题并尊重减少动态效果设置。图标只订阅任务标签和运行状态，进度轮询不使整个标签栏重绘。
- 已确认悬浮闪退根因：Tooltip 的 escaped 定位检测将底部横向滚动容器之外的内容隐藏，实际可见区域内的卡片也受影响。替换为 Portal Popover 悬浮卡片，移入卡片持续展示、离开 250 ms 后收起，键盘聚焦/Esc 和点击完整任务中心保持可用；仍展示前三项运行任务及其进度、额外数量提示，窄窗口内部滚动。
- 验证：在独立无界面 Edge 中用真实组件与模拟任务重现旧版 visibility:hidden，修复后验证持续进度刷新、鼠标移入/离开、键盘聚焦/Esc、打开完整任务中心、前三任务/进度、80%–150% 显示密度和窄窗口边界、来源页签隔离与取消/成功/失败结束状态；前端构建和运行状态回归通过。未操作用户桌面、未访问数据库或真实模型。
- 回归入口：Vite 使用 1425 端口启动后执行 `scripts/check-task-ui.cjs`，需要 Playwright 与 Edge，可通过 `PLAYWRIGHT_MODULE` 指定现有依赖；测试夹具位于 `scripts/fixtures/task-ui.*`。原生 Tauri 视觉验收由用户进行。

### v0.110 AI 响应诊断与读取上限

- 修复将 SSE 包装/心跳计入 2 MiB 正文额度的问题；传输与内容分别限制，超限信息明确指出限制对象，不再建议降低无法直接控制的单批数量。
- 已完成数据生成响应快照、失败入口、批次选择、分页/复制、服务错误正文、当前密钥脱敏、截断和内存淘汰提示。失败响应仅供诊断，不产生可写入数据；已接收的部分正文不等于完整响应。
- 验证：前端构建、生成事件/归档上限回归通过；Rust 57 项通过、4 项显式服务器集成测试跳过。新增本地 HTTP 模拟测试覆盖 SSE 包装超 2 MiB、正文上限、错误正文、非法 JSON 和密钥脱敏。未请求真实模型，未控制桌面，视觉验收由用户进行。
- 已知边界：规则建议仍使用原有非流式返回方式，本次响应查看针对数据生成；原始 SSE 包装与推理字段不归档，异常事件单独保留有界诊断片段。当前页关闭或重新生成后无法找回旧响应。

### v0.109 任务进度可见性

- 数据生成页的状态条新增校验进度条及百分比，保留数量与查看过程入口；失败时保留停止位置，成功时显示完成状态。窄布局可换行，颜色跟随主题。
- 底部任务中心在有运行/取消中任务时使用主题高亮、加载动画和数量徽标。悬浮或键盘聚焦显示当前任务列表的前 3 项（最近发起优先），包含任务名称、会话、耗时、当前消息和各自的进度条；超过 3 项显示剩余数量，点击打开完整任务中心。
- 进度统一归一化：已知正数总量显示百分比；未知/零总量使用不定进度条，不伪造百分比；负数与非有限处理量归零，超过总量时进度条最多 100%。生成条表示已校验比例，不代表模型输出字符比例。
- 悬浮卡片使用 Portal 向上弹出并限制宽高，可滚动，避免底部状态栏裁切。完整任务中心或悬浮卡片打开时才刷新耗时；未增加后端轮询或任务正文存储。
- 验证：TypeScript/Vite 构建通过；任务运行/取消、进度边界、生成规则/流式现场/草稿恢复脚本通过。仅前端展示调整，未改数据库与 AI 请求逻辑；未控制桌面，视觉验收由用户进行。

### v0.108 生成过程与流式预览

- 已完成：SSE 内容生成与非流式切换、任务隔离的实时过程面板、返回文本/已校验数据双区预览、成功/失败通知与失败原因弹窗、取消/失败现场保留、唯一约束字段/行号定位及跨批次唯一值上下文。
- 验证：54 项 Rust 测试通过，4 项显式服务器集成测试跳过；新增真实 HTTP 模拟流验证首段在结束前送达、UTF-8 分片、CRLF、usage、截断/中断拒收、流中取消、重复值保留失败行；前端验证缓冲上限、样本上限、结束后迟到事件隔离及原有规则/模板/草稿恢复。未控制用户桌面、未请求真实计费模型。
- 已知边界：不完整 JSON 只展示文本，完整批次返回后才做结构化校验；流式服务需支持 SSE，不能保证第三方服务及时刷新输出。过程面板仅在当前打开的生成页保留，不跨重启恢复，不提供失败批次部分写入。操作说明见 `docs/acceptance-v0.108.md`。

### v0.107 AI 直接生成与流程澄清

- 已完成：直接生成入口、自动业务字段选择及范围展示、默认服务选择、草稿提示词恢复、规则生成入口语义澄清、预览来源与请求进度。
- 修复原因：此前仅填写 AI 要求或应用 AI 规则建议不会把业务字段设为 AI 内容规则，导致预览继续走本地生成，形成“没生效”的体验。
- 自动验证：50 项 Rust 测试通过（4 项显式集成测试跳过）；前端方案转换/隔离/边界回归通过；模拟兼容 HTTP 服务验证实际生成调用及非法响应不回退，隔离 SQLite 验证无隐式写入。真实服务兼容性与视觉体验由用户自行验收，未调用用户计费接口或控制桌面。
- 操作与已知边界见 `docs/acceptance-v0.107.md`；G1–G3 原有适配范围和数据写入边界保持适用。

### v0.106 统一数据生成 G1–G3

- 已完成 G1：独立 AI 服务配置、模型列表/手动模型、测试、凭据分离与统一生成接口。
- 已完成 G2：五种引擎目标（Redis String/Hash）、模板库/批量规则、确定性本地生成、草稿恢复、冻结批次分页预览、分批插入、取消/部分失败统计和文件导出。
- 已完成 G3：自然语言建议规则（确认后应用）、指定字段 AI 内容生成、字段/类型校验、token 用量与任务中心。
- 自动验证：49 项 Rust 测试通过，覆盖隔离 SQLite 数据库、模拟 OpenAI 兼容 HTTP 服务；本机 MySQL/PG/MongoDB/Redis 随机对象生成/写入/清理通过；规则/模板/恢复和原有连接/任务/工作区回归通过。未使用真实 AI 账户计费接口，未控制桌面进行视觉验收。
- 已知边界：MySQL 非 InnoDB、SQL 未知/二进制/向量类型暂不写入；集合完整约束、外键及排序规则由数据库最终执行。MongoDB/Redis 按记录提交，无整个任务回滚；不确定结果必须人工核对。Schema 输出仅固定测试采用严格模式，动态生成采用 JSON + 本地校验。G4 未开始。
- 详细操作与验收：`docs/acceptance-v0.106.md`。

### v0.105 应用标识与全局工作流

- 图标（v0.142 更新）：透明背景、蓝色镂空数据库轮廓；SVG 为源文件，Tauri 图标工具生成 ICO/PNG/ICNS。窗口标题栏、关于、WebView 图标与可执行文件使用同一标识，品牌色不随用户主题改变。
- 流畅度：面板分隔条每动画帧最多更新一次，松手提交最终值；取消拖动恢复起始尺寸，支持方向键/Home/End。恢复的工作区首次选中才挂载，已访问的页签继续保留编辑/滚动状态；工作区内容 memo 隔离外壳更新。任务中心关闭时停止耗时定时器和记录列表构建。工作区保存只订阅页签、活动会话与草稿变化，并跳过相同快照，连接健康探测不再触发写盘。
- 快速打开：Ctrl+P 输入关键词后才加载已连接 SQL 会话的对象索引；本地页签/文件/收藏立即可用。索引缓存 60 秒，支持手动刷新；切换范围/关闭后忽略过期结果。输入 > 只搜索应用命令，包括设置、布局、专注、重新打开页签、任务中心、历史与关于，不扫描数据库。
- 工作区布局：底部工作区菜单、设置「布局与缩放」及快速命令均可进入。提供经典左栏、左右分栏、右侧工具栏；最多保存 12 个自定义名称（同名拒绝），记录面板位置、左右独立宽度、上下比例和折叠状态。应用布局通过本地 SQLite 事务原子保存全部相关设置，成功后更新界面；失败保持原布局并显示错误。预设保存在 workspace_layout_presets_v1，兼容原独立设置键。
- 专注模式：Ctrl+Shift+J 临时隐藏面板，退出后保留原布局和折叠状态，不持久化专注开关。Ctrl+B 在专注时退出专注；其他情况沿用侧栏折叠。
- 页签：标签栏末端的下拉按钮列出当前会话全部页签（内部滚动）；长标题悬停显示完整数据库/名称。增加「关闭右侧（置顶除外）」；关闭其它/全部仅处理确认时的目标集合。Ctrl+Shift+T 恢复本次运行最近关闭的 20 个页签，自动去重；已删除会话不恢复。SQL 使用已有草稿恢复机制，明确放弃的编辑仍按放弃结果处理，数据库未提交编辑不恢复。重启后的恢复数量在底栏提示，可关闭。
- 撤销：Ctrl+Alt+Z 或底栏撤销按钮恢复本地收藏切换、会话分组移动、面板停靠、布局预设切换/删除；最多 20 项，本次运行有效，保存失败保留记录可重试。不是数据库事务撤销，不覆盖删除会话/删除分组、连续尺寸拖动、主题设置等所有操作。
- 反馈与帮助：任务中心可返回任务发起时匹配会话/数据库的活动页签（同步不关联页签），页签已关闭时禁用；可复制失败详情，不自动重新执行。底栏关于页展示版本、本次更新、常用快捷键、配置与日志目录，可复制不含会话凭据的版本/运行环境。新增弹窗沿用紧凑尺寸、内容滚动、主题配色及关闭/忙碌保护。
- 验证：前端构建；工作区、停靠、连接/任务、生产力、页签滚动、外观、强调色回归；新增关闭顺序/脏编辑取消、恢复去重、布局连续切换/失败/撤销、收藏失败重试与保存去重检查；Rust 内存 SQLite 验证多设置提交失败完整回滚。
- 已知边界：不承诺全部后台子组件停止渲染或请求；元数据缓存刷新不取消已发出的服务端请求。任务定位表示发起时的页签上下文，不是历史结果快照；已关闭结果不重建。没有控制桌面或进行实测帧率/视觉验收，图标在 Windows 任务栏的缓存刷新、高缩放布局和快捷键手感由用户自行验收。

### v0.104 自定义配色交互优化

- 原因：原生色盘的 React onChange 在拖动时连续触发，每次均调用全局 setAccent，产生主题更新、全局订阅重渲染和 IPC 设置写入，拖动成本随已打开工作区增加。
- 自定义颜色改为独立 memo 组件内的草稿状态；拖动仅更新色值与局部色块，点击「应用配色」才保存并更新全局主题，可「还原」未应用颜色。预设色与跟随系统仍一键生效；应用失败保留草稿并显示错误。
- useAppTheme 按深浅色、强调色、界面风格与密度缓存主题对象，避免无关重渲染重复生成主题。强调色写入串行化，过期的系统色异步读取不会覆盖新选择；写入成功后更新生效状态，失败保持旧配色。
- 验证：前端构建、串行保存/最后选择优先/系统色迟到/失败重试/重启恢复回归。未控制桌面，不声称已有原生色盘帧率实测；调整后的实际拖动手感由用户验收。

### v0.103 紧凑工作台与弹窗规范

- 设计方向：保留 Fluent UI 的键盘、焦点与语义交互，采用更平面的工具型布局；取消紧凑模式下工作区标题/工具栏/网格的重复卡片、渐变与阴影，使用细分隔线、主题底色与弹窗标题左侧强调线建立层次。界面密度与九种配色独立。
- 设置「布局与缩放」新增「紧凑（默认）/舒适」，持久化到 ui_density。紧凑模式常规正文 13px、辅助标签 12px、弹窗标题 16px；按钮最小高度 26px、输入框最小高度 28px，长文案仍可撑开。沿用用户缩放、编辑器字号和数据网格行高，不通过整体缩小界面实现紧凑。
- 主界面：标题栏 34px，工作区标题/工具栏平面化；侧栏使用主题画布底色；表信息、设置、同步区使用统一间距变量；Redis 详情收紧头部和正文；MongoDB 集合工具并入集合标题行，查询输入与详情收紧。
- 二级弹窗：统一 16px 内边距、8px 圆角、紧凑标题和带分隔线的操作区，弹窗背景跟随所选深浅主题而非系统主题；覆盖会话、数据库、建表/改列、索引/外键、SQL 确认、单元格详情、Redis 键操作、MongoDB 确认、导入导出、历史/快速打开、任务中心和未保存提示。标题与操作区保留，内容内部滚动；极矮视口改为整窗滚动确保可达。
- 表单：会话改双列，主机/端口与认证相关字段分组；窄窗口回单列。建表、改列、索引、外键、导入导出等间距统一；列类型长说明改为展开查看。主题选择缩小缩略图。
- 范围说明：系统文件选择器、Windows 标题栏原生行为以及 Monaco 内部排版不重写。网格虚拟滚动尺寸保持原逻辑，不以 CSS 改行高。
- 验证：TypeScript/Vite 构建、外观设置持久化/失败恢复/旧配置迁移与九主题对比度检查；没有控制桌面或声称完成视觉实测。建议用户重点检查高缩放、小窗口、二级确认和键盘焦点。

### v0.102 MongoDB M3/M4 与 SQL 执行计划

- MongoDB「集合工具」：集合统计（文档数、数据及索引空间等）、索引查看与创建（复合键、唯一、TTL 等）；创建前展示定义并确认，后端检查只读会话。索引创建超时提示结果待确认，不能视为已撤销。
- 字段抽样：自然顺序前 100 条文档的顶层字段类型、出现次数和缺失次数；不是完整 schema，也不是随机全库分析。
- 聚合：Extended JSON 数组编辑与只读执行，允许 match/project/group/sort/lookup/facet 等阶段，递归验证嵌套管道并拒绝 out/merge/服务端脚本；服务端 maxTime 20 秒、禁止磁盘溢写，预览最多 500 条 / 8 MiB，达到上限明确提示。首版采用可展开 JSON 结果，暂不提供阶段拖拽或聚合文件管理。
- 导出：按当前 Filter 导出全部匹配的完整文档，不受浏览分页/投影影响；JSON 数组或 JSON Lines，采用 Canonical Extended JSON 保留 BSON 类型。流式读取，临时文件与目标同目录，完成且未取消才替换目标；查询 maxTime 60 秒，不提供一致性快照。
- 导入：仅新增，重复键等确定失败继续并生成同目录唯一 errors.jsonl 报告（记录编号、错误码与脱敏原因，不复制原文）；JSON 数组上限 64 MiB，JSON Lines 按单行流式读取、单行上限 48 MiB。网络或写入结果不确定时停止；取消在文档之间生效，已提交文档保留。没有覆盖模式、全文件事务或断点续传。报告目录不可写时在开始插入前失败。
- 任务中心显示分析、索引、导入导出进度/结果/失败，工具对话框运行时允许收起，以便访问任务中心取消；只读会话后端禁止索引创建和导入。
- SQL：复用执行计划入口；MySQL 使用 EXPLAIN FORMAT=JSON，PostgreSQL 使用 EXPLAIN (FORMAT JSON)，SQLite 保留 QUERY PLAN 网格。新增可展开节点、表、索引、预估行数/成本、全扫描提示与原始 JSON；未识别格式显示原文。针对当前光标语句或选中语句，不再误用上次执行 SQL。仅预估计划，不开放 ANALYZE；拒绝多语句、外部 EXPLAIN 选项和可执行注释。为避免服务器转义模式歧义，暂拒绝带反斜杠字符串及 PG dollar-quoted 字符串。
- 验证：本机认证 MongoDB 临时库实测统计、抽样、索引、聚合、JSON/JSONL 导出导入、重复键报告、取消时原目标文件保留，以及 ObjectId/Int64/Decimal128/日期/二进制/嵌套结构文件往返；测试后清理。执行计划有语句边界与 PG/MySQL JSON 样本回归；本轮未做 MySQL/PG 真实服务计划验收或桌面控制，TLS/SRV/副本集仍未覆盖。
- 参考：[MongoDB Rust 索引](https://www.mongodb.com/docs/drivers/rust/current/fundamentals/indexes/)、[MySQL EXPLAIN](https://dev.mysql.com/doc/refman/8.4/en/explain.html)、[PostgreSQL EXPLAIN](https://www.postgresql.org/docs/current/sql-explain.html)。

### v0.101 MongoDB 实机验证与浏览交互

- 会话共用图标注册表补齐 MongoDB 绿色叶片图标。
- 文档表格移除「操作／查看」列，点击整行显示详情，支持 Tab 聚焦及 Enter／空格选择；JSON 树卡片同样支持点击选择，展开节点不触发重读。选择高亮、投影只读与未保存编辑保护保留。
- 修复原文冲突表达式误用 `$ROOT`，改为 MongoDB 系统变量 `$$ROOT`，保持原子条件更新／删除；插入和替换返回文档统一将 `_id` 排在首位，与服务器存储顺序一致，避免后续快照比较误判。
- 本机认证服务使用随机 `dw_acceptance_` 测试库验证分页、完整读取、BSON 类型、自动生成 `_id`、插入／替换／删除、重复键、修改 `_id` 拒绝、过期原文冲突与投影只读标识。测试结束删除专用测试库，不读取业务集合。TLS／SRV／副本集及桌面交互尚未实测。

### v0.100 MongoDB M1＋M2

- 已完成：MongoDB 官方 Rust 驱动 3.3.0，新增 Engine::Mongodb 与 DocumentAdapter，文档查询/游标/读写独立于 SQL。为降低本轮对现有引擎的影响，连接容器保留 DbAdapter 公共连接桥接，MongoDB 的 SQL 方法明确拒绝；完整公共连接 trait 拆分留待后续。
- 连接：主机/端口、mongodb://、mongodb+srv://、认证库、账号密码及 TLS；每会话复用 Client（每服务器最大8连接）。共用连接去重、连接状态和重连机制；认证库独立存储列 auth_source，密码沿用 Windows 凭据管理器；URI 不接受内嵌账号密码或秘密选项，需拆分填写。保留 URI 的副本集/认证机制配置，表单认证库优先。
- 浏览：数据库/集合、默认数据库回退、集合搜索与收藏、按名称打开（首个文档写入时创建新集合）、集合页签去重/恢复、快速打开收藏集合。受限账号请求 authorizedDatabases/authorizedCollections；列表失败且指定默认库时允许尝试该库。SQL 历史、同步及关系型结构入口排除 MongoDB。
- 查询：Filter、Projection（字段0/1）、Sort（1/-1）、Limit（1–10000），默认最多1000条；后端游标每批最多50条、目标2MiB预览，超过128KiB的单文档不返回摘要内容，点击按 _id 读取完整文档。表格最多展示20字段，树节点每层最多200项，完整内容由详情编辑器查看/复制。游标空闲120秒定期清理（扫描间隔30秒）、每会话最多16个；刷新/关闭/取消释放，下一批替换当前批，暂不支持任意页跳转。
- BSON：Canonical Extended JSON 跨 IPC，启用 serde_json preserve_order 保留原文字段顺序；ObjectId、Int64、Decimal128、日期、数组、二进制等保持类型，missing 和 null 区分。投影隐藏 _id 时只读预览；可编辑详情始终按 _id 重新读取完整原文，禁止用局部投影/省略预览直接覆盖。
- 编辑：新增/复制（移除原 _id）/替换/删除单文档；无 _id 时自动生成 ObjectId，已有 _id 不可变。提交前展示原文/新文对照；按 _id + $expr 文档原文等值条件原子更新/删除（simple collation），变化或删除则拒绝覆盖。比较采用 MongoDB 文档等值语义（不是应用版本号锁）；首版不支持部分字段补丁、多文档事务和批量编辑。
- 保护：后台只读会话拦截；前端未保存编辑接入切文档/查询/翻批/关闭/断开/退出保护，失败保留草稿；正常修改不自动保存到磁盘，异常退出不恢复未提交文档。查询/修改接入任务中心，查询可请求取消；写入发送后等待实际结果，不把取消当作回滚，超时或网络异常提示结果待确认，禁用再次提交，需复制草稿并刷新核对；不自动重发。
- 历史：MongoDB 集合内独立历史/收藏，最多100条普通记录＋100条收藏，按会话/数据库/集合隔离；串行保存并在失败时保留内存旧值，收藏可重新载入查询条件。
- 验证：前端构建、Rust BSON类型往返/顺序/投影/原文条件/秘密URI检查，前端页签隔离/历史并发与持久化失败回归，以及原有工作区/SQL/字段类型回归。提供 ignored 专用MongoDB集成测试（DW_MONGO_TEST_URI，可选 DW_MONGO_TEST_USER/PASSWORD），随机 dw_acceptance_ 数据库；当前环境无 mongod/docker，未执行真实服务器与桌面验收，不能视为已验证 Atlas/TLS/副本集联通。
- 后续：M3聚合管道、索引、字段抽样、集合统计；M4导入导出。当前不支持完整mongosh、GridFS、Change Streams、MongoDB同步或跨引擎同步。

### v0.99 独立侧栏宽度与扩展主题

- 已完成：左右侧栏分别使用 ui_sidebar_width / ui_right_sidebar_width，拖动和设置界面独立调节；旧宽度首次迁移至右侧并持久化，之后互不覆盖。窗口空间不足时仅限制显示宽度，不覆盖用户保存值。同侧上下两个面板共享该侧列宽。
- 已完成：保留经典/流光/专业风格，新增海盐蓝、苔原绿、暖砂纸、雾紫、石墨、玫瑰灰六套风格，均支持亮暗模式及独立强调色；设置新增自定义颜色选择器。
- 覆盖：新主题的整体背景、侧栏、Fluent 按钮/输入/菜单/弹窗与选中态、页签、表头与数据区、工具栏、底栏，SQL/Redis/单元格详情 Monaco 编辑器背景、光标和选择区域。告警、错误及环境标识保留语义颜色，语法高亮沿用 Monaco 基础亮暗规则。
- 验证：前端构建；左右宽度迁移与重启恢复、9种风格持久化、6套亮暗普通/次要文字对比度回归；停靠与工作区回归。未操作桌面，视觉及真实窗口拖动由用户验收。

### v0.98 PostgreSQL 向量读取

- 已完成：解析 pgvector vector 的网络二进制（维数/保留位/float32）和文本值，支持包括768维在内的合法向量；检查长度、维度、保留位与非有限数值。向量文本完整传入表数据/查询结果，详情复用同一解码路径，支持查看与复制。
- 已完成：增加 readonly 值标记；真实 NULL 通过驱动原始值判断，非空但未支持/解析失败的 PG 字段明确显示类型提示，禁止静默变成 NULL。HALFVEC/SPARSEVEC 及向量数组尚未新增解码，会显示未支持提示，可通过 SQL 转 text 查看。
- 已完成：向量网格/详情只读（含空向量列），后台拒绝把只读值作为变更或筛选参数；同步遇到只读值跳过并报告，避免落成 NULL。CSV/JSON 导出将向量作为文本输出；通用导入/同步写向量仍不支持，需使用显式 SQL。
- 验证：二进制768维、文本、无效长度/维度/非有限值、readonly序列化与写入拒绝、前端显示/空值区分回归；未直接连接用户 PG 或控制桌面，真实 pgvector 端到端由用户验收。
- 协议依据：[pgvector vector_send/recv](https://github.com/pgvector/pgvector/blob/v0.8.0/src/vector.c)。


### v0.97 下拉与菜单内部滚动

- 已完成：统一 Fluent Dropdown/Combobox 的弹出列表最大高度为 min(320px, 60vh, 视口减24px)，超出内部滚动；Portal 弹层同样适用，分组和选项不压缩高度，滚动不传递到底层页面。
- 排查覆盖：三处字段类型、SQL/对象搜索数据库、同步源/目标、字符集和排序规则、外键表/列、导入导出映射、会话分组与 Redis 类型等下拉；原筛选面板滚动限制同步改为视口自适应。
- 已完成：Fluent 动态菜单（含草稿库）限制420px/70vh，自定义右键菜单保留位置校正并采用相同高度上限。历史、快速打开、收藏、任务中心等原有内部滚动区域保持原逻辑。
- 验证：前端构建、类型分组与菜单定位回归通过；未控制桌面，用户自行检查鼠标滚轮/键盘选择及高缩放下菜单显示。


### v0.96 类型分组与表信息

- 已完成：新增列、编辑列、新建表的类型下拉统一使用 Fluent OptionGroup 分组，按数值/布尔/文本/日期时间/JSON/二进制/标识与网络划分，仅显示当前数据库支持的选项与非空分组；已有特殊声明独立列在“当前声明类型”，保留原始值。
- 已完成：表信息每个分区内每行两个标签-值栏位，拓宽内容区并收紧间距；按工作区实际宽度（含两侧停靠）响应，620px 以下退为单列，长名称/注释换行；磁盘零值显示 0 B。
- 验证：三引擎分组完整性和去重回归、前端构建；未控制桌面，视觉由用户自行验收。


### v0.95 面板独立停靠

- 已完成：拖动会话/对象浏览器标题至主窗口左/右边缘独立停靠；同侧支持上下排列，分居两侧时各自占满高度。拖动显示落点，中央/窗口外释放不修改布局，Esc、指针取消或失焦取消拖动。
- 已完成：标题旁布局菜单提供左右移动/同侧上下排序/恢复默认，设置的布局页也可恢复默认停靠；配置存入本地 settings，保存串行，慢速恢复不覆盖新操作。
- 已完成：布局采用固定 React 子树与 CSS Grid 移位，移动及 Ctrl+B 收起时保留面板和工作区实例；支持两侧宽度拖动（沿用统一侧栏宽度配置）、同侧上下比例拖动，窗口变窄时限制侧栏宽度以保留数据区。
- 范围：仅主窗口内左右停靠与上下排列，不包含独立浮动窗口、拖到其它显示器或数据区上下停靠。原有宽度和比例设置继续有效。
- 验证：后台覆盖独立停靠/排序、落点判断、配置损坏、恢复与用户操作竞争、顺序保存及失败重试；前端构建。未控制桌面，指针手感、重启与不同缩放下视觉由用户验收。


### v0.94 侧栏与连接状态视觉整理

- 已完成：新建会话/分组合并为标题栏新增菜单，刷新移到标题栏，移除中间工具条；分组文字弱化、间距收紧、选中会话突出，第二行仅保留地址，连接中/失败显示文字，常规状态用状态点与悬浮说明。
- 已完成：搜索默认跟随最近展开的数据库，无展开记录时使用活动页签或首个数据库；范围选择收进搜索框旁按钮，输入时显示当前范围。修复数据库列表缓存键使用错误导致下拉范围缺失；按需加载范围内表列表。
- 已完成：空收藏仅保留轻量入口，展开给出操作说明；未收藏星标悬停或键盘聚焦时显示，已收藏始终显示，触控设备保持可见。
- 已完成：对象浏览器和工作区空状态连接提示使用透明背景，连接中仅显示加载图标和文字，失败保留原因与重试；已打开页签断线提示移至工作区顶部，不再放入标签按钮。
- 空间分配：新配置默认会话区 38%，移除中间工具条释放空间；已有自定义上下比例继续保留，可拖动分隔条调整。
- 验证：前端构建及现有工作区、连接状态、收藏/搜索关联数据和菜单回归。未控制用户桌面，宽窄侧栏及视觉验收由用户完成。


### v0.93 MySQL 表大小统计兼容

- 已完成：MySQL 元数据整数读取兼容 DECIMAL 和文本数字，直接做十进制转换，避免中转浮点造成大整数精度丢失；同时覆盖 SUM 形式的库级统计。
- 已完成：普通表保留零值，对象浏览器显示 0 B；视图不显示表大小，未知值继续留空。MySQL 悬浮提示标明估算大小，仍使用 DATA_LENGTH + INDEX_LENGTH，不扫描业务表计算精确空间。
- 验证：十进制小数位、科学记数、大整数、溢出与零值回归；前端构建和 Rust 测试。未访问用户数据库或控制桌面，实际服务器显示由用户验收。


### v0.92 新建表布局与类型来源

- 已完成：新建表从独立表头/横向输入行改为字段卡片，每项自带标签；网格按可用宽度换行，控件允许收缩，NULL/主键/自增使用带文字的独立选项区，删除按钮置于卡片标题栏。
- 已完成：类型说明默认折叠，仅在适用类型显示长度/精度输入；弹窗宽度受视口限制，沿用内容区纵向滚动，避免输入行与表头分别横滚造成错位。
- 已核实：SQLite 结构列类型来自 pragma_table_xinfo 的 type 字段，后端原样赋值 raw_type，前端直接显示 rawType，不以 canonical 推测替换。结构页改称“声明类型”，解释 VARCHAR(n) 并非 SQLite 普通表的长度约束。
- 验证：前端构建及类型回归通过；未操作用户桌面，宽窄窗口及缩放下的视觉验收由用户完成。


### v0.91 数据库字段类型适配

- 已完成：新增列行、列编辑弹窗、新建表统一使用按引擎划分的类型配置；SQLite 提供 INTEGER/REAL/TEXT/BLOB/NUMERIC 并默认 TEXT，PostgreSQL 使用原生类型名称，MySQL 不再显示伪原生 UUID 类型。
- 已完成：PG JSON/JSONB、TIMESTAMP/TIMESTAMPTZ/TIMETZ 明确区分，保持同步使用的规范类型映射；已有列编辑默认原样保留数据库声明（大小写、数组、枚举、无界 VARCHAR/NUMERIC 等），显式重新选型才重新生成类型。
- 已完成：长度、数值精度、时间精度控件按类型适配；限制自增类型，SQLite 新建表自增要求单列整数主键，添加/编辑列不开放 SQLite 自增开关。
- 边界：SQLite 本轮提供普通表常用亲和类型，STRICT 类型规则在界面说明，STRICT/ANY 及 PG 新建数组、枚举、自定义类型仍通过 SQL 管理；PG 数值精度/小数位沿用现有 u8 参数模型，未覆盖全部 PostgreSQL 精度范围。
- 验证：前端类型配置回归、三入口构建；后端 PG 类型语义、原始声明保留和 SQLite 内存库实际建表回归。未操作用户桌面或连接用户数据库，用户自行验收。
- 依据：[SQLite 类型规则](https://www.sqlite.org/datatype3.html)、[SQLite STRICT](https://www.sqlite.org/stricttables.html)、[PostgreSQL 类型](https://www.postgresql.org/docs/18/datatype.html)。


### v0.90 活动页签滚动追踪

- 已完成：恢复工作区后连接会话、切换会话/页签、打开/关闭/置顶页签和返回工作区时，将当前页签滚动到标签栏可见范围；已经可见时保持滚动位置。
- 已完成：窗口、侧栏宽度变化及界面缩放后重新校正；只滚动标签栏，保留数据区位置，用户手动拖动滚动条时不强制拉回。
- 验证：后台检查左右越界、已可见、缩放、隐藏容器和超宽页签；前端构建。桌面验收由用户完成：打开多张表并选中末尾页签，重启后连接原会话，确认选中标签可见。


### v0.89 统一连接管理

- 已完成：所有正式连接入口统一经过会话 Store；同会话连接中共享 Promise，已连接直接复用，修改/删除/断开期间阻止新连接。刷新列表不覆盖期间变化的连接状态。
- 已完成：后端按会话共享一次连接尝试的成功或失败，已连接复用适配器；连接、配置更新、删除、断开按会话串行，不阻塞其它会话。完整连接尝试限制 30 秒；健康探测失败仅移除对应旧适配器，重试建立新连接。
- 已完成：对象浏览器、右侧空工作区与已打开页签统一显示连接中、失败原因和重试；连接中禁用连接按钮，断线保留编辑内容。
- 语义边界：连接池内部可有多个物理连接，这是正常池化；“测试连接”使用待保存配置建立临时连接，不加入正式会话池。没有新增自动重连或自动重跑 SQL。
- 验证：前端连接去重/订阅重入/失败重试/生命周期互斥/过期探测回归，后端共享成功/失败与不同会话并行回归；本轮仅后台检查，桌面验收由用户完成。
- 自行验收：对不可达 PG 会话从列表和对象浏览器连续点击连接，三处均显示连接中，失败后展示原因和重试；恢复数据库后重试；已连接时重复打开对象应复用连接，断开重连后原有编辑内容保留。


### v0.88 编辑器菜单

- Monaco 初始化之前加载当前安装版本自带的简体中文语言包，覆盖剪切、复制、粘贴、修改所有匹配项、命令面板等原生文案；应用内共用 Monaco 的编辑器同时生效。
- SQL 编辑器通过公开 addAction API 注册右键操作：执行当前语句、执行选中 SQL、格式化（选中优先）、保存 SQL 文件、打开查询历史中心。保留原生编辑菜单及定位能力。
- 当前语句执行明确忽略选区；选中执行只使用选区，未选中时不可用，选中空白时拒绝执行，不回退执行其它 SQL。运行中或参数/危险确认未结束时禁用执行动作；复用现有命名参数、只读检查、危险确认和任务中心。Ctrl+Enter 仍为选中优先。
- 使用实时回调，切换数据库/修改编辑内容后不执行挂载时的旧 SQL；组件清理时注销菜单动作。
- 验证：前端构建、中文资源/加载顺序、菜单条件和入口隔离、SQL 编辑回归通过；桌面交互仍由用户自行验收。


### v0.87 查询与浏览效率

| 模块 | 状态 | 实现说明 |
|---|---|---|
| 查询历史中心 | 完成首版 | 底栏及 SQL 历史菜单入口；本地 SQLite 先按 SQL 文本、连接、数据库完整名称、UTC 日期区间、成功/失败筛选，再以 100 条分页；历史仍按连接保留最近 500 条；收藏另存快照，不受历史滚动清理影响；重新打开创建新 SQL 页签，不执行、不替换当前编辑 |
| 全局快速打开 | 完成首版 | Ctrl+P 或底栏按钮；搜索表/视图、表与 Redis 键收藏、收藏 SQL、曾打开或保存的 SQL 文件、现有页签；默认加载当前连接对象，可选择所有已连接会话，元数据按库最多两路并发；加载失败提示范围不完整；上下键/Enter/Esc 操作，返回前 100 项；已有文件页签优先激活，保留未保存编辑 |
| SQL 编辑增强 | 完成首版 | 执行按钮与 Ctrl+Enter 默认执行光标所在分号语句，有选区则执行选区；扫描器忽略字符串/注释/PG dollar-quote 内部分号及参数，处理各引擎常见转义；按钮及 Ctrl+Shift+F 提供保守格式化并支持撤销，不改变非空白 token |
| 命名参数 | 完成首版 | 使用 :name，重复名称共用输入；支持文本、数字、布尔、NULL；后端校验数字并按引擎渲染字面量后替换，保留大整数文本精度，不把输入直接拼成 SQL 片段；实际 SQL 继续经过只读/危险操作确认与任务中心，并记录到执行历史；参数值不另存方案 |
| 别名与跨 schema 补全 | 渐进增强 | FROM/JOIN/UPDATE/INTO 常见表引用与 AS/隐式别名；alias. 优先提示该表字段，PG schema. 提示该 schema 对象，MySQL database. 加载对应库；最多六个表引用取元数据，缓存表清单 30 秒，输入/数据库变化后丢弃过期结果；同时修复跨 schema 同名表误复用页签 |
| 筛选增强 | 完成首版 | 表数据右键“按此值筛选（替换条件）”，使用当前显示行并保留值类型，NULL 使用 IS NULL，截断值拒绝精确筛选，未提交网格修改仍拦截；保留 AND/OR 条件组合；按连接/库/schema/表保存命名方案，支持载入、同名覆盖、删除，载入不自动执行，缺失字段提示失效 |
| 持久化与验证 | 自动检查完成，桌面待用户验收 | 收藏历史/筛选方案/最近文件使用 productivity_library_v1，串行保存避免相互覆盖，失败不更新内存；测试覆盖词法边界、参数安全、历史筛选分页、持久化并发/失败及 schema 隔离；本轮不控制桌面、不连接业务库 |

**已知边界**：快速打开搜索的是已连接会话的元数据和应用已知 SQL 文件，不扫描整个磁盘、不自动连接所有会话；打开离线收藏时只重连所选会话。历史日期为 UTC，已清理且未收藏的旧历史无法恢复。格式化是保守排版；复杂存储程序、MySQL DELIMITER、SQL mode 特殊转义、嵌套作用域/CTE 别名推导尚非完整 SQL 解析器，复杂过程请明确选区执行并核对 SQL。筛选首版为同层 AND 或 OR，尚无嵌套括号条件组。详细自行验收步骤见 docs/acceptance-v087.md。


### v0.86 缩放调节稳定性

- 设置页缩放滑块改为待应用值：拖动只更新百分比，点击「应用缩放」后统一应用和保存，避免滑轨随自身缩放移动。
- 显示当前已应用比例及未应用提示；提供恢复 100% 按钮。快捷键与 Ctrl+滚轮仍即时缩放，并同步设置页显示值。
- 未应用比例只保留在本次设置页内，关闭设置后丢弃；保存期间禁用操作并显示失败通知。
- 验证：前端生产构建与 release-fast 打包通过，产物 `release/Data Workbench v0.86.exe`。
- 已知边界：点击应用后设置页随全局比例调整一次；本轮不控制桌面，交由用户自行验收。


### v0.85 连接状态与统一任务中心

| 模块 | 状态 | 实现说明 |
|---|---|---|
| 连接状态 | 完成首版 | 会话列表明确显示未连接、连接中、已连接、已断开；同会话连接请求去重；每 30 秒对空闲连接执行有 5 秒超时的 ping，数据库操作失败也触发探测，不用 SQL 语法错误直接推断断线；过期探测不能覆盖重连结果 |
| 断线恢复 | 完成首版 | 已挂载工作区、SQL 草稿、网格和 Redis 未提交编辑继续保留；断线提示与重连按钮；断线期间阻止数据库调用，重连后由用户继续执行，不自动重放 SQL 或写入；连接/任务运行期间阻止删除、重配或断开会话 |
| 任务中心 | 完成首版 | 底栏统一入口，查询（含分页/执行计划）、CSV 导入、CSV/JSON/XLSX 导出、结构/数据比较与同步使用独立任务 ID；显示运行/取消中/完成/失败或部分失败/已取消、耗时、已处理数量、错误和结果；总量未知时使用不定进度；保留本次进程最近 100 条已结束任务及全部运行任务 |
| 任务取消 | 完成首版 | 取消请求与实际结束分开；MySQL/PG 读取使用该任务的查询连接 ID 发出取消，等待真实结果，不取消同会话其它查询；SQLite 当前读取不支持立即中断，明确提示等待；导入、结构同步与数据写入在批次/语句边界停止，已提交变更保留，记录已提交数量和同步回滚目录；取消太晚时按真实成功结果显示 |
| 导出文件保护 | 完成 | 所有格式先写同目录临时文件，全部成功且未取消后替换目标；失败/取消清理临时文件，已有文件保留；读取阶段支持任务取消与 60 秒等待上限 |
| 弹窗与退出 | 完成首版 | 导入/导出/同步确认弹窗内部显示任务进度和取消入口；运行中防止遮罩/Esc 关闭写入弹窗；有任务未结束时退出给出明确提示，在任务中心取消并等待结果后可正常退出 |
| 验证边界 | 自动检查完成，桌面由用户验收 | 本轮不控制用户电脑、不启动或关闭工作台、不连接业务数据库；后台使用模拟 IPC 与临时 SQLite 测试；MySQL/PG/Redis 真实断网与 GUI 缩放交互交由用户验收，见 docs/acceptance-v085.md |

**已知边界**：任务记录不跨重启持久化；进程崩溃的结果恢复不在此轮范围。空闲 ping 是时点探测，网络波动或连接池拥塞可能暂报不可用，需手动重连。SQLite 当前查询、正在提交的事务或 DDL 不强制中断；取消等待当前操作返回，不承诺撤销已提交数据。单条 SQL 写入的超时可能导致结果不确定，须核对数据库，不自动重试。CSV 当前仍整文件读取、XLSX 仍在内存组装。断线保留是本次运行的编辑状态，表格与 Redis 草稿不承诺崩溃恢复。


### v0.83 环境标识、对象搜索收藏与大数据浏览

| 模块 | 状态 | 实现说明 |
|---|---|---|
| 稳定性验收 | 后台检查完成，桌面验收待做 | 覆盖退出取消/失败重试、工作区恢复、菜单位置与图标、环境收藏持久化、SQL 游标安全、Redis 分页合并；不在用户使用主屏时注入鼠标/键盘操作 |
| 环境标识 | 完成首版 | 会话编辑增加未标记/开发/测试/生产；会话列表、工作区标题、状态栏、SQL 危险确认、表格/结构/同步确认与未保存确认显示环境；文字加颜色区分，不自动修改只读权限 |
| 对象收藏 | 完成首版 | 表与 Redis 键增加星标，按会话/数据库/schema/类型/名称隔离；对象浏览器收藏区可快速打开，Redis 收藏直接定位键；收藏不存在的对象时打开会正常报错，支持取消收藏 |
| 对象搜索 | 完成首版 | 选择当前会话的数据库后搜索表名/schema/注释；点击按钮追加字段名与字段注释搜索，最多两张表并发读取，切换条件后忽略旧结果；明确显示读取失败导致的结果不完整 |
| SQL 大表分页 | 完成限定场景 | 单非空整数主键、无筛选、默认排序时使用主键升序游标，不逐页增加 OFFSET；保存已访问页的游标支持返回；复杂排序/筛选/复合或其它类型主键仍回退普通分页，不安全的数值不作为游标 |
| Redis 大集合 | 完成首版 | List/ZSet 范围续读，Hash/Set 游标续读，Stream 按条目 ID 续读；游标按字符串传输避免 64 位精度损失；保留 SCAN 返回整批成员并去重；每页显示 100 项，支持搜索已加载内容及已加载/总数提示 |
| 偏好持久化 | 完成 | `settings.object_preferences_v1` 保存环境和收藏；串行写入，落盘成功后更新状态，失败提示且保留原值，不改数据库连接结构或凭据 |

#### 验收条件与限制

- 副屏与主屏共享系统焦点、鼠标与键盘；用户确认移好窗口并允许使用键鼠后，已完成副屏核心流程验收：SQL 草稿取消/保存退出及重启恢复、测试环境标记、对象/字段搜索、收藏、SQLite 主键分页、Redis List/Hash 续读与底部菜单。完整矩阵未全部覆盖，证据及问题见 `docs/acceptance-v083.md`。
- Redis 搜索仅针对已加载成员；达到 5000 项后停止继续加载，SCAN 单批可能超过 COUNT 提示值，为避免漏项保留整批。List/ZSet/Stream 范围遍历及 SCAN 都不提供并发修改下的一致性快照；List 编辑使用原始索引，不使用过滤后位置。
- Redis 键列表扫描新增请求版本隔离与按键名去重，筛选/刷新重叠时不让旧响应回写，扫描途中固定使用本次搜索条件。
- SQL 游标分页不会保证跨页快照一致；筛选和自定义排序维持现有语义，复合主键及字符串主键的游标分页留待后续。
- 环境标识为可见提示，不代表服务端权限策略；未标记的现有会话不会自动推断为生产或开发。


### v0.82 退出修复

- 补齐主窗口 `core:window:allow-destroy` 权限。Tauri `onCloseRequested` 接管关闭后需要销毁窗口，仅配置 `allow-close` 无法完成退出。
- 退出处理统一拦截事件，依次确认未保存内容、持久化工作区、直接销毁窗口；不递归调用 `close()`。保存或销毁失败会提示，且允许再次尝试；重复点击不会并发保存/关闭。
- 回归检查覆盖权限配置、正常退出、取消、保存失败不关闭、销毁失败可重试、重复关闭只执行一次。新版桌面实测 SQL 草稿关闭取消保持窗口、保存后窗口实际退出，重启后文本和页签恢复。

### v0.81 工作台完善

| 模块 | 状态 | 实现说明 |
|---|---|---|
| 未保存内容保护 | 完成首版 | 表格变更、SQL 草稿、Redis String/集合编辑统一登记；关闭页签/会话、断开、退出以及刷新、翻页、替换查询、切换 Redis 键时提供取消、放弃、保存后继续；表格保存前展示 SQL，失败保留现场；自动清理不关闭脏页签 |
| SQL 草稿与工作区恢复 | 完成首版 | `settings.workspace_v1` 保存页签、活动会话、SQL、数据库和草稿库；500 ms 防抖、串行写入，退出前刷新；重启恢复后等待用户连接再首次加载数据库内容 |
| SQL 自动补全 | 完成首版 | Monaco 按当前会话/数据库提供关键词、表名及简单 FROM/JOIN/UPDATE/INTO 引用表的列名；元数据短期缓存，编辑器销毁时解除注册 |
| Redis 命令控制台 | 完成首版 | Redis 工作区第三页签；单双引号、空字符串、转义、Ctrl+Enter、常用命令与最近 100 条页签内历史；后端读写白名单、只读校验、写命令确认、15 秒超时 |
| 同步行级差异 | 完成首版 | 表名入口展开新增/修改/删除样本与字段前后值；每表最多 100 行、每行最多 100 字段、值最多 256 字符，统计与样本分开 |
| 数据同步回滚材料 | 完成首版 | 目标每批写入前持久化反向 SQL；目录为 `%APPDATA%/data-workbench/sync-backups/<任务ID>`；成功提交批次改为 `committed-*`，状态不确定保留 `pending-*`；执行日志显示目录；备份失败不写库，提交失败停止后续批次 |
| 同步边界修正 | 完成 | 修复源数据恰好整页结束时漏比较目标剩余行；尊重禁止补齐行选项；删除参与分批；按实际提交统计结果；参数内联不再误替换值中的问号/占位符；NULL 删除条件空安全比较 |
| 验证 | 自动检查通过 | 前端构建；工作区关闭/取消/自动清理/保存恢复及 Redis 分词检查；7 个菜单定位场景、46 个菜单项图标检查；9 个 Rust 测试（含独立临时 SQLite 同步/反向恢复/备份失败保护） |

#### 当前边界与后续事项

- 自动恢复保存 SQL 文本和页签信息，不持久化数据库密码、查询结果、表格尚未提交的变更或 Redis 编辑缓存；异常终止可能丢失最后一次防抖窗口中的修改。SQL 草稿保存在本机配置库。
- 自动补全为轻量元数据补全，复杂别名、CTE、跨 schema 引用尚未进行完整语法解析；草稿库暂以内容摘要标识，命名、整理和 `.sql` 文件管理后续补充。
- Redis 控制台只开放明确支持的普通命令，禁止改变连接状态、脚本、事务、订阅及管理类命令；超时不代表服务器未执行，界面明确提醒不要盲目重试。集合深分页与更多值类型浏览能力仍可继续完善。
- Redis Set 保留添加/删除成员，移除没有保存实现的编辑按钮，避免静默丢弃修改。
- 回滚材料含目标原始数据，保存在本机；仅用于直接 DML，不涵盖 DDL、触发器、级联副作用、后续并发变化。按 README 检查目标、备份与批次状态后人工倒序恢复，尚无自动回滚按钮。`pending-*` 必须先核实提交状态，不可直接执行。
- 数据同步遇到事务提交错误会停止后续批次，即使选中继续出错也如此，避免提交状态不确定时继续扩大影响；结构同步行为保持独立。
- 本轮真实数据库集成覆盖 SQLite；MySQL/PostgreSQL 实库验证、桌面不同缩放比例与连续快速切换的人工验收尚未完成。浏览器自动化曾因工具容量限制无法启动，不能据此宣称视觉验收通过。
- 后续增强：查询事务会话、执行计划、同步任务配置保存/进度取消、大数据分页性能与数据库环境标识。


### M1（已完成）

| 模块 | 状态 | 实现说明 |
|---|---|---|
| 工程骨架 | 完成 | Tauri 2.11 + React 19 + TS + Fluent UI v9；Mica 窗口 + 自绘标题栏（最小化/最大化/关闭/拖拽） |
| 本地存储 | 完成 | `%APPDATA%/data-workbench/app.db`；sessions / query_history / sync_profiles / settings 四表已建 |
| 凭据 | 完成 | Windows 凭据管理器（keyring，服务名 `data-workbench`） |
| 会话管理 | 完成 | 增删改查、只读标记、测试连接（含服务器版本）、连接/断开、状态指示、错误通知 |
| 适配层 | 完成 | DbAdapter trait + MySQL/PostgreSQL/SQLite（含 PG 多库连接池缓存、TLS 模式映射） |
| 元数据 | 完成 | 库列表、表/视图列表、表详情（列/主键/索引/外键；MySQL 含 SHOW CREATE TABLE，SQLite 含 sqlite_master DDL） |
| 前端 | 完成 | 会话列表（悬停操作、双击连接）、对象树（懒加载）、表结构详情（列/索引/外键/DDL 四区）、状态栏、Toast 通知 |
| 测试 | 部分 | CanonicalType 解析单元测试（MySQL/PG/SQLite） |

### M2（已完成）

| 模块 | 状态 | 实现说明 |
|---|---|---|
| 查询执行 | 完成 | 语句分类（Rows/Write/Ddl/Other）、包装分页（`SELECT * FROM (...) LIMIT n OFFSET m`）、三引擎动态解码为 `DbValue`、受影响行数、耗时统计 |
| 取消 | 部分 | MySQL `KILL QUERY`、PostgreSQL `pg_cancel_backend`；SQLite 暂不支持（返回明确提示） |
| 只读与危险拦截 | 完成 | 只读会话拦截写/DDL（`E_READONLY`）；DROP/TRUNCATE、无 WHERE 的 UPDATE/DELETE 返回 `E_DANGEROUS`，前端确认后 `force=true` 重试 |
| 查询历史 | 完成 | 每次执行写入本地 app.db（成功/失败、耗时、受影响行数），每会话保留 500 条；查询页签「历史」菜单一键回填 |
| 网格编辑 | 完成 | AG Grid 就地编辑、类型感知解析（int/float/decimal/bool/日期/JSON/bytes）、新增/删除行、变更集统计、空值语义（清空= NULL，自动增列不参与 INSERT） |
| 事务提交 | 完成 | 变更集生成参数化 SQL（预览时内联字面量渲染）、主键 + 旧值空安全等值并发校验、单事务执行 |
| 库表 DDL | 完成 | 建库/删库（MySQL/PG）、建表可视化、删表、加列/改列/删列；预览-确认-执行；SQLite 改列/删列走重建表流程（PRAGMA foreign_keys 关闭 + 建临时表 + 复制 + 重命名 + 重建索引） |
| 前端工作区 | 完成 | 页签系统（查询/表）、Monaco SQL 编辑器（Ctrl+Enter 执行、选中执行、离线打包）、结果分页导航、表工作区（数据/结构子页签）、对象树右键菜单 |
| 查询页签 | 完成 | 数据库切换、限制行数（200/页）、上/下一页、错误内联展示、危险操作确认弹窗、只读/无主键只读徽标 |

### M2.1 稳定性修复（已完成）

| 项 | 说明 |
|---|---|
| 大字段截断（服务端） | 表数据浏览按列类型生成 `LEFT(col, 8192)`（MySQL）/ `LEFT`/`substring`（PG）/ `substr`（SQLite），超长 TEXT/JSON/BLOB 不再整值传输 |
| 截断值模型 | `DbValue` 新增 `trunc` 标签（只读预览），前端以琥珀色斜体展示，该单元格禁止编辑，提交时后端再次拒绝（`E_INVALID`） |
| 查询超时 | 单条查询 60 秒超时，中断等待并返回明确错误；查询完成写入 INFO 日志（行数/耗时） |
| 错误边界 | 前端 `ErrorBoundary` 捕获渲染异常，展示错误信息与「重新加载」，不再整窗白屏 |
| 本地库连接池 | app.db 池增加 10 秒 acquire 超时，避免极端情况下命令排队 |
| 快速构建 | Cargo `release-fast` profile（无 LTO）+ `npm run app:build:fast`，用于日常迭代 |
| 修复无限渲染循环 | `useNotify` 每次渲染返回新对象并被放入 `useEffect` 依赖，导致表数据页无限重复加载（React #185，表现为持续加载/连接池占满）；改为 `useMemo` 稳定引用，并在数据加载处增加并发保护 |

### M2.2 反馈修复与体验调整（已完成）

| 项 | 说明 |
|---|---|
| MySQL 元数据类型/注释丢失 | information_schema 的 `COLUMN_TYPE` / `COLUMN_KEY` / `COLUMN_COMMENT` 等列可能以 BINARY/BLOB 返回，`String` 解码失败被静默吞掉；改为字节回退 + UTF-8 转换，类型/注释/主键/默认值全部恢复 |
| 弹窗透明度过高 | Fluent 弹窗/菜单/浮层统一覆盖为不透明背景（`.fui-DialogSurface` / `.fui-MenuPopover` 等），Mica 半透明只保留在应用主界面 |
| 会话文件夹 | 左侧会话栏支持文件夹分组：新建/删除文件夹（存储于 settings 表 `session_folders`）、折叠展开、会话归组（`session_set_group` 命令，不触发断开连接）；会话表单新增「分组」输入 |
| 会话栏底部菜单栏 | 新增底部工具栏：新建会话、新建文件夹、刷新 |
| 表工作区页签 | 索引、外键、DDL 从「结构」页内嵌区块升级为顶级页签：数据 / 结构 / 索引 / 外键 / DDL，各带数量徽标 |

### M2.3 体验细化（已完成）

| 项 | 说明 |
|---|---|
| 每会话页签组 | 顶部页签按活动会话过滤展示，切换会话自动激活该会话最近页签；页签条左侧显示会话名，表页签附数据库名小字 |
| SQLite 表详情修复 | `pragma_table_xinfo` 的 `"notnull"` 别名与 SQLite 保留字冲突导致语法错误，改为 `is_not_null` |
| 数据网格表头类型 | 数据/查询结果表头两行显示：列名 + 类型小字（自定义 `TypeHeader`） |
| 页签切换不重复加载 | 表工作区各子页签首次访问后保持挂载（display 切换），切换不再触发请求；数据由「刷新」按钮或提交后主动刷新 |
| 文件夹展开指示 | 会话文件夹右侧增加旋转箭头（`> / v`）显示展开状态 |
| 选项与系统设置 | 左侧栏新增「会话 / 选项」导航；系统设置支持界面配色：跟随系统 / 亮色 / 暗色（存储于 settings 表 `ui_theme`） |

### M2.4 观感与细节修复（已完成）

| 项 | 说明 |
|---|---|
| 暗色主题不完整 | 窗口 Mica 背景未随应用主题变化（暗色主题叠在亮色 Mica 上显得灰白）；现切换主题时同步调用 `window.setTheme`（系统模式下传 null 跟随系统），并提高暗色面板不透明度 |
| 网格/编辑器主题 | 网格与 Monaco 之前使用系统深浅判断，现统一为「设置项优先」的有效主题（`useIsDark` 重写） |
| 浏览器右键菜单 | 全局屏蔽 WebView2 默认右键菜单，输入框 / textarea / Monaco 编辑器内保留原生菜单 |
| 交互动画 | 工作区与子页签切换加入非线性淡入位移动画（170ms cubic-bezier），页签/会话行/文件夹/树节点补充 120–140ms 过渡 |
| 悬停位移 | 会话行与文件夹 hover 操作区由 `display` 切换改为常驻占位 + 透明度渐显，消除悬停时元素位移 |

### M2.5 交互增强（已完成）

| 项 | 说明 |
|---|---|
| 界面色彩点缀 | 会话行左侧按引擎着色竖条（活动时高亮）、对象树图标面色（库=品牌蓝 / 表=绿 / 视图=紫）、活动页签品牌色底边、表工作区标题前引擎色圆点、数据网格增加品牌强调色与斑马纹 |
| 右侧内容缩放 | 主工作区支持缩放 60%–200%：Ctrl + / - / 0 快捷键、Ctrl+滚轮、选项页滑块；缩放值持久化（`ui_zoom`）。实现采用 `transform: scale()` + 尺寸补偿（`width/height = 100/zoom%`），避免 CSS `zoom` 在新版 Chromium 下的布局错位 |
| 页签行数设置 | 选项页可设置页签最多显示行数（1–4 行，`ui_tab_rows`），多行时自动换行、超出滚动 |
| 可拖动分栏 | 会话栏宽度（180–420px）与对象浏览器宽度（200–480px）支持拖拽分隔条调整，宽度持久化（`ui_sidebar_width` / `ui_explorer_width`） |

### M2.6 强调色配置（已完成）

| 项 | 说明 |
|---|---|
| 强调色设置 | 选项页新增强调色选择：跟随系统（读取 Windows 系统强调色，注册表 `DWM\AccentColor` / `ColorizationColor`，命令 `system_accent_color`）或 8 种预设色；持久化 `ui_accent` |
| 主题生成 | 由单一强调色经 HSL 色阶生成 Fluent 品牌 16 级色板（`brandVariantsFromHex`），动态构建亮/暗主题（`createLightTheme` / `createDarkTheme`），按钮、页签底边、选中态等全部跟随 |
| 全局点缀 | 标题栏 Logo 渐变、分隔条悬停、数据网格强调色与斑马纹均跟随强调色（CSS 变量 `--dw-accent` / AG Grid `accentColor`） |

### M2.7 单栏布局（已完成）

| 项 | 说明 |
|---|---|
| 单栏上下分区 | 会话列表与对象浏览器合并为左侧单栏，上下两段，中间垂直分隔条可拖动（比例持久化 `ui_sidebar_split`，0.2–0.8） |
| 侧栏收起 | 一键收起（标题行按钮 / Ctrl+B），收起后保留 22px 展开导轨；状态持久化 `ui_sidebar_collapsed` |
| 宽度调整 | 侧栏宽度 200–460px（默认 300），拖拽调整并持久化 `ui_sidebar_width` |
| 右侧空间 | 相比三栏布局释放约 280px 给工作区；「选项」页签时侧栏整体用于设置 |

### M2.8 设置独立页面（已完成）

| 项 | 说明 |
|---|---|
| 设置页签 | 「选项」从侧栏移除，改为工作区页签（`SettingsWorkspace`），点击侧栏齿轮按钮或 Ctrl+, 打开；页签可关闭、始终可见、切换会话不受影响 |
| 分类导航 | 左侧分类 + 右侧表单：外观（配色/强调色）、布局与缩放（缩放/页签行数/侧栏宽度/上下比例）；编辑器、数据网格、同步、快捷键、高级为占位分类，供后续扩展 |
| 侧栏简化 | 侧栏顶部改为「会话」标题 + 设置/收起按钮，会话与对象浏览器分区不变 |

### M2.9 数据网格紧凑化（已完成）

| 项 | 说明 |
|---|---|
| 紧凑密度 | 网格字号 12px、行高 28px、表头 38px、水平内边距 8px（AG Grid Theming 参数统一配置） |
| 统一列宽 | 所有列默认 110px 等宽，最小宽度放宽至 40px（原 120px），支持拖拽调整，单位宽度内容展示更紧凑 |
| 表头两行 | 列名 12px + 类型 9px 小字，表头高度压缩到 38px |

### M2.10 数据网格排序（已完成）

| 项 | 说明 |
|---|---|
| 服务端排序 | 数据页点击表头按列排序：生成 `ORDER BY <列> ASC/DESC` 重新查询（非仅当前页排序）；支持 Shift 多列排序（按点击顺序生成多列 ORDER BY） |
| 排序指示 | 自定义表头显示升/降序箭头；翻页延续排序 |
| 安全约束 | 存在未提交修改时表头不可排序（避免丢失编辑）；排序变化自动回到第 1 页；请求竞态用请求序号丢弃过期结果 |
| 查询结果网格 | 保持前端排序（仅当前页），属预期行为 |

### M2.11 排序修复与查询结果排序（已完成）

| 项 | 说明 |
|---|---|
| 表头点击排序修复 | AG Grid 使用自定义表头时会替换内置点击逻辑，导致点击无效；现由 `TypeHeader` 自行调用 `progressSort`（支持 Shift 多列），排序箭头由父级 `sortSpecs` 状态驱动，避免自定义表头不刷新的问题 |
| 查询结果服务端排序 | `query_execute` / `query_fetch_page` 新增 `sort` 参数，后端在包装分页时生成 `ORDER BY`（标识符按方言引用）；SQL 页签点击结果表头即重新查询，翻页延续排序；修改 SQL 重新执行时清空排序 |
| 参数 | `SortSpec { column, dir }`，dir 仅接受 asc/desc，列名进入 ORDER BY 前统一引用，无注入风险 |

### M2.12 排序正确性与加载反馈（已完成）

| 项 | 说明 |
|---|---|
| 排序被前端覆盖 | AG Grid 在网络数据到达后会再次执行客户端排序（按字符串比较）覆盖服务端顺序；服务端排序启用时为列设置 `comparator: () => 0`（保持原顺序），显示顺序完全由数据库 ORDER BY 决定 |
| 数据页排序参数化 | 数据页不再把 ORDER BY 拼进子查询（MySQL 派生表可能忽略），统一通过 `sort` 参数由后端在包装分页外层生成 ORDER BY |
| 刷新按钮闪烁 | 加载状态切换导致刷新按钮图标在箭头/加载圈间闪烁；按钮图标固定，加载中改为状态栏显示「加载中…」小指示 |

### M2.13 排序体验修复（已完成）

| 项 | 说明 |
|---|---|
| 排序后列宽丢失 | 之前排序会重建列定义导致手动调整的列宽重置；现列定义与排序状态解耦，排序变化仅调用 `api.refreshHeader()` 刷新表头箭头，列宽保持不变 |
| 刷新按钮闪烁 | 加载状态切换按钮 `disabled` 造成视觉闪烁；去掉禁用态与图标切换，加载中仅由状态栏「加载中…」指示 |

### M2.14 列宽保持（已完成）

| 项 | 说明 |
|---|---|
| 根因 | `valueSetter` 的依赖链包含 `computeChanges`（依赖行数据），数据一变化就重建列定义，AG Grid 随之重置列宽 |
| 修复 | 用 ref 持有 `computeChanges` / `onPendingChange` 最新实现，`valueSetter` 仅依赖列定义；`defaultColDef` 与 `rowSelection` 也做 memo 化，确保排序/翻页/刷新时列定义身份稳定 |

### M2.15 对象浏览器滚动修复（已完成）

| 项 | 说明 |
|---|---|
| 根因 | 对象浏览器面板未约束高度（`flexShrink: 0` + 内容自适应），树容器 `overflow: auto` 失效，内容被裁切且无滚动条 |
| 修复 | 面板改为 `flex: 1, minHeight: 0`，树容器补 `minHeight: 0`；侧栏与下区增加 `overflow: hidden`，保证滚动发生在树容器内部 |

### M2.16 表信息页签（已完成）

| 项 | 说明 |
|---|---|
| 信息页签 | 表工作区新增「信息」标签页（数据/结构/索引/外键/DDL/信息），展示表基础信息并支持单独刷新 |
| 展示内容 | 基本（名称/库/Schema/类型/注释/行数估算）、结构（列/索引/外键数量、主键、自增列与下一个值）、存储（引擎/字符集/排序规则）、时间（创建/更新时间） |
| 数据来源 | 新增 `meta_table_info` 命令：复用 `introspect_table`，并新增适配器方法 `table_extra_info`（默认空实现）；MySQL 读取 `information_schema.TABLES`（ENGINE/TABLE_COLLATION/AUTO_INCREMENT/CREATE_TIME/UPDATE_TIME），PostgreSQL 通过 `pg_get_serial_sequence` + 序列 `last_value` 取自增值，SQLite 读取 `sqlite_sequence` |

### M2.17 页签菜单与细节修正（已完成）

| 项 | 说明 |
|---|---|
| 页签右键菜单 | 置顶/取消置顶（仅表页签）、关闭、关闭其它（保留置顶与其他会话页签）、关闭所有（置顶除外，仅当前会话） |
| 置顶持久化 | 置顶表页签按会话存储（settings `pinned_tabs_<sessionId>`），置顶页签排在最前并显示置顶图标；会话连接时自动恢复（重新打开置顶表） |
| 信息页签前置 | 表工作区页签顺序调整为：信息 / 数据 / 结构 / 索引 / 外键 / DDL（默认仍打开数据页） |
| 结构类型去重 | 结构页「类型」列去掉重复的规范化类型小字，只显示数据库原始类型 |
| 页签与分节图标 | 表工作区页签配主题图标（信息 Info / 数据 Grid / 结构 ColumnTriple / 索引 ArrowSort / 外键 Link / DDL Code）；信息页分节（基本/结构/存储/时间）与索引/外键/DDL 面板标题同样加图标 |

### M2.18 测试连接反馈修复（已完成）

| 项 | 说明 |
|---|---|
| 长错误信息撑破弹窗 | 测试连接结果原先为单行省略号且不换行，长错误（如 Access denied）会把弹窗撑宽/重叠；现结果独立成行、自动换行、最高 54px 可滚动，按钮行保持在下方 |

### M2.19 未连接会话页签隐藏（已完成）

| 项 | 说明 |
|---|---|
| 规则 | 页签条与工作区仅显示「当前活动且已连接」会话的页签（设置页签始终显示）；未连接/已断开会话的页签隐藏但保留在内存，重连后恢复 |
| 联动 | 断开连接时自动取消其活动页签；主区域显示「该会话尚未连接，连接后将显示其页签」提示 |

### M2.20 表大小展示与双击编辑（已完成）

| 项 | 说明 |
|---|---|
| 树中表大小 | 对象浏览器表名右侧显示磁盘大小（MySQL：DATA_LENGTH+INDEX_LENGTH；PostgreSQL：pg_total_relation_size；SQLite 暂无逐表大小）；悬停提示显示引擎、行数估算、大小与注释（`TableRef` 增加 sizeBytes/engine） |
| 信息页磁盘大小 | 「存储」分节新增磁盘大小：总量 / 数据 / 索引（按引擎可用性展示） |
| 双击编辑 | 数据网格取消单击进入编辑（移除 `singleClickEdit`），改为双击编辑，避免误操作，单击仍用于选中 |

### M2.21 已打开表标识（已完成）

| 项 | 说明 |
|---|---|
| 树中区分已打开表 | 对象浏览器中已打开（存在页签）的表/视图使用实心图标（TableFilled / EyeFilled），未打开使用线框图标（TableRegular / EyeRegular）；悬停提示追加「已打开」 |

### M2.22 PostgreSQL 适配（已完成）

| 项 | 说明 |
|---|---|
| 参数类型转换 | PG 参数类型严格：网格写入时对文本类值（文本/日期/时间/JSON/UUID/枚举/数组）按目标列类型生成显式转换（如 `$1::timestamp with time zone`、`$4::jsonb`、`$1::text[]`），列类型来自内省结果；MySQL/SQLite 不受影响 |
| 数组解码 | PG 数组列（类型名 `TEXT[]` / `_TEXT`）解码为 JSON 文本展示，避免显示为 NULL |
| 改列优化 | PG `ALTER COLUMN ... TYPE` 仅在类型确有变化时执行（类型名归一化比较），避免无谓全表重建 |
| 未知类型保留 | 列编辑对话框对枚举/数组/自定义类型保留原始类型文本（不再回退 varchar），改列不会误转类型 |
| 集成验证 | 使用本地 PostgreSQL 18（Docker 容器）完成端到端验证：连接/版本、库表列表（含大小与引擎 heap）、内省、分页查询（时间/JSON/数组/UUID 解码）、参数化插入/更新/删除（含转换）、建表删表 |

### M2.23 PG DDL 生成与信息页引擎适配（已完成）

| 项 | 说明 |
|---|---|
| PG DDL 生成 | PostgreSQL 无 SHOW CREATE 等价物，改为由统一元数据在前端重建 DDL（`generateDdl`）：CREATE TABLE（列/类型/非空/默认/自增、主键、外键）+ 索引语句 + COMMENT ON TABLE/COLUMN；其他引擎缺少原始 DDL 时同样回退生成；PG 视图无法重建时给出说明 |
| 信息页引擎适配 | 按引擎能力隐藏不适用的字段，避免「—」误导：PostgreSQL 隐藏引擎/字符集/排序规则/时间；SQLite 隐藏注释/行数估算/字符集/排序规则/时间；存储分节仅在存在可用字段时显示 |

### M2.24 复制粘贴（已完成）

| 项 | 说明 |
|---|---|
| 剪贴板命令 | 新增 `clipboard_read_text` / `clipboard_write_text`（Rust arboard，读写系统剪贴板） |
| 数据网格 | Ctrl+C 复制选中行/焦点行（TSV，可直接粘贴进 Excel）、Ctrl+V 从当前焦点单元格粘贴（支持多行多列、自动跳过主键/截断/不可编辑单元格）、右键菜单（复制单元格/复制选中行/粘贴/设为 NULL）、工具栏「复制 / 粘贴」按钮 |
| 查询结果 | Ctrl+C 与右键菜单复制（只读）、工具栏「复制」按钮 |
| 待提交语义 | 粘贴写入变更集但不落库，仍需「提交」确认，避免误操作 |

### M2.25 可视化筛选（已完成）

| 项 | 说明 |
|---|---|
| WHERE 生成 | 后端 `build_filter_clause`：列名按方言引用，值按类型安全转义（数字裸值、布尔、字符串转义），支持操作符：等于/不等于/大于/≥/小于/≤/包含/开头/结尾/为空/不为空/IN/BETWEEN |
| 筛选面板 | 数据页工具栏「筛选」弹出面板：多条件 + 全部/任一（AND/OR）+ 添加/删除/清空；应用后重新查询并显示条件数与「清除筛选」 |
| 安全约束 | 有未提交修改时禁止应用/清空筛选；筛选条件作用于表格查询与导出 |

### M2.26 导入导出（已完成）

| 项 | 说明 |
|---|---|
| 导出 | 数据页与查询结果支持导出 CSV / JSON / Excel(.xlsx)，范围可选「全部数据」（后端分批 5000 行流式写入）或「当前页」；CSV 可含表头；完成后可一键打开所在文件夹（`revealItemInDir`） |
| 导入 | CSV 导入对话框：文件选择、分隔符（, ; Tab \|）、编码（UTF-8 / GBK）、首行表头、空串转 NULL、按列自动映射（可手动调整/忽略）、前 5 行预览、分批事务写入（默认 500 行/批），结果展示成功/跳过/错误 |
| 值处理 | 导出 JSON 保留类型（数字/布尔/ null），CSV/Excel 使用文本；导入统一以文本绑定并按目标列类型转换（复用 PG 类型转换逻辑） |
| 筛选面板样式 | 弹层加宽至 640px；列/操作符/连接词下拉列表限高 260px 可滚动；列名显示「列名（注释）」格式，注释括号包裹且超长截断（悬停显示完整文本）；值输入框获得更多空间 |
| 筛选布局修复 | 条件行改为固定轨道（190/150/弹性/32px）+ 溢出裁剪，下拉与输入框统一 `min-width: 0`，修复控件超出轨道导致的视觉重叠 |
| 下拉弹层修复 | `listbox` 样式改为正确的 `style` 嵌套（此前写错层级导致限高失效，超长列表使 Fluent 自动改为右侧弹出）；三个下拉统一指定 `positioning: below/start`，弹层限高 260px 且宽度 220–420px |
| 列选择可搜索 | 列选择改为 Combobox：支持输入模糊匹配（列名或注释，不区分大小写），下拉最多约 10 项（全局样式 `.dw-listbox-compact` 以 `!important` 覆盖 Fluent 自动尺寸），无匹配时提示「无匹配列」 |
| 筛选弹层定位 | Popover 默认优先向上弹出，清空条件后内容变矮会跳到上方；现固定 `positioning: below/start`，始终向下弹出 |
| 验证 | PostgreSQL 容器端到端验证：CSV/JSON/XLSX 导出内容、预览解析、列映射导入（含中文与含逗号字段）均通过 |

### M2.27 文本渲染长度限制（已完成）

| 项 | 说明 |
|---|---|
| 统一预览上限 | 所有文本类值（VARCHAR/TEXT/JSON 等）后端预览上限从 8192 收紧到 **1024 字符**，超出即标记为 `trunc` 只读值，IPC 负载与 DOM 渲染量同步下降 |
| 表数据浏览下推 | 表数据查询对「无界文本或声明长度 > 1024」的列生成 `LEFT(col, 1025)`（PG `substring`/`substr` 同理），避免整值从数据库传出；多取 1 字符确保能被识别为截断 |
| 编辑保护 | 截断单元格保持只读（琥珀色斜体提示），不会因编辑写回残缺内容；真实长度 ≤1024 的文本仍可正常编辑 |

### M2.28 会话列表紧凑化与折叠记忆（已完成）

| 项 | 说明 |
|---|---|
| 紧凑布局 | 会话行内边距 7/8 → 4/6、图标 18 → 16、引擎色条高度 26 → 22、文件夹头内边距与间距收紧、名称行高 17px、状态点 7px、底部工具栏内边距收紧 |
| 折叠状态记忆 | 文件夹展开/收起状态写入设置 `ui_collapsed_folders`（JSON 数组），启动时恢复，不再每次全部展开 |

### M2.29 页签数量上限与设置独立页（已完成）

| 项 | 说明 |
|---|---|
| 页签数量上限 | 移除「页签行数」设置，改为「页签最多数量」（默认 20，可选 10/20/30/50/不限，设置 `ui_max_tabs`）；超过上限自动关闭最早打开的未置顶页签（按会话分别计数，置顶页签不参与计数）；页签条恢复为单行横向滚动 |
| 设置独立页 | 设置不再是工作区页签：齿轮按钮 / Ctrl+, 打开独立设置页（带「返回」按钮），期间工作区保持挂载（查询内容不丢失）；从设置页打开新表/查询时自动返回工作区；移除 `SettingsTab` 类型与 `openSettings` 动作 |

### M2.30 结构页行内编辑与列操作菜单（已完成）

| 项 | 说明 |
|---|---|
| 紧凑表格 | 结构表改为 `extra-small` 密度，页面内边距收紧 |
| 行内添加列 | 「添加列」不再弹窗：在列表末尾（或右键指定位置）追加一行内联编辑行，含列名、类型下拉（TYPE_OPTIONS）、长度、可空、默认值与确认/取消 |
| 行右键菜单 | 修改（打开列编辑对话框）、在上方添加、在下方添加、向上移动、向下移动、移除 |
| 位置支持 | `DdlSpec::AddColumn` 增加 `position`（first/after）：MySQL 生成 `ADD COLUMN ... FIRST/AFTER`；`DdlSpec::MoveColumn` 新增：MySQL 用 `MODIFY COLUMN ... AFTER/FIRST`，SQLite 走重建表重排，PostgreSQL 不支持列顺序（菜单项禁用并提示）；PG/SQLite 添加列时提示「只能追加到末尾」 |

### M2.31 右键菜单定位修复（已完成）

| 项 | 说明 |
|---|---|
| 根因 | 主工作区使用 `transform: scale(zoom)` 实现界面缩放，`position: fixed` 在 transform 祖先内以该元素为包含块，鼠标视口坐标与容器坐标不一致，缩放后菜单偏移（缩放越小偏移越大） |
| 修复 | 新增 `ContextMenuPortal`，所有自定义右键菜单（对象树、页签、数据网格、查询结果、结构列行）统一 Portal 到 FluentProvider 内的 `#dw-overlay-root` 容器：既脱离缩放容器保证坐标准确，又保留主题 CSS 变量 |

### M2.32 列编辑弹窗类型参数适配（已完成）

| 项 | 说明 |
|---|---|
| 布局修复 | 类型与参数改为两行显示：第一行「类型」独占整行，第二行按类型显示参数（decimal → 精度 + 小数位 两列；varchar/char → 长度；datetime/timestamp/time → 小数秒精度），彻底避免三列挤压导致输入框溢出 |
| 类型参数 | decimal → 精度+小数位；varchar/char → 长度；datetime/timestamp/time → 小数秒精度（MySQL `DATETIME(p)`、PG `TIMESTAMP(p)`）；其余类型单列显示并占位对齐 |
| 反显 | 编辑列时从元数据回填：decimal 的 precision/scale、字符串长度、时间精度，`TIMESTAMPTZ` 自动对应 timestamp 类型 |

### M2.33 列表斑马纹（已完成）

| 项 | 说明 |
|---|---|
| 全局列表斑马纹 | Fluent 表格（结构 / 索引 / 外键 / 导入预览等）统一添加隔行底色与悬停高亮，颜色使用强调色低透明度混合（`color-mix` + `--dw-accent`），亮暗主题自动适配 |
| 实现 | 全局样式作用于 `.fui-TableBody .fui-TableRow`，无需逐组件改动；行内添加列的高亮行不参与条纹 |

### M3.1 同步引擎（结构 + 数据，已完成）

| 项 | 说明 |
|---|---|
| 服务层 | `services/sync.rs`：端点连接校验（同引擎、不可同库）、结构对比、脚本生成与执行、数据对比与执行 |
| 结构对比 | 表级（仅源/仅目标/有差异/一致）；列级（类型/可空/默认值/自增/注释，自动跳过双方自增列的默认值差异）；索引与外键按名称匹配比较定义 |
| 结构脚本 | 建缺失表（PG 自增列转 IDENTITY，避免引用源库序列）、删多余表（可选）、加列、改列（MySQL `MODIFY`、PG `TYPE/SET DEFAULT/ADD IDENTITY`、SQLite 提示手工重建）、删多余列（可选，危险）、建索引、加外键 |
| 数据对比 | 按主键有序合并扫描（键集分页，块 1000 行）；统计待插入/待更新/待删除；无主键表跳过并提示；行比较使用完整值序列化对比 |
| 数据同步 | 批量事务写入（默认 500 行/批，可调），插入/更新/删除选项独立（删除默认关）；含截断字段的行跳过并记录，避免写入不完整数据；连续出错策略可选 |
| 前端 | 侧栏入口「数据同步」独立页面（三步向导）：① 选择源/目标（已连接会话 + 库，引擎不一致拦截）② 勾选对象表 ③ 对比结果 + 选项 + 预览脚本 / 执行结构 / 执行数据 + 执行日志；危险选项触发确认勾选 |
| 验证 | 本地 PostgreSQL 18 容器端到端：结构差异（类型/加列/删列/索引）→ 执行 7 条语句 → 复检全部一致；数据 3 行场景（+1 插入、2 更新、1 删除）执行后复检为 0，重复同步幂等 |
| 已知偏差 | v0.81 已补数据同步回滚材料，结构同步仍无完整快照回滚；SQLite 的改列/删列/外键同步需手工重建（给出提示）；索引/外键同步的删除与修改暂不执行；跨引擎同步按 ADR-003 暂不支持 |

### M3.2 高频短板补齐（已完成）

| 项 | 说明 |
|---|---|
| 执行计划 | 查询页签新增「执行计划」按钮：MySQL/PG `EXPLAIN`、SQLite `EXPLAIN QUERY PLAN`，结果以网格弹窗展示（命令 `query_explain`） |
| 大字段查看/编辑 | 数据网格右键「查看/编辑完整值」：按主键取完整值（不做 1024 字符截断，命令 `cell_full_value`），可复制；可编辑表支持直接保存（命令 `update_cell`，带完整旧值的并发校验，`UPDATE ... WHERE pk = ? AND col IS NOT DISTINCT FROM old`）；编辑框固定 16 行高、内部高度 100% 自适应，避免内容被小框截断 |
| 索引编辑 | 索引页签支持新建索引（名称/唯一/多选列，预览后执行）、**编辑索引**（改名/改列/改唯一，等价于 DROP + CREATE 两条语句）、删除索引（主键索引不可删）；SQLite 也支持 CREATE/DROP INDEX |
| 外键编辑 | 外键页签支持添加外键、**编辑外键**（等价于 DROP + ADD）、删除外键；SQLite 不支持 ALTER 外键（按钮隐藏并提示重建表） |
| 后端 | `DdlSpec` 新增 `CreateIndex / DropIndex / AddForeignKey / DropForeignKey` 方言渲染（MySQL `DROP FOREIGN KEY`、PG `DROP CONSTRAINT`/`DROP INDEX schema.name`） |

### R1 Redis 连接管理与概览（已完成）

| 模块 | 状态 | 实现说明 |
|---|---|---|
| 引擎族与适配层 | 完成 | `Engine::Redis` + `is_sql()`；`KeyValueAdapter` trait（`ping / server_info / list_databases / command`）；`RedisAdapter` 同时实现 `DbAdapter`（SQL 方法返回不支持）与 `KeyValueAdapter`，复用会话连接流程 |
| 连接管理 | 完成 | 会话新增 `redisDb` / `tls` 列（本地库自动迁移旧数据）；URL 拼装（percent-encode 特殊字符，TLS 用 `rediss://`）；每逻辑库一个 `ConnectionManager`，支持 ACL 用户名/密码、密码留空 |
| 服务器信息 | 完成 | `INFO` 解析为分节 `InfoEntry`；`CONFIG GET databases`（回退 16）+ `DBSIZE` 得到各库键数（`RedisDatabaseInfo`） |
| 会话表单 | 完成 | 引擎下拉新增 Redis（品牌色 #dc382d、默认端口 6379）；Redis 专属「逻辑库（0-15）」「使用 TLS」；隐藏默认数据库/SSL 模式字段；测试连接与只读模式沿用 |
| 对象浏览器 | 完成 | Redis 会话下逻辑库为叶子节点（显示「N 个键」），点击打开该库的键浏览页签（同一会话每个库一个独立页签，重复点击聚焦已有页签） |
| Redis 概览页签 | 完成 | 服务器卡片（版本/模式/运行时间/客户端连接/内存/最大内存/总连接数/缓存命中率）+ INFO 分节：分节标题中文化（附英文原名与项数）、可折叠（统计/错误/延迟类默认折叠）与「展开全部/折叠全部」，行内键名中文化（约 190 个常用键 + `dbN`/`cmdstat_*`/`errorstat_*`/`listenerN` 规则），紧凑网格（250px 列、18px 行高）+ 大数字千分位；逻辑库列表已移除（切换在「键浏览」工具栏） |
| 集成影响 | 完成 | 同步向导端点仅列出 SQL 会话（Redis 不参与同步）；状态栏不显示库表路径；页签图标/颜色与现有体系一致 |
| 验证 | 完成 | `cargo check` + 前端 `tsc` + 应用启动冒烟通过；本地 Redis 8.10.1 实例端到端验证：连接/`PING`、`INFO` 解析（版本 8.10.1 分节键值）、`CONFIG GET databases` → 16 库、`DBSIZE` 键数、`GET` 命令返回值、SQL 操作正确拒绝 |
| 后续实现 | R1 是早期连接与概览里程碑 | 键浏览/值编辑已在 R2/R3 实现，v0.81 已增加命令控制台，v0.83 增加成员继续加载；Redis 导入导出仍待补 |

### R2 Redis 键浏览（已完成）

| 模块 | 状态 | 实现说明 |
|---|---|---|
| SCAN 分页 | 完成 | `scan_page`（`SCAN MATCH [TYPE] COUNT`，禁用 KEYS）返回 `{ cursor, keys }`；前端游标追加式「继续扫描」，空页自动续扫（≤20 轮） |
| 键摘要 | 完成 | 每页 `TYPE/PTTL/MEMORY USAGE` 命令管道；`RedisKeyInfo { key, kind, ttlMs, size }`；类型过滤走服务端 `SCAN ... TYPE` |
| 键预览 | 完成 | `key_preview` 按类型取前 100 项（string GETRANGE、list LRANGE、set SSCAN、zset ZRANGE WITHSCORES、hash HSCAN、stream XRANGE），含长度/截断/编码/内存；非 UTF-8 值十六进制展示 |
| 键浏览页签 | 完成 | Redis 页签子导航「键浏览 / 服务器概览」；三栏布局（前缀树 / 键表格 / 预览面板），两侧分隔条可拖拽调宽并持久化（`ui_redis_tree_width` / `ui_redis_preview_width`）；工具栏含当前库徽标、搜索模式、类型过滤、刷新、继续扫描（逻辑库切换移至对象浏览器，每个库独立页签） |
| 前缀树 | 完成 | 按 `:` 分段生成树（当前已加载键内计数），紧凑行高（22px）与缩进，**子级带缩进引导线**（每级 12px 竖线，层级更直观），无下级前缀的节点使用「多钥匙堆叠」图标（有下级的用文件夹图标），点击节点本地筛选该前缀（不触发重扫、不覆盖搜索框，树保持完整）；展开/折叠由箭头控制，再次点击「全部键」清除筛选 |
| 键表格 | 完成 | 键名（等宽）/ 类型徽标（按类型着色）/ TTL（毫秒→天可读化）/ 内存（MEMORY USAGE）；紧凑行样式（行高 22px、11px 字号）；**客户端本地排序**（点击 键名 / TTL / 内存 表头切换升降序，仅对已加载数据排序，不改变服务端 SCAN 查询）；**复选列批量选择**（表头全选/半选，选中项随扫描结果自动修剪），工具栏出现「已选 N 个键 / 清除选择 / 批量删除」，批量删除走 `redis_delete_keys`（分块 DEL），右键菜单在选中多键时显示「删除选中的 N 个键」 |
| 概览联动 | 完成 | 概览页逻辑库表新增「浏览键」入口，切换子页签并定位到该库 |
| 验证 | 完成 | 本地 Redis 8.10.1：SCAN 循环（COUNT=2）收集 8 键、TTL 识别、TYPE 过滤、六类型 + 二进制预览、截断与缺失键错误全部通过；`cargo check` / `tsc` / 应用启动冒烟通过 |

### R3 Redis 值编辑与键管理（已完成）

| 模块 | 状态 | 实现说明 |
|---|---|---|
| 编辑操作 | 完成 | `RedisEditOp` 六类型操作模型；String 用 `SET ... KEEPTTL` 保留 TTL；List `LPUSH/RPUSH/LSET/LREM`；Set `SADD/SREM`；ZSet `ZADD/ZREM`；Hash `HSET/HDEL`；Stream `XADD` |
| 键管理 | 完成 | 新建键（`EXISTS` 校验 + 类型化首个值，类型选择对话框）、重命名（`RENAMENX`，目标存在拒绝）、TTL（PEXPIRE / PERSIST，单位换算）、删除（确认对话框） |
| 只读保护 | 完成 | 所有写命令校验会话 `read_only`，返回 `E_READONLY` |
| 编辑面板 | 完成 | 右侧面板升级为编辑器：头部操作（重命名/TTL/复制/刷新/删除）+ 按类型编辑（String 多行、List 头尾插入与行内改写/删除、Set/ZSet 增删与分值编辑、Hash 字段设置/删除、Stream 按行追加）；写入后自动重载预览并静默刷新键列表（保留前缀与选中态） |
| 文本格式适配 | 完成 | String 使用 Monaco 编辑器（与 SQL 编辑器同源、离线打包）渲染，按内容自动切换语言：严格 JSON → `json`、XML → `xml`、类 JSON（键未加引号等）→ `javascript` 高亮、其余 → `plaintext`；自动格式化展示（`detectTextFormat` + `prettifyJson`/`prettifyXml`），提供「格式化」「压缩（JSON）」与解析错误提示；编辑面板对 String 拉取完整值（截断时按 1 MB 上限重取，超限提示并禁用保存） |
| 右键菜单 | 完成 | 键列表右键：查看/编辑、复制键名、重命名、设置 TTL、刷新列表、删除（Portal 到浮层容器，与编辑面板共用对话框）；编辑面板头部按钮改为触发同一套对话框 |
| 验证 | 完成 | 本地 Redis 8.10.1：创建/重复创建拒绝、SET KEEPTTL 保留 TTL、LPUSH/RPUSH/LSET/LREM（越界报错）、SADD/SREM、ZADD 更新分值/ZREM、HSET/HDEL、XADD、RENAMENX（目标存在拒绝）、PERSIST/EXPIRE、DEL 计数全部通过；`cargo check` / `tsc` / 应用启动冒烟通过 |
| 已知偏差 | — | 批量删除/导入导出在 R5；Stream 条目编辑（XDEL/字段修改）暂未提供；键类型创建后不可变更（Redis 语义） |

### R2.5 右键菜单与信息对话框（已完成）

| 模块 | 状态 | 实现说明 |
|---|---|---|
| 会话右键菜单 | 完成 | 会话行移除「…」按钮，改为右键菜单：连接/断开、编辑会话、服务器信息（未连接时自动连接）、删除会话 |
| 服务器信息 | 完成 | 新增 `meta_server_info`：MySQL（版本/主机名/端口/字符集/排序规则/最大连接数 + Uptime/连接数/查询数等状态）、PostgreSQL（版本/主机/端口/最大连接数/连接数/运行时间/数据库大小）、SQLite（版本/文件路径/页统计）；Redis 会话复用 `INFO` 并按中文分节显示 |
| 数据库信息 | 完成 | 新增 `meta_database_info`：MySQL（字符集/排序规则/表数量/估算行数/数据与索引大小）、PostgreSQL（编码/排序规则/字符分类/大小/表数量/表数据总量）、SQLite（文件/页统计/表·视图·索引数量） |
| 对象树菜单 | 完成 | 数据库菜单新增「数据库信息」；数据表菜单新增「表信息」（直接打开信息页）；Redis 逻辑库新增右键菜单（浏览键、刷新逻辑库、复制库名） |
| 信息对话框 | 完成 | 通用 `InfoDialog`（分节键值、紧凑网格、值省略+悬停完整、限高滚动），供会话与对象树共用 |

### M2.34 可选界面风格（已完成）

| 项 | 说明 |
|---|---|
| 设置入口 | 外观新增三张风格预览卡片，选中勾选、键盘焦点、自动保存；沿用 SQLite settings 存储 |
| 表数据视觉 | 流光层次增加渐变标题卡片、工具栏容器与网格阴影；专业工作台增加列分隔和等宽数据；增强风格以颜色区分数值/日期/文档/文本类型标签，保留原始类型文字 |
| 主题兼容 | Fluent 根节点标记当前风格与实际深浅模式，AG Grid 主题同步响应强调色和风格；SQL 引擎共用，非 MySQL 独占 |
| 验证 | `npm run build` 与 `npm run app:build:fast` 通过，已生成免安装可执行文件；本次浏览器视觉检查被自动审批服务容量错误阻止，桌面实机视觉验收待补 |
| 已知边界 | 本次调整主侧栏、表工作区和 SQL 网格；Redis 专属编辑器布局保持现有实现 |

### M2.35 右键菜单边界适配与图标补齐（已完成）

| 项 | 说明 |
|---|---|
| 边界定位 | 新增共享 `ContextMenuSurface`，挂载后测量菜单实际尺寸，底部/右侧空间不足时向上/向左展开，并保留 8px 窗口边距；菜单超过可视区域时限宽限高并内部滚动 |
| 动态适配 | 保留 Portal 脱离 transform 缩放容器的机制；通过 ResizeObserver 与窗口/visualViewport 变化重新计算位置，兼容内容变化、窗口调整与缩放 |
| 覆盖范围 | 对象浏览器、会话、页签、表结构、可编辑网格、查询结果网格、Redis 键列表共七处自定义右键菜单 |
| 图标 | 补齐打开数据/结构、删除数据库/表、关闭其它/所有页签及查询历史图标；置顶/取消置顶使用不同图标；共 45 个 MenuItem 均有图标 |
| 验证 | `node scripts/check-context-menus.cjs`：7 个定位场景及全部菜单项图标检查通过；前端与快速可执行文件构建通过；浏览器视觉检查被自动审批服务容量错误阻止，桌面截图验收待补 |

### R2.6 Redis 键列表窄宽度适配（已完成）

| 项 | 说明 |
|---|---|
| 原因 | 三栏两侧宽度固定，中间表格可被压缩到极窄；键名允许 break-all 换行，导致长键逐字排列并撑高行 |
| 修复 | 表格固定列布局，最小总宽 556px（复选 36 + 键名至少 240 + 类型 80 + TTL 110 + 内存 90）；表头和单元格不换行，键名单行省略，悬停显示完整键名 |
| 窄窗口策略 | 中间面板最小宽 280px，表格溢出时面板内横向滚动；三栏总宽超过窗口时整体可横向滚动，保留原有两侧宽度设置，避免挤没键列表 |
| 验证 | 前端 TypeScript/Vite 构建通过；实际缩放比例的桌面视觉验收待补 |

### R3.1 Redis 键详情面板重设计（已完成）

| 项 | 说明 |
|---|---|
| 信息层级 | 右侧改为「键详情标题与类型 → 单行键名 → 独立操作栏 → 两列属性卡片 → 内容区」；长键名省略，悬停可看全文，保留复制键名入口 |
| 属性与操作 | 过期时间、内存占用、值长度/元素数量、内部编码以标签与数值分组展示，替代密集描边徽标；重命名/过期时间有文字按钮，复制/刷新/删除有无障碍名称，删除以红色区分 |
| String 编辑 | 值内容卡片包含语言标记、展开/收起和保存；底部展示修改状态与适用的格式化/压缩操作；Monaco 根据实际内容高度自动调整到 140–360px，手动展开为 480px，超过上限内部滚动 |
| 集合内容 | List/Set/ZSet/Hash/Stream 增加成员内容标题与已加载数，成员行使用独立浅色卡片；写入方式、截断保护沿用原有逻辑 |
| 主题 | 使用 Fluent 主题色与现有强调色，兼容亮暗模式；窄面板操作自动换行 |
| 验证 | TypeScript/Vite 前端构建及 app:build:fast 打包通过；本轮未完成桌面视觉验收 |

### R3.2 Redis 键切换平滑化（已完成）

| 项 | 说明 |
|---|---|
| 闪烁原因 | 原先选择键即清空 preview 和 String 草稿，属性卡片与 Monaco 编辑器卸载后重建，导致内容空白及高度跳动 |
| 切换策略 | 加载新键时保留上一份完整详情，返回后批量更新属性与草稿；String 间切换复用编辑器；无选中键时才清空详情 |
| 竞态保护 | 每次读取分配递增版本，切换/卸载使旧版本失效；首轮与大值补读后均校验版本，忽略过期成功/失败及 loading 收尾；旧键保存完成后不触发覆盖当前选择的读取 |
| 交互保护 | 加载中、数据与选择不一致或读取失败时锁定内容区域与键操作；保留旧键标题，并在慢请求时说明暂显示上次内容，失败允许刷新重试 |
| 加载反馈 | 160ms 后才显示加载指示，固定预留指示与提示位置，避免快速请求的闪烁和布局挪动；编辑区高度使用 140ms 过渡，遵循减少动态效果偏好 |
| 验证 | TypeScript/Vite 与 app:build:fast 构建通过；连续点击与慢网络的桌面交互验收待补 |

### v0.84 窗口、浏览与编辑体验

| 模块 | 状态 | 说明 |
|---|---|---|
| 窗口恢复 | 已实现 | `window_geometry_v1` 保存普通窗口物理坐标、尺寸和最大化状态；启动先恢复再显示；忽略最小化坐标，副屏移除时收回可用工作区；移动/缩放防抖落盘，正常退出前刷新 |
| 新增行定位 | 已实现 | 网格完成行更新后定位新行，滚动到末尾、显示首个可编辑列并进入编辑；现有主键保护保持不变 |
| Redis 编辑后浏览 | 已实现 | 保存后从服务端重新遍历至原已加载范围（5000 项上限），保留搜索、页码及滚动；删除导致页数减少时收回有效页；重复游标/过多空批次中止，切键后停止旧遍历；成员保存失败保留编辑输入 |
| Redis 窄窗口 | 已实现 | 按工作区逻辑宽度适配缩放：不足 1000px 时前缀树折叠为覆盖面板；不足 720px 时键列表和详情切换，提供返回列表/查看详情；详情组件保留挂载以保护草稿 |
| SQL 文件 | 已实现首版 | 查询工具栏打开/保存/另存为 `.sql`，编辑器 Ctrl+S 保存文件，支持草稿命名；页签显示文件名或草稿名；本地草稿恢复文件关联与基线；退出时文件修改保存到关联文件 |
| 文件保存保护 | 已实现 | UTF-8（可读 BOM），2 MB 上限；同目录临时文件写入并同步后替换；保存前比较打开时内容，发现外部修改或删除拒绝覆盖，建议另存为；不是跨进程文件锁，检查与替换间的极小竞争窗口仍存在 |
| 单元格详情 | 已实现 | 复用完整值入口，增加 Monaco 高亮、搜索、JSON 格式化、复制、十六进制查看；空字符串与 NULL 独立选择，JSON/二进制/数值校验；保存仍使用旧值并发校验和会话只读检查；关闭纳入未保存保护 |
| 查询结果详情 | 已实现 | 结果网格右键增加只读详情，保留原始换行；截断结果明确提示去表数据页读取完整值，不冒充已获得全文 |
| 稳定性验证 | 部分完成 | 前端及菜单回归、11 个默认 Rust 测试、本机 MySQL 650 行集成检查通过；Redis/PostgreSQL 本轮本机端口不可用，显式集成用例已提供，尚不能标为通过；桌面新版复验见验收记录 |

单元格详情直接写入，因此网格存在未提交/新增行时须先处理网格修改，避免保存详情触发表格刷新丢失草稿。主键单元格详情只读；超大整数详情修改拒绝不安全数值转换。SQL 文件首版不包含目录树、编码选择、多个进程的写锁与 SQL 格式化。

### M2 已知偏差（后续补齐）

v0.83 副屏核心验收见 `docs/acceptance-v083.md`；其四项体验待办已在 v0.84 实现。SQL/Redis 全部引擎、错误注入及缩放组合仍需继续复验，不能视为完整发布验收通过。


| 项 | 当前实现 | 计划 |
|---|---|---|
| 分页方式 | v0.83 单整数主键默认浏览使用游标，其它情况仍为 OFFSET | 后续覆盖复合/字符串主键与排序 |
| SQLite 取消查询 | 不支持 | 后续用 sqlite3_interrupt / progress_handler |
| 结果导出 | 已实现 CSV/JSON/Excel | 见 transfer 模块 |
| `DefaultValue` 归一化 | 仍为原始文本（M2 未做） | M3 同步引擎需要时归一化 |
| PostgreSQL `raw_ddl` | 使用元数据重建表 DDL，视图定义仍有限制 | 后续提高还原完整性 |
| 索引与外键可视化编辑 | 已有编辑对话框；SQLite 外键需重建表 | 按引擎能力显示限制 |
| 视图结构编辑 | 只读 | 保持只读 |

### M1 已知偏差（补记）

| 项 | 当前实现 | 计划 |
|---|---|---|
| 系统强调色同步 | 已实现读取 Windows 强调色及手动选择 | 见 v0.11 |

### 环境说明（开发机）

- Rust stable 1.98.1（rustup + MSVC 工具链）；crates.io 使用 rsproxy.cn 镜像（`~/.cargo/config.toml`）
- rustup 分发使用 rsproxy.cn 镜像（用户环境变量 `RUSTUP_DIST_SERVER` / `RUSTUP_UPDATE_ROOT`）
- 开发命令：`npm run tauri dev`（依赖 `%USERPROFILE%\.cargo\bin` 在 PATH，已写入用户 PATH）

---

## 21. 变更记录

| 版本 | 日期 | 变更内容 | 变更人 |
|---|---|---|---|
| v0.1 | 2026-09-14 | 初始版本：技术选型（Tauri 2 + React + Fluent UI v9 + sqlx）、整体架构、统一元数据/值模型、同步引擎设计、UI 规范、里程碑 | 初始设计 |
| v0.2 | 2026-09-14 | M1 实现完成：工程骨架（Mica+自绘标题栏）、本地存储与凭据、会话管理、三引擎适配与元数据内省、对象树与表结构详情；新增「20. 实现状态」章节，记录实现偏差（DefaultValue 原始文本、PG raw_ddl 暂缺）与开发环境说明；风险表补充脚手架误删风险 | 实现 |
| v0.3 | 2026-09-14 | M2 实现完成：SQL 编辑器（Monaco 离线打包）、分页查询与取消、三引擎动态解码、查询历史、只读与危险语句拦截、AG Grid 网格编辑与事务提交、库/表 DDL（含 SQLite 重建表）、页签工作区与对象树右键菜单；新增 `E_DANGEROUS` 错误码；记录 M2 偏差（OFFSET 分页、SQLite 取消、导出待做） | 实现 |
| v0.4 | 2026-09-14 | M2.1 稳定性修复：大字段服务端截断与 `trunc` 只读值、查询 60 秒超时、前端错误边界、本地库连接池 acquire 超时、新增 `release-fast` 快速构建渠道 | 修复 |
| v0.5 | 2026-09-14 | 修复无限渲染循环：`useNotify` 返回值改为稳定引用（此前导致表数据页无限重复查询、连接池占满、界面报 React #185），表数据加载增加并发保护 | 修复 |
| v0.6 | 2026-09-14 | 用户反馈修复：MySQL 元数据 BINARY/BLOB 解码回退（类型/注释/主键恢复）、弹窗与菜单不透明化、会话文件夹分组与底部工具栏、表工作区升级为「数据/结构/索引/外键/DDL」五页签；新增 `session_set_group` 与 `settings_get/set` 命令 | 修复 |
| v0.7 | 2026-09-14 | 体验细化：页签按会话分组显示、SQLite 表详情语法错误修复（notnull 别名）、网格表头显示字段类型、子页签切换保持挂载不重复请求、文件夹展开/收起箭头、左侧新增「选项 → 系统设置」（亮色/暗色/跟随系统） | 优化 |
| v0.8 | 2026-09-14 | 观感修复：暗色主题同步窗口 Mica（setTheme）并统一网格/编辑器主题、屏蔽浏览器右键菜单、新增非线性切换动画与过渡、消除悬停元素位移 | 修复 |
| v0.9 | 2026-09-14 | 交互增强：界面色彩点缀（引擎色、图标配色、活动页签底边、网格强调色/斑马纹）、右侧内容缩放（快捷键/Ctrl+滚轮/设置项，`ui_zoom`）、页签行数设置（`ui_tab_rows`）、会话栏与对象浏览器可拖拽调宽（持久化） | 优化 |
| v0.10 | 2026-09-14 | 修复缩放布局错位：`zoom` 属性在新版 Chromium 下百分比尺寸解析异常，改为 `transform: scale()` + 尺寸补偿方案 | 修复 |
| v0.11 | 2026-09-14 | 强调色配置：跟随系统（Windows 注册表读取）或预设色选择，由强调色生成 Fluent 品牌色板并贯穿主题/标题栏/分隔条/数据网格；新增 `system_accent_color` 命令与 `ui_accent` 设置 | 优化 |
| v0.12 | 2026-09-14 | 布局重构（方案 A）：会话与对象浏览器合并为单栏上下分区、垂直分隔条拖拽、Ctrl+B 收起侧栏（带展开导轨）；释放约 280px 给右侧工作区 | 优化 |
| v0.13 | 2026-09-14 | 设置独立页面：设置改为工作区页签（分类导航 + 表单），入口为侧栏齿轮与 Ctrl+,；新增布局与缩放分类，预留编辑器/数据网格/同步/快捷键/高级分类 | 优化 |
| v0.14 | 2026-09-14 | 数据网格紧凑化：字号 12px、行高 28px、表头 38px；列宽统一 110px 且最小宽度放宽到 40px，减少横向滚动 | 优化 |
| v0.15 | 2026-09-14 | 数据页支持服务端排序：点击表头生成 ORDER BY 重新查询、Shift 多列排序、排序指示箭头；有未提交修改时禁止排序 | 新增 |
| v0.16 | 2026-09-14 | 修复自定义表头点击不排序（TypeHeader 自行触发 progressSort、箭头由状态驱动）；查询页签结果支持服务端排序（`sort` 参数贯穿 query_execute / query_fetch_page） | 修复 |
| v0.17 | 2026-09-14 | 修复排序结果被 AG Grid 客户端字符串排序覆盖（服务端排序启用时 comparator 返回 0）；数据页排序改由后端外层生成 ORDER BY；刷新按钮不再因加载状态闪烁（改状态栏指示） | 修复 |
| v0.18 | 2026-09-14 | 排序不再重建列定义（用 api.refreshHeader 更新箭头），列宽在排序后保持；刷新按钮去掉 disabled/图标切换，彻底消除闪烁 | 修复 |
| v0.19 | 2026-09-14 | 彻底修复排序后列宽重置：切断 valueSetter 对行数据的依赖链（ref 化），列定义在排序/翻页/刷新间保持稳定 | 修复 |
| v0.20 | 2026-09-14 | 修复对象浏览器无滚动条：面板高度约束补全（flex/minHeight/overflow），树容器内部滚动生效 | 修复 |
| v0.21 | 2026-09-14 | 表工作区新增「信息」页签：表注释、行列索引统计、主键、自增列与当前值、引擎/字符集/排序规则、创建更新时间；新增 `meta_table_info` 命令与适配器 `table_extra_info` | 新增 |
| v0.22 | 2026-09-14 | 页签右键菜单（置顶/关闭/关闭其它/关闭所有）；置顶表页签按会话持久化并在连接时自动恢复；信息页签移至首位；结构页类型列去重 | 新增 |
| v0.23 | 2026-09-14 | 界面图标补充：表工作区页签、信息页分节、索引/外键/DDL 面板标题统一配主题图标 | 优化 |
| v0.24 | 2026-09-14 | 修复测试连接长错误信息撑破新建会话弹窗：结果独立成行、自动换行、限高滚动 | 修复 |
| v0.25 | 2026-09-14 | 未连接/已断开会话的页签隐藏（保留内存，重连恢复）；断开时取消其活动页签并显示未连接提示 | 优化 |
| v0.26 | 2026-09-14 | 对象浏览器表行显示磁盘大小（MySQL/PG，悬停含引擎与行数）；信息页存储分节新增磁盘大小；数据网格改为双击编辑防误操作 | 优化 |
| v0.27 | 2026-09-14 | 对象浏览器区分已打开表：已打开使用实心图标、未打开使用线框图标，悬停提示标记「已打开」 | 优化 |
| v0.28 | 2026-09-14 | PostgreSQL 适配：写入参数按列类型显式转换（日期/JSON/UUID/枚举/数组）、数组解码为 JSON 文本、改列仅在类型变化时重建、未知类型保留原文；用 PG18 容器完成端到端验证 | 适配 |
| v0.29 | 2026-09-14 | PG DDL 由元数据生成（CREATE TABLE + 索引 + COMMENT）；信息页按引擎能力隐藏不适用字段（PG 无引擎/字符集等概念、SQLite 无注释/估算行数） | 适配 |
| v0.30 | 2026-09-14 | 新增复制粘贴（TSV，Excel 互通）、可视化筛选器（后端安全生成 WHERE）、导入导出（CSV/JSON/Excel，全部数据流式导出 + CSV 预览映射导入）；PG 容器端到端验证通过 | 新增 |
| v0.31 | 2026-09-14 | 文本渲染长度限制：统一预览上限收紧到 1024 字符，表数据查询对超长文本/二进制列下推 LEFT/substring/substr 截断（多取 1 字符保证可识别），截断单元格只读 | 优化 |
| v0.32 | 2026-09-14 | 筛选面板布局优化：弹层加宽、下拉列表限高滚动、列名带注释（括号包裹+截断）、值输入框空间增大 | 优化 |
| v0.33 | 2026-09-14 | 修复筛选条件行控件重叠：固定轨道宽度 + 溢出裁剪 + minWidth 归一 | 修复 |
| v0.34 | 2026-09-14 | 修复筛选下拉弹层出现在右侧：listbox 样式层级修正（限高生效）+ 强制向下弹出 | 修复 |
| v0.35 | 2026-09-14 | 筛选列选择改为可搜索 Combobox（列名/注释模糊匹配），下拉限高约 10 项（CSS !important 覆盖 Fluent 自动尺寸） | 优化 |
| v0.36 | 2026-09-14 | 修复筛选弹层清空后跳到上方：Popover 固定向下弹出 | 修复 |
| v0.37 | 2026-09-14 | 会话列表紧凑化（内边距/图标/行高/色条收紧）；文件夹折叠状态持久化（ui_collapsed_folders） | 优化 |
| v0.38 | 2026-09-14 | 页签改为数量上限（默认 20，超出自动关闭最早的未置顶页签）；设置改为独立页面（返回按钮，不再是页签） | 优化 |
| v0.39 | 2026-09-14 | 结构页紧凑化；添加列改为行内追加（类型下拉）；列行右键菜单（修改/上下方添加/上下移动/移除）；新增 AddColumn.position 与 MoveColumn（MySQL AFTER/FIRST、SQLite 重建、PG 不支持顺序） | 新增 |
| v0.40 | 2026-09-14 | 修复右键菜单在界面缩放下定位偏移：新增 ContextMenuPortal，所有自定义菜单渲染到 Provider 内的浮层容器 | 修复 |
| v0.41 | 2026-09-14 | 列编辑弹窗类型参数适配：decimal 三列布局修复溢出，时间类型支持小数秒精度（DATETIME(p)/TIMESTAMP(p)），编辑时回填类型参数 | 修复 |
| v0.42 | 2026-09-14 | 列编辑弹窗布局改为「类型单独一行、参数放下一行」，彻底避免输入框挤压溢出 | 修复 |
| v0.43 | 2026-09-14 | 所有 Fluent 列表（结构/索引/外键/导入预览）统一斑马纹与悬停高亮，颜色跟随强调色 | 优化 |
| v0.44 | 2026-09-14 | M3 同步引擎：结构与数据差异对比、脚本预览、批量事务执行；前端三步向导（端点/对象/对比执行）；修复 PG identity 列识别；用 PG18 容器完成端到端验证 | 新增 |
| v0.45 | 2026-09-14 | 高频短板补齐：查询执行计划弹窗、大字段完整值查看/编辑（带并发校验）、索引与外键的可视化新建/删除 | 新增 |
| v0.46 | 2026-09-14 | 修复完整值编辑框高度未传导导致内容被截断：Textarea 固定 16 行 + 内部高度自适应 | 修复 |
| v0.47 | 2026-09-14 | 视觉调性增强：表格表头着色（强调色 8%）、斑马纹与悬停加深、内容区/侧栏标题/状态栏强调色渐变、信息卡片渐层、欢迎页强调色图标与渐变标题 | 优化 |
| v0.48 | 2026-09-15 | 右键菜单改为不透明（统一 `dw-context-menu` 样式）；索引与外键支持编辑（ReplaceIndex/ReplaceForeignKey，等价于删除+重建并预览两条语句） | 优化 |
| v0.49 | 2026-09-15 | 修复表头强调色被逐单元格绘制导致的分隔间隙：改为整行表头容器着色 + 单元格透明 + 底部强调线 | 修复 |
| v0.50 | 2026-09-15 | Redis 引擎 R1：`Engine::Redis` + `KeyValueAdapter`/`RedisAdapter`（复用会话流程）、会话 `redisDb`/`tls` 字段与本地库迁移、`INFO`/`CONFIG GET databases`/`DBSIZE` 服务器信息、`redis_server_info`/`redis_databases`/`redis_command` 命令、会话表单 Redis 专属字段、对象树逻辑库叶子与 Redis 概览页签、同步向导排除 Redis 会话；新增 6.4 节记录设计与 R2–R5 路线图 | 新增 |
| v0.51 | 2026-09-15 | Redis 引擎 R2：`redis_scan_keys`（SCAN 游标分页 + TYPE 过滤 + 命令管道取 TYPE/PTTL/MEMORY USAGE）与 `redis_key_preview`（六类型前 100 项预览、截断/编码/二进制标记）；Redis 页签升级为「键浏览 / 服务器概览」双子页签，键浏览含前缀树、类型/TTL/大小表格、右侧预览面板与游标续扫；概览逻辑库表加「浏览键」入口；新增 6.5 节 | 新增 |
| v0.52 | 2026-09-15 | 修复键浏览前缀树交互：点击树节点不再覆盖搜索框并触发重扫（此前会导致树被过滤、同级前缀消失），改为本地前缀筛选（树保持完整、自动展开、可一键清除），搜索框仅由用户输入驱动 | 修复 |
| v0.53 | 2026-09-15 | 修复前缀树无法展开（受控 `openItems` 值与 `TreeItem value` 的 `folder:` 前缀未对齐）；移除工具栏「已加载 N 个键」状态文字（扫描中改为按钮加载态） | 修复 |
| v0.54 | 2026-09-15 | Redis 服务器概览信息打磨：INFO 分节改为强调色标题卡片、可折叠（默认折叠命令/错误/延迟统计）并支持展开/折叠全部；键名中文化（约 190 个常用键 + dbN/cmdstat_*/errorstat_*/listenerN 规则，附英文原名）；条目紧凑化（250px 网格、18px 行高、值列省略+悬停完整）与大数字千分位 | 优化 |
| v0.55 | 2026-09-15 | 修复 Redis 概览分节被压成标题条/内容裁切：`overflow: hidden` 的卡片作为 flex 子项被压缩（min-height 自动值失效），概览改为普通文档流布局（各区块外边距分隔，不再参与 flex 收缩） | 修复 |
| v0.56 | 2026-09-15 | Redis 概览占满可用宽度（移除 1100px 宽度上限）；逻辑库区块与表头去重：「库」列改为「名称」、操作列右对齐显示「浏览键 →」、区块标题补充操作提示 | 优化 |
| v0.57 | 2026-09-15 | Redis 服务器概览移除「逻辑库」区块（与键浏览工具栏的逻辑库选择重复），概览仅保留服务器卡片与 INFO 分节 | 优化 |
| v0.58 | 2026-09-15 | 键浏览交互打磨：前缀树紧凑化（行高 22px、缩进每级 12px、无子前缀节点不显示展开箭头）；点击节点不再折叠/切换展开（展开由箭头控制）；前缀树与预览面板支持拖拽调宽并持久化（`ui_redis_tree_width` / `ui_redis_preview_width`） | 优化 |
| v0.59 | 2026-09-15 | 修复右侧预览面板拖拽方向相反：`ResizeHandle` 新增 `invert` 支持（面板在右侧/下方时宽度增量取反），预览分隔条启用 | 修复 |
| v0.60 | 2026-09-15 | 键浏览去掉工具栏逻辑库下拉：逻辑库切换统一由左下角对象浏览器完成，点击库打开该库的独立页签（同一会话按库去重，重复点击聚焦），工具栏改为显示当前库徽标 | 优化 |
| v0.61 | 2026-09-15 | Redis R3：`RedisEditOp` 六类型写入（SET KEEPTTL / LPUSH·RPUSH·LSET·LREM / SADD·SREM / ZADD·ZREM / HSET·HDEL / XADD）、键管理（新建、RENAMENX 重命名、PEXPIRE/PERSIST TTL、DEL 删除）、所有写命令只读校验（`E_READONLY`）；右侧面板升级为编辑器（含重命名/TTL/删除对话框、新建键对话框、行内编辑），写入后自动重载预览并静默刷新键列表；新增 6.6 节 | 新增 |
| v0.62 | 2026-09-15 | 会话列表改用数据库官方品牌图标（Simple Icons：SQLite #003B57、PostgreSQL #4169E1、MySQL #4479A1、Redis #FF4438），引擎色板同步为品牌色（`engineIconColor`） | 优化 |
| v0.63 | 2026-09-15 | 键浏览与编辑体验：前缀树叶子节点改用「多钥匙堆叠」图标；键列表支持右键菜单（查看/编辑、复制键名、重命名、TTL、刷新、删除）；String 编辑器自动识别 JSON/XML 并格式化（格式化/压缩按钮、解析错误提示），并对 String 拉取完整值（截断按 1 MB 上限重取，超限禁用保存）；重命名/TTL/删除对话框抽为共享组件 | 优化 |
| v0.64 | 2026-09-15 | Redis String 值编辑器改用 Monaco（VS Code 同款高亮）：JSON/XML 自动识别并格式化，类 JSON 回退 JavaScript 高亮，纯文本普通显示；工具栏徽标显示当前语言；编辑框随主题切换明暗（`useIsDark`）；行号、自动换行、无小地图 | 优化 |
| v0.65 | 2026-09-15 | 键浏览「刷新」与类型过滤不再清除已选前缀与选中键（仅切换逻辑库或输入新搜索模式时重置），避免刷新后跳回 `*` | 修复 |
| v0.66 | 2026-09-15 | 键浏览体验：前缀树子级增加竖线缩进引导（层级更直观）；键列表更紧凑（行高 22px、11px 字号）；键名 / TTL / 大小支持表头点击本地排序（升降序，仅作用于已加载数据，服务端仍为 SCAN 游标查询） | 优化 |
| v0.67 | 2026-09-15 | 修复 String 类型编辑面板内容重复：Monaco 编辑器下方不再重复渲染条目列表（此前会再次显示序号 + 原值） | 修复 |
| v0.68 | 2026-09-15 | 值编辑器行号槽与内容区分：自定义 Monaco 主题（`dw-light`/`dw-dark`，行号弱化 + 行号槽浅底色）并在槽右侧加分隔线，避免误把行号当内容 | 优化 |
| v0.69 | 2026-09-15 | 指标口径澄清：编辑面板徽标改标「长度 N B」（STRLEN）、「内存 N B」（MEMORY USAGE）、raw（OBJECT ENCODING）并加悬停说明；键列表「大小」列改名「内存」并注明为扫描时采样；移除字符串编辑器下方的字符数提示文字 | 优化 |
| v0.70 | 2026-09-15 | 键列表支持批量删除：复选列（表头全选/半选）+ 工具栏「已选 N 个键 / 清除选择 / 批量删除」+ 确认对话框（列出前 50 个键名）；后端新增 `redis_delete_keys`（分块 DEL，返回删除总数，只读会话拒绝）；右键菜单选中多键时显示「删除选中的 N 个键」 | 新增 |
| v0.71 | 2026-09-15 | 会话行去掉「…」按钮改为右键菜单（连接/断开、编辑、服务器信息、删除）；新增通用信息对话框 `InfoDialog` 与 `meta_server_info`/`meta_database_info`（MySQL/PG/SQLite 服务器与数据库信息；Redis 会话复用 INFO 并按中文分节显示）；对象树右键增强：数据库菜单加「数据库信息」、数据表菜单加「表信息」（打开信息页）、Redis 逻辑库菜单（浏览键/刷新逻辑库/复制库名） | 新增 |
| v0.72 | 2026-09-15 | 补上「新建数据库」入口：对象浏览器标题栏 + 按钮与数据库右键菜单项（MySQL 支持可选字符集/排序规则，PostgreSQL 仅名称，SQLite/Redis 隐藏），新建后自动刷新数据库列表 | 新增 |
| v0.73 | 2026-09-15 | 新建数据库对话框改为选择集：新增 `meta_charsets`/`meta_collations` 命令（MySQL `SHOW CHARACTER SET`/`SHOW COLLATION`），字符集下拉显示默认排序规则，排序规则随字符集联动加载，避免手输；PostgreSQL 保持仅名称 | 优化 |
| v0.74 | 2026-09-15 | 修复建库对话框布局：两个下拉未撑满字段宽度导致错位与横向滚动（统一 `width:100%`），字符集选项改为单行（字符集 + 灰色默认排序规则，超长省略），消除选项换行造成的间距不均 | 修复 |
| v0.75 | 2026-09-15 | 建库对话框字符集/排序规则改为上下堆叠全宽布局（两列并排在 Fluent Field 下会错位重叠），彻底消除横向滚动与重叠 | 修复 |
| v0.76 | 2026-09-15 | 新增可持久化界面风格选择（经典简洁/流光层次/专业工作台）与设置缩略预览；默认流光层次，丰富侧栏、表标题、工具栏、网格与类型标签，兼容亮暗主题及强调色；前端构建通过，视觉验收待补 | 新增 |

| v0.77 | 2026-09-15 | 七处右键菜单统一按实际尺寸避让窗口边界，超高菜单内部滚动，兼容窗口缩放；补齐操作图标并区分置顶/取消置顶；增加定位与图标检查脚本 | 修复 |

| v0.78 | 2026-09-15 | 修复 Redis 键列表在特定缩放/分栏比例下键名逐字换行、行高异常：设置表格和中间面板最小宽度，键名单行省略与悬停全文，窄窗口使用横向滚动 | 修复 |

| v0.79 | 2026-09-15 | Redis 键详情面板分层重设计：键名单行省略、独立操作栏、两列属性卡片、内容编辑卡片；编辑器按内容自适应高度并支持展开，集合成员卡片化，保留主题适配 | 优化 |

| v0.80 | 2026-09-15 | Redis 键详情切换保留旧内容直至新请求完成，复用 String 编辑器，增加请求版本与交互锁定保护；延迟加载指示、固定反馈占位及编辑高度过渡，减少闪烁 | 修复 |
| v0.81 | 2026-09-15 | 按优先顺序补充统一未保存保护、SQL 草稿与工作区恢复、稳定性检查、SQL 元数据补全、Redis 命令控制台、同步行级差异与提交前回滚材料；修复整页边界、插入选项、分批统计、NULL 条件与 SQL 内联问题；明确恢复及回滚范围 | 实现 |
| v0.82 | 2026-09-15 | 修复新增退出保护后缺少窗口销毁权限导致无法关闭；改为确认与持久化成功后直接销毁窗口，补充取消、失败重试及并发关闭回归检查 | 修复 |
| v0.83 | 2026-09-15 | 增加会话环境标识、表/Redis 键收藏、库内对象与字段搜索；SQL 单整数主键游标分页、Redis 集合续读/本地搜索/分页显示；修复 SCAN 超出 COUNT 后漏项与游标精度问题；补后台回归与副屏验收边界，清理过期实现状态 | 实现 |
| v0.83（验收补记） | 2026-09-15 | 完成副屏核心流程实测，确认 SQL 保存退出/恢复、环境标记、搜索收藏、SQLite 分页、Redis List/Hash 续读及原始索引编辑、底部菜单；记录窗口位置、新增行定位、高缩放与集合保存后位置四项体验待办，并保留未覆盖矩阵 | 验收 |
| v0.84 | 2026-09-15 | 实现窗口位置/最大化恢复、新增行定位、Redis 保存后重读与浏览状态保留、窄屏前缀折叠及列表/详情切换；补稳定性和本机数据库验收；增加 SQL 文件打开/保存/另存为/命名及外部修改校验，升级单元格详情编辑器与只读结果详情 | 实现 |
| v0.85 | 2026-09-15 | 增加连接中/断开状态、空闲探测、编辑保留和手动重连；查询/导入/导出/同步统一任务中心、独立取消与真实批次进度、耗时和部分失败结果；导出临时文件保护；补后台回归与用户自行验收清单，本轮不控制桌面 | 实现 |
| v0.86 | 2026-09-16 | 设置页缩放改为选择比例后显式应用，修复滑轨随实时缩放位移；增加已应用/待应用提示与恢复 100%，保留快捷键缩放 | 修复 |
| v0.87 | 2026-09-16 | 新增历史中心与 SQL 收藏、Ctrl+P 快速打开；SQL 当前语句执行、保守格式化、命名参数与别名/跨 schema 补全；单元格取值筛选与命名方案；修复跨 schema 页签复用；补后台回归和自行验收清单 | 实现 |
| v0.88 | 2026-09-16 | Monaco 简体中文资源提前加载；SQL 右键增加当前语句/选中执行、格式化、保存与历史中心；选区与运行状态保护，复用原有执行确认链路 | 修复/增强 |

| v0.89 | 2026-09-16 | 统一前后端会话连接去重与已连接复用；连接生命周期互斥、旧探测适配器隔离和 30 秒超时；对象浏览器/工作区同步连接中、错误与重试，补并发回归 | 修复 |

| v0.90 | 2026-09-16 | 修复恢复工作区后活动页签位于标签栏可视范围外；增加切换/置顶/返回和窗口尺寸/缩放变化时的横向可见性追踪 | 修复 |

| v0.91 | 2026-09-16 | 新增列/编辑列/新建表按数据库适配类型、默认值与参数控件；修复 PG JSON/时间类型混淆，保留原始声明，限制 SQLite 自增，补类型回归 | 修复 |

| v0.92 | 2026-09-16 | 新建表改为响应式字段卡片，修复表头/控件错位与横向溢出；SQLite 结构显示明确标注声明类型与元数据来源 | 修复/优化 |

| v0.93 | 2026-09-16 | MySQL 表/库大小统计兼容 DECIMAL 与文本数字；零大小正常显示，悬浮提示标注估算，补边界回归 | 修复 |

| v0.94 | 2026-09-16 | 合并会话工具栏、精简会话元信息；搜索范围跟随数据库并折叠选择、收藏按需显示；去掉连接中背景块与重复按钮，断线提示回归工作区顶部 | 优化/修复 |

| v0.95 | 2026-09-16 | 会话与对象浏览器支持标题拖动左右独立停靠及同侧上下排序，落点预览/取消、菜单替代操作、持久化与恢复默认；固定子树保留面板状态 | 实现 |

| v0.96 | 2026-09-16 | 三处数据类型下拉按中文类别分组；表信息分区内部每行两个栏位，窄工作区自动单列，修复磁盘零值显示 | 优化 |

| v0.97 | 2026-09-16 | 修复分组类型列表撑满屏幕；统一 Dropdown/Combobox 内部滚动及视口高度限制，排查并限制动态菜单/自定义右键菜单高度 | 修复 |

| v0.98 | 2026-09-16 | 补齐 PostgreSQL vector 值读取与详情，只读展示/复制；解析失败不再伪装 NULL，补写入/筛选/同步保护与768维协议回归 | 修复 |

| v0.99 | 2026-09-16 | 修复左右侧栏共享宽度导致联动；新增6套整体主题、独立宽度设置和自定义强调色，覆盖组件、网格与编辑器 | 修复/优化 |

| v0.100 | 2026-09-16 | MongoDB M1＋M2：连接、集合与文档浏览、BSON保真、游标查询、单文档增删改、原文冲突检查、编辑保护、历史收藏与任务中心；附自动回归与专用集成测试入口 | 新增 |
| v0.101 | 2026-09-16 | 本机 MongoDB 认证服务实测；修复原文冲突表达式及写入返回的 _id 字段顺序；补齐 MongoDB 会话图标；文档整行点击查看并移除独立查看按钮 | 修复／优化 |
| v0.102 | 2026-09-17 | MongoDB 集合统计、索引查看/创建、字段抽样及只读聚合；Canonical Extended JSON/JSON Lines 流式导出、逐文档导入与错误报告/取消；MySQL/PG JSON 执行计划节点展示、扫描提示和单语句约束 | 新增 |
| v0.103 | 2026-09-17 | 统一紧凑/舒适密度与持久化；工作区平面化、表单收紧、会话双列、MongoDB 工具合并标题；二级弹窗统一尺寸、主题与内容滚动 | UI 优化 |
| v0.104 | 2026-09-17 | 自定义色盘拖动改为局部预览与应用确认；主题对象缓存；强调色写入串行化与异步竞态/失败保护 | 性能修复 |
| v0.105 | 2026-09-17 | 三栏工作台图标；按帧调整面板、页签按需挂载与工作区保存去重；布局预设/临时专注、本地撤销、关闭右侧/恢复页签/页签列表、Ctrl+P 应用命令与索引缓存、任务定位和关于；补原子保存与恢复回归 | 体验增强 |
| v0.106 | 2026-09-17 | 数据生成 G1–G3：统一适配接口、AI 服务/模型/凭据配置、模板与本地规则、五引擎预览/分批写入、冻结批次防重复提交、取消与部分失败统计、AI 规则建议/指定字段内容、草稿恢复与隔离/本机集成回归 | 新增 |
| v0.107 | 2026-09-17 | 增加 AI 直接生成入口、自动业务字段选择和范围预告；区分本地规则/AI 规则建议/AI 内容生成；展示结果来源和请求进度；明确空配置与响应错误，补充模拟服务回归 | 修复 |
| v0.108 | 2026-09-17 | AI 内容生成支持 SSE；新增实时过程面板、已校验样本与失败现场；强化成功/失败提示；唯一约束报出行号/字段并提供跨批次唯一值上下文；补流协议、取消与事件隔离回归 | 体验增强 |
| v0.109 | 2026-09-17 | 生成状态条增加进度条/百分比；任务中心运行高亮、数量徽标和悬浮前三项任务进度；未知总量使用不定进度，卡片防裁切及按需刷新耗时 | 体验增强 |
| v0.110 | 2026-09-17 | 分离 SSE 传输与正文上限；数据生成失败后按批次查看/复制已收到的 AI 响应，保留错误正文、标明截断并限制归档内存；补模拟 HTTP 与归档回归 | 修复/体验增强 |
| v0.111 | 2026-09-17 | 数据生成页签增加来源任务动画与取消中说明；修复 Tooltip 将任务悬浮卡片误判为超出滚动容器后隐藏的问题，改用可悬停浮层；补无界面浏览器交互回归 | 修复/体验增强 |
| v0.112 | 2026-09-17 | 丰富本地文本模板变量、随机 UUID 与批次标识；明确种子复现边界，新增光标插入和常用模板；补跨行/跨任务及冻结写入回归 | 功能增强 |
| v0.113 | 2026-09-17 | Redis 中间键列表收紧行高、表头和复选框留白，修复共享表格样式撑高问题；实测紧凑 28px / 舒适 32px | UI 优化 |
| v0.114 | 2026-09-17 | 数据分析 A1＋A2：SQL / MongoDB 聚合绘图、九种图表与统计、范围标识、参数化分析方案、工作区恢复和 PNG/CSV/JSON 导出；补齐大整数、NULL、字段重排与分页边界验证 | 功能 |

| v0.115 | 2026-09-17 | 数据表与 SQL 结果网格由固定窄列改为初始弹性列，少列自动铺满、超宽横向滚动；保留用户手动列宽并验证窗口/刷新/显隐变化 | UI 优化 |

| v0.116 | 2026-09-17 | 数据分析增加状态栏/欢迎页独立入口，表与集合直接新建分析；结果入口改为「用此结果绘图」，明确快照不联动并修正跨会话默认数据库 | 体验优化 |

| v0.117 | 2026-09-17 | 数据分析新增无外键名称关联与真实字段备注，饼/环图显示百分比；图例改为搜索滚动明细，PNG 导出含完整图例，关联配置可保存并兼容旧方案 | 功能 / 体验 |

| v0.118 | 2026-09-17 | 实现 AI 查询助手 Q1＋Q2：结构上下文、流式生成/修改/解释/纠错、只读候选校验及差异确认应用；任务取消、失败响应保留与独立草稿保护 | 功能 |

| v0.119 | 2026-09-17 | AI 澄清由文本提醒改为交互弹窗，支持单选/多选/具体值和自由回答、暂存与重试、多轮需求延续；兼容旧问题响应 | 体验增强 |

| v0.120 | 2026-09-18 | 分析 SQL 接入 Monaco 与查询区共享补全，支持表名、别名字段和备注提示，跟随会话/数据库与主题 | 体验增强 |

| v0.121 | 2026-09-18 | 修复分析 SQL 补全浮层在缩放容器内偏移；收紧分析页、关联设置与分析库控件和间距，保持图形画布尺寸 | 修复 / UI 优化 |

| v0.122 | 2026-09-18 | 修复同步向导跳过选表步骤，增加搜索、显式勾选和所选范围展示，重选后清理差异；结构/数据沿用指定表执行范围 | 修复 / 体验 |

| v0.123 | 2026-09-18 | 修复 MySQL BIT 默认值被重复字符串转义导致同步建表失败；结构同步失败改为失败提醒 | 修复 |

| v0.124 | 2026-09-18 | 修复 MySQL 源 schema 覆盖同步目标库的问题，覆盖结构脚本、数据写入和回滚 SQL，外键引用显式限定目标库 | 修复 |

| v0.125 | 2026-09-18 | 同步改为可并行的全局独立页签，持久化配置并按页归属任务；新增每表源数据字段筛选，跨分页一致应用并保留目标未匹配行 | 功能 |

| v0.126 | 2026-09-18 | 对齐 AI 服务选择与设置按钮；查询助手与澄清弹窗精简文案，必要说明收纳到信息提示 | UI 优化 |

| v0.127 | 2026-09-18 | 全局精简页面与弹窗说明，统一信息图标提示；保留关键错误、运行状态及操作风险 | UI 优化 |

| v0.128 | 2026-09-18 | AI 查询助手改为查询/分析 SQL 区内嵌智能生成；自动上下文、默认服务固定流式、需求补全、滑入澄清与确认追加 | 交互重构 |

| v0.129 | 2026-09-18 | 移除打开查询成功提示；SQL 区拖动调高与记忆，统一双栏栏头、生成/预览布局和文件菜单 | UI / 体验 |

| v0.130 | 2026-09-18 | 中间分隔条可调比例，停止置于栏头；流式只显示 SQL，移除确认/说明/原响应，完成后自动追加并常驻 AI 提醒 | 交互优化 |

| v0.131 | 2026-09-18 | 移除 SQL / 智能生成区重复分割线，以底色和留白分区；上下及左右拖动条默认弱化，交互时突出 | UI 优化 |

| v0.132 | 2026-09-18 | 恢复单层低对比编辑边框，统一行号底色；仅在输出 SQL 后显示提醒，结合模型与本地检查显示黄/红风险提示 | UI / 风险提示 |

| v0.133 | 2026-09-18 | 修复智能生成补全菜单被输入框与面板裁切；保持边框、滚动与局部坐标定位 | 修复 |

| v0.134 | 2026-09-18 | 会话标题改为独立弹性布局，仅截断名称，保留生产/测试/开发和只读标识 | 修复 |

| v0.135 | 2026-09-18 | 修正查询结果分析的非全量/非全库固定文案，去除重复图表副标题，保留真实范围提示并增加大数据量耗时提醒 | 体验修复 |

| v0.136 | 2026-09-18 | 加固 SQL / 分页 / 同步只读校验及 SQL 连接层保护；生产默认只读、关闭风险确认与一次性升级迁移 | 安全与体验 |

| v0.137 | 2026-09-18 | 统一表页右上角四个操作按钮的尺寸与字体样式 | UI 修复 |

| v0.138 | 2026-09-18 | 移除状态栏已恢复页签计数提示，保留自动恢复功能 | UI 精简 |

| v0.139 | 2026-09-19 | 索引操作单排与右键菜单；页签拖动排序及可配置换行；区分后端查询和请求总耗时 | 交互优化 |

| v0.140 | 2026-09-19 | 修正表页签文字与计数徽标的垂直对齐，统一间距 | UI 修正 |

| v0.141 | 2026-09-19 | 新增外键/业务关联记录侧栏、分析关联复用、当前结果快照差异对比，以及独立连接的手动事务与退出保护 | 功能 |

| v0.142 | 2026-09-19 | 应用图标改为简约镂空数据库轮廓，同步 SVG、窗口与可执行文件图标 | UI 优化 |

| v0.143 | 2026-09-19 | 标题栏新增紧凑全局菜单，将同步和设置移出会话工具栏 | UI 优化 |

| v0.144 | 2026-09-19 | 关于页仅保留作者、邮箱和主页，收紧弹窗尺寸 | UI 精简 |

| v0.145 | 2026-09-19 | 完善 MySQL 表结构差异与逐项排除、主键/索引/外键同步、完整字段定义、依赖顺序及后端固定计划；错误与结构漂移阻止执行 | 功能 / 可靠性 |

| v0.146 | 2026-09-20 | 第一阶段 MySQL SQL 导出：全局多标签、选表/全库、结构/数据、筛选、快照、批次与取消；禁用 WebView 原生菜单、刷新、打印、浏览器快捷键及导航手势，保留应用操作 | 功能 / 修复 |

| v0.147 | 2026-09-20 | 索引/外键新增按钮常显并按权限禁用，修正面板宽度；MySQL 会话数据库白名单、元数据与 SQL/事务/同步/导出范围校验、旧页面与缓存失效 | 交互 / 安全 |

| v0.148 | 2026-09-20 | 会话右键复制、预填编辑与「-副本」名称；保存独立新会话，继承白名单/只读/环境配置，后端复制凭据并保持来源不变 | 功能 |
| v0.149 | 2026-09-21 | 只读对象菜单隐藏写入项，补齐 Redis 编辑与控制台限制、DDL/导入/同步/MongoDB 最终确认层；验证后端只读拒绝仍生效 | 修复 / 安全 |
| v0.149 | 2026-09-21 | 确定采用 MIT 开源协议，添加 LICENSE、README 协议入口并同步 npm/Rust 许可证及作者信息 | 开源 / 文档 |
| v0.149 | 2026-09-21 | 完善中文 README，说明实际功能与数据库边界、运行构建方式、数据存储和反馈贡献流程 | 开源 / 文档 |
| v0.150 | 2026-09-22 | 设置改称首选项，新增本机存储统计、可配置的按会话历史上限、确认清理与空间回收 | 功能 / 交互 |
| v0.151 | 2026-09-22 | 缩小会话列表行距和分组间距，保留名称、地址及状态信息 | 界面 |
| v0.152 | 2026-09-22 | 新增独立 OLED 纯黑主题，统一面板、编辑器、网格和图表底色，保留强调色 | 外观 |
| v0.153 | 2026-09-22 | 新增动效偏好，统一非线性轻动效及减弱/关闭策略，保持编辑器和拖动定位稳定 | 交互 |
| v0.154 | 2026-09-22 | 修复标签内容切换闪烁，以共享滑动指示条恢复连续动效 | 修复 / 动效 |
| v0.155 | 2026-09-22 | 加强完整动效模式的可见切换效果，新增不透明短距离内容滑入并延长菜单与标签过渡 | 交互 |
| v0.156 | 2026-09-22 | 会话列表分组增加非线性展开与收起动画，遵循动效偏好 | 交互 |
| v0.157 | 2026-09-22 | 缩小会话名称、分组及标签字号，保持地址可读性 | 界面 |
| v0.158 | 2026-09-22 | 表数据及查询结果按字段类型配色，适配亮暗与 OLED，保留特殊值样式 | 界面 |
| v0.159 | 2026-09-22 | 缩小结构、索引和外键列表字号及行高，统一常规字重 | 界面 |
| v0.160 | 2026-09-22 | 补齐外键操作列宽度和不换行容器，修复编辑/删除按钮竖排 | 修复 |

| v0.161 | 2026-09-22 | 整理筛选布局、缩小字段选项字号、关系符号化，增加当前已加载数据的去重可搜索候选值 | 优化 |

| v0.162 | 2026-09-22 | 首选项增加每页最大查询行数，统一表数据、SQL 和手动事务分页，保留已有结果分页步长 | 功能 |

| v0.163 | 2026-09-22 | 选区 AI 格式化和优化菜单、本地方言语法前置校验、候选预览及可撤销替换 | 功能 |

| v0.164 | 2026-09-22 | 统一表单控件内外层与焦点圆角，修复主题/密度叠加及 Select 底边色差 | 修复 |

| v0.165 | 2026-09-22 | 修复紧凑 small Select 内部高度不足导致中文底部裁切，补充小尺寸与缩放验证 | 修复 |

| v0.166 | 2026-09-22 | 数据库节点展示表概览，取消 MySQL 系统库硬编码隐藏并保留数据库隔离 | 功能 |

| v0.167 | 2026-09-22 | 信息页新增基本属性与 MySQL 表选项编辑，接入 DDL 预览、只读与未保存保护 | 功能 |

| v0.168 | 2026-09-22 | 固化全局紧凑 UI 原则，修正表属性布局，引擎/字符集/排序规则改为服务器下拉列表 | 优化 |

| v0.169 | 2026-09-22 | 结构列表可空/无符号复选框，暂存保存/废弃，原始列定义保护与只读校验 | 功能 |

| v0.170 | 2026-09-22 | MySQL 字段行内编辑、长度/集合独立列、默认值模式及自增/ON UPDATE 设置 | 功能 |

| v0.171 | 2026-09-23 | 结构单元格双击编辑、恢复字段右键操作、新增创建及加入索引 | 交互 |

| v0.172 | 2026-09-23 | 对象树优先显示用户数据库，MySQL 四个内置数据库置后 | 交互 |

| v0.173 | 2026-09-23 | 表数据逐行差异与选择性提交、统一危险 SQL 范围检查、生产写入二次确认 | 功能与安全 |
| v0.174 | 2026-09-23 | 数据库概览行数比例条改为数字右侧的高对比度实色轨道，保持紧凑行高 | UI 修复 |
| v0.175 | 2026-09-25 | 改善九种分析图的默认配色与信息层次，饼/环图减少拥挤标签；修复 SQLite 大整数主键删除无效和零行命中误报成功，增加事务回滚校验 | UI / 修复 |
| v0.176 | 2026-09-25 | 项目更名为 DBFolio，统一应用/构建/文档名称与包元数据；保留旧版本地目录和凭据标识，兼容已有会话与设置 | 命名 / 兼容 |
| v0.177 | 2026-09-25 | 新增 NSIS 安装包和目录式便携包，测试构建统一 portable；前端资源外置并校验摘要，输出版本与校验清单，明确后续整包更新及用户数据保留原则 | 构建 / 分发 |
| v0.177 | 2026-09-25 | 固定 Git 提交消息采用 `feat:`、`fix:` 等类型前缀与中文说明，并写入项目协作规则 | 协作规范 |
| v0.177 / 文档 R1 | 2026-09-26 | 新增 39 项有序功能路线图，规定逐项实施、验收打标及完成证据记录；应用版本与现有功能不变 | 路线图 / 协作规范 |
| v0.178 | 2026-09-26 | 实施 R01–R03：流式 SQL 文件导入、MySQL 五类对象定义管理/差异/过程多结果、完整对象导出/目标映射/ZIP/本地方案；补齐只读与作用域检查、取消和断线报告、真实 MySQL 往返验收，修复预处理协议与 VARBINARY 兼容问题 | 功能 / 验证 |
| v0.179 | 2026-09-27 | 修复结构列表遗漏字段类型配色；共用数据页语义色，覆盖 MySQL/PostgreSQL/SQLite，支持类型暂存和废弃后颜色联动；完成主题/行内编辑回归和测试便携包校验 | 修复 / UI |
| v0.180 | 2026-09-27 | 修复 MySQL CHAR/VARCHAR/TEXT 在二进制排序规则下被显示为十六进制；按服务器字符集编号区分文本与二进制，增加真实 MySQL 双协议与全值读取回归，记录 SQLx 本地补丁来源和维护方式 | 修复 / 驱动 |
| v0.180 / 文档 R5 | 2026-09-27 | 汇总本轮功能与修复，补录代码提交 a07fa00，同步路线图和验收记录；完成 3/39，下一项 R04 | 文档 / 提交归档 |
| v0.181 | 2026-09-27 | 完成 R04：单跳 SSH 密码/加密私钥与指纹信任、TLS CA/客户端证书/数据库服务器名、分阶段诊断、独立超时与安全凭据生命周期；114 项自动测试及 MySQL/隔离协议专项通过；生成并校验正式 NSIS 和 portable，固定每次代码变更双包交付规则，路线图完成 4/39 | 功能 / 安全 / 构建 |
| v1.0.0-alpha | 2026-09-28 | 对外版本从 1.0.0-alpha 起算并统一各端版本；所有构建归档 release/版本号，安装版与便携版分开生成 SHA256SUMS，便携清单覆盖 ZIP 与目录；归档旧 0.181.0 包并验证摘要不变，新版本正式双包及完整性校验通过 | 版本 / 构建 |
| v1.0.0-alpha.1 | 2026-09-28 | 任务中心执行入口改为静态强调色细描边和描边数量徽标，移除旋转图标、底色、粗线及加粗；三主题与原交互回归通过，正式安装包/便携版及独立校验清单已生成并验证 | UI / 修复 |

| v1.0.0-alpha.2 | 2026-09-28 | 补齐索引/外键类型及规则配色，DDL 复用查询页 SQL 高亮；任务中心聚焦后台作业，保留前台按页签取消和连接保护；修复 SQLite/PostgreSQL 等结构操作横排与紧凑行高；前端及隔离 UI 回归通过，正式安装包/便携版与两份 SHA256SUMS 已交付并验证 | UI / 修复 |
| v1.0.0-alpha.3 | 2026-09-28 | 统一三 SQL 引擎双击行内列编辑与保存/废弃；补齐 SQLite 保留依赖的事务重建和 PostgreSQL 原生批量修改；更正追加列菜单，清理重复入口，MongoDB/Redis 增加废弃；123 项 Rust 测试与三引擎 UI 回归通过，真实 PostgreSQL 验收受本机服务拒绝连接限制；正式双包和两份 SHA256SUMS 已生成并校验通过 | UI / 修复 / 跨引擎 |
| v1.0.0-alpha.4 | 2026-09-28 | 新增 Base64 位图缩略图、完整图片/原始尺寸及原文切换；表数据与查询结果共用组件，截断图片按主键可见范围限量补读，解码失败保留文本；三引擎合成 UI、误识别/损坏/超限/竞态及 SQLite 限长读取验证通过，正式安装包、便携目录/ZIP 与两份 SHA256SUMS 已交付并校验 | 功能 / 图片预览 |
| v1.0.0-alpha.5 | 2026-09-28 | 修复 PNG 块识别与高分辨率预览限制，使用缩小位图及 Blob 资源回收，新增保留原始字节的原图导出；前端与 Rust 图片回归通过，正式安装包、便携目录/ZIP 及两份 SHA256SUMS 已生成并校验通过 | 修复 / 图片预览与导出 |
| v1.0.0-alpha.6 | 2026-09-28 | 重构关系型建表为新建表* 标签页草稿，复用信息表单/结构行编辑/导航；暂存索引外键并统一创建，保存成功显示数据页，失败保留草稿；三引擎 UI 与 SQLite 实际建表/回滚验证通过，正式安装包、便携目录/ZIP 及两份 SHA256SUMS 已生成并校验通过 | 功能 / 建表交互 |
| v1.0.0-alpha.6 / 文档 R14 | 2026-09-28 | 汇总 R04 与 alpha 系列改动，补录提交 [830bec9](https://github.com/SerLiunx-ctrl/dbfolio/commit/830bec9d308f55f4dc13710ee1906c0ae85d8616)，更新路线图及验收归档；版本和构建产物不变 | 文档 / 提交归档 |
| v1.0.0-alpha.7 | 2026-09-29 | 新增 SQLite 文件拖入自动填写会话名/路径，复用保存流程；只读文件识别、覆盖保护、名称冲突处理；页签改为兼容原生文件拖放的指针排序 | 功能 / 会话体验 |
| v1.0.0-alpha.7 / 文档 R16 | 2026-09-30 | README 新增可互相切换的中英文版本、章节目录及五张界面示例；公开截图中的 MongoDB 凭据摘要与文档原文已脱敏。仅文档和截图资源调整，应用版本与打包产物不变 | 文档 / 开源展示 |
