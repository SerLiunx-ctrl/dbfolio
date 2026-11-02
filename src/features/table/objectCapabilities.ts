import type { TableMeta } from '../../ipc/types';

export function objectCapabilities(detail: TableMeta) {
  const table = detail.kind === 'table';
  const definition = (detail.rawDdl ?? '').replace(/^(?:\s|--[^\r\n]*(?:\r?\n|$)|\/\*[\s\S]*?\*\/)+/, '');
  const materialized = !table && /^\s*CREATE\s+MATERIALIZED\s+VIEW\b/i.test(definition);
  return { table, materialized, indexes: table || materialized || detail.indexes.length > 0, foreignKeys: table };
}
