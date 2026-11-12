import { createRoot } from "react-dom/client";
import { useState } from "react";
import { FluentProvider } from "@fluentui/react-components";
import { DdlPanel } from "../../src/features/table/StructurePanel";
import { objectDisplayName } from "../../src/features/table/objectName";
import { buildTheme } from "../../src/theme";
import { useSettingsStore } from "../../src/stores/useSettingsStore";
import type { Engine, TableMeta } from "../../src/ipc/types";
import * as monaco from "monaco-editor";
import "../../src/monaco";
import "../../src/styles.css";
import "../../src/compact.css";

const w = window as any, params = new URLSearchParams(location.search), mode = params.get("theme") ?? "light";
const engine = (params.get("engine") ?? "dameng") as Engine;
useSettingsStore.setState({ themeMode: mode as any });
document.documentElement.dataset.oled = String(mode === "oled");
document.documentElement.dataset.density = "compact";
const original: TableMeta = {
  name: "MODEL_CATALOG", schema: "AGENT", kind: "table", primaryKey: ["ID"],
  columns: [{ name: "ID", ordinal: 1, rawType: "DECIMAL(20,0)", canonical: { kind: "decimal", precision: 20, scale: 0 }, nullable: false, autoIncrement: true } as any],
  indexes: [], foreignKeys: [], rawDdl: 'CREATE TABLE "AGENT"."MODEL_CATALOG" (\n  "ID" DECIMAL(20,0) IDENTITY(13,1) NOT NULL,\n  "CONTENT" CLOB, "DATA" BLOB,\n  NOT CLUSTER PRIMARY KEY("ID")\n) STORAGE(ON "MAIN", CLUSTERBTR);\nCREATE INDEX "AGENT"."IDX_CATALOG" ON "AGENT"."MODEL_CATALOG"("CONTENT");\nCOMMENT ON TABLE "AGENT"."MODEL_CATALOG" IS \'模型目录\';',
};
w.monaco = monaco; w.opened = []; w.copied = [];
w.__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => { if (command === "clipboard_write_text") { w.copied.push(args.text); return; } throw Error(command); } };
function App() {
  const [detail, setDetail] = useState(original); w.setDetail = (v: Partial<TableMeta>) => setDetail({ ...original, ...v });
  return <FluentProvider theme={buildTheme(mode !== "light", "#0f6cbd", mode === "oled" ? "oled" : "aurora")} data-color-mode={mode === "light" ? "light" : "dark"} style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
    <div data-testid="object-name">{objectDisplayName(engine, "AGENT", "AGENT", detail.name)}</div>
    <DdlPanel detail={detail} engine={engine} onOpenQuery={sql => w.opened.push(sql)} />
  </FluentProvider>;
}
createRoot(document.getElementById("root")!).render(<App />);
