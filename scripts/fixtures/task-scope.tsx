import { createRoot } from 'react-dom/client';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { TaskCenter } from '../../src/app/TaskCenter';
import { useTaskStore, activeSessionTasks } from '../../src/stores/useTaskStore';
import { trackedInvoke } from '../../src/ipc/taskInvoke';
import { connectionBridge } from '../../src/ipc/connectionBridge';
import { api } from '../../src/ipc';
import '../../src/styles.css';
const w = window as any, pending = new Map<string, { resolve: Function; reject: Function }>();
w.calls = []; w.store = useTaskStore; w.activeSessionTasks = activeSessionTasks; w.api = api;
connectionBridge.isOffline = () => false;
connectionBridge.currentTab = () => ({ id: 'wrong-tab', sessionId: 's', database: 'd' }) as any;
w.__TAURI_INTERNALS__ = { invoke: async (c: string, a: any) => {
  w.calls.push({ c, a });
  if (c === 'task_cancel') { pending.get(a.id)?.reject({ code: 'E_CANCELLED', message: '已取消' }); return; }
  if (c.startsWith('task_')) return null;
  return new Promise((resolve, reject) => pending.set(a.taskId, { resolve, reject }));
} };
w.start = (command: string, tabId = 'query-1') => { void trackedInvoke(command, { sessionId: 's', database: 'd', sql: 'SELECT 1', originTabId: tabId }).catch(() => {}); };
w.finish = (id: string, fail = false) => fail ? pending.get(id)?.reject(Error('模拟失败')) : pending.get(id)?.resolve({ rows: [] });
createRoot(document.getElementById('root')!).render(<FluentProvider theme={webLightTheme}><TaskCenter /></FluentProvider>);
