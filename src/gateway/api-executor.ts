import { pool } from "../db/pool.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { executeCommandDsl } from "./command-engine.js";
import { executeApiDsl } from "./query-dsl-engine.js";
import { publishVersionAndSyncSkillMd, rollbackVersion, rejectVersion, tenantRollbackVersion } from "../version/version.service.js";
import { rollbackTestSchemaDsl } from "../tenant/test-schema.service.js";
import { qIdent } from "../db/schema-resolver.js";
import type { SessionUser } from "../types.js";

export function buildZodSchema(schemaDef: { fields: Array<{ name: string; type: string; required?: boolean }> }) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of schemaDef.fields) {
    let base: z.ZodTypeAny;
    switch (field.type) {
      case "string": base = z.string(); break;
      case "number": base = z.number(); break;
      case "boolean": base = z.boolean(); break;
      case "date": base = z.string(); break;
      default: base = z.unknown(); break;
    }
    shape[field.name] = field.required ? base : base.optional();
  }
  return z.object(shape);
}

export async function loadApiDsl(scope: "admin" | "tenant", apiCode: string, schemaName?: string) {
  const { rows } = await pool.query(
    `select api_code, api_type, dsl_json
     from admin.api_dsl
     where api_code = $1 and status = 'active' and deleted = false
       and ((schema_scope = $2 and coalesce(schema_name,'') = coalesce($3,''))
         or (schema_scope = 'tenant_default' and $2 = 'tenant'))
     order by case when schema_scope = $2 then 0 else 1 end
     limit 1`,
    [apiCode, scope, schemaName ?? null]
  );
  if (!rows[0]) throw new Error("API DSL 不存在");
  return rows[0].dsl_json;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return asObject(parsed);
    } catch {
      throw Object.assign(new Error("JSON 格式不正确"), { statusCode: 400 });
    }
  }
  return {};
}

function safeCode(value: unknown, label: string) {
  const text = String(value ?? "");
  if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,120}$/.test(text)) throw Object.assign(new Error(`${label} 不合法: ${text}`), { statusCode: 400 });
  return text;
}

function businessRuleCategoryLabel(category: string) {
  const labels: Record<string, string> = {
    funds_allocation: "资金分配",
    promotion_allocation: "优惠分配",
    performance_allocation: "业绩分配",
    approval_trigger: "审批触发",
    validation: "校验规则",
    workflow: "业务流转",
    refund: "退费规则",
    charge: "扣费规则",
    attendance: "考勤规则",
  };
  return labels[category] ?? category;
}

function businessRuleTypeLabel(type: string) {
  const labels: Record<string, string> = {
    contract: "合同签约",
    funds: "收款",
    course: "排课",
    course_cancel: "课程取消",
    attendance: "考勤",
    charge: "扣费",
    charge_reverse: "撤销扣费",
    refund: "退费",
    contract_refund: "合同退费",
    product_price: "产品价格",
    performance: "业绩",
  };
  return labels[type] ?? type;
}

function moduleLabel(moduleCode: string) {
  const labels: Record<string, string> = {
    recruit: "招生",
    student: "学员",
    education: "教务",
    finance: "财务",
    system: "系统设置",
    ai_customization: "AI 定制",
  };
  return labels[moduleCode] ?? moduleCode;
}

function approvalRoleLabel(role: string) {
  const labels: Record<string, string> = {
    PRINCIPAL: "校长",
    MANAGER: "校长",
    SALES: "顾问",
    TEACHER: "老师",
    STUDY_MANAGER: "学管师",
  };
  return labels[role] ?? role;
}

function pageFields(dsl: Record<string, unknown>) {
  const table = asObject(dsl.table);
  const modal = asObject(dsl.modal);
  const fields = [
    ...(Array.isArray(dsl.filters) ? dsl.filters : []),
    ...(Array.isArray(table.columns) ? table.columns : []),
    ...(Array.isArray(modal.fields) ? modal.fields : []),
  ];
  const seen = new Set<string>();
  return fields
    .map((field) => asObject(field))
    .map((field) => ({ key: String(field.key ?? ""), label: String(field.label ?? field.title ?? field.key ?? "") }))
    .filter((field) => field.key && !seen.has(field.key) && seen.add(field.key));
}

