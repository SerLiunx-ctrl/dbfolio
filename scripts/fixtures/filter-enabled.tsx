import { createRoot } from 'react-dom/client';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { TableDataPanel } from '../../src/features/table/TableDataPanel';
import { AppToaster } from '../../src/app/toast';
import { connectionBridge } from '../../src/ipc/connectionBridge';
import { useLibrary } from '../../src/stores/useLibrary';
import type { Engine, FilterCondition, TableMeta } from '../../src/ipc/types';
import '../../src/styles.css';
import '../../src/compact.css';

const w = window as any;
const engine = (new URLSearchParams(location.search).get('engine') ?? 'mysql') as Engine;
const scope = JSON.stringify(['s', 'test', null, 'items']);
const presets = [{ id: 'old', scope, name: '旧方案', conjunction: 'and', filters: [{ column: 'id', operator: 'ge', value: '2' }, { column: 'id', operator: 'le', value: '3' }] }];
const settings = new Map([['productivity_library_v1', JSON.stringify({ filters: presets, history: [], files: [] })]]);
w.calls = [];
w.settings = settings;
w.reloadPresets = () => useLibrary.setState(JSON.parse(settings.get('productivity_library_v1')!));
connectionBridge.isOffline = () => false;
w.__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
  w.calls.push({ command, args });
  if (command === 'settings_get') return settings.get(args.key) ?? null;
  if (command === 'settings_set') { settings.set(args.key, args.value); return; }
  if (command.startsWith('task_')) return null;
  if (command === 'build_filter_clause') {
    w.applied = args;
    const active = args.filters.filter((filter: FilterCondition) => filter.enabled !== false);
    // 仅模拟本地 IPC；SQL 生成及执行由独立 Rust/SQLite 测试覆盖。
    return active.length ? ` WHERE ${active.map((filter: FilterCondition) => `id ${filter.operator === 'ge' ? '>=' : '<='} ${filter.value}`).join(args.conjunction === 'or' ? ' OR ' : ' AND ')}` : '';
  }
  if (command === 'query_execute' || command === 'query_fetch_page') return { columns: [{ name: 'id', rawType: 'integer' }], rows: [[['int', 1]]], affected: null };
  throw Error(command);
} };
const detail: TableMeta = { name: 'items', kind: 'table', columns: [{ name: 'id', ordinal: 1, rawType: 'integer', canonical: { kind: 'int', bits: 32, unsigned: false }, nullable: false, autoIncrement: false, unsigned: false }], primaryKey: ['id'], indexes: [], foreignKeys: [] };
document.documentElement.dataset.density = 'compact';
createRoot(document.getElementById('root')!).render(
  <FluentProvider theme={webLightTheme} style={{ height: '100vh' }}>
    <AppToaster />
    <div style={{ display: 'flex', height: 650 }}><TableDataPanel tab={{ id: 't', kind: 'table', sessionId: 's', database: 'test', table: 'items', view: 'data', title: 'items' }} active detail={detail} engine={engine} readOnly={false} onChanged={() => {}} /></div>
  </FluentProvider>,
);
