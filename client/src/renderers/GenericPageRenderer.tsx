import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { GatewayClient } from "../api/GatewayClient";
import type { ActionDsl, PageDsl, PageTargetDsl } from "../dsl/types";
import { sortWithOrder } from "../dsl/sortWithOrder";
import { useToast } from "../context/ToastContext";
import { token } from "../styles/designTokens";
import { ActionRenderer } from "./ActionRenderer";
import { GenericTableRenderer } from "./GenericTableRenderer";
import { ModalRenderer } from "./ModalRenderer";
import { ApprovalTaskDetail } from "./ApprovalTaskDetail";
import { GenericFormRenderer } from "./GenericFormRenderer";
import { ImportHandler } from "./ImportHandler";
import { exportToExcel } from "./ExportHandler";
import { CustomizationRecordDetail } from "./CustomizationRecordDetail";
import { CalendarView } from "./CalendarView";
import { fieldDictCode } from "../dsl/dictionarySource";

const editorDictionaryCodes: Record<string, string[]> = {
  business_rule_editor: [
    "business_rule_category", "business_type", "funds_allocation_method", "allocation_split_by", "generated_log_table",
    "promotion_allocation_method", "performance_allocation_method", "organization_performance_owner", "personal_performance_owner",
    "product_priority", "business_action_code", "approval_flow_code", "refund_allocation_method", "charge_type",
    "rule_condition_field", "rule_system_value", "rule_operator"
  ],
  approval_flow_editor: ["approval_trigger_event", "approval_trigger_page", "approval_action_code", "approval_role", "business_type"]
};

