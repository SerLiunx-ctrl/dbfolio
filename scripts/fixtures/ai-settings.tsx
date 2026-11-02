import { createRoot } from 'react-dom/client';
import { FluentProvider } from '@fluentui/react-components';
import { AiSettings } from '../../src/features/settings/AiSettings';
import { useSettingsStore } from '../../src/stores/useSettingsStore';
import { useAppTheme } from '../../src/theme';
import { connectionBridge } from '../../src/ipc/connectionBridge';
import '../../src/styles.css';
import '../../src/compact.css';
const w = window as any, params = new URLSearchParams(location.search);
const mode = params.has('oled') ? 'oled' : params.has('dark') ? 'dark' : 'light';
const zoom = Number(params.get('zoom') || 1);
document.documentElement.dataset.colorMode = mode;
document.documentElement.dataset.density = 'compact';
useSettingsStore.setState({ themeMode: mode });
connectionBridge.isOffline = () => false;
w.calls = []; w.modelMode = 'ready'; w.failSave = false;
w.providers = [{ id: crypto.randomUUID(), name: '已有模型', baseUrl: 'http://127.0.0.1:1234/v1', model: 'legacy-model', outputFormat: 'json', tokenParameter: 'max_tokens', timeoutSeconds: 60, maxTokens: 4096, isDefault: true, hasKey: true }];
w.__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
  w.calls.push({ command, args });
  if (command === 'ai_providers') return structuredClone(w.providers);
  if (command === 'ai_models') { const mode = w.modelMode; await new Promise(resolve => setTimeout(resolve, w.modelDelay || 80)); if (mode === 'fail') throw Error('服务不支持 /models'); return mode === 'empty' ? [] : args.provider.baseUrl.includes('/second/') ? ['second-model'] : ['model-a', 'model-b']; }
  if (command === 'ai_test') return { usage: { inputTokens: 4, outputTokens: 2, requests: 1 } };
  if (command === 'ai_save') { if (w.failSave) throw Error('模拟保存失败'); const p = structuredClone(args.provider); p.hasKey = args.key === null ? w.providers.find((v: any) => v.id === p.id)?.hasKey ?? false : !!args.key; w.providers = w.providers.filter((v: any) => v.id !== p.id); if (p.isDefault) w.providers.forEach((v: any) => v.isDefault = false); if (!w.providers.length) p.isDefault = true; w.providers.push(p); return structuredClone(w.providers); }
  if (command === 'ai_remove') { w.providers = w.providers.filter((v: any) => v.id !== args.id); if (!w.providers.some((v: any) => v.isDefault) && w.providers[0]) w.providers[0].isDefault = true; return structuredClone(w.providers); }
  if (command.startsWith('task_')) return null;
  throw Error(command);
} };
// Match App.tsx: scale the work area; Fluent dialogs mount outside that transform.
function App() { const { theme } = useAppTheme(); return <FluentProvider theme={theme} style={{ height: '100vh', overflow: 'hidden', boxSizing: 'border-box' }}><div style={{ transform: `scale(${zoom})`, transformOrigin: 'top left', width: `${100 / zoom}%`, height: `${100 / zoom}%`, padding: 12, boxSizing: 'border-box', overflow: 'auto' }}><AiSettings /></div></FluentProvider>; }
createRoot(document.getElementById('root')!).render(<App />);
