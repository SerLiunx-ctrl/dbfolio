// 必须在编辑器模块求值前加载与当前 Monaco 版本匹配的简体中文资源。
import "monaco-editor/nls/lang/zh-cn";
import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
import editorWorker from "monaco-editor/editor/editor.worker?worker";

type MonacoEnvironmentLike = {
  getWorker: (moduleId: string, label: string) => Worker;
};

(self as unknown as { MonacoEnvironment: MonacoEnvironmentLike }).MonacoEnvironment = {
  getWorker: () => new editorWorker(),
};

loader.config({ monaco });

export { monaco };
