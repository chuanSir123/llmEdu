import { randomUUID } from "node:crypto";
import { pool, withClient } from "../db/pool.js";
import { collectBusinessEventRelatedFeatureCodes, syncSkillMd } from "../agent/skill-md.service.js";
import { qIdent } from "../db/schema-resolver.js";

export async function createDraftVersion(input: {
  schemaScope: string;
  schemaName?: string;
  targetType: string;
  targetCode: string;
  moduleCode?: string;
  featureCode?: string;
  changeSummary: string;
  diff: unknown;
  snapshot: unknown;
}) {
  const { rows } = await pool.query(
    `select coalesce(max(version_no), 0) + 1 as next_version
     from admin.dsl_version where schema_scope = $1 and coalesce(schema_name,'') = coalesce($2,'') and target_type = $3 and target_code = $4`,
    [input.schemaScope, input.schemaName ?? null, input.targetType, input.targetCode]
  );
  const id = randomUUID();
  await pool.query(
    `insert into admin.dsl_version(id, schema_scope, schema_name, target_type, target_code, module_code, feature_code, version_no, status, change_type, change_summary, diff_json, snapshot_json, created_by_agent)
     values($1,$2,$3,$4,$5,$6,$7,$8,'draft','update',$9,$10,$11,true)`,
    [
      id,
      input.schemaScope,
      input.schemaName ?? null,
      input.targetType,
      input.targetCode,
      input.moduleCode ?? null,
      input.featureCode ?? null,
      Number(rows[0].next_version),
      input.changeSummary,
      JSON.stringify(input.diff),
      JSON.stringify(input.snapshot)
    ]
  );
  return { id, versionNo: Number(rows[0].next_version), status: "draft" };
}

export const DSL_TABLE_MAP: Record<string, string> = {
  page: "admin.page_dsl",
  api: "admin.api_dsl",
  action: "admin.action_dsl",
  skill: "admin.skill_registry",
  import: "admin.import_dsl",
  report: "admin.report_dsl",
  print_template: "admin.print_template",
};

type BundleSnapshotItem = {
  targetType: string;
  targetCode: string;
  snapshot: Record<string, unknown>;
  previousSnapshot?: Record<string, unknown> | null;
  diff?: unknown;
};

type DslSource = {
  table: string;
  targetType: string;
  codeCol: string;
  contentCol: string;
};

function appendInsertColumn(cols: string[], vals: unknown[], col: string, val: unknown) {
  if (val == null || cols.includes(col)) return;
  cols.push(col);
  vals.push(val);
}

function appendDslMetadata(cols: string[], vals: unknown[], src: Record<string, unknown>) {
  for (const col of ["module_code", "feature_code", "api_type", "action_type", "page_code", "page_kind", "route_path"]) {
    appendInsertColumn(cols, vals, col, src[col]);
  }
}

function deriveDslMetadata(targetType: string, targetCode: string, snap: Record<string, unknown>): Record<string, unknown> {
  const dsl = (snap.dsl_json && typeof snap.dsl_json === "object" && !Array.isArray(snap.dsl_json))
    ? snap.dsl_json as Record<string, unknown>
    : {};
  if (targetType === "page") {
    return {
      page_name: dsl.title ?? dsl.pageName ?? targetCode,
      page_kind: dsl.pageKind ?? "business",
      module_code: dsl.moduleCode ?? "custom",
      feature_code: dsl.featureCode ?? targetCode,
      route_path: dsl.routePath ?? `/app/${targetCode}`,
    };
  }
  if (targetType === "api") {
    return {
      api_name: dsl.apiName ?? targetCode,
      api_type: dsl.apiType ?? dsl.operation ?? "query",
      module_code: dsl.moduleCode ?? "custom",
      feature_code: dsl.featureCode ?? targetCode.replace(/\.(query|detail|create|update|delete)$/, ""),
    };
  }
  if (targetType === "action") {
    const pageCode = String(dsl.pageCode ?? targetCode.replace(/\.[^.]+$/, ""));
    return {
      action_name: dsl.actionName ?? dsl.label ?? targetCode,
      action_type: dsl.actionType ?? dsl.type ?? "open_modal",
      page_code: pageCode,
      module_code: dsl.moduleCode ?? "custom",
      feature_code: dsl.featureCode ?? pageCode,
    };
  }
  if (targetType === "skill") {
    return {
      skill_name: targetCode,
      module_code: "custom",
      feature_code: targetCode.replace(/^skill_/, ""),
    };
  }
  return {};
}

export async function createDraftBundleVersion(input: {
  schemaScope: string;
  schemaName?: string;
  changeSummary: string;
  items: BundleSnapshotItem[];
}) {
  const { rows } = await pool.query(
    `select coalesce(max(version_no), 0) + 1 as next_version
     from admin.dsl_version where schema_scope = $1 and coalesce(schema_name,'') = coalesce($2,'') and target_type = 'bundle'`,
    [input.schemaScope, input.schemaName ?? null]
  );
  const id = randomUUID();
  await pool.query(
    `insert into admin.dsl_version(id, schema_scope, schema_name, target_type, target_code, version_no, status, change_type, change_summary, diff_json, snapshot_json, created_by_agent, batch_id)
     values($1,$2,$3,'bundle',$4,$5,'draft','update',$6,$7,$8,true,$1)`,
    [
      id,
      input.schemaScope,
      input.schemaName ?? null,
      `bundle_${id}`,
      Number(rows[0].next_version),
      input.changeSummary,
      JSON.stringify({ items: input.items.map((item) => item.diff ?? { targetType: item.targetType, targetCode: item.targetCode }) }),
      JSON.stringify({ items: input.items }),
    ]
  );
  return { id, versionNo: Number(rows[0].next_version), status: "draft" };
}

const DSL_SOURCES: DslSource[] = [
  { table: "admin.page_dsl", targetType: "page", codeCol: "page_code", contentCol: "dsl_json" },
  { table: "admin.api_dsl", targetType: "api", codeCol: "api_code", contentCol: "dsl_json" },
  { table: "admin.action_dsl", targetType: "action", codeCol: "action_code", contentCol: "dsl_json" },
  { table: "admin.skill_registry", targetType: "skill", codeCol: "skill_code", contentCol: "skill_md_content" },
  { table: "admin.import_dsl", targetType: "import", codeCol: "import_code", contentCol: "dsl_json" },
  { table: "admin.report_dsl", targetType: "report", codeCol: "report_code", contentCol: "dsl_json" },
  { table: "admin.print_template", targetType: "print_template", codeCol: "template_code", contentCol: "dsl_json" },
  { table: "admin.business_rule", targetType: "business_rule", codeCol: "rule_code", contentCol: "rule_json" },
];