async function listPermissionConfig(schemaName: string, roleId: string) {
  const { rows: pageRows } = await pool.query(
    `select p.page_code, p.page_name, p.dsl_json, p.schema_scope,
            f.feature_code, f.feature_name, coalesce(f.sort_no, 999) as feature_sort,
            m.module_code, m.module_name, coalesce(m.sort_no, 999) as module_sort
     from admin.page_dsl p
     left join admin.feature_registry f
       on f.page_code = p.page_code and f.status = 'ACTIVE' and f.deleted = false
     left join admin.module_registry m
       on m.module_code = f.module_code and m.status = 'ACTIVE' and m.deleted = false
     where p.status = 'active' and p.deleted = false
       and ((p.schema_scope = 'tenant' and p.schema_name = $1) or p.schema_scope = 'tenant_default')
     order by case when p.schema_scope = 'tenant' then 0 else 1 end, module_sort, feature_sort, p.page_name`,
    [schemaName]
  );
  const pageMap = new Map<string, Record<string, unknown>>();
  for (const row of pageRows) {
    if (!pageMap.has(row.page_code)) pageMap.set(row.page_code, row);
  }

  const { rows: actionRows } = await pool.query(
    `select action_code, action_name, action_type, page_code, dsl_json, schema_scope
     from admin.action_dsl
     where status = 'active' and deleted = false and action_type <> 'modal'
       and ((schema_scope = 'tenant' and schema_name = $1) or schema_scope = 'tenant_default')
     order by case when schema_scope = 'tenant' then 0 else 1 end, action_code`,
    [schemaName]
  );
  const actionsByPage = new Map<string, Map<string, Record<string, unknown>>>();
  for (const row of actionRows) {
    const pageCode = String(row.page_code ?? "");
    if (!pageCode || !pageMap.has(pageCode)) continue;
    if (!actionsByPage.has(pageCode)) actionsByPage.set(pageCode, new Map());
    const byCode = actionsByPage.get(pageCode)!;
    if (!byCode.has(row.action_code)) byCode.set(row.action_code, row);
  }

  const { rows: resourceRows } = roleId
    ? await pool.query(
        `select id, resource_code, resource_type, page_code, action_code, page_permission, button_permission, data_permission, field_permission
         from ${qIdent(schemaName)}.role_resource
         where role_id = $1 and deleted = false
         order by page_code`,
        [roleId]
      )
    : { rows: [] as Record<string, unknown>[] };

  const pages = [...pageMap.values()].map((row) => {
    const pageCode = String(row.page_code);
    const dsl = asObject(row.dsl_json);
    return {
      pageCode,
      pageName: String(row.page_name ?? dsl.title ?? pageCode),
      moduleCode: String(row.module_code ?? "uncategorized"),
      moduleName: String(row.module_name ?? "未分组菜单"),
      featureCode: String(row.feature_code ?? pageCode),
      featureName: String(row.feature_name ?? row.page_name ?? dsl.title ?? pageCode),
      actions: [...(actionsByPage.get(pageCode)?.values() ?? [])].map((action) => ({
        actionCode: String(action.action_code),
        actionName: String(action.action_name ?? asObject(action.dsl_json).label ?? action.action_code),
        actionType: String(action.action_type ?? ""),
      })),
      fields: pageFields(dsl),
    };
  });

  return { pages, resources: resourceRows };
}

async function queryApprovalFlows(schemaName: string, params: Record<string, unknown>) {
  const filters = asObject(params.filters);
  const values: unknown[] = [];
  const where = ["deleted = false"];
  if (filters.name) { values.push(`%${filters.name}%`); where.push(`name ilike $${values.length}`); }
  if (filters.organization_id) { values.push(filters.organization_id); where.push(`organization_id = $${values.length}`); }
  const page = Math.max(Number(params.page ?? 1), 1);
  const pageSize = Math.min(Math.max(Number(params.pageSize ?? 20), 1), 100);
  values.push(pageSize, (page - 1) * pageSize);
  const { rows } = await pool.query(
    `select id, name, flow_code, module_code, status, organization_id, config_json, count(*) over() as __total
     from ${qIdent(schemaName)}.approval_flow
     where ${where.join(" and ")}
     order by updated_at desc
     limit $${values.length - 1} offset $${values.length}`,
    values
  );
  const mapped = rows.map((row) => {
    const config = asObject(row.config_json);
    const steps = Array.isArray(config.steps) ? config.steps as Array<Record<string, unknown>> : [];
    return {
      ...row,
      business_type: config.businessType ?? config.business_type ?? "",
      business_type_label: businessRuleTypeLabel(String(config.businessType ?? config.business_type ?? "")),
      module_label: moduleLabel(String(row.module_code ?? "")),
      steps_summary: steps.map((step) => `${step.stepName ?? step.stepCode ?? ""}:${approvalRoleLabel(String(step.assigneeRole ?? ""))}`).join(" / "),
      config_json: config,
    };
  });
  return { rows: mapped.map(({ __total, ...row }) => row), total: Number(rows[0]?.__total ?? 0), page, pageSize };
}

