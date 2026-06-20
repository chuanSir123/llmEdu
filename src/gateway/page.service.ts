import { pool } from "../db/pool.js";
import { visibleActionCodes, fieldPermissions, getDataPermissionScope } from "../permission/permission.service.js";
import type { SessionUser } from "../types.js";
import { inferForeignKeyMeta } from "../common/foreign-key-meta.js";

export async function loadPageDsl(scope: "admin" | "tenant_default" | "tenant", pageCode: string, schemaName?: string) {
  const { rows } = await pool.query(
    `select page_code, page_name, page_kind, dsl_json, version_no
     from admin.page_dsl
     where page_code = $1 and status = 'active' and deleted = false
       and ((schema_scope = $2 and coalesce(schema_name,'') = coalesce($3,''))
         or (schema_scope = 'tenant_default' and $2 = 'tenant'))
     order by case when schema_scope = $2 then 0 else 1 end
     limit 1`,
    [pageCode, scope, schemaName ?? null]
  );
  if (!rows[0]) throw new Error("页面 DSL 不存在");
  return rows[0];
}

export async function loadPageFullDsl(scope: "admin" | "tenant", pageCode: string, schemaName?: string, user?: SessionUser) {
  const page = await loadPageDsl(scope, pageCode, schemaName);
  const pageKind = page.page_kind ?? (pageCode === "tenant_select" || pageCode === "admin_login" || pageCode === "tenant_login" ? "public" : "shtml");

  if (pageKind === "public") {
    return { page, pageKind, actions: [], apis: [], permissions: null, activeVersion: null, tenantInfo: null };
  }

  const [actions, apis, tenantInfo, versionRows, actionPermSet, fieldPermMap, dataPermScope] = await Promise.all([
    pool.query(
      `select action_code, action_name, action_type, dsl_json from admin.action_dsl where page_code = $1 and status = 'active' and deleted = false and ((schema_scope = $2 and coalesce(schema_name,'') = coalesce($3,'')) or (schema_scope = 'tenant_default' and $2 = 'tenant')) order by case when schema_scope = $2 then 0 else 1 end`,
      [pageCode, scope, schemaName ?? null]
    ),
    pool.query(
      `select api_code, api_type, dsl_json from admin.api_dsl where feature_code = (select feature_code from admin.page_dsl where page_code = $1 and status = 'active' and deleted = false limit 1) and status = 'active' and deleted = false and ((schema_scope = $2 and coalesce(schema_name,'') = coalesce($3,'')) or (schema_scope = 'tenant_default' and $2 = 'tenant'))`,
      [pageCode, scope, schemaName ?? null]
    ),
    schemaName ? pool.query(`select schema_name, name, status from admin.tenant_manage where schema_name = $1 and deleted = false`, [schemaName]) : Promise.resolve({ rows: [] }),
    pool.query(
      `select id, version_no, status, change_summary, created_at from admin.dsl_version where target_type = 'page' and target_code = $1 and status = 'active' and deleted = false order by version_no desc limit 1`,
      [pageCode]
    ),
    user && schemaName ? visibleActionCodes(user, schemaName, pageCode) : Promise.resolve(new Set(["*"])),
    user && schemaName ? fieldPermissions(user, schemaName, pageCode) : Promise.resolve({}),
    user && schemaName ? getDataPermissionScope(user, schemaName) : Promise.resolve({ dataPermission: "all", organizationId: null, subOrganizationIds: [] }),
  ]);

  const filteredActions = actions.rows.filter((a) => {
    if (!user || user.kind === "admin") return true;
    if (actionPermSet.has("*")) return true;
    return actionPermSet.has(a.action_code);
  });

  const permissions = {
    pages: [] as string[],
    buttons: filteredActions.map((a) => a.action_code),
    dataPermission: dataPermScope.dataPermission,
    fieldPermissions: fieldPermMap,
  };

  const actionMap = new Map<string, Record<string, unknown>>();
  for (const action of filteredActions) {
    actionMap.set(action.action_code, action.dsl_json as Record<string, unknown>);
  }
  const pageDsl = await enrichImportConfigs(
    normalizeForeignKeyFields(mergePageActions(page.dsl_json as Record<string, unknown>, actionMap)),
    scope,
    schemaName,
  );

  return {
    page: { ...page, dsl_json: pageDsl },
    pageKind,
    actions: filteredActions,
    apis: apis.rows,
    permissions,
    activeVersion: versionRows.rows[0] ?? null,
    tenantInfo: tenantInfo.rows[0] ?? null,
  };
}

function normalizeField(field: unknown) {
  if (!field || typeof field !== "object" || Array.isArray(field)) return field;
  const obj = field as Record<string, unknown>;
  const key = String(obj.key ?? "");
  const meta = inferForeignKeyMeta(key);
  if (!meta) return obj;
  return {
    ...obj,
    type: obj.type ?? "text",
    displayKey: obj.displayKey ?? meta.displayKey,
    optionSource: obj.optionSource ?? {
      pageCode: meta.pageCode,
      apiCode: meta.apiCode,
      valueField: meta.valueField,
      labelField: meta.labelField,
      pageSize: 500,
    },
  };
}

