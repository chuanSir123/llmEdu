import { callWithToolCalling } from "../llm.service.js";
import { PLAN_CHANGES_TOOL, REPAIR_PROMPT_TEMPLATE } from "../prompts.js";
import { parsePlanDiffsFromToolArguments } from "../dsl-diff-parser.js";
import { VALID_OPS, VALID_TARGET_TYPES, OPS_REQUIRE_FIELD_DEF } from "../types.js";
import type { ContextResult, DslDiff, IntentResult, HarnessStepResult } from "../types.js";
import { pool } from "../../db/pool.js";
import { inferForeignKeyMeta } from "../../common/foreign-key-meta.js";
import { loadTenantAgentPolicy } from "../tenant-policy.service.js";
import { validateTenantPolicy } from "../validators/tenant-policy.validator.js";
import { validateEduDomainGuardrails } from "../validators/edu-domain.validator.js";
import { executeDiffs } from "../diff-executor.js";
import { validateApiDslAgainstSchema } from "../../db/dsl-validator.js";

const FIELD_RE = /^[a-z][a-z0-9_]{0,62}$/;
const MAX_RETRIES = 3;
const REPAIR_TIMEOUT_MS = 30000;

export type ExistingPageActions = {
  toolbar: Set<string>;
  rowActions: Set<string>;
  columns: Set<string>;
  filters: Set<string>;
  modalFields: Set<string>;
};

export type ExistingApiShape = {
  allowedFields: Set<string>;
  selectFields: Set<string>;
  selectAliases: Set<string>;
  filters: Set<string>;
};

export async function executeValidationRepair(
  diffs: DslDiff[],
  intent: IntentResult,
  context: ContextResult,
  schemaName: string,
  originalPrompt: string,
): Promise<HarnessStepResult<DslDiff[]>> {
  const start = Date.now();
  const inputSummary = `diffs_count=${diffs.length}`;

  let currentDiffs = diffs;
  let lastErrors: string[] = [];

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const validation = await validate(currentDiffs, schemaName);
    if (validation.valid) {
      const summary = summarizeDiffs(validation.normalizedDiffs);
      return {
        stepName: "validation_repair",
        input_summary: inputSummary,
        output_summary: `校验通过：${summary}`,
        duration_ms: Date.now() - start,
        data: validation.normalizedDiffs,
      };
    }
    lastErrors = validation.errors;

    if (attempt >= MAX_RETRIES) break;
    if (Date.now() - start > REPAIR_TIMEOUT_MS) {
      lastErrors.push("修正超时");
      break;
    }

    const deterministic = await deterministicPreRepair(currentDiffs, schemaName);
    if (deterministic.length !== currentDiffs.length) {
      currentDiffs = deterministic;
      continue;
    }

    const repaired = await repair(currentDiffs, lastErrors, intent, context, schemaName, originalPrompt);
    if (repaired.length > 0) {
      currentDiffs = repaired;
    }
  }

  return {
    stepName: "validation_repair",
    input_summary: inputSummary,
    output_summary: `failed after ${MAX_RETRIES} repairs: ${lastErrors.join("; ")}`.substring(0, 500),
    duration_ms: Date.now() - start,
    data: currentDiffs,
    error: `校验失败: ${lastErrors.join("; ")}`,
  };
}

async function deterministicPreRepair(diffs: DslDiff[], schemaName: string) {
  const cache = new Map<string, Promise<ExistingPageActions>>();
  const getExisting = (pageCode: string) => {
    if (!cache.has(pageCode)) cache.set(pageCode, loadExistingPageActions(schemaName, pageCode));
    return cache.get(pageCode)!;
  };
  const result: DslDiff[] = [];
  for (const diff of diffs) {
    if (diff.targetType === "page_dsl" && (diff.op === "add_toolbar" || diff.op === "add_row_action")) {
      const actionCode = String(diff.fieldDef?.actionCode ?? "");
      if (actionCode) {
        const existing = await getExisting(diff.targetCode);
        if (diff.op === "add_toolbar" && existing.toolbar.has(actionCode)) continue;
        if (diff.op === "add_row_action" && existing.rowActions.has(actionCode)) continue;
      }
    }
    if (diff.targetType === "page_dsl" && (diff.op === "add_column" || diff.op === "add_filter" || diff.op === "add_modal_field")) {
      const fieldKey = String(diff.fieldDef?.key ?? diff.fieldDef?.field ?? diff.field ?? "");
      if (fieldKey) {
        const existing = await getExisting(diff.targetCode);
        if (diff.op === "add_column" && existing.columns.has(fieldKey)) continue;
        if (diff.op === "add_filter" && existing.filters.has(fieldKey)) continue;
        if (diff.op === "add_modal_field" && existing.modalFields.has(fieldKey)) continue;
      }
    }
    result.push(diff);
  }
  return result;
}

