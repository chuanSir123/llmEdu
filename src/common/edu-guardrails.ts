/**
 * 教务域护栏的可复用判定：租户隔离表、财务派生写保护。
 * 静态清单仅作模板基线兜底；优先读字段/表元数据，使 AI 新增表/字段不会被静默跳过。
 */

/** 财务派生字段：只能由业务命令维护，禁止写接口/可编辑弹窗直接开放。 */
export const PROTECTED_FINANCE_WRITE_FIELDS = new Set([
  "paid_amount",
  "paid_status",
  "paid_real_hour",
  "paid_promotion_hour",
  "paid_real_amount",
  "paid_promotion_amount",
  "remaining_real_hour",
  "remaining_promotion_hour",
  "remaining_real_amount",
  "remaining_promotion_amount",
  "arrange_real_hour",
  "arrange_real_amount",
  "arrange_promotion_hour",
  "arrange_promotion_amount",
]);

/** 模板基线中明确需要租户/校区隔离的业务表（清单兜底）。 */
export const TENANT_SCOPED_TABLES = new Set([
  "student",
  "lead",
  "student_followup",
  "contract",
  "contract_product",
  "funds_history",
  "charge_record",
  "refund_record",
  "course",
  "course_list",
  "generic_course",
  "generic_course_student",
  "attendance_record",
]);

/** 租户范围字段名。 */
export const TENANT_SCOPE_FIELDS = new Set([
  "organization_id",
  "tenant_id",
  "school_id",
  "campus_id",
]);

/**
 * 平台/配置类表：查询时通常不强制 organization 隔离（非租户业务事实表）。
 * 不在此集合、也不在 TENANT_SCOPED_TABLES 的表，默认按租户业务表处理（AI 新表 fail-closed）。
 */
export const PLATFORM_NON_SCOPED_TABLES = new Set([
  "organization",
  "user",
  "role",
  "role_resource",
  "user_role",
  "dictionary",
  "pay_way_config",
  "product",
  "promotion",
  "classroom",
  "lesson",
  "module_registry",
  "feature_registry",
  "business_rule",
  "approval_flow",
  "print_template",
]);

export type TableScopeMeta = {
  /** 显式标记是否租户隔离表 */
  tenantScoped?: boolean;
  /** 已知列名（来自 information_schema / create_table fields / 缓存） */
  columns?: Iterable<string>;
};

export type TenantScopeOptions = {
  tableMeta?: TableScopeMeta;
  /** 同批 diff 中 create_table 已声明范围字段的表名 */
  scopedTablesFromDiffs?: Iterable<string>;
  /** 额外已知隔离表（如运行时从 DB 探测） */
  knownScopedTables?: Iterable<string>;
};

/** 字段是否禁止直接写入（元数据优先，静态清单与命名模式兜底）。 */
export function isProtectedFinanceWriteField(
  field: string,
  fieldDef?: Record<string, unknown> | null
): boolean {
  if (!field) return false;
  if (fieldDef && typeof fieldDef === "object") {
    if (
      fieldDef.derived === true ||
      fieldDef.protected === true ||
      fieldDef.writeProtected === true ||
      fieldDef.financeDerived === true
    ) {
      return true;
    }
  }
  if (PROTECTED_FINANCE_WRITE_FIELDS.has(field)) return true;
  // 租户 AI 新增的同类派生字段命名约定
  if (/^(paid|remaining|arrange)_(real|promotion)_(hour|amount)$/.test(field)) return true;
  return false;
}

/**
 * 表是否应按租户业务表做数据隔离校验。
 * 优先级：显式元数据 → 列含范围字段 → 同批 create_table → 静态隔离清单 →
 * 未知表（非平台配置表）默认隔离（避免 AI 新表被静默跳过）。
 */
export function isTenantScopedTable(table: string, options?: TenantScopeOptions): boolean {
  if (!table) return false;
  const meta = options?.tableMeta;
  if (meta?.tenantScoped === false) return false;
  if (meta?.tenantScoped === true) return true;
  if (meta?.columns) {
    for (const col of meta.columns) {
      if (TENANT_SCOPE_FIELDS.has(String(col))) return true;
    }
  }
  if (options?.scopedTablesFromDiffs) {
    for (const name of options.scopedTablesFromDiffs) {
      if (name === table) return true;
    }
  }
  if (options?.knownScopedTables) {
    for (const name of options.knownScopedTables) {
      if (name === table) return true;
    }
  }
  if (TENANT_SCOPED_TABLES.has(table)) return true;
  // AI / 租户自定义业务表：不在平台配置表清单内 → 按隔离表处理
  if (!PLATFORM_NON_SCOPED_TABLES.has(table)) return true;
  return false;
}

/** 从 create_table resourceDef 收集是否含租户范围字段。 */
export function resourceDefHasTenantScope(resourceDef: Record<string, unknown> | null | undefined): boolean {
  if (!resourceDef || typeof resourceDef !== "object") return false;
  const fields = Array.isArray(resourceDef.fields) ? resourceDef.fields : [];
  for (const field of fields) {
    if (!field || typeof field !== "object" || Array.isArray(field)) continue;
    const key = String((field as Record<string, unknown>).key ?? (field as Record<string, unknown>).field ?? "");
    if (TENANT_SCOPE_FIELDS.has(key)) return true;
  }
  if (resourceDef.tenantScoped === true) return true;
  return false;
}
