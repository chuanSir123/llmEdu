import { useEffect, useMemo, useState, type ReactNode } from "react";
import { GatewayClient } from "../api/GatewayClient";
import type { ActionDsl, PageDsl, PageTargetDsl } from "../dsl/types";
import { token } from "../styles/designTokens";
import { ActionRenderer } from "./ActionRenderer";
import { GenericTableRenderer } from "./GenericTableRenderer";
import { ModalRenderer } from "./ModalRenderer";
import { GenericFormRenderer } from "./GenericFormRenderer";

type Presentation = NonNullable<PageDsl["presentation"]>;
type MetricDsl = {
  label: string;
  source: "total" | "countBy" | "sum";
  field?: string;
  value?: string | number | boolean;
  suffix?: string;
  target?: PageTargetDsl;
};

type RightRailSectionDsl = NonNullable<NonNullable<Presentation["dashboard"]>["rightRail"]>["sections"][number];
type RightRailItem = {
  tag?: string;
  text: string;
  meta?: string;
  target?: PageTargetDsl;
};

type ModalState =
  | { type: "create"; value: Record<string, unknown>; action?: ActionDsl }
  | { type: "edit"; value: Record<string, unknown>; action?: ActionDsl }
  | { type: "detail"; value: Record<string, unknown> }
  | null;

