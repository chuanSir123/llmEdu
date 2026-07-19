import { useEffect, useMemo, useRef, useState } from "react";
import { GatewayClient } from "../api/GatewayClient";

// 通用可搜索下拉：静态 options 或 optionSource 远程加载（学员/产品/老师等大数据量场景）。
// 远程模式下输入词 300ms 防抖后带 labelField 过滤重查；本地始终兜底按 label/value 过滤。
// 视觉与 GenericFormRenderer 的弹窗下拉保持一致（圆角 + focus 高亮 + 选中勾）。

export type SearchSelectOption = { value: string; label: string; hint?: string };

// 默认只展示前 20 条，更多请输入关键字搜索（远程模式同时作为查询 pageSize）
const DISPLAY_LIMIT = 20;

export type SearchSelectSource = {
  pageCode: string;
  apiCode: string;
  labelField?: string;
  valueField?: string;
  filters?: Record<string, unknown>;
  pageSize?: number;
};

export function SearchSelect({
  value,
  onChange,
  options,
  optionSource,
  scope = "tenant",
  schemaName,
  placeholder = "请选择",
  clearLabel,
  disabled,
  compact,
  excludeValues,
  className = ""
}: {
  value: string;
  onChange: (next: string) => void;
  options?: SearchSelectOption[];
  optionSource?: SearchSelectSource;
  scope?: "admin" | "tenant";
  schemaName?: string;
  placeholder?: string;
  /** 顶部“清空”项文案（如筛选栏的“全部”）；不传则用 placeholder */
  clearLabel?: string;
  disabled?: boolean;
  compact?: boolean;
  /** 需要从选项中排除的值（当前值除外），如行编辑器里其他行已选的学员 */
  excludeValues?: string[];
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [remote, setRemote] = useState<SearchSelectOption[] | null>(null);
  // 面板 fixed 定位：absolute 会被表格/弹窗等祖先的 overflow 裁剪（如排课行编辑器）
  const [panelRect, setPanelRect] = useState<{ left: number; width: number; top?: number; bottom?: number } | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const lastQueryRef = useRef<string | null>(null);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function updateRect() {
      const el = triggerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      // 下方空间不足且上方更宽裕时向上弹出
      const openUp = spaceBelow < 320 && rect.top > spaceBelow;
      setPanelRect({
        left: rect.left,
        width: rect.width,
        ...(openUp ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 })
      });
    }
    updateRect();
    window.addEventListener("resize", updateRect);
    window.addEventListener("scroll", updateRect, true);
    return () => {
      window.removeEventListener("resize", updateRect);
      window.removeEventListener("scroll", updateRect, true);
    };
  }, [open]);

  // 远程加载：打开时首查；输入词变化 300ms 防抖带 label 过滤重查
  useEffect(() => {
    if (!optionSource || !open) return;
    const trimmed = query.trim();
    if (lastQueryRef.current === trimmed && remote !== null) return;
    const timer = window.setTimeout(async () => {
      lastQueryRef.current = trimmed;
      const labelField = optionSource.labelField ?? "name";
      const valueField = optionSource.valueField ?? "id";
      try {
        const result = await GatewayClient.executeApi({
          scope,
          schemaName,
          pageCode: optionSource.pageCode,
          apiCode: optionSource.apiCode,
          params: {
            filters: { ...(optionSource.filters ?? {}), ...(trimmed ? { [labelField]: trimmed } : {}) },
            page: 1,
            pageSize: optionSource.pageSize ?? DISPLAY_LIMIT
          }
        });
        const rows = (result.data as { rows?: Record<string, unknown>[] }).rows ?? [];
        setRemote(rows.map((row) => ({ value: String(row[valueField] ?? ""), label: String(row[labelField] ?? row[valueField] ?? "") })));
      } catch {
        setRemote([]);
      }
    }, remote === null ? 0 : 300);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optionSource && JSON.stringify(optionSource), open, query]);

  function dedupeOptions(list: SearchSelectOption[]) {
    const seen = new Set<string>();
    return list.filter((option) => {
      const key = `${option.value}::${option.label}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // 远程未加载完成前用传入的静态 options 兜底（用于回显已选值的 label）
  const allOptions = dedupeOptions(optionSource ? remote ?? options ?? [] : options ?? []);
  const excluded = useMemo(() => new Set((excludeValues ?? []).filter((item) => item !== value)), [excludeValues, value]);
  const { filtered, truncatedCount } = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    const base = allOptions.filter((option) => !excluded.has(option.value));
    const matched = trimmed
      ? base.filter((option) => option.label.toLowerCase().includes(trimmed) || option.value.toLowerCase().includes(trimmed))
      : base;
    return { filtered: matched.slice(0, DISPLAY_LIMIT), truncatedCount: Math.max(0, matched.length - DISPLAY_LIMIT) };
  }, [allOptions, excluded, query]);

  const selected = [...(remote ?? []), ...(options ?? [])].find((option) => option.value === value);
  const heightClass = compact ? "h-7 text-xs" : "h-8 text-[13px]";

  return (
    <div className={`relative min-w-0 ${className}`} ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        disabled={disabled}
        className={`flex ${heightClass} w-full min-w-0 items-center justify-between gap-1 rounded-[3px] border bg-white px-2.5 text-left transition ${
          open ? "border-[#2f80ed] shadow-[0_0_0_2px_rgba(47,128,237,0.12)]" : "border-[#dde3ee] hover:border-[#b9c8de]"
        } disabled:cursor-not-allowed disabled:bg-[#f5f7fa] disabled:text-[#a7b0bf]`}
        onClick={() => { setOpen(!open); setQuery(""); }}
      >
        <span className={`truncate ${selected || value ? "text-[#263445]" : "text-[#a7b0bf]"}`}>
          {selected?.label ?? (value ? String(value) : placeholder)}
        </span>
        <svg className={`h-4 w-4 shrink-0 text-[#8b95a7] transition-transform ${open ? "rotate-180" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
      </button>
      {open && panelRect && (
        <div
          className="fixed z-[500] overflow-hidden rounded-[4px] border border-[#dfe6f0] bg-white shadow-[0_12px_32px_rgba(24,36,56,0.18)]"
          style={{ left: panelRect.left, width: panelRect.width, top: panelRect.top, bottom: panelRect.bottom }}
        >
          <div className="flex items-center gap-1 border-b border-[#eef2f7] bg-[#fafbfd] px-2">
            <svg className="h-4 w-4 shrink-0 text-[#8b95a7]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
            <input
              className="h-9 w-full border-0 bg-transparent px-1 text-[13px] outline-none placeholder:text-[#a7b0bf]"
              value={query}
              placeholder="输入关键字搜索..."
              autoFocus
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className="max-h-56 overflow-auto py-1">
            <button
              type="button"
              className="block w-full px-3 py-2 text-left text-[13px] text-[#8b95a7] hover:bg-[#f2f7ff]"
              onClick={() => { onChange(""); setOpen(false); }}
            >
              {clearLabel ?? placeholder}
            </button>
            {filtered.map((option) => {
              const isSelected = option.value === value;
              return (
                <button
                  type="button"
                  key={option.value}
                  className={`flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] hover:bg-[#f2f7ff] ${isSelected ? "bg-[#eaf2ff] font-medium text-[#1765d8]" : "text-[#3f4b5f]"}`}
                  onClick={() => { onChange(option.value); setOpen(false); }}
                >
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {option.hint && <span className="shrink-0 text-xs text-[#8b95a7]">{option.hint}</span>}
                  {isSelected && <svg className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>}
                </button>
              );
            })}
            {!filtered.length && (
              <div className="px-3 py-4 text-center text-[13px] text-[#8b95a7]">
                {optionSource && remote === null ? "加载中..." : "无匹配选项"}
              </div>
            )}
            {(truncatedCount > 0 || (optionSource && (remote?.length ?? 0) >= DISPLAY_LIMIT)) && (
              <div className="border-t border-[#eef2f7] bg-[#fafbfd] px-3 py-1.5 text-center text-xs text-[#8b95a7]">
                仅显示前 {DISPLAY_LIMIT} 条，请输入关键字继续筛选
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
