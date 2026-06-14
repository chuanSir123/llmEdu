import { pool } from "../db/pool.js";

export async function loadPageDsl(scope: "admin" | "tenant_default" | "tenant", pageCode: string, schemaName?: string) {
  const { rows } = await pool.query(
    `select page_code, page_name, dsl_json, version_no
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
