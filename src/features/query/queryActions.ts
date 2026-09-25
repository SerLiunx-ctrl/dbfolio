import type * as Monaco from "monaco-editor";

export interface QueryActions {
  runCurrent: () => void;
  runSelection: () => void;
  format: () => void;
  aiFormat: () => void;
  aiOptimize: () => void;
  save: () => void;
  history: () => void;
}

/** 使用 Monaco 的公开扩展入口，保留选区、菜单边界定位及原生编辑操作。 */
export function registerQueryActions(editor: Monaco.editor.IStandaloneCodeEditor, actions: QueryActions) {
  const definitions: Monaco.editor.IActionDescriptor[] = [
    { id: "dw-run-current", label: "执行当前语句", precondition: "dwQueryIdle", contextMenuGroupId: "0_query", contextMenuOrder: 1, run: actions.runCurrent },
    { id: "dw-run-selection", label: "执行选中 SQL", precondition: "dwQueryIdle && editorHasSelection", contextMenuGroupId: "0_query", contextMenuOrder: 2, run: actions.runSelection },
    { id: "dw-context-format", label: "格式化 SQL（选中优先）", contextMenuGroupId: "0_query", contextMenuOrder: 3, run: actions.format },
    { id: "dw-ai-format", label: "AI 格式化 SQL", precondition: "dwQueryIdle && editorHasSelection", contextMenuGroupId: "0_query", contextMenuOrder: 4, run: actions.aiFormat },
    { id: "dw-ai-optimize", label: "AI 优化 SQL", precondition: "dwQueryIdle && editorHasSelection", contextMenuGroupId: "0_query", contextMenuOrder: 5, run: actions.aiOptimize },
    { id: "dw-context-save", label: "保存 SQL 文件", precondition: "dwQueryFileIdle", contextMenuGroupId: "0_query_file", contextMenuOrder: 1, run: actions.save },
    { id: "dw-context-history", label: "打开查询历史中心", contextMenuGroupId: "0_query_file", contextMenuOrder: 2, run: actions.history },
  ];
  const handles = definitions.map(action => editor.addAction(action));
  return { dispose: () => handles.forEach(handle => handle.dispose()) };
}
