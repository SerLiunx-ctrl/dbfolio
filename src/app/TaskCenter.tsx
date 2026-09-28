import { useTabStore } from "../stores/useTabStore";
import { api } from "../ipc";
import { useNotify } from "./toast";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions, ProgressBar, Badge, Popover, PopoverTrigger, PopoverSurface, tokens } from "@fluentui/react-components";
import { TaskListSquareLtrRegular, StopRegular, DismissRegular, ArrowLeftRegular, CopyRegular } from "@fluentui/react-icons";
import { cancelTask, isTaskActive, isBackgroundTask, useTaskStore } from "../stores/useTaskStore";
import { useSessionStore } from "../stores/useSessionStore";
import {progressDisplay} from "./taskProgress";
import "./task-center.css";
const labels = { running: "进行中", cancelling: "正在取消", success: "已完成", error: "失败 / 部分失败", cancelled: "已取消" };
export function TaskCenter() {
  const notify=useNotify();
  const tabs=useTabStore(s=>s.tabs);
  const tasks = useTaskStore(s => s.tasks).filter(isBackgroundTask);
  const sessions = useSessionStore(s => s.sessions);
  const [open, setOpen] = useState(false);
  const [hovered,setHovered]=useState(false);
  const previewRef = useRef<HTMLDivElement>(null);
  const onPreviewChange = useCallback((event: {type: string}, data: {open: boolean}) => {
    // Clicking the trigger opens the full task center, not the hover preview.
    if(event.type !== 'click' || !data.open) setHovered(data.open);
  }, []);
  const [now, setNow] = useState(Date.now());
  const active = tasks.filter(isTaskActive);
  useEffect(() => {
    if ((!open && !hovered) || active.length === 0) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [open, hovered, active.length]);
  useEffect(() => { const show = () => setOpen(true); window.addEventListener("dw:tasks", show); return () => window.removeEventListener("dw:tasks", show); }, []);
  useEffect(() => {
    const check = () => { const state=useSessionStore.getState(); for (const id of Object.keys(state.statuses)) void state.checkHealth(id); };
    const timer = window.setInterval(check, 30000);
    return () => window.clearInterval(timer);
  }, []);
  return <>
    <Popover openOnHover mouseLeaveDelay={250} unstable_disableAutoFocus positioning="above-end" open={hovered&&!open} onOpenChange={onPreviewChange}>
      <PopoverTrigger disableButtonEnhancement>
      <Button className={'dw-task-trigger'+(active.length?' is-active':'')} appearance="subtle" size="small" icon={<TaskListSquareLtrRegular />} aria-haspopup="dialog" onFocus={event=>{if(event.currentTarget.matches(':focus-visible'))setHovered(true);}} onBlur={event=>{if(!previewRef.current?.contains(event.relatedTarget as Node))setHovered(false);}} onClick={() => {setHovered(false);setOpen(true);}}>
        {active.length?'任务中心 · 进行中':'任务中心'}{active.length?<Badge appearance="outline" size="small">{active.length}</Badge>:tasks[0]?' · '+labels[tasks[0].status]:''}
      </Button>
      </PopoverTrigger>
      {/* Tooltip hides escaped surfaces relative to the footer's scroll container. */}
      <PopoverSurface ref={previewRef} className="dw-task-hover" aria-label="当前任务进度">
      <div className="dw-task-hover-header"><strong>{active.length?'当前正在进行的任务':'任务中心'}</strong>{active.length>0&&<Badge appearance="filled">{active.length} 项</Badge>}</div>
      {active.slice(0,3).map(task=>{const progress=progressDisplay(task.progress?.processed,task.progress?.total);return <section className="dw-task-hover-item" key={task.id}>
        <div className="dw-task-hover-row"><strong>{task.label}</strong><span>{task.status==='cancelling'?'正在取消':progress.percent===undefined?'进行中':progress.percent+'%'}</span></div>
        <div className="dw-task-hover-context">{task.kind} · {task.sessionIds.map(id=>sessions.find(s=>s.id===id)?.name??'已删除会话').join(' → ')||'应用任务'} · {Math.max(0,Math.floor((now-task.startedAt)/1000))} 秒</div>
        <ProgressBar aria-label={task.label+'进度'} value={progress.value}/>
        <div className="dw-task-hover-row"><span>{progress.text}</span></div>
        {task.progress?.message&&<p className="dw-task-hover-message">{task.progress.message}</p>}
      </section>;})}
      {!active.length&&<p className="dw-task-hover-message">当前没有运行中的任务。{tasks[0]?'最近任务：'+tasks[0].label+' · '+labels[tasks[0].status]:''}</p>}
      <div className="dw-task-hover-footer">{active.length>3?'还有 '+(active.length-3)+' 项任务。':''}点击打开完整任务中心</div>
      </PopoverSurface>
    </Popover>
    <Dialog open={open} onOpenChange={(_, data) => setOpen(data.open)}>
      <DialogSurface style={{ width: "min(760px, 94vw)", maxWidth: "94vw" }}>
        <DialogBody>
          <DialogTitle>任务中心</DialogTitle>
          <DialogContent style={{ maxHeight: "65vh", overflowY: "auto" }}>
            <p>显示导入、导出、同步、生成、AI 等后台作业。取消仅停止后续处理，已提交数据不会回滚。</p>
            {!tasks.length && <p>暂无任务</p>}
            {open && tasks.map(task => <section key={task.id} style={{ padding: 12, marginBottom: 10, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 8 }}>
              <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                <Badge appearance="tint" color={task.status === "error" ? "danger" : task.status === "success" ? "success" : "informative"}>{labels[task.status]}</Badge>
                <strong style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>{task.label}</strong>
                <span>{(Math.max(0, (task.endedAt ?? now) - task.startedAt) / 1000).toFixed(1)} 秒</span>
                {isTaskActive(task) && <Button size="small" icon={<StopRegular />} disabled={task.status === "cancelling"} onClick={() => void cancelTask(task.id)}>{task.status === "cancelling" ? "等待停止" : "取消"}</Button>}
              </div>
              <div style={{ color: tokens.colorNeutralForeground3, margin: "6px 0" }}>{task.kind} · {task.sessionIds.map(id => sessions.find(s => s.id === id)?.name ?? "已删除会话").join(" → ")}</div>
              {isTaskActive(task) && <ProgressBar aria-label={`${task.label}进度`} value={progressDisplay(task.progress?.processed,task.progress?.total).value} />}
              {task.tabId && <Button size="small" icon={<ArrowLeftRegular/>} disabled={!tabs.some(t=>t.id===task.tabId)} onClick={()=>{const tab=tabs.find(t=>t.id===task.tabId);if(tab){if(tab.kind!=="sync"&&tab.kind!=="sqlExport")useSessionStore.getState().setActiveSession(tab.sessionId);useTabStore.getState().setActive(tab.id);window.dispatchEvent(new Event("dw:show-workspace"));setOpen(false);}}}>返回发起时页签</Button>}
              {task.error && <Button size="small" icon={<CopyRegular/>} onClick={()=>void api.clipboardWriteText(task.label+"\n"+task.error).then(()=>notify.success("已复制失败详情")).catch(e=>notify.error(e))}>复制失败详情</Button>}
              <div style={{ marginTop: 6, overflowWrap: "anywhere", whiteSpace: "pre-wrap" }}>
                {task.progress?.message && <div>{task.progress.message}</div>}
                {task.result && <div>{task.result}{task.progress?.cancelRequested && task.status === "success" ? "（取消生效前操作已完成）" : ""}</div>}
                {task.error && <div style={{ color: task.status === "cancelled" ? tokens.colorNeutralForeground2 : tokens.colorPaletteRedForeground1 }}>{task.error}</div>}
                {task.cancelError && <div>取消请求失败：{task.cancelError}，任务仍在运行。</div>}
              </div>
            </section>)}
          </DialogContent>
          <DialogActions>
            <Button onClick={() => useTaskStore.setState(s => ({ tasks: s.tasks.filter(isTaskActive) }))}>清除已结束记录</Button>
            <Button appearance="primary" icon={<DismissRegular />} onClick={() => setOpen(false)}>关闭</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  </>;
}
