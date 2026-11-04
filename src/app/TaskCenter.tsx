import { useTabStore } from "../stores/useTabStore";
import { api } from "../ipc";
import { useNotify } from "./toast";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions, ProgressBar, Badge, Popover, PopoverTrigger, PopoverSurface } from "@fluentui/react-components";
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
  const ordered = [...tasks].sort((a,b)=>Number(isTaskActive(b))-Number(isTaskActive(a)));
  const finished = tasks.length-active.length;
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
      <DialogSurface className="dw-task-center">
        <DialogBody>
          <DialogTitle>任务中心</DialogTitle>
          <DialogContent className="dw-task-center-content">
            <div className="dw-task-center-summary"><span>进行中 <strong>{active.length}</strong> · 已结束 <strong>{finished}</strong></span><span>导入、导出、同步、生成、AI 等后台作业</span></div>
            <p className="dw-task-center-hint">取消仅停止后续处理，已提交数据不会回滚。</p>
            {!tasks.length && <p className="dw-task-center-empty">暂无任务</p>}
            {open && ordered.map(task => {const running=isTaskActive(task),progress=progressDisplay(task.progress?.processed,task.progress?.total);return <section key={task.id} className="dw-task-card" data-status={task.status} aria-label={task.label}>
              <div className="dw-task-card-header">
                <Badge appearance="tint" color={task.status === "error" ? "danger" : task.status === "success" ? "success" : "informative"}>{labels[task.status]}</Badge>
                <strong className="dw-task-card-title">{task.label}</strong>
                <span className="dw-task-card-time" title="任务耗时">{(Math.max(0, (task.endedAt ?? now) - task.startedAt) / 1000).toFixed(1)} 秒</span>
              </div>
              <div className="dw-task-card-context">{task.kind} · {task.sessionIds.map(id => sessions.find(s => s.id === id)?.name ?? "已删除会话").join(" → ") || "应用任务"}</div>
              {running && <div className="dw-task-card-progress"><div className="dw-task-card-progress-label"><span>{task.status==='cancelling'?'等待当前步骤停止':'任务进度'}</span><span>{progress.text}</span></div><ProgressBar aria-label={`${task.label}进度`} value={progress.value}/></div>}
              {(task.progress?.message||task.result||task.error||task.cancelError)&&<div className="dw-task-card-message">
                {task.progress?.message && <div>{task.progress.message}</div>}
                {task.result && <div>{task.result}{task.progress?.cancelRequested && task.status === "success" ? "（取消生效前操作已完成）" : ""}</div>}
                {task.error && <div className={task.status === "cancelled" ? "" : "dw-task-card-error"}>{task.error}</div>}
                {task.cancelError && <div className="dw-task-card-error">取消请求失败：{task.cancelError}，任务仍在运行。</div>}
              </div>}
              {(task.tabId||task.error||running)&&<div className="dw-task-card-actions">{task.tabId && <Button size="small" icon={<ArrowLeftRegular/>} disabled={!tabs.some(t=>t.id===task.tabId)} onClick={()=>{const tab=tabs.find(t=>t.id===task.tabId);if(tab){if(tab.kind!=="sync"&&tab.kind!=="sqlExport")useSessionStore.getState().setActiveSession(tab.sessionId);useTabStore.getState().setActive(tab.id);window.dispatchEvent(new Event("dw:show-workspace"));setOpen(false);}}}>返回发起时页签</Button>}<div className="dw-task-card-controls">{task.error && <Button size="small" icon={<CopyRegular/>} onClick={()=>void api.clipboardWriteText(task.label+"\n"+task.error).then(()=>notify.success("已复制失败详情")).catch(e=>notify.error(e))}>复制失败详情</Button>} {isTaskActive(task) && <Button size="small" icon={<StopRegular />} disabled={task.status === "cancelling"} onClick={() => void cancelTask(task.id)}>{task.status === "cancelling" ? "等待停止" : "取消"}</Button>}</div></div>}
            </section>;})}
          </DialogContent>
          <DialogActions className="dw-task-center-actions">
            <Button size="small" disabled={!finished} onClick={() => useTaskStore.setState(s => ({ tasks: s.tasks.filter(isTaskActive) }))}>清除已结束记录</Button>
            <Button size="small" appearance="primary" icon={<DismissRegular />} onClick={() => setOpen(false)}>关闭</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  </>;
}
