import { pool } from "./pool.js";

const IDENTIFIER = /^[a-z][a-z0-9_]{1,62}$/;

export function assertSafeIdentifier(value: string) {
  if (!IDENTIFIER.test(value)) {
    throw new Error("Invalid schema identifier");
  }
  return value;
}

export function qIdent(value: string) {
  assertSafeIdentifier(value);
  return `"${value}"`;
}

export async function resolveTenantSchema(schemaName: string) {
  assertSafeIdentifier(schemaName);
  const { rows } = await pool.query(
    `select schema_name from admin.tenant_manage
     where schema_name = $1 and status = 'ACTIVE' and deleted = false
       and (expire_time is null or expire_time > now())`,
    [schemaName]
  );
  if (!rows[0]) {
    throw new Error("Tenant is unavailable");
  }
  return rows[0].schema_name as string;
}
