import { useEffect, useMemo, useState } from "react";
import { Building2, Check, ChevronDown, LogOut, Search, Sparkles } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import { GatewayClient, getStoredManagementOrganizationId, setStoredManagementOrganizationId } from "../api/GatewayClient";
import { useAuth } from "../context/AuthContext";
import type { MenuModule, PageDsl } from "../dsl/types";
import { token } from "../styles/designTokens";
import { GenericPageRenderer } from "./GenericPageRenderer";
import { SidebarRenderer } from "./SidebarRenderer";
import { TabManager, type Tab } from "./TabManager";
import { AiCustomizationPanel } from "./AiCustomizationPanel";
import { AiAssistantPanel } from "./AiAssistantPanel";

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
  const [showAssistantPanel, setShowAssistantPanel] = useState(false);
  const [aiSessionId, setAiSessionId] = useState<string>();
  const [refreshKey, setRefreshKey] = useState(0);
  const [managementOpen, setManagementOpen] = useState(false);
  const [managementSearch, setManagementSearch] = useState("");
  const [managementOrganizations, setManagementOrganizations] = useState<Array<{ id: string; name: string; parent_id?: string | null; organization_type?: string }>>([]);
  const [managementOrganizationId, setManagementOrganizationId] = useState<string>(() => getStoredManagementOrganizationId() ?? "");
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

  useEffect(() => {
    if (!user || scope !== "tenant") return;
    let cancelled = false;
    GatewayClient.managementOrganizations(schemaName)
      .then((res) => {
        if (cancelled) return;
        setManagementOrganizations(res.organizations);
        const stored = getStoredManagementOrganizationId();
        const validStored = stored && res.organizations.some((item) => item.id === stored);
        const nextId = validStored ? stored : res.currentOrganizationId ?? res.organizations[0]?.id ?? "";
        setManagementOrganizationId(nextId);
        setStoredManagementOrganizationId(nextId);
      })
      .catch(() => {
        if (!cancelled) setManagementOrganizations([]);
      });
    return () => {
      cancelled = true;
    };
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

  const managementTree = useMemo(() => {
    const byParent = new Map<string, typeof managementOrganizations>();
    for (const org of managementOrganizations) {
      const parent = org.parent_id ?? "";
      byParent.set(parent, [...(byParent.get(parent) ?? []), org]);
    }
    const result: Array<(typeof managementOrganizations)[number] & { depth: number }> = [];
    const visit = (parentId: string, depth: number) => {
      for (const org of byParent.get(parentId) ?? []) {
        result.push({ ...org, depth });
        visit(org.id, depth + 1);
      }
    };
    visit("", 0);
    for (const org of managementOrganizations) {
      if (!result.some((item) => item.id === org.id)) result.push({ ...org, depth: 0 });
    }
    const query = managementSearch.trim().toLowerCase();
    return query ? result.filter((org) => org.name.toLowerCase().includes(query) || org.id.toLowerCase().includes(query)) : result;
  }, [managementOrganizations, managementSearch]);

  const currentManagementOrganization = managementOrganizations.find((item) => item.id === managementOrganizationId);
  const orgTypeLabel: Record<string, string> = { HEAD: "总部", COMPANY: "分公司", BRANCH: "校区", CUSTOM: "自定义" };
  const userInitial = (user?.name ?? "U").slice(0, 1);

  async function switchManagementOrganization(id: string) {
    setManagementOrganizationId(id);
    setStoredManagementOrganizationId(id);
    setManagementOpen(false);
    setManagementSearch("");
    await refreshActivePage();
  }

  return (
    <div className={`${token.shell} flex`}>
      <SidebarRenderer modules={modules} activeModule={activeModule} onModule={toggleModule} onOpenPage={openPage} />
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-[48px] shrink-0 items-center justify-between border-b border-[#e8edf5] bg-white px-4">
          <div />
          <div className="flex items-center gap-2 text-sm">
            <button className="inline-flex h-8 items-center gap-1.5 border border-[#d9e3ef] bg-[#f6faff] px-2.5 text-[#2f80ed] hover:border-[#9fc7f5]" onClick={() => setShowAssistantPanel(true)}>
              <Sparkles className="h-4 w-4" />
              <span>AI 助手</span>
            </button>
            {scope === "tenant" && (
              <div className="relative">
                <button
                  type="button"
                  className={`inline-flex h-8 max-w-[260px] items-center gap-2 border px-2.5 text-left transition ${managementOpen ? "border-[#2f80ed] bg-[#f2f7ff] text-[#1765d8]" : "border-[#d9e3ef] bg-[#fbfcfe] text-[#354154] hover:border-[#9fc7f5] hover:bg-[#f6faff]"}`}
                  onClick={() => setManagementOpen((open) => !open)}
                >
                  <Building2 className="h-4 w-4 shrink-0 text-[#2f80ed]" />
                  <span className="min-w-0 truncate">{currentManagementOrganization?.name ?? "管理架构"}</span>
                  <ChevronDown className={`h-4 w-4 shrink-0 text-[#8b95a7] transition-transform ${managementOpen ? "rotate-180" : ""}`} />
                </button>
                {managementOpen && (
                  <div className="absolute right-0 top-[38px] z-50 w-[320px] border border-[#cfd8e6] bg-white shadow-[0_14px_32px_rgba(24,36,56,0.18)]">
                    <div className="border-b border-[#e8edf5] px-3 py-2">
                      <div className="text-xs font-semibold text-[#172033]">切换管理架构</div>
                      <div className="mt-1 text-[11px] text-[#7a8494]">数据权限按当前架构及其下级生效</div>
                    </div>
                    <div className="border-b border-[#edf1f6] p-2">
                      <div className="flex h-8 items-center gap-2 border border-[#d9e3ef] bg-[#f8fafc] px-2">
                        <Search className="h-4 w-4 shrink-0 text-[#8b95a7]" />
                        <input
                          className="h-full min-w-0 flex-1 border-0 bg-transparent text-sm text-[#263445] outline-none placeholder:text-[#9aa5b5]"
                          value={managementSearch}
                          placeholder="搜索管理架构"
                          onChange={(event) => setManagementSearch(event.target.value)}
                          autoFocus
                        />
                      </div>
                    </div>
                    <div className="max-h-72 overflow-auto py-1">
                      {managementTree.map((org) => (
                        <button
                          key={org.id}
                          type="button"
                          className={`flex w-full items-center gap-2 py-2 pr-3 text-left text-sm hover:bg-[#f2f7ff] ${org.id === managementOrganizationId ? "bg-[#edf3ff] text-[#1765d8] font-medium" : "text-[#263445]"}`}
                          style={{ paddingLeft: 12 + org.depth * 18 }}
                          onClick={() => void switchManagementOrganization(org.id)}
                        >
                          <span className="flex h-5 w-5 shrink-0 items-center justify-center border border-[#d9e3ef] bg-white text-[#8b95a7]">
                            {org.id === managementOrganizationId ? <Check className="h-3.5 w-3.5 text-[#2f80ed]" /> : <Building2 className="h-3.5 w-3.5" />}
                          </span>
                          <span className="min-w-0 flex-1 truncate">{org.name}</span>
                          {org.organization_type && <span className="shrink-0 border border-[#e1e7f0] bg-[#f8fafc] px-1.5 py-0.5 text-[11px] text-[#7a8494]">{orgTypeLabel[org.organization_type] ?? org.organization_type}</span>}
                        </button>
                      ))}
                      {!managementTree.length && <div className="px-3 py-3 text-sm text-[#8b95a7]">无匹配架构</div>}
                    </div>
                  </div>
                )}
              </div>
            )}
            <div className="ml-1 flex h-8 items-center gap-2 border-l border-[#e8edf5] pl-3">
              <span className="inline-flex h-7 w-7 items-center justify-center bg-[#eef5ff] text-xs font-semibold text-[#2f80ed]">
                {userInitial}
              </span>
              <span className="max-w-[120px] truncate text-[#354154]">{user?.name}</span>
            </div>
            <button
              className="inline-flex h-8 items-center gap-1.5 border border-[#dde3ee] px-2.5 text-[#526075] hover:border-[#2f80ed] hover:text-[#2f80ed]"
              onClick={() => {
                logout();
                navigate(scope === "admin" ? "/admin" : `/${schemaName}`);
              }}
            >
              <LogOut className="h-4 w-4" />
              <span>退出</span>
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
      {showAssistantPanel && schemaName && !isTestSchema && (
        <AiAssistantPanel
          schemaName={schemaName}
          onNavigate={(pageCode, filters) => {
            void openPage(pageCode, pageCode, filters);
            setShowAssistantPanel(false);
          }}
          onClose={() => setShowAssistantPanel(false)}
        />
      )}
    </div>
  );
}
