import { TableBody, TableCell, TableHeader, TableRow } from '@fluentui/react-components';
import type { Engine, TableMeta } from '../../ipc/types';
import { fieldTypeStyle } from '../grid/valueColor';
import { splitColumnType } from './columnCapabilities';
import { ResizableSchemaTable, ResizableHeaderCell } from './ResizableSchemaTable';
import { useColumnFocus, type ColumnFocusRequest } from './useColumnFocus';

export function ViewColumnsPanel({ detail, engine, active, columnFocus }: {
  detail: TableMeta; engine: Engine; active: boolean; columnFocus?: ColumnFocusRequest | null;
}) {
  const { rootRef, highlightedColumn } = useColumnFocus(columnFocus, active, detail.columns);
  const comments = detail.columns.some(column => Boolean(column.comment));
  return <div ref={rootRef} className="dw-view-columns" style={{ overflow: 'auto', minHeight: 0, flex: 1, padding: '10px 16px' }}>
    <ResizableSchemaTable kind="structure" engine={engine} scopeId="view-columns" size="extra-small" aria-label="视图列信息" className="dw-schema-list">
      <TableHeader><TableRow>
        <ResizableHeaderCell>#</ResizableHeaderCell><ResizableHeaderCell>名称</ResizableHeaderCell>
        <ResizableHeaderCell>类型</ResizableHeaderCell><ResizableHeaderCell>长度/集合</ResizableHeaderCell>
        <ResizableHeaderCell title="服务器返回的结果列可空性">可空</ResizableHeaderCell>
        {comments && <ResizableHeaderCell>注释</ResizableHeaderCell>}
      </TableRow></TableHeader>
      <TableBody>{detail.columns.map(column => {
        const type = splitColumnType(column.rawType, engine), style = fieldTypeStyle(column.rawType, column.canonical);
        return <TableRow key={column.name} data-column-name={column.name} className={highlightedColumn === column.name ? 'dw-column-located' : undefined}>
          <TableCell>{column.ordinal}</TableCell><TableCell style={style} title={column.name}>{column.name}</TableCell>
          <TableCell style={style} title={column.rawType}>{type.type}{engine === 'mysql' && column.unsigned ? ' unsigned' : ''}</TableCell>
          <TableCell style={style}>{type.args || '—'}</TableCell><TableCell>{column.nullable ? '是' : '否'}</TableCell>
          {comments && <TableCell title={column.comment ?? undefined}>{column.comment || '—'}</TableCell>}
        </TableRow>;
      })}</TableBody>
    </ResizableSchemaTable>
  </div>;
}
