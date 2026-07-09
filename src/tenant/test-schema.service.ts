import { randomUUID } from "node:crypto";
import { pool, withClient } from "../db/pool.js";
import { assertSafeIdentifier, qIdent } from "../db/schema-resolver.js";
import { executeDiffs } from "../agent/diff-executor.js";
import type { DslDiff } from "../agent/types.js";
import { DSL_TABLE_MAP } from "../version/version.service.js";
import { invalidateTableColumnsCache } from "../gateway/query-dsl-engine.js";
import { TEMPLATE_SCHEMA } from "../common/template-schema.js";

function httpError(statusCode: number, message: string) {
  return Object.assign(new Error(message), { statusCode });
}

function mapFieldTypeToSqlType(fieldType?: string): string {
  switch (fieldType) {
    case "number": return "numeric";
    case "date": return "date";
    case "datetime": return "timestamptz";
    case "boolean": return "boolean";
    default: return "text";
  }
}

export function getTestSchemaName(schemaName: string): string {
  assertSafeIdentifier(schemaName);
  const base = schemaName.endsWith("_test") ? schemaName.slice(0, -"_test".length) : schemaName;
  const testSchema = `${base}_test`;
  assertSafeIdentifier(testSchema);
  return testSchema;
}

export async function ensureTestSchema(schemaName: string): Promise<string> {
  const testSchema = getTestSchemaName(schemaName);

  const { rows: existing } = await pool.query(
    `select schema_name from admin.tenant_manage where schema_name = $1 and status = 'ACTIVE' and deleted = false`,
    [testSchema]
  );

  if (existing.length > 0) {
    await resetTestData(schemaName, testSchema);
    await ensureSubscriptions(schemaName, testSchema);
    return testSchema;
  }

  return withClient(async (client) => {
    await client.query(`create schema if not exists ${qIdent(testSchema)}`);

    const { rows: tables } = await client.query(
      `select table_name from information_schema.tables where table_schema = $1 and table_type = 'BASE TABLE' order by table_name`,
      [schemaName]
    );

    for (const t of tables) {
      const tableName = t.table_name;
      const quotedSrc = `${qIdent(schemaName)}.${tableName === "user" ? qIdent("user") : tableName}`;
      const quotedDst = `${qIdent(testSchema)}.${tableName === "user" ? qIdent("user") : tableName}`;
      await client.query(`drop table if exists ${quotedDst} cascade`);
      await client.query(`create table ${quotedDst} (like ${quotedSrc} including all)`);
    }

    for (const t of tables) {
      const tableName = t.table_name;
      const quotedSrc = `${qIdent(schemaName)}.${tableName === "user" ? qIdent("user") : tableName}`;
      const quotedDst = `${qIdent(testSchema)}.${tableName === "user" ? qIdent("user") : tableName}`;
      try {
        await client.query(`insert into ${quotedDst} select * from ${quotedSrc}`);
      } catch {
        // skip tables with constraint issues
      }
    }

    const testTenantId = `test_${schemaName}`;
    await client.query(
      `insert into admin.tenant_manage(id, schema_name, name, status, contact_phone, owner_name, expire_time)
       values($1,$2,$3,'ACTIVE',null,null,'2099-12-31T23:59:59Z')
       on conflict (schema_name) do update set status = 'ACTIVE', deleted = false`,
      [testTenantId, testSchema, `${schemaName} 测试预览`]
    );

    await ensureSubscriptions(schemaName, testSchema, client);

    return testSchema;
  });
}