export function GenericPageRenderer({
  scope,
  schemaName,
  dsl,
  initialFilters,
  onOpenPage
}: {
  scope: "admin" | "tenant";
  schemaName?: string;
  dsl: PageDsl;
  initialFilters?: Record<string, unknown>;
  onOpenPage?: (pageCode: string, title: string, initialFilters?: Record<string, unknown>) => void;
}) {
  const [filters, setFilters] = useState<Record<string, unknown>>(initialFilters ?? {});
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [modal, setModal] = useState<ModalState>(null);
  const [rightRailItems, setRightRailItems] = useState<Record<string, RightRailItem[]>>({});

  const modalTitle = useMemo(() => {
    if (!modal) return "";
    if ("action" in modal && modal.action?.modalTitle) return modal.action.modalTitle;
    if (modal.type === "create") return `新增${dsl.title}`;
    if (modal.type === "edit") return `编辑${dsl.title}`;
    return `${dsl.title}详情`;
  }, [dsl.title, modal]);

  async function load(nextFilters = filters) {
    setLoading(true);
    setError("");
    try {
      const result = await GatewayClient.executeApi({
        scope,
        schemaName,
        pageCode: dsl.pageCode,
        apiCode: dsl.dataApi,
        params: { filters: nextFilters, page: 1, pageSize: 20 }
      });
      const data = result.data as { rows: Record<string, unknown>[]; total: number };
      setRows(data.rows);
      setTotal(data.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const nextFilters = initialFilters ?? {};
    setFilters(nextFilters);
    void load(nextFilters);
  }, [dsl.pageCode, JSON.stringify(initialFilters ?? {})]);

  async function submitModal() {
    if (!modal) return;
    const apiCode = "action" in modal && modal.action?.apiCode ? modal.action.apiCode : modal.type === "create" ? dsl.createApi : dsl.updateApi;
    await GatewayClient.executeApi({
      scope,
      schemaName,
      pageCode: dsl.pageCode,
      apiCode,
      params: { id: modal.value.id, data: modal.value }
    });
    setModal(null);
    await load();
  }

  async function onToolbar(action: ActionDsl) {
    if (action.actionCode.endsWith(".create")) {
      setModal({ type: "create", value: action.defaultValues ?? {}, action });
      return;
    }
    await load();
  }

  async function onRowAction(action: ActionDsl, row: Record<string, unknown>) {
    if (action.confirm && !window.confirm(action.confirm)) return;
    if (action.actionCode.endsWith(".detail")) {
      setModal({ type: "detail", value: row });
      return;
    }
    if (action.actionCode.endsWith(".edit")) {
      setModal({ type: "edit", value: row });
      return;
    }
    if (action.type === "open_modal" && action.fields?.length) {
      const mapped = Object.fromEntries(Object.entries(action.mapRowToValue ?? {}).map(([target, source]) => [target, row[source]]));
      setModal({ type: "create", value: { ...(action.defaultValues ?? {}), ...mapped }, action });
      return;
    }
    if (action.actionCode.endsWith(".delete")) {
      await GatewayClient.executeApi({
        scope,
        schemaName,
        pageCode: dsl.pageCode,
        apiCode: dsl.deleteApi,
        params: { id: row.id }
      });
      await load();
    }
  }

  function metricValue(metric: MetricDsl) {
    if (metric.source === "total") return total;
    if (metric.source === "countBy" && metric.field) {
      return rows.filter((row) => String(row[metric.field!]) === String(metric.value)).length;
    }
    if (metric.source === "sum" && metric.field) {
      return rows.reduce((sum, row) => sum + Number(row[metric.field!] ?? 0), 0).toLocaleString();
    }
    return "-";
  }

  function metricLabel(metric: MetricDsl) {
    return metric.label;
  }

  function openTarget(target: PageTargetDsl | undefined, fallbackTitle: string) {
    if (!target) return;
    onOpenPage?.(target.pageCode, target.title ?? fallbackTitle, target.filters);
  }

  function formatMeta(value: unknown) {
    if (value === null || value === undefined || value === "") return undefined;
    const text = String(value);
    if (/^\d{4}-\d{2}-\d{2}T/.test(text)) return text.slice(5, 10);
    return text;
  }

  function sectionFallbackItems(section: RightRailSectionDsl) {
    return section.items ?? [];
  }

  function mapSectionRows(section: RightRailSectionDsl, rows: Record<string, unknown>[]) {
    const source = section.dataSource;
    if (!source) return sectionFallbackItems(section);
    const dynamicItems = rows.map((row) => {
      const target = source.target
        ? {
            pageCode: source.target.pageCode,
            title: source.target.title,
            filters:
              source.target.filterField && source.target.rowField
                ? { [source.target.filterField]: row[source.target.rowField] }
                : source.target.filters
          }
        : undefined;
      return {
        tag: source.tag,
        text: String(row[source.textField] ?? "-"),
        meta: formatMeta(source.metaField ? row[source.metaField] : undefined),
        target
      };
    });
    return source.appendStaticItems ? [...dynamicItems, ...sectionFallbackItems(section)] : dynamicItems;
  }

  const metrics = dsl.presentation?.header?.metrics ?? [];
  const dashboard = dsl.presentation?.dashboard;
  const dashboardRows = rows.slice(0, dashboard?.panels?.[0]?.limit ?? 6);
  const createAction = dsl.toolbar.find((action) => action.actionCode.endsWith(".create") || action.actionCode.endsWith(".enroll"));
  const visibleModalFields = (fields: typeof dsl.modal.fields) => fields.filter((field) => field.key !== "id" && !field.hidden);

  useEffect(() => {
    const sections = dashboard?.rightRail?.sections ?? [];
    const sourcedSections = sections.filter((section) => section.dataSource);
    if (dsl.layout !== "dashboard" || !sourcedSections.length) {
      setRightRailItems({});
      return;
    }
    let cancelled = false;
    Promise.all(
      sourcedSections.map(async (section) => {
        const source = section.dataSource!;
        const result = await GatewayClient.executeApi({
          scope,
          schemaName,
          pageCode: source.pageCode,
          apiCode: source.apiCode,
          params: { filters: source.filters ?? {}, page: 1, pageSize: source.limit ?? 5 }
        });
        const data = result.data as { rows: Record<string, unknown>[] };
        return [section.title, mapSectionRows(section, data.rows)] as const;
      })
    )
      .then((entries) => {
        if (!cancelled) setRightRailItems(Object.fromEntries(entries));
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [dsl.pageCode, JSON.stringify(dashboard?.rightRail?.sections ?? [])]);

  if (dsl.layout === "dashboard") {
    const quickGradients = [
      "from-[#1665f8] to-[#315df7]",
      "from-[#4269f5] to-[#5362f7]",
      "from-[#5c63ec] to-[#7d62ee]",
      "from-[#8061e6] to-[#9966e8]",
      "from-[#a85bdd] to-[#c06ce3]",
      "from-[#cd6bd6] to-[#df73ce]"
    ];
    return (
      <div className="grid h-full grid-cols-[minmax(0,1fr)_360px] overflow-hidden bg-[#eef0f8]">
        <div className="overflow-auto p-6">
          {dashboard?.quickActions?.length ? (
            <section className="mb-6">
              <h2 className="mb-4 text-base font-semibold text-[#263445]">常用功能</h2>
              <div className="flex flex-wrap gap-5">
                {dashboard.quickActions.map((action, index) => (
                  <button
                    key={action.pageCode}
                    className={`h-[86px] w-[88px] rounded-[8px] bg-gradient-to-br ${quickGradients[index % quickGradients.length]} px-2 text-center text-xs font-semibold text-white shadow-[0_8px_18px_rgba(47,80,237,0.28)] transition hover:-translate-y-0.5`}
                    onClick={() => onOpenPage?.(action.pageCode, action.label, action.filters)}
                  >
                    <span className="block text-[28px] leading-8">◎</span>
                    <span className="mt-2 block">{action.label}</span>
                  </button>
                ))}
              </div>
            </section>
          ) : null}

          <section className="mb-6">
            <h2 className="mb-4 text-base font-semibold text-[#263445]">数据预览</h2>
            {metrics.length > 0 && (
              <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                {metrics.map((metric) => (
                  <button
                    key={`${metric.label}-${metric.field ?? metric.source}`}
                    className={`rounded-[8px] bg-white px-8 py-7 text-center shadow-[0_8px_22px_rgba(24,36,56,0.06)] transition ${
                      metric.target ? "cursor-pointer hover:-translate-y-0.5 hover:shadow-[0_12px_28px_rgba(24,36,56,0.1)]" : "cursor-default"
                    }`}
                    onClick={() => openTarget(metric.target, metricLabel(metric))}
                  >
                    <div className="text-[28px] font-semibold text-[#4968ff]">
                      {metricValue(metric)}
                      {metric.suffix && <span className="ml-1 text-xs font-normal text-[#8b95a7]">{metric.suffix}</span>}
                    </div>
                    <div className="mt-2 text-xs text-[#7a8494]">{metricLabel(metric)}</div>
                  </button>
                ))}
              </div>
            )}
          </section>

          <section>
            <h2 className="mb-4 text-base font-semibold text-[#263445]">月排行榜 TOP10</h2>
            {(dashboard?.panels ?? []).map((panel) => (
              <div key={panel.title} className="rounded-[6px] bg-white p-4 shadow-[0_8px_22px_rgba(24,36,56,0.06)]">
                <div className="mb-3 flex items-center gap-3">
                  <button className="h-8 min-w-[86px] border border-[#dde3ee] px-3 text-xs text-[#526075]">按分公司</button>
                  <button className="h-8 min-w-[86px] border border-[#dde3ee] px-3 text-xs text-[#526075]">校区业绩</button>
                  <button className="h-8 min-w-[86px] border border-[#dde3ee] px-3 text-xs text-[#526075]">统计指标</button>
                </div>
                <GenericTableRenderer
                  columns={panel.columns ?? dsl.table.columns}
                  rows={dashboardRows}
                  rowActions={[]}
                  onAction={() => undefined}
                  presentation={dsl.presentation}
                />
              </div>
            ))}
          </section>

          {error && <div className="mt-4 border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}
        </div>

        <aside className="overflow-auto border-l border-[#e8edf5] bg-white p-5">
          <div className="mb-6">
            <h2 className="mb-4 text-base font-semibold text-[#263445]">{dashboard?.rightRail?.title ?? "校区动态"}</h2>
            {(dashboard?.rightRail?.sections ?? []).map((section) => (
              <section key={section.title} className="mb-8">
                <div className="mb-3 text-sm font-semibold text-[#263445]">{section.title}</div>
                <div className="space-y-3">
                  {(rightRailItems[section.title] ?? section.items).map((item) => (
                    <button
                      key={`${section.title}-${item.text}`}
                      className={`flex w-full items-center justify-between gap-3 rounded-[4px] px-2 py-1.5 text-left text-xs transition ${
                        item.target ? "hover:bg-[#f2f7ff]" : "cursor-default"
                      }`}
                      onClick={() => openTarget(item.target, item.text)}
                    >
                      <div className="min-w-0">
                        {item.tag && <span className="mr-2 rounded-[3px] bg-[#e8f1ff] px-1.5 py-0.5 text-[#2f80ed]">{item.tag}</span>}
                        <span className="text-[#526075]">{item.text}</span>
                      </div>
                      <span className="shrink-0 text-[#8b95a7]">{item.meta}</span>
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </aside>
      </div>
    );
  }

  if (dsl.layout === "enrollment") {
    const enrollmentFields = createAction?.fields ?? dsl.modal.fields;
    const section = (title: string, children: ReactNode) => (
      <section className="border border-[#d9e3ed] bg-white">
        <div className="flex h-12 items-center justify-between border-b border-[#e8edf5] px-5">
          <h2 className="text-sm font-semibold text-[#263445]">{title}</h2>
        </div>
        <div className="p-5">{children}</div>
      </section>
    );
    return (
      <div className="h-full overflow-auto bg-[#eef0f8] p-4">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h1 className="text-base font-semibold text-[#172033]">{dsl.title}</h1>
            <p className="mt-1 text-xs text-[#607083]">{dsl.presentation?.header?.subtitle ?? dsl.subtitle}</p>
          </div>
          <button
            className={`${token.button} ${token.primaryButton}`}
            onClick={() => setModal({ type: "create", value: createAction?.defaultValues ?? {}, action: createAction })}
          >
            保存合同
          </button>
        </div>
        <div className="space-y-3">
          {section(
            "学员信息",
            <GenericFormRenderer
              scope={scope}
              schemaName={schemaName}
              fields={visibleModalFields(enrollmentFields).slice(0, 6)}
              value={createAction?.defaultValues ?? {}}
              onChange={() => undefined}
              presentation={dsl.presentation}
              columns={3}
              labelAlign="left"
            />
          )}
          {section(
            "报读课程",
            <div>
              <GenericFormRenderer
                scope={scope}
                schemaName={schemaName}
                fields={visibleModalFields(enrollmentFields).filter((field) => ["product_ids", "promotion_id", "total_amount", "promotion_amount"].includes(field.key))}
                value={createAction?.defaultValues ?? {}}
                onChange={() => undefined}
                presentation={dsl.presentation}
                columns={3}
                labelAlign="left"
              />
              <div className="mt-4 min-h-[82px] border border-[#e8edf5] bg-[#f8fafc] px-4 py-7 text-center text-sm text-[#8b95a7]">
                请选择要报读的课程
              </div>
            </div>
          )}
          <div className="grid gap-3 xl:grid-cols-[1fr_360px]">
            {section(
              "业务属性",
              <GenericFormRenderer
                scope={scope}
                schemaName={schemaName}
                fields={visibleModalFields(enrollmentFields).filter((field) => ["contract_type", "organization_id", "sign_staff_id", "sign_time", "remark"].includes(field.key))}
                value={createAction?.defaultValues ?? {}}
                onChange={() => undefined}
                presentation={dsl.presentation}
                columns={2}
                labelAlign="left"
              />
            )}
            {section(
              "结算",
              <div className="space-y-4 text-sm">
                <div className="flex justify-between text-[#607083]"><span>共 0 个课程，总金额</span><span>0.00 元</span></div>
                <div className="flex justify-between text-[#607083]"><span>课程优惠</span><span className="text-[#d92d20]">-0.00 元</span></div>
                <div className="flex justify-between text-[#607083]"><span>合同优惠</span><span className="text-[#d92d20]">-0.00 元</span></div>
                <div className="flex justify-between border-t border-[#e8edf5] pt-4 text-base font-semibold text-[#2f80ed]"><span>合同应收款</span><span>0.00 元</span></div>
              </div>
            )}
          </div>
        </div>
        {modal && (
          <ModalRenderer
            scope={scope}
            schemaName={schemaName}
            title={modalTitle}
            fields={visibleModalFields("action" in modal && modal.action?.fields?.length ? modal.action.fields : dsl.modal.fields)}
            value={modal.value}
            readonly={modal.type === "detail"}
            onChange={(value) => setModal({ ...modal, value })}
            onClose={() => setModal(null)}
            onSubmit={submitModal}
            presentation={dsl.presentation}
            size={"action" in modal ? modal.action?.modalSize : undefined}
          />
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden p-4">
      <div className="mb-3 flex items-start justify-between border-b border-[#d9e3ed] pb-3">
        <div>
          <h1 className="text-base font-semibold text-[#172033]">{dsl.title}</h1>
          {(dsl.presentation?.header?.subtitle ?? dsl.subtitle) && (
            <p className="mt-1 text-xs text-[#607083]">{dsl.presentation?.header?.subtitle ?? dsl.subtitle}</p>
          )}
        </div>
        <div className="text-sm text-[#607083]">{loading ? "加载中..." : `共 ${total} 条`}</div>
      </div>
      {metrics.length > 0 && (
        <div className="mb-3 grid grid-cols-1 gap-3 md:grid-cols-3">
          {metrics.map((metric) => (
            <button
              key={`${metric.label}-${metric.field ?? metric.source}`}
              className={`border border-[#d9e3ed] bg-white px-4 py-3 text-left transition ${metric.target ? "hover:border-[#2f80ed]" : "cursor-default"}`}
              onClick={() => openTarget(metric.target, metricLabel(metric))}
            >
              <div className="text-xs font-medium text-[#607083]">{metricLabel(metric)}</div>
              <div className="mt-1 text-xl font-semibold text-[#172033]">
                {metricValue(metric)}
                {metric.suffix && <span className="ml-1 text-xs font-normal text-[#607083]">{metric.suffix}</span>}
              </div>
            </button>
          ))}
        </div>
      )}
      <div className={token.filterBar}>
        {dsl.filters.map((field) => (
          <label key={field.key} className="flex flex-col gap-1 text-xs font-medium text-[#607083]">
            {field.label}
            <input
              className={token.input}
              value={String(filters[field.key] ?? "")}
              placeholder={field.placeholder}
              onChange={(event) => setFilters({ ...filters, [field.key]: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter") void load();
              }}
            />
          </label>
        ))}
        <button className={`${token.button} ${token.primaryButton}`} onClick={() => void load()}>
          查询
        </button>
        <button className={`${token.button} ${token.defaultButton}`} onClick={() => { setFilters({}); void load({}); }}>
          重置
        </button>
      </div>
      <div className="mb-3 flex flex-wrap gap-2">
        {dsl.toolbar.map((action) => (
          <ActionRenderer key={action.actionCode} action={action} onClick={onToolbar} />
        ))}
      </div>
      {error && <div className="mb-3 border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}
      <div className="min-h-0 flex-1 overflow-auto">
        <GenericTableRenderer
          columns={dsl.table.columns}
          rows={rows}
          rowActions={dsl.table.rowActions}
          onAction={onRowAction}
          presentation={dsl.presentation}
        />
      </div>
      {modal && (
        <ModalRenderer
          scope={scope}
          schemaName={schemaName}
          title={modalTitle}
          fields={visibleModalFields("action" in modal && modal.action?.fields?.length ? modal.action.fields : dsl.modal.fields)}
          value={modal.value}
          readonly={modal.type === "detail"}
          onChange={(value) => setModal({ ...modal, value })}
          onClose={() => setModal(null)}
          onSubmit={submitModal}
          presentation={dsl.presentation}
          size={"action" in modal ? modal.action?.modalSize : undefined}
        />
      )}
    </div>
  );
}
