import { pool } from "../db/pool.js";
import { systemDictionaryLabel } from "../dictionary.service.js";
import { DATA_PERMISSION_PRIORITY } from "../common/dsl-constants.js";
import { TEMPLATE_SCHEMA } from "../common/template-schema.js";
import type { SessionUser } from "../types.js";

export async function canAccessPage(user: SessionUser | undefined, schemaName: string | undefined, pageCode: string) {
  if (user?.kind === "admin") return true;
  if (!user || !schemaName) return false;
  const { rows } = await pool.query(
    `select rr.page_permission
     from "${schemaName}".role_resource rr
     join "${schemaName}".user_role ur on ur.role_id = rr.role_id and ur.deleted = false
     where ur.user_id = $1 and rr.page_code = $2 and rr.deleted = false
     limit 1`,
    [user.userId, pageCode]
  );
  return rows.length > 0;
}

export async function visiblePageCodes(user: SessionUser | undefined, schemaName: string) {
  if (!user) return [];
  if (user.kind === "admin") return ["*"];
  const { rows } = await pool.query(
    `select distinct rr.page_code
     from "${schemaName}".role_resource rr
     join "${schemaName}".user_role ur on ur.role_id = rr.role_id and ur.deleted = false
     where ur.user_id = $1 and rr.deleted = false`,
    [user.userId]
  );
  return rows.map((row) => row.page_code as string);
}

export async function visibleActionCodes(user: SessionUser | undefined, schemaName: string, pageCode: string): Promise<Set<string>> {
  if (!user || user.kind === "admin") return new Set(["*"]);
  const { rows } = await pool.query(
    `select distinct rr.resource_type, rr.action_code, rr.button_permission, rr.page_permission
     from "${schemaName}".role_resource rr
     join "${schemaName}".user_role ur on ur.role_id = rr.role_id and ur.deleted = false
     where ur.user_id = $1 and rr.page_code = $2 and rr.deleted = false`,
    [user.userId, pageCode]
  );
  if (rows.length === 0) return new Set();
  const hasButtonResource = rows.some((r) => r.resource_type === "button");
  if (hasButtonResource) {
    return new Set(rows.filter((r) => r.resource_type === "button").map((r) => r.action_code as string));
  }
  const pagePerms = rows.map((r) => r.page_permission as string);
  if (pagePerms.some((p) => p === "all")) return new Set(["*"]);
  const buttons = new Set<string>();
  for (const row of rows) {
    const bp = row.button_permission;
    if (Array.isArray(bp)) {
      for (const b of bp) {
        const code = String(b);
        buttons.add(code.includes(".") ? code : `${pageCode}.${code}`);
      }
    }
  }
  return buttons.size > 0 ? buttons : new Set(["*"]);
}

/**
 * 判断用户能否在某页面执行某个写接口（按钮权限级别）。
 * 规则：admin 放行；按钮权限含 "*" 放行；可见按钮编码直接等于 apiCode（常见约定 actionCode=apiCode）放行；
 * 否则查该页面可见按钮的 action DSL 中是否有任一 apiCode 指向该接口。
 */
