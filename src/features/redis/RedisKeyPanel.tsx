import {useSessionReadOnly} from "../../stores/useSessionReadOnly";
import { confirmEdits, usePendingEdit } from "../../stores/useEditGuard";
import { FavoriteButton } from "../explorer/FavoriteButton";
import { mergePreview } from "./mergePreview";
import { reloadPreview } from "./reloadPreview";
import {
  Badge,
  Button,
  Input,
  Spinner,
  Textarea,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import {
  ArrowClockwiseRegular,
  CopyRegular,
  DeleteRegular,
  EditRegular,
  CodeRegular,
  KeyRegular,
  ArrowExpandRegular,
  ArrowMinimizeRegular,
  RenameRegular,
  SaveRegular,
  TimerRegular,
} from "@fluentui/react-icons";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNotify } from "../../app/toast";
import { api } from "../../ipc";
import type { RedisEditOp, RedisKeyPreview } from "../../ipc/types";
import type { RedisTab } from "../../stores/useTabStore";
import {
  detectEditorLanguage,
  detectTextFormat,
  formatBytes,
  formatTtl,
  minifyJson,
  prettifyByFormat,
  typeBadgeColor,
  type EditorLanguage,
  type TextFormat,
} from "./format";
import type { RedisKeyChange, RedisKeyDialog } from "./keyTypes";
import { RedisValueEditor } from "./RedisValueEditor";

const useStyles = makeStyles({
  pane: {
    flex: 1,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    overflow: "auto",
    minWidth: 0,
    background: tokens.colorNeutralBackground2,
  },
  header: {
    padding: "14px 14px 10px",
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    flexShrink: 0,
    background: "linear-gradient(120deg, color-mix(in srgb, var(--dw-accent) 9%, transparent), transparent)",
  },
  heading: {
    display: "flex", alignItems: "center", gap: "8px",
    fontSize: tokens.fontSizeBase200, fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground2, marginBottom: "10px",
  },
  key: {
    fontFamily: '"Cascadia Mono", Consolas, monospace',
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    padding: "8px 10px",
    borderRadius: "6px",
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    background: tokens.colorNeutralBackground1,
    userSelect: "text",
  },
  actions: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    marginTop: "10px",
    flexWrap: "wrap",
  },
  body: {
    padding: "12px 14px 20px",
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    flexShrink: 0,
    minWidth: 0,
  },
  metrics: {
    display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: "1px", background: tokens.colorNeutralStroke2,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: "8px", overflow: "hidden",
  },
  metric: {
    padding: "9px 12px", minWidth: 0, background: tokens.colorNeutralBackground1,
    display: "flex", flexDirection: "column", gap: "4px",
    "& dt": { color: tokens.colorNeutralForeground3, fontSize: "10px" },
    "& dd": { margin: 0, fontWeight: tokens.fontWeightSemibold, fontSize: "12px", overflowWrap: "anywhere" },
  },
  contentCard: {
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: "8px",
    overflow: "hidden", background: tokens.colorNeutralBackground1,
  },
  contentTitle: {
    display: "flex", alignItems: "center", gap: "6px", padding: "8px 10px",
    flexWrap: "wrap", borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    fontSize: tokens.fontSizeBase200, fontWeight: tokens.fontWeightSemibold,
  },
  editorFooter: {
    display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap",
    padding: "6px 10px", borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    fontSize: tokens.fontSizeBase100, color: tokens.colorNeutralForeground3,
  },
  deleteAction: {
    color: tokens.colorPaletteRedForeground1,
  },
  addRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: "6px",
    alignItems: "center",
    paddingBottom: "6px",
    borderBottom: `1px dashed ${tokens.colorNeutralStroke3}`,
    marginBottom: "4px",
  },
  grow: { flex: 1, minWidth: "120px" },
  row: {
    display: "grid",
    gridTemplateColumns: "auto minmax(0, 1fr) auto",
    gap: "8px",
    alignItems: "start",
    padding: "8px",
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: "6px",
    background: tokens.colorNeutralBackground1,
    fontSize: tokens.fontSizeBase200,
  },
  index: {
    color: tokens.colorNeutralForeground4,
    minWidth: "18px",
    textAlign: "right",
    fontFamily: '"Cascadia Mono", Consolas, monospace',
  },
  field: {
    fontFamily: '"Cascadia Mono", Consolas, monospace',
    color: tokens.colorNeutralForeground3,
    wordBreak: "break-all",
  },
  value: {
    fontFamily: '"Cascadia Mono", Consolas, monospace',
    wordBreak: "break-all",
    whiteSpace: "pre-wrap",
    userSelect: "text",
  },
  rowActions: {
    display: "flex",
    gap: "2px",
    alignItems: "center",
  },
  placeholder: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    padding: "24px 16px",
    textAlign: "center",
  },
  note: {
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground4,
  },
  error: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorPaletteRedForeground1,
  },
  warning: {
    color: tokens.colorPaletteYellowForeground1,
    fontSize: tokens.fontSizeBase200,
    paddingBottom: "4px",
  },
});

