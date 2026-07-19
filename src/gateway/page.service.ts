import { pool } from "../db/pool.js";
import { visibleActionCodes, fieldPermissions, getDataPermissionScope } from "../permission/permission.service.js";
import type { SessionUser } from "../types.js";
import { inferForeignKeyMeta } from "../common/foreign-key-meta.js";
import { TEMPLATE_SCHEMA } from "../common/template-schema.js";
import { businessRuleEditorSchema } from "../business-rule-editor-schema.js";

export async function loadPageDsl(scope: "admin" | "tenant", pageCode: string, schemaName?: string) {
  const { rows } = await pool.query(
    `select page_code, page_name, page_kind, dsl_json, version_no
     from admin.page_dsl
     where page_code = $1 and status = 'active' and deleted = false
       and ((schema_scope = $2 and coalesce(schema_name,'') = coalesce($3,''))
         or (schema_scope = 'tenant' and schema_name = '${TEMPLATE_SCHEMA}' and $2 = 'tenant'))
     order by case when schema_scope = $2 and coalesce(schema_name,'') = coalesce($3,'') then 0 when schema_scope = 'tenant' and schema_name = '${TEMPLATE_SCHEMA}' then 1 else 2 end
     limit 1`,
    [pageCode, scope, schemaName ?? null]
  );
  if (!rows[0]) throw new Error("页面 DSL 不存在");
  return rows[0];
}

