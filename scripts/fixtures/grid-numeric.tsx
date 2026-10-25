import { createRoot } from 'react-dom/client';
import { createRef } from 'react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { EditableDataGrid, type EditableDataGridHandle } from '../../src/features/grid/EditableDataGrid';
import { AppToaster } from '../../src/app/toast';
import { parseCell } from '../../src/features/grid/value';
import { detailValue } from '../../src/features/grid/detailValue';
import { connectionBridge } from '../../src/ipc/connectionBridge';
import type { ColumnMeta, DbValue } from '../../src/ipc/types';
import '../../src/styles.css';
import '../../src/compact.css';

const w = window as any;
connectionBridge.isOffline = () => false;
w.__TAURI_INTERNALS__ = { invoke: async (command: string) => {
  if (command === 'clipboard_read_text') return w.clipboard;
  if (command === 'settings_get') return null;
  throw Error(command);
} };
const engine = new URLSearchParams(location.search).get('engine') ?? 'mysql';
const columns: ColumnMeta[] = [
  { name: 'id', rawType: 'bigint', canonical: { kind: 'int', bits: 64, unsigned: false } },
  { name: 'count', rawType: 'integer', canonical: { kind: 'int', bits: engine === 'sqlite' ? 64 : 32, unsigned: false } },
  { name: 'amount', rawType: 'decimal(30,10)', canonical: { kind: 'decimal', precision: 30, scale: 10 } },
  { name: 'ratio', rawType: 'double precision', canonical: { kind: 'float', bits: 64 } },
  { name: 'code', rawType: 'varchar(30)', canonical: { kind: 'string', len: 30 } },
  { name: 'large', rawType: 'bigint', canonical: { kind: 'int', bits: 64, unsigned: false } },
  ...(engine === 'mysql' ? [{ name: 'unsigned', rawType: 'bigint unsigned', canonical: { kind: 'int', bits: 64, unsigned: true } }] : []),
].map((column, index) => ({ ...column, ordinal: index + 1, nullable: true, autoIncrement: false, unsigned: column.name === 'unsigned' })) as ColumnMeta[];
const rows: DbValue[][] = [[['int', 1], ['null', null], ['decimal', '1.00'], ['float', 1.5], ['text', 'old'], ['int', 2], ...(engine === 'mysql' ? [['uint', 2] as DbValue] : [])]];
const ref = createRef<EditableDataGridHandle>();
w.grid = ref;
w.parse = (column: ColumnMeta, text: string) => parseCell(column, text);
w.detail = (column: ColumnMeta, text: string) => detailValue(['null', null], text, false, column);
w.columns = columns;
createRoot(document.getElementById('root')!).render(
  <FluentProvider theme={webLightTheme} style={{ height: '100vh' }}>
    <AppToaster />
    <div style={{ height: 500 }}><EditableDataGrid ref={ref} tabId="numeric" columns={columns} rows={rows} pkColumns={['id']} sessionId="s" database="test" table="numbers" onPendingChange={changes => { w.pending = changes; }} /></div>
  </FluentProvider>,
);