export async function canExecuteApiOnPage(user: SessionUser | undefined, schemaName: string, pageCode: string, apiCode: string): Promise<boolean> {
  if (!user) return false;
  if (user.kind === "admin") return true;
  const codes = await visibleActionCodes(user, schemaName, pageCode);
  if (codes.has("*")) return true;
  if (codes.size === 0) return false;
  if (codes.has(apiCode)) return true;
  // 按钮的 apiCode 可能直接配置，也可能藏在弹窗（内联 modal 或 modalCode 引用的 modal 行）的 submitApiCode 里，两种口径都要认
  const { rows } = await pool.query(
    `select a.dsl_json->>'apiCode' as api_code,
            a.dsl_json->>'submitApiCode' as submit_api_code,
            a.dsl_json->'modal'->>'submitApiCode' as modal_submit_api_code,
            m.dsl_json->>'submitApiCode' as ref_submit_api_code,
            m.dsl_json->'modal'->>'submitApiCode' as ref_modal_submit_api_code
     from admin.action_dsl a
     left join admin.action_dsl m
       on m.action_code = a.dsl_json->>'modalCode' and m.action_type = 'modal' and m.status = 'active' and m.deleted = false
     where a.page_code = $1 and a.status = 'active' and a.deleted = false and a.action_code = any($2)`,
    [pageCode, [...codes]]
  );
  if (rows.some((row) =>
    [row.api_code, row.submit_api_code, row.modal_submit_api_code, row.ref_submit_api_code, row.ref_modal_submit_api_code]
      .some((code) => String(code ?? "") === apiCode)
  )) return true;
  // 内联按钮：大多数行按钮/工具栏按钮直接写在 page_dsl 里（不在 action_dsl 注册表），
  // 其 apiCode（含 .create/.edit/.delete 约定映射到页面 createApi/updateApi/deleteApi）也要认，
  // 否则受限角色被授权的按钮点击时会被误拒。
  const pageRows = await pool.query(
    `select dsl_json from admin.page_dsl
     where page_code = $1 and status = 'active' and deleted = false
       and schema_scope = 'tenant' and (schema_name = $2 or schema_name = '${TEMPLATE_SCHEMA}')
     order by case when schema_name = $2 then 0 else 1 end
     limit 1`,
    [pageCode, schemaName]
  );
  const pageDsl = pageRows.rows[0]?.dsl_json as Record<string, unknown> | undefined;
  if (!pageDsl) return false;
  const tableDsl = (pageDsl.table as Record<string, unknown> | undefined) ?? {};
  const inlineActions = [
    ...(Array.isArray(pageDsl.toolbar) ? pageDsl.toolbar : []),
    ...(Array.isArray(tableDsl.rowActions) ? tableDsl.rowActions : []),
  ] as Array<Record<string, unknown>>;
  for (const action of inlineActions) {
    const actionCode = String(action?.actionCode ?? "");
    if (!actionCode || !codes.has(actionCode)) continue;
    if (String(action?.apiCode ?? "") === apiCode) return true;
    if (actionCode.endsWith(".create") && String(pageDsl.createApi ?? "") === apiCode) return true;
    if (actionCode.endsWith(".edit") && String(pageDsl.updateApi ?? "") === apiCode) return true;
    if (actionCode.endsWith(".delete") && String(pageDsl.deleteApi ?? "") === apiCode) return true;
  }
  return false;
}

export async function fieldPermissions(user: SessionUser | undefined, schemaName: string, pageCode: string): Promise<Record<string, string>> {
  if (!user || user.kind === "admin") return {};
  const { rows } = await pool.query(
    `select rr.field_permission
     from "${schemaName}".role_resource rr
     join "${schemaName}".user_role ur on ur.role_id = rr.role_id and ur.deleted = false
     where ur.user_id = $1 and rr.page_code = $2 and rr.deleted = false`,
    [user.userId, pageCode]
  );
  const result: Record<string, string> = {};
  const priority: Record<string, number> = { visible: 3, readonly: 2, hidden: 1 };
  for (const row of rows) {
    const fp = row.field_permission as Record<string, string> | null;
    if (!fp) continue;
    for (const [field, perm] of Object.entries(fp)) {
      if (!result[field] || (priority[perm] ?? 0) > (priority[result[field]] ?? 0)) {
        result[field] = perm;
      }
    }
  }
  return result;
}

function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    } catch {
      return value.split(",").map((item) => item.trim()).filter(Boolean);
    }
  }
  return [];
}

async function organizationTreeIds(schemaName: string, rootIds: string[]) {
  if (!rootIds.length) return [];
  const { rows } = await pool.query(
    `with recursive org_tree as (
       select id from "${schemaName}".organization where id = any($1::text[]) and deleted = false
       union all
       select o.id from "${schemaName}".organization o join org_tree ot on o.parent_id = ot.id and o.deleted = false
     ) select distinct id from org_tree`,
    [rootIds]
  );
  return rows.map((row) => row.id as string);
}

async function resolveManagementContext(user: SessionUser, schemaName: string) {
  const { rows } = await pool.query(
    `select id, organization_id, management_organization_ids
     from "${schemaName}"."user"
     where id = $1 and deleted = false
     limit 1`,
    [user.userId]
  );
  const row = rows[0];
  const homeOrganizationId = (row?.organization_id as string | null) ?? null;
  const rootIds = normalizeStringArray(row?.management_organization_ids);
  if (homeOrganizationId && !rootIds.includes(homeOrganizationId)) rootIds.unshift(homeOrganizationId);
  const allowedOrganizationIds = await organizationTreeIds(schemaName, rootIds);
  const requested = user.currentManagementOrganizationId;
  const organizationId = requested && allowedOrganizationIds.includes(requested)
    ? requested
    : (rootIds.find((id) => allowedOrganizationIds.includes(id)) ?? homeOrganizationId);
  const subOrganizationIds = organizationId ? await organizationTreeIds(schemaName, [organizationId]) : [];
  return { organizationId, subOrganizationIds, allowedOrganizationIds };
}

function withOrganizationTypeLabels(rows: Array<Record<string, unknown>>) {
  return rows.map((row) => ({
    ...row,
    organization_type_label: systemDictionaryLabel("organization_type", row.organization_type) ?? row.organization_type
  }));
}

