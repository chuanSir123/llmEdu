import { pool } from "../db/pool.js";
import { qIdent } from "../db/schema-resolver.js";

const FIELD = /^[a-z][a-z0-9_]{0,62}$/;
type JoinDsl = { table: string; alias: string; on: { left: string; right: string }; fields?: Array<{ source: string; as: string }> };
type ApiDsl = {
  table: string;
  joins?: JoinDsl[];
  operation: "query" | "detail" | "create" | "update" | "delete";
  allowedFields?: string[];
  filters?: string[];
  fixedFilters?: Array<{ field: string; op?: "eq" | "ne"; value: unknown }>;
  sort?: string;
};

const tableColumnsCache = new Map<string, Set<string>>();

function assertField(field: string) {
  if (!FIELD.test(field)) throw new Error(`Unsafe field: ${field}`);
  return field;
}

function tableExpr(schemaName: string, table: string) {
  assertField(table);
  return `${qIdent(schemaName)}.${table === "user" ? `"user"` : qIdent(table)}`;
}

async function nextTextId(schemaName: string, table: string) {
  assertField(schemaName);
  assertField(table);
  const sequence = `${table}_id_seq`;
  await pool.query(`create sequence if not exists ${qIdent(schemaName)}.${qIdent(sequence)} start 100000`);
  const { rows } = await pool.query(`select nextval('${qIdent(schemaName)}.${qIdent(sequence)}'::regclass)::text as id`);
  return rows[0].id as string;
}

async function getTableColumns(schemaName: string, table: string) {
  const key = `${schemaName}.${table}`;
  const cached = tableColumnsCache.get(key);
  if (cached) return cached;
  const { rows } = await pool.query(
    `select column_name from information_schema.columns where table_schema = $1 and table_name = $2`,
    [schemaName, table]
  );
  const columns = new Set(rows.map((row) => row.column_name as string));
  tableColumnsCache.set(key, columns);
  return columns;
}

async function selectColumns(schemaName: string, dsl: ApiDsl) {
  const tableColumns = await getTableColumns(schemaName, dsl.table);
  const cols = ["t.id"];
  for (const field of dsl.allowedFields ?? []) {
    cols.push(`t.${qIdent(assertField(field))}`);
  }
  for (const join of dsl.joins ?? []) {
    for (const field of join.fields ?? []) {
      cols.push(`${qIdent(join.alias)}.${qIdent(assertField(field.source))} as ${qIdent(assertField(field.as))}`);
    }
  }
  if (tableColumns.has("created_at")) cols.push("t.created_at");
  if (tableColumns.has("updated_at")) cols.push("t.updated_at");
  return cols.join(", ");
}

function joinSql(schemaName: string, joins: JoinDsl[] = []) {
  return joins
    .map((join) => {
      assertField(join.alias);
      assertField(join.on.left);
      assertField(join.on.right);
      return `left join ${tableExpr(schemaName, join.table)} ${qIdent(join.alias)} on t.${qIdent(join.on.left)} = ${qIdent(join.alias)}.${qIdent(join.on.right)} and ${qIdent(join.alias)}.deleted = false`;
    })
    .join(" ");
}

export async function executeApiDsl(schemaName: string, dsl: ApiDsl, params: Record<string, unknown>) {
  const table = tableExpr(schemaName, dsl.table);
  const tableColumns = await getTableColumns(schemaName, dsl.table);
  if (dsl.operation === "query") {
    const values: unknown[] = [];
    const where = ["t.deleted = false"];
    for (const fixed of dsl.fixedFilters ?? []) {
      values.push(fixed.value);
      const op = fixed.op === "ne" ? "<>" : "=";
      where.push(`t.${qIdent(assertField(fixed.field))} ${op} $${values.length}`);
    }
    const filters = (params.filters ?? {}) as Record<string, string>;
    for (const field of dsl.filters ?? []) {
      const value = filters[field];
      if (value !== undefined && value !== "") {
        values.push(`%${value}%`);
        where.push(`cast(t.${qIdent(assertField(field))} as text) ilike $${values.length}`);
      }
    }
    const page = Math.max(Number(params.page ?? 1), 1);
    const pageSize = Math.min(Math.max(Number(params.pageSize ?? 20), 1), 100);
    values.push(pageSize, (page - 1) * pageSize);
    const orderColumn = tableColumns.has("created_at") ? "created_at" : "id";
    const sql = `
      select ${await selectColumns(schemaName, dsl)}, count(*) over() as __total
      from ${table} t
      ${joinSql(schemaName, dsl.joins)}
      where ${where.join(" and ")}
      order by t.${qIdent(orderColumn)} desc
      limit $${values.length - 1} offset $${values.length}
    `;
    const { rows } = await pool.query(sql, values);
    const total = rows[0]?.__total ? Number(rows[0].__total) : 0;
    return { rows: rows.map(({ __total, ...row }) => row), total, page, pageSize };
  }

  if (dsl.operation === "detail") {
    const { rows } = await pool.query(
      `select ${await selectColumns(schemaName, dsl)} from ${table} t ${joinSql(schemaName, dsl.joins)} where t.id = $1 and t.deleted = false`,
      [params.id]
    );
    return rows[0] ?? null;
  }

  const allowed = new Set(dsl.allowedFields ?? []);
  const input = (params.data ?? {}) as Record<string, unknown>;
  const fields = Object.keys(input).filter((key) => allowed.has(key) && FIELD.test(key));

  if (dsl.operation === "create") {
    const newId = String(params.id ?? await nextTextId(schemaName, dsl.table));
    const cols = ["id", ...fields];
    const values = [newId, ...fields.map((field) => input[field])];
    const sql = `insert into ${table} (${cols.map(qIdent).join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")}) returning *`;
    const { rows } = await pool.query(sql, values);
    return rows[0];
  }

  if (dsl.operation === "update") {
    if (!params.id) throw new Error("缺少 id");
    if (!fields.length) return executeApiDsl(schemaName, { ...dsl, operation: "detail" }, { id: params.id });
    const values = [...fields.map((field) => input[field]), params.id];
    const updatedAtSet = tableColumns.has("updated_at") ? ", updated_at = now()" : "";
    const sets = fields.map((field, index) => `${qIdent(field)} = $${index + 1}`).join(",");
    const { rows } = await pool.query(
      `update ${table} set ${sets}${updatedAtSet} where id = $${values.length} and deleted = false returning *`,
      values
    );
    return rows[0];
  }

  if (dsl.operation === "delete") {
    if (!params.id) throw new Error("缺少 id");
    const updatedAtSet = tableColumns.has("updated_at") ? ", updated_at = now()" : "";
    const { rows } = await pool.query(
      `update ${table} set deleted = true${updatedAtSet} where id = $1 and deleted = false returning id`,
      [params.id]
    );
    return { deleted: Boolean(rows[0]), id: params.id };
  }

  throw new Error("Unsupported api operation");
}
