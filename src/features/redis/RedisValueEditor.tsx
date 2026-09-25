import { useEditorTheme } from "../../useEditorTheme";
import Editor from "@monaco-editor/react";
import { makeStyles, tokens } from "@fluentui/react-components";
import { useIsDark } from "../../theme";
import type { EditorLanguage } from "./format";
import { useEffect, useRef, useState } from "react";

const useStyles = makeStyles({
  wrap: {
    background: tokens.colorNeutralBackground1,
    overflow: "hidden",
    flexShrink: 0,
    transition: "height 140ms ease-out",
    "@media (prefers-reduced-motion: reduce)": { transition: "none" },
    "& .monaco-editor .margin": {
      borderRight: "1px solid var(--dw-editor-gutter-border)",
    },
  },
});


interface Props {
  value: string;
  language: EditorLanguage;
  height?: number;
  readOnly?: boolean;
  onChange: (value: string) => void;
}

export function RedisValueEditor({
  value,
  language,
  height,
  readOnly = false,
  onChange,
}: Props) {
  const styles = useStyles();
  const dark = useIsDark();
  const editorTheme=useEditorTheme();
  const [contentHeight, setContentHeight] = useState(140);
  const subscription = useRef<{ dispose: () => void } | null>(null);
  useEffect(() => () => subscription.current?.dispose(), []);

  return (
    <div
      className={styles.wrap}
      style={
        {
          height: height ?? contentHeight,
          "--dw-editor-gutter-border": dark
            ? "rgba(255, 255, 255, 0.12)"
            : "rgba(0, 0, 0, 0.10)",
        } as React.CSSProperties
      }
    >
      <Editor
        language={language}
        theme={editorTheme.name} beforeMount={editorTheme.beforeMount}
        onMount={(editor) => {
          subscription.current?.dispose();
          const resize = () => setContentHeight(Math.max(140, Math.min(360, editor.getContentHeight())));
          subscription.current = editor.onDidContentSizeChange(resize);
          resize();
        }}
        value={value}
        onChange={(next) => onChange(next ?? "")}
        options={{
          minimap: { enabled: false },
          fontSize: 12,
          lineNumbers: "on",
          lineNumbersMinChars: 3,
          glyphMargin: false,
          folding: false,
          scrollBeyondLastLine: false,
          automaticLayout: true,
          wordWrap: "on",
          tabSize: 2,
          renderLineHighlight: "none",
          overviewRulerLanes: 0,
          scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
          padding: { top: 8, bottom: 8 },
          readOnly,
          contextmenu: true,
          fixedOverflowWidgets: true,
        }}
      />
    </div>
  );
}