function mapFieldTypeToSqlType(type: unknown) {
  switch (String(type ?? "text")) {
    case "number": return "numeric";
    case "integer": return "int";
    case "date": return "date";
    case "datetime": return "timestamptz";
    case "boolean": return "boolean";
    default: return "text";
  }
}

function safeName(value: unknown, label: string) {
  const text = String(value ?? "");
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(text)) throw Object.assign(new Error(`${label} 命名不安全: ${text}`), { statusCode: 400 });
  return text;
}

async function applyDbResource(client: import("pg").PoolClient, schemaName: string, resource: Record<string, unknown>) {
  const operation = String(resource.operation ?? "");
  const tableName = safeName(resource.tableName, "表");
  const fields = Array.isArray(resource.fields) ? resource.fields as Array<Record<string, unknown>> : [];
  if (operation === "create_table") {
    const cols = [
      `"id" text primary key`,
      ...fields.map((field) => `${qIdent(safeName(field.key, "字段"))} ${mapFieldTypeToSqlType(field.type)}${field.required ? " not null" : ""}`),
      `"ext_json" jsonb not null default '{}'::jsonb`,
      `"created_at" timestamptz not null default now()`,
      `"updated_at" timestamptz not null default now()`,
      `"created_by" text`,
      `"updated_by" text`,
      `"deleted" boolean not null default false`,
    ];
    await client.query(`create table if not exists ${qIdent(schemaName)}.${qIdent(tableName)} (${cols.join(", ")})`);
    return;
  }
  if (operation === "add_field") {
    for (const field of fields) {
      await client.query(
        `alter table ${qIdent(schemaName)}.${qIdent(tableName)} add column if not exists ${qIdent(safeName(field.key, "字段"))} ${mapFieldTypeToSqlType(field.type)}`
      );
    }
  }
}

async function upsertResourceDsl(
  client: import("pg").PoolClient,
  table: string,
  codeCol: string,
  nameCol: string,
  schemaScope: string,
  schemaName: string | null,
  targetCode: string,
  resource: Record<string, unknown>,
) {
  const name = String(resource.title ?? resource.name ?? resource.importName ?? resource.reportName ?? targetCode);
  const updateResult = await client.query(
    `update ${table} set dsl_json = $1, ${nameCol} = $2, status = 'active', updated_at = now()
     where ${codeCol} = $3 and schema_scope = $4 and coalesce(schema_name,'') = coalesce($5,'') and status = 'active' and deleted = false`,
    [JSON.stringify(resource), name, targetCode, schemaScope, schemaName]
  );
  if (updateResult.rowCount === 0) {
    await client.query(
      `insert into ${table}(id, ${codeCol}, ${nameCol}, schema_scope, schema_name, dsl_json, status, deleted)
       values($1,$2,$3,$4,$5,$6,'active',false)`,
      [randomUUID(), targetCode, name, schemaScope, schemaName, JSON.stringify(resource)]
    );
  }
}

async function upsertFeatureResource(
  client: import("pg").PoolClient,
  schemaName: string | null,
  resource: Record<string, unknown>,
) {
  const featureCode = safeName(resource.featureCode, "功能");
  const moduleCode = safeName(resource.moduleCode, "模块");
  const pageCode = safeName(resource.pageCode ?? featureCode, "页面");
  const featureName = String(resource.featureName ?? resource.title ?? featureCode);
  await client.query(
    `insert into admin.module_registry(id, module_code, module_name, module_group, description, default_enabled, sort_no, status)
     values($1,$2,$3,'tenant',$4,true,999,'ACTIVE')
     on conflict (module_code) do update set status = 'ACTIVE', deleted = false`,
    [randomUUID(), moduleCode, String(resource.moduleName ?? moduleCode), String(resource.moduleDescription ?? "AI 定制模块")]
  );
  await client.query(
    `insert into admin.feature_registry(id, module_code, feature_code, feature_name, page_code, description, default_enabled, sort_no, status)
     values($1,$2,$3,$4,$5,$6,true,999,'ACTIVE')
     on conflict (feature_code) do update set feature_name = EXCLUDED.feature_name, page_code = EXCLUDED.page_code, description = EXCLUDED.description, status = 'ACTIVE', deleted = false`,
    [randomUUID(), moduleCode, featureCode, featureName, pageCode, String(resource.description ?? "AI 定制功能")]
  );
  if (schemaName) {
    const { rows: tenantRows } = await client.query(`select id from admin.tenant_manage where schema_name = $1 limit 1`, [schemaName]);
    const tenantId = tenantRows[0]?.id ?? schemaName;
    await client.query(
      `insert into admin.tenant_feature_subscription(id, tenant_id, schema_name, module_code, feature_code, enabled)
       values($1,$2,$3,$4,$5,true)
       on conflict (schema_name, feature_code) do update set enabled = true, deleted = false`,
      [randomUUID(), tenantId, schemaName, moduleCode, featureCode]
    );
    await grantFeaturePageAccess(client, schemaName, pageCode);
  }
}


async function upsertDictionaryItem(client: import("pg").PoolClient, schemaName: string | undefined, resource: Record<string, unknown>) {
  if (!schemaName) throw Object.assign(new Error("dictionary 变更必须有租户 schema"), { statusCode: 400 });
  const dictCode = String(resource.dictCode ?? resource.dict_code ?? "").trim();
  const itemValue = String(resource.itemValue ?? resource.item_value ?? "").trim();
  const itemLabel = String(resource.itemLabel ?? resource.item_label ?? "").trim();
  if (!/^[a-z][a-z0-9_]{1,80}$/.test(dictCode)) throw Object.assign(new Error(`数据字典编码不合法: ${dictCode}`), { statusCode: 400 });
  if (!/^[A-Z][A-Z0-9_]{1,80}$/.test(itemValue)) throw Object.assign(new Error(`字典项值不合法: ${itemValue}`), { statusCode: 400 });
  if (!itemLabel) throw Object.assign(new Error("字典项中文名不能为空"), { statusCode: 400 });
  const { rows: systemRows } = await client.query(`select id from admin.dictionary_item where dict_code = $1 and item_value = $2 and is_system = true and deleted = false limit 1`, [dictCode, itemValue]);
  if (systemRows[0]) throw Object.assign(new Error(`系统字典项不可覆盖: ${dictCode}.${itemValue}`), { statusCode: 409 });
  await client.query(
    `insert into admin.dictionary_item(id, dict_code, item_value, item_label, schema_scope, schema_name, is_system, locked, sort_no, status, metadata_json, deleted)
     values($1,$2,$3,$4,'tenant',$5,false,false,$6,$7,$8,false)
     on conflict (dict_code, schema_name, item_value) do update
       set item_label = excluded.item_label, sort_no = excluded.sort_no, status = excluded.status, metadata_json = excluded.metadata_json, deleted = false, updated_at = now()
       where admin.dictionary_item.locked = false`,
    [randomUUID(), dictCode, itemValue, itemLabel, schemaName, Number(resource.sortNo ?? resource.sort_no ?? 100), String(resource.status ?? "ACTIVE"), JSON.stringify(resource.metadata ?? resource.metadata_json ?? {})]
  );
}

