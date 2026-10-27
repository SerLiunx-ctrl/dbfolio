import { version } from "../../package.json";

export const APP_RELEASE = version;
export const CURRENT_RELEASE = {
  date: "2026-10-27",
  changes: [
    "字段类型按 MySQL 版本和当前 PostgreSQL 数据库的真实类型能力适配。",
    "已安装 pgvector 时可选择向量类型并填写维度，类型选项补充中文说明。",
    "新增列、行内修改和建表共用类型能力，支持刷新并保留当前声明。",
  ],
};
