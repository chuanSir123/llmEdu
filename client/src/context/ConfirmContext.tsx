import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { token } from "../styles/designTokens";

// 应用内确认弹窗（替代 window.confirm）：居中、跟随项目视觉规范，Promise 形态便于在原 confirm 调用点直接 await。

export type ConfirmOptions = {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
};

type ConfirmFn = (options: ConfirmOptions | string) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn>(() => Promise.resolve(true));

export function useConfirm() {
  return useContext(ConfirmContext);
}

type PendingConfirm = ConfirmOptions & { resolve: (ok: boolean) => void };

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null);

  const confirm = useCallback<ConfirmFn>((options) => {
    const normalized = typeof options === "string" ? { message: options } : options;
    return new Promise<boolean>((resolve) => {
      setPending({ ...normalized, resolve });
    });
  }, []);

  const close = (ok: boolean) => {
    pending?.resolve(ok);
    setPending(null);
  };

  useEffect(() => {
    if (!pending) return;
    confirmButtonRef.current?.focus();
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") close(false);
      if (event.key === "Enter") close(true);
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && (
        <div className="fixed inset-0 z-[400] flex items-center justify-center bg-black/35 p-4" onMouseDown={() => close(false)}>
          <div
            className="w-full max-w-[420px] rounded-[4px] border border-[#e5e8ef] bg-white shadow-[0_18px_48px_rgba(15,23,42,0.28)]"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="flex h-12 items-center justify-between border-b border-[#edf0f5] px-4">
              <h3 className="text-[15px] font-semibold text-[#263445]">{pending.title ?? "操作确认"}</h3>
              <button className="text-xl leading-none text-[#9aa4b5] hover:text-[#526075]" onClick={() => close(false)}>
                ×
              </button>
            </div>
            <div className="flex items-start gap-3 px-5 py-5">
              <span
                className={`mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-sm font-bold text-white ${
                  pending.danger ? "bg-[#ff4d64]" : "bg-[#f5a623]"
                }`}
              >
                !
              </span>
              <div className="whitespace-pre-wrap text-sm leading-6 text-[#3f4b5f]">{pending.message}</div>
            </div>
            <div className="flex justify-end gap-2 border-t border-[#edf0f5] px-4 py-3">
              <button className={`${token.button} ${token.defaultButton}`} onClick={() => close(false)}>
                {pending.cancelLabel ?? "取消"}
              </button>
              <button
                ref={confirmButtonRef}
                className={`${token.button} ${pending.danger ? token.dangerButton : token.primaryButton}`}
                onClick={() => close(true)}
              >
                {pending.confirmLabel ?? "确定"}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}
