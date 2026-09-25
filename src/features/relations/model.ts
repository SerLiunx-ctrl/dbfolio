import type {DbValue, TableMeta, TableSelection} from '../../ipc/types';

export interface BusinessRelation {
  id: string;
  source: TableSelection;
  columns: string[];
  target: {database: string; schema?: string | null; table: string};
  keys: string[];
  label?: string;
}
export const sourceKey = (s: TableSelection) => JSON.stringify([s.sessionId,s.database,s.schema??'',s.table]);
export function foreignRelations(source: TableSelection, meta: TableMeta): BusinessRelation[] {
  return meta.foreignKeys.map(f => ({id:'fk:'+f.name,source,columns:f.columns,
    target:{database:f.refDatabase||source.database,schema:f.refSchema??source.schema,table:f.refTable},keys:f.refColumns}));
}
export function relationValues(relation: BusinessRelation, columns: string[], row: DbValue[]): DbValue[] {
  if (!relation.columns.length || relation.columns.length!==relation.keys.length) throw Error('关联字段配置不完整');
  return relation.columns.map(name => {
    const index=columns.indexOf(name),value=row[index];
    if(index<0||!value)throw Error('源字段已不存在，请重新配置关联');
    if(value[0]==='null')throw Error('关联字段为 NULL，没有关联记录');
    if(value[0]==='trunc'||value[0]==='readonly')throw Error('关联字段值不完整，无法精确查找');
    return value;
  });
}