export async function listManagementOrganizations(user: SessionUser | undefined, schemaName: string) {
  if (!user) return { currentOrganizationId: null, organizations: [] };
  if (user.kind === "admin") {
    const { rows } = await pool.query(
      `select id, name, parent_id, organization_type, status
       from "${schemaName}".organization
       where deleted = false
       order by parent_id nulls first, name`
    );
    return { currentOrganizationId: rows[0]?.id ?? null, organizations: withOrganizationTypeLabels(rows) };
  }
  const context = await resolveManagementContext(user, schemaName);
  if (!context.allowedOrganizationIds.length) return { currentOrganizationId: null, organizations: [] };
  const { rows } = await pool.query(
    `select id, name, parent_id, organization_type, status
     from "${schemaName}".organization
     where id = any($1::text[]) and deleted = false
     order by parent_id nulls first, name`,
    [context.allowedOrganizationIds]
  );
  return { currentOrganizationId: context.organizationId, organizations: withOrganizationTypeLabels(rows) };
}

export async function getDataPermissionScope(user: SessionUser | undefined, schemaName: string) {
  if (!user) return { dataPermission: "self_only", organizationId: null, subOrganizationIds: [] };
  if (user.kind === "admin") return { dataPermission: "all", organizationId: null, subOrganizationIds: [] };

  const { rows } = await pool.query(
    `select ur.user_id, rr.data_permission
     from "${schemaName}".role_resource rr
     join "${schemaName}".user_role ur on ur.role_id = rr.role_id and ur.deleted = false
     where ur.user_id = $1 and rr.deleted = false`,
    [user.userId]
  );

  const priority = DATA_PERMISSION_PRIORITY;
  let bestPermission = "self_only";

  for (const row of rows) {
    const dp = row.data_permission as string;
    if ((priority[dp] ?? 0) > (priority[bestPermission] ?? 0)) bestPermission = dp;
  }

  const management = await resolveManagementContext(user, schemaName);
  const subOrganizationIds = bestPermission === "organization_or_sub" ? management.subOrganizationIds : management.organizationId ? [management.organizationId] : [];

  return { dataPermission: bestPermission, organizationId: management.organizationId, subOrganizationIds };
}

export async function getOrganizationScope(user: SessionUser | undefined, schemaName: string, availableColumns?: Set<string>) {
  const scope = await getDataPermissionScope(user, schemaName);
  const params: unknown[] = [];
  const conditions: string[] = [];
  // 归属列在目标表不一定存在（如 own_courses 的 teacher_id 在学员/收款表上没有），
  // 拼 SQL 前先校验列存在，缺列时回落到校区维度；连 organization_id 都没有的表视为共享字典表不加过滤。
  const has = (column: string) => !availableColumns || availableColumns.has(column);

  const pushOrganizationScope = () => {
    if (!has("organization_id")) return false;
    if (scope.subOrganizationIds.length > 0) {
      const placeholders = scope.subOrganizationIds.map((_, i) => `$${params.length + i + 1}`);
      conditions.push(`t.organization_id in (${placeholders.join(", ")})`);
      params.push(...scope.subOrganizationIds);
      return true;
    }
    if (scope.organizationId) {
      conditions.push(`t.organization_id = $${params.length + 1}`);
      params.push(scope.organizationId);
      return true;
    }
    return false;
  };

  const pushOwnerScope = (ownerColumns: string[]) => {
    const columns = ownerColumns.filter(has);
    if (!user?.userId || !columns.length) return false;
    params.push(user.userId);
    conditions.push(`(${columns.map((column) => `t.${column} = $${params.length}`).join(" or ")})`);
    return true;
  };

  switch (scope.dataPermission) {
    case "all":
      return { whereSql: "", params: [] };
    case "own_organization":
    case "organization_or_sub":
      if (!pushOrganizationScope() && availableColumns) return { whereSql: "", params: [] };
      break;
    case "own_students":
      if (!pushOwnerScope(["owner_user_id", "study_manager_id"]) && !pushOrganizationScope() && availableColumns) return { whereSql: "", params: [] };
      break;
    case "own_courses":
      if (!pushOwnerScope(["teacher_id", "study_manager_id"]) && !pushOrganizationScope() && availableColumns) return { whereSql: "", params: [] };
      break;
    case "self_only":
    default:
      if (!pushOwnerScope(["created_by"]) && !pushOrganizationScope() && availableColumns) return { whereSql: "", params: [] };
      break;
  }

  return { whereSql: conditions.length ? conditions.join(" and ") : "1=0", params };
}