async function ensureSubscriptions(schemaName: string, testSchema: string, client?: import("pg").PoolClient) {
  const testTenantId = `test_${schemaName}`;
  const q = client ? client.query.bind(client) : pool.query.bind(pool);

  const { rows: srcModules } = await q(
    `select module_code, enabled from admin.tenant_module_subscription where schema_name = $1 and enabled = true and deleted = false`,
    [schemaName]
  );
  for (const m of srcModules) {
    await q(
      `insert into admin.tenant_module_subscription(id, tenant_id, schema_name, module_code, enabled)
       values($1,$2,$3,$4,true) on conflict (id) do update set schema_name = EXCLUDED.schema_name, module_code = EXCLUDED.module_code, enabled = true`,
      [`test_mod_${m.module_code}`, testTenantId, testSchema, m.module_code]
    );
  }

  const { rows: srcFeatures } = await q(
    `select module_code, feature_code, enabled from admin.tenant_feature_subscription where schema_name = $1 and enabled = true and deleted = false`,
    [schemaName]
  );
  for (const f of srcFeatures) {
    await q(
      `insert into admin.tenant_feature_subscription(id, tenant_id, schema_name, module_code, feature_code, enabled)
       values($1,$2,$3,$4,$5,true) on conflict (id) do update set schema_name = EXCLUDED.schema_name, feature_code = EXCLUDED.feature_code, enabled = true`,
      [`test_feat_${f.feature_code}`, testTenantId, testSchema, f.module_code, f.feature_code]
    );
  }

  await q(
    `insert into admin.tenant_agent_config(id, schema_name, agent_customization_enabled)
     values($1,$2,false) on conflict (schema_name) do update set agent_customization_enabled = false`,
    [`test_agent_${schemaName}`, testSchema]
  );
}

async function resetTestData(schemaName: string, testSchema: string) {
  await withClient(async (client) => {
    // 查源 schema 的表列表（而非 testSchema），确保源 schema 新增的表也能同步
    const { rows: tables } = await client.query(
      `select table_name from information_schema.tables where table_schema = $1 and table_type = 'BASE TABLE' order by table_name`,
      [schemaName]
    );

    // 1. DROP testSchema 的所有表（cascade），清除旧表结构（包括上次定制残留的物理列）
    for (const t of tables) {
      const tableName = t.table_name;
      const quotedDst = `${qIdent(testSchema)}.${tableName === "user" ? qIdent("user") : tableName}`;
      try {
        await client.query(`drop table if exists ${quotedDst} cascade`);
      } catch {
        // skip
      }
    }

    // 2. 从源 schema 重建表结构，确保和源 schema 完全一致
    for (const t of tables) {
      const tableName = t.table_name;
      const quotedSrc = `${qIdent(schemaName)}.${tableName === "user" ? qIdent("user") : tableName}`;
      const quotedDst = `${qIdent(testSchema)}.${tableName === "user" ? qIdent("user") : tableName}`;
      await client.query(`create table ${quotedDst} (like ${quotedSrc} including all)`);
    }

    // 3. 复制数据
    for (const t of tables) {
      const tableName = t.table_name;
      const quotedSrc = `${qIdent(schemaName)}.${tableName === "user" ? qIdent("user") : tableName}`;
      const quotedDst = `${qIdent(testSchema)}.${tableName === "user" ? qIdent("user") : tableName}`;
      try {
        await client.query(`insert into ${quotedDst} select * from ${quotedSrc}`);
      } catch {
        // skip tables with constraint issues
      }
    }
  });

  // 4. 清除 testSchema 的表结构缓存（表已重建，旧缓存无效）
  invalidateTableColumnsCache(testSchema);
}

export async function writeDiffToTestSchema(
  schemaName: string,
  diffs: DslDiff[],
) {
  const testSchema = getTestSchemaName(schemaName);

  const { rows: existing } = await pool.query(
    `select schema_name from admin.tenant_manage where schema_name = $1 and status = 'ACTIVE' and deleted = false`,
    [testSchema]
  );
  if (existing.length === 0) {
    throw httpError(400, "预览环境暂时不可用，请稍后重试");
  }

  const executed = await executeDiffs(diffs, testSchema);

  const mappedDiffs = executed.map(({ diff, modifiedDslJson }) => ({
    targetType: diff.targetType,
    targetCode: diff.targetCode,
    op: diff.op,
    field: diff.field,
    fieldDef: diff.fieldDef,
    modifiedDslJson,
  }));

  await writePreviewDslToTestSchema(schemaName, mappedDiffs);
}

