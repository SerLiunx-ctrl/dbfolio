import { useEffect, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import {
  Badge, Button, Checkbox, Dialog, DialogActions, DialogBody, DialogContent,
  DialogSurface, DialogTitle, Field, Input, Select, Spinner, Table, TableBody,
  TableCell, TableHeader, TableHeaderCell, TableRow,
} from "@fluentui/react-components";
import { CopyRegular, DeleteRegular, OpenRegular, StarFilled, StarRegular } from "@fluentui/react-icons";
import { InfoHint } from "../../common/InfoHint";
import { api, normalizeError } from "../../ipc";
import type { HistoryEntry } from "../../ipc/types";
import { useSessionStore } from "../../stores/useSessionStore";
import { loadLibrary, toggleHistory, useLibrary } from "../../stores/useLibrary";
import { useNotify } from "../../app/toast";
import { sqlLanguage } from "../../sqlLanguage";
import { useEditorTheme } from "../../useEditorTheme";
import { openSql } from "./openSql";
import "./history.css";

const PAGE_SIZE = 100;
const initialFilters = { text: "", sessionId: "", database: "", from: "", to: "", result: "", favorites: false };
type Filters = typeof initialFilters;

function sqlPreview(sql: string) {
  const text = sql.trimStart();
  return text.slice(0, 120).replace(/\s+/g, " ").trimEnd() + (text.length > 120 ? "…" : "");
}

function executionTime(entry: HistoryEntry) {
  // 历史的日期筛选按 UTC，展示与筛选使用同一时区。
  return entry.executedAt.slice(0, 19).replace("T", " ");
}

function HistoryResult({ success }: { success: boolean }) {
  return <Badge appearance="tint" color={success ? "success" : "danger"}>{success ? "成功" : "失败"}</Badge>;
}

export function HistoryCenter({ open, onClose }: { open: boolean; onClose: () => void }) {
  const sessions = useSessionStore(state => state.sessions);
  const saved = useLibrary(state => state.history);
  const notify = useNotify();
  const theme = useEditorTheme();
  const [filters, setFilters] = useState<Filters>(initialFilters);
  const [rows, setRows] = useState<HistoryEntry[]>([]);
  const [offset, setOffset] = useState(0);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [detail, setDetail] = useState<HistoryEntry | null>(null);
  const [pendingDelete, setPendingDelete] = useState<HistoryEntry | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [favoriteBusy, setFavoriteBusy] = useState<number | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const favoriteSource = filters.favorites ? saved : null;
  const savedIds = new Set(saved.map(entry => entry.id));

  useEffect(() => {
    if (open) void loadLibrary().catch(error => notify.error(error, "读取收藏失败"));
    else {
      setDetail(null);
      setPendingDelete(null);
    }
  }, [open, notify]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setBusy(true);
    setError("");
    const timer = setTimeout(async () => {
      try {
        const { text, sessionId, database, from, to, result } = filters;
        if (from && to && from > to) throw new Error("开始日期不能晚于结束日期");
        const success = result ? result === "success" : undefined;
        const query = text.trim().toLowerCase();
        const list = favoriteSource
          ? favoriteSource.filter(entry => {
            const date = entry.executedAt.slice(0, 10);
            return (!sessionId || entry.sessionId === sessionId)
              && (!database || entry.database === database)
              && entry.sql.toLowerCase().includes(query)
              && (!from || date >= from) && (!to || date <= to)
              && (success === undefined || entry.success === success);
          }).slice(offset, offset + PAGE_SIZE + 1)
          : await api.queryHistorySearch({ text, sessionId, database, from, to, success, offset });
        if (!active) return;
        if (!list.length && offset > 0) {
          setOffset(Math.max(0, offset - PAGE_SIZE));
          return;
        }
        setRows(list.slice(0, PAGE_SIZE));
        setMore(list.length > PAGE_SIZE);
      } catch (error) {
        if (active) {
          setRows([]);
          setMore(false);
          setError(normalizeError(error).message);
        }
      } finally {
        if (active) setBusy(false);
      }
    }, 250);
    return () => { active = false; clearTimeout(timer); };
  }, [open, filters, favoriteSource, offset, revision]);

  useEffect(() => {
    if (open && !detail && !pendingDelete) searchInput.current?.focus();
  }, [open, detail, pendingDelete]);

  function changeFilters(patch: Partial<Filters>) {
    setFilters(previous => ({ ...previous, ...patch }));
    setOffset(0);
  }

  async function reopen(entry: HistoryEntry) {
    setOpening(true);
    try {
      await openSql(entry.sessionId, entry.database ?? "", entry.sql);
      onClose();
    } catch (error) {
      notify.error(error, "重新打开失败");
    } finally {
      setOpening(false);
    }
  }

  async function changeFavorite(entry: HistoryEntry) {
    setFavoriteBusy(entry.id);
    try {
      await toggleHistory(entry);
    } catch (error) {
      notify.error(error, "更新收藏失败");
    } finally {
      setFavoriteBusy(null);
    }
  }

  async function removeHistory(entry: HistoryEntry) {
    setDeleting(true);
    try {
      await api.queryHistoryDelete(entry.id);
      setRows(previous => previous.filter(row => row.id !== entry.id));
      setPendingDelete(null);
      setRevision(previous => previous + 1);
    } catch (error) {
      notify.error(error, "删除查询历史失败");
    } finally {
      setDeleting(false);
    }
  }

  const detailSession = sessions.find(session => session.id === detail?.sessionId);
  const maxWidth = pendingDelete ? 480 : detail ? 900 : 1120;
  function closeView() {
    if (opening || deleting) return;
    if (pendingDelete) setPendingDelete(null);
    else if (detail) setDetail(null);
    else onClose();
  }

  return <Dialog open={open} modalType={pendingDelete ? "alert" : "modal"} onOpenChange={(_, data) => {
    if (!data.open) closeView();
  }}>
    <DialogSurface style={{ width: "min(" + maxWidth + "px, 94vw)", maxWidth: "94vw" }}>
      <DialogBody>
        <DialogTitle>{pendingDelete ? "删除查询历史" : detail ? "查询详情" : "查询历史中心"}</DialogTitle>
        {!detail && !pendingDelete && <>
          <DialogContent className="dw-history-content">
            <div className="dw-history-filters">
              <Field label="搜索 SQL" className="dw-history-search">
                <Input ref={searchInput} size="small" value={filters.text} onChange={(_, data) => changeFilters({ text: data.value })} />
              </Field>
              <Field label="连接" className="dw-history-connection">
                <Select size="small" value={filters.sessionId} onChange={(_, data) => changeFilters({ sessionId: data.value })}>
                  <option value="">全部连接</option>
                  {sessions.filter(session => ["mysql", "postgres", "sqlite", "dameng"].includes(session.engine)).map(session =>
                    <option key={session.id} value={session.id}>{session.name}</option>
                  )}
                </Select>
              </Field>
              <Field label="数据库（完整名称）">
                <Input size="small" value={filters.database} onChange={(_, data) => changeFilters({ database: data.value })} />
              </Field>
              <Field label="开始日期（UTC）">
                <Input size="small" type="date" value={filters.from} onChange={(_, data) => changeFilters({ from: data.value })} />
              </Field>
              <Field label="结束日期（UTC）">
                <Input size="small" type="date" value={filters.to} onChange={(_, data) => changeFilters({ to: data.value })} />
              </Field>
              <Field label="执行结果">
                <Select size="small" value={filters.result} onChange={(_, data) => changeFilters({ result: data.value })}>
                  <option value="">全部结果</option>
                  <option value="success">成功</option>
                  <option value="error">失败</option>
                </Select>
              </Field>
            </div>
            <div className="dw-history-controls">
              <Checkbox label="仅收藏" checked={filters.favorites} onChange={(_, data) => changeFilters({ favorites: data.checked === true })} />
              <InfoHint label="历史保存说明">历史保留上限可在首选项的「本机数据」中调整。收藏另行保存。重新打开只将 SQL 填入新页签。</InfoHint>
              {busy && <Spinner size="tiny" label="加载记录…" />}
            </div>
            <div className="dw-history-table-scroll" role="region" aria-label="查询历史列表" tabIndex={0} aria-busy={busy}>
              <Table size="small" className="dw-history-table" aria-label="查询历史">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>SQL 摘要</TableHeaderCell>
                    <TableHeaderCell className="dw-history-context">连接 / 数据库</TableHeaderCell>
                    <TableHeaderCell className="dw-history-result">结果</TableHeaderCell>
                    <TableHeaderCell className="dw-history-duration">耗时</TableHeaderCell>
                    <TableHeaderCell className="dw-history-time">时间（UTC）</TableHeaderCell>
                    <TableHeaderCell className="dw-history-operation">操作</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {!busy && rows.map(entry => {
                    const sessionName = sessions.find(session => session.id === entry.sessionId)?.name;
                    const favorite = savedIds.has(entry.id);
                    return <TableRow key={entry.id}>
                      <TableCell><code className="dw-history-clip">{sqlPreview(entry.sql)}</code></TableCell>
                      <TableCell>
                        <span className="dw-history-clip" title={sessionName}>{sessionName ?? "已删除连接"}</span>
                        <span className="dw-history-clip dw-history-secondary" title={entry.database ?? undefined}>{entry.database || "—"}</span>
                      </TableCell>
                      <TableCell><HistoryResult success={entry.success} /></TableCell>
                      <TableCell title="后端数据库请求及结果读取耗时">
                        {entry.durationMs == null ? "—" : entry.durationMs + " ms"}
                      </TableCell>
                      <TableCell><time dateTime={entry.executedAt}>{executionTime(entry)}</time></TableCell>
                      <TableCell><div className="dw-history-actions">
                        <Button size="small" appearance="subtle" onClick={() => setDetail(entry)}>详情</Button>
                        <Button size="small" appearance="subtle" icon={<OpenRegular />} disabled={!sessionName || opening}
                          aria-label="重新打开" title="在新查询页签打开 SQL" onClick={() => void reopen(entry)} />
                        <Button size="small" appearance="subtle" icon={favorite ? <StarFilled /> : <StarRegular />}
                          aria-pressed={favorite} disabled={favoriteBusy !== null} aria-label={favorite ? "取消收藏" : "收藏"}
                          title={favorite ? "取消收藏" : "收藏"} onClick={() => void changeFavorite(entry)} />
                        {!filters.favorites && <Button size="small" appearance="subtle" icon={<DeleteRegular />}
                          aria-label="删除历史记录" title="删除历史记录" onClick={() => setPendingDelete(entry)} />}
                      </div></TableCell>
                    </TableRow>;
                  })}
                </TableBody>
              </Table>
              {error && <p role="alert" className="dw-history-empty">{error}</p>}
              {!busy && !error && !rows.length && <p className="dw-history-empty">没有匹配记录</p>}
            </div>
          </DialogContent>
          <DialogActions>
            <Button size="small" disabled={!offset || busy} onClick={() => setOffset(offset - PAGE_SIZE)}>上一页</Button>
            <span className="dw-history-page">第 {offset / PAGE_SIZE + 1} 页</span>
            <Button size="small" disabled={!more || busy} onClick={() => setOffset(offset + PAGE_SIZE)}>下一页</Button>
            <Button size="small" disabled={opening} onClick={onClose}>关闭</Button>
          </DialogActions>
        </>}
        {detail && <>
          <DialogContent className="dw-history-detail">
            <div className="dw-history-metadata">
              <HistoryResult success={detail.success} />
              <span>{detailSession?.name ?? "已删除连接"}{detail.database && " / " + detail.database}</span>
              <time dateTime={detail.executedAt}>{executionTime(detail)} UTC</time>
              {detail.durationMs != null && <span>{detail.durationMs} ms</span>}
              {detail.rowsAffected != null && <span>记录行数 {detail.rowsAffected}</span>}
            </div>
            {detail.errorCode && <div className="dw-history-error">错误代码 {detail.errorCode}</div>}
            <div className="dw-history-editor">
              <Editor language={sqlLanguage(detailSession?.engine)} value={detail.sql}
                theme={theme.name} beforeMount={theme.beforeMount}
                options={{
                  ariaLabel: "历史 SQL", readOnly: true, domReadOnly: true, automaticLayout: true,
                  minimap: { enabled: false }, lineNumbers: "on", fontSize: 13,
                  scrollBeyondLastLine: false, wordWrap: "on", tabSize: 2, renderLineHighlight: "none",
                }} />
            </div>
          </DialogContent>
          <DialogActions>
            <Button size="small" icon={<CopyRegular />} onClick={() => void api.clipboardWriteText(detail.sql)
              .then(() => notify.success("已复制 SQL")).catch(error => notify.error(error, "复制 SQL 失败"))}>复制 SQL</Button>
            <Button size="small" icon={<OpenRegular />} disabled={!detailSession || opening} onClick={() => void reopen(detail)}>重新打开</Button>
            <Button autoFocus size="small" appearance="primary" disabled={opening} onClick={closeView}>返回列表</Button>
          </DialogActions>
        </>}
        {pendingDelete && <>
          <DialogContent>
            此操作将删除这条本机历史记录。{savedIds.has(pendingDelete.id) && "该 SQL 已收藏，仍可在收藏中查看。"}
            <code className="dw-history-delete-summary">{sqlPreview(pendingDelete.sql)}</code>
          </DialogContent>
          <DialogActions>
            <Button autoFocus size="small" disabled={deleting} onClick={closeView}>取消</Button>
            <Button size="small" appearance="primary" disabled={deleting} onClick={() => void removeHistory(pendingDelete)}>
              {deleting ? "删除中…" : "删除"}
            </Button>
          </DialogActions>
        </>}
      </DialogBody>
    </DialogSurface>
  </Dialog>;
}
