import { createRoot } from 'react-dom/client';
import { createRef } from 'react';
import { Button, FluentProvider } from '@fluentui/react-components';
import { EditableDataGrid, type EditableDataGridHandle } from '../../src/features/grid/EditableDataGrid';
import { AppToaster } from '../../src/app/toast';
import { useAppTheme } from '../../src/theme';
import { useSettingsStore } from '../../src/stores/useSettingsStore';
import { useSessionStore } from '../../src/stores/useSessionStore';
import { connectionBridge } from '../../src/ipc/connectionBridge';
import { writeRowClipboard } from '../../src/features/grid/rowClipboard';
import { monaco } from '../../src/monaco';
import type { ColumnMeta, DbValue } from '../../src/ipc/types';
import '../../src/styles.css';
import '../../src/compact.css';

const w = window as any;
const engine = new URLSearchParams(location.search).get('engine') ?? 'mysql';
document.documentElement.dataset.density = 'compact';
useSettingsStore.setState({ themeMode: 'light', interfaceStyle: 'classic', density: 'compact' });
useSessionStore.setState({ sessions: [{ id: engine, name: '字段值验收', engine, readOnly: false } as any] });
connectionBridge.isOffline = () => false;
const bitType = (bits: number) => engine === 'mysql'
  ? { kind: 'int', bits, unsigned: true } as const
  : engine === 'dameng' && bits === 1
    ? { kind: 'bool' } as const
    : { kind: 'unknown', raw: `bit(${bits})` } as const;
const columns: ColumnMeta[] = [
  { name: 'id', rawType: 'bigint', canonical: { kind: 'int', bits: 64, unsigned: false } },
  { name: 'bit1', rawType: 'bit(1)', canonical: bitType(1) },
  { name: 'bit3', rawType: 'bit(3)', canonical: bitType(3) },
  { name: 'bit64', rawType: 'bit(64)', canonical: bitType(64) },
  { name: 'tiny', rawType: 'tinyint(1)', canonical: { kind: 'int', bits: 8, unsigned: false } },
  { name: 'year_value', rawType: 'year', canonical: { kind: 'int', bits: 16, unsigned: true } },
  { name: 'document', rawType: 'json', canonical: { kind: 'json' } },
  { name: 'binary_value', rawType: 'varbinary(20)', canonical: { kind: 'binary', len: 20 } },
  { name: 'note', rawType: 'varchar(20)', canonical: { kind: 'string', len: 20 } },
  { name: 'amount', rawType: 'decimal(6,2) unsigned', canonical: { kind: 'decimal', precision: 6, scale: 2 } },
].map((column, index) => ({ ...column, ordinal: index + 1, nullable: true, autoIncrement: false, unsigned: ['bit1', 'bit3', 'bit64', 'year_value', 'amount'].includes(column.name) })) as ColumnMeta[];
const rows: DbValue[][] = [[['int', 1], ['uint', 0], ['uint', 0], ['uint', 0], ['int', 0], ['uint', 2000], ['json', '{}'], ['bytes', '0x00'], ['text', 'original'], ['decimal', '1.00']]];
if (engine !== 'mysql') {
  rows[0][1] = engine === 'dameng' ? ['bool', false] : ['text', '0'];
  rows[0][2] = ['text', '000']; rows[0][3] = ['text', '0'.repeat(64)];
}
w.clipboard = ''; w.calls = [];
w.__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
  w.calls.push({ command, args });
  if (command === 'settings_get') return null;
  if (command === 'settings_set' || command.startsWith('task_')) return;
  if (command === 'clipboard_write_text') { w.clipboard = args.text; return; }
  if (command === 'clipboard_read_text') return w.clipboard;
  if (command === 'cell_full_value') return rows[0][columns.findIndex(column => column.name === args.column)];
  throw Error(`未预期 IPC：${command}`);
} };
const ref = createRef<EditableDataGridHandle>();
w.grid = ref;
w.typed = (values: DbValue[]) => writeRowClipboard(values.map((_, index) => ({ name: `source_${index}`, rawType: 'test' })), [values]);
w.editText = (text: string) => monaco.editor.getModels().filter(model => !model.isDisposed()).at(-1)?.setValue(text);
w.editorText = () => monaco.editor.getModels().filter(model => !model.isDisposed()).at(-1)?.getValue();
function Fixture() {
  const { theme } = useAppTheme();
  return <FluentProvider theme={theme} style={{ height: '100vh' }}>
    <AppToaster />
    <div style={{ height: 30 }}><Button size="small" onClick={() => ref.current?.discard()}>放弃修改</Button><span data-testid="validation">{w.invalid ?? '有效'}</span></div>
    <div style={{ height: 'calc(100vh - 30px)' }}><EditableDataGrid ref={ref} tabId="field-values" columns={columns} rows={rows} pkColumns={['id']} sessionId={engine} database="fixture" table="fields" onPendingChange={changes => { w.pending = changes; }} onValidationChange={error => { w.invalid = error; }} /></div>
    <div id="dw-overlay-root" />
  </FluentProvider>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
