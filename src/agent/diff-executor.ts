import { pool } from "../db/pool.js";
import { inferForeignKeyMeta } from "../common/foreign-key-meta.js";
import type { DslDiff, TargetType } from "./types.js";

const SYSTEM_FIELD_KEYS = new Set(["id", "created_at", "updated_at", "deleted", "deleted_at"]);

export async function executeDiffs(
  diffs: DslDiff[],
  schemaName: string,
): Promise<Array<{ diff: DslDiff; modifiedDslJson: unknown }>> {
  const expandedDiffs = await expandRelatedDiffs(diffs, schemaName);
  const results: Array<{ diff: DslDiff; modifiedDslJson: unknown }> = [];
  const grouped = groupByTarget(expandedDiffs);

  for (const [key, groupDiffs] of grouped) {
    const sepIdx = key.indexOf("::");
    const targetType = key.substring(0, sepIdx) as TargetType;
    const targetCode = key.substring(sepIdx + 2);

    const existingDsl = await loadExistingDsl(targetType, targetCode, schemaName);
    let currentDsl: unknown = existingDsl
      ? JSON.parse(JSON.stringify(existingDsl))
      : {};

    for (const diff of groupDiffs) {
      currentDsl = applyOp(currentDsl, diff);
      results.push({ diff, modifiedDslJson: currentDsl });
    }
  }

  return results;
}

async function expandRelatedDiffs(diffs: DslDiff[], schemaName: string): Promise<DslDiff[]> {
  const expanded: DslDiff[] = [...diffs];
  const hasDiff = (targetType: DslDiff["targetType"], targetCode: string, op: DslDiff["op"], field?: string) =>
    expanded.some((diff) => diff.targetType === targetType && diff.targetCode === targetCode && diff.op === op && (!field || String(diff.fieldDef?.field ?? diff.fieldDef?.key ?? diff.field ?? "") === field));
  const hasTarget = (targetType: DslDiff["targetType"], targetCode: string) =>
    expanded.some((diff) => diff.targetType === targetType && diff.targetCode === targetCode);

  for (const diff of diffs) {
    if (diff.targetType === "db_schema" && diff.op === "create_table") {
      expanded.push(...buildCreateTableCompanionDiffs(diff, hasTarget));
    }
    if (diff.targetType === "import_dsl" && diff.op === "create_import") {
      expanded.push(...buildImportCompanionDiffs(diff, expanded));
    }
    if (diff.targetType === "report_dsl" && diff.op === "create_report") {
      expanded.push(...buildReportCompanionDiffs(diff, hasTarget));
    }
  }

  for (const diff of diffs) {
    if (diff.targetType !== "page_dsl") continue;
    const field = String(diff.fieldDef?.key ?? diff.field ?? "");
    if (!field) continue;

    if (diff.op === "add_filter" && !hasDiff("api_dsl", `${diff.targetCode}.query`, "add_filter", field)) {
      expanded.push({
        targetType: "api_dsl",
        targetCode: `${diff.targetCode}.query`,
        op: "add_filter",
        field,
        fieldDef: { field },
      });
    }

    if ((diff.op === "add_column" || diff.op === "add_filter") && !hasDiff("api_dsl", `${diff.targetCode}.query`, "add_allowed_field", field)) {
      expanded.push({
        targetType: "api_dsl",
        targetCode: `${diff.targetCode}.query`,
        op: "add_allowed_field",
        field,
        fieldDef: { field },
      });
    }

    if (diff.op === "add_column" || diff.op === "add_modal_field" || diff.op === "add_filter") {
      for (const suffix of ["detail", "create", "update"]) {
        const targetCode = `${diff.targetCode}.${suffix}`;
        if (!hasDiff("api_dsl", targetCode, "add_allowed_field", field)) {
          expanded.push({
            targetType: "api_dsl",
            targetCode,
            op: "add_allowed_field",
            field,
            fieldDef: { field },
          });
        }
      }
    }

    if (diff.op === "add_column" || diff.op === "add_modal_field") {
      const modalCodes = await discoverPageModalCodes(diff.targetCode, schemaName);
      for (const modalCode of modalCodes) {
        if (!hasDiff("action_dsl", modalCode, "add_modal_field", field)) {
          expanded.push({
            targetType: "action_dsl",
            targetCode: modalCode,
            op: "add_modal_field",
            field,
            fieldDef: normalizeModalField(diff.fieldDef, field),
          });
        }
      }
    }
  }

  return expanded;
}

