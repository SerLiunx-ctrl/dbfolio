import type { Engine } from '../../ipc/types';

export const supportsSqlImport = (engine: Engine) => engine === 'mysql' || engine === 'dameng';
export const supportsSqlTool = (engine: Engine, mode: unknown) =>
  mode === 'import' ? supportsSqlImport(engine) : mode === 'objects' && engine === 'mysql';
export const importTargetLabel = (engine: Engine | undefined) => engine === 'dameng' ? '模式' : '数据库';
