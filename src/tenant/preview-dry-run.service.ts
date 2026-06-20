import { executeGatewayApi, loadApiDsl } from "../gateway/api-executor.js";
import type { SessionUser } from "../types.js";
import { pool } from "../db/pool.js";
import { qIdent } from "../db/schema-resolver.js";
import { inferForeignKeyMeta } from "../common/foreign-key-meta.js";

export type PreviewDryRunResult = {
  ok: boolean;
  checks: Array<{ apiCode: string; operation: string; ok: boolean; message: string }>;
};

export async function dryRunPreviewApis(input: {
  testSchema: string;
  diffs: Array<{ targetType: string; targetCode: string; modifiedDslJson: unknown }>;
  user: { kind: string; userId: string };
}): Promise<PreviewDryRunResult> {
  const checks: PreviewDryRunResult["checks"] = [];
  const apiCodes = [...new Set(input.diffs
    .filter((diff) => diff.targetType === "api_dsl")
    .map((diff) => diff.targetCode))];
  const user: SessionUser = {
    kind: input.user.kind === "admin" ? "admin" : "tenant",
    userId: input.user.userId,
    name: "preview-dry-run",
    schemaName: input.testSchema,
  };

  for (const apiCode of apiCodes) {
    let dsl: Record<string, unknown>;
    try {
      dsl = await loadApiDsl("tenant", apiCode, input.testSchema);
    } catch (err) {
      checks.push({ apiCode, operation: "load", ok: false, message: err instanceof Error ? err.message : String(err) });
      continue;
    }
    const operation = String(dsl.operation ?? "");
    try {
      if (operation === "query") {
        await executeGatewayApi("tenant", input.testSchema, apiCode, { page: 1, pageSize: 1, filters: {} }, user);
        checks.push({ apiCode, operation, ok: true, message: "query ok" });
        continue;
      }
      if (operation === "detail") {
        const sampleId = await loadSampleId(input.testSchema, String(dsl.table ?? ""));
        if (!sampleId) {
          checks.push({ apiCode, operation, ok: true, message: "detail skipped: no sample row" });
          continue;
        }
        await executeGatewayApi("tenant", input.testSchema, apiCode, { id: sampleId }, user);
        checks.push({ apiCode, operation, ok: true, message: "detail ok" });
        continue;
      }
      if (operation === "create") {
        const sampleData = await buildSampleData(input.testSchema, dsl);
        if (Object.keys(sampleData).length === 0) {
          checks.push({ apiCode, operation, ok: true, message: "create skipped: no allowed fields" });
          continue;
        }
        const created = await executeGatewayApi("tenant", input.testSchema, apiCode, { data: sampleData }, user) as Record<string, unknown> | null;
        checks.push({ apiCode, operation, ok: true, message: created?.id ? `create ok: ${created.id}` : "create ok" });
        continue;
      }
      if (operation === "update") {
        const sampleId = await loadSampleId(input.testSchema, String(dsl.table ?? ""));
        if (!sampleId) {
          checks.push({ apiCode, operation, ok: true, message: "update skipped: no sample row" });
          continue;
        }
        await executeGatewayApi("tenant", input.testSchema, apiCode, { id: sampleId, data: await buildSampleData(input.testSchema, dsl) }, user);
        checks.push({ apiCode, operation, ok: true, message: "update ok" });
        continue;
      }
      checks.push({ apiCode, operation: operation || "unknown", ok: true, message: "skipped" });
    } catch (err) {
      checks.push({ apiCode, operation: operation || "unknown", ok: false, message: err instanceof Error ? err.message : String(err) });
    }
  }

  return { ok: checks.every((check) => check.ok), checks };
}

async function loadSampleId(schemaName: string, tableName: string) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(tableName)) return "";
  const tableExpr = `${qIdent(schemaName)}.${tableName === "user" ? qIdent("user") : qIdent(tableName)}`;
  const { rows: cols } = await pool.query(
    `select column_name from information_schema.columns where table_schema = $1 and table_name = $2 and column_name in ('id','deleted')`,
    [schemaName, tableName]
  );
  const colset = new Set(cols.map((row) => String(row.column_name)));
  if (!colset.has("id")) return "";
  const where = colset.has("deleted") ? " where coalesce(deleted, false) = false" : "";
  const { rows } = await pool.query(`select id from ${tableExpr}${where} limit 1`);
  return rows[0]?.id ? String(rows[0].id) : "";
}

async function buildSampleData(schemaName: string, dsl: Record<string, unknown>) {
  const allowed = Array.isArray(dsl.allowedFields) ? dsl.allowedFields.map(String).filter((field) => field !== "id") : [];
  const tableName = String(dsl.table ?? "");
  const columnTypes = await loadColumnTypes(schemaName, tableName);
  const data: Record<string, unknown> = {};
  for (const field of allowed.slice(0, 5)) {
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(field)) continue;
    if (field.endsWith("_id")) {
      const sampleId = await loadForeignKeySampleId(schemaName, field);
      if (sampleId) data[field] = sampleId;
      continue;
    }
    data[field] = sampleValueForColumn(field, columnTypes.get(field));
  }
  return data;
}

async function loadForeignKeySampleId(schemaName: string, field: string) {
  const meta = inferForeignKeyMeta(field);
  if (!meta) return "";
  return loadSampleId(schemaName, meta.table);
}

async function loadColumnTypes(schemaName: string, tableName: string) {
  const result = new Map<string, string>();
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(tableName)) return result;
  const { rows } = await pool.query(
    `select column_name, data_type from information_schema.columns where table_schema = $1 and table_name = $2`,
    [schemaName, tableName]
  );
  for (const row of rows) result.set(String(row.column_name), String(row.data_type));
  return result;
}

function sampleValueForColumn(field: string, dataType = "") {
  if (/timestamp|time/i.test(dataType)) return new Date().toISOString();
  if (/date/i.test(dataType)) return new Date().toISOString().slice(0, 10);
  if (/numeric|decimal|double|real|integer|bigint|smallint/i.test(dataType)) return 1;
  if (/boolean/i.test(dataType)) return false;
  if (/(phone|mobile|tel|电话|手机号)/i.test(field)) return "13800000000";
  return `dry_run_${field}`;
}