function normalizeFieldArray(fields: unknown) {
  return Array.isArray(fields) ? fields.map(normalizeField) : fields;
}

function normalizeActionFields(action: unknown) {
  if (!action || typeof action !== "object" || Array.isArray(action)) return action;
  const obj = action as Record<string, unknown>;
  return Array.isArray(obj.fields) ? { ...obj, fields: normalizeFieldArray(obj.fields) } : obj;
}

function normalizeForeignKeyFields(pageDsl: Record<string, unknown>) {
  const table = (pageDsl.table as Record<string, unknown> | undefined) ?? {};
  const modal = (pageDsl.modal as Record<string, unknown> | undefined) ?? {};
  return {
    ...pageDsl,
    filters: normalizeFieldArray(pageDsl.filters),
    toolbar: Array.isArray(pageDsl.toolbar) ? pageDsl.toolbar.map(normalizeActionFields) : pageDsl.toolbar,
    table: {
      ...table,
      columns: normalizeFieldArray(table.columns),
      rowActions: Array.isArray(table.rowActions) ? table.rowActions.map(normalizeActionFields) : table.rowActions,
    },
    modal: {
      ...modal,
      fields: normalizeFieldArray(modal.fields),
    },
  };
}

function mergeActionRefs(actions: unknown, actionMap: Map<string, Record<string, unknown>>) {
  if (!Array.isArray(actions)) return actions;
  return actions.map((action) => {
    if (!action || typeof action !== "object") return action;
    const ref = action as Record<string, unknown>;
    const actionCode = String(ref.actionCode ?? "");
    const full = actionMap.get(actionCode);
    return full ? { ...full, ...ref, actionType: full.actionType ?? ref.actionType, type: ref.type ?? full.actionType } : ref;
  });
}

function mergePageActions(pageDsl: Record<string, unknown>, actionMap: Map<string, Record<string, unknown>>) {
  const toolbar = dedupeActionRefs(mergeActionRefs(pageDsl.toolbar, actionMap));
  const table = (pageDsl.table as Record<string, unknown> | undefined) ?? {};
  const rowActions = mergeActionRefs(table.rowActions, actionMap);
  return { ...pageDsl, toolbar, table: { ...table, rowActions } };
}

function dedupeActionRefs(actions: unknown) {
  if (!Array.isArray(actions)) return actions;
  const result: unknown[] = [];
  const seen = new Map<string, number>();
  for (const action of actions) {
    if (!action || typeof action !== "object" || Array.isArray(action)) {
      result.push(action);
      continue;
    }
    const ref = action as Record<string, unknown>;
    const actionCode = String(ref.actionCode ?? "");
    if (!actionCode) {
      result.push(action);
      continue;
    }
    const existingIndex = seen.get(actionCode);
    if (existingIndex == null) {
      seen.set(actionCode, result.length);
      result.push(action);
      continue;
    }
    const existing = result[existingIndex] as Record<string, unknown>;
    const existingIsImport = existing.type === "import" || existing.actionType === "import" || Boolean(existing.importConfig);
    const nextIsImport = ref.type === "import" || ref.actionType === "import" || Boolean(ref.importConfig);
    result[existingIndex] = {
      ...existing,
      ...ref,
      type: existingIsImport || nextIsImport ? "import" : (ref.type ?? existing.type),
      actionType: existingIsImport || nextIsImport ? "import" : (ref.actionType ?? existing.actionType),
      importConfig: { ...((existing.importConfig as Record<string, unknown> | undefined) ?? {}), ...((ref.importConfig as Record<string, unknown> | undefined) ?? {}) },
    };
  }
  return result;
}

async function enrichImportConfigs(pageDsl: Record<string, unknown>, scope: "admin" | "tenant", schemaName?: string) {
  const toolbar = Array.isArray(pageDsl.toolbar) ? pageDsl.toolbar as Array<Record<string, unknown>> : [];
  const importCodes = toolbar
    .map((action) => (action.importConfig as Record<string, unknown> | undefined)?.importCode)
    .filter((code): code is string => typeof code === "string" && code.length > 0);
  if (importCodes.length === 0) return pageDsl;

  const { rows } = await pool.query(
    `select import_code, dsl_json from admin.import_dsl
     where import_code = any($1) and status = 'active' and deleted = false
       and ((schema_scope = $2 and coalesce(schema_name,'') = coalesce($3,''))
         or (schema_scope = 'tenant_default' and $2 = 'tenant'))
     order by case when schema_scope = $2 then 0 else 1 end`,
    [importCodes, scope, schemaName ?? null]
  );
  const configs = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    if (!configs.has(row.import_code)) configs.set(row.import_code, row.dsl_json as Record<string, unknown>);
  }
  if (configs.size === 0) return pageDsl;

  return {
    ...pageDsl,
    toolbar: toolbar.map((action) => {
      const importConfig = action.importConfig as Record<string, unknown> | undefined;
      const importCode = importConfig?.importCode;
      if (typeof importCode !== "string") return action;
      const stored = configs.get(importCode);
      if (!stored) return action;
      return { ...action, importConfig: { ...stored, ...importConfig } };
    }),
  };
}