async function saveApprovalFlow(schemaName: string, params: Record<string, unknown>) {
  const input = asObject(params.data ?? params);
  const id = String(input.id ?? "");
  const flowCode = input.flow_code || input.flowCode ? safeCode(input.flow_code ?? input.flowCode, "审批编码") : `custom_flow_${Date.now()}`;
  const flowName = String(input.name ?? input.flow_name ?? input.flowName ?? flowCode);
  const config = {
    ...parseJsonObject(input.config_json),
    resourceType: "approval_flow",
    flowCode,
    flowName,
    businessType: input.business_type ?? parseJsonObject(input.config_json).businessType ?? "",
  };
  const values = [
    id || randomUUID(),
    flowName,
    flowCode,
    input.module_code ?? asObject(config).moduleCode ?? null,
    input.status ?? "ACTIVE",
    JSON.stringify(config),
    input.organization_id ?? null,
  ];
  await pool.query(
    `insert into ${qIdent(schemaName)}.approval_flow(id, name, flow_code, module_code, status, config_json, organization_id)
     values($1,$2,$3,$4,$5,$6,$7)
     on conflict (id) do update set name = excluded.name, flow_code = excluded.flow_code, module_code = excluded.module_code,
       status = excluded.status, config_json = excluded.config_json, organization_id = excluded.organization_id, updated_at = now(), deleted = false`,
    values
  );
  return { id: values[0], flowCode };
}

async function queryBusinessRules(schemaName: string, params: Record<string, unknown>) {
  const filters = asObject(params.filters);
  const values: unknown[] = [schemaName];
  const where = [`status = 'active'`, "deleted = false", `((schema_scope = 'tenant' and schema_name = $1) or schema_scope = 'tenant_default')`];
  if (filters.rule_name) { values.push(`%${filters.rule_name}%`); where.push(`rule_name ilike $${values.length}`); }
  const page = Math.max(Number(params.page ?? 1), 1);
  const pageSize = Math.min(Math.max(Number(params.pageSize ?? 20), 1), 100);
  values.push(pageSize, (page - 1) * pageSize);
  const { rows } = await pool.query(
    `select distinct on (rule_code) id, schema_scope, schema_name, rule_code, rule_name, rule_json, status, updated_at, count(*) over() as __total
     from admin.business_rule
     where ${where.join(" and ")}
     order by rule_code, case when schema_scope = 'tenant' then 0 else 1 end, updated_at desc
     limit $${values.length - 1} offset $${values.length}`,
    values
  );
  return {
    rows: rows.map(({ __total, ...row }) => ({
      ...row,
      source_label: row.schema_scope === "tenant" ? "租户自定义" : "默认模板",
      rule_json: asObject(row.rule_json),
      category_label: businessRuleCategoryLabel(String(asObject(row.rule_json).category ?? "")),
      business_type_label: businessRuleTypeLabel(String(asObject(row.rule_json).businessType ?? "")),
    })),
    total: Number(rows[0]?.__total ?? 0),
    page,
    pageSize,
  };
}

async function saveBusinessRule(schemaName: string, params: Record<string, unknown>) {
  const input = asObject(params.data ?? params);
  const ruleCode = input.rule_code || input.ruleCode ? safeCode(input.rule_code ?? input.ruleCode, "规则编码") : `custom_rule_${Date.now()}`;
  const ruleName = String(input.rule_name ?? input.ruleName ?? ruleCode);
  const ruleJson = { ...parseJsonObject(input.rule_json), ruleCode, ruleName };
  const { rows } = await pool.query(
    `select id from admin.business_rule
     where schema_scope = 'tenant' and schema_name = $1 and rule_code = $2 and deleted = false
     limit 1`,
    [schemaName, ruleCode]
  );
  const id = String(rows[0]?.id ?? randomUUID());
  await pool.query(
    `insert into admin.business_rule(id, schema_scope, schema_name, rule_code, rule_name, rule_json, status, deleted)
     values($1,'tenant',$2,$3,$4,$5,'active',false)
     on conflict (id) do update set rule_name = excluded.rule_name, rule_json = excluded.rule_json,
       status = 'active', deleted = false, updated_at = now()`,
    [id, schemaName, ruleCode, ruleName, JSON.stringify(ruleJson)]
  );
  return { id, ruleCode };
}