async function upsertBusinessRule(
  client: import("pg").PoolClient,
  schemaScope: string,
  schemaName: string | null,
  targetCode: string,
  resource: Record<string, unknown>,
) {
  const ruleCode = safeName(resource.ruleCode ?? targetCode, "业务规则");
  const ruleName = String(resource.ruleName ?? resource.name ?? targetCode);
  const ruleJson = { ...resource, ruleCode, ruleName };
  const update = await client.query(
    `update admin.business_rule set rule_json = $1, rule_name = $2, updated_at = now(), status = 'active', deleted = false
     where rule_code = $3 and schema_scope = $4 and coalesce(schema_name,'') = coalesce($5,'') and status = 'active' and deleted = false`,
    [JSON.stringify(ruleJson), ruleName, ruleCode, schemaScope, schemaName]
  );
  if (update.rowCount && update.rowCount > 0) return;
  await client.query(
    `insert into admin.business_rule(id, schema_scope, schema_name, rule_code, rule_name, rule_json, status, deleted)
     values($1,$2,$3,$4,$5,$6,'active',false)`,
    [randomUUID(), schemaScope, schemaName, ruleCode, ruleName, JSON.stringify(ruleJson)]
  );
}

async function upsertApprovalFlow(
  client: import("pg").PoolClient,
  schemaName: string,
  targetCode: string,
  resource: Record<string, unknown>,
) {
  const flowCode = safeName(resource.flowCode ?? targetCode, "审批流");
  const flowName = String(resource.flowName ?? resource.name ?? targetCode);
  const schema = qIdent(schemaName);
  const config = { ...resource, flowCode, flowName };
  const update = await client.query(
    `update ${schema}.approval_flow
     set name = $1, module_code = $2, status = $3, config_json = $4, organization_id = $5, updated_at = now(), deleted = false
     where flow_code = $6 and deleted = false`,
    [
      flowName,
      resource.moduleCode ?? null,
      resource.status ?? "ACTIVE",
      JSON.stringify(config),
      resource.organizationId ?? resource.organization_id ?? null,
      flowCode,
    ]
  );
  if (update.rowCount && update.rowCount > 0) return;
  await client.query(
    `insert into ${schema}.approval_flow(id, name, flow_code, module_code, status, config_json, organization_id)
     values($1,$2,$3,$4,$5,$6,$7)`,
    [
      randomUUID(),
      flowName,
      flowCode,
      resource.moduleCode ?? null,
      resource.status ?? "ACTIVE",
      JSON.stringify(config),
      resource.organizationId ?? resource.organization_id ?? null,
    ]
  );
}

async function grantFeaturePageAccess(
  client: import("pg").PoolClient,
  schemaName: string,
  pageCode: string,
) {
  const schema = qIdent(schemaName);
  const { rows: roles } = await client.query(`select id, role_code from ${schema}.role where deleted = false`);
  for (const role of roles) {
    const roleId = String(role.id);
    const roleCode = String(role.role_code ?? roleId).toLowerCase();
    const resourceId = `rr_ai_${roleCode}_${pageCode}`.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 120);
    await client.query(
      `insert into ${schema}.role_resource
         (id, role_id, resource_code, resource_type, page_code, action_code, page_permission, button_permission, data_permission, field_permission)
       select $1,$2,$3,'page',$3,null,'read','[]'::jsonb,'self_only','{}'::jsonb
       where not exists (
         select 1 from ${schema}.role_resource
         where role_id = $2 and page_code = $3 and resource_type = 'page' and deleted = false
       )
       on conflict (id) do nothing`,
      [resourceId, roleId, pageCode]
    );
  }
}

async function loadCurrentBundleItems(client: import("pg").PoolClient, schemaName: string, options: { selectedFeatureCodes?: string[] } = {}): Promise<BundleSnapshotItem[]> {
  const selectedFeatures = new Set((options.selectedFeatureCodes ?? []).filter(Boolean));
  const { rows: selectedPageRows } = selectedFeatures.size > 0
    ? await client.query(`select page_code from admin.feature_registry where feature_code = any($1::text[]) and deleted = false`, [[...selectedFeatures]])
    : { rows: [] };
  const selectedPages = new Set(selectedPageRows.map((row: { page_code: string }) => String(row.page_code)));
  const items: BundleSnapshotItem[] = [];
  for (const source of DSL_SOURCES) {
    const { rows } = await client.query(
      `select * from ${source.table}
       where status = 'active' and deleted = false
         and ((schema_scope = 'tenant' and schema_name = $1) or (schema_scope = 'tenant' and schema_name = 'demo_school'))
       order by case when schema_scope = 'tenant' and schema_name = $1 then 0 when schema_scope = 'tenant' and schema_name = 'demo_school' then 1 else 2 end`,
      [schemaName]
    );
    const seen = new Set<string>();
    for (const row of rows) {
      const targetCode = String(row[source.codeCol]);
      if (seen.has(targetCode)) continue;
      if (!tenantDslRowEnabledForSelection(source.targetType, row, selectedFeatures, selectedPages)) continue;
      seen.add(targetCode);
      items.push({
        targetType: source.targetType,
        targetCode,
        snapshot: source.targetType === "skill"
          ? { skill_md_content: row[source.contentCol] }
          : source.targetType === "import" || source.targetType === "report" || source.targetType === "print_template" || source.targetType === "business_rule"
            ? { resource_json: row[source.contentCol] }
            : { dsl_json: row[source.contentCol] },
      });
    }
  }
  return items;
}

