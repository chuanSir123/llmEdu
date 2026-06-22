import { pool } from "../db/pool.js";
import { qIdent } from "../db/schema-resolver.js";
import type { SessionUser } from "../types.js";
import { getOrganizationScope } from "../permission/permission.service.js";
import { inferForeignKeyMeta } from "../common/foreign-key-meta.js";

const FIELD = /^[a-z][a-z0-9_]{0,62}$/;

function flattenExtJson(row: Record<string, unknown>): Record<string, unknown> {
  const extJson = row.ext_json;
  if (!extJson || typeof extJson !== "object" || Array.isArray(extJson)) return row;
  const { ext_json, ...rest } = row;
  const flat: Record<string, unknown> = { ...rest };
  for (const [key, value] of Object.entries(extJson as Record<string, unknown>)) {
    if (!(key in flat)) flat[key] = value;
  }
  return flat;
}
type JoinDsl = { table: string; schema?: string; alias: string; on: { left: string; right: string }; fields?: Array<{ source: string; as: string }> };
type WhereCondition = {
  field: string;
  op: "eq" | "ilike" | "between" | "in" | "gt" | "gte" | "lt" | "lte";
  value?: unknown;
  param?: string;
  source: "constant" | "fixed" | "param";
  ignoreEmpty?: boolean;
};
type SelectField = { field: string; as?: string };
type FilterDsl = string | {
  key?: string;
  field?: string;
  param?: string;
  op?: "eq" | "ilike" | "between" | "in" | "gt" | "gte" | "lt" | "lte";
  type?: string;
  ignoreEmpty?: boolean;
};
type AggregateMetric = {
  field?: string;
  type?: "count" | "sum" | "avg" | "min" | "max" | "distinct_count";
  aggregate?: "count" | "sum" | "avg" | "min" | "max" | "distinct_count";
  as?: string;
};
type SortDsl = string | { field?: string; direction?: "asc" | "desc" };
type ApiDsl = {
  table: string;
  schema?: string;
  alias?: string;
  joins?: JoinDsl[];
  operation: "query" | "detail" | "create" | "update" | "delete";
  select?: SelectField[];
  allowedFields?: string[];
  groupBy?: string[];
  dimensions?: string[];
  metrics?: AggregateMetric[];
  where?: WhereCondition[];
  filters?: FilterDsl[];
  fixedFilters?: Array<{ field: string; op?: "eq" | "ne"; value?: unknown; valueFromParam?: string }>;
  sort?: SortDsl;
  orderBy?: SortDsl[];
  rank?: boolean;
  softDelete?: boolean;
  security?: { requireLogin?: boolean; dataPermission?: string };
};

const tableColumnsCache = new Map<string, Set<string>>();