async function validate(diffs: DslDiff[], schemaName: string): Promise<{ valid: boolean; errors: string[]; normalizedDiffs: DslDiff[] }> {
  const errors: string[] = [];
  const normalizedDiffs = await normalizeRelatedDiffs(diffs.map(normalizeDiffShape), schemaName);
  const policy = await loadTenantAgentPolicy(schemaName);
  errors.push(...validateTenantPolicy(normalizedDiffs, policy));
  errors.push(...validateEduDomainGuardrails(normalizedDiffs, policy));
  if (normalizedDiffs.length === 0) errors.push("没有可执行的 DSL 变更");
  const seenAddFields = new Set<string>();
  const detailReadableFields = new Set(
    normalizedDiffs
      .filter((diff) => diff.targetType === "api_dsl" && diff.targetCode.endsWith(".detail") && (diff.op === "add_allowed_field" || diff.op === "add_select_field"))
      .map((diff) => `${diff.targetCode.replace(/\.detail$/, "")}:${String(diff.fieldDef?.field ?? diff.fieldDef?.key ?? diff.field ?? "")}`)
  );
  const queryReadableFields = new Set(
    normalizedDiffs
      .filter((diff) => diff.targetType === "api_dsl" && diff.targetCode.endsWith(".query") && (diff.op === "add_allowed_field" || diff.op === "add_select_field"))
      .map((diff) => `${diff.targetCode.replace(/\.query$/, "")}:${String(diff.fieldDef?.field ?? diff.fieldDef?.key ?? diff.field ?? "")}`)
  );
  const modalDisplayFields = new Set(
    normalizedDiffs
      .filter((diff) => diff.targetType === "action_dsl" && diff.op === "add_modal_field")
      .map((diff) => `${diff.targetCode}:${String(diff.fieldDef?.key ?? diff.field ?? "")}`)
  );
  const physicalFieldAdds = collectPhysicalFieldAdds(normalizedDiffs);
  const seenResourceWrites = new Set<string>();
  const toolbarWrites = new Map<string, string>();
  const existingPageActionCache = new Map<string, Promise<ExistingPageActions>>();
  const existingApiShapeCache = new Map<string, Promise<ExistingApiShape>>();
  const getExistingPageActions = (pageCode: string) => {
    if (!existingPageActionCache.has(pageCode)) {
      existingPageActionCache.set(pageCode, loadExistingPageActions(schemaName, pageCode));
    }
    return existingPageActionCache.get(pageCode)!;
  };
  const registerToolbarWrite = (pageCode: string, actionCode: string, source: string) => {
    if (!pageCode || !actionCode) return;
    const key = `${pageCode}:${actionCode}`;
    const previous = toolbarWrites.get(key);
    if (previous) {
      errors.push(`重复工具栏按钮: ${pageCode}.${actionCode} 同时由 ${previous} 和 ${source} 生成，请合并为一条变更`);
      return;
    }
    toolbarWrites.set(key, source);
  };
  const getExistingApiShape = (apiCode: string) => {
    if (!existingApiShapeCache.has(apiCode)) {
      existingApiShapeCache.set(apiCode, loadExistingApiShape(schemaName, apiCode));
    }
    return existingApiShapeCache.get(apiCode)!;
  };

  for (const diff of normalizedDiffs) {
    if (!VALID_TARGET_TYPES.has(diff.targetType)) errors.push(`invalid targetType: ${diff.targetType}`);
    if (!VALID_OPS.has(diff.op)) errors.push(`invalid op: ${diff.op}`);
    if (["modify", "create_table", "create_import", "create_report", "create_feature", "create_approval_flow", "create_print_template", "create_business_rule"].includes(diff.op)) {
      const resourceKey = `${diff.targetType}:${diff.targetCode}:${diff.op}`;
      if (seenResourceWrites.has(resourceKey)) {
        errors.push(`重复资源变更: ${diff.targetType}/${diff.targetCode} ${diff.op}，请合并为一条变更`);
      }
      seenResourceWrites.add(resourceKey);
    }
    if (OPS_REQUIRE_FIELD_DEF.has(diff.op) && !diff.fieldDef) errors.push(`${diff.op} requires fieldDef for ${diff.targetCode}`);
    if ((diff.op === "create_table" || diff.op === "add_field" || diff.op === "create_import" || diff.op === "create_report" || diff.op === "create_feature" || diff.op === "create_approval_flow" || diff.op === "create_print_template" || diff.op === "create_business_rule" || diff.op === "modify_permission") && !diff.resourceDef) {
      errors.push(`${diff.op} requires resourceDef for ${diff.targetCode}`);
    }
    if (diff.targetType === "db_schema" && diff.resourceDef) {
      const tableName = String(diff.resourceDef.tableName ?? diff.targetCode ?? "");
      if (!FIELD_RE.test(tableName)) errors.push(`invalid table name: ${tableName}`);
      const fields = Array.isArray(diff.resourceDef.fields) ? diff.resourceDef.fields as Array<Record<string, unknown>> : [];
      if (fields.length === 0) errors.push(`db_schema ${diff.targetCode} requires fields`);
      for (const field of fields) {
        const key = String(field.key ?? "");
        if (!FIELD_RE.test(key)) errors.push(`invalid db field name: ${key}`);
      }
    }
    if (diff.targetType === "import_dsl" && diff.resourceDef) {
      if (!diff.resourceDef.pageCode) errors.push(`import_dsl ${diff.targetCode} missing pageCode`);
      if (!Array.isArray(diff.resourceDef.fields)) errors.push(`import_dsl ${diff.targetCode} missing fields`);
      const pageCode = String(diff.resourceDef.pageCode ?? "");
      if (diff.op === "create_import" && pageCode) {
        registerToolbarWrite(pageCode, `${pageCode}.import`, `${diff.targetCode} create_import 自动导入按钮`);
        const existingActions = await getExistingPageActions(pageCode);
        if (existingActions.toolbar.has(`${pageCode}.import`)) {
          errors.push(`工具栏按钮已存在: ${pageCode}.import，导入模板会自动补充按钮，请合并或复用现有导入入口`);
        }
      }
    }
    if (diff.targetType === "report_dsl" && diff.resourceDef) {
      if (!diff.resourceDef.pageCode) errors.push(`report_dsl ${diff.targetCode} missing pageCode`);
      if (!diff.resourceDef.sourceTable) errors.push(`report_dsl ${diff.targetCode} missing sourceTable`);
      const sourceTable = String(diff.resourceDef.sourceTable ?? "");
      if (sourceTable) {
        const reportFields = [
          ...(Array.isArray(diff.resourceDef.dimensions) ? diff.resourceDef.dimensions.map(String) : []),
          ...(Array.isArray(diff.resourceDef.metrics)
            ? (diff.resourceDef.metrics as Array<Record<string, unknown>>).map((metric) => String(metric.field ?? "")).filter(Boolean)
            : []),
          ...(Array.isArray(diff.resourceDef.filters)
            ? (diff.resourceDef.filters as unknown[]).map((filter) => typeof filter === "string" ? filter : filter && typeof filter === "object" && !Array.isArray(filter) ? String((filter as Record<string, unknown>).field ?? (filter as Record<string, unknown>).key ?? "") : "").filter(Boolean)
            : []),
        ];
        for (const field of [...new Set(reportFields)]) {
          if (FIELD_RE.test(sourceTable) && FIELD_RE.test(field) && !(await physicalColumnExists(schemaName, sourceTable, field))) {
            const available = await loadPhysicalColumns(schemaName, sourceTable);
            errors.push(`报表字段不存在: ${sourceTable}.${field}，请从数据库表结构中选择真实字段${available.length > 0 ? `；${sourceTable} 可用字段: ${available.join(", ")}` : ""}`);
          }
        }
      }
    }
    if (diff.targetType === "feature_registry" && diff.resourceDef) {
      if (!diff.resourceDef.featureCode || !diff.resourceDef.pageCode || !diff.resourceDef.moduleCode) {
        errors.push(`feature_registry ${diff.targetCode} missing moduleCode/featureCode/pageCode`);
      }
    }
    if (diff.targetType === "approval_flow" && diff.resourceDef) {
      if (!FIELD_RE.test(String(diff.resourceDef.flowCode ?? diff.targetCode))) errors.push(`approval_flow ${diff.targetCode} flowCode 不合法`);
      if (!diff.resourceDef.flowName) errors.push(`approval_flow ${diff.targetCode} missing flowName`);
      if (!diff.resourceDef.businessType) errors.push(`approval_flow ${diff.targetCode} missing businessType`);
      if (!Array.isArray(diff.resourceDef.steps) || diff.resourceDef.steps.length === 0) errors.push(`approval_flow ${diff.targetCode} missing steps`);
    }
    if (diff.targetType === "print_template" && diff.resourceDef) {
      if (!FIELD_RE.test(String(diff.resourceDef.templateCode ?? diff.targetCode))) errors.push(`print_template ${diff.targetCode} templateCode 不合法`);
      if (!diff.resourceDef.templateName) errors.push(`print_template ${diff.targetCode} missing templateName`);
      if (!diff.resourceDef.pageCode) errors.push(`print_template ${diff.targetCode} missing pageCode`);
    }
    if (diff.targetType === "business_rule" && diff.resourceDef) {
      if (!FIELD_RE.test(String(diff.resourceDef.ruleCode ?? diff.targetCode))) errors.push(`business_rule ${diff.targetCode} ruleCode 不合法`);
      if (!diff.resourceDef.ruleName) errors.push(`business_rule ${diff.targetCode} missing ruleName`);
      validateBusinessRuleResource(errors, diff.targetCode, diff.resourceDef);
    }
    if ((diff.op === "add_column" || diff.op === "add_filter" || diff.op === "add_modal_field") && diff.fieldDef && !diff.fieldDef.key) errors.push(`${diff.op} fieldDef missing key`);
    if (diff.op === "add_select_field" && diff.fieldDef && !diff.fieldDef.field && !diff.fieldDef.key) errors.push(`add_select_field fieldDef missing field`);
    if (diff.op === "add_where" && diff.fieldDef && !(diff.fieldDef as Record<string, unknown>).field) errors.push(`add_where fieldDef missing field`);
    if (diff.op === "modify" && !diff.modifiedDslJson) errors.push(`modify requires modifiedDslJson for ${diff.targetCode}`);
    if (diff.field && !FIELD_RE.test(diff.field)) errors.push(`invalid field name: ${diff.field}`);
    if (diff.fieldDef?.key && !FIELD_RE.test(String(diff.fieldDef.key))) errors.push(`invalid fieldDef.key: ${diff.fieldDef.key}`);
    if (diff.fieldDef?.field && !FIELD_RE.test(String(diff.fieldDef.field))) errors.push(`invalid fieldDef.field: ${diff.fieldDef.field}`);
    validateForeignKeyFieldDef(errors, diff);
    validateModifiedApiDsl(errors, diff);
    if (diff.targetType === "api_dsl" && diff.op === "modify") {
      errors.push(...findModifiedApiDuplicateErrors(diff));
    }
    if (diff.targetType === "page_dsl" && diff.op === "add_toolbar") {
      validateImportToolbarAction(errors, diff.fieldDef, `${diff.targetCode} add_toolbar`);
      validateExportToolbarAction(errors, diff.fieldDef, `${diff.targetCode} add_toolbar`);
      const actionCode = String(diff.fieldDef?.actionCode ?? "");
      registerToolbarWrite(diff.targetCode, actionCode, `${diff.targetCode} add_toolbar`);
      const existingActions = await getExistingPageActions(diff.targetCode);
      errors.push(...findPageActionConflictErrors(diff, existingActions));
    }
    if (diff.targetType === "page_dsl" && diff.op === "add_row_action") {
      const existingActions = await getExistingPageActions(diff.targetCode);
      errors.push(...findPageActionConflictErrors(diff, existingActions));
    }
    if (diff.targetType === "page_dsl" && diff.op === "modify" && diff.modifiedDslJson && typeof diff.modifiedDslJson === "object" && !Array.isArray(diff.modifiedDslJson)) {
      errors.push(...findModifiedPageDuplicateErrors(diff));
      const toolbar = (diff.modifiedDslJson as Record<string, unknown>).toolbar;
      if (Array.isArray(toolbar)) {
        const actionCodes = new Set<string>();
        for (const action of toolbar) {
          validateImportToolbarAction(errors, action, `${diff.targetCode} toolbar`);
          if (!action || typeof action !== "object" || Array.isArray(action)) continue;
          const actionCode = String((action as Record<string, unknown>).actionCode ?? "");
          if (!actionCode) continue;
          if (actionCodes.has(actionCode)) errors.push(`重复工具栏按钮: ${diff.targetCode}.${actionCode} 在 toolbar 中出现多次`);
          actionCodes.add(actionCode);
          registerToolbarWrite(diff.targetCode, actionCode, `${diff.targetCode} modify.toolbar`);
        }
      }
      const table = (diff.modifiedDslJson as Record<string, unknown>).table;
      if (table && typeof table === "object" && !Array.isArray(table)) {
        const rowActionCodes = new Set<string>();
        for (const action of ((table as Record<string, unknown>).rowActions as unknown[] | undefined) ?? []) {
          if (!action || typeof action !== "object" || Array.isArray(action)) continue;
          const actionCode = String((action as Record<string, unknown>).actionCode ?? "");
          if (!actionCode) continue;
          if (rowActionCodes.has(actionCode)) errors.push(`重复行操作: ${diff.targetCode}.${actionCode} 在 rowActions 中出现多次`);
          rowActionCodes.add(actionCode);
        }
      }
    }
    if (diff.sortOrder != null && diff.sortOrder < 0) errors.push(`sortOrder cannot be negative: ${diff.sortOrder}`);
    if (diff.targetType === "api_dsl" && diff.op === "add_filter") {
      const existingShape = await getExistingApiShape(diff.targetCode);
      errors.push(...findApiFieldConflictErrors(diff, existingShape));
      const apiTable = await resolveApiTable(diff.targetCode, schemaName, normalizedDiffs);
      const fieldKey = String(diff.fieldDef?.field ?? diff.fieldDef?.key ?? diff.field ?? "");
      if (apiTable && fieldKey && !(await physicalColumnExists(schemaName, apiTable, fieldKey)) && !physicalFieldAdds.has(`${apiTable}:${fieldKey}`)) {
        errors.push(`筛选字段必须是物理列: ${apiTable}.${fieldKey} 不存在；请补充 db_schema add_field，不要使用 ext_json 表达式`);
      }
    }
    if (diff.targetType === "api_dsl" && (diff.op === "add_allowed_field" || diff.op === "add_select_field")) {
      const existingShape = await getExistingApiShape(diff.targetCode);
      errors.push(...findApiFieldConflictErrors(diff, existingShape));
    }
    if ((diff.op === "add_column" || diff.op === "add_filter" || diff.op === "add_modal_field") && (diff.field || diff.fieldDef?.key)) {
      const fieldKey = String(diff.fieldDef?.key ?? diff.field);
      const dedupeKey = `${diff.targetType}:${diff.targetCode}:${diff.op}:${fieldKey}`;
      if (seenAddFields.has(dedupeKey)) errors.push(`重复添加字段: ${diff.targetCode}.${fieldKey}`);
      seenAddFields.add(dedupeKey);
      if (diff.targetType === "page_dsl") {
        const existingShape = await getExistingPageActions(diff.targetCode);
        errors.push(...findPageFieldConflictErrors(diff, existingShape));
      }
      if (diff.targetType === "page_dsl" && (diff.op === "add_column" || diff.op === "add_filter") && !queryReadableFields.has(`${diff.targetCode}:${fieldKey}`)) {
        errors.push(`列表查询回显缺失: ${diff.targetCode}.query 未返回字段 ${fieldKey}`);
      }
      if (diff.targetType === "page_dsl" && diff.op === "add_filter") {
        const apiTable = await resolveApiTable(`${diff.targetCode}.query`, schemaName, normalizedDiffs);
        if (apiTable && !(await physicalColumnExists(schemaName, apiTable, fieldKey)) && !physicalFieldAdds.has(`${apiTable}:${fieldKey}`)) {
          errors.push(`筛选字段必须是物理列: ${apiTable}.${fieldKey} 不存在；请补充 db_schema add_field，不要使用 ext_json 表达式`);
        }
      }
      if (diff.targetType === "page_dsl" && (diff.op === "add_column" || diff.op === "add_modal_field")) {
        if (!detailReadableFields.has(`${diff.targetCode}:${fieldKey}`)) {
          errors.push(`详情接口回显缺失: ${diff.targetCode}.detail 未包含字段 ${fieldKey}`);
        }
        for (const modalCode of await discoverPageModalCodes(diff.targetCode, schemaName)) {
          if (!modalDisplayFields.has(`${modalCode}:${fieldKey}`)) {
            errors.push(`详情/编辑弹窗回显缺失: ${modalCode} 未包含字段 ${fieldKey}`);
          }
        }
      }
    }
  }
  if (errors.length === 0) {
    errors.push(...await validateExecutedApiDsl(normalizedDiffs, schemaName));
  }
  return { valid: errors.length === 0, errors, normalizedDiffs };
}