async function applySnapshotItem(
  client: import("pg").PoolClient,
  schemaScope: string,
  schemaName: string | null,
  item: BundleSnapshotItem,
) {
  if (item.targetType === "db_schema") {
    if (!schemaName) throw Object.assign(new Error("db_schema 变更必须有租户 schema"), { statusCode: 400 });
    const resource = item.snapshot?.resource_json as Record<string, unknown> | undefined;
    if (resource) await applyDbResource(client, schemaName, resource);
    return;
  }
  if (item.targetType === "import") {
    await upsertResourceDsl(client, "admin.import_dsl", "import_code", "import_name", schemaScope, schemaName, item.targetCode, item.snapshot?.resource_json as Record<string, unknown> ?? {});
    return;
  }
  if (item.targetType === "report") {
    await upsertResourceDsl(client, "admin.report_dsl", "report_code", "report_name", schemaScope, schemaName, item.targetCode, item.snapshot?.resource_json as Record<string, unknown> ?? {});
    return;
  }
  if (item.targetType === "print_template") {
    await upsertResourceDsl(client, "admin.print_template", "template_code", "template_name", schemaScope, schemaName, item.targetCode, item.snapshot?.resource_json as Record<string, unknown> ?? {});
    return;
  }
  if (item.targetType === "business_rule") {
    await upsertBusinessRule(client, schemaScope, schemaName, item.targetCode, item.snapshot?.resource_json as Record<string, unknown> ?? {});
    return;
  }
  if (item.targetType === "dictionary") {
    await upsertDictionaryItem(client, schemaName ?? undefined, item.snapshot?.resource_json as Record<string, unknown> ?? {});
    return;
  }
  if (item.targetType === "approval_flow") {
    if (!schemaName) throw Object.assign(new Error("approval_flow 变更必须有租户 schema"), { statusCode: 400 });
    await upsertApprovalFlow(client, schemaName, item.targetCode, item.snapshot?.resource_json as Record<string, unknown> ?? {});
    return;
  }
  if (item.targetType === "permission_policy") {
    if (!schemaName) throw Object.assign(new Error("permission_policy 变更必须有租户 schema"), { statusCode: 400 });
    await applyPermissionPolicy(client, schemaName, item.snapshot?.resource_json as Record<string, unknown> ?? {});
    return;
  }
  if (item.targetType === "feature") {
    await upsertFeatureResource(client, schemaName, item.snapshot?.resource_json as Record<string, unknown> ?? {});
    return;
  }
  const dslTable = DSL_TABLE_MAP[item.targetType];
  if (!dslTable) return;
  const snap = item.snapshot ?? {};
  const setClauses: string[] = ["status = 'active'", "updated_at = now()"];
  const values: unknown[] = [];
  if ("dsl_json" in snap) { setClauses.push(`dsl_json = $${values.length + 1}`); values.push(JSON.stringify(snap.dsl_json)); }
  if ("skill_md_content" in snap) { setClauses.push(`skill_md_content = $${values.length + 1}`); values.push(snap.skill_md_content); }
  values.push(schemaScope, schemaName, item.targetCode);
  const codeCol = item.targetType === "skill" ? "skill_code" : item.targetType + "_code";
  const updateResult = await client.query(
    `update ${dslTable} set ${setClauses.join(", ")} where schema_scope = $${values.length - 2} and coalesce(schema_name,'') = coalesce($${values.length - 1},'') and ${codeCol} = $${values.length} and status = 'active'`,
    values
  );
  if (updateResult.rowCount === 0 && schemaScope === "tenant" && schemaName) {
    const nameCol = item.targetType === "skill" ? "skill_name" : item.targetType + "_name";
    const insValues: unknown[] = [randomUUID(), item.targetCode, item.targetCode, schemaScope, schemaName, "active", false];
    const insCols = ["id", codeCol, nameCol, "schema_scope", "schema_name", "status", "deleted"];
    const { rows: srcRows } = await client.query(
      `select * from ${dslTable}
       where ${codeCol} = $1 and status = 'active' and deleted = false
         and ((schema_scope = 'tenant' and coalesce(schema_name,'') = coalesce($2,'')) or (schema_scope = 'tenant' and schema_name = 'demo_school'))
       order by case when schema_scope = 'tenant' and schema_name = $2 then 0 when schema_scope = 'tenant' and schema_name = 'demo_school' then 1 else 2 end
       limit 1`,
      [item.targetCode, schemaName]
    );
    const src = srcRows[0] ?? deriveDslMetadata(item.targetType, item.targetCode, snap);
    appendDslMetadata(insCols, insValues, src);
    appendInsertColumn(insCols, insValues, "dsl_json", "dsl_json" in snap ? JSON.stringify(snap.dsl_json) : null);
    appendInsertColumn(insCols, insValues, "skill_md_content", "skill_md_content" in snap ? snap.skill_md_content : null);
    await client.query(
      `insert into ${dslTable} (${insCols.join(", ")}) values (${insValues.map((_, i) => `$${i + 1}`).join(", ")})`,
      insValues
    );
  }
}

async function applyPermissionPolicy(
  client: import("pg").PoolClient,
  schemaName: string,
  policy: Record<string, unknown>,
) {
  const roleCode = String(policy.roleCode ?? "");
  const pageCode = String(policy.pageCode ?? "");
  if (!roleCode || !pageCode) throw Object.assign(new Error("权限策略缺少 roleCode/pageCode"), { statusCode: 400 });

  const schema = qIdent(schemaName);
  const { rows: roleRows } = await client.query(
    `select id from ${schema}.role where role_code = $1 and deleted = false limit 1`,
    [roleCode]
  );
  const roleId = roleRows[0]?.id as string | undefined;
  if (!roleId) throw Object.assign(new Error(`角色不存在: ${roleCode}`), { statusCode: 400 });

  const buttonPermission = Array.isArray(policy.buttonPermission) ? policy.buttonPermission.map(String) : [];
  const fieldPermission = policy.fieldPermission && typeof policy.fieldPermission === "object" && !Array.isArray(policy.fieldPermission)
    ? policy.fieldPermission
    : {};
  const dataPermission = String(policy.dataPermission ?? "self_only");
  const pagePermission = String(policy.pagePermission ?? "read");

  const update = await client.query(
    `update ${schema}.role_resource
     set page_permission = $1, button_permission = $2, data_permission = $3, field_permission = $4,
         resource_code = $5, resource_type = 'page', page_code = $5, updated_at = now(), deleted = false
     where role_id = $6 and page_code = $5 and resource_type = 'page'`,
    [pagePermission, JSON.stringify(buttonPermission), dataPermission, JSON.stringify(fieldPermission), pageCode, roleId]
  );
  if (update.rowCount && update.rowCount > 0) return;

  await client.query(
    `insert into ${schema}.role_resource
       (id, role_id, resource_code, resource_type, page_code, page_permission, button_permission, data_permission, field_permission)
     values ($1,$2,$3,'page',$3,$4,$5,$6,$7)`,
    [randomUUID(), roleId, pageCode, pagePermission, JSON.stringify(buttonPermission), dataPermission, JSON.stringify(fieldPermission)]
  );
}

