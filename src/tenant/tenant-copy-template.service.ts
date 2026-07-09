import { randomUUID } from "node:crypto";
import { pool, withClient } from "../db/pool.js";
import { TEMPLATE_SCHEMA } from "../common/template-schema.js";

function httpError(statusCode: number, message: string) {
  return Object.assign(new Error(message), { statusCode });
}

export async function listTenantDslChanges(schemaName: string) {
  const { rows } = await pool.query(
    `select dsl_type, dsl_code, change_type, changed_at, source_version_id
     from admin.tenant_dsl_change where schema_name = $1 order by changed_at desc`,
    [schemaName]
  );
  return rows;
}

export async function previewCopyToTemplate(schemaName: string) {
  const changes = await listTenantDslChanges(schemaName);
  if (changes.length === 0) return { changes: [], targetSchema: TEMPLATE_SCHEMA, message: "该租户无 DSL 改动，无需复制" };

  let warning: string | undefined;
  for (const change of changes) {
    const { rows } = await pool.query(
      `select id from admin.dsl_version where schema_scope = 'tenant' and schema_name = '${TEMPLATE_SCHEMA}' and target_type = $1 and target_code = $2 and status = 'active'`,
      [change.dsl_type, change.dsl_code]
    );
    if (rows.length > 0) {
      warning = `模板机构 ${TEMPLATE_SCHEMA} 已存在 ${change.dsl_type}/${change.dsl_code} 的 active 版本，复制将创建 draft 版本`;
      break;
    }
  }

  return { changes, targetSchema: TEMPLATE_SCHEMA, warning };
}

export async function executeCopyToTemplate(input: {
  schemaName: string;
  operatorId: string;
  confirmed: boolean;
}) {
  if (!input.confirmed) throw httpError(400, "请确认复制操作");

  return withClient(async (client) => {
    const { rows: changes } = await client.query(
      `select dsl_type, dsl_code, source_version_id from admin.tenant_dsl_change where schema_name = $1`,
      [input.schemaName]
    );
    if (changes.length === 0) throw httpError(400, "该租户无 DSL 改动，无需复制");

    const draftVersionIds: string[] = [];

    for (const change of changes) {
      const { rows: tenantVersions } = await client.query(
        `select snapshot_json from admin.dsl_version where schema_scope = 'tenant' and schema_name = $1 and target_type = $2 and target_code = $3 and status = 'active'`,
        [input.schemaName, change.dsl_type, change.dsl_code]
      );

      if (tenantVersions.length === 0) continue;

      const { rows: maxRows } = await client.query(
        `select coalesce(max(version_no), 0) + 1 as next_version from admin.dsl_version where schema_scope = 'tenant' and schema_name = '${TEMPLATE_SCHEMA}' and target_type = $1 and target_code = $2`,
        [change.dsl_type, change.dsl_code]
      );
      const newVersionNo = Number(maxRows[0].next_version);
      const newId = randomUUID();

      await client.query(
        `insert into admin.dsl_version(id, schema_scope, schema_name, target_type, target_code, version_no, status, change_type, change_summary, diff_json, snapshot_json, created_by_user_id)
         values($1,'tenant','${TEMPLATE_SCHEMA}',$2,$3,$4,'draft','copy_from_tenant',$5,'{}',$6,$7)`,
        [newId, change.dsl_type, change.dsl_code, newVersionNo, `从 ${input.schemaName} 复制`, JSON.stringify(tenantVersions[0].snapshot_json), input.operatorId]
      );
      draftVersionIds.push(newId);
    }

    await client.query(
      `insert into admin.audit_log(id, schema_name, user_id, action_code, input_summary, created_at)
       values($1,$2,$3,'copy_to_template',$4,now())`,
      [randomUUID(), input.schemaName, input.operatorId, JSON.stringify({ source: input.schemaName, target: TEMPLATE_SCHEMA, copiedCount: draftVersionIds.length })]
    );

    return { copiedCount: draftVersionIds.length, draftVersionIds };
  });
}