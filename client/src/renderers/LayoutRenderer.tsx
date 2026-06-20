import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { GatewayClient } from "../api/GatewayClient";
import { useAuth } from "../context/AuthContext";
import type { MenuModule, PageDsl } from "../dsl/types";
import { token } from "../styles/designTokens";
import { GenericPageRenderer } from "./GenericPageRenderer";
import { SidebarRenderer } from "./SidebarRenderer";
import { TabManager, type Tab } from "./TabManager";
import { AiCustomizationPanel } from "./AiCustomizationPanel";

export function LayoutRenderer({ scope }: { scope: "admin" | "tenant" }) {
  const params = useParams();
  const schemaName = params.schemaName;
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const [modules, setModules] = useState<MenuModule[]>([]);
  const [activeModule, setActiveModule] = useState<string>();
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTab, setActiveTab] = useState<string>();
  const [pageDsl, setPageDsl] = useState<PageDsl | null>(null);
  const [error, setError] = useState("");
  const [showAiPanel, setShowAiPanel] = useState(false);
  const [aiSessionId, setAiSessionId] = useState<string>();
  const [refreshKey, setRefreshKey] = useState(0);
  const isTestSchema = Boolean(schemaName?.endsWith("_test"));


  const defaultPage = useMemo(
    () => (scope === "admin" ? { pageCode: "tenant_manage", title: "租户管理" } : { pageCode: "frontdesk_home", title: "后台首页" }),
    [scope]
  );

  useEffect(() => {
    if (!user) {
      navigate(scope === "admin" ? "/admin" : `/${schemaName}`);
      return;
    }
    GatewayClient.menu(scope, schemaName)
      .then((res) => {
        const list = res.modules as MenuModule[];
        setModules(list);

        openPage(defaultPage.pageCode, defaultPage.title);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));

  }, [scope, schemaName, user?.userId]);

  async function openPage(pageCode: string, title: string, initialFilters?: Record<string, unknown>) {
    setError("");
    setTabs((current) => {
      const nextTab = { pageCode, title, initialFilters };
      return current.some((tab) => tab.pageCode === pageCode)
        ? current.map((tab) => (tab.pageCode === pageCode ? { ...tab, title, initialFilters } : tab))
        : [...current, nextTab];
    });
    setActiveTab(pageCode);
    try {
      const res = await GatewayClient.page(scope, pageCode, schemaName);
      setPageDsl(res.page.dsl_json as PageDsl);
    } catch (err) {
      setPageDsl(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function activate(pageCode: string) {
    const tab = tabs.find((item) => item.pageCode === pageCode);
    if (tab) await openPage(tab.pageCode, tab.title);
  }

  async function refreshActivePage() {
    const tab = tabs.find((item) => item.pageCode === activeTab);
    if (!tab) return;
    await openPage(tab.pageCode, tab.title, tab.initialFilters);
    setRefreshKey((current) => current + 1);
  }

  function close(pageCode: string) {
    setTabs((current) => {
      const next = current.filter((tab) => tab.pageCode !== pageCode);
      if (activeTab === pageCode) {
        const fallback = next[next.length - 1] ?? defaultPage;
        void openPage(fallback.pageCode, fallback.title);
      }
      return next;
    });
  }

  function toggleModule(moduleCode: string) {
    setActiveModule((current) => (current === moduleCode ? undefined : moduleCode));
  }

  function openAiCustomization(sessionId?: string) {
    setAiSessionId(sessionId);
    setShowAiPanel(true);
  }

  return (
    <div className={`${token.shell} flex`}>
      <SidebarRenderer modules={modules} activeModule={activeModule} onModule={toggleModule} onOpenPage={openPage} />
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-[40px] shrink-0 items-center justify-between border-b border-[#e8edf5] bg-white px-4">
          <div />
          <div className="flex items-center gap-3 text-sm">
            <span className="text-[#2f80ed]">AI邦</span>
            <span className="text-[#7a8494]">在线帮助</span>
            <span className="text-[#526075]">{user?.name}</span>
            <button
              className="border border-[#dde3ee] px-3 py-1 text-[#526075] hover:border-[#2f80ed] hover:text-[#2f80ed]"
              onClick={() => {
                logout();
                navigate(scope === "admin" ? "/admin" : `/${schemaName}`);
              }}
            >
              退出
            </button>
          </div>
        </header>
        <TabManager tabs={tabs} active={activeTab} onActive={activate} onClose={close} onRefresh={() => void refreshActivePage()} />
        <section className="min-h-0 flex-1 overflow-hidden">
          {error && <div className="m-4 border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}
          {pageDsl && (
            <GenericPageRenderer
              scope={scope}
              schemaName={schemaName}
              dsl={pageDsl}
              initialFilters={tabs.find((tab) => tab.pageCode === activeTab)?.initialFilters}
              refreshKey={refreshKey}
              onOpenPage={openPage}
              onOpenAiCustomization={isTestSchema ? undefined : () => openAiCustomization()}
              onContinueAiCustomization={isTestSchema ? undefined : openAiCustomization}
            />
          )}
        </section>
      </main>
      {showAiPanel && schemaName && !isTestSchema && (
        <AiCustomizationPanel
          schemaName={schemaName}
          initialSessionId={aiSessionId}
          onClose={() => {
            setShowAiPanel(false);
            setAiSessionId(undefined);
          }}
        />
      )}
    </div>
  );
}