interface Props {
  tab: RedisTab;
  keyName: string | null;
  onChanged: (change: RedisKeyChange) => void;
  onAction: (action: RedisKeyDialog) => void;
}

export function RedisKeyPanel({ tab, keyName, onChanged, onAction }: Props) {
  const readOnly=useSessionReadOnly(tab.sessionId);
  const styles = useStyles();
  const notify = useNotify();
  const databaseIndex = useMemo(() => {
    const text = tab.database.startsWith("db") ? tab.database.slice(2) : tab.database;
    const parsed = Number.parseInt(text, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }, [tab.database]);

  const [preview, setPreview] = useState<RedisKeyPreview | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const requestVersion = useRef(0);
  const activeKey = useRef<string | null>(null);
  const [showLoading, setShowLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stringDraft, setStringDraft] = useState("");
  const [stringBaseline, setStringBaseline] = useState("");
  const [textFormat, setTextFormat] = useState<TextFormat>("text");
  const [editorLanguage, setEditorLanguage] = useState<EditorLanguage>("plaintext");
  const [formatError, setFormatError] = useState<string | null>(null);
  const [editIndex, setEditIndex] = useState<number | null>(null);
  const [editValue, setEditValue] = useState("");
  const [addValue, setAddValue] = useState("");
  const [zsetMember, setZsetMember] = useState("");
  const [zsetScore, setZsetScore] = useState("");
  const [hashField, setHashField] = useState("");
  const [hashValue, setHashValue] = useState("");
  const [streamDraft, setStreamDraft] = useState("");
  const [expandedEditor, setExpandedEditor] = useState(false);
  const [memberSearch, setMemberSearch] = useState("");
  const [memberPage, setMemberPage] = useState(0);
  const paneRef = useRef<HTMLDivElement>(null);
  const browseRef = useRef({count:100,page:0,search:""});
  browseRef.current = {count:preview?.entries.length ?? 100,page:memberPage,search:memberSearch};
  const restoreScroll = useRef<number | null>(null);
  useLayoutEffect(()=>{
    if(restoreScroll.current !== null && paneRef.current?.parentElement) {
      paneRef.current.parentElement.scrollTop = restoreScroll.current;
      restoreScroll.current = null;
    }
  },[preview,memberPage]);

  const load = useCallback(
    async (key: string, preserve = false) => {
      if (activeKey.current !== key) return;
      const version = ++requestVersion.current;
      const isCurrent = () => version === requestVersion.current && activeKey.current === key;
      setLoading(true);
      setLoadError(false);
      const browse = browseRef.current;
      const scroll = paneRef.current?.parentElement?.scrollTop ?? 0;
      try {
        let data = await reloadPreview(cursor=>api.redisKeyPreview(tab.sessionId, databaseIndex, key, 100,cursor),preserve ? browse.count : 100,isCurrent);
        if (!isCurrent()) return;
        if (data.kind === "string" && data.truncated) {
          data = await api.redisKeyPreview(tab.sessionId, databaseIndex, key, 1_000_000);
        }
        if (!isCurrent()) return;
        setPreview(data);
        const matches = data.entries.filter(entry=>`${entry.field ?? ""} ${entry.value}`.toLowerCase().includes(browse.search.toLowerCase())).length;
        setMemberPage(preserve ? Math.min(browse.page,Math.max(0,Math.ceil(matches/100)-1)) : 0);
        restoreScroll.current = preserve ? scroll : 0;
        setLoadedKey(key);
        if (data.kind === "string") {
          const raw = data.entries[0]?.value ?? "";
          const format = detectTextFormat(raw);
          const pretty =
            format === "text" ? raw : (prettifyByFormat(raw, format) ?? raw);
          setStringDraft(pretty);
          setStringBaseline(pretty);
          setTextFormat(format);
          setEditorLanguage(detectEditorLanguage(raw));
          setFormatError(null);
        } else {
          setStringDraft("");
          setStringBaseline("");
          setTextFormat("text");
          setEditorLanguage("plaintext");
          setFormatError(null);
        }
        setEditIndex(null);
      } catch (error) {
        if (!isCurrent()) return;
        notify.error(error, "读取键失败");
        setLoadError(true);
      } finally {
        if (isCurrent()) setLoading(false);
      }
    },
    [tab.sessionId, databaseIndex, notify],
  );

  useLayoutEffect(() => {
    setMemberSearch("");
    activeKey.current = keyName;
    if (keyName) void load(keyName);
    else {
      setPreview(null);
      setLoadedKey(null);
      setLoading(false);
    }
    return () => {
      activeKey.current = null;
      requestVersion.current += 1;
    };
  }, [keyName, load]);

  // 快请求不闪一下加载图标；慢请求才显示，并预留位置避免按钮跳动。
  useEffect(() => {
    if (!loading) { setShowLoading(false); return; }
    const timer = window.setTimeout(() => setShowLoading(true), 160);
    return () => window.clearTimeout(timer);
  }, [loading]);

  const switching = loadedKey !== keyName;
  const locked = loading || busy || switching || loadError;
  const writeLocked=locked || readOnly;

  const loadMore = async () => {
    if (!preview?.nextCursor || !keyName || locked) return;
    if (!await confirmEdits(entry => entry.tabId === tab.id)) return;
    const key = keyName;
    const version = requestVersion.current;
    setBusy(true);
    try {
      const next = await api.redisKeyPreview(tab.sessionId, databaseIndex, key, 100, preview.nextCursor);
      if (activeKey.current !== key || requestVersion.current !== version) return;
      setPreview(mergePreview(preview, next));
    } catch (error) { notify.error(error, "加载更多成员失败"); }
    finally { setBusy(false); }
  };

  const runEdit = async (edit: RedisEditOp, message: string) => {
    if (!keyName || writeLocked) return false;
    setBusy(true);
    try {
      await api.redisEdit(tab.sessionId, databaseIndex, keyName, edit);
      notify.success(message, keyName);
      await load(keyName,true);
      onChanged({});
      return true;
    } catch (error) {
      notify.error(error, `${message}失败`);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const commitRowEdit = async () => {
    if (!preview || !keyName || editIndex === null) return;
    const entry = preview.entries[editIndex];
    if (!entry) return;
    if (preview.kind === "list") {
      if(!await runEdit({ op: "listSet", index: editIndex, value: editValue }, "改写元素"))return;
    } else if (preview.kind === "zset") {
      const score = Number(editValue);
      if (!Number.isFinite(score)) {
        notify.error(new Error("分值必须是数字"), "无效的分值");
        return;
      }
      if(!await runEdit({ op: "zAdd", member: entry.value, score }, "更新分值"))return;
    } else if (preview.kind === "hash" && entry.field) {
      if(!await runEdit({ op: "hashSet", field: entry.field, value: editValue }, "更新字段"))return;
    }
    setEditIndex(null);
  };

  const removeRow = async (index: number) => {
    if (!preview || !keyName) return;
    const entry = preview.entries[index];
    if (!entry) return;
    if (preview.kind === "list") {
      await runEdit({ op: "listRemove", value: entry.value, count: 1 }, "删除元素");
    } else if (preview.kind === "set") {
      await runEdit({ op: "setRemove", member: entry.value }, "删除成员");
    } else if (preview.kind === "zset") {
      await runEdit({ op: "zRemove", member: entry.value }, "删除成员");
    } else if (preview.kind === "hash" && entry.field) {
      await runEdit({ op: "hashRemove", field: entry.field }, "删除字段");
    }
  };

  const handleStreamAdd = async () => {
    const fields = streamDraft
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const separator = line.indexOf("=");
        if (separator <= 0) return null;
        return {
          field: line.slice(0, separator).trim(),
          value: line.slice(separator + 1),
        };
      });
    if (fields.length === 0 || fields.some((item) => item === null)) {
      notify.error(new Error("格式应为每行 field=value"), "字段格式不正确");
      return;
    }
    await runEdit(
      { op: "streamAdd", fields: fields as { field: string; value: string }[] },
      "追加条目",
    );
    setStreamDraft("");
  };

  const handleFormat = () => {
    const format =
      textFormat !== "text" ? textFormat : detectTextFormat(stringDraft);
    const formatted = prettifyByFormat(stringDraft, format);
    if (formatted === null) {
      setFormatError(
        format === "json" ? "JSON 解析失败，请检查语法" : "XML 解析失败，请检查语法",
      );
      return;
    }
    setStringDraft(formatted);
    setTextFormat(format);
    setEditorLanguage(detectEditorLanguage(formatted));
    setFormatError(null);
  };

  const handleMinify = () => {
    const minified = minifyJson(stringDraft);
    if (minified === null) {
      setFormatError("JSON 解析失败，请检查语法");
      return;
    }
    setStringDraft(minified);
    setTextFormat("json");
    setEditorLanguage("json");
    setFormatError(null);
  };

  const handleStringChange = (next: string) => {
    setStringDraft(next);
    setEditorLanguage(detectEditorLanguage(next));
  };

  usePendingEdit({tabId:tab.id,sessionId:tab.sessionId,label: (loadedKey ?? "Redis") + "（Redis 值）",busy:()=>busy,
    save: async()=>{
      if(writeLocked||!loadedKey||!preview)throw new Error("当前值无法保存，请等待加载完成");
      const edits:RedisEditOp[]=[];
      if(preview.kind==="string"){
        if(preview.truncated)throw new Error("截断值不能保存");
        edits.push({op:"setString",value:stringDraft,ttlMs:null});
      } else {
        if(editIndex!==null){const entry=preview.entries[editIndex];
          if(preview.kind==="list")edits.push({op:"listSet",index:editIndex,value:editValue});
          if(preview.kind==="hash"&&entry?.field)edits.push({op:"hashSet",field:entry.field,value:editValue});
          if(preview.kind==="zset"){if(!Number.isFinite(Number(editValue)))throw new Error("分值无效");edits.push({op:"zAdd",member:entry.value,score:Number(editValue)});}
        }
        if(addValue&&preview.kind==="list")edits.push({op:"listPush",value:addValue,head:false});
        if(addValue&&preview.kind==="set")edits.push({op:"setAdd",member:addValue});
        if(preview.kind==="hash"&&(hashField||hashValue)){if(!hashField)throw new Error("请填写字段名");edits.push({op:"hashSet",field:hashField,value:hashValue});}
        if(preview.kind==="zset"&&(zsetMember||zsetScore)){if(!zsetMember||!Number.isFinite(Number(zsetScore)))throw new Error("请填写成员及有效分值");edits.push({op:"zAdd",member:zsetMember,score:Number(zsetScore)});}
        if(preview.kind==="stream"&&streamDraft){const fields=streamDraft.split(/\r?\n/).filter(Boolean).map(line=>{const i=line.indexOf("=");if(i<=0)throw new Error("Stream 每行应为 field=value");return {field:line.slice(0,i),value:line.slice(i+1)};});edits.push({op:"streamAdd",fields});}
      }
      for(const edit of edits)await api.redisEdit(tab.sessionId,databaseIndex,loadedKey,edit);
      setStringBaseline(stringDraft);setEditIndex(null);setAddValue("");setHashField("");setHashValue("");setStreamDraft("");setZsetMember("");setZsetScore("");onChanged({});
    },
    discard:()=>{setStringDraft(stringBaseline);setEditIndex(null);setAddValue("");setHashField("");setHashValue("");setStreamDraft("");setZsetMember("");setZsetScore("");},
  }, busy || (preview?.kind === "string" ? stringDraft !== stringBaseline : editIndex!==null || !!(addValue||hashField||hashValue||streamDraft||zsetMember||zsetScore)));

  if (!keyName) {
    return (
      <div className={styles.placeholder}>
        点击键名查看与编辑
        <br />
        （支持 String / List / Set / ZSet / Hash / Stream）
      </div>
    );
  }

  const dirty = preview?.kind === "string" && stringDraft !== stringBaseline;

  return (
    <div className={styles.pane + " dw-redis-detail"} ref={paneRef}>
      <div className={styles.header}>
        <div className={styles.heading}>
          <KeyRegular style={{ color: tokens.colorBrandForeground1 }} />
          <span>键详情</span>
          <span style={{ flex: 1 }} />
          {preview && <Badge appearance="tint" size="small" color={typeBadgeColor(preview.kind)}>{preview.kind}</Badge>}
        </div>
        <div className={styles.key} title={preview ? loadedKey ?? keyName : keyName}>{preview ? loadedKey ?? keyName : keyName}</div>
        <FavoriteButton item={{sessionId: tab.sessionId, database: tab.database, kind: "redis", name: loadedKey ?? keyName}} />
        <div className={styles.actions}>
          <span style={{ width: 16, height: 16, flexShrink: 0 }}>{((showLoading && loading) || busy) && <Spinner size="tiny" />}</span>
          <div style={{ flex: 1 }} />
          <Button
            size="small"
            appearance="subtle"
            icon={<RenameRegular />}
            title="重命名键"
            aria-label="重命名键"
            disabled={writeLocked}
            onClick={() => onAction("rename")}
          >重命名</Button>
          <Button
            size="small"
            appearance="subtle"
            icon={<TimerRegular />}
            title="设置 TTL"
            aria-label="设置过期时间"
            disabled={writeLocked}
            onClick={() => onAction("ttl")}
          >过期时间</Button>
          <Button
            size="small"
            appearance="subtle"
            icon={<CopyRegular />}
            disabled={locked}
            title="复制键名"
            aria-label="复制键名"
            onClick={() => {
              void navigator.clipboard.writeText(keyName);
              notify.success("已复制键名", keyName);
            }}
          />
          <Button
            size="small"
            appearance="subtle"
            icon={<ArrowClockwiseRegular />}
            title="刷新"
            aria-label="刷新键详情"
            disabled={loading || busy}
            onClick={async () => {if(await confirmEdits(e=>e.tabId===tab.id))await load(keyName);}}
          />
          <Button
            size="small"
            appearance="subtle"
            icon={<DeleteRegular />}
            title="删除键"
            aria-label="删除键"
            className={styles.deleteAction}
            disabled={writeLocked}
            onClick={() => onAction("delete")}
          />
        </div>
      </div>

      <div role="status" className={styles.note} style={{ padding: "0 14px", minHeight: 20, flexShrink: 0 }}>
        {loadError ? "读取失败，请刷新重试。" : showLoading && loading
          ? preview ? "正在加载所选键，暂时保留上一份内容…" : "正在读取键内容…"
          : null}
      </div>
      <div className={styles.body} inert={locked} aria-busy={loading}>
        {preview && <dl className={styles.metrics} style={{ margin: 0 }}>
          <div className={styles.metric}><dt>剩余有效期</dt><dd>{formatTtl(preview.ttlMs)}</dd></div>
          <div className={styles.metric} title="MEMORY USAGE，包含编码与分配开销"><dt>内存占用</dt><dd>{preview.size == null ? "—" : formatBytes(preview.size)}</dd></div>
          <div className={styles.metric}><dt>{preview.kind === "string" ? "值长度（字节）" : "元素数量"}</dt><dd>{preview.length == null ? "—" : preview.length.toLocaleString()}</dd></div>
          <div className={styles.metric} title="OBJECT ENCODING"><dt>内部编码</dt><dd>{preview.encoding || "—"}</dd></div>
        </dl>}
        {preview?.binary && (
          <div className={styles.warning}>值包含非 UTF-8 字节，按十六进制展示（编辑将整体覆盖）</div>
        )}

        {preview && preview.kind !== "string" && (
          <div className={styles.heading} style={{ marginBottom: 0 }}>
            <CodeRegular /><span>成员内容</span>
            <span style={{ flex: 1 }} />
            <span className={styles.note}>已加载 {preview.entries.length} 项</span>
            <span className={styles.note}>共 {preview.length ?? "—"} 项</span>
          </div>
        )}

        {preview && preview.kind !== "string" && <div style={{display:"flex",gap:6,flexWrap:"wrap",alignItems:"center"}}>
          <Input size="small" aria-label="搜索已加载成员" placeholder="搜索已加载的成员 / 字段 / 值" value={memberSearch} onChange={(_,data)=>{setMemberSearch(data.value);setMemberPage(0);}}/>
          <Button size="small" disabled={locked || !preview.nextCursor || preview.entries.length >= 5000} onClick={()=>void loadMore()}>继续加载</Button>
          <Button size="small" disabled={memberPage === 0} onClick={()=>setMemberPage(page=>Math.max(0,page-1))}>上一页</Button>
          <span>第 {memberPage+1} 页</span>
          <Button size="small" disabled={(memberPage+1)*100 >= preview.entries.filter(entry=>`${entry.field ?? ""} ${entry.value}`.toLowerCase().includes(memberSearch.toLowerCase())).length} onClick={()=>setMemberPage(page=>page+1)}>下一页</Button>
          <span className={styles.note}>{preview.nextCursor ? preview.entries.length >= 5000 ? "已达本次加载上限，刷新可重新浏览" : "尚有成员未加载" : "本次遍历已结束"}；每页显示 100 项，搜索仅针对已加载成员</span>
        </div>}

        {preview?.kind === "string" && (
          <>
            <section className={styles.contentCard} aria-label="键值编辑">
              <div className={styles.contentTitle}>
                <CodeRegular /><span>值内容</span>
                <Badge appearance="tint" size="small" color="informative">{editorLanguage === "plaintext" ? "文本" : editorLanguage.toUpperCase()}</Badge>
                <span style={{ flex: 1 }} />
                <Button size="small" appearance="subtle"
                  icon={expandedEditor ? <ArrowMinimizeRegular /> : <ArrowExpandRegular />}
                  title={expandedEditor ? "恢复自适应高度" : "展开编辑区"}
                  aria-label={expandedEditor ? "恢复自适应高度" : "展开编辑区"}
                  onClick={() => setExpandedEditor(!expandedEditor)} />
                <Button size="small" appearance="primary" icon={<SaveRegular />}
                  disabled={!dirty || writeLocked || Boolean(preview.truncated)}
                  onClick={() => void runEdit({ op: "setString", value: stringDraft, ttlMs: null }, "保存值")}>保存</Button>
                <Button size="small" disabled={!dirty||writeLocked} onClick={()=>setStringDraft(stringBaseline)}>废弃</Button>
              </div>
              <RedisValueEditor value={stringDraft} language={editorLanguage}
                height={expandedEditor ? 480 : undefined}
                readOnly={writeLocked || Boolean(preview.truncated)} onChange={handleStringChange} />
              <div className={styles.editorFooter}>
                <span>{preview.truncated ? "截断预览 · 只读" : dirty ? "有未保存的修改" : "尚无修改"}</span>
                <span style={{ flex: 1 }} />
                {editorLanguage !== "plaintext" && <Button size="small" appearance="subtle" disabled={writeLocked} onClick={handleFormat}>格式化</Button>}
                {editorLanguage === "json" && <Button size="small" appearance="subtle" disabled={writeLocked} onClick={handleMinify}>压缩</Button>}
              </div>
            </section>
            {editorLanguage === "javascript" && (
              <div className={styles.note}>
                检测到类 JSON 内容（键未加引号等），已按 JavaScript 语法高亮；格式化需标准 JSON。
              </div>
            )}
            {preview?.truncated && (
              <div className={styles.error}>
                值超过 1 MB，仅加载了前 1 MB，已禁用保存以避免覆盖丢失数据
              </div>
            )}
            {formatError && <div className={styles.error}>{formatError}</div>}
          </>
        )}

        {!readOnly && preview?.kind === "list" && (
          <div className={styles.addRow}>
            <Input
              size="small"
              className={styles.grow}
              value={addValue}
              placeholder="新元素"
              onChange={(_, data) => setAddValue(data.value)}
            />
            <Button
              size="small"
              disabled={writeLocked || !addValue}
              onClick={() => {
                void runEdit({ op: "listPush", value: addValue, head: true }, "头部插入");
                setAddValue("");
              }}
            >
              头部插入
            </Button>
            <Button
              size="small"
              appearance="primary"
              disabled={writeLocked || !addValue}
              onClick={() => {
                void runEdit({ op: "listPush", value: addValue, head: false }, "尾部追加");
                setAddValue("");
              }}
            >
              尾部追加
            </Button>
          </div>
        )}

        {!readOnly && preview?.kind === "set" && (
          <div className={styles.addRow}>
            <Input
              size="small"
              className={styles.grow}
              value={addValue}
              placeholder="新成员"
              onChange={(_, data) => setAddValue(data.value)}
            />
            <Button
              size="small"
              appearance="primary"
              disabled={writeLocked || !addValue}
              onClick={() => {
                void runEdit({ op: "setAdd", member: addValue }, "添加成员");
                setAddValue("");
              }}
            >
              添加
            </Button>
          </div>
        )}

        {!readOnly && preview?.kind === "zset" && (
          <div className={styles.addRow}>
            <Input
              size="small"
              className={styles.grow}
              value={zsetMember}
              placeholder="成员"
              onChange={(_, data) => setZsetMember(data.value)}
            />
            <Input
              size="small"
              style={{ width: 90 }}
              value={zsetScore}
              placeholder="分值"
              onChange={(_, data) => setZsetScore(data.value)}
            />
            <Button
              size="small"
              appearance="primary"
              disabled={writeLocked || !zsetMember || !Number.isFinite(Number(zsetScore))}
              onClick={() => {
                void runEdit(
                  { op: "zAdd", member: zsetMember, score: Number(zsetScore) },
                  "添加成员",
                );
                setZsetMember("");
                setZsetScore("");
              }}
            >
              添加
            </Button>
          </div>
        )}

        {!readOnly && preview?.kind === "hash" && (
          <div className={styles.addRow}>
            <Input
              size="small"
              className={styles.grow}
              value={hashField}
              placeholder="字段"
              onChange={(_, data) => setHashField(data.value)}
            />
            <Input
              size="small"
              className={styles.grow}
              value={hashValue}
              placeholder="值"
              onChange={(_, data) => setHashValue(data.value)}
            />
            <Button
              size="small"
              appearance="primary"
              disabled={writeLocked || !hashField}
              onClick={() => {
                void runEdit(
                  { op: "hashSet", field: hashField, value: hashValue },
                  "设置字段",
                );
                setHashField("");
                setHashValue("");
              }}
            >
              设置
            </Button>
          </div>
        )}

        {!readOnly && preview?.kind === "stream" && (
          <div className={styles.addRow}>
            <Textarea
              className={styles.grow}
              resize="vertical"
              rows={2}
              value={streamDraft}
              placeholder={"追加条目，每行一个字段：\nfield=value"}
              onChange={(_, data) => setStreamDraft(data.value)}
            />
            <Button
              size="small"
              appearance="primary"
              disabled={writeLocked || !streamDraft.trim()}
              onClick={() => void handleStreamAdd()}
            >
              追加
            </Button>
          </div>
        )}

        {preview?.kind !== "string" &&
          (preview?.entries ?? []).map((entry,index)=>({entry,index})).filter(({entry})=>`${entry.field ?? ""} ${entry.value}`.toLowerCase().includes(memberSearch.toLowerCase())).slice(memberPage*100,(memberPage+1)*100).map(({entry,index}) => (
          <div key={`${entry.field ?? ""}:${entry.value}:${index}`} className={styles.row}>
            {entry.field ? (
              <span className={styles.field} style={{ minWidth: 60 }} title={entry.field}>
                {entry.field}
              </span>
            ) : (
              <span className={styles.index}>{index + 1}</span>
            )}
            <span>
              {entry.score !== null && entry.score !== undefined && editIndex !== index && (
                <Badge
                  appearance="tint"
                  size="small"
                  color="important"
                  style={{ marginRight: 6 }}
                >
                  {entry.score}
                </Badge>
              )}
              {editIndex === index ? (
                <Input
                  size="small"
                  autoFocus
                  style={{ width: "100%" }}
                  value={editValue}
                  onChange={(_, data) => setEditValue(data.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void commitRowEdit();
                    if (event.key === "Escape") setEditIndex(null);
                  }}
                />
              ) : (
                <span className={styles.value}>{entry.value}</span>
              )}
            </span>
            <span className={styles.rowActions}>
              {editIndex === index ? (
                <>
                  <Button
                    size="small"
                    appearance="primary"
                    icon={<SaveRegular />}
                    aria-label="保存成员"
                    disabled={writeLocked}
                    onClick={() => void commitRowEdit()}
                  />
                  <Button size="small" appearance="subtle" onClick={() => setEditIndex(null)}>
                    取消
                  </Button>
                </>
              ) : (
                <>
                  {preview?.kind !== "stream" && preview?.kind !== "set" && (
                    <Button
                      size="small"
                      appearance="subtle"
                      icon={<EditRegular />}
                      title="编辑"
                      disabled={writeLocked}
                      onClick={() => {
                        setEditIndex(index);
                        setEditValue(
                          preview?.kind === "zset"
                            ? String(entry.score ?? "")
                            : entry.value,
                        );
                      }}
                    />
                  )}
                  {preview?.kind !== "stream" && (
                    <Button
                      size="small"
                      appearance="subtle"
                      icon={<DeleteRegular />}
                      title="删除"
                      disabled={writeLocked}
                      onClick={() => void removeRow(index)}
                    />
                  )}
                </>
              )}
            </span>
          </div>
        ))}

        {preview?.kind !== "string" && preview?.truncated && (
          <div className={styles.note}>
            仅显示前 {preview.entries.length} 项（共 {preview.length ?? "?"}），编辑不受影响
          </div>
        )}
      </div>
    </div>
  );
}
