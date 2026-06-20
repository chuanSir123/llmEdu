import { RefreshCw, X } from "lucide-react";
import { token } from "../styles/designTokens";

export type Tab = { pageCode: string; title: string; initialFilters?: Record<string, unknown> };

export function TabManager({
  tabs,
  active,
  onActive,
  onClose,
  onRefresh
}: {
  tabs: Tab[];
  active?: string;
  onActive: (pageCode: string) => void;
  onClose: (pageCode: string) => void;
  onRefresh: () => void;
}) {
  return (
    <div className="flex h-9 shrink-0 border-b border-[#e8edf5] bg-white">
      <button
        className="flex h-9 w-10 shrink-0 items-center justify-center border-r border-[#e8edf5] text-[#8b95a7] hover:bg-[#f7f9fc] hover:text-[#2f80ed]"
        title="刷新当前页面"
        onClick={onRefresh}
        disabled={!active}
      >
        <RefreshCw size={15} />
      </button>
      {tabs.map((tab) => (
        <div key={tab.pageCode} className={`${token.tab} ${tab.pageCode === active ? token.activeTab : "bg-[#f7f9fc] text-[#7a8494]"} flex items-center gap-2`}>
          <button className="whitespace-nowrap" onClick={() => onActive(tab.pageCode)}>
            {tab.title}
          </button>
          {tab.pageCode !== "frontdesk_home" && tab.pageCode !== "tenant_manage" && (
            <button title="关闭" onClick={() => onClose(tab.pageCode)}>
              <X size={14} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
