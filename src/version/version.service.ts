import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";

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