async function validateExecutedApiDsl(diffs: DslDiff[], schemaName: string): Promise<string[]> {
  const errors: string[] = [];
  const pendingColumns = collectPendingColumns(diffs);
  try {
    const executed = await executeDiffs(diffs, schemaName);
    const latestByApi = new Map<string, unknown>();
    for (const item of executed) {
      if (item.diff.targetType === "api_dsl") latestByApi.set(item.diff.targetCode, item.modifiedDslJson);
    }
    for (const [apiCode, dsl] of latestByApi) {
      if (!dsl || typeof dsl !== "object" || Array.isArray(dsl)) continue;
      const problems = await validateApiDslAgainstSchema(schemaName, apiCode, dsl as Record<string, unknown>, pendingColumns);
      for (const problem of problems) {
        errors.push(`API DSL 字段校验失败: ${problem.apiCode}.${problem.field ?? ""} ${problem.problem}${problem.table ? ` (${problem.table})` : ""}`);
      }
    }
  } catch (err) {
    errors.push(`执行后 DSL 校验失败: ${err instanceof Error ? err.message : String(err)}`);
  }
  return errors;
}

function collectPendingColumns(diffs: DslDiff[]) {
  const result: Record<string, string[]> = {};
  for (const diff of diffs) {
    if (diff.targetType !== "db_schema" || !diff.resourceDef) continue;
    const tableName = String(diff.resourceDef.tableName ?? diff.targetCode ?? "");
    const fields = Array.isArray(diff.resourceDef.fields) ? diff.resourceDef.fields as Array<Record<string, unknown>> : [];
    if (!tableName) continue;
    result[tableName] ??= [];
    for (const field of fields) {
      const key = String(field.key ?? "");
      if (key && !result[tableName].includes(key)) result[tableName].push(key);
    }
  }
  return result;
}