function fieldDefsFromResource(diff: DslDiff) {
  const fields = Array.isArray(diff.resourceDef?.fields) ? diff.resourceDef.fields as Array<Record<string, unknown>> : [];
  return fields.map((field) => ({
    key: String(field.key ?? field.name ?? ""),
    label: String(field.label ?? field.name ?? field.key ?? ""),
    type: normalizeDslFieldType(String(field.key ?? field.name ?? ""), String(field.label ?? field.name ?? field.key ?? ""), String(field.type ?? "text")),
    required: Boolean(field.required),
  })).filter((field) => field.key && !SYSTEM_FIELD_KEYS.has(field.key));
}

function normalizeDslFieldType(key: string, label: string, rawType: string) {
  const text = `${key} ${label}`.toLowerCase();
  const normalized = rawType.toLowerCase();
  if (/(phone|mobile|tel|手机号|电话|联系电话)/.test(text)) return "text";
  if (/(birthday|birth_date|生日)/.test(text)) return "date";
  if (/(datetime|timestamp|time|时间)/.test(text)) return "datetime";
  if (/(date|日期)/.test(text)) return "date";
  if (/(amount|fee|price|balance|tuition|payment|refund|arrears|金额|费用|学费|余额|欠费|收款|退款|count|hours|课时|次数|数量)/.test(text)) return "number";
  if (/^(varchar|char|string|bigint|int|integer|uuid)$/.test(normalized) || normalized.startsWith("varchar")) return "text";
  if (normalized === "textarea" || normalized === "select" || normalized === "boolean") return normalized;
  return rawType || "text";
}

function pageFieldFromResource(field: ReturnType<typeof fieldDefsFromResource>[number], extra: Record<string, unknown> = {}) {
  const meta = inferForeignKeyMeta(field.key);
  const base: Record<string, unknown> = {
    key: field.key,
    label: field.label,
    type: meta ? "select" : field.type,
    ...extra,
  };
  if (!meta) return base;
  return {
    ...base,
    displayKey: meta.displayKey,
    optionSource: {
      pageCode: meta.pageCode,
      apiCode: meta.apiCode,
      valueField: meta.valueField,
      labelField: meta.labelField,
    },
  };
}

function buildCreateTableCompanionDiffs(
  diff: DslDiff,
  hasTarget: (targetType: DslDiff["targetType"], targetCode: string) => boolean,
): DslDiff[] {
  const def = diff.resourceDef ?? {};
  const tableName = String(def.tableName ?? diff.targetCode);
  const pageCode = String(def.pageCode ?? `${tableName}_list`);
  const featureCode = String(def.featureCode ?? pageCode);
  const moduleCode = String(def.moduleCode ?? "custom");
  const title = String(def.pageTitle ?? def.tableLabel ?? def.label ?? tableName);
  const fields = fieldDefsFromResource(diff);
  const columns = fields.map((field) => ({
    ...pageFieldFromResource(field),
    title: field.label,
    width: field.type === "textarea" ? 220 : 140,
  }));
  const modalFields = fields.map((field) => ({
    ...pageFieldFromResource(field),
    required: field.required,
  }));
  const allowedFields = fields.map((field) => field.key);
  const additions: DslDiff[] = [];

  if (!hasTarget("page_dsl", pageCode)) {
    additions.push({
      targetType: "page_dsl",
      targetCode: pageCode,
      op: "modify",
      modifiedDslJson: {
        pageCode,
        title,
        moduleCode,
        featureCode,
        layout: "list",
        dataApi: `${pageCode}.query`,
        createApi: `${pageCode}.create`,
        updateApi: `${pageCode}.update`,
        deleteApi: `${pageCode}.delete`,
        filters: [],
        toolbar: [
          { actionCode: `${pageCode}.create`, label: `新增${title}`, type: "open_modal", variant: "primary" },
        ],
        table: {
          columns: [{ key: "id", title: "ID", width: 100, hidden: true }, ...columns],
          rowActions: [
            { actionCode: `${pageCode}.detail`, label: "详情", type: "open_modal" },
            { actionCode: `${pageCode}.edit`, label: "编辑", type: "open_modal" },
            { actionCode: `${pageCode}.delete`, label: "删除", type: "execute_api", confirm: "确认删除？" },
          ],
        },
        modal: { fields: modalFields },
      },
    });
  }

  const apiDefs: Array<[string, string, Record<string, unknown>]> = [
    ["query", "query", { table: tableName, operation: "query", allowedFields, filters: [] }],
    ["detail", "detail", { table: tableName, operation: "detail", allowedFields }],
    ["create", "create", { table: tableName, operation: "create", allowedFields }],
    ["update", "update", { table: tableName, operation: "update", allowedFields }],
    ["delete", "delete", { table: tableName, operation: "delete", allowedFields: [] }],
  ];
  for (const [suffix, apiType, dsl] of apiDefs) {
    const apiCode = `${pageCode}.${suffix}`;
    if (!hasTarget("api_dsl", apiCode)) {
      additions.push({
        targetType: "api_dsl",
        targetCode: apiCode,
        op: "modify",
        modifiedDslJson: { apiCode, apiType, moduleCode, featureCode, ...dsl },
      });
    }
  }

  const actionDefs: Array<[string, string, Record<string, unknown>]> = [
    ["create", `新增${title}`, { actionType: "open_modal", type: "open_modal", apiCode: `${pageCode}.create`, fields: modalFields }],
    ["edit", `编辑${title}`, { actionType: "open_modal", type: "open_modal", apiCode: `${pageCode}.update`, fields: modalFields }],
    ["detail", `${title}详情`, { actionType: "open_modal", type: "open_modal", fields: modalFields }],
    ["delete", "删除", { actionType: "execute_api", type: "execute_api", apiCode: `${pageCode}.delete`, confirm: "确认删除？" }],
  ];
  for (const [suffix, label, actionDsl] of actionDefs) {
    const actionCode = `${pageCode}.${suffix}`;
    if (!hasTarget("action_dsl", actionCode)) {
      additions.push({
        targetType: "action_dsl",
        targetCode: actionCode,
        op: "modify",
        modifiedDslJson: { actionCode, actionName: label, label, pageCode, moduleCode, featureCode, ...actionDsl },
      });
    }
  }

  if (!hasTarget("feature_registry", featureCode)) {
    additions.push({
      targetType: "feature_registry",
      targetCode: featureCode,
      op: "create_feature",
      resourceDef: { moduleCode, featureCode, featureName: title, pageCode, description: `AI 定制新增：${title}` },
    });
  }

  if (!hasTarget("skill_registry", `skill_${featureCode}`)) {
    additions.push({
      targetType: "skill_registry",
      targetCode: `skill_${featureCode}`,
      op: "modify",
      modifiedDslJson: `# ${title}\n\n## 功能描述\nAI 定制新增功能。\n\n## 数据表\n- 表: ${tableName}\n\n## 字段\n${fields.map((field) => `- ${field.label} (${field.key})`).join("\n")}`,
    });
  }

  return additions;
}

