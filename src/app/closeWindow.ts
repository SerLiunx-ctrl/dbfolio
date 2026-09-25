interface CloseEvent {
  preventDefault: () => void;
}

interface CloseDependencies {
  confirm: () => Promise<boolean>;
  flush: () => Promise<void>;
  destroy: () => Promise<void>;
  onError: (error: unknown) => void;
}

/** 只在确认并持久化成功后销毁窗口，不再次发送关闭请求。 */
export function createCloseHandler({ confirm, flush, destroy, onError }: CloseDependencies) {
  let closing = false;
  return async (event: CloseEvent) => {
    event.preventDefault();
    if (closing) return;
    closing = true;
    try {
      if (!(await confirm())) return;
      await flush();
      await destroy();
    } catch (error) {
      onError(error);
    } finally {
      closing = false;
    }
  };
}
