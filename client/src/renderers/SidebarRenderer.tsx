import { useEffect, useState } from "react";
import { Icon } from "../components/Icon";
import type { MenuModule } from "../dsl/types";
import { token } from "../styles/designTokens";

export function SidebarRenderer({
  modules,
  activeModule,
  onModule,
  onOpenPage
}: {
  modules: MenuModule[];
  activeModule?: string;
  onModule: (moduleCode: string) => void;
  onOpenPage: (pageCode: string, title: string, initialFilters?: Record<string, unknown>) => void;
}) {
  const active = modules.find((item) => item.moduleCode === activeModule);
  const [mountedModule, setMountedModule] = useState<MenuModule | undefined>(active);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (active) {
      setMountedModule(active);
      requestAnimationFrame(() => setVisible(true));
      return;
    }
    setVisible(false);
    const timer = window.setTimeout(() => setMountedModule(undefined), 220);
    return () => window.clearTimeout(timer);
  }, [active]);

  const flyoutModule = active ?? mountedModule;

  return (
    <>
      <aside className={token.sidebar}>
        <div className="flex h-16 flex-col items-center justify-center text-white">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-white text-sm font-bold text-[#1261d8] shadow-[0_8px_24px_rgba(9,50,120,0.28)]">B</div>
          <div className="mt-1 text-[10px] font-semibold tracking-wide text-white/80">BOSS</div>
        </div>
        <nav className="py-2">
          {modules.map((item) => (
            <button
              key={item.moduleCode}
              className={`relative flex h-[58px] w-full flex-col items-center justify-center gap-1 text-xs transition ${
                item.moduleCode === active?.moduleCode ? "bg-white/18 text-white shadow-[inset_3px_0_0_rgba(255,255,255,0.9)]" : "text-white/85 hover:bg-white/10 hover:text-white"
              }`}
              onClick={() => onModule(item.moduleCode)}
              title={item.moduleName}
            >
              <Icon name={item.icon} />
              {item.moduleCode === active?.moduleCode && <span className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-cyan-200" />}
              <span>{item.moduleName}</span>
            </button>
          ))}
        </nav>
      </aside>
      {flyoutModule && (
        <div className="fixed inset-y-0 left-[88px] right-0 z-40">
          <button
            className={`absolute inset-0 cursor-default bg-black/45 transition-opacity duration-200 ${visible ? "opacity-100" : "opacity-0"}`}
            aria-label="关闭菜单"
            onClick={() => onModule(flyoutModule.moduleCode)}
          />
          <aside
            className={`absolute left-0 top-0 h-full w-[360px] border-r border-[#e5e8ef] bg-white shadow-[8px_0_24px_rgba(15,23,42,0.18)] transition-all duration-200 ease-out ${
              visible ? "translate-x-0 opacity-100" : "-translate-x-3 opacity-0"
            }`}
          >
            <div className="flex h-16 items-center border-b border-[#e5e8ef] bg-gradient-to-r from-[#f3f7ff] to-white px-6">
              <div>
                <div className="text-lg font-semibold text-[#1673e6]">LLM Edu</div>
                <div className="text-xs text-[#7a8999]">{flyoutModule.moduleName}</div>
              </div>
            </div>
            <div className="space-y-6 p-6">
              {Object.entries(flyoutModule.groups).map(([group, pages]) => (
                <section key={group}>
                  <h3 className="mb-3 flex items-center gap-2 text-xs font-semibold text-[#7a8999]">
                    <span className="h-3 w-3 bg-[#d9e3ed]" />
                    {group}
                  </h3>
                  <div className="grid grid-cols-2 gap-x-8 gap-y-3">
                    {pages.map((page) => (
                      <button
                        key={page.pageCode}
                        className="text-left text-sm text-[#253448] hover:text-[#1673e6]"
                        onClick={() => {
                          onOpenPage(page.pageCode, page.featureName);
                          onModule(flyoutModule.moduleCode);
                        }}
                        title={page.featureName}
                      >
                        <span className="block truncate">{page.featureName}</span>
                      </button>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </aside>
        </div>
      )}
    </>
  );
}