export async function publishVersion(versionId: string, userId: string) {
  return withClient(async (client) => {
    const { rows } = await client.query(
      `select id, schema_scope, schema_name, target_type, target_code, version_no, status, snapshot_json
       from admin.dsl_version where id = $1 for update`,
      [versionId]
    );
    const ver = rows[0];
    if (!ver) throw Object.assign(new Error("版本不存在"), { statusCode: 404 });
    if (ver.status !== "draft") throw Object.assign(new Error("仅 draft 状态可发布"), { statusCode: 400 });

    if (ver.target_type === "bundle") {
      const bundle = (ver.snapshot_json ?? {}) as { items?: BundleSnapshotItem[] };
      const items = Array.isArray(bundle.items) ? bundle.items : [];
      await client.query(
        `update admin.dsl_version set status = 'archived'
         where schema_scope = $1 and coalesce(schema_name,'') = coalesce($2,'') and target_type = 'bundle' and status = 'active' and id <> $3`,
        [ver.schema_scope, ver.schema_name, versionId]
      );
      for (const item of items) {
        await client.query(
          `update admin.dsl_version set status = 'archived'
           where schema_scope = $1 and coalesce(schema_name,'') = coalesce($2,'') and target_type = $3 and target_code = $4 and status = 'active'`,
          [ver.schema_scope, ver.schema_name, item.targetType, item.targetCode]
        );
        await applySnapshotItem(client, ver.schema_scope, ver.schema_name, item);
      }
      if (ver.schema_scope === "tenant" && ver.schema_name) {
        const fullItems = await loadCurrentBundleItems(client, ver.schema_name);
        await client.query(
          `update admin.dsl_version set status = 'active', snapshot_json = $2, published_at = now() where id = $1`,
          [versionId, JSON.stringify({ items: fullItems })]
        );
      } else {
        await client.query(`update admin.dsl_version set status = 'active', published_at = now() where id = $1`, [versionId]);
      }
      return { id: versionId, versionNo: Number(ver.version_no), status: "active", schemaScope: ver.schema_scope, schemaName: ver.schema_name, targetType: ver.target_type, targetCode: ver.target_code };
    }

    await client.query(
      `update admin.dsl_version set status = 'archived' where schema_scope = $1 and coalesce(schema_name,'') = coalesce($2,'') and target_type = $3 and target_code = $4 and status = 'active'`,
      [ver.schema_scope, ver.schema_name, ver.target_type, ver.target_code]
    );

    const dslTable = DSL_TABLE_MAP[ver.target_type];
    if (dslTable) {
      const snapshot = ver.snapshot_json;
      if (snapshot && typeof snapshot === "object") {
        const setClauses: string[] = ["status = 'active'", "updated_at = now()"];
        const values: unknown[] = [];
        const snap = snapshot as Record<string, unknown>;
        if ("dsl_json" in snap) { setClauses.push(`dsl_json = $${values.length + 1}`); values.push(JSON.stringify(snap.dsl_json)); }
        if ("skill_md_content" in snap) { setClauses.push(`skill_md_content = $${values.length + 1}`); values.push(snap.skill_md_content); }
        values.push(ver.schema_scope, ver.schema_name, ver.target_code);
        const codeCol = ver.target_type === "skill" ? "skill_code" : ver.target_type + "_code";
        const updateResult = await client.query(
          `update ${dslTable} set ${setClauses.join(", ")} where schema_scope = $${values.length - 2} and coalesce(schema_name,'') = coalesce($${values.length - 1},'') and ${codeCol} = $${values.length} and status = 'active'`,
          values
        );
        if (updateResult.rowCount === 0 && ver.schema_scope === "tenant" && ver.schema_name) {
          const codeCol = ver.target_type === "skill" ? "skill_code" : ver.target_type + "_code";
          const nameCol = ver.target_type === "skill" ? "skill_name" : ver.target_type + "_name";
          const insValues: unknown[] = [randomUUID(), ver.target_code, `${ver.target_code}`, ver.schema_scope, ver.schema_name, "active", false];
          const insCols = ["id", codeCol, nameCol, "schema_scope", "schema_name", "status", "deleted"];
          const { rows: srcRows } = await client.query(
            `select * from ${dslTable}
             where ${codeCol} = $1 and status = 'active' and deleted = false
               and ((schema_scope = 'tenant' and coalesce(schema_name,'') = coalesce($2,'')) or (schema_scope = 'tenant' and schema_name = 'demo_school'))
             order by case when schema_scope = 'tenant' and schema_name = $2 then 0 when schema_scope = 'tenant' and schema_name = 'demo_school' then 1 else 2 end
             limit 1`,
            [ver.target_code, ver.schema_name]
          );
          appendDslMetadata(insCols, insValues, srcRows[0] ?? deriveDslMetadata(ver.target_type, ver.target_code, snap));
          appendInsertColumn(insCols, insValues, "dsl_json", "dsl_json" in snap ? JSON.stringify(snap.dsl_json) : null);
          appendInsertColumn(insCols, insValues, "skill_md_content", "skill_md_content" in snap ? snap.skill_md_content : null);
          await client.query(
            `insert into ${dslTable} (${insCols.join(", ")}) values (${insValues.map((_, i) => `$${i + 1}`).join(", ")})`,
            insValues
          );
        }
      }
    }

    await client.query(
      `update admin.dsl_version set status = 'active', published_at = now() where id = $1`,
      [versionId]
    );

    return { id: versionId, versionNo: Number(ver.version_no), status: "active", schemaScope: ver.schema_scope, schemaName: ver.schema_name, targetType: ver.target_type, targetCode: ver.target_code };
  });
}