type Presentation = NonNullable<PageDsl["presentation"]>;
type MetricDsl = {
  label: string;
  source: "total" | "countBy" | "sum" | "todayCount" | "todayCountBy";
  field?: string;
  dateField?: string;
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

function collectDictionaryRefs(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => collectDictionaryRefs(item));
  if (!value || typeof value !== "object") return [];
  const obj = value as Record<string, unknown>;
  const self = typeof obj.dictCode === "string" ? [obj.dictCode] : [];
  return [...self, ...Object.values(obj).flatMap((child) => collectDictionaryRefs(child))];
}

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
  const configuredPageSize = Number(dsl.presentation?.table?.pageSize ?? 10);
  const [pageSize, setPageSize] = useState(configuredPageSize);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [modal, setModal] = useState<ModalState>(null);
  const [customizationRecordId, setCustomizationRecordId] = useState("");
  const [importConfig, setImportConfig] = useState<Record<string, unknown> | null>(null);
  const [selectedRowIds, setSelectedRowIds] = useState<string[]>([]);
  const [rightRailItems, setRightRailItems] = useState<Record<string, RightRailItem[]>>({});
  const [dictionaryLabels, setDictionaryLabels] = useState<Record<string, Record<string, string>>>({});
  const [dictionaryOptionIds, setDictionaryOptionIds] = useState<Record<string, Record<string, string>>>({});
  const [dictionaryMeta, setDictionaryMeta] = useState<Record<string, Record<string, Record<string, unknown>>>>({});
  const [enrollmentValue, setEnrollmentValue] = useState<Record<string, unknown>>({});
  const remoteProductOptionsRef = useRef<Array<{ value: string; label: string; row: Record<string, unknown> }>>([]);
  const remotePromotionOptionsRef = useRef<Array<{ value: string; label: string; row: Record<string, unknown> }>>([]);

  const createAction = toolbarDsl.find((action) => action.actionCode.endsWith(".create") || action.actionCode.endsWith(".enroll"));
  const enrollmentFields = dsl.layout === "enrollment" ? (createAction?.fields ?? modalDsl.fields) : [];
  const enrollmentConfig = dsl.presentation?.enrollment ?? {};
  const enrollmentProductConfig = enrollmentConfig.productTable ?? {};
  const enrollmentPromotionConfig = enrollmentConfig.promotion ?? {};
  const enrollmentSections = enrollmentConfig.sections ?? {};
  const productIdsField = enrollmentProductConfig.productIdsField ?? "product_ids";
  const productValuePrefix = enrollmentProductConfig.rowValuePrefix ?? "cp_";
  const promotionField = enrollmentPromotionConfig.field ?? "promotion_id";
  const enrollmentValueWithDefaults = dsl.layout === "enrollment" ? { ...(resolveDictionaryDefaults(createAction?.defaultValues) ?? {}), ...enrollmentValue } : {};

  const selectedProductIds = useMemo(() => {
    if (dsl.layout !== "enrollment") return [] as string[];
    return (Array.isArray(enrollmentValueWithDefaults[productIdsField]) ? enrollmentValueWithDefaults[productIdsField] : []) as string[];
  }, [dsl.layout, dsl.pageCode, productIdsField, enrollmentValueWithDefaults[productIdsField]]);

  const productRows = useMemo(() => {
    if (dsl.layout !== "enrollment" || !selectedProductIds.length) return [] as Record<string, unknown>[];
    return selectedProductIds.map((pid) => {
      const opt = (remoteProductOptionsRef.current ?? []).find((o) => o.value === String(pid));
      return opt?.row ?? {};
    });
  }, [dsl.layout, selectedProductIds]);


  const dictionaryCodes = useMemo(() => {
    const actions = [...toolbarDsl, ...(tableDsl.rowActions ?? [])];
    const actionFields = actions.flatMap((action) => action.fields ?? []);
    const fields = [...filtersDsl, ...(tableDsl.columns ?? []), ...(modalDsl.fields ?? []), ...actionFields];
    const fieldCodes = fields.map((field) => fieldDictCode(field)).filter(Boolean) as string[];
    const editorCodes = fields.flatMap((field) => editorDictionaryCodes[String(field.type ?? "")] ?? []);
    const refCodes = actions.flatMap((action) => [
      ...collectDictionaryRefs(action.defaultValues),
      ...collectDictionaryRefs(action.visibleWhen)
    ]);
    return [...new Set([...fieldCodes, ...editorCodes, ...refCodes])];
  }, [dsl.pageCode, JSON.stringify(filtersDsl), JSON.stringify(tableDsl.columns ?? []), JSON.stringify(tableDsl.rowActions ?? []), JSON.stringify(modalDsl.fields ?? []), JSON.stringify(toolbarDsl)]);

  useEffect(() => {
    let cancelled = false;
    if (!dictionaryCodes.length) {
      setDictionaryLabels({});
      return;
    }
    Promise.all(dictionaryCodes.map(async (dictCode) => {
      const result = await GatewayClient.executeApi({
        scope,
        schemaName,
        pageCode: "__dictionary__",
        apiCode: "dictionary.options",
        params: { dictCode, page: 1, pageSize: 500 }
      });
      const data = result.data as { rows: Array<{ value?: string; itemValue?: string; item_value?: string; label?: string; item_label?: string; metadata?: Record<string, unknown>; metadata_json?: Record<string, unknown> }> };
      const labels: Record<string, string> = {};
      const ids: Record<string, string> = {};
      const meta: Record<string, Record<string, unknown>> = {};
      for (const row of data.rows ?? []) {
        const itemValue = String(row.itemValue ?? row.item_value ?? "");
        const optionId = String(row.value ?? "");
        const label = String(row.label ?? row.item_label ?? itemValue ?? optionId);
        if (itemValue) labels[itemValue] = label;
        if (optionId) labels[optionId] = label;
        if (itemValue) ids[itemValue] = optionId;
        if (optionId) ids[optionId] = optionId;
        if (itemValue) meta[itemValue] = row.metadata ?? row.metadata_json ?? {};
        if (optionId) meta[optionId] = row.metadata ?? row.metadata_json ?? {};
      }
      return [dictCode, { labels, ids, meta }] as const;
    }))
      .then((entries) => {
        if (cancelled) return;
        setDictionaryLabels(Object.fromEntries(entries.map(([dictCode, data]) => [dictCode, data.labels])));
        setDictionaryOptionIds(Object.fromEntries(entries.map(([dictCode, data]) => [dictCode, data.ids])));
        setDictionaryMeta(Object.fromEntries(entries.map(([dictCode, data]) => [dictCode, data.meta])));
      })
      .catch(() => { if (!cancelled) { setDictionaryLabels({}); setDictionaryOptionIds({}); setDictionaryMeta({}); } });
    return () => { cancelled = true; };
  }, [scope, schemaName, dictionaryCodes.join("|")]);

  const presentationWithDictionaries = useMemo(() => ({
    ...(dsl.presentation ?? {}),
    valueLabels: { ...(dsl.presentation?.valueLabels ?? {}), ...dictionaryLabels },
    dictionaryMeta: { ...dictionaryMeta, ...(dsl.presentation?.dictionaryMeta ?? {}) }
  }), [dsl.presentation, dictionaryLabels, dictionaryMeta]);

  function resolveDictionaryValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => resolveDictionaryValue(item));
    if (value && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      if (typeof obj.dictCode === "string" && obj.itemValue !== undefined) {
        return dictionaryOptionIds[obj.dictCode]?.[String(obj.itemValue)] ?? obj.itemValue;
      }
      return Object.fromEntries(Object.entries(obj).map(([key, child]) => [key, resolveDictionaryValue(child)]));
    }
    return value;
  }

  function resolveDictionaryDefaults<T extends Record<string, unknown> | undefined>(defaults: T): T {
    return (defaults ? resolveDictionaryValue(defaults) : defaults) as T;
  }

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
      const cpKey = `${productValuePrefix}${pid}`;
      const existing = enrollmentValueWithDefaults[cpKey] as Record<string, unknown> | undefined;
      const defaultHour = Number(productRow[enrollmentProductConfig.defaultHourField ?? "default_course_hour"] ?? 0);
      const unitPrice = Number(productRow[enrollmentProductConfig.unitPriceField ?? "unit_price"] ?? 0);
      const defaultTotal = Number(productRow[enrollmentProductConfig.totalAmountField ?? "total_amount"] ?? 0);
      const courseHour = existing && "course_hour" in existing ? Number(existing.course_hour ?? 0) : defaultHour;
      const cpUnitPrice = existing && "unit_price" in existing ? Number(existing.unit_price ?? 0) : unitPrice;
      const cpTotal = existing && "total_amount" in existing ? Number(existing.total_amount ?? 0) : defaultTotal;
      const cpPromotionAmount = existing && "promotion_amount" in existing ? Number(existing.promotion_amount ?? 0) : 0;
      return {
        productId: pid,
        productName: String(productRow[enrollmentProductConfig.productNameField ?? "name"] ?? ""),
        productType: String(productRow[enrollmentProductConfig.productTypeField ?? "product_type"] ?? ""),
        courseHour: Math.round(courseHour * 100) / 100,
        unitPrice: Math.round(cpUnitPrice * 100) / 100,
        totalAmount: Math.round(cpTotal * 100) / 100,
        promotionAmount: Math.round(cpPromotionAmount * 100) / 100
      };
    });
  }, [dsl.layout, selectedProductIds, productRows, enrollmentValueWithDefaults, enrollmentProductConfig, productValuePrefix]);

  const promotionId = dsl.layout === "enrollment" ? String(enrollmentValueWithDefaults[promotionField] ?? "") : "";

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
      const promoType = String(promotionRow[enrollmentPromotionConfig.typeField ?? "type"] ?? "");
      const promoValue = Number(promotionRow[enrollmentPromotionConfig.valueField ?? "value"] ?? 0);
      if (promoType === (enrollmentPromotionConfig.reduceValue ?? "REDUCE")) {
        contractPromotionAmount = promoValue;
      } else if (promoType === (enrollmentPromotionConfig.discountValue ?? "DISCOUNT")) {
        contractPromotionAmount = Math.round(totalProductAmount * (1 - promoValue / 10) * 100) / 100;
      }
    }
    const productPromotionTotal = contractProducts.reduce((sum, cp) => sum + cp.promotionAmount, 0);
    const allPromotion = contractPromotionAmount + productPromotionTotal;
    const receivable = totalProductAmount - allPromotion;
    return { totalProductAmount, contractPromotionAmount, productPromotionTotal, allPromotion, receivable };
  }, [dsl.layout, contractProducts, promotionRow, enrollmentPromotionConfig]);

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

  async function load(nextFilters = filters, nextPage = page, nextPageSize = pageSize) {
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
        params: { filters: effectiveFilters, page: nextPage, pageSize: nextPageSize, schemaName }
      });
      const data = result.data as { rows: Record<string, unknown>[]; total: number };
      setRows(data.rows);
      setTotal(data.total);
      setSelectedRowIds((current) => current.filter((id) => data.rows.some((row) => String(row.id) === id)));
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
    const nextPageSize = Number(dsl.presentation?.table?.pageSize ?? 10);
    setPageSize(nextPageSize);
    setEnrollmentValue({});
    setImportConfig(null);
    void load(nextFilters, 1, nextPageSize);
  }, [dsl.pageCode, JSON.stringify(initialFilters ?? {}), refreshKey, dsl.presentation?.table?.pageSize]);

  async function submitModal(extra: Record<string, unknown> = {}) {
    if (!modal) return;
    const apiCode = "action" in modal && modal.action?.apiCode ? modal.action.apiCode : modal.type === "create" ? dsl.createApi : dsl.updateApi;
    const actionLabel = "action" in modal && modal.action?.label ? modal.action.label : modal.type === "create" ? `新增${dsl.title}` : modal.type === "edit" ? `编辑${dsl.title}` : dsl.title;
    try {
      const hasAttendanceTable = modalFields(modal).some((field) => field.type === "attendance_table");
      const selectedStudentIds = new Set((Array.isArray(modal.value.__selectedStudentIds) ? modal.value.__selectedStudentIds : []) as string[]);
      if (hasAttendanceTable && (extra.__attendanceMode === "cancel_attendance" || extra.__attendanceMode === "cancel_charge") && selectedStudentIds.size === 0) {
        toast.error("请先勾选要处理的学员");
        return;
      }
      const submitValue = hasAttendanceTable ? {
        ...modal.value,
        students: (Array.isArray(modal.value.students) ? modal.value.students as Array<Record<string, unknown>> : [])
          .filter((student, idx) => selectedStudentIds.size === 0 || selectedStudentIds.has(String(student.student_id ?? idx)))
          .map((student) => extra.__attendanceMode === "cancel_attendance"
            ? { ...student, attendance_status: "PENDING", cancel_attendance: true }
            : extra.__attendanceMode === "cancel_charge"
              ? { ...student, reverse_charge: true }
              : student)
      } : modal.value;
      const result = await GatewayClient.executeApi({
        scope,
        schemaName,
        pageCode: dsl.pageCode,
        apiCode,
        params: { id: modal.value.id, data: { ...submitValue, ...extra } }
      });
      const responseData = result.data as { failed?: Array<{ studentId?: unknown; reason?: unknown }> } | undefined;
      if (hasAttendanceTable && responseData?.failed?.length) {
        const failedByStudent = new Map(responseData.failed.map((item) => [String(item.studentId ?? ""), String(item.reason ?? "处理失败")]));
        const students = Array.isArray(modal.value.students) ? modal.value.students as Array<Record<string, unknown>> : [];
        setModal({
          ...modal,
          value: {
            ...modal.value,
            students: students.map((student) => ({
              ...student,
              row_error: failedByStudent.get(String(student.student_id ?? "")) ?? student.row_error
            }))
          }
        });
        toast.error("部分学员处理失败，请查看行内原因");
        return;
      }
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
    const submitData: Record<string, unknown> = { ...(resolveDictionaryDefaults(createAction.defaultValues) ?? {}), ...enrollmentValue };
    const productIds = (Array.isArray(submitData[productIdsField]) ? submitData[productIdsField] : []) as string[];
    if (productIds.length) {
      const contractProducts = productIds.map((pid) => {
        const cpKey = `${productValuePrefix}${pid}`;
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
        delete submitData[`${productValuePrefix}${pid}`];
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
    if (action.actionCode.endsWith(".create") || action.actionCode.endsWith(".batchEnroll")) {
      if (action.requiresSelection && selectedRowIds.length === 0) {
        toast.error(action.requiresSelectionMessage ?? "请先选择数据");
        return;
      }
      const selectedRows = rows.filter((row) => selectedRowIds.includes(String(row.id)));
      const selectedValues = action.mapSelectedToValue && selectedRows.length
        ? Object.fromEntries(Object.entries(action.mapSelectedToValue).map(([targetKey, sourceKey]) => [targetKey, selectedRows.map((row) => row[String(sourceKey)]).filter((value) => value !== undefined && value !== null && value !== "")]))
        : {};
      setModal({ type: "create", value: { ...(resolveDictionaryDefaults(action.defaultValues) ?? {}), ...selectedValues }, action });
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

  async function loadDetailValue(row: Record<string, unknown>) {
    if (!dsl.detailApi || row.id === undefined || row.id === null) return row;
    try {
      const result = await GatewayClient.executeApi({
        scope,
        schemaName,
        pageCode: dsl.pageCode,
        apiCode: dsl.detailApi,
        params: { id: row.id }
      });
      const detail = result.data && typeof result.data === "object" && !Array.isArray(result.data) ? result.data as Record<string, unknown> : {};
      return { ...row, ...detail };
    } catch {
      return row;
    }
  }

  async function hydrateEditValue(row: Record<string, unknown>) {
    const detail = await loadDetailValue(row);
    if (dsl.pageCode !== "contract_list") return detail;
    const next: Record<string, unknown> = { ...detail };
    if (next.student_id !== undefined && next.student_ids === undefined) next.student_ids = [next.student_id];
    if (next.id !== undefined && next.product_ids === undefined) {
      try {
        const result = await GatewayClient.executeApi({
          scope,
          schemaName,
          pageCode: "contract_product_list",
          apiCode: "contract_product_list.query",
          params: { filters: { contract_id: next.id }, page: 1, pageSize: 200 }
        });
        const data = result.data as { rows?: Array<Record<string, unknown>> };
        const productIds = (data.rows ?? []).map((item) => item.product_id).filter((value) => value !== undefined && value !== null && value !== "").map(String);
        if (productIds.length) next.product_ids = productIds;
      } catch {
        // 保留合同主表详情，避免关联产品加载失败时阻断编辑弹窗。
      }
    }
    return next;
  }

  async function onRowAction(action: ActionDsl, row: Record<string, unknown>) {
    if (action.confirm && !window.confirm(typeof action.confirm === "string" ? action.confirm : "确认操作？")) return;
    if (action.actionCode.endsWith(".detail")) {
      if (dsl.pageCode === "customization_record_list" || dsl.pageCode === "assistant_record_list") {
        setCustomizationRecordId(String(row.id ?? ""));
        return;
      }
      const detail = await loadDetailValue(row);
      if (dsl.pageCode === "approval_task_list") {
        try {
          const result = await GatewayClient.executeApi({
            scope,
            schemaName,
            pageCode: "approval_task_log_list",
            apiCode: "approval_task_log_list.query",
            params: { filters: { task_id: row.id }, page: 1, pageSize: 50 }
          });
          const data = result.data as { rows?: Array<Record<string, unknown>> };
          detail.logs = data.rows ?? [];
        } catch {
          detail.logs = [];
        }
      }
      setModal({ type: "detail", value: detail });
      return;
    }
    if (action.actionCode.endsWith(".edit")) {
      setModal({ type: "edit", value: await hydrateEditValue(row) });
      return;
    }
    if (action.type === "open_page" || action.actionType === "open_page") {
      const target = action.target ?? (action.targetPageCode ? { pageCode: action.targetPageCode, title: action.label } : undefined);
      openTarget(target, action.label ?? "打开页面", targetFilters(target, row));
      return;
    }
    if (action.type === "open_modal" && action.fields?.length) {
      const mapped = mappedRowValues(action, row);
      let prepared: Record<string, unknown> = {};
      if (action.fields.some((field) => field.type === "attendance_table")) {
        try {
          const result = await GatewayClient.executeApi({ scope, schemaName, pageCode: dsl.pageCode, apiCode: "attendance.prepare", params: { ...mapped, id: row.id } });
          prepared = result.data && typeof result.data === "object" && !Array.isArray(result.data) ? result.data as Record<string, unknown> : {};
        } catch {
          prepared = {};
        }
      }
      setModal({ type: "create", value: { ...(resolveDictionaryDefaults(action.defaultValues) ?? {}), ...mapped, ...prepared }, action });
      return;
    }
    if (action.type === "execute_api" || action.actionType === "execute_api" || action.apiCode) {
      const mapped = mappedRowValues(action, row);
      const data = { ...row, ...(resolveDictionaryDefaults(action.defaultValues) ?? {}), ...mapped };
      const params = (action.apiCode ?? action.actionCode).endsWith(".update")
        ? { id: row.id, data }
        : { ...(resolveDictionaryDefaults(action.defaultValues) ?? {}), ...row, ...mapped, id: row.id, versionId: row.id };
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

  function isTodayValue(value: unknown) {
    if (!value) return false;
    const date = new Date(String(value));
    if (Number.isNaN(date.getTime())) return false;
    const now = new Date();
    return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  }

  function metricValue(metric: MetricDsl) {
    if (metric.source === "total") return total;
    if (metric.source === "countBy" && metric.field) {
      return rows.filter((row) => String(row[metric.field!]) === String(metric.value)).length;
    }
    if (metric.source === "todayCount") {
      const dateField = metric.dateField ?? metric.field ?? "created_at";
      return rows.filter((row) => isTodayValue(row[dateField])).length;
    }
    if (metric.source === "todayCountBy" && metric.field) {
      const dateField = metric.dateField ?? "created_at";
      return rows.filter((row) => String(row[metric.field!]) === String(metric.value) && isTodayValue(row[dateField])).length;
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

  function filterControlClass(extra = "") {
    const compact = dsl.presentation?.filters?.density === "compact";
    return `${token.input} ${compact ? "h-7 min-w-[120px] px-2 text-xs" : ""} ${extra}`.trim();
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
            className={filterControlClass("min-w-[120px]")}
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
            className={filterControlClass("min-w-[120px]")}
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
    const dictOptions = presentationWithDictionaries.valueLabels?.[field.key];
    if (field.type === "select" || fieldDictCode(field) || dictOptions) {
      return (
        <select
          className={filterControlClass()}
          value={String(filters[field.key] ?? "")}
          onChange={(event) => setFilters({ ...filters, [field.key]: event.target.value })}
        >
          <option value="">全部</option>
          {Object.entries(dictOptions ?? {}).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      );
    }
    const inputType = field.type === "date" ? "date" : field.type === "datetime" ? "datetime-local" : "text";
    return (
      <input
        type={inputType}
        className={filterControlClass()}
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
  const headerMetricTip = metrics
    .map((metric) => `${metricLabel(metric)}：${metricValue(metric)}${metric.suffix ?? ""}`)
    .join("\n");
  const compactFont = dsl.presentation?.fontSize === "compact";
  const pageFontClass = compactFont ? "text-[13px]" : "";
  const pageTitleClass = compactFont ? "text-sm" : "text-base";
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
    const productField = (createAction?.fields ?? modalDsl.fields).find((f) => f.key === productIdsField);
    const promoField = (createAction?.fields ?? modalDsl.fields).find((f) => f.key === promotionField);
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
  }, [dsl.pageCode, dsl.layout, productIdsField, promotionField]);

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
      <div className="grid h-full grid-cols-[minmax(0,1fr)_360px] overflow-hidden bg-[#f4f7fb]">
        <div className="overflow-auto p-6">
          <section className="relative mb-6 overflow-hidden rounded-3xl border border-[#dbeafe] bg-gradient-to-br from-[#eaf3ff] via-[#f5f9ff] to-[#dceeff] px-7 py-6 text-[#172033] shadow-[0_18px_44px_rgba(18,97,216,0.12)]">
            <div className="absolute -right-16 -top-20 h-56 w-56 rounded-full bg-[#2f80ed]/20 blur-3xl" />
            <div className="absolute -bottom-20 left-1/3 h-48 w-48 rounded-full bg-cyan-300/20 blur-3xl" />
            <div className="relative flex flex-wrap items-end justify-between gap-4">
              <div>
                <div className="inline-flex items-center gap-2 rounded-full border border-[#bcd8fb] bg-white/70 px-3 py-1 text-xs text-[#1261d8] shadow-sm backdrop-blur">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#2f80ed]" />
                  今日总览
                </div>
                <h1 className="mt-4 text-2xl font-semibold tracking-tight">{dsl.title ?? "后台首页"}</h1>
                <p className="mt-2 text-sm text-[#526075]">{dsl.subtitle ?? dashboard?.panels?.[0]?.description ?? "统一查看校区关键数据与常用入口"}</p>
              </div>
              {metrics.length > 0 && (
                <div className="grid min-w-[520px] flex-1 grid-cols-1 gap-3 md:grid-cols-3">
                  {metrics.map((metric) => (
                    <button
                      key={`${metric.label}-${metric.field ?? metric.source}`}
                      className={`rounded-2xl border border-[#cfe3ff] bg-white/75 px-5 py-4 text-left text-[#172033] shadow-[0_10px_26px_rgba(18,97,216,0.10)] backdrop-blur transition ${
                        metric.target ? "cursor-pointer hover:-translate-y-0.5 hover:border-[#9fc7f5] hover:bg-white hover:shadow-[0_14px_32px_rgba(18,97,216,0.16)]" : "cursor-default"
                      }`}
                      onClick={() => openTarget(metric.target, metricLabel(metric))}
                    >
                      <div className="text-[28px] font-bold leading-none text-[#1261d8]">
                        {metricValue(metric)}
                        {metric.suffix && <span className="ml-1 text-xs font-normal text-[#7a8494]">{metric.suffix}</span>}
                      </div>
                      <div className="mt-2 text-xs font-medium text-[#607083]">{metricLabel(metric)}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </section>

          {dashboard?.quickActions?.length ? (
            <section className="mb-6">
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <h2 className="text-base font-semibold text-[#172033]">常用功能</h2>
                  <p className="mt-1 text-xs text-[#7a8494]">高频业务入口，快速进入日常处理页面</p>
                </div>
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
                {dashboard.quickActions.map((action, index) => (
                  <button
                    key={action.pageCode}
                    className="group rounded-2xl border border-white bg-white p-4 text-left shadow-[0_10px_28px_rgba(18,97,216,0.08)] transition hover:-translate-y-1 hover:border-[#bcd8fb] hover:shadow-[0_16px_36px_rgba(18,97,216,0.14)]"
                    onClick={() => onOpenPage?.(action.pageCode, action.label, action.filters)}
                  >
                    <span className={`flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br ${quickGradients[index % quickGradients.length]} text-xl text-white shadow-[0_8px_18px_rgba(47,80,237,0.24)] transition group-hover:scale-105`}>{action.icon ?? "◎"}</span>
                    <span className="mt-3 block text-sm font-semibold text-[#172033]">{action.label}</span>
                    <span className="mt-1 block truncate text-xs text-[#7a8494]">{action.description ?? "点击打开"}</span>
                  </button>
                ))}
              </div>
            </section>
          ) : null}

          <section>
            <h2 className="mb-4 text-base font-semibold text-[#172033]">月排行榜 TOP10</h2>
            {(dashboard?.panels ?? []).map((panel) => (
              <div key={panel.title} className="overflow-hidden rounded-2xl border border-white bg-white p-4 shadow-[0_10px_28px_rgba(18,97,216,0.08)]">
                <div className="mb-3 flex items-center gap-3">
                  <button className="h-8 min-w-[86px] rounded-lg border border-[#dbe7ff] bg-[#f3f7ff] px-3 text-xs font-medium text-[#1261d8]">按分公司</button>
                  <button className="h-8 min-w-[86px] rounded-lg border border-[#dde3ee] bg-white px-3 text-xs text-[#526075] hover:border-[#9fc7f5] hover:text-[#1261d8]">校区业绩</button>
                  <button className="h-8 min-w-[86px] rounded-lg border border-[#dde3ee] bg-white px-3 text-xs text-[#526075] hover:border-[#9fc7f5] hover:text-[#1261d8]">统计指标</button>
                </div>
                <GenericTableRenderer
                  columns={panel.columns ?? tableDsl.columns ?? []}
                  rows={dashboardRows}
                  rowActions={[]}
                  onAction={() => undefined}
                  presentation={presentationWithDictionaries}
                />
              </div>
            ))}
          </section>

          {error && <div className="mt-4 border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}
        </div>

        <aside className="overflow-auto border-l border-[#dce8f8] bg-white/75 p-6 backdrop-blur">
          <div className="mb-6">
            <h2 className="mb-4 text-base font-semibold text-[#172033]">{dashboard?.rightRail?.title ?? "校区动态"}</h2>
            {(dashboard?.rightRail?.sections ?? []).map((section) => (
              <section key={section.title} className="mb-5 rounded-2xl border border-white bg-white p-4 shadow-[0_10px_28px_rgba(18,97,216,0.08)]">
                <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-[#172033]">
                  <span className="h-2 w-2 rounded-full bg-[#2f80ed]" />
                  {section.title}
                </div>
                <div className="space-y-2">
                  {(rightRailItems[section.title] ?? section.items).map((item) => (
                    <button
                      key={`${section.title}-${item.text}`}
                      className={`flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left text-xs transition ${
                        item.target ? "hover:bg-[#f2f7ff]" : "cursor-default"
                      }`}
                      onClick={() => openTarget(item.target, item.text)}
                    >
                      <div className="min-w-0">
                        {item.tag && <span className="mr-2 rounded-full bg-[#e8f1ff] px-2 py-0.5 text-[#2f80ed]">{item.tag}</span>}
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
    const sectionKeys = {
      student: enrollmentSections.student?.fieldKeys ?? ["student_ids"],
      products: enrollmentSections.products?.fieldKeys ?? [productIdsField],
      attributes: enrollmentSections.attributes?.fieldKeys ?? ["contract_type", "organization_id", "sign_staff_id", "sign_time", promotionField, "remark"]
    };
    const productColumns = enrollmentProductConfig.columns ?? {};
    const settlementLabels = enrollmentSections.settlement?.labels ?? {};

    function r2(v: number) { return Math.round((v + Number.EPSILON) * 100) / 100; }
    function floor2(v: number) { return Math.floor((v + Number.EPSILON) * 100) / 100; }

    function updateCpField(productId: string, field: string, rawValue: unknown) {
      const cpKey = `${productValuePrefix}${productId}`;
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
            <h1 className={`${pageTitleClass} font-semibold text-[#172033]`}>{dsl.title}</h1>
            <p className="mt-1 text-xs text-[#607083]">{dsl.presentation?.header?.subtitle ?? dsl.subtitle}</p>
          </div>
        </div>
        <div className="space-y-3">
          {section(
            enrollmentSections.student?.title ?? "学员信息",
            <GenericFormRenderer
              scope={scope}
              schemaName={schemaName}
              fields={byKeys(sectionKeys.student)}
              value={enrollmentValueWithDefaults}
              onChange={(next) => setEnrollmentValue(next)}
              presentation={presentationWithDictionaries}
              columns={3}
              labelAlign="left"
            />
          )}
          {section(
            enrollmentSections.products?.title ?? "报读课程",
            <div>
              <GenericFormRenderer
                scope={scope}
                schemaName={schemaName}
                fields={byKeys(sectionKeys.products)}
                value={enrollmentValueWithDefaults}
                onChange={(next) => {
                  const newIds = (Array.isArray(next[productIdsField]) ? next[productIdsField] : []) as string[];
                  const oldIds = (Array.isArray(enrollmentValueWithDefaults[productIdsField]) ? enrollmentValueWithDefaults[productIdsField] : []) as string[];
                  const added = newIds.filter((id: string) => !oldIds.includes(id));
                  const merged = { ...enrollmentValueWithDefaults, ...next };
                  for (const pid of added) {
                    const productRow = productRows[selectedProductIds.length] ?? (remoteProductOptionsRef.current ?? []).find((o) => o.value === String(pid))?.row ?? {};
                    const cpKey = `${productValuePrefix}${pid}`;
                    if (!merged[cpKey]) {
                      const hour = r2(Number(productRow[enrollmentProductConfig.defaultHourField ?? "default_course_hour"] ?? 0));
                      const price = r2(Number(productRow[enrollmentProductConfig.unitPriceField ?? "unit_price"] ?? 0));
                      const total = r2(Number(productRow[enrollmentProductConfig.totalAmountField ?? "total_amount"] ?? hour * price));
                      merged[cpKey] = { course_hour: hour, unit_price: price, total_amount: total, promotion_amount: 0 };
                    }
                  }
                  for (const oldId of oldIds) {
                    if (!newIds.includes(oldId)) delete merged[`${productValuePrefix}${oldId}`];
                  }
                  setEnrollmentValue(merged);
                }}
                presentation={presentationWithDictionaries}
                columns={3}
                labelAlign="left"
              />
              {contractProducts.length > 0 && (
                <div className="mt-4 overflow-hidden rounded border border-[#e8edf5]">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-[#f8fafc] text-[#5f6b7a]">
                        <th className="px-3 py-2 text-left font-medium">{productColumns.product ?? "课程产品"}</th>
                        <th className="px-3 py-2 text-center font-medium w-[100px]">{productColumns.courseHour ?? "课时"}</th>
                        <th className="px-3 py-2 text-center font-medium w-[100px]">{productColumns.unitPrice ?? "单价"}</th>
                        <th className="px-3 py-2 text-center font-medium w-[110px]">{productColumns.totalAmount ?? "总价"}</th>
                        <th className="px-3 py-2 text-center font-medium w-[110px]">{productColumns.promotionAmount ?? "优惠金额"}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {contractProducts.map((cp) => (
                        <tr key={cp.productId} className="border-t border-[#e8edf5]">
                          <td className="px-3 py-2">
                            <div className="font-medium text-[#263445]">{cp.productName}</div>
                            <div className="text-xs text-[#8b95a7]">
                              {presentationWithDictionaries.valueLabels?.product_type?.[cp.productType] ?? cp.productType}
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
                  {enrollmentSections.products?.emptyText ?? "请选择要报读的课程"}
                </div>
              )}
            </div>
          )}
          <div className="grid gap-3 xl:grid-cols-[1fr_360px]">
            {section(
              enrollmentSections.attributes?.title ?? "业务属性",
              <GenericFormRenderer
                scope={scope}
                schemaName={schemaName}
                fields={byKeys(sectionKeys.attributes)}
                value={enrollmentValueWithDefaults}
                onChange={(next) => {
                  const promoChanged = next[promotionField] !== enrollmentValueWithDefaults[promotionField];
                  if (promoChanged && next[promotionField]) {
                    const promoOpt = (remotePromotionOptionsRef.current ?? []).find((o) => o.value === String(next[promotionField]));
                    const promo = promoOpt?.row;
                    if (promo && contractProducts.length) {
                      const promoType = String(promo[enrollmentPromotionConfig.typeField ?? "type"] ?? "");
                      const promoValue = Number(promo[enrollmentPromotionConfig.valueField ?? "value"] ?? 0);
                      const totalProductAmount = contractProducts.reduce((sum, cp) => sum + cp.totalAmount, 0);
                      let totalPromotion = 0;
                      if (promoType === (enrollmentPromotionConfig.reduceValue ?? "REDUCE")) totalPromotion = promoValue;
                      else if (promoType === (enrollmentPromotionConfig.discountValue ?? "DISCOUNT")) totalPromotion = r2(totalProductAmount * (1 - promoValue / 10));
                      let remaining = totalPromotion;
                      const merged = { ...enrollmentValueWithDefaults, ...next };
                      contractProducts.forEach((cp, idx) => {
                        const cpKey = `${productValuePrefix}${cp.productId}`;
                        const existing = (merged[cpKey] ?? {}) as Record<string, unknown>;
                        const share = idx === contractProducts.length - 1
                          ? r2(remaining)
                          : totalProductAmount > 0 ? floor2(totalPromotion * (cp.totalAmount / totalProductAmount)) : 0;
                        remaining = r2(remaining - share);
                        merged[cpKey] = { ...existing, promotion_amount: r2(share) };
                      });
                      setEnrollmentValue(merged);
                      return;
                    }
                  }
                  if (promoChanged && !next[promotionField]) {
                    const merged = { ...enrollmentValueWithDefaults, ...next };
                    for (const cp of contractProducts) {
                      const cpKey = `${productValuePrefix}${cp.productId}`;
                      const existing = (merged[cpKey] ?? {}) as Record<string, unknown>;
                      merged[cpKey] = { ...existing, promotion_amount: 0 };
                    }
                    setEnrollmentValue(merged);
                    return;
                  }
                  setEnrollmentValue(next);
                }}
                presentation={presentationWithDictionaries}
                columns={2}
                labelAlign="left"
              />
            )}
            {section(
              enrollmentSections.settlement?.title ?? "结算",
              <div className="space-y-4 text-sm">
                <div className="flex justify-between text-[#607083]"><span>{(settlementLabels.total ?? "共 {count} 个课程，总金额").replace("{count}", String(contractProducts.length))}</span><span>{computedTotals.totalProductAmount.toFixed(2)} 元</span></div>
                <div className="flex justify-between text-[#607083]"><span>{settlementLabels.productPromotion ?? "课程优惠"}</span><span className="text-[#d92d20]">-{computedTotals.productPromotionTotal.toFixed(2)} 元</span></div>
                <div className="flex justify-between text-[#607083]"><span>{settlementLabels.contractPromotion ?? "合同优惠"}</span><span className="text-[#d92d20]">-{computedTotals.contractPromotionAmount.toFixed(2)} 元</span></div>
                <div className="flex justify-between border-t border-[#e8edf5] pt-4 text-base font-semibold text-[#2f80ed]"><span>{settlementLabels.receivable ?? "合同应收款"}</span><span>{computedTotals.receivable.toFixed(2)} 元</span></div>
              </div>
            )}
          </div>
          <div className="sticky bottom-0 flex justify-end border border-[#d9e3ed] bg-white px-5 py-4 shadow-[0_-8px_20px_rgba(24,36,56,0.06)]">
            <button className={`${token.button} ${token.primaryButton} h-9 px-8`} onClick={() => void submitEnrollment()}>
              {settlementLabels.save ?? "保存合同"}
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
            presentation={presentationWithDictionaries}
            size={"action" in modal ? modal.action?.modalSize : undefined}
            submitLabel={"action" in modal ? modal.action?.submitLabel : undefined}
            submitActions={modalFields(modal).some((field) => field.type === "attendance_table") ? [
              { label: "取消考勤", value: { __attendanceMode: "cancel_attendance" }, variant: "default" },
              { label: "取消扣费", value: { __attendanceMode: "cancel_charge" }, variant: "danger" },
              { label: "考勤", value: { __attendanceMode: "attendance" }, variant: "default" },
              { label: "扣费", value: { __attendanceMode: "charge" }, variant: "primary" }
            ] : undefined}
          />
        )}
      </div>
    );
  }

  const hideHeader = dsl.presentation?.header?.hidden === true;
  const showFilterLabels = dsl.presentation?.filters?.showLabels !== false;
  const compactFilters = dsl.presentation?.filters?.density === "compact";
  const filterBarClass = compactFilters
    ? "mx-2 mt-2 mb-2 flex flex-wrap items-end gap-2 rounded-[2px] border-0 bg-white px-3 py-2 shadow-none"
    : `mx-3 mt-3 shrink-0 ${token.filterBar} rounded-[2px] border-0 shadow-none`;
  const titleBarClass = compactFilters
    ? "mx-2 mt-2 flex shrink-0 items-center justify-between border-b border-[#edf0f5] bg-white px-4 py-3"
    : "mx-3 mt-3 flex shrink-0 items-center justify-between border-b border-[#edf0f5] bg-white px-5 py-4";
  const tableWrapClass = compactFilters ? "mx-2 min-h-0 flex-1 overflow-auto bg-white px-0" : "mx-3 min-h-0 flex-1 overflow-auto bg-white px-0";
  const pagerClass = compactFilters
    ? "mx-2 flex shrink-0 items-center justify-center border-t border-[#d9e3ed] bg-white px-4 py-1.5 text-sm text-[#607083]"
    : "mx-3 flex shrink-0 items-center justify-center border-t border-[#d9e3ed] bg-white px-4 py-2 text-sm text-[#607083]";
  const toolbarAlign = dsl.presentation?.toolbar?.align ?? "left";

  if (dsl.layout === "calendar" || presentationWithDictionaries?.type === "calendar") {
    return (
      <div className={`flex h-full flex-col overflow-hidden bg-[#eef0f8] ${pageFontClass}`}>
        <div className={filterBarClass}>
          {sortWithOrder(filtersDsl).map((field) => (
            <label key={field.key} className="flex flex-col gap-1 text-xs font-medium text-[#607083]">
              {renderFilterInput(field)}
            </label>
          ))}
          <button className={`${token.button} ${token.primaryButton} ${compactFilters ? "h-7 px-4 text-xs" : ""}`} onClick={() => { setPage(1); void load(filters, 1); }}>查询</button>
          <button className={`${token.button} ${token.defaultButton} ${compactFilters ? "h-7 px-4 text-xs" : ""}`} onClick={() => { const empty = { course_date: currentWeekRange() }; setFilters(empty); setPage(1); void load(empty, 1); }}>重置</button>
        </div>
        {error && <div className="mx-3 mt-3 border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}
        <div className="mx-3 mt-3 min-h-0 flex-1 overflow-hidden bg-white">
          <CalendarView dsl={{ ...dsl, presentation: presentationWithDictionaries }} rows={rows} toolbar={toolbarDsl} onToolbar={onToolbar} onAction={onRowAction} />
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
            presentation={presentationWithDictionaries}
            size={"action" in modal ? modal.action?.modalSize : undefined}
            submitLabel={"action" in modal ? modal.action?.submitLabel : undefined}
            submitActions={modalFields(modal).some((field) => field.type === "attendance_table") ? [
              { label: "取消考勤", value: { __attendanceMode: "cancel_attendance" }, variant: "default" },
              { label: "取消扣费", value: { __attendanceMode: "cancel_charge" }, variant: "danger" },
              { label: "考勤", value: { __attendanceMode: "attendance" }, variant: "default" },
              { label: "扣费", value: { __attendanceMode: "charge" }, variant: "primary" }
            ] : undefined}
          />
        )}
      </div>
    );
  }

  return (
    <div className={`flex h-full flex-col overflow-hidden bg-[#eef0f8] ${pageFontClass}`}>
      {!hideHeader && (
        <div className="mx-4 mt-4 mb-3 flex items-start justify-between border-b border-[#d9e3ed] bg-white px-4 py-3">
          <div>
            <h1 className={`${pageTitleClass} font-semibold text-[#172033]`}>{dsl.title}</h1>
            {(dsl.presentation?.header?.subtitle ?? dsl.subtitle) && (
              <p className="mt-1 text-xs text-[#607083]">{dsl.presentation?.header?.subtitle ?? dsl.subtitle}</p>
            )}
          </div>
          <div className="text-sm text-[#607083]">{loading ? "加载中..." : `共 ${total} 条`}</div>
        </div>
      )}
      <div className={filterBarClass}>
        {sortWithOrder(filtersDsl).map((field) => (
          <label key={field.key} className="flex flex-col gap-1 text-xs font-medium text-[#607083]">
            {showFilterLabels && field.label}
            {renderFilterInput(field)}
          </label>
        ))}
        <button className={`${token.button} ${token.primaryButton} ${compactFilters ? "h-7 px-4 text-xs" : ""}`} onClick={() => { setPage(1); void load(filters, 1, pageSize); }}>
          查询
        </button>
        <button className={`${token.button} ${token.defaultButton} ${compactFilters ? "h-7 px-4 text-xs" : ""}`} onClick={() => { const empty = dsl.pageCode === "course_week_schedule" ? { course_date: currentWeekRange() } : {}; setFilters(empty); setPage(1); void load(empty, 1, pageSize); }}>
          重置
        </button>
      </div>
      <div className={titleBarClass}>
        <div className={`flex items-center gap-1 ${pageTitleClass} font-semibold text-[#172033]`}>
          {dsl.title}
          {headerMetricTip && (
            <span
              className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-[#c8ced8] text-[10px] font-bold text-white"
              title={headerMetricTip}
            >
              i
            </span>
          )}
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
            dsl={{ ...dsl, presentation: presentationWithDictionaries }}
            scope={scope}
            schemaName={schemaName}
            importConfig={importConfig}
            onComplete={() => {
              void load();
            }}
          />
        </div>
      )}
      <div className={tableWrapClass}>
        <GenericTableRenderer
          columns={tableDsl.columns ?? []}
          rows={rows}
          rowActions={tableDsl.rowActions}
          onAction={onRowAction}
          presentation={presentationWithDictionaries}
          selectable={Boolean(tableDsl.selectable)}
          selectedRowIds={selectedRowIds}
          onSelectionChange={setSelectedRowIds}
        />
      </div>

      <div className={pagerClass}>
        <div className="flex items-center gap-2">
          <button className={`${token.button} ${token.defaultButton} h-8`} disabled={page <= 1} onClick={() => { const next = Math.max(1, page - 1); setPage(next); void load(filters, next, pageSize); }}>上一页</button>
          <span>第 {page} / {Math.max(1, Math.ceil(total / pageSize))} 页</span>
          <button className={`${token.button} ${token.defaultButton} h-8`} disabled={page >= Math.max(1, Math.ceil(total / pageSize))} onClick={() => { const next = page + 1; setPage(next); void load(filters, next, pageSize); }}>下一页</button>
          <select
            className="ml-2 h-8 rounded-[3px] border border-[#dde3ee] bg-white px-2 text-sm text-[#526075] outline-none"
            value={pageSize}
            onChange={(event) => {
              const nextPageSize = Number(event.target.value);
              setPageSize(nextPageSize);
              setPage(1);
              void load(filters, 1, nextPageSize);
            }}
          >
            {[10, 20, 50, 100].map((size) => (
              <option key={size} value={size}>每页{size}条</option>
            ))}
          </select>
          <span className="ml-2">共 {total.toLocaleString()} 条</span>
        </div>
      </div>
      {modal && dsl.pageCode === "approval_task_list" && modal.type === "detail" ? (
        <ApprovalTaskDetail
          value={modal.value}
          onClose={() => setModal(null)}
          onApprove={async () => {
            await GatewayClient.executeApi({ scope, schemaName, pageCode: dsl.pageCode, apiCode: "approvalTask.approve", params: { id: modal.value.id } });
            setModal(null);
            await load(filters, page);
          }}
          onReject={async () => {
            await GatewayClient.executeApi({ scope, schemaName, pageCode: dsl.pageCode, apiCode: "approvalTask.reject", params: { id: modal.value.id } });
            setModal(null);
            await load(filters, page);
          }}
        />
      ) : modal && (
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
          presentation={presentationWithDictionaries}
          size={"action" in modal ? modal.action?.modalSize : undefined}
          submitLabel={"action" in modal ? modal.action?.submitLabel : undefined}
          submitActions={modalFields(modal).some((field) => field.type === "attendance_table") ? [
            { label: "取消考勤", value: { __attendanceMode: "cancel_attendance" }, variant: "default" },
            { label: "取消扣费", value: { __attendanceMode: "cancel_charge" }, variant: "danger" },
            { label: "考勤", value: { __attendanceMode: "attendance" }, variant: "default" },
            { label: "扣费", value: { __attendanceMode: "charge" }, variant: "primary" }
          ] : undefined}
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
