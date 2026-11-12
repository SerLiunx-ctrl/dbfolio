import {
  Toaster,
  Toast,
  ToastBody,
  ToastTitle,
  ToastTrigger,
  Button,
  useToastController,
} from "@fluentui/react-components";
import { DismissRegular } from "@fluentui/react-icons";
import { useMemo } from "react";
import { normalizeError } from "../ipc";

export function AppToaster() {
  return <Toaster toasterId="main" position="bottom-end" pauseOnHover />;
}

function ToastClose() {
  return <ToastTrigger><Button size="small" appearance="subtle" icon={<DismissRegular />} aria-label="关闭通知" title="关闭通知" /></ToastTrigger>;
}

export function useNotify() {
  const { dispatchToast } = useToastController("main");

  // 必须保持引用稳定：该对象会被放入 useEffect 依赖，引用不稳定会导致无限渲染
  return useMemo(
    () => ({
      error: (error: unknown, title = "操作失败") => {
        const payload = normalizeError(error);
        dispatchToast(
          <Toast>
            <ToastTitle action={<ToastClose />}>{payload.code === "E_CANCELLED" ? "任务已取消" : title}</ToastTitle>
            <ToastBody>{payload.message}</ToastBody>
          </Toast>,
          { intent: payload.code === "E_CANCELLED" ? "info" : "error", timeout: 6000 },
        );
      },
      success: (title: string, body?: string) => {
        dispatchToast(
          <Toast>
            <ToastTitle action={<ToastClose />}>{title}</ToastTitle>
            {body ? <ToastBody>{body}</ToastBody> : null}
          </Toast>,
          { intent: "success", timeout: 3000 },
        );
      },
    }),
    [dispatchToast],
  );
}