export async function publishVersionAndSyncSkillMd(versionId: string, userId: string) {
  const result = await publishVersion(versionId, userId);
  if (result.targetType === "bundle") {
    const { rows } = await pool.query(`select snapshot_json from admin.dsl_version where id = $1`, [versionId]);
    const items = ((rows[0]?.snapshot_json ?? {}) as { items?: BundleSnapshotItem[] }).items ?? [];
    const schemaName = result.schemaName ?? "demo_school";
    const features = new Set<string>();
    for (const item of items) {
      if (item.targetType === "page") features.add(item.targetCode);
      if (item.targetType === "api" || item.targetType === "action") {
        features.add(item.targetCode.replace(/\.(query|detail|create|update|delete)$/, ""));
      }
      if (item.targetType === "business_rule") {
        const resource = ((item.snapshot as Record<string, unknown> | undefined)?.resource_json ?? item.snapshot) as Record<string, unknown> | undefined;
        for (const featureCode of collectBusinessEventRelatedFeatureCodes(resource ?? {})) features.add(featureCode);
      }
    }
    for (const featureCode of features) {
      try {
        await syncSkillMd(schemaName, featureCode);
      } catch (err) {
        console.warn("[Version] SKILL.md sync failed after bundle publish for %s: %s", featureCode, err instanceof Error ? err.message : String(err));
      }
    }
    return result;
  }
  if (result.targetType === "page" || result.targetType === "api" || result.targetType === "action") {
    const featureCode = result.targetCode.replace(/\.(query|detail|create|update|delete)$/, "");
    const schemaName = result.schemaName ?? "demo_school";
    try {
      await syncSkillMd(schemaName, featureCode);
    } catch (err) {
      console.warn("[Version] SKILL.md sync failed after publish for %s: %s", featureCode, err instanceof Error ? err.message : String(err));
    }
  }
  if (result.targetType === "business_rule") {
    const schemaName = result.schemaName ?? "demo_school";
    const { rows } = await pool.query(
      `select rule_json from admin.business_rule
       where rule_code = $1 and status = 'active' and deleted = false
         and ((schema_scope = 'tenant' and schema_name = $2) or schema_scope = 'tenant_default')
       order by case when schema_scope = 'tenant' then 0 else 1 end
       limit 1`,
      [result.targetCode, schemaName]
    );
    for (const featureCode of collectBusinessEventRelatedFeatureCodes((rows[0]?.rule_json ?? {}) as Record<string, unknown>)) {
      try {
        await syncSkillMd(schemaName, featureCode);
      } catch (err) {
        console.warn("[Version] SKILL.md sync failed after business rule publish for %s: %s", featureCode, err instanceof Error ? err.message : String(err));
      }
    }
  }
  return result;
}

export async function rollbackVersion(versionId: string, userId: string) {
  return withClient(async (client) => {
    const { rows } = await client.query(
      `select id, schema_scope, schema_name, target_type, target_code, version_no, status, snapshot_json
       from admin.dsl_version where id = $1 for update`,
      [versionId]
    );
    const ver = rows[0];
    if (!ver) throw Object.assign(new Error("版本不存在"), { statusCode: 404 });
    if (ver.status !== "archived") throw Object.assign(new Error("仅 archived 状态可回滚"), { statusCode: 400 });

    const { rows: maxRows } = await client.query(
      `select coalesce(max(version_no), 0) + 1 as next_version from admin.dsl_version where schema_scope = $1 and coalesce(schema_name,'') = coalesce($2,'') and target_type = $3 and target_code = $4`,
      [ver.schema_scope, ver.schema_name, ver.target_type, ver.target_code]
    );
    const newVersionNo = Number(maxRows[0].next_version);
    const newId = randomUUID();

    await client.query(
      `update admin.dsl_version set status = 'archived' where schema_scope = $1 and coalesce(schema_name,'') = coalesce($2,'') and target_type = $3 and target_code = $4 and status = 'active'`,
      [ver.schema_scope, ver.schema_name, ver.target_type, ver.target_code]
    );

    await client.query(
      `insert into admin.dsl_version(id, schema_scope, schema_name, target_type, target_code, version_no, status, change_type, change_summary, diff_json, snapshot_json, rollback_from_version_id, created_by_user_id)
       values($1,$2,$3,$4,$5,$6,'active','rollback',$7,'{}',$8,$9,$10)`,
      [newId, ver.schema_scope, ver.schema_name, ver.target_type, ver.target_code, newVersionNo, `回滚至版本 ${ver.version_no}`, JSON.stringify(ver.snapshot_json), ver.id, userId]
    );

    const dslTable = DSL_TABLE_MAP[ver.target_type];
    if (dslTable) {
      const snapshot = ver.snapshot_json;
      if (snapshot && typeof snapshot === "object") {
        const setClauses: string[] = ["status = 'active'", "updated_at = now()"];
        const values: unknown[] = [];
        const snap = snapshot as Record<string, unknown>;
        if ("dsl_json" in snap) { setClauses.push(`dsl_json = $${values.length + 1}`); values.push(JSON.stringify(snap.dsl_json)); }
        if ("skill_md_content" in snap) { setClauses.push(`skill_md_content = $${values.length + 1}`); values.push(snap.skill_md_content); }
        values.push(ver.schema_scope, ver.schema_name, ver.target_code);
        await client.query(
          `update ${dslTable} set ${setClauses.join(", ")} where schema_scope = $${values.length - 2} and coalesce(schema_name,'') = coalesce($${values.length - 1},'') and ${ver.target_type === 'skill' ? 'skill_code' : ver.target_type + '_code'} = $${values.length} and status = 'active'`,
          values
        );
      }
    }

    return { id: newId, versionNo: newVersionNo, status: "active", rollbackFrom: ver.id };
  });
}

export async function rejectVersion(versionId: string, reason: string, userId: string) {
  const { rows } = await pool.query(
    `select id, status from admin.dsl_version where id = $1`,
    [versionId]
  );
  const ver = rows[0];
  if (!ver) throw Object.assign(new Error("版本不存在"), { statusCode: 404 });
  if (ver.status !== "draft") throw Object.assign(new Error("仅 draft 状态可驳回"), { statusCode: 400 });

  await pool.query(
    `update admin.dsl_version set status = 'rejected', change_summary = $1 where id = $2`,
    [reason || "驳回", versionId]
  );
  return { id: versionId, status: "rejected" };
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item)).filter(Boolean);
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function resourceFeatureHints(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => resourceFeatureHints(item));
  if (!value || typeof value !== "object") return [];
  const resource = value as Record<string, unknown>;
  const direct = stringList(resource.featureCodes ?? resource.relatedFeatureCodes);
  const featureCode = String(resource.featureCode ?? resource.feature_code ?? "");
  const pageCode = String(resource.pageCode ?? resource.page_code ?? "");
  const targetPage = String(resource.targetPageCode ?? resource.targetPage ?? "");
  const targetAction = String(resource.targetAction ?? resource.actionCode ?? resource.action_code ?? "");
  const targetApi = String(resource.targetApi ?? resource.apiCode ?? resource.api_code ?? "");
  return [featureCode, pageCode, targetPage, targetAction.split(".")[0], targetApi.split(".")[0], ...direct].filter(Boolean);
}

