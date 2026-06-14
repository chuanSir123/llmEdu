import { pool } from "./pool.js";

type Problem = {
  apiCode: string;
  schema: string;
  table?: string;
  problem: string;
  field?: string;
};

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
    const dsl = row.dsl_json;
    if (dsl.operation === "command") continue;
    const table = dsl.table as string;
    const { rows: columns } = await pool.query(
      `select column_name from information_schema.columns where table_schema = $1 and table_name = $2`,
      [schema, table]
    );
    const colset = new Set(columns.map((col) => col.column_name as string));
    if (!colset.size) problems.push({ apiCode: row.api_code, schema, table, problem: "missing table" });

    for (const field of dsl.allowedFields ?? []) {
      if (!colset.has(field)) problems.push({ apiCode: row.api_code, schema, table, problem: "missing allowedField", field });
    }
    for (const field of dsl.filters ?? []) {
      if (!colset.has(field)) problems.push({ apiCode: row.api_code, schema, table, problem: "missing filter", field });
    }

    for (const join of dsl.joins ?? []) {
      const { rows: joinColumns } = await pool.query(
        `select column_name from information_schema.columns where table_schema = $1 and table_name = $2`,
        [schema, join.table]
      );
      const joinColset = new Set(joinColumns.map((col) => col.column_name as string));
      if (!joinColset.size) problems.push({ apiCode: row.api_code, schema, table: join.table, problem: "missing join table" });
      if (!colset.has(join.on.left)) problems.push({ apiCode: row.api_code, schema, table, problem: "missing join left", field: join.on.left });
      if (!joinColset.has(join.on.right)) problems.push({ apiCode: row.api_code, schema, table: join.table, problem: "missing join right", field: join.on.right });
      for (const field of join.fields ?? []) {
        if (!joinColset.has(field.source)) problems.push({ apiCode: row.api_code, schema, table: join.table, problem: "missing join source", field: field.source });
      }
    }
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
