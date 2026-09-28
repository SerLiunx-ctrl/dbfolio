import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { FluentProvider } from '@fluentui/react-components';
import { ColumnsPanel, IndexesPanel, ForeignKeysPanel, DdlPanel } from '../../src/features/table/StructurePanel';
import { buildTheme } from '../../src/theme';
import { useSettingsStore } from '../../src/stores/useSettingsStore';
import { connectionBridge } from '../../src/ipc/connectionBridge';
import { useSessionStore } from '../../src/stores/useSessionStore';
import * as monaco from 'monaco-editor';
import '../../src/monaco';
import '../../src/styles.css';
import '../../src/compact.css';
const w = window as any, params = new URLSearchParams(location.search);
const mode = params.get('theme') ?? 'light', engine = (params.get('engine') ?? 'mysql') as any;
useSettingsStore.setState({ themeMode: mode as any });
document.documentElement.dataset.oled = String(mode === 'oled');
document.documentElement.dataset.density = 'compact';
connectionBridge.isOffline = () => false;
useSessionStore.setState({ sessions: [{ id: 's', name: 'test', engine, readOnly: false } as any] });
const column = (name: string, rawType: string, ordinal = 1) => ({ name, rawType, ordinal, nullable: true, autoIncrement: false, unsigned: false });
const detail: any = { name: 'orders', kind: 'table', primaryKey: ['id'], columns: [column('id', 'bigint'), column('user_id', 'bigint', 2), column('status', 'varchar(30)', 3), column('created_at', 'datetime', 4)],
  indexes: [{ name: 'PRIMARY', primary: true, unique: true, columns: [{ name: 'id' }], method: 'BTREE' }, { name: 'idx_status', unique: true, columns: [{ name: 'status', prefixLen: 10 }, { name: 'created_at', desc: true }], method: 'HASH' }],
  foreignKeys: [{ name: 'fk_user', columns: ['user_id'], refTable: 'users', refColumns: ['id'], onDelete: 'CASCADE', onUpdate: 'RESTRICT' }, { name: 'fk_duplicate', columns: ['status'], refTable: 'users', refColumns: ['code'], onDelete: 'SET NULL', onUpdate: 'NO ACTION' }, { name: 'fk_denied', columns: ['id'], refDatabase: 'restricted', refTable: 'hidden', refColumns: ['id'], onDelete: 'SET DEFAULT', onUpdate: 'CASCADE' }],
  rawDdl: "-- 订单\nCREATE TABLE orders (\n  id BIGINT PRIMARY KEY,\n  status VARCHAR(30) DEFAULT 'draft'\n);" };
w.calls = []; w.monaco = monaco;
w.__TAURI_INTERNALS__ = { invoke: async (c: string, a: any) => {
  w.calls.push({ c, a });
  if (c === 'meta_table_detail') {
    await new Promise(r => setTimeout(r, a.database === 'other' ? 30 : 300));
    if (a.table === 'hidden') throw Error('无权限');
    return { columns: [column('id', a.database === 'other' ? 'datetime' : 'bigint'), column('code', 'varchar(20)')] };
  }
  if (c.startsWith('task_')) return null;
  throw Error(c);
} };
function App() {
  const [view, setView] = useState(params.get('view') ?? 'indexes'), [database, setDatabase] = useState('db');
  w.switchDatabase = () => setDatabase('other');
  const props = { tab: { id: 't', kind: 'table', sessionId: 's', database, table: 'orders' } as any, detail, engine, readOnly: false, onChanged: () => {} };
  return <FluentProvider theme={buildTheme(mode !== 'light', '#0f6cbd', mode === 'oled' ? 'oled' : 'aurora')} data-color-mode={mode === 'light' ? 'light' : 'dark'} style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
    <nav>{['columns', 'indexes', 'foreignKeys', 'ddl'].map(v => <button key={v} onClick={() => setView(v)}>{v}</button>)}</nav>
    {view === 'columns' ? <ColumnsPanel {...props} /> : view === 'indexes' ? <IndexesPanel {...props} /> : view === 'foreignKeys' ? <ForeignKeysPanel {...props} /> : <DdlPanel detail={detail} engine={engine} />}
  </FluentProvider>;
}
createRoot(document.getElementById('root')!).render(<App />);
