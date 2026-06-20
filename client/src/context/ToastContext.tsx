import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

type ToastItem = {
  id: number;
  type: "success" | "error";
  message: string;
};

type ToastContextValue = {
  success: (message: string) => void;
  error: (message: string) => void;
};

const ToastContext = createContext<ToastContextValue>({ success() {}, error() {} });

export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  let counter = 0;

  const add = useCallback((type: ToastItem["type"], message: string) => {
    const id = Date.now() + counter++;
    setItems((prev) => [...prev, { id, type, message }]);
    setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), 3000);
  }, []);

  const value = useCallback(
    () => ({
      success: (msg: string) => add("success", msg),
      error: (msg: string) => add("error", msg)
    }),
    [add]
  )();

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="fixed right-5 top-5 z-[9999] flex flex-col gap-2">
        {items.map((item) => (
          <div
            key={item.id}
            className={`flex items-center gap-2 rounded-lg px-4 py-3 text-sm font-medium shadow-lg transition-all duration-300 animate-in slide-in-from-right ${
              item.type === "success"
                ? "bg-[#f0fdf4] text-[#166534] border border-[#bbf7d0]"
                : "bg-[#fef2f2] text-[#991b1b] border border-[#fecaca]"
            }`}
          >
            <span className="text-base">{item.type === "success" ? "✓" : "✕"}</span>
            <span>{item.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}