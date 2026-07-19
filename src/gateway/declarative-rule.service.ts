import type pg from "pg";
import { qIdent } from "../db/schema-resolver.js";
import { TEMPLATE_SCHEMA } from "../common/template-schema.js";
import {
  COMMAND_BUSINESS_TYPES,
  CONTEXT_ENTITIES,
  COUNT_LIMIT_TABLES,
  evaluateFieldCheck,
  compareRuleValues,
  resolveRulePath,
  type CountLimitCheck,
  type FieldCheck,
} from "../common/declarative-rules.js";

// 声明式校验规则解释器：业务命令执行前，把租户在 admin.business_rule 里配置/AI 定制的
// category=validation 规则翻译成"命令前置校验"。规则只能收紧（校验不过 → 抛错阻断命令），
// 不能放宽引擎内置防护——内置余额/状态机/冲突校验仍在命令内部执行，与本解释器叠加生效。
//
// 与 command-engine 在同一事务、同一 client 上运行：规则拦截时整个命令回滚，无副作用。

type Row = Record<string, unknown>;

function str(value: unknown, fallback = "") {
  return value === undefined || value === null || value === "" ? fallback : String(value);
}

function asObject(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}

function dataOf(params: Row) {
  return (params.data ?? params) as Row;
}

async function loadValidationRules(client: pg.PoolClient, schemaName: string, businessTypes: string[]) {
  // category/businessType 可能被字典归一成 "business_rule_category.validation" / "business_type.charge_create" 形态，双形态匹配
  const businessTypeVariants = businessTypes.flatMap((type) => [type, `business_type.${type}`]);
  const { rows } = await client.query(
    `select distinct on (rule_code) rule_code, rule_json
     from admin.business_rule
     where status = 'active' and deleted = false
       and ((schema_scope = 'tenant' and schema_name = $1) or (schema_scope = 'tenant' and schema_name = '${TEMPLATE_SCHEMA}'))
       and (rule_json->>'category' in ('validation', 'business_rule_category.validation')
         or rule_json->'categories' ? 'validation'
         or rule_json->'categories' ? 'business_rule_category.validation')
       and coalesce(rule_json->>'businessType', rule_json->>'business_type') = any($2::text[])
     order by rule_code, case when schema_name = $1 then 0 else 1 end`,
    [schemaName, businessTypeVariants]
  );
  return rows
    .map((row) => ({ ruleCode: str(row.rule_code), rule: asObject(row.rule_json) }))
    .filter(({ rule }) => Array.isArray(rule.validations) && rule.validations.length > 0);
}

/** 按入参约定 ID 字段惰性加载 context.<entity>：只加载 validations 实际引用到的实体 */
async function buildRuleContext(
  client: pg.PoolClient,
  schemaName: string,
  input: Row,
  referencedEntities: Set<string>,
) {
  const context: Row = {};
  for (const entity of referencedEntities) {
    const meta = CONTEXT_ENTITIES[entity];
    if (!meta) continue;
    const id = meta.idFields.map((field) => str(input[field])).find(Boolean);
    if (!id) continue;
    const { rows } = await client.query(
      `select * from ${qIdent(schemaName)}.${qIdent(meta.table)} where id = $1 and coalesce(deleted, false) = false limit 1`,
      [id]
    );
    if (rows[0]) context[entity] = rows[0];
  }
  return context;
}

function collectReferencedEntities(validations: Row[]): Set<string> {
  const entities = new Set<string>();
  const scanPath = (value: unknown) => {
    const text = str(value);
    if (text.startsWith("context.")) {
      const entity = text.split(".")[1];
      if (entity) entities.add(entity);
    }
  };
  for (const check of validations) {
    scanPath(check.field);
    scanPath(check.valueField);
    for (const pre of Array.isArray(check.when) ? check.when : []) {
      scanPath(asObject(pre).field);
      scanPath(asObject(pre).valueField);
    }
    for (const cond of Array.isArray(check.where) ? check.where : []) {
      scanPath(asObject(cond).valueFrom);
    }
  }
  return entities;
}

async function evaluateCountLimit(
  client: pg.PoolClient,
  schemaName: string,
  check: CountLimitCheck,
  source: Row,
): Promise<{ passed: boolean; message?: string }> {
  const table = str(check.table);
  if (!COUNT_LIMIT_TABLES.has(table)) return { passed: true }; // 白名单外：结构校验层已拦，运行时静默跳过
  for (const pre of Array.isArray(check.when) ? check.when : []) {
    const preLeft = resolveRulePath(source, str(pre.field));
    const preRight = pre.valueField ? resolveRulePath(source, str(pre.valueField)) : pre.value;
    if (!compareRuleValues(preLeft, str(pre.operator, "="), preRight)) return { passed: true };
  }
  const where = ["coalesce(deleted, false) = false"];
  const values: unknown[] = [];
  for (const cond of Array.isArray(check.where) ? check.where : []) {
    const field = str(cond.field);
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(field)) continue;
    const value = cond.valueFrom !== undefined ? resolveRulePath(source, str(cond.valueFrom)) : cond.value;
    if (value === undefined || value === null || value === "") return { passed: true }; // 条件值缺失 → 规则不适用
    values.push(value);
    where.push(`cast(${qIdent(field)} as text) = cast($${values.length} as text)`);
  }
  if (values.length === 0) return { passed: true }; // 无有效条件禁止全表计数
  const { rows } = await client.query(
    `select count(*)::int as cnt from ${qIdent(schemaName)}.${qIdent(table)} where ${where.join(" and ")}`,
    values
  );
  const count = Number(rows[0]?.cnt ?? 0);
  return compareRuleValues(count, str(check.operator, "<"), Number(check.value)) // compareRuleValues 内部会归一字典形态操作符
    ? { passed: true }
    : { passed: false, message: check.message };
}

/**
 * 命令前置声明式校验入口。校验失败抛 statusCode=422 的错误（消息含规则名与自定义 message），
 * 由 command-engine 的事务包裹保证整体回滚。
 */
export async function runDeclarativeValidations(
  client: pg.PoolClient,
  schemaName: string,
  command: string,
  params: Row,
): Promise<void> {
  const businessTypes = COMMAND_BUSINESS_TYPES[command];
  if (!businessTypes?.length) return;
  const rules = await loadValidationRules(client, schemaName, businessTypes);
  if (!rules.length) return;

  const input = dataOf(params);
  for (const { ruleCode, rule } of rules) {
    const validations = (rule.validations as Row[]).filter((item) => item && typeof item === "object");
    const referenced = collectReferencedEntities(validations);
    const context = referenced.size ? await buildRuleContext(client, schemaName, input, referenced) : {};
    const source: Row = { data: input, context };
    for (const check of validations) {
      const result = str(check.type) === "count_limit"
        ? await evaluateCountLimit(client, schemaName, check as unknown as CountLimitCheck, source)
        : evaluateFieldCheck(check as unknown as FieldCheck, source);
      if (!result.passed) {
        const ruleName = str(rule.ruleName ?? rule.rule_name, ruleCode);
        const message = str(result.message, `不满足业务规则「${ruleName}」`);
        throw Object.assign(new Error(message), { statusCode: 422, ruleCode, declarativeRule: true });
      }
    }
  }
}
