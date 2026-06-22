import { useEffect, useMemo, useState } from "react";
import { GatewayClient } from "../api/GatewayClient";
import { token } from "../styles/designTokens";

type PermissionPage = {
  pageCode: string;
  pageName: string;
  moduleCode?: string;
  moduleName?: string;
  featureCode?: string;
  featureName?: string;
  actions: Array<{ actionCode: string; actionName: string; actionType: string }>;
  fields: Array<{ key: string; label: string }>;
};

type ResourceItem = {
  page_code: string;
  resource_code?: string;
  resource_type?: string;
  page_permission?: string;
  button_permission?: string[];
  data_permission?: string;
  field_permission?: Record<string, string>;
};

const dataPermissionOptions = [
  ["self_only", "本人创建"],
  ["own_organization", "当前管理架构"],
  ["organization_or_sub", "当前管理架构及下级"],
  ["own_students", "负责学员"],
  ["own_courses", "负责课程"],
  ["all", "全部数据"]
];

type PermissionFeature = { featureCode: string; featureName: string; pages: PermissionPage[] };
type PermissionModule = { moduleCode: string; moduleName: string; features: PermissionFeature[] };

function normalizeResource(raw: Record<string, unknown>): ResourceItem {
  const buttonPermission = Array.isArray(raw.button_permission) ? raw.button_permission.map(String) : [];
  const fieldPermission = raw.field_permission && typeof raw.field_permission === "object" && !Array.isArray(raw.field_permission)
    ? raw.field_permission as Record<string, string>
    : {};
  return {
    page_code: String(raw.page_code ?? ""),
    resource_code: String(raw.resource_code ?? raw.page_code ?? ""),
    resource_type: String(raw.resource_type ?? "page"),
    page_permission: String(raw.page_permission ?? "read"),
    button_permission: buttonPermission,
    data_permission: String(raw.data_permission ?? "organization_or_sub"),
    field_permission: fieldPermission,
  };
}

function defaultResource(page: PermissionPage): ResourceItem {
  return {
    page_code: page.pageCode,
    resource_code: page.pageCode,
    resource_type: "page",
    page_permission: "read",
    button_permission: page.actions.map((action) => action.actionCode),
    data_permission: "organization_or_sub",
    field_permission: {},
  };
}