function normalizeDiffShape(diff: DslDiff): DslDiff {
  const next: DslDiff = { ...diff };
  if (next.op === "modify" && !next.modifiedDslJson && next.resourceDef) {
    next.modifiedDslJson = next.resourceDef;
    delete next.resourceDef;
  }
  if (OPS_REQUIRE_FIELD_DEF.has(next.op) && !next.fieldDef && next.resourceDef) {
    next.fieldDef = next.resourceDef;
    delete next.resourceDef;
  }
  if (next.targetType === "report_dsl" && next.op === "create_report" && next.resourceDef) {
    next.resourceDef = normalizeReportResourceDef(next.resourceDef);
  }
  if (next.targetType === "permission_policy" && next.op === "modify_permission" && next.resourceDef) {
    next.resourceDef = normalizePermissionResourceDef(next.resourceDef);
  }
  return next;
}

function normalizePermissionResourceDef(resourceDef: Record<string, unknown>): Record<string, unknown> {
  const next = { ...resourceDef };
  if (next.roleCode) next.roleCode = String(next.roleCode).toUpperCase();
  if (next.dataPermission && typeof next.dataPermission === "object" && !Array.isArray(next.dataPermission)) {
    const obj = next.dataPermission as Record<string, unknown>;
    next.dataPermission = obj.type ?? obj.value ?? obj.mode ?? "self_only";
  }
  if (Array.isArray(next.buttonPermission)) {
    next.buttonPermission = next.buttonPermission
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && !Array.isArray(item)) {
          const obj = item as Record<string, unknown>;
          if (obj.visible === false || obj.enabled === false) return "";
          return String(obj.actionCode ?? obj.code ?? obj.key ?? "");
        }
        return "";
      })
      .filter(Boolean);
  }
  if (next.fieldPermission && typeof next.fieldPermission === "object" && !Array.isArray(next.fieldPermission)) {
    const obj = next.fieldPermission as Record<string, unknown>;
    if (Array.isArray(obj.hiddenFields)) {
      const fieldPermission: Record<string, string> = {};
      for (const field of obj.hiddenFields) fieldPermission[String(field)] = "hidden";
      next.fieldPermission = fieldPermission;
    }
  }
  return next;
}

function normalizeReportResourceDef(resourceDef: Record<string, unknown>): Record<string, unknown> {
  const dimensions = Array.isArray(resourceDef.dimensions)
    ? resourceDef.dimensions.map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const obj = item as Record<string, unknown>;
        return String(obj.field ?? obj.key ?? obj.as ?? "");
      }
      return "";
    }).filter(Boolean)
    : [];
  const metrics = Array.isArray(resourceDef.metrics)
    ? resourceDef.metrics.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return item;
      const metric = { ...(item as Record<string, unknown>) };
      if (!metric.field && metric.sourceField) metric.field = metric.sourceField;
      if (!metric.type && metric.aggregate) metric.type = metric.aggregate;
      if (!metric.type && metric.aggregation) metric.type = metric.aggregation;
      if (!metric.type && metric.func) metric.type = String(metric.func).toLowerCase();
      if (!metric.as && metric.alias) metric.as = metric.alias;
      if (!metric.as && metric.label && metric.field) metric.as = String(metric.field);
      if (typeof metric.type === "string") metric.type = metric.type.toLowerCase();
      return metric;
    })
    : resourceDef.metrics;
  const filters = Array.isArray(resourceDef.filters)
    ? resourceDef.filters.map((item) => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object" || Array.isArray(item)) return item;
      const filter = { ...(item as Record<string, unknown>) };
      if (!filter.field && filter.key) filter.field = String(filter.key).replace(/_range$/, "");
      if (!filter.key && filter.field) filter.key = filter.type === "date_range" ? `${String(filter.field)}_range` : filter.field;
      if (!filter.op && filter.type === "date_range") filter.op = "between";
      return filter;
    })
    : resourceDef.filters;
  let sort = resourceDef.sort;
  if (Array.isArray(sort)) sort = sort[0];
  if (sort && typeof sort === "object") {
    const sortObj = { ...(sort as Record<string, unknown>) };
    if (!sortObj.direction && sortObj.order) sortObj.direction = String(sortObj.order).toLowerCase();
    sort = sortObj;
  } else if (typeof sort === "string") {
    sort = { field: sort, direction: "desc" };
  }
  return { ...resourceDef, dimensions, metrics, filters, sort };
}

export function findPageActionConflictErrors(diff: DslDiff, existingActions: ExistingPageActions): string[] {
  if (diff.targetType !== "page_dsl") return [];
  const actionCode = String(diff.fieldDef?.actionCode ?? "");
  if (!actionCode) return [];
  if (diff.op === "add_toolbar" && existingActions.toolbar.has(actionCode)) {
    return [`工具栏按钮已存在: ${diff.targetCode}.${actionCode}，请复用现有按钮或改为修改现有配置`];
  }
  if (diff.op === "add_row_action" && existingActions.rowActions.has(actionCode)) {
    return [`行操作已存在: ${diff.targetCode}.${actionCode}，请复用现有行操作或改为修改现有配置`];
  }
  return [];
}

export function findPageFieldConflictErrors(diff: DslDiff, existingActions: ExistingPageActions): string[] {
  if (diff.targetType !== "page_dsl") return [];
  const fieldKey = String(diff.fieldDef?.key ?? diff.fieldDef?.field ?? diff.field ?? "");
  if (!fieldKey) return [];
  if (diff.op === "add_column" && existingActions.columns.has(fieldKey)) {
    return [`列表列已存在: ${diff.targetCode}.${fieldKey}，请改为 change_column 或复用现有列`];
  }
  if (diff.op === "add_filter" && existingActions.filters.has(fieldKey)) {
    return [`筛选条件已存在: ${diff.targetCode}.${fieldKey}，请改为 change_column 或复用现有筛选`];
  }
  if (diff.op === "add_modal_field" && existingActions.modalFields.has(fieldKey)) {
    return [`表单字段已存在: ${diff.targetCode}.${fieldKey}，请改为 change_column 或复用现有字段`];
  }
  return [];
}

