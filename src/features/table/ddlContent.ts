import type { Engine, TableMeta } from "../../ipc/types";
import { generateDdl } from "./ddl";

/** Keep native definitions and their diagnostics together when copying or exporting. */
export function ddlContent(engine: Engine, detail: TableMeta) {
  const warnings = (detail.ddlWarnings ?? []).filter(message => message.trim());
  const native = detail.rawDdl?.trim();
  if (native) {
    const heading = warnings.map(message => `-- DDL 读取说明：${message.replace(/[\r\n]+/g, " ")}`).join("\n");
    return { sql: heading ? `${heading}\n\n${native}` : native, warnings };
  }
  if (engine === "dameng") {
    return {
      sql: null,
      warnings: warnings.length ? warnings : ["未能获取达梦原生 DDL，请确认查看定义的权限后刷新元数据。"],
    };
  }
  return { sql: detail.kind === "table" ? generateDdl(engine, detail) : null, warnings };
}