export async function loadPageFullDsl(scope: "admin" | "tenant", pageCode: string, schemaName?: string, user?: SessionUser) {
  const page = await loadPageDsl(scope, pageCode, schemaName);
  const pageKind = page.page_kind ?? (pageCode === "admin_login" || pageCode === "tenant_login" ? "public" : "shtml");

  if (pageKind === "public") {
    return { page, pageKind, actions: [], apis: [], permissions: null, activeVersion: null, tenantInfo: null };
  }

  const [actions, apis, tenantInfo, versionRows, actionPermSet, fieldPermMap, dataPermScope] = await Promise.all([
    pool.query(
      `select action_code, action_name, action_type, dsl_json from admin.action_dsl where page_code = $1 and status = 'active' and deleted = false and ((schema_scope = $2 and coalesce(schema_name,'') = coalesce($3,'')) or (schema_scope = 'tenant' and schema_name = '${TEMPLATE_SCHEMA}' and $2 = 'tenant')) order by case when schema_scope = $2 and coalesce(schema_name,'') = coalesce($3,'') then 0 when schema_scope = 'tenant' and schema_name = '${TEMPLATE_SCHEMA}' then 1 else 2 end`,
      [pageCode, scope, schemaName ?? null]
    ),
    pool.query(
      `select distinct on (api_code) api_code, api_type, dsl_json from admin.api_dsl where feature_code = (select feature_code from admin.page_dsl where page_code = $1 and status = 'active' and deleted = false order by case when schema_scope = $2 and coalesce(schema_name,'') = coalesce($3,'') then 0 when schema_scope = 'tenant' and schema_name = '${TEMPLATE_SCHEMA}' then 1 else 2 end limit 1) and status = 'active' and deleted = false and ((schema_scope = $2 and coalesce(schema_name,'') = coalesce($3,'')) or (schema_scope = 'tenant' and schema_name = '${TEMPLATE_SCHEMA}' and $2 = 'tenant')) order by api_code, case when schema_scope = $2 and coalesce(schema_name,'') = coalesce($3,'') then 0 when schema_scope = 'tenant' and schema_name = '${TEMPLATE_SCHEMA}' then 1 else 2 end`,
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
  const permittedActionCodes = !user || user.kind === "admin" || actionPermSet.has("*") ? null : actionPermSet;
  const pageDsl = await enrichImportConfigs(
    ensureBusinessRuleEditorSchema(normalizeForeignKeyFields(applyFieldPermissions(mergePageActions(page.dsl_json as Record<string, unknown>, actionMap, permittedActionCodes), fieldPermMap))),
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

function ensureBusinessRuleEditorSchema(pageDsl: Record<string, unknown>) {
  if (String(pageDsl.pageCode ?? pageDsl.page_code ?? "") !== "business_rule_list") return pageDsl;
  const modal = pageDsl.modal && typeof pageDsl.modal === "object" && !Array.isArray(pageDsl.modal) ? pageDsl.modal as Record<string, unknown> : {};
  const fields = Array.isArray(modal.fields) ? modal.fields.map((field) => {
    if (!field || typeof field !== "object" || Array.isArray(field)) return field;
    const obj = field as Record<string, unknown>;
    return obj.type === "business_rule_editor" ? { ...obj, editorSchema: obj.editorSchema ?? businessRuleEditorSchema } : obj;
  }) : modal.fields;
  return { ...pageDsl, modal: { ...modal, fields } };
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

// 字段权限落到 DSL：hidden 字段从列/弹窗/筛选中剥除，readonly 字段在表单中置为只读。
// （数据层面的剥除在 api 执行响应里做，见 main.ts 的 stripHiddenFields）
function applyFieldPermissions(pageDsl: Record<string, unknown>, fieldPermMap: Record<string, string>) {
  const entries = Object.entries(fieldPermMap ?? {});
  if (!entries.length) return pageDsl;
  const hidden = new Set(entries.filter(([, perm]) => perm === "hidden").map(([key]) => key));
  const readonly = new Set(entries.filter(([, perm]) => perm === "readonly").map(([key]) => key));
  if (!hidden.size && !readonly.size) return pageDsl;
  const mapFields = (fields: unknown) => {
    if (!Array.isArray(fields)) return fields;
    return fields
      .filter((field) => !(field && typeof field === "object" && hidden.has(String((field as Record<string, unknown>).key ?? ""))))
      .map((field) => {
        if (field && typeof field === "object" && readonly.has(String((field as Record<string, unknown>).key ?? ""))) {
          return { ...(field as Record<string, unknown>), readonly: true, computed: true };
        }
        return field;
      });
  };
  const mapActions = (actions: unknown) => {
    if (!Array.isArray(actions)) return actions;
    return actions.map((action) => {
      if (!action || typeof action !== "object") return action;
      const obj = action as Record<string, unknown>;
      return Array.isArray(obj.fields) ? { ...obj, fields: mapFields(obj.fields) } : obj;
    });
  };
  const table = (pageDsl.table as Record<string, unknown> | undefined) ?? {};
  const modal = (pageDsl.modal as Record<string, unknown> | undefined) ?? {};
  return {
    ...pageDsl,
    filters: mapFields(pageDsl.filters),
    toolbar: mapActions(pageDsl.toolbar),
    table: { ...table, columns: mapFields(table.columns), rowActions: mapActions(table.rowActions) },
    modal: { ...modal, fields: mapFields(modal.fields) },
  };
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

function mergeActionRefs(actions: unknown, actionMap: Map<string, Record<string, unknown>>, permittedActionCodes?: Set<string> | null) {
  if (!Array.isArray(actions)) return actions;
  return actions
    .filter((action) => {
      // 按钮权限落到 UI：受限角色（无 "*"）看不到未授权按钮，而不是点击后被后端拒绝
      if (!permittedActionCodes || !action || typeof action !== "object") return true;
      const actionCode = String((action as Record<string, unknown>).actionCode ?? "");
      return !actionCode || permittedActionCodes.has(actionCode);
    })
    .map((action) => {
    if (!action || typeof action !== "object") return action;
    const ref = action as Record<string, unknown>;
    const actionCode = String(ref.actionCode ?? "");
    const full = actionMap.get(actionCode);
    return full ? { ...full, ...ref, actionType: full.actionType ?? ref.actionType, type: ref.type ?? full.actionType } : ref;
  });
}

function mergePageActions(pageDsl: Record<string, unknown>, actionMap: Map<string, Record<string, unknown>>, permittedActionCodes?: Set<string> | null) {
  const toolbar = dedupeActionRefs(mergeActionRefs(pageDsl.toolbar, actionMap, permittedActionCodes));
  const table = (pageDsl.table as Record<string, unknown> | undefined) ?? {};
  const rowActions = mergeActionRefs(table.rowActions, actionMap, permittedActionCodes);
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
         or (schema_scope = 'tenant' and schema_name = '${TEMPLATE_SCHEMA}' and $2 = 'tenant'))
     order by case when schema_scope = $2 and coalesce(schema_name,'') = coalesce($3,'') then 0 when schema_scope = 'tenant' and schema_name = '${TEMPLATE_SCHEMA}' then 1 else 2 end`,
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
