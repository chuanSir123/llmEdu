import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { GatewayClient } from "../api/GatewayClient";
import type { ActionDsl, PageDsl, PageTargetDsl } from "../dsl/types";
import { sortWithOrder } from "../dsl/sortWithOrder";
import { useToast } from "../context/ToastContext";
import { token } from "../styles/designTokens";
import { ActionRenderer } from "./ActionRenderer";
import { GenericTableRenderer } from "./GenericTableRenderer";
import { ModalRenderer } from "./ModalRenderer";
import { GenericFormRenderer } from "./GenericFormRenderer";
import { ImportHandler } from "./ImportHandler";
import { exportToExcel } from "./ExportHandler";
import { CustomizationRecordDetail } from "./CustomizationRecordDetail";

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
  refreshKey,
  onOpenPage,
  onOpenAiCustomization,
  onContinueAiCustomization
}: {
  scope: "admin" | "tenant";
  schemaName?: string;
  dsl: PageDsl;
  initialFilters?: Record<string, unknown>;
  refreshKey?: number;
  onOpenPage?: (pageCode: string, title: string, initialFilters?: Record<string, unknown>) => void;
  onOpenAiCustomization?: () => void;
  onContinueAiCustomization?: (sessionId?: string) => void;
}) {
  const filtersDsl = dsl.filters ?? [];
  const toolbarDsl = dsl.toolbar ?? [];
  const tableDsl = dsl.table ?? { columns: [], rowActions: [] };
  const modalDsl = dsl.modal ?? { fields: [] };
  const toast = useToast();
  const [filters, setFilters] = useState<Record<string, unknown>>(initialFilters ?? {});
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const pageSize = dsl.presentation?.table?.pageSize ?? 50;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [modal, setModal] = useState<ModalState>(null);
  const [customizationRecordId, setCustomizationRecordId] = useState("");
  const [importConfig, setImportConfig] = useState<Record<string, unknown> | null>(null);
  const [rightRailItems, setRightRailItems] = useState<Record<string, RightRailItem[]>>({});
  const [enrollmentValue, setEnrollmentValue] = useState<Record<string, unknown>>({});
  const remoteProductOptionsRef = useRef<Array<{ value: string; label: string; row: Record<string, unknown> }>>([]);
  const remotePromotionOptionsRef = useRef<Array<{ value: string; label: string; row: Record<string, unknown> }>>([]);

  const createAction = toolbarDsl.find((action) => action.actionCode.endsWith(".create") || action.actionCode.endsWith(".enroll"));
  const enrollmentFields = dsl.layout === "enrollment" ? (createAction?.fields ?? modalDsl.fields) : [];
  const enrollmentValueWithDefaults = dsl.layout === "enrollment" ? { ...(createAction?.defaultValues ?? {}), ...enrollmentValue } : {};

  const selectedProductIds = useMemo(() => {
    if (dsl.layout !== "enrollment") return [] as string[];
    return (Array.isArray(enrollmentValueWithDefaults.product_ids) ? enrollmentValueWithDefaults.product_ids : []) as string[];
  }, [dsl.layout, dsl.pageCode, enrollmentValueWithDefaults.product_ids]);

  const productRows = useMemo(() => {
    if (dsl.layout !== "enrollment" || !selectedProductIds.length) return [] as Record<string, unknown>[];
    return selectedProductIds.map((pid) => {
      const opt = (remoteProductOptionsRef.current ?? []).find((o) => o.value === String(pid));
      return opt?.row ?? {};
    });
  }, [dsl.layout, selectedProductIds]);

  function mappedRowValues(action: ActionDsl, row: Record<string, unknown>) {
    return Object.fromEntries(
      Object.entries(action.mapRowToValue ?? {}).map(([target, source]) => {
        const value = row[source];
        return [target, target.endsWith("_ids") && value !== undefined && !Array.isArray(value) ? [value] : value];
      })
    );
  }

  function targetFilters(target: PageTargetDsl | undefined, row?: Record<string, unknown>) {
    if (!target) return undefined;
    const filtersFromRow = row && target.filterField && target.rowField ? { [target.filterField]: row[target.rowField] } : {};
    return { ...(target.filters ?? {}), ...filtersFromRow };
  }

  const contractProducts = useMemo(() => {
    if (dsl.layout !== "enrollment") return [] as Array<{ productId: string; productName: string; productType: string; courseHour: number; unitPrice: number; totalAmount: number; promotionAmount: number }>;
    return selectedProductIds.map((pid, idx) => {
      const productRow = productRows[idx] ?? {};
      const cpKey = `cp_${pid}`;
      const existing = enrollmentValueWithDefaults[cpKey] as Record<string, unknown> | undefined;
      const defaultHour = Number(productRow.default_course_hour ?? 0);
      const unitPrice = Number(productRow.unit_price ?? 0);
      const defaultTotal = Number(productRow.total_amount ?? 0);
      const courseHour = existing && "course_hour" in existing ? Number(existing.course_hour ?? 0) : defaultHour;
      const cpUnitPrice = existing && "unit_price" in existing ? Number(existing.unit_price ?? 0) : unitPrice;
      const cpTotal = existing && "total_amount" in existing ? Number(existing.total_amount ?? 0) : defaultTotal;
      const cpPromotionAmount = existing && "promotion_amount" in existing ? Number(existing.promotion_amount ?? 0) : 0;
      return {
        productId: pid,
        productName: String(productRow.name ?? ""),
        productType: String(productRow.product_type ?? ""),
        courseHour: Math.round(courseHour * 100) / 100,
        unitPrice: Math.round(cpUnitPrice * 100) / 100,
        totalAmount: Math.round(cpTotal * 100) / 100,
        promotionAmount: Math.round(cpPromotionAmount * 100) / 100
      };
    });
  }, [dsl.layout, selectedProductIds, productRows, enrollmentValueWithDefaults]);

  const promotionId = dsl.layout === "enrollment" ? String(enrollmentValueWithDefaults.promotion_id ?? "") : "";

  const promotionRow = useMemo(() => {
    if (dsl.layout !== "enrollment" || !promotionId) return null as Record<string, unknown> | null;
    const opt = (remotePromotionOptionsRef.current ?? []).find((o) => o.value === promotionId);
    return opt?.row ?? null;
  }, [dsl.layout, promotionId]);

  const computedTotals = useMemo(() => {
    if (dsl.layout !== "enrollment") return { totalProductAmount: 0, contractPromotionAmount: 0, productPromotionTotal: 0, allPromotion: 0, receivable: 0 };
    const totalProductAmount = contractProducts.reduce((sum, cp) => sum + cp.totalAmount, 0);
    let contractPromotionAmount = 0;
    if (promotionRow) {
      const promoType = String(promotionRow.type ?? "");
      const promoValue = Number(promotionRow.value ?? 0);
      if (promoType === "REDUCE") {
        contractPromotionAmount = promoValue;
      } else if (promoType === "DISCOUNT") {
        contractPromotionAmount = Math.round(totalProductAmount * (1 - promoValue / 10) * 100) / 100;
      }
    }
    const productPromotionTotal = contractProducts.reduce((sum, cp) => sum + cp.promotionAmount, 0);
    const allPromotion = contractPromotionAmount + productPromotionTotal;
    const receivable = totalProductAmount - allPromotion;
    return { totalProductAmount, contractPromotionAmount, productPromotionTotal, allPromotion, receivable };
  }, [dsl.layout, contractProducts, promotionRow]);

  const modalTitle = useMemo(() => {
    if (!modal) return "";
    if ("action" in modal && modal.action?.modalTitle) return modal.action.modalTitle;
    if (modal.type === "create") return `新增${dsl.title}`;
    if (modal.type === "edit") return `编辑${dsl.title}`;
    return `${dsl.title}详情`;
  }, [dsl.title, modal]);

  function currentMonthRange() {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    const fmt = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    return [fmt(start), fmt(end)];
  }

  function daysBetween(start: string, end: string) {
    return Math.floor((new Date(`${end}T00:00:00`).getTime() - new Date(`${start}T00:00:00`).getTime()) / 86400000) + 1;
  }

  function normalizedFilters(input: Record<string, unknown>) {
    const next = { ...input };
    for (const field of filtersDsl) {
      if (field.type !== "date_range" && field.type !== "daterange") continue;
      const fallback = field.defaultRange === "current_month" || field.required ? currentMonthRange() : [];
      const rawValue = next[field.key];
      const raw = Array.isArray(rawValue) ? rawValue.map(String) : [];
      let start = raw[0] && /^\d{4}-\d{2}-\d{2}$/.test(raw[0]) ? raw[0] : fallback[0];
      let end = raw[1] && /^\d{4}-\d{2}-\d{2}$/.test(raw[1]) ? raw[1] : fallback[1];
      if (start && end && start > end) [start, end] = [end, start];
      const maxRangeDays = field.maxRangeDays ?? 366;
      if (start && end && daysBetween(start, end) > maxRangeDays) {
        const startDate = new Date(`${start}T00:00:00`);
        startDate.setDate(startDate.getDate() + maxRangeDays - 1);
        end = startDate.toISOString().slice(0, 10);
        toast.error(`${field.label ?? "日期范围"}最大只能查询1年`);
      }
      if (start && end) next[field.key] = [start, end];
    }
    return next;
  }

  function currentWeekRange() {
    const now = new Date();
    const day = now.getDay() || 7;
    const monday = new Date(now);
    monday.setDate(now.getDate() - day + 1);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    return [monday.toISOString().slice(0, 10), sunday.toISOString().slice(0, 10)];
  }

  async function load(nextFilters = filters, nextPage = page) {
    setLoading(true);
    setError("");
    try {
      const effectiveFilters = normalizedFilters(nextFilters);
      setFilters(effectiveFilters);
      const result = await GatewayClient.executeApi({
        scope,
        schemaName,
        pageCode: dsl.pageCode,
        apiCode: dsl.dataApi,
        params: { filters: effectiveFilters, page: nextPage, pageSize, schemaName }
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
    const nextFilters = initialFilters ?? (dsl.pageCode === "course_week_schedule" ? { course_date: currentWeekRange() } : {});
    setFilters(nextFilters);
    setPage(1);
    setEnrollmentValue({});
    setImportConfig(null);
    void load(nextFilters, 1);
  }, [dsl.pageCode, JSON.stringify(initialFilters ?? {}), refreshKey]);

  async function submitModal() {
    if (!modal) return;
    const apiCode = "action" in modal && modal.action?.apiCode ? modal.action.apiCode : modal.type === "create" ? dsl.createApi : dsl.updateApi;
    const actionLabel = "action" in modal && modal.action?.label ? modal.action.label : modal.type === "create" ? `新增${dsl.title}` : modal.type === "edit" ? `编辑${dsl.title}` : dsl.title;
    try {
      await GatewayClient.executeApi({
        scope,
        schemaName,
        pageCode: dsl.pageCode,
        apiCode,
        params: { id: modal.value.id, data: modal.value }
      });
      toast.success(`${actionLabel}成功`);
      setModal(null);
      await load(filters, page);
    } catch (err) {
      toast.error(`${actionLabel}失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function submitEnrollment() {
    if (!createAction) return;
    const apiCode = createAction.apiCode ?? dsl.createApi;
    const submitData: Record<string, unknown> = { ...(createAction.defaultValues ?? {}), ...enrollmentValue };
    const productIds = (Array.isArray(submitData.product_ids) ? submitData.product_ids : []) as string[];
    if (productIds.length) {
      const contractProducts = productIds.map((pid) => {
        const cpKey = `cp_${pid}`;
        const cpData = (submitData[cpKey] ?? {}) as Record<string, unknown>;
        return {
          product_id: pid,
          plan_real_hour: cpData.course_hour,
          plan_real_amount: cpData.total_amount,
          plan_promotion_amount: cpData.promotion_amount,
          unit_price: cpData.unit_price
        };
      });
      submitData.contract_products = contractProducts;
      for (const pid of productIds) {
        delete submitData[`cp_${pid}`];
      }
      if (!submitData.total_amount) {
        submitData.total_amount = contractProducts.reduce((sum: number, cp: Record<string, unknown>) => sum + Number(cp.plan_real_amount ?? 0), 0);
      }
      if (!submitData.promotion_amount) {
        submitData.promotion_amount = contractProducts.reduce((sum: number, cp: Record<string, unknown>) => sum + Number(cp.plan_promotion_amount ?? 0), 0);
      }
    }
    try {
      await GatewayClient.executeApi({
        scope,
        schemaName,
        pageCode: dsl.pageCode,
        apiCode,
        params: { data: submitData }
      });
      toast.success(`${createAction.label ?? "保存"}成功`);
      setEnrollmentValue({});
      await load(filters, page);
    } catch (err) {
      toast.error(`${createAction.label ?? "保存"}失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function isImportToolbarAction(action: ActionDsl) {
    return (
      action.type === "import" ||
      action.actionType === "import" ||
      (action.actionCode.endsWith(".import") && Boolean(action.importConfig))
    );
  }

  async function onToolbar(action: ActionDsl) {
    if (action.type === "open_ai_customization" || action.actionType === "open_ai_customization") {
      onOpenAiCustomization?.();
      return;
    }
    if (action.type === "open_page" || action.actionType === "open_page") {
      const target = action.target ?? (action.targetPageCode ? { pageCode: action.targetPageCode, title: action.label } : undefined);
      openTarget(target, action.label ?? "打开页面", targetFilters(target));
      return;
    }
    if (action.actionCode.endsWith(".create")) {
      setModal({ type: "create", value: action.defaultValues ?? {}, action });
      return;
    }
    if (isImportToolbarAction(action)) {
      setImportConfig((action.importConfig as Record<string, unknown> | undefined) ?? { apiCode: dsl.createApi });
      return;
    }
    if (action.type === "export" || action.actionType === "export" || action.actionCode.endsWith(".export")) {
      await exportToExcel(dsl, rows);
      return;
    }
    await load();
  }

  async function onRowAction(action: ActionDsl, row: Record<string, unknown>) {
    if (action.confirm && !window.confirm(typeof action.confirm === "string" ? action.confirm : "确认操作？")) return;
    if (action.actionCode.endsWith(".detail")) {
      if (dsl.pageCode === "customization_record_list" || dsl.pageCode === "assistant_record_list") {
        setCustomizationRecordId(String(row.id ?? ""));
        return;
      }
      setModal({ type: "detail", value: row });
      return;
    }
    if (action.actionCode.endsWith(".edit")) {
      setModal({ type: "edit", value: row });
      return;
    }
    if (action.type === "open_page" || action.actionType === "open_page") {
      const target = action.target ?? (action.targetPageCode ? { pageCode: action.targetPageCode, title: action.label } : undefined);
      openTarget(target, action.label ?? "打开页面", targetFilters(target, row));
      return;
    }
    if (action.type === "open_modal" && action.fields?.length) {
      const mapped = mappedRowValues(action, row);
      setModal({ type: "create", value: { ...(action.defaultValues ?? {}), ...mapped }, action });
      return;
    }
    if (action.type === "execute_api" || action.actionType === "execute_api" || action.apiCode) {
      const mapped = mappedRowValues(action, row);
      const data = { ...row, ...(action.defaultValues ?? {}), ...mapped };
      const params = (action.apiCode ?? action.actionCode).endsWith(".update")
        ? { id: row.id, data }
        : { ...(action.defaultValues ?? {}), ...row, ...mapped, id: row.id, versionId: row.id };
      try {
        await GatewayClient.executeApi({
          scope,
          schemaName,
          pageCode: dsl.pageCode,
          apiCode: action.apiCode ?? action.actionCode,
          params
        });
        toast.success(`${action.label ?? "操作"}成功`);
        await load(filters, page);
      } catch (err) {
        toast.error(`${action.label ?? "操作"}失败：${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }
    if (action.actionCode.endsWith(".delete")) {
      try {
        await GatewayClient.executeApi({
          scope,
          schemaName,
          pageCode: dsl.pageCode,
          apiCode: dsl.deleteApi,
          params: { id: row.id }
        });
        toast.success("删除成功");
        await load(filters, page);
      } catch (err) {
        toast.error(`删除失败：${err instanceof Error ? err.message : String(err)}`);
      }
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

  function openTarget(target: PageTargetDsl | undefined, fallbackTitle: string, initialFilters = target?.filters) {
    if (!target) return;
    onOpenPage?.(target.pageCode, target.title ?? fallbackTitle, initialFilters);
  }

  function formatMeta(value: unknown) {
    if (value === null || value === undefined || value === "") return undefined;
    const text = String(value);
    if (/^\d{4}-\d{2}-\d{2}T/.test(text)) return text.slice(5, 10);
    return text;
  }

  function renderFilterInput(field: typeof filtersDsl[number]) {
    if (field.type === "date_range" || field.type === "daterange") {
      const range = Array.isArray(filters[field.key]) ? filters[field.key] as unknown[] : currentMonthRange();
      const start = String(range[0] ?? "");
      const end = String(range[1] ?? "");
      const updateRange = (index: 0 | 1, value: string) => {
        const nextRange = [start, end];
        nextRange[index] = value;
        setFilters({ ...filters, [field.key]: nextRange });
      };
      return (
        <div className="flex items-center gap-2">
          <input
            type="date"
            className={`${token.input} min-w-[150px]`}
            value={start}
            aria-label={`${field.label ?? "日期"}开始日期`}
            onChange={(event) => updateRange(0, event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") { setPage(1); void load(filters, 1); }
            }}
          />
          <span className="text-sm text-[#8b95a7]">至</span>
          <input
            type="date"
            className={`${token.input} min-w-[150px]`}
            value={end}
            aria-label={`${field.label ?? "日期"}结束日期`}
            onChange={(event) => updateRange(1, event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") { setPage(1); void load(filters, 1); }
            }}
          />
        </div>
      );
    }
    const inputType = field.type === "date" ? "date" : field.type === "datetime" ? "datetime-local" : "text";
    return (
      <input
        type={inputType}
        className={token.input}
        value={String(filters[field.key] ?? "")}
        placeholder={field.placeholder}
        onChange={(event) => setFilters({ ...filters, [field.key]: event.target.value })}
        onKeyDown={(event) => {
          if (event.key === "Enter") { setPage(1); void load(filters, 1); }
        }}
      />
    );
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

  const visibleModalFields = (fields: typeof modalDsl.fields = []) => fields.filter((field) => field.key !== "id" && !field.hidden);
  const modalFields = (state: NonNullable<ModalState>) =>
    visibleModalFields(state.type === "detail" ? tableDsl.columns : "action" in state && state.action?.fields?.length ? state.action.fields : modalDsl.fields);

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

  useEffect(() => {
    if (dsl.layout !== "enrollment") return;
    let cancelled = false;
    const productField = (createAction?.fields ?? modalDsl.fields).find((f) => f.key === "product_ids");
    const promoField = (createAction?.fields ?? modalDsl.fields).find((f) => f.key === "promotion_id");
    const loads: Promise<void>[] = [];
    if (productField?.optionSource) {
      loads.push(
        GatewayClient.executeApi({
          scope, schemaName,
          pageCode: productField.optionSource.pageCode,
          apiCode: productField.optionSource.apiCode,
          params: { filters: productField.optionSource.filters ?? { status: "ACTIVE" }, page: 1, pageSize: 200 }
        }).then((result) => {
          if (cancelled) return;
          const data = result.data as { rows: Record<string, unknown>[] };
          const vf = productField.optionSource!.valueField ?? "id";
          const lf = productField.optionSource!.labelField ?? "name";
          remoteProductOptionsRef.current = data.rows.map((row) => ({ value: String(row[vf] ?? ""), label: String(row[lf] ?? ""), row }));
        })
      );
    }
    if (promoField?.optionSource) {
      loads.push(
        GatewayClient.executeApi({
          scope, schemaName,
          pageCode: promoField.optionSource.pageCode,
          apiCode: promoField.optionSource.apiCode,
          params: { filters: promoField.optionSource.filters ?? { status: "ACTIVE" }, page: 1, pageSize: 200 }
        }).then((result) => {
          if (cancelled) return;
          const data = result.data as { rows: Record<string, unknown>[] };
          const vf = promoField.optionSource!.valueField ?? "id";
          const lf = promoField.optionSource!.labelField ?? "name";
          remotePromotionOptionsRef.current = data.rows.map((row) => ({ value: String(row[vf] ?? ""), label: String(row[lf] ?? ""), row }));
        })
      );
    }
    if (loads.length) Promise.all(loads).catch(() => {});
    return () => { cancelled = true; };
  }, [dsl.pageCode, dsl.layout]);

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
                  columns={panel.columns ?? tableDsl.columns ?? []}
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
    const byKeys = (keys: string[]) => visibleModalFields(enrollmentFields).filter((field) => keys.includes(field.key));

    function r2(v: number) { return Math.round(v * 100) / 100; }

    function updateCpField(productId: string, field: string, rawValue: unknown) {
      const cpKey = `cp_${productId}`;
      const existing = (enrollmentValueWithDefaults[cpKey] ?? {}) as Record<string, unknown>;
      const numVal = rawValue === "" ? 0 : r2(Number(rawValue));
      let next = { ...existing, [field]: numVal };
      if (field === "course_hour" || field === "unit_price") {
        const hour = field === "course_hour" ? numVal : r2(Number(existing.course_hour ?? 0));
        const price = field === "unit_price" ? numVal : r2(Number(existing.unit_price ?? 0));
        next.total_amount = r2(hour * price);
      }
      if (field === "total_amount") {
        const hour = r2(Number(existing.course_hour ?? 0));
        if (hour > 0) next.unit_price = r2(numVal / hour);
      }
      setEnrollmentValue({ ...enrollmentValueWithDefaults, [cpKey]: next });
    }

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
        </div>
        <div className="space-y-3">
          {section(
            "学员信息",
            <GenericFormRenderer
              scope={scope}
              schemaName={schemaName}
              fields={byKeys(["student_id"])}
              value={enrollmentValueWithDefaults}
              onChange={(next) => setEnrollmentValue(next)}
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
                fields={byKeys(["product_ids"])}
                value={enrollmentValueWithDefaults}
                onChange={(next) => {
                  const newIds = (Array.isArray(next.product_ids) ? next.product_ids : []) as string[];
                  const oldIds = (Array.isArray(enrollmentValueWithDefaults.product_ids) ? enrollmentValueWithDefaults.product_ids : []) as string[];
                  const added = newIds.filter((id: string) => !oldIds.includes(id));
                  const merged = { ...enrollmentValueWithDefaults, ...next };
                  for (const pid of added) {
                    const productRow = productRows[selectedProductIds.length] ?? (remoteProductOptionsRef.current ?? []).find((o) => o.value === String(pid))?.row ?? {};
                    const cpKey = `cp_${pid}`;
                    if (!merged[cpKey]) {
                      const hour = r2(Number(productRow.default_course_hour ?? 0));
                      const price = r2(Number(productRow.unit_price ?? 0));
                      const total = r2(Number(productRow.total_amount ?? hour * price));
                      merged[cpKey] = { course_hour: hour, unit_price: price, total_amount: total, promotion_amount: 0 };
                    }
                  }
                  for (const oldId of oldIds) {
                    if (!newIds.includes(oldId)) delete merged[`cp_${oldId}`];
                  }
                  setEnrollmentValue(merged);
                }}
                presentation={dsl.presentation}
                columns={3}
                labelAlign="left"
              />
              {contractProducts.length > 0 && (
                <div className="mt-4 overflow-hidden rounded border border-[#e8edf5]">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-[#f8fafc] text-[#5f6b7a]">
                        <th className="px-3 py-2 text-left font-medium">课程产品</th>
                        <th className="px-3 py-2 text-center font-medium w-[100px]">课时</th>
                        <th className="px-3 py-2 text-center font-medium w-[100px]">单价</th>
                        <th className="px-3 py-2 text-center font-medium w-[110px]">总价</th>
                        <th className="px-3 py-2 text-center font-medium w-[110px]">优惠金额</th>
                      </tr>
                    </thead>
                    <tbody>
                      {contractProducts.map((cp) => (
                        <tr key={cp.productId} className="border-t border-[#e8edf5]">
                          <td className="px-3 py-2">
                            <div className="font-medium text-[#263445]">{cp.productName}</div>
                            <div className="text-xs text-[#8b95a7]">
                              {dsl.presentation?.valueLabels?.product_type?.[cp.productType] ?? cp.productType}
                            </div>
                          </td>
                          <td className="px-3 py-2">
                            <input type="number" step="0.01" className={`${token.input} w-full text-center`} value={cp.courseHour || ""} onChange={(e) => updateCpField(cp.productId, "course_hour", e.target.value)} />
                          </td>
                          <td className="px-3 py-2">
                            <input type="number" step="0.01" className={`${token.input} w-full text-center`} value={cp.unitPrice || ""} onChange={(e) => updateCpField(cp.productId, "unit_price", e.target.value)} />
                          </td>
                          <td className="px-3 py-2">
                            <input type="number" step="0.01" className={`${token.input} w-full text-center`} value={cp.totalAmount || ""} onChange={(e) => updateCpField(cp.productId, "total_amount", e.target.value)} />
                          </td>
                          <td className="px-3 py-2">
                            <input type="number" step="0.01" className={`${token.input} w-full text-center bg-[#f5f7fa]`} value={cp.promotionAmount || ""} readOnly />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {!contractProducts.length && (
                <div className="mt-4 min-h-[82px] border border-[#e8edf5] bg-[#f8fafc] px-4 py-7 text-center text-sm text-[#8b95a7]">
                  请选择要报读的课程
                </div>
              )}
            </div>
          )}
          <div className="grid gap-3 xl:grid-cols-[1fr_360px]">
            {section(
              "业务属性",
              <GenericFormRenderer
                scope={scope}
                schemaName={schemaName}
                fields={byKeys(["contract_type", "organization_id", "sign_staff_id", "sign_time", "promotion_id", "remark"])}
                value={enrollmentValueWithDefaults}
                onChange={(next) => {
                  const promoChanged = next.promotion_id !== enrollmentValueWithDefaults.promotion_id;
                  if (promoChanged && next.promotion_id) {
                    const promoOpt = (remotePromotionOptionsRef.current ?? []).find((o) => o.value === String(next.promotion_id));
                    const promo = promoOpt?.row;
                    if (promo && contractProducts.length) {
                      const promoType = String(promo.type ?? "");
                      const promoValue = Number(promo.value ?? 0);
                      const totalProductAmount = contractProducts.reduce((sum, cp) => sum + cp.totalAmount, 0);
                      let totalPromotion = 0;
                      if (promoType === "REDUCE") totalPromotion = promoValue;
                      else if (promoType === "DISCOUNT") totalPromotion = r2(totalProductAmount * (1 - promoValue / 10));
                      let remaining = totalPromotion;
                      const merged = { ...enrollmentValueWithDefaults, ...next };
                      contractProducts.forEach((cp, idx) => {
                        const cpKey = `cp_${cp.productId}`;
                        const existing = (merged[cpKey] ?? {}) as Record<string, unknown>;
                        const share = idx === contractProducts.length - 1
                          ? r2(remaining)
                          : totalProductAmount > 0 ? r2(totalPromotion * (cp.totalAmount / totalProductAmount)) : 0;
                        remaining -= share;
                        merged[cpKey] = { ...existing, promotion_amount: r2(share) };
                      });
                      setEnrollmentValue(merged);
                      return;
                    }
                  }
                  if (promoChanged && !next.promotion_id) {
                    const merged = { ...enrollmentValueWithDefaults, ...next };
                    for (const cp of contractProducts) {
                      const cpKey = `cp_${cp.productId}`;
                      const existing = (merged[cpKey] ?? {}) as Record<string, unknown>;
                      merged[cpKey] = { ...existing, promotion_amount: 0 };
                    }
                    setEnrollmentValue(merged);
                    return;
                  }
                  setEnrollmentValue(next);
                }}
                presentation={dsl.presentation}
                columns={2}
                labelAlign="left"
              />
            )}
            {section(
              "结算",
              <div className="space-y-4 text-sm">
                <div className="flex justify-between text-[#607083]"><span>共 {contractProducts.length} 个课程，总金额</span><span>{computedTotals.totalProductAmount.toFixed(2)} 元</span></div>
                <div className="flex justify-between text-[#607083]"><span>课程优惠</span><span className="text-[#d92d20]">-{computedTotals.productPromotionTotal.toFixed(2)} 元</span></div>
                <div className="flex justify-between text-[#607083]"><span>合同优惠</span><span className="text-[#d92d20]">-{computedTotals.contractPromotionAmount.toFixed(2)} 元</span></div>
                <div className="flex justify-between border-t border-[#e8edf5] pt-4 text-base font-semibold text-[#2f80ed]"><span>合同应收款</span><span>{computedTotals.receivable.toFixed(2)} 元</span></div>
              </div>
            )}
          </div>
          <div className="sticky bottom-0 flex justify-end border border-[#d9e3ed] bg-white px-5 py-4 shadow-[0_-8px_20px_rgba(24,36,56,0.06)]">
            <button className={`${token.button} ${token.primaryButton} h-9 px-8`} onClick={() => void submitEnrollment()}>
              保存合同
            </button>
          </div>
        </div>
        {modal && (
          <ModalRenderer
            scope={scope}
            schemaName={schemaName}
            title={modalTitle}
            fields={modalFields(modal)}
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

  const hideHeader = dsl.presentation?.header?.hidden === true;
  const showFilterLabels = dsl.presentation?.filters?.showLabels !== false;
  const toolbarAlign = dsl.presentation?.toolbar?.align ?? "left";

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[#eef0f8]">
      {!hideHeader && (
        <div className="mx-4 mt-4 mb-3 flex items-start justify-between border-b border-[#d9e3ed] bg-white px-4 py-3">
          <div>
            <h1 className="text-base font-semibold text-[#172033]">{dsl.title}</h1>
            {(dsl.presentation?.header?.subtitle ?? dsl.subtitle) && (
              <p className="mt-1 text-xs text-[#607083]">{dsl.presentation?.header?.subtitle ?? dsl.subtitle}</p>
            )}
          </div>
          <div className="text-sm text-[#607083]">{loading ? "加载中..." : `共 ${total} 条`}</div>
        </div>
      )}
      <div className={`mx-3 mt-3 shrink-0 ${token.filterBar} rounded-[2px] border-0 shadow-none`}>
        {sortWithOrder(filtersDsl).map((field) => (
          <label key={field.key} className="flex flex-col gap-1 text-xs font-medium text-[#607083]">
            {showFilterLabels && field.label}
            {renderFilterInput(field)}
          </label>
        ))}
        <button className={`${token.button} ${token.primaryButton}`} onClick={() => { setPage(1); void load(filters, 1); }}>
          查询
        </button>
        <button className={`${token.button} ${token.defaultButton}`} onClick={() => { const empty = dsl.pageCode === "course_week_schedule" ? { course_date: currentWeekRange() } : {}; setFilters(empty); setPage(1); void load(empty, 1); }}>
          重置
        </button>
      </div>
      <div className="mx-3 mt-3 flex shrink-0 items-center justify-between border-b border-[#edf0f5] bg-white px-5 py-4">
        <div className="flex items-center gap-1 text-base font-semibold text-[#172033]">
          {dsl.title}
          <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-[#c8ced8] text-[10px] font-bold text-white">i</span>
        </div>
        <div className={`flex flex-wrap gap-2 ${toolbarAlign === "left" ? "justify-start" : "justify-end"}`}>
          {sortWithOrder(toolbarDsl).map((action) => (
            <ActionRenderer key={action.actionCode} action={action} onClick={onToolbar} />
          ))}
        </div>
      </div>
      {error && <div className="mb-3 border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}
      {importConfig && (
        <div className="mb-3 border border-[#d9e3ed] bg-white p-3">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-sm font-semibold text-[#172033]">数据导入</div>
            <button className="text-xs text-[#607083] hover:text-[#2f80ed]" onClick={() => setImportConfig(null)}>关闭</button>
          </div>
          <ImportHandler
            dsl={dsl}
            scope={scope}
            schemaName={schemaName}
            importConfig={importConfig}
            onComplete={() => {
              void load();
            }}
          />
        </div>
      )}
      <div className="mx-3 min-h-0 flex-1 overflow-auto bg-white px-0">
        <GenericTableRenderer
          columns={tableDsl.columns ?? []}
          rows={rows}
          rowActions={tableDsl.rowActions}
          onAction={onRowAction}
          presentation={dsl.presentation}
        />
      </div>

      <div className="mx-3 flex shrink-0 items-center justify-center border-t border-[#d9e3ed] bg-white px-4 py-2 text-sm text-[#607083]">
        <div className="flex items-center gap-2">
          <button className={`${token.button} ${token.defaultButton} h-8`} disabled={page <= 1} onClick={() => { const next = Math.max(1, page - 1); setPage(next); void load(filters, next); }}>上一页</button>
          <span>第 {page} / {Math.max(1, Math.ceil(total / pageSize))} 页</span>
          <button className={`${token.button} ${token.defaultButton} h-8`} disabled={page >= Math.max(1, Math.ceil(total / pageSize))} onClick={() => { const next = page + 1; setPage(next); void load(filters, next); }}>下一页</button>
          <span className="ml-2">共 {total.toLocaleString()} 条</span>
        </div>
      </div>
      {modal && (
        <ModalRenderer
          scope={scope}
          schemaName={schemaName}
          title={modalTitle}
          fields={modalFields(modal)}
          value={modal.value}
          readonly={modal.type === "detail"}
          onChange={(value) => setModal({ ...modal, value })}
          onClose={() => setModal(null)}
          onSubmit={submitModal}
          presentation={dsl.presentation}
          size={"action" in modal ? modal.action?.modalSize : undefined}
        />
      )}
      {customizationRecordId && (
        <CustomizationRecordDetail
          recordId={customizationRecordId}
          onClose={() => setCustomizationRecordId("")}
          onContinue={(_, sessionId) => {
            setCustomizationRecordId("");
            onContinueAiCustomization?.(sessionId);
          }}
        />
      )}
    </div>
  );
}