export function findApiFieldConflictErrors(diff: DslDiff, existingShape: ExistingApiShape): string[] {
  if (diff.targetType !== "api_dsl") return [];
  const field = String(diff.fieldDef?.field ?? diff.fieldDef?.key ?? diff.field ?? "");
  const alias = String(diff.fieldDef?.as ?? field);
  if (!field) return [];
  if (diff.op === "add_allowed_field" && existingShape.allowedFields.has(field)) {
    return [`API 字段已开放: ${diff.targetCode}.${field}，请复用现有 allowedFields`];
  }
  if (diff.op === "add_filter" && existingShape.filters.has(field)) {
    return [`API 筛选已存在: ${diff.targetCode}.${field}，请复用现有 filters`];
  }
  if (diff.op === "add_select_field" && (existingShape.selectFields.has(field) || existingShape.selectAliases.has(alias))) {
    return [`API 查询字段已存在: ${diff.targetCode}.${field}，请复用现有 select 字段`];
  }
  return [];
}

export function findModifiedPageDuplicateErrors(diff: DslDiff): string[] {
  if (diff.targetType !== "page_dsl" || diff.op !== "modify") return [];
  if (!diff.modifiedDslJson || typeof diff.modifiedDslJson !== "object" || Array.isArray(diff.modifiedDslJson)) return [];
  const dsl = diff.modifiedDslJson as Record<string, unknown>;
  const errors: string[] = [];
  pushDuplicateFieldErrors(errors, diff.targetCode, "filters", dsl.filters);
  const table = dsl.table;
  if (table && typeof table === "object" && !Array.isArray(table)) {
    pushDuplicateFieldErrors(errors, diff.targetCode, "table.columns", (table as Record<string, unknown>).columns);
  }
  const modal = dsl.modal;
  if (modal && typeof modal === "object" && !Array.isArray(modal)) {
    pushDuplicateFieldErrors(errors, diff.targetCode, "modal.fields", (modal as Record<string, unknown>).fields);
  }
  return errors;
}

export function findModifiedApiDuplicateErrors(diff: DslDiff): string[] {
  if (diff.targetType !== "api_dsl" || diff.op !== "modify") return [];
  if (!diff.modifiedDslJson || typeof diff.modifiedDslJson !== "object" || Array.isArray(diff.modifiedDslJson)) return [];
  const dsl = diff.modifiedDslJson as Record<string, unknown>;
  const errors: string[] = [];
  pushDuplicateFieldErrors(errors, diff.targetCode, "allowedFields", dsl.allowedFields);
  pushDuplicateFieldErrors(errors, diff.targetCode, "filters", dsl.filters);
  pushDuplicateFieldErrors(errors, diff.targetCode, "where", dsl.where);
  pushDuplicateFieldErrors(errors, diff.targetCode, "fixedFilters", dsl.fixedFilters);
  pushDuplicateSelectErrors(errors, diff.targetCode, dsl.select);
  return errors;
}

async function loadExistingPageActions(schemaName: string, pageCode: string): Promise<ExistingPageActions> {
  const result: ExistingPageActions = {
    toolbar: new Set<string>(),
    rowActions: new Set<string>(),
    columns: new Set<string>(),
    filters: new Set<string>(),
    modalFields: new Set<string>(),
  };
  const { rows } = await pool.query(
    `select dsl_json from admin.page_dsl
     where page_code = $1 and status = 'active' and deleted = false
       and ((schema_scope = 'tenant' and schema_name = $2) or schema_scope = 'tenant_default')
     order by case when schema_scope = 'tenant' then 0 else 1 end limit 1`,
    [pageCode, schemaName]
  );
  const dsl = rows[0]?.dsl_json;
  if (!dsl || typeof dsl !== "object" || Array.isArray(dsl)) return result;
  const obj = dsl as Record<string, unknown>;
  for (const action of (obj.toolbar as unknown[] | undefined) ?? []) {
    const actionCode = actionCodeOf(action);
    if (actionCode) result.toolbar.add(actionCode);
  }
  for (const filter of (obj.filters as unknown[] | undefined) ?? []) {
    const key = fieldKeyOf(filter);
    if (key) result.filters.add(key);
  }
  const table = obj.table;
  if (table && typeof table === "object" && !Array.isArray(table)) {
    for (const column of ((table as Record<string, unknown>).columns as unknown[] | undefined) ?? []) {
      const key = fieldKeyOf(column);
      if (key) result.columns.add(key);
    }
    for (const action of ((table as Record<string, unknown>).rowActions as unknown[] | undefined) ?? []) {
      const actionCode = actionCodeOf(action);
      if (actionCode) result.rowActions.add(actionCode);
    }
  }
  const modal = obj.modal;
  if (modal && typeof modal === "object" && !Array.isArray(modal)) {
    for (const field of ((modal as Record<string, unknown>).fields as unknown[] | undefined) ?? []) {
      const key = fieldKeyOf(field);
      if (key) result.modalFields.add(key);
    }
  }
  await collectExistingActionModalFields(schemaName, pageCode, result.modalFields);
  return result;
}

async function collectExistingActionModalFields(schemaName: string, pageCode: string, modalFields: Set<string>) {
  const { rows: actionRows } = await pool.query(
    `SELECT dsl_json FROM admin.action_dsl
     WHERE page_code = $1
       AND action_type = 'open_modal'
       AND status = 'active' AND deleted = false
       AND ((schema_scope = 'tenant' AND schema_name = $2) OR schema_scope = 'tenant_default')
     ORDER BY CASE WHEN schema_scope = 'tenant' THEN 0 ELSE 1 END`,
    [pageCode, schemaName]
  );
  const modalCodes = new Set<string>();
  for (const row of actionRows) {
    const dsl = row.dsl_json as Record<string, unknown> | undefined;
    const modalCode = String(dsl?.modalCode ?? "");
    if (modalCode) modalCodes.add(modalCode);
  }
  if (modalCodes.size === 0) return;

  const { rows: modalRows } = await pool.query(
    `SELECT dsl_json FROM admin.action_dsl
     WHERE action_code = ANY($1)
       AND status = 'active' AND deleted = false
       AND ((schema_scope = 'tenant' AND schema_name = $2) OR schema_scope = 'tenant_default')
     ORDER BY CASE WHEN schema_scope = 'tenant' THEN 0 ELSE 1 END`,
    [[...modalCodes], schemaName]
  );
  for (const row of modalRows) {
    collectFieldKeys(row.dsl_json, modalFields);
  }
}

function collectFieldKeys(dsl: unknown, target: Set<string>) {
  if (!dsl || typeof dsl !== "object" || Array.isArray(dsl)) return;
  const obj = dsl as Record<string, unknown>;
  for (const field of (obj.fields as unknown[] | undefined) ?? []) {
    const key = fieldKeyOf(field);
    if (key) target.add(key);
  }
  const modal = obj.modal;
  if (!modal || typeof modal !== "object" || Array.isArray(modal)) return;
  for (const field of ((modal as Record<string, unknown>).fields as unknown[] | undefined) ?? []) {
    const key = fieldKeyOf(field);
    if (key) target.add(key);
  }
}

