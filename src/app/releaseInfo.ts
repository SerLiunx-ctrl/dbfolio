import { version } from "../../package.json";

export const APP_RELEASE = version;
export const CURRENT_RELEASE = {
  date: "2026-10-26",
  changes: [
    "表数据与查询结果统一紧凑分页，支持页码跳转和每页条数选择。",
    "分页设置保留在当前页签，切换条数回到首页，未保存修改仍有保护。",
    "结果对比收进菜单，补充当前页快照的使用说明与基准状态。",
  ],
};