function featureHintsFromResource(resource: Record<string, unknown>): string[] {
  const trigger = objectValue(resource.trigger);
  return [
    ...resourceFeatureHints(resource),
    ...resourceFeatureHints(trigger),
    ...resourceFeatureHints(resource.listeners),
    ...resourceFeatureHints(resource.actions),
  ];
}

function tenantDslRowEnabledForSelection(
  targetType: string,
  row: Record<string, unknown>,
  selectedFeatures: Set<string>,
  selectedPages: Set<string>,
) {
  if (selectedFeatures.size === 0) return true;
  const featureCode = String(row.feature_code ?? "");
  const pageCode = String(row.page_code ?? "");
  if (featureCode && selectedFeatures.has(featureCode)) return true;
  if (pageCode && selectedPages.has(pageCode)) return true;
  if (targetType === "page" && selectedPages.has(String(row.page_code ?? row.page_code ?? ""))) return true;
  if (targetType === "skill" && selectedFeatures.has(String(row.skill_code ?? "").replace(/^skill_/, ""))) return true;
  const content = row.dsl_json ?? row.rule_json;
  const resource = objectValue(content);
  return featureHintsFromResource(resource).some((code) => selectedFeatures.has(code) || selectedPages.has(code));
}

export async function initializeTenantVersion(schemaName: string, options: { selectedFeatureCodes?: string[]; templateSchemaName?: string } = {}) {
  return withClient(async (client) => {
    const selectedFeatures = new Set((options.selectedFeatureCodes ?? []).filter(Boolean));
    const { rows: selectedPageRows } = selectedFeatures.size > 0
      ? await client.query(`select feature_code, page_code from admin.feature_registry where feature_code = any($1::text[]) and deleted = false`, [[...selectedFeatures]])
      : { rows: [] };
    const selectedPages = new Set(selectedPageRows.map((row: { page_code: string }) => String(row.page_code)));
    const dslTables = [
      { table: "admin.page_dsl", type: "page", codeCol: "page_code" },
      { table: "admin.api_dsl", type: "api", codeCol: "api_code" },
      { table: "admin.action_dsl", type: "action", codeCol: "action_code" },
      { table: "admin.skill_registry", type: "skill", codeCol: "skill_code" },
      { table: "admin.import_dsl", type: "import", codeCol: "import_code" },
      { table: "admin.report_dsl", type: "report", codeCol: "report_code" },
      { table: "admin.print_template", type: "print_template", codeCol: "template_code" },
      { table: "admin.business_rule", type: "business_rule", codeCol: "rule_code" },
    ];
    const templateSchema = options.templateSchemaName ?? "demo_school";
    for (const dt of dslTables) {
      const { rows: dslRows } = await client.query(
        `select * from ${dt.table}
         where status = 'active' and deleted = false
           and schema_scope = 'tenant' and schema_name = $1`,
        [templateSchema]
      );
      for (const dsl of dslRows) {
        if (!tenantDslRowEnabledForSelection(dt.type, dsl, selectedFeatures, selectedPages)) continue;
        const cols = Object.keys(dsl).filter(k => k !== "id" && k !== "created_at" && k !== "updated_at");
        const vals = cols.map(c => {
          const v = dsl[c];
          if (v && typeof v === "object" && !(v instanceof Date)) return JSON.stringify(v);
          return v;
        });
        const newId = randomUUID();
        const allCols = ["id", "schema_scope", "schema_name", ...cols.filter(c => c !== "schema_scope" && c !== "schema_name")];
        const allVals = [newId, "tenant", schemaName, ...cols.filter(c => c !== "schema_scope" && c !== "schema_name").map(c => {
          const idx = cols.indexOf(c);
          return vals[idx];
        })];
        const placeholders = allVals.map((_, i) => `$${i + 1}`).join(",");
        await client.query(
          `insert into ${dt.table}(${allCols.join(",")}) values(${placeholders}) on conflict (id) do nothing`,
          allVals
        );
      }
    }

    const items = await loadCurrentBundleItems(client, schemaName, { selectedFeatureCodes: [...selectedFeatures] });
    const existing = await client.query(
      `select id from admin.dsl_version where schema_scope = 'tenant' and schema_name = $1 and target_type = 'bundle' and status = 'active' and deleted = false limit 1`,
      [schemaName]
    );
    if (existing.rows[0]) return { versionIds: [existing.rows[0].id], count: 1 };

    const id = randomUUID();
    await client.query(
      `insert into admin.dsl_version(id, schema_scope, schema_name, target_type, target_code, version_no, status, change_type, change_summary, diff_json, snapshot_json, created_by_agent, batch_id)
       values($1,'tenant',$2,'bundle',$3,1,'active','init','租户初始化版本','{}',$4,false,$1)`,
      [id, schemaName, `baseline_${schemaName}`, JSON.stringify({ items })]
    );

    return { versionIds: [id], count: 1 };
  });
}

async function loadDefaultDslVersionSources(client: import("pg").PoolClient) {
  const result: Array<Record<string, unknown>> = [];
  const sources = [
    { table: "admin.page_dsl", targetType: "page", codeCol: "page_code", contentCol: "dsl_json" },
    { table: "admin.api_dsl", targetType: "api", codeCol: "api_code", contentCol: "dsl_json" },
    { table: "admin.action_dsl", targetType: "action", codeCol: "action_code", contentCol: "dsl_json" },
    { table: "admin.skill_registry", targetType: "skill", codeCol: "skill_code", contentCol: "skill_md_content" },
  ];
  for (const source of sources) {
    const { rows } = await client.query(
      `select * from ${source.table} where schema_scope = 'tenant' and schema_name = 'demo_school' and status = 'active' and deleted = false`
    );
    for (const row of rows) {
      result.push({
        target_type: source.targetType,
        target_code: row[source.codeCol],
        module_code: row.module_code ?? null,
        feature_code: row.feature_code ?? null,
        diff_json: {},
        snapshot_json: source.targetType === "skill"
          ? { skill_md_content: row[source.contentCol] }
          : { dsl_json: row[source.contentCol] },
      });
    }
  }
  return result;
}

