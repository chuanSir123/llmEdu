import { pool } from "./pool.js";

type Problem = {
  apiCode: string;
  schema: string;
  table?: string;
  problem: string;
  field?: string;
};

type ApiDsl = {
  table?: string;
  operation?: string;
  allowedFields?: string[];
  select?: Array<{ field?: string; as?: string }>;
  groupBy?: string[];
  dimensions?: string[];
  metrics?: Array<{ field?: string; type?: string; aggregate?: string; as?: string }>;
  filters?: Array<string | { field?: string; key?: string }>;
  fixedFilters?: Array<{ field?: string }>;
  where?: Array<{ field?: string }>;
  joins?: Array<{ table?: string; on?: { left?: string; right?: string }; fields?: Array<{ source?: string; as?: string }> }>;
};

const FIELD_RE = /^[a-z][a-z0-9_]{0,62}$/;

function validateFieldName(problems: Problem[], apiCode: string, schema: string, table: string | undefined, field: unknown, usage: string) {
  if (!field) return false;
  const fieldName = String(field);
  if (!FIELD_RE.test(fieldName)) {
    problems.push({ apiCode, schema, table, problem: `unsafe ${usage}`, field: fieldName });
    return false;
  }
  return true;
}

export async function validateApiDslAgainstSchema(
  schemaName: string,
  apiCode: string,
  dsl: ApiDsl,
  pendingColumns?: Record<string, string[]>,
): Promise<Problem[]> {
  const problems: Problem[] = [];
  if (dsl.operation === "command") return problems;
  const table = dsl.table;
  const effectiveSchema = typeof (dsl as Record<string, unknown>).schema === "string" ? String((dsl as Record<string, unknown>).schema) : schemaName;
  if (!table) {
    problems.push({ apiCode, schema: effectiveSchema, problem: "missing table" });
    return problems;
  }

  const { rows: columns } = await pool.query(
    `select column_name from information_schema.columns where table_schema = $1 and table_name = $2`,
    [effectiveSchema, table]
  );
  const colset = new Set(columns.map((col) => col.column_name as string));
  for (const field of pendingColumns?.[table] ?? []) colset.add(field);
  if (!colset.size) {
    problems.push({ apiCode, schema: effectiveSchema, table, problem: "missing table" });
    return problems;
  }

  const hasExtJson = colset.has("ext_json");
  const checkMainField = (field: unknown, problem: string, options?: { requirePhysical?: boolean }) => {
    if (!field) return;
    const fieldName = String(field);
    if (!validateFieldName(problems, apiCode, effectiveSchema, table, fieldName, problem)) return;
    if (!colset.has(fieldName) && (options?.requirePhysical || !hasExtJson)) {
      problems.push({ apiCode, schema: effectiveSchema, table, problem, field: fieldName });
    }
  };

  for (const field of dsl.allowedFields ?? []) checkMainField(field, "missing allowedField");
  for (const field of dsl.filters ?? []) {
    const filterField = typeof field === "string"
      ? field.replace(/_range$/, "")
      : field.field ?? (typeof field.key === "string" ? field.key.replace(/_range$/, "").replace(/_filter$/, "") : undefined);
    checkMainField(filterField, "missing filter", { requirePhysical: true });
  }
  for (const field of dsl.select ?? []) checkMainField(field.field, "missing select field");
  for (const field of dsl.groupBy ?? []) checkMainField(field, "missing groupBy field", { requirePhysical: true });
  for (const field of dsl.dimensions ?? []) checkMainField(field, "missing dimension field", { requirePhysical: true });
  for (const metric of dsl.metrics ?? []) {
    if (String(metric.type ?? metric.aggregate ?? "count") !== "count" || metric.field) {
      checkMainField(metric.field, "missing metric field", { requirePhysical: true });
    }
  }
  for (const field of dsl.fixedFilters ?? []) checkMainField(field.field, "missing fixed filter field");
  for (const field of dsl.where ?? []) checkMainField(field.field, "missing where field");

  for (const join of dsl.joins ?? []) {
    if (!join.table) continue;
    const { rows: joinColumns } = await pool.query(
      `select column_name from information_schema.columns where table_schema = $1 and table_name = $2`,
      [effectiveSchema, join.table]
    );
    const joinColset = new Set(joinColumns.map((col) => col.column_name as string));
    if (!joinColset.size) problems.push({ apiCode, schema: effectiveSchema, table: join.table, problem: "missing join table" });
    if (join.on?.left && validateFieldName(problems, apiCode, effectiveSchema, table, join.on.left, "join left") && !colset.has(join.on.left)) problems.push({ apiCode, schema: effectiveSchema, table, problem: "missing join left", field: join.on.left });
    if (join.on?.right && validateFieldName(problems, apiCode, effectiveSchema, join.table, join.on.right, "join right") && !joinColset.has(join.on.right)) problems.push({ apiCode, schema: effectiveSchema, table: join.table, problem: "missing join right", field: join.on.right });
    for (const field of join.fields ?? []) {
      if (field.source && validateFieldName(problems, apiCode, effectiveSchema, join.table, field.source, "join source") && !joinColset.has(field.source)) problems.push({ apiCode, schema: effectiveSchema, table: join.table, problem: "missing join source", field: field.source });
      if (field.as) validateFieldName(problems, apiCode, effectiveSchema, join.table, field.as, "join alias");
    }
  }

  return problems;
}