async function loadExistingApiShape(schemaName: string, apiCode: string): Promise<ExistingApiShape> {
  const result: ExistingApiShape = {
    allowedFields: new Set<string>(),
    selectFields: new Set<string>(),
    selectAliases: new Set<string>(),
    filters: new Set<string>(),
  };
  const { rows } = await pool.query(
    `select dsl_json from admin.api_dsl
     where api_code = $1 and status = 'active' and deleted = false
       and ((schema_scope = 'tenant' and schema_name = $2) or schema_scope = 'tenant_default')
     order by case when schema_scope = 'tenant' then 0 else 1 end limit 1`,
    [apiCode, schemaName]
  );
  const dsl = rows[0]?.dsl_json;
  if (!dsl || typeof dsl !== "object" || Array.isArray(dsl)) return result;
  const obj = dsl as Record<string, unknown>;
  for (const field of (obj.allowedFields as unknown[] | undefined) ?? []) {
    const key = fieldKeyOf(field);
    if (key) result.allowedFields.add(key);
  }
  for (const filter of (obj.filters as unknown[] | undefined) ?? []) {
    const key = fieldKeyOf(filter);
    if (key) result.filters.add(key);
  }
  for (const item of (obj.select as unknown[] | undefined) ?? []) {
    const key = fieldKeyOf(item);
    if (key) result.selectFields.add(key);
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const alias = String((item as Record<string, unknown>).as ?? "");
      if (alias) result.selectAliases.add(alias);
    }
  }
  return result;
}

function actionCodeOf(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  return String((value as Record<string, unknown>).actionCode ?? "");
}

function fieldKeyOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const obj = value as Record<string, unknown>;
  return String(obj.key ?? obj.field ?? "");
}

function pushDuplicateFieldErrors(errors: string[], targetCode: string, section: string, value: unknown) {
  if (!Array.isArray(value)) return;
  const seen = new Set<string>();
  for (const item of value) {
    const key = fieldKeyOf(item);
    if (!key) continue;
    if (seen.has(key)) {
      errors.push(`重复字段配置: ${targetCode} ${section}.${key} 出现多次，请合并为一项`);
    }
    seen.add(key);
  }
}