export async function writePreviewDslToTestSchema(
  schemaName: string,
  diffs: Array<{ targetType: string; targetCode: string; op: string; field?: string; fieldDef?: Record<string, unknown>; modifiedDslJson: unknown }>
) {
  const testSchema = getTestSchemaName(schemaName);

  for (const diff of diffs) {
    await applyResourceDiffToTestSchema(testSchema, diff);
  }

  for (const diff of diffs) {
    if (diff.op === "add_filter" && diff.field && diff.fieldDef) {
      const colType = mapFieldTypeToSqlType(diff.fieldDef.type as string | undefined);
      const targetTable = await resolveTableName(diff, testSchema);
      if (targetTable) {
        try {
          const { rows: existingColumns } = await pool.query(
            `select column_name from information_schema.columns where table_schema = $1 and table_name = $2 and column_name = $3`,
            [testSchema, targetTable, diff.field]
          );
          if (existingColumns.length > 0) continue;
          await pool.query(
            `alter table ${qIdent(testSchema)}.${qIdent(targetTable)} add column if not exists ${qIdent(diff.field)} ${colType}`
          );
        } catch {
          // column may already exist
        }
      }
    }
  }

  for (const diff of diffs) {

    if (["db_schema", "import_dsl", "report_dsl", "approval_flow", "print_template", "business_rule", "feature_registry", "permission_policy"].includes(diff.targetType)) continue;

    const typeMap: Record<string, string> = { page_dsl: "page", api_dsl: "api", action_dsl: "action", skill_registry: "skill" };
    const targetType = typeMap[diff.targetType] ?? diff.targetType;
    const dslTable = targetType === "page" ? "admin.page_dsl" : targetType === "api" ? "admin.api_dsl" : targetType === "action" ? "admin.action_dsl" : "admin.skill_registry";
    const codeCol = targetType === "skill" ? "skill_code" : targetType + "_code";
    const contentCol = targetType === "skill" ? "skill_md_content" : "dsl_json";
    const contentValue = targetType === "skill" ? diff.modifiedDslJson : JSON.stringify(diff.modifiedDslJson);

    const { rows: existing } = await pool.query(
      `select id from ${dslTable} where ${codeCol} = $1 and schema_scope = 'tenant' and schema_name = $2 and status = 'active' and deleted = false`,
      [diff.targetCode, testSchema]
    );

    if (existing.length > 0) {
      await pool.query(
        `update ${dslTable} set ${contentCol} = $1, updated_at = now() where ${codeCol} = $2 and schema_scope = 'tenant' and schema_name = $3 and status = 'active' and deleted = false`,
        [contentValue, diff.targetCode, testSchema]
      );
    } else {
      const src = await loadDslSourceRow(dslTable, codeCol, diff.targetCode, schemaName) ?? deriveDslSourceRow(targetType, diff.targetCode, diff.modifiedDslJson);

      const cols = [codeCol, "schema_scope", "schema_name", contentCol, "version_no", "status", "deleted"];
      const vals: unknown[] = [diff.targetCode, "tenant", testSchema, contentValue, 1, "active", false];

      appendDslMetadata(cols, vals, src);
      validateInsertMetadata(targetType, diff.targetCode, cols, src);

      const nameCol = targetType === "skill" ? "skill_name" : targetType + "_name";
      cols.push(nameCol);
      vals.push(src[nameCol] ?? diff.targetCode);

      cols.push("id");
      vals.push(randomUUID());

      await pool.query(
        `insert into ${dslTable}(${cols.join(", ")}) values(${vals.map((_, i) => `$${i + 1}`).join(", ")})`,
        vals
      );
    }
  }
}

