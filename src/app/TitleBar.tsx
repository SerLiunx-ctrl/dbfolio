import { makeStyles, tokens, Button } from "@fluentui/react-components";
import {
  DismissRegular,
  SquareMultipleRegular,
  SquareRegular,
  SubtractRegular,
} from "@fluentui/react-icons";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState, type ReactNode } from "react";

const useStyles = makeStyles({
  bar: {
    height: "40px",
    flexShrink: 0,
    display: "flex",
    alignItems: "stretch",
    justifyContent: "space-between",
  },
  drag: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    paddingLeft: "14px",
    minWidth: 0,
  },
  title: {
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground2,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  controls: {
    display: "flex",
    alignItems: "stretch",
    flexShrink: 0,
  },
  controlButton: {
    minWidth: "46px",
    width: "46px",
    height: "100%",
    borderRadius: 0,
    color: tokens.colorNeutralForeground2,
  },
  closeButton: {
    minWidth: "46px",
    width: "46px",
    height: "100%",
    borderRadius: 0,
    color: tokens.colorNeutralForeground2,
    ":hover": {
      backgroundColor: "#c42b1c",
      color: "#ffffff",
    },
  },
});

export function TitleBar({ children }: { children?: ReactNode }) {
  const styles = useStyles();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    let unlisten: (() => void) | undefined;

    appWindow.isMaximized().then(setMaximized).catch(() => {});

    appWindow
      .onResized(() => {
        appWindow.isMaximized().then(setMaximized).catch(() => {});
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});

    return () => unlisten?.();
  }, []);

  const appWindow = getCurrentWindow();

  return (
    <header className={styles.bar + " dw-window-titlebar"}>
      <div className={styles.drag} data-tauri-drag-region>
        <img src="/app-icon.svg" width={22} height={22} alt="" draggable={false} data-tauri-drag-region />
        <span className={styles.title} data-tauri-drag-region>
          DBFolio
        </span>
      </div>
      {children}
      <div style={{ flex: 1, minWidth: 20 }} data-tauri-drag-region />
      <div className={styles.controls}>
        <Button
          appearance="subtle"
          className={styles.controlButton}
          icon={<SubtractRegular />}
          aria-label="最小化"
          onClick={() => appWindow.minimize()}
        />
        <Button
          appearance="subtle"
          className={styles.controlButton}
          icon={maximized ? <SquareMultipleRegular /> : <SquareRegular />}
          aria-label={maximized ? "还原" : "最大化"}
          onClick={() => appWindow.toggleMaximize()}
        />
        <Button
          appearance="subtle"
          className={styles.closeButton}
          icon={<DismissRegular />}
          aria-label="关闭"
          onClick={() => appWindow.close()}
        />
      </div>
    </header>
  );
}