export async function validateActiveDsl() {
  const { rows } = await pool.query(
    `select schema_scope, api_code, dsl_json
     from admin.api_dsl
     where status = 'active' and deleted = false
     order by schema_scope, api_code`
  );
  const problems: Problem[] = [];

  for (const row of rows) {
    const schema = row.schema_scope === "admin" ? "admin" : "demo_school";
    problems.push(...await validateApiDslAgainstSchema(schema, row.api_code, row.dsl_json));
  }

  const { rows: pages } = await pool.query(
    `select p.schema_scope, p.page_code, p.dsl_json as page_dsl, a.dsl_json as api_dsl
     from admin.page_dsl p
     join admin.api_dsl a on a.api_code = (p.page_code || '.query')
      and a.status = 'active' and a.deleted = false
      and a.schema_scope = p.schema_scope
      and coalesce(a.schema_name,'') = coalesce(p.schema_name,'')
     where p.status = 'active' and p.deleted = false`
  );
  for (const row of pages) {
    const apiOutput = new Set<string>(["id", "created_at", "updated_at"]);
    for (const field of row.api_dsl.allowedFields ?? []) apiOutput.add(field);
    for (const field of row.api_dsl.select ?? []) apiOutput.add(field.as ?? field.field);
    for (const field of row.api_dsl.groupBy ?? []) apiOutput.add(field);
    for (const field of row.api_dsl.dimensions ?? []) apiOutput.add(field);
    for (const metric of row.api_dsl.metrics ?? []) apiOutput.add(metric.as ?? metric.field);
    for (const join of row.api_dsl.joins ?? []) {
      for (const field of join.fields ?? []) apiOutput.add(field.as);
    }
    for (const column of row.page_dsl.table?.columns ?? []) {
      if (!apiOutput.has(column.key)) {
        problems.push({
          apiCode: `${row.page_code}.query`,
          schema: row.schema_scope,
          problem: "page column missing from api output",
          field: column.key
        });
      }
    }
  }

  return { apiCount: rows.length, problems };
}

if (process.argv[1] && process.argv[1].endsWith("dsl-validator.ts")) {
  validateActiveDsl()
    .then(async (result) => {
      console.log(JSON.stringify(result, null, 2));
      await pool.end();
      if (result.problems.length) process.exit(1);
    })
    .catch(async (error) => {
      console.error(error);
      await pool.end();
      process.exit(1);
    });
}