function buildImportCompanionDiffs(
  diff: DslDiff,
  existingDiffs: DslDiff[],
): DslDiff[] {
  const def = diff.resourceDef ?? {};
  const pageCode = String(def.pageCode ?? "");
  if (!pageCode) return [];
  const actionCode = `${pageCode}.import`;
  const alreadyHasImportToolbar = existingDiffs.some((item) => {
    if (item.targetType !== "page_dsl" || item.targetCode !== pageCode) return false;
    if (item.op === "add_toolbar") {
      return String(item.fieldDef?.actionCode ?? "") === actionCode;
    }
    if (item.op === "modify" && item.modifiedDslJson && typeof item.modifiedDslJson === "object" && !Array.isArray(item.modifiedDslJson)) {
      const toolbar = (item.modifiedDslJson as Record<string, unknown>).toolbar;
      return Array.isArray(toolbar) && toolbar.some((action) => {
        if (!action || typeof action !== "object" || Array.isArray(action)) return false;
        return String((action as Record<string, unknown>).actionCode ?? "") === actionCode;
      });
    }
    return false;
  });
  if (alreadyHasImportToolbar) return [];
  return [{
    targetType: "page_dsl",
    targetCode: pageCode,
    op: "add_toolbar",
    fieldDef: {
      actionCode: `${pageCode}.import`,
      label: "导入",
      type: "import",
      variant: "default",
      importConfig: {
        importCode: diff.targetCode,
        apiCode: def.apiCode ?? `${pageCode}.create`,
      },
    },
  }];
}

