# SQLx PostgreSQL TLS 服务器名补丁

- 来源：crates.io `sqlx-postgres 0.8.6`，保留上游 MIT / Apache-2.0 许可证。
- 修改：`src/options/mod.rs` 新增可选 `tls_server_name`，`src/connection/tls.rs` 用其进行 TLS 主机名验证；未设置时继续使用原 host。
- 用途：SSH 隧道 TCP 端点为 127.0.0.1，但证书应按原数据库服务器名验证，不关闭证书或主机名校验。
- 维护：升级 SQLx 时确认上游具备独立连接地址和 TLS 服务器名能力，并验收后再移除 Cargo 补丁。
