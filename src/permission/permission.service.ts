import { pool } from "../db/pool.js";
import { systemDictionaryLabel } from "../dictionary.service.js";
import { DATA_PERMISSION_PRIORITY } from "../common/dsl-constants.js";
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
  return rows.some((row) =>
    [row.api_code, row.submit_api_code, row.modal_submit_api_code, row.ref_submit_api_code, row.ref_modal_submit_api_code]
      .some((code) => String(code ?? "") === apiCode)
  );
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

export async function getOrganizationScope(user: SessionUser | undefined, schemaName: string) {
  const scope = await getDataPermissionScope(user, schemaName);
  const params: unknown[] = [];
  const conditions: string[] = [];

  switch (scope.dataPermission) {
    case "all":
      return { whereSql: "", params: [] };
    case "own_organization":
    case "organization_or_sub":
      if (scope.subOrganizationIds.length > 0) {
        const placeholders = scope.subOrganizationIds.map((_, i) => `$${i + 1}`);
        conditions.push(`t.organization_id in (${placeholders.join(", ")})`);
        params.push(...scope.subOrganizationIds);
      } else if (scope.organizationId) {
        conditions.push("t.organization_id = $1");
        params.push(scope.organizationId);
      }
      break;
    case "own_students":
      if (user?.userId) {
        conditions.push(`(t.owner_user_id = $1 or t.study_manager_id = $1)`);
        params.push(user.userId);
      }
      break;
    case "own_courses":
      if (user?.userId) {
        conditions.push(`(t.teacher_id = $1 or t.study_manager_id = $1)`);
        params.push(user.userId);
      }
      break;
    case "self_only":
    default:
      if (user?.userId) {
        conditions.push("t.created_by = $1");
        params.push(user.userId);
      }
      break;
  }

  return { whereSql: conditions.length ? conditions.join(" and ") : "1=0", params };
}