function buildReportCompanionDiffs(
  diff: DslDiff,
  hasTarget: (targetType: DslDiff["targetType"], targetCode: string) => boolean,
): DslDiff[] {
  const def = diff.resourceDef ?? {};
  const pageCode = String(def.pageCode ?? diff.targetCode);
  const featureCode = String(def.featureCode ?? pageCode);
  const moduleCode = String(def.moduleCode ?? "report");
  const title = String(def.title ?? def.reportName ?? pageCode);
  const sourceTable = String(def.sourceTable ?? "");
  const dimensions = Array.isArray(def.dimensions) ? def.dimensions as string[] : [];
  const metrics = Array.isArray(def.metrics) ? def.metrics as Array<Record<string, unknown>> : [];
  const filters = reportFilters(sourceTable, def.filters);
  const rankEnabled = def.rank === true || def.ranking === true || String(def.title ?? "").includes("排行") || String(def.title ?? "").includes("排名");
  const primaryMetricAlias = String(metrics[0]?.as ?? metrics[0]?.field ?? metrics[0]?.type ?? "");
  const columns = [
    ...(rankEnabled ? [{ key: "rank", title: "排名", label: "排名", type: "number", width: 80 }] : []),
    ...dimensions.map((field) => ({
      key: field,
      title: reportFieldLabel(sourceTable, field),
      label: reportFieldLabel(sourceTable, field),
      type: "text",
      width: 140,
      displayKey: reportDisplayKey(field),
    })),
    ...metrics.map((metric) => {
      const field = String(metric.field ?? "");
      const alias = String(metric.as ?? metric.field ?? metric.type ?? "metric");
      const label = reportMetricLabel(sourceTable, field, metric);
      return { key: alias, title: label, label, type: "number", width: 140 };
    }),
  ];
  const additions: DslDiff[] = [];
  if (sourceTable && !hasTarget("api_dsl", `${pageCode}.query`)) {
    additions.push({
      targetType: "api_dsl",
      targetCode: `${pageCode}.query`,
      op: "modify",
      modifiedDslJson: {
        apiCode: `${pageCode}.query`,
        apiType: "query",
        moduleCode,
        featureCode,
        table: sourceTable,
        operation: "query",
        allowedFields: [
          ...new Set([
            ...dimensions,
            ...metrics.map((metric) => String(metric.field ?? "")).filter(Boolean),
            ...metrics.map((metric) => String(metric.as ?? "")).filter(Boolean),
          ]),
        ],
        groupBy: dimensions,
        metrics: metrics.map((metric) => ({
          field: metric.field,
          type: metric.type ?? metric.aggregate ?? "count",
          as: metric.as ?? metric.field ?? metric.type,
        })),
        rank: rankEnabled,
        sort: primaryMetricAlias ? { field: primaryMetricAlias, direction: "desc" } : undefined,
        filters: filters.map((filter) => ({
          field: filter.field,
          key: filter.key,
          param: filter.key,
          type: filter.type,
          op: filter.op,
        })),
      },
    });
  }
  if (!hasTarget("page_dsl", pageCode)) {
    additions.push({
      targetType: "page_dsl",
      targetCode: pageCode,
      op: "modify",
      modifiedDslJson: {
        pageCode,
        title,
        moduleCode,
        featureCode,
        layout: "list",
        dataApi: `${pageCode}.query`,
        filters: filters.map((filter) => ({
          key: filter.key,
          field: filter.field,
          label: filter.label,
          type: filter.type,
          placeholder: filter.placeholder,
        })),
        toolbar: [],
        table: { columns: columns.length ? columns : [{ key: "id", title: "ID", width: 100 }], rowActions: [] },
        modal: { fields: [] },
        presentation: {
          header: {
            subtitle: "AI 定制报表",
            metrics: metrics.slice(0, 3).map((metric) => ({
              label: reportMetricLabel(sourceTable, String(metric.field ?? ""), metric),
              source: metric.type === "sum" ? "sum" : "total",
              field: metric.as ?? metric.field,
            })),
          },
        },
      },
    });
  }
  if (!hasTarget("feature_registry", featureCode)) {
    additions.push({
      targetType: "feature_registry",
      targetCode: featureCode,
      op: "create_feature",
      resourceDef: { moduleCode, featureCode, featureName: title, pageCode, description: `AI 定制报表：${title}` },
    });
  }
  return additions;
}

function reportFilters(sourceTable: string, rawFilters: unknown) {
  const explicit = Array.isArray(rawFilters) ? rawFilters.map(normalizeReportFilter).filter((item) => item.field && item.key) : [];
  if (explicit.length > 0) return explicit;
  const timeField = defaultReportTimeField(sourceTable);
  if (!timeField) return [];
  return [{
    field: timeField,
    key: `${timeField}_range`,
    label: "时间范围",
    type: "date_range",
    op: "between" as const,
    placeholder: "请选择时间范围",
  }];
}

