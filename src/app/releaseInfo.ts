import { version } from "../../package.json";

export const APP_RELEASE = version;
export const CURRENT_RELEASE = {
  date: "2026-10-28",
  changes: [
    "数据页和查询结果增加底部/右侧停靠的单元格详情。",
    "详情编辑与网格编辑统一进入待提交，保留类型和原值冲突检查。",
    "增加列搜索、隐藏、冻结、顺序调整和布局记忆。",
  ],
};
