import type { DslDiff, TenantAgentPolicy } from "../types.js";
import { SYSTEM_FIELD_SET as SYSTEM_FIELDS, SAFE_DATA_PERMISSION_SET } from "../../common/dsl-constants.js";
import { PHONE_HINTS, MONEY_HINTS, DATE_HINTS, TIME_HINTS, COUNT_HINTS } from "../../common/field-type.js";
const OVERWRITE_STRATEGIES = new Set(["upsert", "overwrite", "replace", "merge"]);
const FIELD_RE = /^[a-z][a-z0-9_]{0,62}$/;
const ROLE_CODE_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
const SAFE_DATA_PERMISSIONS = SAFE_DATA_PERMISSION_SET;
const ALL_DATA_PERMISSION = "all";
const PAGE_PERMISSIONS = new Set(["read", "all", "none"]);
const FIELD_PERMISSIONS = new Set(["visible", "readonly", "hidden"]);
const PROTECTED_FINANCE_WRITE_FIELDS = new Set([
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
const TENANT_SCOPED_TABLES = new Set([
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
const TENANT_SCOPE_FIELDS = new Set(["organization_id", "tenant_id", "school_id", "campus_id"]);
const TENANT_DATA_PERMISSIONS = new Set(["own_courses", "own_students", "own_organization", "organization_or_sub"]);

export function validateEduDomainGuardrails(diffs: DslDiff[], policy: TenantAgentPolicy): string[] {
  const errors: string[] = [];

  for (const diff of diffs) {
    for (const field of collectFieldDefs(diff)) {
      validateFieldShape(errors, diff, field);
    }
    validateImport(errors, diff, policy);
    validateReport(errors, diff);
    validateTenantDataScope(errors, diff);
    validateCustomTableScope(errors, diff);
    validatePermissionPolicy(errors, diff);
    validateFollowupAction(errors, diff);
    validateCourseSchedulingAction(errors, diff);
    validateChargeAction(errors, diff);
    validateContractPaymentAction(errors, diff);
    validateRefundAction(errors, diff);
    validateProtectedFinanceWrites(errors, diff);
  }

  return errors;
}

function validateCustomTableScope(errors: string[], diff: DslDiff) {
  if (diff.targetType !== "db_schema" || diff.op !== "create_table" || !diff.resourceDef) return;
  const tableName = String(diff.resourceDef.tableName ?? diff.targetCode ?? "");
  if (diff.resourceDef.softDelete === false) {
    errors.push(`业务表 ${tableName} 必须启用 softDelete，避免租户误删数据不可恢复`);
  }
  if (diff.resourceDef.extJson === false) {
    errors.push(`业务表 ${tableName} 必须保留 extJson，支持后续低风险租户扩展字段`);
  }
  if (hasTenantScope(diff.resourceDef)) return;
  const fields = Array.isArray(diff.resourceDef.fields) ? diff.resourceDef.fields.filter(isObject) : [];
  const hasScopeField = fields.some((field) => TENANT_SCOPE_FIELDS.has(String(field.key ?? field.field ?? "")));
  if (!hasScopeField) {
    errors.push(`业务表 ${tableName} 必须包含 organization_id 等租户范围字段，避免跨校区数据混用`);
  }
}

function validateTenantDataScope(errors: string[], diff: DslDiff) {
  if (diff.targetType === "report_dsl" && diff.op === "create_report" && diff.resourceDef) {
    const sourceTable = String(diff.resourceDef.sourceTable ?? "");
    if (!isTenantScopedTable(sourceTable) || hasTenantScope(diff.resourceDef)) return;
    errors.push(`报表 ${diff.targetCode} 基于租户业务表 ${sourceTable}，必须配置 organization_id 维度/筛选或明确的数据权限范围`);
    return;
  }

  if (diff.targetType !== "api_dsl" || diff.op !== "modify") return;
  if (!diff.modifiedDslJson || typeof diff.modifiedDslJson !== "object" || Array.isArray(diff.modifiedDslJson)) return;
  const dsl = diff.modifiedDslJson as Record<string, unknown>;
  const operation = String(dsl.operation ?? dsl.apiType ?? "");
  if (!["query", "detail", "list"].includes(operation)) return;
  const table = String(dsl.table ?? "");
  if (!isTenantScopedTable(table)) return;

  const security = isObject(dsl.security) ? dsl.security : {};
  const dataPermission = String(dsl.dataPermission ?? security.dataPermission ?? "");
  if (!hasTenantScope(dsl) && !TENANT_DATA_PERMISSIONS.has(dataPermission)) {
    errors.push(`API ${diff.targetCode} 查询租户业务表 ${table}，必须配置 organization_id 固定条件或明确的数据权限范围`);
  }
}

function validatePermissionPolicy(errors: string[], diff: DslDiff) {
  if (diff.targetType !== "permission_policy" || diff.op !== "modify_permission" || !diff.resourceDef) return;
  const roleCode = String(diff.resourceDef.roleCode ?? "");
  const pageCode = String(diff.resourceDef.pageCode ?? diff.targetCode.split(".").slice(1).join("."));
  const pagePermission = String(diff.resourceDef.pagePermission ?? "read");
  const dataPermission = String(diff.resourceDef.dataPermission ?? "self_only");

  if (!ROLE_CODE_RE.test(roleCode)) errors.push(`权限策略 ${diff.targetCode} roleCode 不合法: ${roleCode}`);
  if (!FIELD_RE.test(pageCode)) errors.push(`权限策略 ${diff.targetCode} pageCode 不合法: ${pageCode}`);
  if (!PAGE_PERMISSIONS.has(pagePermission)) errors.push(`权限策略 ${diff.targetCode} pagePermission 不支持: ${pagePermission}`);
  if (!SAFE_DATA_PERMISSIONS.has(dataPermission) && dataPermission !== ALL_DATA_PERMISSION) {
    errors.push(`权限策略 ${diff.targetCode} dataPermission 不支持: ${dataPermission}`);
  }

  const buttonPermission = diff.resourceDef.buttonPermission;
  if (buttonPermission != null && !Array.isArray(buttonPermission)) {
    errors.push(`权限策略 ${diff.targetCode} buttonPermission 必须是数组`);
  }
  if (Array.isArray(buttonPermission)) {
    for (const action of buttonPermission) {
      const actionCode = String(action);
      if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)?$/.test(actionCode)) {
        errors.push(`权限策略 ${diff.targetCode} buttonPermission 不合法: ${actionCode}`);
      }
    }
  }

  const fieldPermission = diff.resourceDef.fieldPermission;
  if (fieldPermission != null && !isObject(fieldPermission)) {
    errors.push(`权限策略 ${diff.targetCode} fieldPermission 必须是对象`);
  }
  if (isObject(fieldPermission)) {
    for (const [field, permission] of Object.entries(fieldPermission)) {
      if (!FIELD_RE.test(field)) errors.push(`权限策略 ${diff.targetCode} fieldPermission 字段不合法: ${field}`);
      if (!FIELD_PERMISSIONS.has(String(permission))) {
        errors.push(`权限策略 ${diff.targetCode} fieldPermission.${field} 不支持: ${permission}`);
      }
    }
  }
}

function validateCourseSchedulingAction(errors: string[], diff: DslDiff) {
  if (diff.targetType !== "page_dsl") return;
  const actions = collectPageActions(diff);
  for (const action of actions) {
    const actionCode = String(action.actionCode ?? "");
    const apiCode = String(action.apiCode ?? "");
    const looksScheduling = apiCode === "course_list.create";
    if (!looksScheduling) continue;

    const type = String(action.type ?? action.actionType ?? "");
    if (type !== "open_modal") errors.push(`${diff.targetCode} 排课动作 ${actionCode} 必须使用 open_modal`);
    if (apiCode !== "course_list.create") {
      errors.push(`${diff.targetCode} 排课动作 ${actionCode} apiCode 必须是 course_list.create`);
    }

    const fields = arrayObjects(action.fields);
    const fieldKeys = new Set(fields.map((field) => String(field.key ?? "")));
    for (const required of ["course_title", "course_type", "course_date", "start_time", "end_time", "teacher_id", "organization_id", "course_hour"]) {
      if (!fieldKeys.has(required)) errors.push(`${diff.targetCode} 排课动作 ${actionCode} 缺少字段 ${required}`);
    }
  }
}

function validateContractPaymentAction(errors: string[], diff: DslDiff) {
  if (diff.targetType !== "page_dsl") return;
  const actions = collectPageRowActions(diff);
  for (const action of actions) {
    const actionCode = String(action.actionCode ?? "");
    const apiCode = String(action.apiCode ?? "");
    const looksPayment = apiCode === "funds_history.create";
    if (!looksPayment) continue;

    const type = String(action.type ?? action.actionType ?? "");
    if (type !== "open_modal") errors.push(`${diff.targetCode} 收款动作 ${actionCode} 必须使用 open_modal`);
    if (apiCode !== "funds_history.create") {
      errors.push(`${diff.targetCode} 收款动作 ${actionCode} apiCode 必须是 funds_history.create`);
    }

    const visibleWhen = isObject(action.visibleWhen) ? action.visibleWhen : {};
    if (visibleWhen.contract_status !== "ACTIVE") {
      errors.push(`${diff.targetCode} 收款动作 ${actionCode} 必须限制 visibleWhen.contract_status = "ACTIVE"`);
    }

    const fields = arrayObjects(action.fields);
    const fieldKeys = new Set(fields.map((field) => String(field.key ?? "")));
    for (const required of ["contract_id", "student_id", "organization_id", "transaction_amount", "pay_way_config_id", "transaction_time", "funds_type"]) {
      if (!fieldKeys.has(required)) errors.push(`${diff.targetCode} 收款动作 ${actionCode} 缺少字段 ${required}`);
    }

    const mapRowToValue = isObject(action.mapRowToValue) ? action.mapRowToValue : {};
    if (mapRowToValue.contract_id !== "id") {
      errors.push(`${diff.targetCode} 收款动作 ${actionCode} 必须配置 mapRowToValue.contract_id = "id"`);
    }
    if (mapRowToValue.student_id !== "student_id") {
      errors.push(`${diff.targetCode} 收款动作 ${actionCode} 必须配置 mapRowToValue.student_id = "student_id"`);
    }
  }
}

function validateRefundAction(errors: string[], diff: DslDiff) {
  if (diff.targetType !== "page_dsl") return;
  const actions = collectPageRowActions(diff);
  for (const action of actions) {
    const actionCode = String(action.actionCode ?? "");
    const apiCode = String(action.apiCode ?? "");
    const looksRefund = apiCode === "refund_record.create";
    if (!looksRefund) continue;

    const type = String(action.type ?? action.actionType ?? "");
    if (type !== "open_modal") errors.push(`${diff.targetCode} 退费动作 ${actionCode} 必须使用 open_modal`);
    if (apiCode !== "refund_record.create") {
      errors.push(`${diff.targetCode} 退费动作 ${actionCode} apiCode 必须是 refund_record.create`);
    }

    const fields = arrayObjects(action.fields);
    const fieldKeys = new Set(fields.map((field) => String(field.key ?? "")));
    for (const required of ["student_id", "contract_product_id", "refund_real_hour", "refund_real_amount", "refund_promotion_amount", "refund_promotion_hour", "refund_way_config_id", "refund_time"]) {
      if (!fieldKeys.has(required)) errors.push(`${diff.targetCode} 退费动作 ${actionCode} 缺少字段 ${required}`);
    }

    const mapRowToValue = isObject(action.mapRowToValue) ? action.mapRowToValue : {};
    if (mapRowToValue.contract_product_id !== "id") {
      errors.push(`${diff.targetCode} 退费动作 ${actionCode} 必须配置 mapRowToValue.contract_product_id = "id"`);
    }
  }
}

function validateChargeAction(errors: string[], diff: DslDiff) {
  if (diff.targetType !== "page_dsl") return;
  const actions = collectPageRowActions(diff);
  for (const action of actions) {
    const actionCode = String(action.actionCode ?? "");
    const apiCode = String(action.apiCode ?? "");
    const looksCharge = apiCode === "charge_record.create";
    if (!looksCharge) continue;

    const type = String(action.type ?? action.actionType ?? "");
    if (type !== "open_modal") errors.push(`${diff.targetCode} 扣费动作 ${actionCode} 必须使用 open_modal`);
    if (apiCode !== "charge_record.create") {
      errors.push(`${diff.targetCode} 扣费动作 ${actionCode} apiCode 必须是 charge_record.create`);
    }

    const visibleWhen = isObject(action.visibleWhen) ? action.visibleWhen : {};
    if (visibleWhen.course_status !== "FINISHED") {
      errors.push(`${diff.targetCode} 扣费动作 ${actionCode} 必须限制 visibleWhen.course_status = "FINISHED"`);
    }

    const fields = arrayObjects(action.fields);
    const fieldKeys = new Set(fields.map((field) => String(field.key ?? "")));
    for (const required of ["course_id", "student_id", "contract_product_id", "charge_type", "charge_hour", "charge_amount"]) {
      if (!fieldKeys.has(required)) errors.push(`${diff.targetCode} 扣费动作 ${actionCode} 缺少字段 ${required}`);
    }

    const mapRowToValue = isObject(action.mapRowToValue) ? action.mapRowToValue : {};
    if (mapRowToValue.course_id !== "id") {
      errors.push(`${diff.targetCode} 扣费动作 ${actionCode} 必须配置 mapRowToValue.course_id = "id"`);
    }
  }
}

function validateProtectedFinanceWrites(errors: string[], diff: DslDiff) {
  const writeTarget = diff.targetType === "api_dsl" && /\.(create|update)$/.test(diff.targetCode);
  if (writeTarget && (diff.op === "add_allowed_field" || diff.op === "add_select_field")) {
    const field = String(diff.fieldDef?.field ?? diff.fieldDef?.key ?? diff.field ?? "");
    if (PROTECTED_FINANCE_WRITE_FIELDS.has(field)) {
      errors.push(`${diff.targetCode} 禁止直接写入财务派生字段 ${field}，请使用 funds_history.create 或 charge_record.create 业务命令`);
    }
  }

  if ((diff.targetType === "page_dsl" || diff.targetType === "action_dsl") && diff.op === "add_modal_field") {
    const field = String(diff.fieldDef?.key ?? diff.field ?? "");
    if (PROTECTED_FINANCE_WRITE_FIELDS.has(field)) {
      errors.push(`${diff.targetCode} 禁止把财务派生字段 ${field} 放入可编辑弹窗`);
    }
  }

  if (diff.op === "modify" && diff.modifiedDslJson && typeof diff.modifiedDslJson === "object" && !Array.isArray(diff.modifiedDslJson)) {
    const dsl = diff.modifiedDslJson as Record<string, unknown>;
    const operation = String(dsl.operation ?? dsl.apiType ?? "");
    if (diff.targetType === "api_dsl" && ["create", "update"].includes(operation)) {
      for (const field of collectWriteFieldNames(dsl)) {
        if (PROTECTED_FINANCE_WRITE_FIELDS.has(field)) {
          errors.push(`${diff.targetCode} 禁止在写接口中直接开放财务派生字段 ${field}，请使用业务命令`);
        }
      }
    }
    if (diff.targetType === "page_dsl") {
      const modal = isObject(dsl.modal) ? dsl.modal : {};
      for (const field of arrayObjects(modal.fields)) {
        const key = String(field.key ?? "");
        if (PROTECTED_FINANCE_WRITE_FIELDS.has(key)) {
          errors.push(`${diff.targetCode} 禁止把财务派生字段 ${key} 放入可编辑弹窗`);
        }
      }
    }
  }
}

function validateFollowupAction(errors: string[], diff: DslDiff) {
  if (diff.targetType !== "page_dsl") return;
  const actions = collectPageRowActions(diff);

  for (const action of actions) {
    const actionCode = String(action.actionCode ?? "");
    const looksFollowup = String(action.apiCode ?? "") === "student_followup_list.create";
    if (!looksFollowup) continue;

    const type = String(action.type ?? action.actionType ?? "");
    const apiCode = String(action.apiCode ?? "");
    if (type !== "open_modal") errors.push(`${diff.targetCode} 跟进动作 ${actionCode} 必须使用 open_modal`);
    if (apiCode !== "student_followup_list.create") {
      errors.push(`${diff.targetCode} 跟进动作 ${actionCode} apiCode 必须是 student_followup_list.create`);
    }

    const fields = arrayObjects(action.fields);
    const fieldKeys = new Set(fields.map((field) => String(field.key ?? "")));
    for (const required of ["student_id", "follow_type", "follow_content", "next_follow_time"]) {
      if (!fieldKeys.has(required)) errors.push(`${diff.targetCode} 跟进动作 ${actionCode} 缺少字段 ${required}`);
    }

    const mapRowToValue = isObject(action.mapRowToValue) ? action.mapRowToValue : {};
    if (mapRowToValue.student_id !== "id") {
      errors.push(`${diff.targetCode} 跟进动作 ${actionCode} 必须配置 mapRowToValue.student_id = "id"`);
    }
  }
}

function collectPageRowActions(diff: DslDiff): Array<Record<string, unknown>> {
  return collectPageActions(diff);
}

function collectPageActions(diff: DslDiff): Array<Record<string, unknown>> {
  const actions: Array<Record<string, unknown>> = [];
  if (diff.op === "add_row_action" && diff.fieldDef) actions.push(diff.fieldDef);
  if (diff.op === "add_toolbar" && diff.fieldDef) actions.push(diff.fieldDef);
  if (diff.op === "modify" && diff.modifiedDslJson && typeof diff.modifiedDslJson === "object" && !Array.isArray(diff.modifiedDslJson)) {
    const dsl = diff.modifiedDslJson as Record<string, unknown>;
    const table = dsl.table;
    actions.push(...arrayObjects(dsl.toolbar));
    if (isObject(table)) actions.push(...arrayObjects(table.rowActions));
  }
  return actions;
}

function collectFieldDefs(diff: DslDiff): Array<Record<string, unknown>> {
  const fields: Array<Record<string, unknown>> = [];
  if (diff.fieldDef) fields.push(diff.fieldDef);
  if (Array.isArray(diff.resourceDef?.fields)) {
    fields.push(...diff.resourceDef.fields.filter(isObject));
  }
  if (diff.modifiedDslJson && typeof diff.modifiedDslJson === "object" && !Array.isArray(diff.modifiedDslJson)) {
    const dsl = diff.modifiedDslJson as Record<string, unknown>;
    const table = isObject(dsl.table) ? dsl.table : {};
    const modal = isObject(dsl.modal) ? dsl.modal : {};
    fields.push(...arrayObjects(dsl.filters));
    fields.push(...arrayObjects(table.columns));
    fields.push(...arrayObjects(modal.fields));
    fields.push(...arrayObjects(dsl.fields));
  }
  return fields;
}

function collectWriteFieldNames(dsl: Record<string, unknown>): string[] {
  const names = new Set<string>();
  for (const field of arrayObjects(dsl.allowedFields)) {
    const key = String(field.field ?? field.key ?? "");
    if (key) names.add(key);
  }
  if (Array.isArray(dsl.allowedFields)) {
    for (const item of dsl.allowedFields) {
      if (typeof item === "string") names.add(item);
    }
  }
  for (const field of arrayObjects(dsl.fields)) {
    const key = String(field.field ?? field.key ?? "");
    if (key) names.add(key);
  }
  return [...names];
}

function validateFieldShape(errors: string[], diff: DslDiff, field: Record<string, unknown>) {
  const key = String(field.key ?? field.field ?? "");
  const label = String(field.label ?? field.title ?? field.name ?? "");
  const type = String(field.type ?? "").toLowerCase();
  const text = `${key} ${label}`.toLowerCase();
  if (!key) return;

  if (diff.targetType !== "import_dsl" && SYSTEM_FIELDS.has(key)) {
    errors.push(`${diff.targetCode} 不允许把系统字段 ${key} 暴露为租户可配置字段`);
  }
  if (hasHint(text, PHONE_HINTS) && ["number", "integer", "decimal"].includes(type)) {
    errors.push(`${diff.targetCode}.${key} 手机/电话字段必须使用 text/tel 类型，避免前导 0 和区号丢失`);
  }
  if (hasHint(text, MONEY_HINTS) && type && !["number", "decimal", "currency", "money"].includes(type)) {
    errors.push(`${diff.targetCode}.${key} 金额/学费/余额类字段必须使用 number/decimal/currency 类型`);
  }
  if (hasHint(text, DATE_HINTS) && type && !["date", "datetime"].includes(type)) {
    errors.push(`${diff.targetCode}.${key} 日期类字段必须使用 date/datetime 类型`);
  }
  if (hasHint(text, TIME_HINTS) && !hasHint(text, DATE_HINTS) && type && !["time", "datetime", "text"].includes(type)) {
    errors.push(`${diff.targetCode}.${key} 时间类字段类型不合理，请使用 time/datetime；自由文本时使用 text`);
  }
  if (hasHint(text, COUNT_HINTS) && type && !["number", "integer", "decimal"].includes(type)) {
    errors.push(`${diff.targetCode}.${key} 课时/次数/数量类字段必须使用 number/integer/decimal 类型`);
  }
}

function validateImport(errors: string[], diff: DslDiff, policy: TenantAgentPolicy) {
  if (diff.targetType !== "import_dsl" || diff.op !== "create_import" || !diff.resourceDef) return;
  const pageCode = String(diff.resourceDef.pageCode ?? "");
  const apiCode = String(diff.resourceDef.apiCode ?? "");
  if (!FIELD_RE.test(pageCode)) errors.push(`导入模板 ${diff.targetCode} pageCode 不合法: ${pageCode}`);
  if (!/^[a-z][a-z0-9_]*\.create$/.test(apiCode)) {
    errors.push(`导入模板 ${diff.targetCode} apiCode 必须指向 create 接口，不能是 query/update/delete: ${apiCode}`);
  }

  const fields = Array.isArray(diff.resourceDef.fields) ? diff.resourceDef.fields.filter(isObject) : [];
  const seenKeys = new Set<string>();
  const seenLabels = new Set<string>();
  for (const field of fields) {
    const key = String(field.key ?? field.field ?? "");
    const label = String(field.label ?? field.title ?? key);
    if (!FIELD_RE.test(key)) errors.push(`导入模板 ${diff.targetCode} 字段 key 不合法: ${key}`);
    if (!label.trim()) errors.push(`导入模板 ${diff.targetCode} 字段 ${key} 缺少 label`);
    if (seenKeys.has(key)) errors.push(`导入模板 ${diff.targetCode} 重复字段 key: ${key}`);
    seenKeys.add(key);
    if (seenLabels.has(label)) errors.push(`导入模板 ${diff.targetCode} 重复模板列名: ${label}`);
    seenLabels.add(label);
    if (SYSTEM_FIELDS.has(key)) {
      errors.push(`导入模板 ${diff.targetCode} 不能要求租户填写系统字段 ${key}`);
    }
    if (key.endsWith("_id")) {
      const source = isObject(field.optionSource) ? field.optionSource : {};
      if (!source.apiCode || !source.labelField) {
        errors.push(`导入模板 ${diff.targetCode} 外键字段 ${key} 必须配置 optionSource.apiCode 和 labelField，用名称解析 ID`);
      }
      if (/id$/i.test(label) || label.includes("编号")) {
        errors.push(`导入模板 ${diff.targetCode} 外键字段 ${key} 模板列名应使用业务名称，不要使用 ID/编号`);
      }
    }
  }

  const duplicateStrategy = String(diff.resourceDef.duplicateStrategy ?? "").toLowerCase();
  if (!policy.dataPolicy.allowOverwrite && OVERWRITE_STRATEGIES.has(duplicateStrategy)) {
    errors.push(`租户策略不允许覆盖导入，${diff.targetCode} duplicateStrategy 不能为 ${duplicateStrategy}`);
  }
}

function validateReport(errors: string[], diff: DslDiff) {
  if (diff.targetType !== "report_dsl" || diff.op !== "create_report" || !diff.resourceDef) return;
  const sourceTable = String(diff.resourceDef.sourceTable ?? "");
  if (!FIELD_RE.test(sourceTable)) {
    errors.push(`报表 ${diff.targetCode} sourceTable 不合法: ${sourceTable}`);
  }
  const dimensions = Array.isArray(diff.resourceDef.dimensions) ? diff.resourceDef.dimensions : [];
  for (const dimension of dimensions) {
    const field = String(dimension);
    if (!FIELD_RE.test(field)) errors.push(`报表 ${diff.targetCode} 维度字段不合法: ${field}`);
  }
  const metrics = Array.isArray(diff.resourceDef.metrics) ? diff.resourceDef.metrics.filter(isObject) : [];
  for (const metric of metrics) {
    const field = String(metric.field ?? metric.as ?? "");
    const alias = metric.as == null ? "" : String(metric.as);
    const type = String(metric.type ?? metric.aggregate ?? "").toLowerCase();
    if (!field) errors.push(`报表 ${diff.targetCode} 指标缺少 field`);
    if (field && !FIELD_RE.test(field)) errors.push(`报表 ${diff.targetCode} 指标字段不合法: ${field}`);
    if (alias && !FIELD_RE.test(alias)) errors.push(`报表 ${diff.targetCode} 指标别名不合法: ${alias}`);
    if (type && !["count", "sum", "avg", "min", "max", "distinct_count"].includes(type)) {
      errors.push(`报表 ${diff.targetCode} 指标 ${field} 使用了不支持的聚合类型 ${type}`);
    }
  }
  const filters = Array.isArray(diff.resourceDef.filters) ? diff.resourceDef.filters : [];
  for (const filter of filters) {
    const field = typeof filter === "string" ? filter : isObject(filter) ? String(filter.field ?? filter.key ?? "") : "";
    if (field && !FIELD_RE.test(field)) errors.push(`报表 ${diff.targetCode} 筛选字段不合法: ${field}`);
    if (isObject(filter)) {
      const key = String(filter.key ?? filter.param ?? "");
      const op = String(filter.op ?? "").toLowerCase();
      const type = String(filter.type ?? "").toLowerCase();
      if (key && !FIELD_RE.test(key)) errors.push(`报表 ${diff.targetCode} 筛选入参不合法: ${key}`);
      if (op && !["eq", "ilike", "between", "in", "gt", "gte", "lt", "lte"].includes(op)) errors.push(`报表 ${diff.targetCode} 筛选操作不支持: ${op}`);
      if (type === "date_range" && op && op !== "between") errors.push(`报表 ${diff.targetCode} 时间范围筛选必须使用 between`);
    }
  }
}

function isTenantScopedTable(table: string) {
  return TENANT_SCOPED_TABLES.has(table);
}

function hasTenantScope(value: Record<string, unknown>) {
  const dataPermission = String(value.dataPermission ?? "");
  if (TENANT_DATA_PERMISSIONS.has(dataPermission)) return true;
  const explicitScope = String(value.scopeField ?? value.dataScopeField ?? "");
  if (TENANT_SCOPE_FIELDS.has(explicitScope)) return true;

  for (const key of ["dimensions", "filters", "where", "fixedFilters"]) {
    const raw = value[key];
    if (!Array.isArray(raw)) continue;
    for (const item of raw) {
      const field = typeof item === "string" ? item : isObject(item) ? String(item.field ?? item.key ?? "") : "";
      if (TENANT_SCOPE_FIELDS.has(field)) return true;
    }
  }
  const security = isObject(value.security) ? value.security : {};
  const securityPermission = String(security.dataPermission ?? "");
  return TENANT_DATA_PERMISSIONS.has(securityPermission);
}

function hasHint(text: string, hints: string[]) {
  return hints.some((hint) => text.includes(hint.toLowerCase()));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function arrayObjects(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isObject) : [];
}
