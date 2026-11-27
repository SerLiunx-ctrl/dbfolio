import { Button, Checkbox, Input, Popover, PopoverSurface, PopoverTrigger, Spinner } from "@fluentui/react-components";
import { ArrowClockwiseRegular, EyeOffRegular, EyeRegular, FilterRegular, SearchRegular } from "@fluentui/react-icons";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNotify } from "../../app/toast";
import { loadExplorerDatabaseVisibility, setExplorerHiddenDatabases, useExplorerVisibility } from "../../stores/useExplorerVisibility";
import "./database-visibility.css";

interface Props {
  sessionId: string;
  databases: readonly string[];
  busy: boolean;
  onRefresh: () => void;
}

export function DatabaseVisibilityButton({ sessionId, databases, busy, onRefresh }: Props) {
  const notify = useNotify();
  const hidden = useExplorerVisibility(state => state.hiddenDatabases[sessionId]);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    void loadExplorerDatabaseVisibility().catch(error => notify.error(error, "读取数据库显隐设置失败"));
  }, [notify]);

  const hiddenNames = useMemo(() => new Set(hidden), [hidden]);
  const shown = databases.filter(name => !hiddenNames.has(name)).length;
  const draftShown = databases.filter(name => !draft.has(name)).length;
  const keyword = search.trim().toLowerCase();
  const matches = databases.filter(name => name.toLowerCase().includes(keyword));

  const apply = () => {
    setOpen(false);
    const next = [...draft];
    if (next.length === hiddenNames.size && next.every(name => hiddenNames.has(name))) return;
    setSaving(true);
    void setExplorerHiddenDatabases(sessionId, next)
      .catch(error => notify.error(error, "保存数据库显隐设置失败"))
      .finally(() => setSaving(false));
  };

  const changeVisibility = (names: readonly string[], show: boolean) => {
    setDraft(current => {
      const next = new Set(current);
      for (const name of names) {
        if (show) next.delete(name);
        else next.add(name);
      }
      return next;
    });
  };

  return (
    <Popover
      size="small"
      open={open}
      positioning={{ position: "below", align: "end", fallbackPositions: ["above-end", "after-bottom"], overflowBoundaryPadding: 8 }}
      onOpenChange={(event, data) => {
        if (data.open) {
          void loadExplorerDatabaseVisibility().then(() => {
            setDraft(new Set(useExplorerVisibility.getState().hiddenDatabases[sessionId]));
            setSearch("");
            setOpen(true);
          }).catch(error => notify.error(error, "读取数据库显隐设置失败"));
        } else if ("key" in event && event.key === "Escape") {
          setOpen(false);
          trigger.current?.focus();
        } else {
          apply();
        }
      }}
    >
      <PopoverTrigger disableButtonEnhancement>
        <Button
          ref={trigger}
          size="small"
          appearance={shown < databases.length || open ? "secondary" : "subtle"}
          icon={<FilterRegular />}
          aria-label="显示或隐藏数据库"
          aria-expanded={open}
          aria-haspopup="dialog"
          title={"数据库显隐" + (databases.length ? " · " + shown + " / " + databases.length : "")}
          disabledFocusable={saving}
        />
      </PopoverTrigger>
      <PopoverSurface
        className="dw-database-visibility"
        role="dialog"
        aria-label="数据库显隐"
        onKeyDown={event => {
          if (event.key !== "Enter" || event.nativeEvent.isComposing || event.target instanceof HTMLButtonElement) return;
          event.preventDefault();
          event.stopPropagation();
          apply();
          trigger.current?.focus();
        }}
      >
        <div className="dw-database-visibility-header">
          <strong>数据库显隐</strong>
          <span className="dw-database-visibility-count" aria-live="polite">{draftShown} / {databases.length} 显示</span>
          <div className="dw-database-visibility-actions">
            <Button
              size="small"
              appearance="subtle"
              icon={<ArrowClockwiseRegular />}
              title="刷新数据库列表"
              aria-label="刷新数据库列表"
              disabledFocusable={busy}
              onClick={() => { if (!busy) onRefresh(); }}
            />
            <Button size="small" appearance="subtle" icon={<EyeRegular />} title="全部显示" aria-label="全部显示" disabled={draftShown === databases.length} onClick={() => changeVisibility(databases, true)} />
            <Button size="small" appearance="subtle" icon={<EyeOffRegular />} title="全部隐藏" aria-label="全部隐藏" disabled={draftShown === 0} onClick={() => changeVisibility(databases, false)} />
          </div>
        </div>
        <Input size="small" contentBefore={<SearchRegular />} aria-label="搜索数据库名" placeholder="搜索数据库名" value={search} onChange={(_, data) => setSearch(data.value)} />
        <div className="dw-database-visibility-list" role="group" aria-label="数据库列表" aria-busy={busy}>
          {matches.map(name => (
            <Checkbox
              key={name}
              label={<span title={name}>{name}</span>}
              checked={!draft.has(name)}
              onChange={(_, data) => changeVisibility([name], data.checked === true)}
            />
          ))}
          {!matches.length && (busy
            ? <Spinner size="tiny" label="读取数据库…" />
            : <p>{keyword ? "没有匹配的数据库" : "暂无数据库"}</p>)}
        </div>
        <div className="dw-database-visibility-footer">
          <span>Enter 或点击外部应用，Esc 取消</span>
          <Button size="small" appearance="primary" onClick={() => { apply(); trigger.current?.focus(); }}>应用</Button>
        </div>
      </PopoverSurface>
    </Popover>
  );
}
