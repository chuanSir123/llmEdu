import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { pool, withClient } from "../db/pool.js";
import { migrate } from "../db/migrator.js";
import { initializeTenantVersion } from "../version/version.service.js";
import { qIdent } from "../db/schema-resolver.js";
import { seedDefaultWechatBinding } from "../marketing.service.js";
import { TEMPLATE_SCHEMA } from "../common/template-schema.js";

function httpError(statusCode: number, message: string) {
  return Object.assign(new Error(message), { statusCode });
}

const TENANT_TEMPLATE_SCHEMA = TEMPLATE_SCHEMA;
const DEFAULT_OWNER_PASSWORD = "123456";

function id(prefix: string, code: string) {
  return `${prefix}_${code}`.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 120);
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

async function ensureTenantTables(client: import("pg").PoolClient, schemaName: string) {
  const { rows: sourceExists } = await client.query(
    `select schema_name from information_schema.schemata where schema_name = $1`,
    [TENANT_TEMPLATE_SCHEMA]
  );
  if (!sourceExists[0]) throw httpError(500, "租户模板库不存在，请先完成数据库初始化");

  const { rows: tables } = await client.query(
    `select table_name from information_schema.tables where table_schema = $1 and table_type = 'BASE TABLE' order by table_name`,
    [TENANT_TEMPLATE_SCHEMA]
  );
  if (tables.length === 0) throw httpError(500, "租户模板库没有可复制的业务表");

  const targetSchema = qIdent(schemaName);
  const sourceSchema = qIdent(TENANT_TEMPLATE_SCHEMA);
  for (const row of tables) {
    const tableName = String(row.table_name);
    const table = qIdent(tableName);
    await client.query(`create table if not exists ${targetSchema}.${table} (like ${sourceSchema}.${table} including all)`);
  }
}

async function loadSelectedCatalog(client: import("pg").PoolClient, selectedModules: string[], selectedFeatures: string[]) {
  const { rows: featureRows } = await client.query(
    `select module_code, feature_code, page_code
     from admin.feature_registry
     where deleted = false and status = 'ACTIVE'
       and (feature_code = any($1::text[]) or module_code = any($2::text[]))`,
    [selectedFeatures, selectedModules]
  );
  const features = featureRows.map((row) => ({
    moduleCode: String(row.module_code),
    featureCode: String(row.feature_code),
    pageCode: String(row.page_code),
  }));
  const modules = unique([...selectedModules, ...features.map((feature) => feature.moduleCode)]);
  return { modules, features };
}

async function insertTenantSubscriptions(
  client: import("pg").PoolClient,
  tenantId: string,
  schemaName: string,
  modules: string[],
  features: Array<{ moduleCode: string; featureCode: string }>,
) {
  for (const moduleCode of modules) {
    await client.query(
      `insert into admin.tenant_module_subscription(id, tenant_id, schema_name, module_code, enabled, deleted)
       values($1,$2,$3,$4,true,false)
       on conflict (schema_name, module_code) do update set enabled = true, deleted = false, updated_at = now()`,
      [randomUUID(), tenantId, schemaName, moduleCode]
    );
  }
  for (const feature of features) {
    await client.query(
      `insert into admin.tenant_feature_subscription(id, tenant_id, schema_name, module_code, feature_code, enabled, deleted)
       values($1,$2,$3,$4,$5,true,false)
       on conflict (schema_name, feature_code) do update set module_code = excluded.module_code, enabled = true, deleted = false, updated_at = now()`,
      [randomUUID(), tenantId, schemaName, feature.moduleCode, feature.featureCode]
    );
  }
}

const BUSINESS_DATA_TABLES = [
  "student",
  "student_followup",
  "lead_stage_record",
  "recruit_channel",
  "trial_lesson",
  "sales_task",
  "lead_assignment_history",
  "recruit_channel_cost",
  "sales_target",
  "contract",
  "contract_product",
  "generic_course",
  "generic_course_student",
  "account_charge_records",
  "funds_change_history",
  "refund_record",
  "student_ele_account",
  "student_ele_account_record",
  "mall_order",
  "wechat_push_log",
  "money_arrange_log",
  "promotion_arrange_log",
  "performance_arrange_log",
] as const;

async function assertNoBusinessDataInitialized(client: import("pg").PoolClient, schemaName: string) {
  const schema = qIdent(schemaName);
  const initializedTables: string[] = [];
  for (const tableName of BUSINESS_DATA_TABLES) {
    const { rows } = await client.query(`select count(*)::int as count from ${schema}.${qIdent(tableName)} where deleted = false`);
    if (Number(rows[0]?.count ?? 0) > 0) initializedTables.push(tableName);
  }
  if (initializedTables.length) {
    throw httpError(500, `新增机构不应初始化业务数据，请检查表: ${initializedTables.join(", ")}`);
  }
}