async function executeConfigApi(scope: "admin" | "tenant", schemaName: string, apiCode: string, params: Record<string, unknown>) {
  if (scope !== "tenant") return undefined;
  if (apiCode === "permission_config.meta") return listPermissionConfig(schemaName, String(params.roleId ?? params.id ?? ""));
  if (apiCode === "approval_flow_list.query") return queryApprovalFlows(schemaName, params);
  if (apiCode === "approval_flow_list.create" || apiCode === "approval_flow_list.update") return saveApprovalFlow(schemaName, params);
  if (apiCode === "approval_flow_list.delete") {
    await pool.query(`update ${qIdent(schemaName)}.approval_flow set deleted = true, updated_at = now() where id = $1`, [params.id]);
    return { deleted: true, id: params.id };
  }
  if (apiCode === "business_rule_list.query") return queryBusinessRules(schemaName, params);
  if (apiCode === "business_rule_list.create" || apiCode === "business_rule_list.update") return saveBusinessRule(schemaName, params);
  if (apiCode === "business_rule_list.delete") {
    await pool.query(`update admin.business_rule set deleted = true, updated_at = now() where id = $1 and schema_scope = 'tenant' and schema_name = $2`, [params.id, schemaName]);
    return { deleted: true, id: params.id };
  }
  return undefined;
}

export async function executeGatewayApi(scope: "admin" | "tenant", schemaName: string, apiCode: string, params: Record<string, unknown>, user?: SessionUser) {
  if (scope === "tenant") {
    const versionResult = await handleTenantVersionApi(apiCode, schemaName, params, user);
    if (versionResult !== undefined) return versionResult;
  }

  const configResult = await executeConfigApi(scope, schemaName, apiCode, params);
  if (configResult !== undefined) return configResult;

  const dsl = await loadApiDsl(scope, apiCode, scope === "tenant" ? schemaName : undefined);

  if (dsl.inputSchema) {
    try {
      const schema = buildZodSchema(dsl.inputSchema);
      const result = schema.safeParse(params);
      if (!result.success) {
        const err = Object.assign(new Error("输入校验失败"), { statusCode: 400 }) as Error & { validationErrors?: unknown };
        err.validationErrors = result.error.flatten().fieldErrors;
        throw err;
      }
    } catch (e) {
      if (e instanceof Error && "statusCode" in e) throw e;
      console.warn("inputSchema validation setup failed:", e);
    }
  }

  if (dsl.security?.dataPermission && user && dsl.operation !== "command") {
    // data permission is injected inside executeApiDsl
  }

  let data: unknown;
  if (dsl.operation === "command") {
    data = await executeCommandDsl(scope === "admin" ? "admin" : schemaName, dsl, params);
  } else {
    data = await executeApiDsl(scope === "admin" ? "admin" : schemaName, dsl, params, user);
  }

  if (dsl.outputSchema) {
    try {
      const schema = buildZodSchema(dsl.outputSchema);
      const result = schema.safeParse(data);
      if (!result.success) {
        console.warn("outputSchema validation warning:", result.error.flatten().fieldErrors);
      }
    } catch (e) {
      console.warn("outputSchema validation setup failed:", e);
    }
  }

  return data;
}

async function handleTenantVersionApi(apiCode: string, schemaName: string, params: Record<string, unknown>, user?: SessionUser): Promise<unknown | undefined> {
  const versionId = String(params.id ?? params.versionId ?? "");
  const userId = user?.userId ?? "";

  switch (apiCode) {
    case "dsl_version.publish":
      if (!versionId) throw Object.assign(new Error("缺少版本ID"), { statusCode: 400 });
      return publishVersionAndSyncSkillMd(versionId, userId);

    case "dsl_version.rollback":
      if (!versionId) throw Object.assign(new Error("缺少版本ID"), { statusCode: 400 });
      return tenantRollbackVersion({ schemaName, versionId, userId });

    case "dsl_version.rollback_preview":
      if (!versionId) throw Object.assign(new Error("缺少版本ID"), { statusCode: 400 });
      return rollbackTestSchemaDsl(schemaName, versionId);

    case "dsl_version.reject":
      if (!versionId) throw Object.assign(new Error("缺少版本ID"), { statusCode: 400 });
      return rejectVersion(versionId, "驳回", userId);

    default:
      return undefined;
  }
}