export function assertField(field: string) {
  if (!FIELD.test(field)) throw Object.assign(new Error(`Unsafe field: ${field}`), { statusCode: 400 });
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

function sqlStringLiteral(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

function dbValue(value: unknown) {
  if (value && typeof value === "object" && !(value instanceof Date)) return JSON.stringify(value);
  return value;
}

function fieldExpr(field: string, tableColumns: Set<string>) {
  const safeField = assertField(field);
  if (tableColumns.has(safeField)) return `t.${qIdent(safeField)}`;
  if (tableColumns.has("ext_json")) return `t.ext_json ->> ${sqlStringLiteral(safeField)}`;
  throw Object.assign(new Error(`字段不存在: ${safeField}`), { statusCode: 400 });
}

async function selectColumns(schemaName: string, dsl: ApiDsl) {
  const tableColumns = await getTableColumns(schemaName, dsl.table);
  const cols = ["t.id"];
  const selectedAliases = new Set<string>(["id"]);
  const selectedForeignKeys = new Set<string>();
  for (const field of dsl.allowedFields ?? []) {
    const safeField = assertField(field);
    if (!selectedAliases.has(safeField)) {
      cols.push(`${fieldExpr(safeField, tableColumns)} as ${qIdent(safeField)}`);
      selectedAliases.add(safeField);
    }
    selectedForeignKeys.add(safeField);
  }
  if (dsl.select && dsl.select.length > 0) {
    for (const s of dsl.select) {
      const field = assertField(s.field);
      const alias = s.as ? assertField(s.as) : field;
      if (selectedAliases.has(alias)) continue;
      cols.push(`${fieldExpr(field, tableColumns)} as ${qIdent(alias)}`);
      selectedAliases.add(alias);
      selectedForeignKeys.add(field);
    }
  }
  for (const join of dsl.joins ?? []) {
    for (const field of join.fields ?? []) {
      cols.push(`${qIdent(join.alias)}.${qIdent(assertField(field.source))} as ${qIdent(assertField(field.as))}`);
    }
  }
  for (const field of selectedForeignKeys) {
    if (field === "management_organization_ids" && tableColumns.has("management_organization_ids") && !selectedAliases.has("management_organization_names")) {
      cols.push(`(select string_agg(org.name, ', ' order by org.name) from ${tableExpr(schemaName, "organization")} org where org.id in (select jsonb_array_elements_text(coalesce(t.management_organization_ids, '[]'::jsonb))) and coalesce(org.deleted, false) = false) as management_organization_names`);
      selectedAliases.add("management_organization_names");
      continue;
    }
    const meta = inferForeignKeyMeta(field);
    if (!meta || selectedAliases.has(meta.displayKey)) continue;
    const sourceExpr = fieldExpr(field, tableColumns);
    if (field === "contract_product_id") {
      cols.push(`(select p.name from ${tableExpr(schemaName, "contract_product")} cp left join ${tableExpr(schemaName, "product")} p on cp.product_id = p.id and coalesce(p.deleted, false) = false where cp.id = ${sourceExpr} and coalesce(cp.deleted, false) = false limit 1) as ${qIdent(meta.displayKey)}`);
      selectedAliases.add(meta.displayKey);
      continue;
    }
    const fkColumns = await getTableColumns(schemaName, meta.table);
    if (!fkColumns.has(meta.labelField) || !fkColumns.has(meta.valueField)) continue;
    cols.push(`(select fk.${qIdent(meta.labelField)} from ${tableExpr(schemaName, meta.table)} fk where fk.${qIdent(meta.valueField)} = ${sourceExpr} and coalesce(fk.deleted, false) = false limit 1) as ${qIdent(meta.displayKey)}`);
    selectedAliases.add(meta.displayKey);
  }
  if (tableColumns.has("created_at")) cols.push("t.created_at");
  if (tableColumns.has("updated_at")) cols.push("t.updated_at");
  if (tableColumns.has("ext_json")) cols.push("t.ext_json");
  return cols.join(", ");
}

async function foreignKeyDisplayColumns(schemaName: string, tableColumns: Set<string>, fields: Set<string>, selectedAliases: Set<string>) {
  const cols: string[] = [];
  for (const field of fields) {
    const meta = inferForeignKeyMeta(field);
    if (!meta || selectedAliases.has(meta.displayKey)) continue;
    const sourceExpr = fieldExpr(field, tableColumns);
    if (field === "contract_product_id") {
      cols.push(`(select p.name from ${tableExpr(schemaName, "contract_product")} cp left join ${tableExpr(schemaName, "product")} p on cp.product_id = p.id and coalesce(p.deleted, false) = false where cp.id = ${sourceExpr} and coalesce(cp.deleted, false) = false limit 1) as ${qIdent(meta.displayKey)}`);
      selectedAliases.add(meta.displayKey);
      continue;
    }
    const fkColumns = await getTableColumns(schemaName, meta.table);
    if (!fkColumns.has(meta.labelField) || !fkColumns.has(meta.valueField)) continue;
    cols.push(`(select fk.${qIdent(meta.labelField)} from ${tableExpr(schemaName, meta.table)} fk where fk.${qIdent(meta.valueField)} = ${sourceExpr} and coalesce(fk.deleted, false) = false limit 1) as ${qIdent(meta.displayKey)}`);
    selectedAliases.add(meta.displayKey);
  }
  return cols;
}

function metricSql(metric: AggregateMetric, tableColumns: Set<string>) {
  const built = metricAggregateExpr(metric, tableColumns);
  return { sql: `${built.expr} as ${qIdent(built.alias)}`, alias: built.alias };
}

function metricAggregateExpr(metric: AggregateMetric, tableColumns: Set<string>) {
  const type = String(metric.type ?? metric.aggregate ?? "count").toLowerCase();
  const alias = assertField(String(metric.as ?? metric.field ?? type));
  if (type === "count") {
    const expr = metric.field ? fieldExpr(metric.field, tableColumns) : "*";
    return { expr: `count(${expr})`, alias };
  }
  if (!metric.field) throw Object.assign(new Error(`聚合指标缺少字段: ${alias}`), { statusCode: 400 });
  const expr = fieldExpr(metric.field, tableColumns);
  switch (type) {
    case "sum":
    case "avg":
    case "min":
    case "max":
      return { expr: `${type}(${expr})`, alias };
    case "distinct_count":
      return { expr: `count(distinct ${expr})`, alias };
    default:
      throw Object.assign(new Error(`不支持的聚合类型: ${type}`), { statusCode: 400 });
  }
}

function sortItems(dsl: ApiDsl): SortDsl[] {
  if (Array.isArray(dsl.orderBy) && dsl.orderBy.length) return dsl.orderBy;
  return dsl.sort ? [dsl.sort] : [];
}

function parseSort(sort: SortDsl | undefined) {
  if (!sort) return undefined;
  if (typeof sort === "string") {
    const [field, direction] = sort.trim().split(/\s+/);
    return field ? { field, direction: direction?.toLowerCase() === "asc" ? "asc" as const : "desc" as const } : undefined;
  }
  const field = String(sort.field ?? "");
  if (!field) return undefined;
  return { field, direction: sort.direction === "asc" ? "asc" as const : "desc" as const };
}


function queryOrderClause(dsl: ApiDsl, tableColumns: Set<string>) {
  const orderExprs = sortItems(dsl)
    .map((sort) => {
      const parsed = parseSort(sort);
      if (!parsed) return undefined;
      return `${fieldExpr(parsed.field, tableColumns)} ${parsed.direction}`;
    })
    .filter(Boolean);
  if (orderExprs.length > 0) return `order by ${orderExprs.join(", ")}`;
  const orderColumn = tableColumns.has("created_at") ? "created_at" : "id";
  return `order by t.${qIdent(orderColumn)} desc`;
}

function aggregateOrderExpr(sort: SortDsl | undefined, dimensions: string[], metrics: AggregateMetric[], tableColumns: Set<string>) {
  const parsed = parseSort(sort);
  if (!parsed) return undefined;
  const metric = metrics.find((item) => String(item.as ?? item.field ?? item.type ?? "") === parsed.field);
  const expr = metric ? metricAggregateExpr(metric, tableColumns).expr : dimensions.includes(parsed.field) ? fieldExpr(parsed.field, tableColumns) : undefined;
  return expr ? `${expr} ${parsed.direction}` : undefined;
}

function isEmptyFilterValue(value: unknown) {
  return value === undefined || value === null || value === "" || (Array.isArray(value) && value.every(isEmptyFilterValue));
}

function nextDay(value: unknown) {
  const text = String(value ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return value;
  const date = new Date(`${text}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function appendDynamicFilters(where: string[], values: unknown[], filterDsl: FilterDsl[] | undefined, params: Record<string, unknown>, tableColumns: Set<string>) {
  const inputFilters = (params.filters ?? {}) as Record<string, unknown>;
  for (const raw of filterDsl ?? []) {
    const filter = typeof raw === "string" ? { field: raw, key: raw, op: "ilike" as const } : raw;
    const field = String(filter.field ?? filter.key ?? "");
    if (!field) continue;
    const param = String(filter.param ?? filter.key ?? field);
    const value = inputFilters[param];
    if (isEmptyFilterValue(value)) {
      if (filter.ignoreEmpty !== false) continue;
    }
    const expr = fieldExpr(field, tableColumns);
    const op = filter.op ?? (filter.type === "date_range" || filter.type === "daterange" ? "between" : filter.type === "text" ? "ilike" : "eq");
    if ((filter.type === "date_range" || filter.type === "daterange") && op === "between") {
      const range = Array.isArray(value)
        ? value
        : value && typeof value === "object"
          ? [(value as Record<string, unknown>).start, (value as Record<string, unknown>).end]
          : [];
      const [start, end] = range;
      if (!isEmptyFilterValue(start)) {
        values.push(start);
        where.push(`${expr} >= $${values.length}`);
      }
      if (!isEmptyFilterValue(end)) {
        values.push(nextDay(end));
        where.push(`${expr} < $${values.length}`);
      }
      continue;
    }
    if (op === "between") {
      const range = Array.isArray(value) ? value : [];
      if (range.length < 2 || isEmptyFilterValue(range[0]) || isEmptyFilterValue(range[1])) continue;
      values.push(range[0], range[1]);
      where.push(`${expr} between $${values.length - 1} and $${values.length}`);
      continue;
    }
    if (op === "ilike") {
      values.push(`%${value}%`);
      where.push(`cast(${expr} as text) ilike $${values.length}`);
      continue;
    }
    if (op === "in") {
      const arr = Array.isArray(value) ? value.filter((item) => !isEmptyFilterValue(item)) : [];
      if (!arr.length) continue;
      const placeholders = arr.map((item) => {
        values.push(item);
        return `$${values.length}`;
      });
      where.push(`${expr} in (${placeholders.join(", ")})`);
      continue;
    }
    values.push(value);
    const sqlOp = op === "gt" ? ">" : op === "gte" ? ">=" : op === "lt" ? "<" : op === "lte" ? "<=" : "=";
    where.push(`${expr} ${sqlOp} $${values.length}`);
  }
}

function appendDataPermissionScope(where: string[], values: unknown[], tableColumns: Set<string>, tableName: string, scope: { whereSql: string; params: unknown[] }) {
  if (!scope.whereSql) return;
  let whereSql = scope.whereSql;
  if (whereSql.includes("organization_id") && !tableColumns.has("organization_id")) {
    if (tableName !== "organization") return;
    whereSql = whereSql.replace(/t\.organization_id/g, "t.id");
  }
  const offset = values.length;
  where.push(whereSql.replace(/\$(\d+)/g, (_, index) => `$${Number(index) + offset}`));
  values.push(...scope.params);
}

async function executeAggregateQuery(schemaName: string, dsl: ApiDsl, params: Record<string, unknown>, user: SessionUser | undefined, table: string, tableColumns: Set<string>) {
  const dimensions = [...new Set([...(dsl.groupBy ?? []), ...(dsl.dimensions ?? [])])].filter(Boolean);
  const metrics = dsl.metrics ?? [];
  if (!dimensions.length && !metrics.length) return undefined;

  const values: unknown[] = [];
  const where = dsl.softDelete === false ? [] : ["t.deleted = false"];
  for (const fixed of dsl.fixedFilters ?? []) {
    const val = fixed.valueFromParam ? params[fixed.valueFromParam] : fixed.value;
    if (val === undefined || val === null) continue;
    values.push(val);
    const op = fixed.op === "ne" ? "<>" : "=";
    where.push(`${fieldExpr(fixed.field, tableColumns)} ${op} $${values.length}`);
  }
  appendDynamicFilters(where, values, dsl.filters, params, tableColumns);
  if (dsl.where && dsl.where.length > 0) {
    const { fragments } = buildWhereClause(dsl.where, params, values, values.length + 1, tableColumns);
    where.push(...fragments);
  }
  if (dsl.security?.dataPermission && user) {
    const scope = await getOrganizationScope(user, schemaName);
    appendDataPermissionScope(where, values, tableColumns, dsl.table, scope);
  }

  const selectedAliases = new Set<string>();
  const dimensionSelects = dimensions.map((field) => {
    const safeField = assertField(field);
    selectedAliases.add(safeField);
    return `${fieldExpr(safeField, tableColumns)} as ${qIdent(safeField)}`;
  });
  const metricSelects = metrics.map((metric) => {
    const built = metricSql(metric, tableColumns);
    selectedAliases.add(built.alias);
    return built.sql;
  });
  const primarySort = sortItems(dsl)[0] ?? (metrics[0] ? { field: String(metrics[0].as ?? metrics[0].field ?? ""), direction: "desc" as const } : undefined);
  const rankOrderExpr = aggregateOrderExpr(primarySort, dimensions, metrics, tableColumns);
  const rankSelect = dsl.rank && rankOrderExpr ? [`row_number() over(order by ${rankOrderExpr}) as rank`] : [];
  const displaySelects = await foreignKeyDisplayColumns(schemaName, tableColumns, new Set(dimensions), selectedAliases);
  const selectList = [...rankSelect, ...dimensionSelects, ...displaySelects, ...metricSelects];
  if (!selectList.length) selectList.push("count(*) as count");

  const groupExprs = dimensions.map((field) => fieldExpr(field, tableColumns));
  const whereClause = where.length > 0 ? `where ${where.join(" and ")}` : "";
  const groupClause = groupExprs.length > 0 ? `group by ${groupExprs.join(", ")}` : "";
  const orderExprs = sortItems(dsl).map((sort) => aggregateOrderExpr(sort, dimensions, metrics, tableColumns)).filter(Boolean);
  const orderClause = orderExprs.length > 0 ? `order by ${orderExprs.join(", ")}` : groupExprs.length > 0 ? `order by ${groupExprs[0]} asc` : "";
  const page = Math.max(Number(params.page ?? 1), 1);
  const pageSize = Math.min(Math.max(Number(params.pageSize ?? 20), 1), 100);
  values.push(pageSize, (page - 1) * pageSize);
  const sql = `
    select ${selectList.join(", ")}, count(*) over() as __total
    from ${table} t
    ${joinSql(schemaName, dsl.joins, dsl.softDelete !== false)}
    ${whereClause}
    ${groupClause}
    ${orderClause}
    limit $${values.length - 1} offset $${values.length}
  `;
  const { rows } = await pool.query(sql, values);
  const total = rows[0]?.__total ? Number(rows[0].__total) : 0;
  return { rows: rows.map(({ __total, ...row }) => flattenExtJson(row)), total, page, pageSize };
}

function joinSql(schemaName: string, joins: JoinDsl[] = [], softDelete = true) {
  return joins
    .map((join) => {
      assertField(join.alias);
      assertField(join.on.left);
      assertField(join.on.right);
      const delClause = softDelete ? ` and ${qIdent(join.alias)}.deleted = false` : "";
      const joinSchema = join.schema ?? schemaName;
      return `left join ${tableExpr(joinSchema, join.table)} ${qIdent(join.alias)} on t.${qIdent(join.on.left)} = ${qIdent(join.alias)}.${qIdent(join.on.right)}${delClause}`;
    })
    .join(" ");
}

function buildWhereClause(where: WhereCondition[], params: Record<string, unknown>, values: unknown[], startIdx: number, tableColumns: Set<string>) {
  const fragments: string[] = [];
  let idx = startIdx;
  for (const cond of where) {
    const field = assertField(cond.field);
    const expr = fieldExpr(field, tableColumns);
    let val: unknown;
    if (cond.source === "param") {
      val = params[cond.param ?? cond.field];
    } else {
      val = cond.value;
    }
    if (cond.ignoreEmpty && (val === undefined || val === null || val === "")) continue;

    switch (cond.op) {
      case "eq":
        values.push(val);
        fragments.push(`${expr} = $${idx++}`);
        break;
      case "ilike":
        values.push(`%${val}%`);
        fragments.push(`cast(${expr} as text) ilike $${idx++}`);
        break;
      case "between": {
        const arr = val as unknown[];
        if (!Array.isArray(arr) || arr.length < 2) continue;
        values.push(arr[0], arr[1]);
        fragments.push(`${expr} between $${idx++} and $${idx++}`);
        break;
      }
      case "in": {
        const arr = val as unknown[];
        if (!Array.isArray(arr) || arr.length === 0) continue;
        const ph = arr.map(() => `$${idx++}`);
        values.push(...arr);
        fragments.push(`${expr} in (${ph.join(", ")})`);
        break;
      }
      case "gt":
        values.push(val);
        fragments.push(`${expr} > $${idx++}`);
        break;
      case "gte":
        values.push(val);
        fragments.push(`${expr} >= $${idx++}`);
        break;
      case "lt":
        values.push(val);
        fragments.push(`${expr} < $${idx++}`);
        break;
      case "lte":
        values.push(val);
        fragments.push(`${expr} <= $${idx++}`);
        break;
    }
  }
  return { fragments, nextIdx: idx };
}

export async function executeApiDsl(schemaName: string, dsl: ApiDsl, params: Record<string, unknown>, user?: SessionUser) {
  const effectiveSchema = dsl.schema ?? schemaName;
  const table = tableExpr(effectiveSchema, dsl.table);
  const tableColumns = await getTableColumns(effectiveSchema, dsl.table);
  if (dsl.operation === "query") {
    const aggregateResult = await executeAggregateQuery(effectiveSchema, dsl, params, user, table, tableColumns);
    if (aggregateResult) return aggregateResult;

    const values: unknown[] = [];
    const where = dsl.softDelete === false ? [] : ["t.deleted = false"];
    for (const fixed of dsl.fixedFilters ?? []) {
      const val = fixed.valueFromParam ? params[fixed.valueFromParam] : fixed.value;
      if (val === undefined || val === null) continue;
      values.push(val);
      const op = fixed.op === "ne" ? "<>" : "=";
      where.push(`${fieldExpr(fixed.field, tableColumns)} ${op} $${values.length}`);
    }
    appendDynamicFilters(where, values, dsl.filters, params, tableColumns);
    if (dsl.where && dsl.where.length > 0) {
      const { fragments } = buildWhereClause(dsl.where, params, values, values.length + 1, tableColumns);
      where.push(...fragments);
    }
    if (dsl.security?.dataPermission && user) {
      const scope = await getOrganizationScope(user, schemaName);
      appendDataPermissionScope(where, values, tableColumns, dsl.table, scope);
    }
    const page = Math.max(Number(params.page ?? 1), 1);
    const pageSize = Math.min(Math.max(Number(params.pageSize ?? 20), 1), 100);
    values.push(pageSize, (page - 1) * pageSize);
    const whereClause = where.length > 0 ? `where ${where.join(" and ")}` : "";
    const orderClause = queryOrderClause(dsl, tableColumns);
    const sql = `
      select ${await selectColumns(effectiveSchema, dsl)}, count(*) over() as __total
      from ${table} t
      ${joinSql(effectiveSchema, dsl.joins, dsl.softDelete !== false)}
      ${whereClause}
      ${orderClause}
      limit $${values.length - 1} offset $${values.length}
    `;
    const { rows } = await pool.query(sql, values);
    const total = rows[0]?.__total ? Number(rows[0].__total) : 0;
    return { rows: rows.map(({ __total, ...row }) => flattenExtJson(row)), total, page, pageSize };
  }

  if (dsl.operation === "detail") {
    const delClause = dsl.softDelete === false ? "" : " and t.deleted = false";
    const values: unknown[] = [params.id];
    const where = [`t.id = $1${delClause}`];
    if (dsl.security?.dataPermission && user) {
      const scope = await getOrganizationScope(user, schemaName);
      appendDataPermissionScope(where, values, tableColumns, dsl.table, scope);
    }
    const { rows } = await pool.query(
      `select ${await selectColumns(effectiveSchema, dsl)} from ${table} t ${joinSql(effectiveSchema, dsl.joins, dsl.softDelete !== false)} where ${where.join(" and ")}`,
      values
    );
    return rows[0] ? flattenExtJson(rows[0]) : null;
  }

  const allowed = new Set(dsl.allowedFields ?? []);
  const input = (params.data ?? {}) as Record<string, unknown>;
  const hasExtJson = tableColumns.has("ext_json");
  const fields = Object.keys(input).filter((key) => allowed.has(key) && FIELD.test(key) && tableColumns.has(key));
  const extFields = hasExtJson
    ? Object.keys(input).filter((key) => allowed.has(key) && FIELD.test(key) && !tableColumns.has(key))
    : [];

  if (dsl.operation === "create") {
    const newId = String(params.id ?? await nextTextId(effectiveSchema, dsl.table));
    const cols = ["id", ...fields];
    const values: unknown[] = [newId, ...fields.map((field) => dbValue(input[field]))];
    if (hasExtJson && extFields.length > 0) {
      const extObj: Record<string, unknown> = {};
      for (const f of extFields) extObj[f] = input[f];
      cols.push("ext_json");
      values.push(JSON.stringify(extObj));
    }
    const sql = `insert into ${table} (${cols.map(qIdent).join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")}) returning *`;
    const { rows } = await pool.query(sql, values);
    return rows[0];
  }

  if (dsl.operation === "update") {
    if (!params.id) throw new Error("缺少 id");
    if (!fields.length && !extFields.length) return executeApiDsl(schemaName, { ...dsl, operation: "detail" }, { id: params.id }, user);
    const values: unknown[] = [];
    const sets: string[] = [];
    let idx = 1;
    for (const field of fields) {
      sets.push(`${qIdent(field)} = $${idx}`);
      values.push(dbValue(input[field]));
      idx++;
    }
    if (hasExtJson && extFields.length > 0) {
      const extObj: Record<string, unknown> = {};
      for (const f of extFields) extObj[f] = input[f];
      sets.push(`ext_json = coalesce(ext_json, '{}')::jsonb || $${idx}::jsonb`);
      values.push(JSON.stringify(extObj));
      idx++;
    }
    if (tableColumns.has("updated_at")) sets.push("updated_at = now()");
    values.push(params.id);
    const where = [`t.id = $${values.length}${dsl.softDelete === false ? "" : " and t.deleted = false"}`];
    if (dsl.security?.dataPermission && user) {
      const scope = await getOrganizationScope(user, schemaName);
      appendDataPermissionScope(where, values, tableColumns, dsl.table, scope);
    }
    const { rows } = await pool.query(
      `update ${table} t set ${sets.join(",")} where ${where.join(" and ")} returning *`,
      values
    );
    return rows[0];
  }

  if (dsl.operation === "delete") {
    if (!params.id) throw new Error("缺少 id");
    const values: unknown[] = [params.id];
    const where = ["t.id = $1"];
    if (dsl.security?.dataPermission && user) {
      const scope = await getOrganizationScope(user, schemaName);
      appendDataPermissionScope(where, values, tableColumns, dsl.table, scope);
    }
    if (dsl.softDelete === false) {
      const { rows } = await pool.query(`delete from ${table} t where ${where.join(" and ")} returning id`, values);
      return { deleted: Boolean(rows[0]), id: params.id };
    }
    const updatedAtSet = tableColumns.has("updated_at") ? ", updated_at = now()" : "";
    const { rows } = await pool.query(
      `update ${table} t set deleted = true${updatedAtSet} where ${where.join(" and ")} and t.deleted = false returning id`,
      values
    );
    return { deleted: Boolean(rows[0]), id: params.id };
  }

  throw new Error("Unsupported api operation");
}