function pushDuplicateSelectErrors(errors: string[], targetCode: string, value: unknown) {
  if (!Array.isArray(value)) return;
  const seenFields = new Set<string>();
  const seenAliases = new Set<string>();
  for (const item of value) {
    const field = fieldKeyOf(item);
    if (field) {
      if (seenFields.has(field)) {
        errors.push(`重复查询字段: ${targetCode} select.${field} 出现多次，请合并为一项`);
      }
      seenFields.add(field);
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const alias = String((item as Record<string, unknown>).as ?? "");
    if (!alias) continue;
    if (seenAliases.has(alias)) {
      errors.push(`重复查询别名: ${targetCode} select.${alias} 出现多次，请合并为一项`);
    }
    seenAliases.add(alias);
  }
}

function collectPhysicalFieldAdds(diffs: DslDiff[]) {
  const result = new Set<string>();
  for (const diff of diffs) {
    if (diff.targetType !== "db_schema" || !diff.resourceDef) continue;
    const tableName = String(diff.resourceDef.tableName ?? diff.targetCode ?? "");
    const fields = Array.isArray(diff.resourceDef.fields) ? diff.resourceDef.fields as Array<Record<string, unknown>> : [];
    for (const field of fields) {
      const key = String(field.key ?? "");
      if (tableName && key) result.add(`${tableName}:${key}`);
    }
  }
  return result;
}

function validateModifiedApiDsl(errors: string[], diff: DslDiff) {
  if (diff.targetType !== "api_dsl" || diff.op !== "modify") return;
  const dsl = diff.modifiedDslJson;
  if (!dsl || typeof dsl !== "object" || Array.isArray(dsl)) return;
  const obj = dsl as Record<string, unknown>;
  const check = (value: unknown, label: string) => {
    if (!value) return;
    if (!FIELD_RE.test(String(value))) errors.push(`invalid API DSL ${label}: ${value}`);
  };
  for (const field of (obj.allowedFields as unknown[] | undefined) ?? []) check(field, "allowedField");
  for (const field of (obj.filters as unknown[] | undefined) ?? []) check(fieldKeyOf(field), "filter");
  for (const item of (obj.select as Array<Record<string, unknown>> | undefined) ?? []) {
    check(item.field, "select.field");
    if (item.as) check(item.as, "select.as");
  }
  for (const item of (obj.where as Array<Record<string, unknown>> | undefined) ?? []) check(item.field, "where.field");
  for (const item of (obj.fixedFilters as Array<Record<string, unknown>> | undefined) ?? []) check(item.field, "fixedFilters.field");
  for (const join of (obj.joins as Array<Record<string, unknown>> | undefined) ?? []) {
    check(join.alias, "join.alias");
    const on = join.on as Record<string, unknown> | undefined;
    check(on?.left, "join.on.left");
    check(on?.right, "join.on.right");
    for (const field of (join.fields as Array<Record<string, unknown>> | undefined) ?? []) {
      check(field.source, "join.fields.source");
      check(field.as, "join.fields.as");
    }
  }
}

function validateForeignKeyFieldDef(errors: string[], diff: DslDiff) {
  const checkField = (field: unknown, source: string) => {
    if (!field || typeof field !== "object" || Array.isArray(field)) return;
    const obj = field as Record<string, unknown>;
    const key = String(obj.key ?? obj.field ?? "");
    const meta = inferForeignKeyMeta(key);
    if (!meta) return;
    if (!obj.optionSource) {
      errors.push(`${source} 外键字段 ${key} 缺少 optionSource，列表/详情应显示名称，编辑应使用下拉选择`);
    }
    if (!obj.displayKey && (diff.targetType === "page_dsl" || diff.targetType === "action_dsl")) {
      errors.push(`${source} 外键字段 ${key} 缺少 displayKey: ${meta.displayKey}`);
    }
  };

  if ((diff.op === "add_column" || diff.op === "add_filter" || diff.op === "add_modal_field") && diff.fieldDef) {
    checkField(diff.fieldDef, `${diff.targetCode} ${diff.op}`);
  }
  if (diff.op === "modify" && diff.modifiedDslJson && typeof diff.modifiedDslJson === "object" && !Array.isArray(diff.modifiedDslJson)) {
    const obj = diff.modifiedDslJson as Record<string, unknown>;
    const table = obj.table as Record<string, unknown> | undefined;
    const modal = obj.modal as Record<string, unknown> | undefined;
    for (const field of (obj.filters as unknown[] | undefined) ?? []) checkField(field, `${diff.targetCode} filters`);
    for (const field of (table?.columns as unknown[] | undefined) ?? []) checkField(field, `${diff.targetCode} table.columns`);
    for (const field of (modal?.fields as unknown[] | undefined) ?? []) checkField(field, `${diff.targetCode} modal.fields`);
    for (const field of (obj.fields as unknown[] | undefined) ?? []) checkField(field, `${diff.targetCode} fields`);
  }
}

function validateImportToolbarAction(errors: string[], action: unknown, source: string) {
  if (!action || typeof action !== "object" || Array.isArray(action)) return;
  const obj = action as Record<string, unknown>;
  const actionCode = String(obj.actionCode ?? "");
  const type = String(obj.type ?? obj.actionType ?? "");
  const importConfig = obj.importConfig as Record<string, unknown> | undefined;
  const looksImport =
    actionCode.endsWith(".import") ||
    type === "import" ||
    Boolean(importConfig);
  if (!looksImport) return;

  if (!actionCode) errors.push(`${source} 导入按钮缺少 actionCode`);
  if (type !== "import") {
    errors.push(`${source} 导入按钮必须设置 type 或 actionType 为 import，不能使用 execute_api/query/refresh`);
  }
  if (!importConfig || typeof importConfig !== "object" || Array.isArray(importConfig)) {
    errors.push(`${source} 导入按钮缺少 importConfig`);
    return;
  }
  const apiCode = String(importConfig.apiCode ?? "");
  if (!apiCode) errors.push(`${source} 导入按钮 importConfig.apiCode 缺失，请指向新增接口如 ${actionCode.replace(/\.import$/, ".create")}`);
  if (/\.query$/.test(apiCode)) {
    errors.push(`${source} 导入按钮 importConfig.apiCode 不能是查询接口，请使用 create API`);
  }
}

function validateExportToolbarAction(errors: string[], action: unknown, source: string) {
  if (!action || typeof action !== "object" || Array.isArray(action)) return;
  const obj = action as Record<string, unknown>;
  const actionCode = String(obj.actionCode ?? "");
  const type = String(obj.type ?? obj.actionType ?? "");
  const apiCode = String(obj.apiCode ?? "");
  const looksExport =
    actionCode.endsWith(".export") ||
    type === "export" ||
    Boolean(obj.exportConfig);
  if (!looksExport) return;

  if (!actionCode) errors.push(`${source} 导出按钮缺少 actionCode`);
  if (type !== "export") {
    errors.push(`${source} 导出按钮必须设置 type 或 actionType 为 export，不能使用 execute_api/import`);
  }
  if (!apiCode) {
    errors.push(`${source} 导出按钮缺少 apiCode，请指向当前页面 query API`);
  } else if (!/\.query$/.test(apiCode)) {
    errors.push(`${source} 导出按钮 apiCode 必须指向 query API，当前为 ${apiCode}`);
  }
}

async function resolveApiTable(apiCode: string, schemaName: string, diffs: DslDiff[]) {
  const modified = diffs.find((diff) => diff.targetType === "api_dsl" && diff.targetCode === apiCode && diff.op === "modify" && diff.modifiedDslJson);
  if (modified?.modifiedDslJson && typeof modified.modifiedDslJson === "object" && !Array.isArray(modified.modifiedDslJson)) {
    const table = (modified.modifiedDslJson as Record<string, unknown>).table;
    if (typeof table === "string") return table;
  }
  const { rows } = await pool.query(
    `select dsl_json from admin.api_dsl
     where api_code = $1 and status = 'active' and deleted = false
       and ((schema_scope = 'tenant' and schema_name = $2) or schema_scope = 'tenant_default')
     order by case when schema_scope = 'tenant' then 0 else 1 end limit 1`,
    [apiCode, schemaName]
  );
  const dsl = rows[0]?.dsl_json as Record<string, unknown> | undefined;
  return typeof dsl?.table === "string" ? dsl.table : undefined;
}

async function physicalColumnExists(schemaName: string, tableName: string, fieldName: string) {
  if (!FIELD_RE.test(tableName) || !FIELD_RE.test(fieldName)) return false;
  const { rows } = await pool.query(
    `select 1 from information_schema.columns where table_schema = $1 and table_name = $2 and column_name = $3 limit 1`,
    [schemaName, tableName, fieldName]
  );
  return rows.length > 0;
}

async function loadPhysicalColumns(schemaName: string, tableName: string) {
  if (!FIELD_RE.test(tableName)) return [];
  const { rows } = await pool.query(
    `select column_name from information_schema.columns where table_schema = $1 and table_name = $2 order by ordinal_position limit 30`,
    [schemaName, tableName]
  );
  return rows.map((row) => String(row.column_name));
}

async function normalizeRelatedDiffs(diffs: DslDiff[], schemaName: string): Promise<DslDiff[]> {
  const expanded: DslDiff[] = [...diffs];
  const hasDiff = (targetType: DslDiff["targetType"], targetCode: string, op: DslDiff["op"], field?: string) =>
    expanded.some((diff) => diff.targetType === targetType && diff.targetCode === targetCode && diff.op === op && (!field || String(diff.fieldDef?.field ?? diff.fieldDef?.key ?? diff.field ?? "") === field));
  for (const diff of diffs) {
    if (diff.targetType !== "page_dsl") continue;
    const field = String(diff.fieldDef?.key ?? diff.field ?? "");
    if (!field) continue;
    if (diff.op === "add_column" || diff.op === "add_modal_field" || diff.op === "add_filter") {
      const queryTargetCode = `${diff.targetCode}.query`;
      if (!hasDiff("api_dsl", queryTargetCode, "add_allowed_field", field)) {
        expanded.push({ targetType: "api_dsl", targetCode: queryTargetCode, op: "add_allowed_field", field, fieldDef: { field } });
      }
      for (const suffix of ["detail", "create", "update"]) {
        const targetCode = `${diff.targetCode}.${suffix}`;
        if (!hasDiff("api_dsl", targetCode, "add_allowed_field", field)) {
          expanded.push({ targetType: "api_dsl", targetCode, op: "add_allowed_field", field, fieldDef: { field } });
        }
      }
    }
    if (diff.op === "add_column" || diff.op === "add_modal_field") {
      for (const modalCode of await discoverPageModalCodes(diff.targetCode, schemaName)) {
        if (!hasDiff("action_dsl", modalCode, "add_modal_field", field)) {
          expanded.push({
            targetType: "action_dsl",
            targetCode: modalCode,
            op: "add_modal_field",
            field,
            fieldDef: { ...(diff.fieldDef ?? {}), key: field },
          });
        }
      }
    }
  }
  return expanded;
}

async function discoverPageModalCodes(pageCode: string, schemaName: string): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT dsl_json FROM admin.action_dsl
     WHERE page_code = $1
       AND action_type = 'open_modal'
       AND status = 'active' AND deleted = false
       AND ((schema_scope = 'tenant' AND schema_name = $2) OR schema_scope = 'tenant_default')
     ORDER BY CASE WHEN schema_scope = 'tenant' THEN 0 ELSE 1 END`,
    [pageCode, schemaName]
  );
  const modalCodes = new Set<string>();
  for (const row of rows) {
    const dsl = row.dsl_json as Record<string, unknown> | undefined;
    const actionCode = String(dsl?.actionCode ?? "");
    if (!/\.(create|edit|detail)$/.test(actionCode)) continue;
    const modalCode = String(dsl?.modalCode ?? "");
    if (modalCode) modalCodes.add(modalCode);
  }
  return [...modalCodes];
}

function summarizeDiffs(diffs: DslDiff[]): string {
  const labels: Record<string, string> = {
    add_column: "新增列表字段",
    remove_column: "移除列表字段",
    reorder_columns: "调整字段顺序",
    change_column: "修改字段",
    add_filter: "新增筛选条件",
    remove_filter: "移除筛选条件",
    add_toolbar: "新增工具栏按钮",
    add_row_action: "新增行操作",
    add_modal_field: "新增表单字段",
    remove_modal_field: "移除表单字段",
    add_select_field: "新增查询字段",
    remove_select_field: "移除查询字段",
    add_join: "新增关联查询",
    add_where: "新增固定条件",
    add_sort: "新增排序",
    add_action: "新增操作",
    modify: "完整替换配置",
  };
  return diffs
    .map((diff) => `${diff.targetCode} ${labels[diff.op] ?? diff.op}${diff.field ? `「${diff.field}」` : ""}`)
    .join("；");
}

async function repair(
  originalDiffs: DslDiff[],
  errors: string[],
  intent: IntentResult,
  context: ContextResult,
  schemaName: string,
  originalPrompt: string,
): Promise<DslDiff[]> {
  const repairContext = buildRepairContext(originalDiffs, errors, intent, context);
  const repairPrompt = buildRepairUserPrompt(errors, originalPrompt, repairContext);

  try {
    const result = await callWithToolCalling({
      schemaName,
      messages: [
        {
          role: "system",
          content: [
            "你是一个 DSL 修正助手。请根据校验错误信息修正上一次的输出。",
            "字段不存在时，不要编造同义字段或切到无关表；必须只使用已提供的 SKILL.md 和数据库表结构中的真实表名、真实字段名。",
            "报表修正时先确定业务事实表，再从事实表选择 dimensions/metrics/filters；名称展示用 *_id 的 displayKey/外键展示能力，不要把 name 字段强行写入事实表。",
            "最后一条用户消息会包含 PROBLEMATIC_DIFFS、SKILL_MD_CONTEXT、TABLE_COLUMNS 和 DSL_SUMMARY；这些是本次修正的唯一可信上下文。",
          ].join("\n"),
        },
        { role: "assistant", content: JSON.stringify({ diffs: originalDiffs }) },
        { role: "user", content: repairPrompt },
      ],
      tools: [PLAN_CHANGES_TOOL],
    });

    if (result.type === "tool_call" && result.functionCall) {
      const diffs = parsePlanDiffsFromToolArguments(result.functionCall.arguments);
      if (diffs.length > 0) return diffs;
    }
  } catch {
    // repair failed, continue with current diffs
  }
  return originalDiffs;
}

export function buildRepairUserPrompt(
  errors: string[],
  originalPrompt: string,
  repairContext: string,
): string {
  return [
    REPAIR_PROMPT_TEMPLATE
      .replace("{errors}", errors.join("\n"))
      .replace("{originalPrompt}", originalPrompt),
    "## 本次修正上下文",
    "下面的 JSON 是本次修正的唯一可信上下文。必须基于 PROBLEMATIC_DIFFS、SKILL_MD_CONTEXT、TABLE_COLUMNS 和 DSL_SUMMARY 修正；不要沿用这些上下文之外的表字段猜测。",
    "```json",
    repairContext,
    "```",
  ].join("\n\n");
}