function normalizeReportFilter(value: unknown) {
  if (typeof value === "string") {
    const isTime = value.includes("time") || value.includes("date") || value.endsWith("_at");
    return {
      field: value,
      key: isTime ? `${value}_range` : value,
      label: isTime ? "时间范围" : reportFieldLabel("", value),
      type: isTime ? "date_range" : "text",
      op: (isTime ? "between" : "ilike") as "between" | "ilike",
      placeholder: isTime ? "请选择时间范围" : undefined,
    };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { field: "", key: "", label: "", type: "text", op: "ilike" as const, placeholder: undefined };
  }
  const obj = value as Record<string, unknown>;
  const rawKey = obj.key ?? obj.param;
  const rawField = obj.field ?? obj.sourceField ?? obj.column;
  const field = String(rawField ?? rawKey ?? "").replace(/_range$/, "").replace(/_filter$/, "");
  const type = String(obj.type ?? (field.includes("time") || field.includes("date") || field.endsWith("_at") ? "date_range" : "text"));
  const key = rawKey ? String(rawKey) : type === "date_range" ? `${field}_range` : field;
  return {
    field,
    key: key === "time_range" || key === "date_range" ? `${field}_range` : key,
    label: String(obj.label ?? (type === "date_range" ? "时间范围" : reportFieldLabel("", field))),
    type,
    op: String(obj.op ?? (type === "date_range" ? "between" : "ilike")) as "between" | "ilike",
    placeholder: obj.placeholder ? String(obj.placeholder) : type === "date_range" ? "请选择时间范围" : undefined,
  };
}

function defaultReportTimeField(sourceTable: string) {
  const fields: Record<string, string> = {
    funds_change_history: "transaction_time",
    refund_record: "refund_time",
    contract: "sign_time",
    generic_course: "course_date",
    generic_course_student: "attendance_time",
    student_followup: "next_follow_time",
    student: "created_at",
  };
  return fields[sourceTable] ?? "created_at";
}

function reportDisplayKey(field: string) {
  if (field === "organization_id") return "organization_name";
  if (field === "student_id") return "student_name";
  if (field === "teacher_id" || field === "study_manager_id" || field === "sign_staff_id" || field === "user_id") return `${field.replace(/_id$/, "")}_name`;
  if (field.endsWith("_id")) return `${field.replace(/_id$/, "")}_name`;
  return undefined;
}

function reportFieldLabel(sourceTable: string, field: string) {
  const labels: Record<string, string> = {
    organization_id: "校区",
    organization_name: "校区",
    student_id: "学员",
    student_name: "学员",
    teacher_id: "老师",
    study_manager_id: "学管师",
    sign_staff_id: "签约人",
    user_id: "用户",
    transaction_amount: sourceTable === "funds_change_history" ? "收款金额" : "交易金额",
    transaction_time: sourceTable === "funds_change_history" ? "收款时间" : "交易时间",
    personal_performance_user_id: "员工",
    personal_performance_user_name: "员工",
    personal_performance_amount: "业绩金额",
    organization_performance_amount: "校区业绩金额",
    organization_performance_organization_id: "校区",
    total_amount: "总金额",
    total_performance_amount: "业绩金额",
    paid_amount: "已收金额",
    remaining_amount: "剩余金额",
    sign_time: "签约时间",
    refund_time: "退费时间",
    course_date: "上课日期",
    attendance_time: "出勤时间",
    created_at: "创建时间",
    course_hour: "课时",
    remaining_hours: "剩余课时",
    id: "数量",
  };
  return labels[field] ?? field;
}

function reportMetricLabel(sourceTable: string, field: string, metric: Record<string, unknown>) {
  if (metric.label) return String(metric.label);
  const type = String(metric.type ?? metric.aggregate ?? "").toLowerCase();
  const base = reportFieldLabel(sourceTable, field);
  if (type === "count") return `${base}数量`;
  if (type === "avg") return `平均${base}`;
  if (type === "min") return `最小${base}`;
  if (type === "max") return `最大${base}`;
  return base;
}

async function discoverPageModalCodes(pageCode: string, schemaName: string): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT dsl_json FROM admin.action_dsl
     WHERE page_code = $1
       AND action_type = 'open_modal'
       AND status = 'active' AND deleted = false
       AND ((schema_scope = 'tenant' AND schema_name = $2) OR (schema_scope = 'tenant' AND schema_name = 'demo_school'))
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

function normalizeModalField(fieldDef: Record<string, unknown> | undefined, field: string): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...(fieldDef ?? {}) };
  if (!normalized.key) normalized.key = field;
  if (!normalized.label) normalized.label = field;
  if (!normalized.type) normalized.type = "text";
  return normalized;
}