function deriveDslSourceRow(targetType: string, targetCode: string, dsl: unknown): Record<string, unknown> {
  const obj = dsl && typeof dsl === "object" && !Array.isArray(dsl) ? dsl as Record<string, unknown> : {};
  if (targetType === "page") {
    return {
      page_name: obj.title ?? obj.pageName ?? targetCode,
      page_kind: obj.pageKind ?? "business",
      module_code: obj.moduleCode ?? "custom",
      feature_code: obj.featureCode ?? targetCode,
      route_path: obj.routePath ?? `/app/${targetCode}`,
    };
  }
  if (targetType === "api") {
    return {
      api_name: obj.apiName ?? targetCode,
      api_type: obj.apiType ?? obj.operation ?? "query",
      module_code: obj.moduleCode ?? "custom",
      feature_code: obj.featureCode ?? targetCode.replace(/\.(query|detail|create|update|delete)$/, ""),
    };
  }
  if (targetType === "action") {
    const pageCode = String(obj.pageCode ?? targetCode.replace(/\.[^.]+$/, ""));
    return {
      action_name: obj.actionName ?? obj.label ?? targetCode,
      action_type: obj.actionType ?? obj.type ?? "open_modal",
      page_code: pageCode,
      module_code: obj.moduleCode ?? "custom",
      feature_code: obj.featureCode ?? pageCode,
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

async function resolveTableName(
  diff: { targetType: string; targetCode: string; op: string; field?: string; fieldDef?: Record<string, unknown>; modifiedDslJson?: unknown },
  schemaName: string,
): Promise<string | null> {
  if (diff.targetType === "api_dsl") {
    const { rows } = await pool.query(
      `select dsl_json from admin.api_dsl where api_code = $1 and (schema_scope = 'tenant' and schema_name = $2 or (schema_scope = 'tenant' and schema_name = '${TEMPLATE_SCHEMA}')) and status = 'active' and deleted = false order by case when schema_name = $2 then 0 when schema_name = '${TEMPLATE_SCHEMA}' then 1 else 2 end limit 1`,
      [diff.targetCode, schemaName]
    );
    const dsl = rows[0]?.dsl_json as Record<string, unknown> | null;
    if (dsl?.table) return String(dsl.table);
  }
  if (diff.targetType === "page_dsl") {
    const pageCode = diff.targetCode;
    const { rows: apiRows } = await pool.query(
      `select dsl_json from admin.api_dsl where api_code like $1 and (schema_scope = 'tenant' and schema_name = $2 or (schema_scope = 'tenant' and schema_name = '${TEMPLATE_SCHEMA}')) and status = 'active' and deleted = false order by case when schema_name = $2 then 0 when schema_name = '${TEMPLATE_SCHEMA}' then 1 else 2 end limit 1`,
      [`${pageCode}.query`, schemaName]
    );
    const dsl = apiRows[0]?.dsl_json as Record<string, unknown> | null;
    if (dsl?.table) return String(dsl.table);
  }
  return null;
}

export async function rollbackTestSchemaDsl(schemaName: string, versionId: string) {
  const testSchema = getTestSchemaName(schemaName);

  const { rows: existing } = await pool.query(
    `select schema_name from admin.tenant_manage where schema_name = $1 and status = 'ACTIVE' and deleted = false`,
    [testSchema]
  );
  if (existing.length === 0) {
    throw httpError(400, "预览环境不存在，请先创建预览");
  }

  const { rows } = await pool.query(
    `select id, schema_scope, schema_name, target_type, target_code, version_no, status, snapshot_json
     from admin.dsl_version where id = $1`,
    [versionId]
  );
  const ver = rows[0];
  if (!ver) throw httpError(404, "版本不存在");

  const snapshot = ver.snapshot_json;
  if (!snapshot || typeof snapshot !== "object") {
    throw httpError(400, "版本快照为空，无法回滚");
  }

  const snap = snapshot as Record<string, unknown>;
  if (ver.target_type === "bundle") {
    const items = (snap.items as Array<{ targetType: string; targetCode: string; previousSnapshot?: Record<string, unknown> | null }> | undefined) ?? [];
    for (const item of items) {
      if (!item.previousSnapshot) continue;
      await writeSnapshotToTestSchema(testSchema, item.targetType, item.targetCode, item.previousSnapshot);
    }
    return { success: true, targetType: ver.target_type, targetCode: ver.target_code, versionNo: Number(ver.version_no) };
  }

  const dslTable = DSL_TABLE_MAP[ver.target_type];
  if (!dslTable) return { success: true, targetType: ver.target_type, targetCode: ver.target_code };

  const targetType = ver.target_type;
  const codeCol = targetType === "skill" ? "skill_code" : targetType + "_code";
  const contentCol = targetType === "skill" ? "skill_md_content" : "dsl_json";
  const contentValue = targetType === "skill" ? snap.skill_md_content : JSON.stringify(snap.dsl_json);

  const setClauses: string[] = [`${contentCol} = $1`, "updated_at = now()"];
  const values: unknown[] = [contentValue];
  values.push(testSchema);

  const updateResult = await pool.query(
    `update ${dslTable} set ${setClauses.join(", ")} where ${codeCol} = $2 and schema_scope = 'tenant' and schema_name = $3 and status = 'active' and deleted = false`,
    [contentValue, ver.target_code, testSchema]
  );

  if (updateResult.rowCount === 0) {
    const src = await loadDslSourceRow(dslTable, codeCol, ver.target_code, schemaName);
    if (!src) return { success: true, targetType: ver.target_type, targetCode: ver.target_code };

    const cols = [codeCol, "schema_scope", "schema_name", contentCol, "version_no", "status", "deleted"];
    const vals: unknown[] = [ver.target_code, "tenant", testSchema, contentValue, 1, "active", false];

    appendDslMetadata(cols, vals, src);
    validateInsertMetadata(targetType, ver.target_code, cols, src);

    const nameCol = targetType === "skill" ? "skill_name" : targetType + "_name";
    cols.push(nameCol);
    vals.push(src[nameCol] ?? ver.target_code);

    cols.push("id");
    vals.push(`test_${ver.target_type}_${ver.target_code}`);

    await pool.query(
      `insert into ${dslTable}(${cols.join(", ")}) values(${vals.map((_, i) => `$${i + 1}`).join(", ")})`,
      vals
    );
  }

  return { success: true, targetType: ver.target_type, targetCode: ver.target_code, versionNo: Number(ver.version_no) };
}

async function applyResourceDiffToTestSchema(
  testSchema: string,
  diff: { targetType: string; targetCode: string; modifiedDslJson: unknown },
) {
  if (!diff.modifiedDslJson || typeof diff.modifiedDslJson !== "object" || Array.isArray(diff.modifiedDslJson)) return;
  const resource = diff.modifiedDslJson as Record<string, unknown>;

  if (diff.targetType === "db_schema") {
    const tableName = safeResourceName(resource.tableName ?? diff.targetCode);
    const fields = Array.isArray(resource.fields) ? resource.fields as Array<Record<string, unknown>> : [];
    if (resource.operation === "create_table") {
      const cols = [
        `"id" text primary key`,
        ...fields.map((field) => `${qIdent(safeResourceName(field.key))} ${mapFieldTypeToSqlType(String(field.type ?? "text"))}${field.required ? " not null" : ""}`),
        `"ext_json" jsonb not null default '{}'::jsonb`,
        `"created_at" timestamptz not null default now()`,
        `"updated_at" timestamptz not null default now()`,
        `"created_by" text`,
        `"updated_by" text`,
        `"deleted" boolean not null default false`,
      ];
      await pool.query(`create table if not exists ${qIdent(testSchema)}.${qIdent(tableName)} (${cols.join(", ")})`);
    }
    if (resource.operation === "add_field") {
      for (const field of fields) {
        await pool.query(`alter table ${qIdent(testSchema)}.${qIdent(tableName)} add column if not exists ${qIdent(safeResourceName(field.key))} ${mapFieldTypeToSqlType(String(field.type ?? "text"))}`);
      }
      invalidateTableColumnsCache(testSchema, tableName);
    }
    return;
  }

  if (diff.targetType === "import_dsl" || diff.targetType === "report_dsl" || diff.targetType === "print_template" || diff.targetType === "business_rule") {
    const isImport = diff.targetType === "import_dsl";
    const isReport = diff.targetType === "report_dsl";
    const isPrint = diff.targetType === "print_template";
    const table = isImport ? "admin.import_dsl" : isReport ? "admin.report_dsl" : isPrint ? "admin.print_template" : "admin.business_rule";
    const codeCol = isImport ? "import_code" : isReport ? "report_code" : isPrint ? "template_code" : "rule_code";
    const nameCol = isImport ? "import_name" : isReport ? "report_name" : isPrint ? "template_name" : "rule_name";
    const contentCol = diff.targetType === "business_rule" ? "rule_json" : "dsl_json";
    const resourceCode = diff.targetType === "business_rule"
      ? String(resource.ruleCode ?? diff.targetCode)
      : diff.targetType === "print_template"
        ? String(resource.templateCode ?? diff.targetCode)
        : diff.targetType === "report_dsl"
          ? String(resource.reportCode ?? diff.targetCode)
          : diff.targetType === "import_dsl"
            ? String(resource.importCode ?? diff.targetCode)
            : diff.targetCode;
    const name = String(resource.title ?? resource.name ?? resource.importName ?? resource.reportName ?? resource.templateName ?? resource.ruleName ?? diff.targetCode);
    const update = await pool.query(
      `update ${table} set ${contentCol} = $1, ${nameCol} = $2, updated_at = now()
       where ${codeCol} = $3 and schema_scope = 'tenant' and schema_name = $4 and status = 'active' and deleted = false`,
      [JSON.stringify(resource), name, resourceCode, testSchema]
    );
    if (update.rowCount === 0) {
      await pool.query(
        `insert into ${table}(id, ${codeCol}, ${nameCol}, schema_scope, schema_name, ${contentCol}, status, deleted)
         values($1,$2,$3,'tenant',$4,$5,'active',false)`,
        [randomUUID(), resourceCode, name, testSchema, JSON.stringify(resource)]
      );
    }
    return;
  }

  if (diff.targetType === "approval_flow") {
    const flowCode = safeResourceName(resource.flowCode ?? diff.targetCode);
    const flowName = String(resource.flowName ?? resource.name ?? diff.targetCode);
    const update = await pool.query(
      `update ${qIdent(testSchema)}.approval_flow
       set name = $1, module_code = $2, status = $3, config_json = $4, organization_id = $5, updated_at = now(), deleted = false
       where flow_code = $6 and deleted = false`,
      [
        flowName,
        resource.moduleCode ?? null,
        resource.status ?? "ACTIVE",
        JSON.stringify(resource),
        resource.organizationId ?? resource.organization_id ?? null,
        flowCode,
      ]
    );
    if (update.rowCount === 0) {
      await pool.query(
        `insert into ${qIdent(testSchema)}.approval_flow(id, name, flow_code, module_code, status, config_json, organization_id)
         values($1,$2,$3,$4,$5,$6,$7)`,
        [randomUUID(), flowName, flowCode, resource.moduleCode ?? null, resource.status ?? "ACTIVE", JSON.stringify(resource), resource.organizationId ?? resource.organization_id ?? null]
      );
    }
    return;
  }

  if (diff.targetType === "feature_registry") {
    const featureCode = safeResourceName(resource.featureCode ?? diff.targetCode);
    const moduleCode = safeResourceName(resource.moduleCode ?? "custom");
    const pageCode = safeResourceName(resource.pageCode ?? featureCode);
    await pool.query(
      `insert into admin.module_registry(id, module_code, module_name, module_group, description, default_enabled, sort_no, status)
       values($1,$2,$3,'tenant',$4,true,999,'ACTIVE')
       on conflict (module_code) do update set status = 'ACTIVE', deleted = false`,
      [randomUUID(), moduleCode, String(resource.moduleName ?? moduleCode), String(resource.moduleDescription ?? "AI 定制模块")]
    );
    await pool.query(
      `insert into admin.feature_registry(id, module_code, feature_code, feature_name, page_code, description, default_enabled, sort_no, status)
       values($1,$2,$3,$4,$5,$6,true,999,'ACTIVE')
       on conflict (feature_code) do update set feature_name = EXCLUDED.feature_name, page_code = EXCLUDED.page_code, description = EXCLUDED.description, status = 'ACTIVE', deleted = false`,
      [randomUUID(), moduleCode, featureCode, String(resource.featureName ?? featureCode), pageCode, String(resource.description ?? "AI 定制功能")]
    );
    await pool.query(
      `insert into admin.tenant_feature_subscription(id, tenant_id, schema_name, module_code, feature_code, enabled)
       values($1,$2,$3,$4,$5,true)
       on conflict (schema_name, feature_code) do update set enabled = true, deleted = false`,
      [randomUUID(), `test_${testSchema.replace(/_test$/, "")}`, testSchema, moduleCode, featureCode]
    );
    await grantFeaturePageAccess(testSchema, pageCode);
  }
}

async function grantFeaturePageAccess(schemaName: string, pageCode: string) {
  const schema = qIdent(schemaName);
  const { rows: roles } = await pool.query(`select id, role_code from ${schema}.role where deleted = false`);
  for (const role of roles) {
    const roleId = String(role.id);
    const roleCode = String(role.role_code ?? roleId).toLowerCase();
    const resourceId = `rr_ai_${roleCode}_${pageCode}`.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 120);
    await pool.query(
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

function safeResourceName(value: unknown) {
  const text = String(value ?? "");
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(text)) throw httpError(400, `资源命名不安全：${text}`);
  return text;
}

async function writeSnapshotToTestSchema(testSchema: string, targetType: string, targetCode: string, snapshot: Record<string, unknown>) {
  if ((targetType === "import" || targetType === "report" || targetType === "print_template" || targetType === "business_rule" || targetType === "approval_flow") && snapshot.resource_json) {
    await applyResourceDiffToTestSchema(testSchema, {
      targetType: targetType === "import" ? "import_dsl" : targetType === "report" ? "report_dsl" : targetType,
      targetCode,
      modifiedDslJson: snapshot.resource_json,
    });
    return;
  }
  const dslTable = DSL_TABLE_MAP[targetType];
  if (!dslTable) return;
  const codeCol = targetType === "skill" ? "skill_code" : targetType + "_code";
  const contentCol = targetType === "skill" ? "skill_md_content" : "dsl_json";
  const contentValue = targetType === "skill" ? snapshot.skill_md_content : JSON.stringify(snapshot.dsl_json);
  const updateResult = await pool.query(
    `update ${dslTable} set ${contentCol} = $1, updated_at = now() where ${codeCol} = $2 and schema_scope = 'tenant' and schema_name = $3 and status = 'active' and deleted = false`,
    [contentValue, targetCode, testSchema]
  );
  if ((updateResult.rowCount ?? 0) > 0) return;

  const sourceSchema = testSchema.replace(/_test$/, "");
  const src = await loadDslSourceRow(dslTable, codeCol, targetCode, sourceSchema);
  if (!src) return;
  const cols = [codeCol, "schema_scope", "schema_name", contentCol, "version_no", "status", "deleted"];
  const vals: unknown[] = [targetCode, "tenant", testSchema, contentValue, 1, "active", false];
  appendDslMetadata(cols, vals, src);
  validateInsertMetadata(targetType, targetCode, cols, src);
  const nameCol = targetType === "skill" ? "skill_name" : targetType + "_name";
  cols.push(nameCol);
  vals.push(src[nameCol] ?? targetCode);
  cols.push("id");
  vals.push(randomUUID());
  await pool.query(
    `insert into ${dslTable}(${cols.join(", ")}) values(${vals.map((_, i) => `$${i + 1}`).join(", ")})`,
    vals
  );
}

async function loadDslSourceRow(dslTable: string, codeCol: string, targetCode: string, schemaName: string) {
  const { rows } = await pool.query(
    `select * from ${dslTable}
     where ${codeCol} = $1 and status = 'active' and deleted = false
       and ((schema_scope = 'tenant' and schema_name = $2) or (schema_scope = 'tenant' and schema_name = '${TEMPLATE_SCHEMA}'))
     order by case when schema_scope = 'tenant' and schema_name = $2 then 0 when schema_scope = 'tenant' and schema_name = '${TEMPLATE_SCHEMA}' then 1 else 2 end
     limit 1`,
    [targetCode, schemaName]
  );
  return rows[0] as Record<string, unknown> | undefined;
}

function appendDslMetadata(cols: string[], vals: unknown[], src: Record<string, unknown>) {
  for (const col of ["module_code", "feature_code", "api_type", "action_type", "page_code", "page_kind", "route_path"]) {
    if (col in src && src[col] != null && !cols.includes(col)) {
      cols.push(col);
      vals.push(src[col]);
    }
  }
}

function validateInsertMetadata(targetType: string, targetCode: string, cols: string[], src: Record<string, unknown>) {
  const requiredByType: Record<string, string[]> = {
    api: ["api_type"],
    action: ["action_type", "page_code"],
    page: ["page_kind"],
  };
  for (const col of requiredByType[targetType] ?? []) {
    if (!cols.includes(col) || src[col] == null) {
      throw httpError(400, `${targetType}/${targetCode} 缺少写入预览所需元数据 ${col}`);
    }
  }
}