function buildRepairContext(
  problematicDiffs: DslDiff[],
  errors: string[],
  intent: IntentResult,
  context: ContextResult,
) {
  return JSON.stringify({
    VALIDATION_ERRORS: errors,
    INTENT: intent,
    PROBLEMATIC_DIFFS: problematicDiffs,
    SKILL_MD_CONTEXT: context.skillMdContent,
    TABLE_COLUMNS: context.tableColumns,
    DSL_SUMMARY: context.dslSummary,
    RELEVANT_DSL_CODES: context.relevantDslCodes,
    repairRules: [
      "report_dsl.sourceTable 必须是 TABLE_COLUMNS 中存在的表。",
      "report_dsl.dimensions、metrics.field、filters.field 必须是 sourceTable 的真实字段。",
      "页面显示姓名时，如果事实表只有 *_id，维度仍使用 *_id，名称展示交给 displayKey/外键能力。",
      "business_rule 必须包含合法 category/businessType；排课冲突必须含老师和学员；业绩规则必须用 performanceAllocation/productPriority 等业务枚举，不能用 ownerField/amountField。",
      "如果当前 SKILL_MD_CONTEXT/TABLE_COLUMNS 无法解释用户需求，返回空 diffs，让上层重新选择相关 skill；不要编造表字段。",
    ],
  }, null, 2);
}

function validateBusinessRuleResource(errors: string[], targetCode: string, resource: Record<string, unknown>) {
  const categories = new Set(["funds_allocation", "promotion_allocation", "performance_allocation", "approval_trigger", "validation", "workflow", "refund", "charge", "attendance"]);
  const businessTypes = new Set(["contract", "funds", "course", "course_cancel", "attendance", "charge", "charge_reverse", "refund", "contract_refund", "product_price", "performance"]);
  const category = String(resource.category ?? "");
  const businessType = String(resource.businessType ?? resource.business_type ?? "");
  if (resource.ruleCode && String(resource.ruleCode) !== targetCode) errors.push(`business_rule ${targetCode} targetCode 必须与 ruleCode 一致`);
  if (!categories.has(category)) errors.push(`business_rule ${targetCode} category 必须是教务规则分类枚举`);
  if (!businessTypes.has(businessType)) errors.push(`business_rule ${targetCode} businessType 必须是教务业务类型枚举`);

  if (category === "validation" && businessType === "course") {
    const validations = Array.isArray(resource.validations) ? resource.validations as Array<Record<string, unknown>> : [];
    const hasTeacherConflict = validations.some((item) => item.field === "teacher_id" && item.operator === "no_time_overlap");
    const hasStudentConflict = validations.some((item) => item.field === "student_id" && item.operator === "no_time_overlap");
    const hasTimeRange = validations.some((item) => item.field === "end_time" && item.valueField === "start_time");
    if (!hasTimeRange) errors.push(`business_rule ${targetCode} 排课规则必须校验结束时间晚于开始时间`);
    if (!hasTeacherConflict) errors.push(`business_rule ${targetCode} 排课规则必须包含老师时间冲突校验`);
    if (!hasStudentConflict) errors.push(`business_rule ${targetCode} 排课规则必须包含学员时间冲突校验`);
  }

  if (category === "performance_allocation") {
    const allowedAllocation = new Set(["byCpPaidRatio", "byCpReceivableRatio", "oneToOneFirst", "classCourseFirst", "salesOwnerOnly"]);
    const allowedPriority = new Set(["none", "oneToOneFirst", "classCourseFirst", "oneOnNFirst"]);
    if (!allowedAllocation.has(String(resource.performanceAllocation ?? ""))) errors.push(`business_rule ${targetCode} 业绩规则 performanceAllocation 不合法`);
    if (!allowedPriority.has(String(resource.productPriority ?? "none"))) errors.push(`business_rule ${targetCode} 业绩规则 productPriority 不合法`);
    if (resource.organizationPerformance || resource.personalPerformance) errors.push(`business_rule ${targetCode} 业绩规则不要使用 organizationPerformance/personalPerformance.ownerField/amountField，改用中文业务枚举字段`);
  }

  if (category === "funds_allocation") {
    const allowed = new Set(["byCpRemainingAmount", "byCpPaidRatio", "oldestContractFirst", "manual"]);
    if (!allowed.has(String(resource.fundsAllocation ?? ""))) errors.push(`business_rule ${targetCode} 资金规则 fundsAllocation 不合法`);
  }

  if (category === "promotion_allocation") {
    const allowed = new Set(["byCpAmountRatio", "byCpHourRatio", "oneToOneFirst", "classCourseFirst", "manual"]);
    if (!allowed.has(String(resource.promotionAllocation ?? ""))) errors.push(`business_rule ${targetCode} 优惠规则 promotionAllocation 不合法`);
  }
}
