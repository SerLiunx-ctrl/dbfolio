import { createRoot } from 'react-dom/client';
import { FluentProvider } from '@fluentui/react-components';
import { SettingsWorkspace } from '../../src/features/settings/SettingsWorkspace';
import { WorkbenchHub } from '../../src/app/WorkbenchHub';
import { AppToaster } from '../../src/app/toast';
import { useAppTheme } from '../../src/theme';
import { useSettingsStore } from '../../src/stores/useSettingsStore';
import { connectionBridge } from '../../src/ipc/connectionBridge';
import { APP_RELEASE } from '../../src/app/releaseInfo';
import '../../src/styles.css';
import '../../src/compact.css';
import '../../src/motion.css';

const w = window as any;
const params = new URLSearchParams(location.search);
const oled = params.has('oled');
const mode = oled ? 'oled' : params.has('dark') ? 'dark' : 'light';
const zoom = Number(params.get('zoom') || 1);
document.documentElement.dataset.motion = 'full';
document.documentElement.dataset.density = 'compact';
document.documentElement.dataset.colorMode = mode;
document.documentElement.style.zoom = String(zoom);
useSettingsStore.setState({ themeMode: mode, motionMode: 'full', interfaceStyle: 'classic' });
connectionBridge.isOffline = () => false;
w.calls = [];
w.settings = new Map();
let prefs = { automatic: true, channel: 'preview', skipped: '', lastCheck: 0, proxy: '' };
w.__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
  w.calls.push({ command, args });
  if (command === 'settings_get') return w.settings.get(args.key) ?? null;
  if (command === 'settings_set') { w.settings.set(args.key, args.value); return; }
  if (command === 'updater_status') return { version: APP_RELEASE, distribution: 'installed', preferences: prefs, readyVersion: w.ready ? '1.0.0-alpha.34' : null, logPath: 'C:/fixture/updates' };
  if (command === 'updater_preferences') { prefs = args.value; return; }
  if (command === 'updater_check') { prefs.lastCheck = Date.now() / 1000; if (w.failCheck) throw Error('网络不可用'); return w.hasUpdate ? { version: '1.0.0-alpha.34', notes: '示例新版更新内容', size: 1024, date: null, skipped: false } : null; }
  if (command === 'updater_download') { w.ready = true; return '1.0.0-alpha.34'; }
  if (command.startsWith('task_') || command.startsWith('plugin:opener')) return null;
  if (command === 'generation_providers') return [];
  if (command === 'local_data_stats') return { databasePath: 'C:/fixture/app.db', databaseBytes: 1024, auxiliaryBytes: 0, sessionCount: 0, historyCount: 0, historyLimit: 500 };
  if (command === 'session_list') return [];
  throw Error(command);
} };
function Preview() {
 const {theme,dark}=useAppTheme();
 const style=useSettingsStore(state=>state.interfaceStyle);
 return <FluentProvider theme={theme} data-style={style} data-color-mode={dark?'dark':'light'} style={{height:`${100/zoom}vh`}}><AppToaster/>
 <header style={{height:30,borderBottom:'1px solid #8885',display:'flex',alignItems:'center',paddingInline:10}}>DBFolio <WorkbenchHub/></header>
 <div style={{height:'calc(100% - 31px)',display:'flex'}}><SettingsWorkspace initialCategory={params.get('category') || 'appearance'}/></div></FluentProvider>;
}
createRoot(document.getElementById('root')!).render(<Preview/>);
