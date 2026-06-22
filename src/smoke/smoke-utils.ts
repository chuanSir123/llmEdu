import fs from "node:fs/promises";
import path from "node:path";
import { pool } from "../db/pool.js";

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export async function cleanupTenant(schemaName: string) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schemaName)) return;
  await pool.query(`drop schema if exists "${schemaName}" cascade`);
  const adminTables = [
    "tenant_manage",
    "tenant_module_subscription",
    "tenant_feature_subscription",
    "tenant_agent_config",
    "dsl_version",
    "page_dsl",
    "api_dsl",
    "action_dsl",
    "skill_registry",
    "import_dsl",
    "report_dsl",
    "print_template",
    "business_rule",
    "audit_log",
    "agent_attachment",
    "agent_chat_session",
    "agent_customization_record",
    "tenant_dsl_change",
    "tenant_recharge_record",
  ];
  for (const table of adminTables) {
    await pool.query(`delete from admin.${table} where schema_name = $1`, [schemaName]);
  }
  await fs.rm(path.resolve("data", "uploads", schemaName), { recursive: true, force: true });
}