async function loadPageActionCodes(client: import("pg").PoolClient, pageCode: string) {
  const { rows } = await client.query(
    `select action_code from admin.action_dsl
     where schema_scope = 'tenant' and schema_name = '${TEMPLATE_SCHEMA}' and page_code = $1 and status = 'active' and deleted = false`,
    [pageCode]
  );
  return rows.map((row) => String(row.action_code));
}

async function seedTenantOperatingBaseline(
  client: import("pg").PoolClient,
  input: {
    schemaName: string;
    contactPhone?: string;
    ownerName?: string;
    pageCodes: string[];
    operatorId: string;
  },
) {
  const schema = qIdent(input.schemaName);
  const ownerContact = input.contactPhone?.trim() || `owner_${input.schemaName}`;
  const ownerName = input.ownerName?.trim() || "租户负责人";
  const passwordHash = bcrypt.hashSync(DEFAULT_OWNER_PASSWORD, 10);

  await client.query(
    `insert into ${schema}.organization(id, name, organization_type, status, created_by)
     values($1,$2,'HEAD','ACTIVE',$3)
     on conflict (id) do update set name = excluded.name, status = 'ACTIVE', deleted = false, updated_at = now()`,
    ["org_head", `${ownerName}校区`, input.operatorId]
  );
  await client.query(
    `insert into ${schema}."user"(id, name, contact, psw, organization_id, staff_type, status, created_by)
     values($1,$2,$3,$4,'org_head','MANAGER','ACTIVE',$5)
     on conflict (id) do update set name = excluded.name, contact = excluded.contact, psw = excluded.psw, status = 'ACTIVE', deleted = false, updated_at = now()`,
    ["user_owner", ownerName, ownerContact, passwordHash, input.operatorId]
  );

  const roles = [
    { id: "role_principal", name: "校长", roleCode: "PRINCIPAL", dataPermission: "all", fieldPermission: {} },
    { id: "role_teacher", name: "老师", roleCode: "TEACHER", dataPermission: "own_courses", fieldPermission: { contact: "hidden" } },
    { id: "role_study_manager", name: "学管师", roleCode: "STUDY_MANAGER", dataPermission: "own_students", fieldPermission: {} },
    { id: "role_sales", name: "课程顾问", roleCode: "SALES", dataPermission: "own_organization", fieldPermission: {} },
  ];
  for (const role of roles) {
    await client.query(
      `insert into ${schema}.role(id, name, role_code, organization_id)
       values($1,$2,$3,'org_head')
       on conflict (id) do update set name = excluded.name, role_code = excluded.role_code, deleted = false, updated_at = now()`,
      [role.id, role.name, role.roleCode]
    );
  }
  await client.query(
    `insert into ${schema}.user_role(id, user_id, role_id)
     values($1,'user_owner','role_principal')
     on conflict (id) do update set deleted = false, updated_at = now()`,
    ["ur_owner_principal"]
  );

  for (const pageCode of input.pageCodes) {
    const actionCodes = await loadPageActionCodes(client, pageCode);
    for (const role of roles) {
      await client.query(
        `insert into ${schema}.role_resource
           (id, role_id, resource_code, resource_type, page_code, action_code, page_permission, button_permission, data_permission, field_permission, organization_scope)
         values($1,$2,$3,'page',$3,null,'all',$4::jsonb,$5,$6::jsonb,$7)
         on conflict (id) do update set button_permission = excluded.button_permission, data_permission = excluded.data_permission,
           field_permission = excluded.field_permission, deleted = false, updated_at = now()`,
        [
          id(`rr_${role.roleCode.toLowerCase()}`, pageCode),
          role.id,
          pageCode,
          JSON.stringify(role.roleCode === "PRINCIPAL" ? actionCodes : actionCodes.filter((code) => !code.endsWith(".delete"))),
          role.dataPermission,
          JSON.stringify(role.fieldPermission),
          role.dataPermission === "all" ? null : "role_organization",
        ]
      );
    }
  }

  const payWays = [
    ["pay_cash", "现金", "CASH"],
    ["pay_wechat", "微信", "WECHAT"],
    ["pay_alipay", "支付宝", "ALIPAY"],
    ["pay_ele_account", "电子账户", "ELE_ACCOUNT"],
  ];
  for (const [payId, name, type] of payWays) {
    await client.query(
      `insert into ${schema}.pay_way_config(id, name, pay_way_type, status)
       values($1,$2,$3,'ACTIVE')
       on conflict (id) do update set name = excluded.name, pay_way_type = excluded.pay_way_type, status = 'ACTIVE', deleted = false, updated_at = now()`,
      [payId, name, type]
    );
  }

  await seedDefaultWechatBinding(client, input.schemaName);

  return { ownerContact, ownerPassword: DEFAULT_OWNER_PASSWORD };
}