function groupByTarget(diffs: DslDiff[]): Map<string, DslDiff[]> {
  const map = new Map<string, DslDiff[]>();
  for (const d of diffs) {
    const key = `${d.targetType}::${d.targetCode}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(d);
  }
  return map;
}

async function loadExistingDsl(
  targetType: TargetType,
  targetCode: string,
  schemaName: string,
): Promise<Record<string, unknown> | null> {
  if (targetType === "feature_registry") {
    const { rows } = await pool.query(
      `select * from admin.feature_registry where feature_code = $1 and status = 'ACTIVE' and deleted = false limit 1`,
      [targetCode]
    );
    return rows[0] as Record<string, unknown> | null;
  }
  const tableMap: Record<string, { table: string; codeCol: string; contentCol: string }> = {
    page_dsl: { table: "admin.page_dsl", codeCol: "page_code", contentCol: "dsl_json" },
    api_dsl: { table: "admin.api_dsl", codeCol: "api_code", contentCol: "dsl_json" },
    action_dsl: { table: "admin.action_dsl", codeCol: "action_code", contentCol: "dsl_json" },
    skill_registry: { table: "admin.skill_registry", codeCol: "skill_code", contentCol: "skill_md_content" },
  };
  const mapping = tableMap[targetType];
  if (!mapping) return null;

  const { rows } = await pool.query(
    `SELECT ${mapping.contentCol} AS content FROM ${mapping.table}
     WHERE ${mapping.codeCol} = $1
       AND (schema_scope = 'tenant' AND schema_name = $2 OR (schema_scope = 'tenant' AND schema_name = 'demo_school'))
       AND status = 'active' AND deleted = false
     ORDER BY CASE WHEN schema_scope = 'tenant' THEN 0 ELSE 1 END LIMIT 1`,
    [targetCode, schemaName]
  );

  if (!rows[0]) return null;
  const content = rows[0].content;
  if (targetType === "skill_registry") return { skill_md_content: content };
  if (typeof content === "string") {
    try { return JSON.parse(content); } catch { return {}; }
  }
  return content;
}

function insertWithSortOrder<T>(
  items: T[],
  newItem: T,
  sortOrder?: number,
): T[] {
  const arr = [...items];
  if (sortOrder != null && sortOrder >= 0) {
    const idx = Math.min(sortOrder, arr.length);
    arr.splice(idx, 0, newItem);
  } else {
    arr.push(newItem);
  }
  return arr;
}

function applyOp(dsl: unknown, diff: DslDiff): unknown {
  if (diff.targetType === "skill_registry" && diff.op === "modify" && typeof diff.modifiedDslJson === "string") {
    return diff.modifiedDslJson;
  }
  const base = dsl && typeof dsl === "object" && !Array.isArray(dsl) ? dsl as Record<string, unknown> : {};
  let result = { ...base };

  switch (diff.op) {
    case "create_table": {
      const def = diff.resourceDef ?? {};
      result = {
        resourceType: "db_schema",
        operation: "create_table",
        tableName: def.tableName ?? diff.targetCode,
        tableLabel: def.tableLabel ?? def.label ?? diff.targetCode,
        fields: Array.isArray(def.fields) ? def.fields : [],
        softDelete: def.softDelete !== false,
        extJson: def.extJson !== false,
      };
      break;
    }

    case "add_field": {
      const def = diff.resourceDef ?? {};
      result = {
        resourceType: "db_schema",
        operation: "add_field",
        tableName: def.tableName ?? diff.targetCode,
        fields: Array.isArray(def.fields) ? def.fields : diff.field ? [{ key: diff.field, ...(diff.fieldDef ?? {}) }] : [],
      };
      break;
    }

    case "create_import": {
      result = {
        resourceType: "import_dsl",
        importCode: diff.targetCode,
        ...(diff.resourceDef ?? {}),
      };
      break;
    }

    case "create_report": {
      result = {
        resourceType: "report_dsl",
        reportCode: diff.targetCode,
        ...(diff.resourceDef ?? {}),
      };
      break;
    }

    case "create_feature": {
      result = {
        resourceType: "feature_registry",
        featureCode: diff.targetCode,
        ...(diff.resourceDef ?? {}),
      };
      break;
    }

    case "create_approval_flow": {
      result = {
        resourceType: "approval_flow",
        flowCode: diff.targetCode,
        ...(diff.resourceDef ?? {}),
      };
      break;
    }

    case "create_print_template": {
      result = {
        resourceType: "print_template",
        templateCode: diff.targetCode,
        ...(diff.resourceDef ?? {}),
      };
      break;
    }

    case "create_business_rule":
    case "create_business_event_listener": {
      result = {
        resourceType: "business_rule",
        ruleCode: diff.targetCode,
        ...(diff.resourceDef ?? {}),
      };
      break;
    }

    case "modify_permission": {
      result = {
        resourceType: "permission_policy",
        policyCode: diff.targetCode,
        ...(diff.resourceDef ?? {}),
      };
      break;
    }

    case "add_column": {
      const table = (result.table as Record<string, unknown>) ?? {};
      const columns = (table.columns as Array<Record<string, unknown>>) ?? [];
      const newCol = { ...(diff.fieldDef as Record<string, unknown> ?? {}) };
      const key = String(newCol.key ?? diff.field ?? "");
      if (key && columns.some((c) => c.key === key)) {
        console.warn(`[DiffExecutor] add_column skipped: key "${key}" already exists in ${diff.targetCode}`);
        break;
      }
      const updated = insertWithSortOrder(columns, newCol, diff.sortOrder);
      result = { ...result, table: { ...table, columns: updated } };

      const modal = (result.modal as Record<string, unknown>) ?? {};
      const modalFields = (modal.fields as Array<Record<string, unknown>>) ?? [];
      if (!modalFields.some((f) => f.key === key)) {
        const modalFieldDef: Record<string, unknown> = {
          key,
          label: newCol.label ?? key,
          type: newCol.type ?? "text",
        };
        if (newCol.required != null) modalFieldDef.required = newCol.required;
        if (newCol.span != null) modalFieldDef.span = newCol.span;
        result = { ...result, modal: { ...modal, fields: [...modalFields, modalFieldDef] } };
      }
      break;
    }

    case "remove_column": {
      const table = (result.table as Record<string, unknown>) ?? {};
      const columns = ((table.columns as Array<Record<string, unknown>>) ?? [])
        .filter((c) => c.key !== diff.field);
      result = { ...result, table: { ...table, columns } };
      break;
    }

    case "reorder_columns": {
      const table = (result.table as Record<string, unknown>) ?? {};
      const existingCols = (table.columns as Array<Record<string, unknown>>) ?? [];
      const order = (diff.fieldDef?.order as string[]) ?? [];
      const colMap = new Map(existingCols.map((c) => [String(c.key), c]));
      const reordered: Array<Record<string, unknown>> = [];
      for (const key of order) {
        const col = colMap.get(key);
        if (col) { reordered.push(col); colMap.delete(key); }
      }
      for (const col of existingCols) {
        if (colMap.has(String(col.key))) reordered.push(col);
      }
      result = { ...result, table: { ...table, columns: reordered } };
      break;
    }

    case "change_column": {
      const table = (result.table as Record<string, unknown>) ?? {};
      const columns = ((table.columns as Array<Record<string, unknown>>) ?? [])
        .map((c) => c.key === diff.field ? { ...c, ...(diff.fieldDef as Record<string, unknown> ?? {}) } : c);
      result = { ...result, table: { ...table, columns } };
      break;
    }

    case "add_filter": {
      if (Array.isArray(result.filters) && result.filters.some((item) => typeof item === "object")) {
        const filters = (result.filters as Array<Record<string, unknown>>) ?? [];
        const newFilter = { ...(diff.fieldDef as Record<string, unknown> ?? {}) };
        const key = String(newFilter.key ?? diff.field ?? "");
        if (!key || !filters.some((f) => f.key === key)) {
          result = { ...result, filters: insertWithSortOrder(filters, newFilter, diff.sortOrder) };
        }
      } else {
        const filters = (result.filters as string[] | undefined) ?? [];
        const field = String(diff.fieldDef?.field ?? diff.fieldDef?.key ?? diff.field ?? "");
        if (field && !filters.includes(field)) {
          result = { ...result, filters: [...filters, field] };
        }
      }
      break;
    }

    case "remove_filter": {
      result = { ...result, filters: ((result.filters as Array<Record<string, unknown>>) ?? []).filter((f) => f.key !== diff.field) };
      break;
    }

    case "add_toolbar": {
      const toolbar = (result.toolbar as Array<Record<string, unknown>>) ?? [];
      const newToolbar = { ...(diff.fieldDef as Record<string, unknown> ?? {}) };
      const actionCode = String(newToolbar.actionCode ?? "");
      if (actionCode && toolbar.some((action) => String(action.actionCode ?? "") === actionCode)) {
        console.warn(`[DiffExecutor] add_toolbar skipped: actionCode "${actionCode}" already exists in ${diff.targetCode}`);
        break;
      }
      result = { ...result, toolbar: [...toolbar, newToolbar] };
      break;
    }

    case "add_row_action": {
      const table = (result.table as Record<string, unknown>) ?? {};
      const rowActions = (table.rowActions as Array<Record<string, unknown>>) ?? [];
      const newAction = { ...(diff.fieldDef as Record<string, unknown> ?? {}) };
      const actionCode = String(newAction.actionCode ?? "");
      if (actionCode && rowActions.some((action) => String(action.actionCode ?? "") === actionCode)) {
        console.warn(`[DiffExecutor] add_row_action skipped: actionCode "${actionCode}" already exists in ${diff.targetCode}`);
        break;
      }
      result = { ...result, table: { ...table, rowActions: [...rowActions, newAction] } };
      break;
    }

    case "add_modal_field": {
      const useTopLevelFields = diff.targetType === "action_dsl" || Array.isArray(result.fields) || Boolean(result.modalCode);
      const modal = (result.modal as Record<string, unknown>) ?? {};
      const fields = useTopLevelFields
        ? ((result.fields as Array<Record<string, unknown>>) ?? [])
        : ((modal.fields as Array<Record<string, unknown>>) ?? []);
      const newField = { ...(diff.fieldDef as Record<string, unknown> ?? {}) };
      const key = String(newField.key ?? diff.field ?? "");
      if (key && fields.some((f) => f.key === key)) {
        console.warn(`[DiffExecutor] add_modal_field skipped: key "${key}" already exists`);
        break;
      }
      const nextFields = insertWithSortOrder(fields, newField, diff.sortOrder);
      result = useTopLevelFields ? { ...result, fields: nextFields } : { ...result, modal: { ...modal, fields: nextFields } };
      break;
    }

    case "remove_modal_field": {
      const useTopLevelFields = diff.targetType === "action_dsl" || Array.isArray(result.fields) || Boolean(result.modalCode);
      const modal = (result.modal as Record<string, unknown>) ?? {};
      const fields = (useTopLevelFields
        ? ((result.fields as Array<Record<string, unknown>>) ?? [])
        : ((modal.fields as Array<Record<string, unknown>>) ?? []))
        .filter((f) => f.key !== diff.field);
      result = useTopLevelFields ? { ...result, fields } : { ...result, modal: { ...modal, fields } };
      break;
    }

    case "add_select_field": {
      const select = (result.select as Array<Record<string, unknown>>) ?? [];
      const newField = { ...(diff.fieldDef as Record<string, unknown> ?? {}) };
      if (!newField.field && newField.key) {
        newField.field = newField.key;
        delete newField.key;
      }
      if (!newField.field && diff.field) {
        newField.field = diff.field;
      }
      if (!newField.as && newField.field) {
        newField.as = newField.field;
      }
      result = { ...result, select: [...select, newField] };
      break;
    }

    case "remove_select_field": {
      result = {
        ...result,
        select: ((result.select as Array<Record<string, unknown>>) ?? [])
          .filter((s) => (s as Record<string, unknown>).field !== diff.field),
      };
      break;
    }

    case "add_allowed_field": {
      const allowedFields = (result.allowedFields as string[] | undefined) ?? [];
      const field = String(diff.fieldDef?.field ?? diff.fieldDef?.key ?? diff.field ?? "");
      if (field && !allowedFields.includes(field)) {
        result = { ...result, allowedFields: [...allowedFields, field] };
      }
      break;
    }

    case "add_join": {
      const joins = (result.joins as Array<Record<string, unknown>>) ?? [];
      const newJoin = { ...(diff.fieldDef as Record<string, unknown> ?? {}) };
      if (!newJoin.alias && newJoin.table) {
        newJoin.alias = String(newJoin.table).substring(0, 3);
      }
      result = { ...result, joins: [...joins, newJoin] };
      break;
    }

    case "add_where": {
      const where = (result.where as Array<Record<string, unknown>>) ?? [];
      const newWhere = { ...(diff.fieldDef as Record<string, unknown> ?? {}) };
      if (!newWhere.field && newWhere.key) {
        newWhere.field = newWhere.key;
        delete newWhere.key;
      }
      if (!newWhere.source) {
        newWhere.source = "constant";
      }
      result = { ...result, where: [...where, newWhere] };
      break;
    }

    case "add_sort": {
      if (diff.fieldDef) {
        const sortVal = (diff.fieldDef as Record<string, unknown>).field ?? diff.fieldDef;
        result = { ...result, sort: sortVal };
      }
      break;
    }

    case "add_action": {
      if (diff.fieldDef && typeof diff.fieldDef === "object") {
        const existing = Array.isArray(result.actions) ? result.actions as Array<Record<string, unknown>> : [];
        result = { ...result, actions: [...existing, { ...(diff.fieldDef as Record<string, unknown>) }] };
      }
      break;
    }

    case "modify": {
      if (diff.modifiedDslJson && typeof diff.modifiedDslJson === "object") {
        result = diff.modifiedDslJson as Record<string, unknown>;
      }
      break;
    }
  }

  return result;
}
