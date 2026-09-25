import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("界面渲染出错", error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            height: "100%",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: "12px",
            padding: "32px",
            color: "#444",
            fontSize: "13px",
          }}
        >
          <div style={{ fontSize: "16px", fontWeight: 600 }}>界面渲染出错</div>
          <pre
            style={{
              maxWidth: "640px",
              maxHeight: "200px",
              overflow: "auto",
              padding: "12px",
              borderRadius: "6px",
              background: "rgba(128,128,128,0.12)",
              whiteSpace: "pre-wrap",
              userSelect: "text",
            }}
          >
            {String(this.state.error?.message ?? this.state.error)}
          </pre>
          <div style={{ display: "flex", gap: "8px" }}>
            <button onClick={() => this.setState({ error: null })}>返回</button>
            <button onClick={() => window.location.reload()}>重新加载</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