export async function listTenantVersions(schemaName: string, filters?: { targetType?: string; targetCode?: string; status?: string }) {
  await ensureTenantBaselineBundle(schemaName);
  const conditions = ["schema_scope = 'tenant'", "schema_name = $1", "deleted = false"];
  const params: unknown[] = [schemaName];
  let idx = 2;
  const targetType = filters?.targetType ?? "bundle";
  if (targetType) { conditions.push(`target_type = $${idx}`); params.push(targetType); idx++; }
  if (filters?.targetCode) { conditions.push(`target_code = $${idx}`); params.push(filters.targetCode); idx++; }
  if (filters?.status) { conditions.push(`status = $${idx}`); params.push(filters.status); idx++; }

  const { rows } = await pool.query(
    `select id, version_no, target_type, target_code, module_code, feature_code, status, change_type, change_summary, created_at, published_at
     from admin.dsl_version where ${conditions.join(" and ")} order by version_no desc`,
    params
  );
  return rows;
}

export async function ensureTenantBaselineBundle(schemaName: string) {
  return withClient(async (client) => {
    const { rows } = await client.query(
      `select id from admin.dsl_version
       where schema_scope = 'tenant' and schema_name = $1 and target_type = 'bundle' and status = 'active' and deleted = false
       limit 1`,
      [schemaName]
    );
    if (rows[0]) return { created: false, versionId: rows[0].id };

    const items = await loadCurrentBundleItems(client, schemaName);
    if (items.length === 0) return { created: false };
    const id = randomUUID();
    await client.query(
      `insert into admin.dsl_version(id, schema_scope, schema_name, target_type, target_code, version_no, status, change_type, change_summary, diff_json, snapshot_json, created_by_agent, batch_id)
       values($1,'tenant',$2,'bundle',$3,1,'active','init','租户初始化版本','{}',$4,false,$1)`,
      [id, schemaName, `baseline_${schemaName}`, JSON.stringify({ items })]
    );
    await client.query(
      `update admin.dsl_version set version_no = version_no + 1
       where schema_scope = 'tenant' and schema_name = $1 and target_type = 'bundle' and id <> $2 and version_no >= 1`,
      [schemaName, id]
    );
    return { created: true, versionId: id, count: items.length };
  });
}

export async function refreshActiveBundleSnapshot(schemaName: string) {
  return withClient(async (client) => {
    const { rows } = await client.query(
      `select id from admin.dsl_version
       where schema_scope = 'tenant' and schema_name = $1 and target_type = 'bundle' and status = 'active' and deleted = false
       order by version_no desc limit 1`,
      [schemaName]
    );
    if (!rows[0]) return { updated: false };
    const items = await loadCurrentBundleItems(client, schemaName);
    await client.query(
      `update admin.dsl_version set snapshot_json = $1 where id = $2`,
      [JSON.stringify({ items }), rows[0].id]
    );
    return { updated: true, versionId: rows[0].id, count: items.length };
  });
}

export async function tenantRollbackVersion(input: { versionId: string; schemaName: string; userId: string }) {
  return withClient(async (client) => {
    const { rows } = await client.query(
      `select id, schema_scope, schema_name, target_type, target_code, version_no, status, snapshot_json
       from admin.dsl_version where id = $1 for update`,
      [input.versionId]
    );
    const ver = rows[0];
    if (!ver) throw Object.assign(new Error("版本不存在"), { statusCode: 404 });
    if (ver.schema_name !== input.schemaName) throw Object.assign(new Error("跨租户操作被拒绝"), { statusCode: 403 });

    const { rows: maxRows } = await client.query(
      `select coalesce(max(version_no), 0) + 1 as next_version from admin.dsl_version where schema_scope = 'tenant' and schema_name = $1 and target_type = $2`,
      [input.schemaName, ver.target_type]
    );
    const newVersionNo = Number(maxRows[0].next_version);
    const newId = randomUUID();

    await client.query(
      `update admin.dsl_version set status = 'archived' where schema_scope = 'tenant' and schema_name = $1 and target_type = $2 and status = 'active'`,
      [input.schemaName, ver.target_type]
    );

    await client.query(
      `insert into admin.dsl_version(id, schema_scope, schema_name, target_type, target_code, module_code, feature_code, version_no, status, change_type, change_summary, diff_json, snapshot_json, rollback_from_version_id, created_by_user_id)
       values($1,'tenant',$2,$3,$4,$5,$6,$7,'active','rollback',$8,'{}',$9,$10,$11)`,
      [newId, input.schemaName, ver.target_type, ver.target_code, ver.module_code ?? null, ver.feature_code ?? null, newVersionNo, `回滚至版本 ${ver.version_no}`, JSON.stringify(ver.snapshot_json), ver.id, input.userId]
    );

    if (ver.target_type === "bundle") {
      const bundle = (ver.snapshot_json ?? {}) as { items?: BundleSnapshotItem[] };
      for (const item of bundle.items ?? []) {
        await applySnapshotItem(client, "tenant", input.schemaName, item);
      }
      return { id: newId, versionNo: newVersionNo, status: "active", rollbackFrom: ver.id };
    }

    const dslTable = DSL_TABLE_MAP[ver.target_type];
    if (dslTable) {
      const snapshot = ver.snapshot_json;
      if (snapshot && typeof snapshot === "object") {
        const setClauses: string[] = ["status = 'active'", "updated_at = now()"];
        const values: unknown[] = [];
        const snap = snapshot as Record<string, unknown>;
        if ("dsl_json" in snap) { setClauses.push(`dsl_json = $${values.length + 1}`); values.push(JSON.stringify(snap.dsl_json)); }
        if ("skill_md_content" in snap) { setClauses.push(`skill_md_content = $${values.length + 1}`); values.push(snap.skill_md_content); }
        values.push("tenant", input.schemaName, ver.target_code);
        await client.query(
          `update ${dslTable} set ${setClauses.join(", ")} where schema_scope = $${values.length - 2} and coalesce(schema_name,'') = coalesce($${values.length - 1},'') and ${ver.target_type === 'skill' ? 'skill_code' : ver.target_type + '_code'} = $${values.length} and status = 'active'`,
          values
        );
      }
    }

    return { id: newId, versionNo: newVersionNo, status: "active", rollbackFrom: ver.id };
  });
}
