import type { Engine } from "../../ipc/types";

export function objectDisplayName(engine: Engine, database: string, schema: string | null | undefined, table: string) {
  if (engine === "dameng") return `${schema || database}.${table}`;
  return `${database}${schema ? `.${schema}` : ""}.${table}`;
}
