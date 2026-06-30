import { pool } from "../db/pool.js";
import type { TargetType, TenantAgentPolicy } from "./types.js";

const DEFAULT_TOOLS = [
  "add_ext_field_to_page",
  "add_physical_filter_field",
  "create_import_flow",
  "create_report_page",
  "add_followup_workflow",
  "add_charge_workflow",
  "add_contract_payment_workflow",
  "add_refund_workflow",
  "add_course_scheduling_workflow",
  "create_custom_feature",
  "modify_permission_policy",
  "create_approval_flow",
  "add_export_action",
  "create_print_template",
  "create_business_rule",
  "create_business_event_listener",
];

const DEFAULT_TARGET_TYPES: TargetType[] = [
  "page_dsl",
  "api_dsl",
  "action_dsl",
  "skill_registry",
  "db_schema",
  "import_dsl",
  "report_dsl",
  "permission_policy",
  "approval_flow",
  "print_template",
  "business_rule",
  "feature_registry",
];

function stringArray(value: unknown, fallback: string[]) {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : fallback;
}

function targetTypes() {
  return DEFAULT_TARGET_TYPES;
}

export function defaultTenantAgentPolicy(): TenantAgentPolicy {
  return {
    allowedTools: DEFAULT_TOOLS,
    allowedTargetTypes: DEFAULT_TARGET_TYPES,
    riskPolicy: "auto",
    moduleScope: [],
    fieldPolicy: {
      storageStrategy: "ext_json_first",
      maxPhysicalFieldsPerRequest: 8,
      sensitiveFieldBlocklist: ["password", "api_key", "secret", "token"],
    },
    publishPolicy: {
      requirePreview: true,
      requireAdminReview: false,
    },
    dataPolicy: {
      allowImport: true,
      allowOverwrite: false,
    },
  };
}

export async function loadTenantAgentPolicy(schemaName: string): Promise<TenantAgentPolicy> {
  const defaults = defaultTenantAgentPolicy();
  const { rows } = await pool.query(
    `select allowed_tools, allowed_target_types, risk_policy, module_scope, field_policy, publish_policy, data_policy
     from admin.tenant_agent_config where schema_name = $1 and deleted = false limit 1`,
    [schemaName]
  );
  const row = rows[0];
  if (!row) return defaults;

  const fieldPolicy = { ...defaults.fieldPolicy, ...(row.field_policy ?? {}) };
  const publishPolicy = { ...defaults.publishPolicy, ...(row.publish_policy ?? {}) };
  const dataPolicy = { ...defaults.dataPolicy, ...(row.data_policy ?? {}) };

  return {
    allowedTools: stringArray(row.allowed_tools, defaults.allowedTools),
    allowedTargetTypes: targetTypes(),
    riskPolicy: "auto",
    moduleScope: stringArray(row.module_scope, defaults.moduleScope),
    fieldPolicy: {
      storageStrategy: fieldPolicy.storageStrategy === "physical_first" ? "physical_first" : "ext_json_first",
      maxPhysicalFieldsPerRequest: Number(fieldPolicy.maxPhysicalFieldsPerRequest ?? defaults.fieldPolicy.maxPhysicalFieldsPerRequest),
      sensitiveFieldBlocklist: stringArray(fieldPolicy.sensitiveFieldBlocklist, defaults.fieldPolicy.sensitiveFieldBlocklist),
    },
    publishPolicy: {
      requirePreview: publishPolicy.requirePreview !== false,
      requireAdminReview: publishPolicy.requireAdminReview === true,
    },
    dataPolicy: {
      allowImport: dataPolicy.allowImport !== false,
      allowOverwrite: dataPolicy.allowOverwrite === true,
    },
  };
}