export function PermissionEditor({
  scope,
  schemaName,
  roleId,
  value,
  onChange
}: {
  scope: "admin" | "tenant";
  schemaName?: string;
  roleId?: string;
  value: unknown;
  onChange: (items: ResourceItem[]) => void;
}) {
  const [pages, setPages] = useState<PermissionPage[]>([]);
  const [items, setItems] = useState<ResourceItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [activePage, setActivePage] = useState("");
  const [error, setError] = useState("");
  const [expandedModules, setExpandedModules] = useState<Record<string, boolean>>({});
  const [expandedFeatures, setExpandedFeatures] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    GatewayClient.executeApi({
      scope,
      schemaName,
      pageCode: "role_list",
      apiCode: "permission_config.meta",
      params: { roleId }
    })
      .then((result) => {
        if (cancelled) return;
        const data = result.data as { pages: PermissionPage[]; resources: Record<string, unknown>[] };
        setPages(data.pages);
        setActivePage((current) => current || data.pages[0]?.pageCode || "");
        const incoming = Array.isArray(value) && value.length ? value as ResourceItem[] : data.resources.map(normalizeResource);
        setItems(incoming);
        onChange(incoming);
        setError("");
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scope, schemaName, roleId]);

  const pageMap = useMemo(() => new Map(pages.map((page) => [page.pageCode, page])), [pages]);
  const tree = useMemo(() => {
    const moduleMap = new Map<string, PermissionModule>();
    for (const page of pages) {
      const moduleCode = page.moduleCode || "uncategorized";
      const moduleName = page.moduleName || "未分组菜单";
      const featureCode = page.featureCode || page.pageCode;
      const featureName = page.featureName || page.pageName;
      if (!moduleMap.has(moduleCode)) moduleMap.set(moduleCode, { moduleCode, moduleName, features: [] });
      const module = moduleMap.get(moduleCode)!;
      let feature = module.features.find((item) => item.featureCode === featureCode);
      if (!feature) {
        feature = { featureCode, featureName, pages: [] };
        module.features.push(feature);
      }
      feature.pages.push(page);
    }
    return [...moduleMap.values()];
  }, [pages]);
  const active = pageMap.get(activePage) ?? pages[0];
  const resource = items.find((item) => item.page_code === active?.pageCode);

  const commit = (next: ResourceItem[]) => {
    setItems(next);
    onChange(next);
  };

  const upsert = (page: PermissionPage, patch: Partial<ResourceItem>) => {
    const existing = items.find((item) => item.page_code === page.pageCode) ?? defaultResource(page);
    const nextItem = { ...existing, ...patch };
    commit([...items.filter((item) => item.page_code !== page.pageCode), nextItem]);
  };

  const togglePage = (page: PermissionPage, checked: boolean) => {
    if (!checked) {
      commit(items.filter((item) => item.page_code !== page.pageCode));
      return;
    }
    upsert(page, defaultResource(page));
  };

  const toggleModule = (moduleCode: string) => {
    setExpandedModules((current) => ({ ...current, [moduleCode]: !current[moduleCode] }));
  };

  const toggleFeature = (featureCode: string) => {
    setExpandedFeatures((current) => ({ ...current, [featureCode]: !current[featureCode] }));
  };

  const toggleAction = (page: PermissionPage, actionCode: string, checked: boolean) => {
    const current = items.find((item) => item.page_code === page.pageCode) ?? defaultResource(page);
    const selected = new Set(current.button_permission ?? []);
    if (checked) selected.add(actionCode);
    else selected.delete(actionCode);
    upsert(page, { button_permission: [...selected] });
  };

  const setHiddenFields = (text: string) => {
    if (!active) return;
    const fieldPermission: Record<string, string> = {};
    for (const field of text.split(",").map((item) => item.trim()).filter(Boolean)) {
      fieldPermission[field] = "hidden";
    }
    upsert(active, { field_permission: fieldPermission });
  };

  if (loading) return <div className="border border-[#dde3ee] bg-[#f8fafc] p-4 text-sm text-[#607083]">权限配置加载中...</div>;
  if (error) return <div className="border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>;

  return (
    <div className="grid min-h-[520px] grid-cols-[380px_minmax(0,1fr)] overflow-hidden border border-[#dde3ee] bg-white">
      <div className="overflow-auto border-r border-[#e8edf5] bg-[#f8fafc]">
        {tree.map((module) => (
          <div key={module.moduleCode} className="border-b border-[#e8edf5]">
            <button
              type="button"
              className="flex w-full items-center justify-between bg-[#eef3fa] px-3 py-2 text-left text-xs font-semibold text-[#526075] hover:bg-[#e5edf8]"
              onClick={() => toggleModule(module.moduleCode)}
            >
              <span className="truncate">{module.moduleName}</span>
              <span>{expandedModules[module.moduleCode] ? "收起" : "展开"}</span>
            </button>
            {expandedModules[module.moduleCode] && module.features.map((feature) => (
              <div key={feature.featureCode} className="border-t border-[#e8edf5]">
                <button
                  type="button"
                  className="flex w-full items-center justify-between px-4 py-2 text-left text-xs font-medium text-[#8b95a7] hover:bg-white"
                  onClick={() => toggleFeature(feature.featureCode)}
                >
                  <span className="truncate">{feature.featureName}</span>
                  <span>{expandedFeatures[feature.featureCode] ? "收起按钮" : "展开按钮"}</span>
                </button>
                {expandedFeatures[feature.featureCode] && feature.pages.map((page) => {
                  const pageResource = items.find((item) => item.page_code === page.pageCode);
                  const enabled = Boolean(pageResource);
                  return (
                    <div key={page.pageCode}>
                      <button
                        type="button"
                        className={`flex w-full items-center gap-2 px-5 py-2 text-left text-sm ${activePage === page.pageCode ? "bg-white text-[#2f80ed]" : "text-[#263445] hover:bg-white"}`}
                        onClick={() => setActivePage(page.pageCode)}
                      >
                        <input type="checkbox" checked={enabled} onChange={(event) => togglePage(page, event.target.checked)} onClick={(event) => event.stopPropagation()} />
                        <span className="min-w-0 flex-1 truncate">{page.pageName}</span>
                        <span className="text-xs text-[#a1acba]">{page.actions.length}</span>
                      </button>
                      {(
                        <div className="space-y-1 pb-2 pl-10 pr-3">
                          {page.actions.map((action) => (
                            <label key={action.actionCode} className={`flex items-center gap-2 px-2 py-1 text-xs hover:bg-white ${enabled ? "text-[#607083]" : "text-[#b0bac8]"}`}>
                              <input
                                type="checkbox"
                                checked={(pageResource?.button_permission ?? []).includes(action.actionCode)}
                                onChange={(event) => {
                                  if (!enabled) {
                                    upsert(page, { ...defaultResource(page), button_permission: event.target.checked ? [action.actionCode] : [] });
                                    return;
                                  }
                                  toggleAction(page, action.actionCode, event.target.checked);
                                }}
                              />
                              <span className="min-w-0 flex-1 truncate">{action.actionName}</span>
                            </label>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        ))}
      </div>
      {active ? (
        <div className="min-w-0 overflow-auto p-4">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold text-[#263445]">{active.pageName}</div>
              <div className="mt-1 text-xs text-[#8b95a7]">{active.pageCode}</div>
            </div>
            <label className="flex items-center gap-2 text-sm text-[#607083]">
              <input type="checkbox" checked={Boolean(resource)} onChange={(event) => togglePage(active, event.target.checked)} />
              启用页面
            </label>
          </div>
          {resource ? (
            <div className="space-y-5">
              <div className="grid gap-4 md:grid-cols-2">
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-[#5f6b7a]">页面权限</span>
                  <select className={token.input} value={resource.page_permission ?? "read"} onChange={(event) => upsert(active, { page_permission: event.target.value })}>
                    <option value="read">只读</option>
                    <option value="all">全部操作</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-[#5f6b7a]">数据权限</span>
                  <select className={token.input} value={resource.data_permission ?? "organization_or_sub"} onChange={(event) => upsert(active, { data_permission: event.target.value })}>
                    {dataPermissionOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </label>
              </div>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-[#5f6b7a]">隐藏字段</span>
                <input
                  className={token.input}
                  value={Object.entries(resource.field_permission ?? {}).filter(([, perm]) => perm === "hidden").map(([field]) => field).join(", ")}
                  placeholder="例如 contact,total_amount"
                  onChange={(event) => setHiddenFields(event.target.value)}
                />
              </label>
            </div>
          ) : (
            <div className="border border-dashed border-[#cfd8e6] p-8 text-center text-sm text-[#8b95a7]">启用页面后可配置数据权限和按钮权限</div>
          )}
        </div>
      ) : (
        <div className="p-8 text-center text-sm text-[#8b95a7]">暂无页面</div>
      )}
    </div>
  );
}
