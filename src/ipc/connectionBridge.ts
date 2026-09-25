// 由会话存储安装回调，避免 IPC 与存储之间的循环依赖。
export const connectionBridge: {
  isOffline?: (id: string) => boolean;
  onFailure?: (ids: string[]) => void;
  currentTab?: () => { id: string; sessionId: string; database: string } | undefined;
} = {};
