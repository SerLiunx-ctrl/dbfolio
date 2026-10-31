import { version } from "../../package.json";

export const APP_RELEASE = version;
export const CURRENT_RELEASE = {
  date: "2026-10-31",
  changes: ["ER 图新增顶部缩放比例、滚轮与快捷键缩放，AI 候选采用按钮固定在上方，识别设置可折叠。","新增可编辑的应用内快捷键、冲突检查与恢复默认；Ctrl+S 接入 ER、SQL 查询及其它编辑工作区，保留数据库写入确认且不提交手动事务。"],
};
