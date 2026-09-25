import { makeStyles, mergeClasses } from "@fluentui/react-components";
import { useEffect, useRef } from "react";

const useStyles = makeStyles({
  base: {
    flexShrink: 0,
    position: "relative",
    zIndex: 3,
    touchAction: "none",
    transition: "background-color 140ms cubic-bezier(0.33, 0, 0.67, 1)",
    ":hover": {
      backgroundColor: "color-mix(in srgb, var(--dw-accent) 40%, transparent)",
    },
    ":active": {
      backgroundColor: "color-mix(in srgb, var(--dw-accent) 65%, transparent)",
    },
  },
  horizontal: {
    width: "4px",
    marginLeft: "-2px",
    marginRight: "-2px",
    cursor: "col-resize",
  },
  vertical: {
    height: "4px",
    marginTop: "-2px",
    marginBottom: "-2px",
    cursor: "row-resize",
  },
});

interface Props {
  direction?: "horizontal" | "vertical";
  /** 面板在右侧/下方时，拖动方向与尺寸增量相反 */
  invert?: boolean;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  onCommit: (value: number) => void;
}

export function ResizeHandle({
  direction = "horizontal",
  invert = false,
  value,
  min,
  max,
  onChange,
  onCommit,
}: Props) {
  const styles = useStyles();
  const frame = useRef<number | null>(null);
  const stateRef = useRef<{ pointerId: number; start: number; startValue: number; last: number } | null>(
    null,
  );

  const isVertical = direction === "vertical";
  const cancelFrame = () => { if (frame.current !== null) cancelAnimationFrame(frame.current); frame.current = null; };
  useEffect(() => () => { if (frame.current !== null) cancelAnimationFrame(frame.current); }, []);
  const cancel = () => { cancelFrame(); const state = stateRef.current; stateRef.current = null; if (state) onChange(state.startValue); };

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label={isVertical ? "调整面板高度" : "调整面板宽度"}
      aria-orientation={isVertical ? "horizontal" : "vertical"}
      aria-valuemin={Math.round(min)} aria-valuemax={Math.round(max)} aria-valuenow={Math.round(value)}
      title="拖动调整；方向键微调，Home / End 到最小 / 最大，Esc 取消拖动"
      onKeyDown={event => {
        if (event.key === "Escape") { cancel(); return; }
        const keys = isVertical ? ["ArrowUp", "ArrowDown"] : ["ArrowLeft", "ArrowRight"];
        if (![...keys, "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === "Home" ? min : event.key === "End" ? max : Math.min(max, Math.max(min, value + (event.key === keys[0] ? -10 : 10) * (invert ? -1 : 1)));
        onChange(next); onCommit(next);
      }}
      className={mergeClasses(
        styles.base,
        isVertical ? styles.vertical : styles.horizontal,
      )}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        stateRef.current = {
          pointerId: event.pointerId,
          start: isVertical ? event.clientY : event.clientX,
          startValue: value,
          last: value,
        };
      }}
      onPointerMove={(event) => {
        const state = stateRef.current;
        if (!state || state.pointerId !== event.pointerId) return;
        const current = isVertical ? event.clientY : event.clientX;
        const delta = current - state.start;
        const next = Math.min(
          max,
          Math.max(min, state.startValue + (invert ? -delta : delta)),
        );
        state.last = next;
        if (frame.current === null) frame.current = requestAnimationFrame(() => { frame.current = null; if (stateRef.current) onChange(stateRef.current.last); });
      }}
      onPointerUp={(event) => {
        const state = stateRef.current;
        if (!state || state.pointerId !== event.pointerId) return;
        cancelFrame();
        stateRef.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
        onChange(state.last);
        onCommit(state.last);
      }}
      onPointerCancel={cancel}
      onLostPointerCapture={cancel}
    />
  );
}
