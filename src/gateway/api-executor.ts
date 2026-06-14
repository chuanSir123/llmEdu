import { pool } from "../db/pool.js";
import { executeCommandDsl } from "./command-engine.js";
import { executeApiDsl } from "./query-dsl-engine.js";

export async function loadApiDsl(scope: "admin" | "tenant", apiCode: string, schemaName?: string) {
  const { rows } = await pool.query(
    `select api_code, api_type, dsl_json
     from admin.api_dsl
     where api_code = $1 and status = 'active' and deleted = false
       and ((schema_scope = $2 and coalesce(schema_name,'') = coalesce($3,''))
         or (schema_scope = 'tenant_default' and $2 = 'tenant'))
     order by case when schema_scope = $2 then 0 else 1 end
     limit 1`,
    [apiCode, scope, schemaName ?? null]
  );
  if (!rows[0]) throw new Error("API DSL 不存在");
  return rows[0].dsl_json;
}

export async function executeGatewayApi(scope: "admin" | "tenant", schemaName: string, apiCode: string, params: Record<string, unknown>) {
  const dsl = await loadApiDsl(scope, apiCode, scope === "tenant" ? schemaName : undefined);
  if (dsl.operation === "command") return executeCommandDsl(scope === "admin" ? "admin" : schemaName, dsl, params);
  return executeApiDsl(scope === "admin" ? "admin" : schemaName, dsl, params);
}