export async function loadModuleSelectionTree() {
  const { rows: modules } = await pool.query(
    `select module_code, module_name, module_group, description, sort_no, icon, default_enabled
     from admin.module_registry where deleted = false and status = 'ACTIVE' order by sort_no`
  );
  const { rows: features } = await pool.query(
    `select module_code, feature_code, feature_name, page_code, default_enabled, sort_no
     from admin.feature_registry where deleted = false and status = 'ACTIVE' order by sort_no`
  );

  const { rows: demoModules } = await pool.query(
    `select module_code from admin.tenant_module_subscription where schema_name = '${TEMPLATE_SCHEMA}' and enabled = true and deleted = false`
  );
  const { rows: demoFeatures } = await pool.query(
    `select feature_code from admin.tenant_feature_subscription where schema_name = '${TEMPLATE_SCHEMA}' and enabled = true and deleted = false`
  );

  const demoModuleSet = new Set(demoModules.map((r: { module_code: string }) => r.module_code));
  const demoFeatureSet = new Set(demoFeatures.map((r: { feature_code: string }) => r.feature_code));

  return modules.map((m: { module_code: string; module_name: string; module_group: string; description: string; sort_no: number; icon: string; default_enabled: boolean }) => ({
    moduleCode: m.module_code,
    moduleName: m.module_name,
    moduleGroup: m.module_group,
    description: m.description,
    sortNo: m.sort_no,
    icon: m.icon,
    selected: demoModuleSet.has(m.module_code),
    features: features
      .filter((f: { module_code: string }) => f.module_code === m.module_code)
      .map((f: { feature_code: string; feature_name: string; page_code: string; default_enabled: boolean; sort_no: number }) => ({
        featureCode: f.feature_code,
        featureName: f.feature_name,
        pageCode: f.page_code,
        sortNo: f.sort_no,
        selected: demoFeatureSet.has(f.feature_code),
      })),
  }));
}

export async function createTenantWithModules(input: {
  name: string;
  contactPhone?: string;
  ownerName?: string;
  selectedModules: string[];
  selectedFeatures: string[];
  operatorId: string;
}) {
  await migrate();
  return withClient(async (client) => {
    const schemaName = `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const tenantId = `tenant_${randomUUID().slice(0, 8)}`;
    const catalog = await loadSelectedCatalog(client, input.selectedModules, input.selectedFeatures);
    if (catalog.modules.length === 0 || catalog.features.length === 0) {
      throw httpError(400, "请至少选择一个可用模块和功能");
    }
    const agentCustomizationEnabled = catalog.modules.includes("ai_agent") || catalog.features.some((feature) => ["customization_record_list", "tenant_version_list"].includes(feature.featureCode));

    await client.query(
      `insert into admin.tenant_manage(id, schema_name, name, status, contact_phone, owner_name, enabled_modules, enabled_features, expire_time, created_by, agent_customization_enabled)
       values($1,$2,$3,'INITIALIZING',$4,$5,$6,$7,'2099-12-31T23:59:59Z',$8,$9)`,
      [
        tenantId,
        schemaName,
        input.name,
        input.contactPhone ?? null,
        input.ownerName ?? null,
        JSON.stringify(catalog.modules),
        JSON.stringify(catalog.features.map((feature) => feature.featureCode)),
        input.operatorId,
        agentCustomizationEnabled,
      ]
    );

    await client.query(`create schema if not exists ${qIdent(schemaName)}`);
    await ensureTenantTables(client, schemaName);
    await insertTenantSubscriptions(client, tenantId, schemaName, catalog.modules, catalog.features);

    const versionResult = await initializeTenantVersion(schemaName, { selectedFeatureCodes: catalog.features.map((feature) => feature.featureCode) });
    await client.query(
      `insert into admin.tenant_agent_config(id, schema_name, agent_customization_enabled, max_chat_rounds, module_scope)
       values($1,$2,$3,20,$4::jsonb)
       on conflict (schema_name) do update set agent_customization_enabled = excluded.agent_customization_enabled,
         module_scope = excluded.module_scope, deleted = false, updated_at = now()`,
      [randomUUID(), schemaName, agentCustomizationEnabled, JSON.stringify(catalog.modules)]
    );
    const login = await seedTenantOperatingBaseline(client, {
      schemaName,
      contactPhone: input.contactPhone,
      ownerName: input.ownerName,
      pageCodes: unique(catalog.features.map((feature) => feature.pageCode)),
      operatorId: input.operatorId,
    });
    await assertNoBusinessDataInitialized(client, schemaName);

    await client.query(
      `update admin.tenant_manage set status = 'ACTIVE', updated_at = now() where id = $1`,
      [tenantId]
    );

    return { schemaName, tenantId, initialVersionCount: versionResult.count, login };
  });
}
