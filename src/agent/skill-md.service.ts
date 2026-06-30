import { pool } from "../db/pool.js";
import { BUSINESS_API_EVENT_MAP, BUSINESS_COMMAND_EVENT_MAP } from "../gateway/business-event.service.js";

type PageDslJson = {
  title?: string;
  filters?: Array<{ key?: string; label?: string; type?: string; placeholder?: string }>;
  table?: {
    columns?: Array<{ key?: string; label?: string; type?: string; width?: number; sortable?: boolean; badge?: boolean; align?: string }>;
  };
  toolbar?: Array<{ actionCode?: string; label?: string; variant?: string; type?: string }>;
  modal?: {
    fields?: Array<{ key?: string; label?: string; type?: string; required?: boolean; span?: string | number }>;
  };
};

type ApiDslJson = {
  table?: string;
  joins?: Array<{ table?: string; alias?: string; on?: { left?: string; right?: string }; fields?: Array<{ source?: string; as?: string }> }>;
  select?: Array<{ field?: string; as?: string }>;
  sort?: string | Array<{ field?: string; direction?: string }>;
  where?: Array<{ field?: string; op?: string; source?: string; value?: unknown }>;
  filters?: string[];
  operation?: string;
};

type BusinessEventRelation = {
  ruleCode: string;
  ruleName: string;
  listenerFeatureCode: string;
  triggerEvent: string;
  sourceFeatures: string[];
  actionCommands: string[];
  targetFeatures: string[];
};

export type SkillMdMetadata = {
  featureCode?: string;
  featureName?: string;
  featureDescription?: string;
  primaryTable?: string;
};

export function extractSkillMdMetadata(content: string): SkillMdMetadata {
  const metadata: SkillMdMetadata = {};
  const lines = content.split(/\r?\n/);
  let inStandardMetadata = false;

  for (const line of lines) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      inStandardMetadata = heading[1].trim() === "标准元数据";
      continue;
    }
    if (!inStandardMetadata) continue;
    const match = line.match(/^[-*]\s*([^:：]+)\s*[:：]\s*(.*?)\s*$/);
    if (!match) continue;
    const key = match[1].trim();
    const value = match[2].trim();
    if (!value) continue;
    if (key === "功能编码") metadata.featureCode = value.replace(/^skill_/, "");
    if (key === "功能名称") metadata.featureName = value;
    if (key === "功能描述") metadata.featureDescription = value;
    if (key === "主数据表") metadata.primaryTable = value;
  }

  if (!metadata.featureName) {
    const title = lines.find((line) => /^#\s+/.test(line));
    if (title) metadata.featureName = title.replace(/^#\s+/, "").trim();
  }
  if (!metadata.featureDescription) {
    const sectionText = extractSectionText(content, "功能描述");
    if (sectionText) metadata.featureDescription = sectionText;
  }
  if (!metadata.primaryTable) {
    const tableMatch = content.match(/[-•]\s*表[：:]\s*(\w+)/);
    if (tableMatch) metadata.primaryTable = tableMatch[1];
  }
  return metadata;
}

export function hasStandardSkillMdMetadata(content: string): boolean {
  const metadata = extractSkillMdMetadata(content);
  return Boolean(metadata.featureCode && metadata.featureName && metadata.featureDescription);
}

export function formatSkillSummaryFromMd(input: {
  skillCode?: string;
  skillName?: string;
  featureCode?: string;
  content?: string;
  fallbackChars?: number;
}): string {
  const content = input.content ?? "";
  const metadata = extractSkillMdMetadata(content);
  const featureCode = metadata.featureCode ?? input.featureCode ?? input.skillCode?.replace(/^skill_/, "");
  const featureName = metadata.featureName ?? input.skillName ?? featureCode ?? input.skillCode ?? "";
  const description = metadata.featureDescription ?? content.trim().replace(/\s+/g, " ").slice(0, input.fallbackChars ?? 200);
  const table = metadata.primaryTable ? `；主数据表：${metadata.primaryTable}` : "";
  const code = featureCode ? `功能编码：${featureCode}；` : "";
  return `${code}功能名称：${featureName}；功能描述：${description}${table}`;
}

function extractSectionText(content: string, sectionTitle: string): string {
  const lines = content.split(/\r?\n/);
  const result: string[] = [];
  let inSection = false;
  for (const line of lines) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      if (inSection) break;
      inSection = heading[1].trim() === sectionTitle;
      continue;
    }
    if (!inSection) continue;
    const trimmed = line.trim();
    if (trimmed) result.push(trimmed.replace(/^[-*]\s*/, ""));
    if (result.join("").length > 240) break;
  }
  return result.join(" ").slice(0, 240);
}

export function collectPrimaryTables(apiDsls: Array<{ dsl_json: ApiDslJson | null }>): string[] {
  return [...new Set(apiDsls.flatMap((api) => [api.dsl_json?.table, ...((api.dsl_json?.joins ?? []).map((join) => join.table))]).filter((item): item is string => Boolean(item)))];
}

export function generateSkillMd(input: {
  pageDsl: PageDslJson | null;
  apiDsls: Array<{ api_code: string; api_type: string; dsl_json: ApiDslJson | null }>;
  actionDsls: Array<{ action_code: string; action_name?: string; action_type?: string; dsl_json?: Record<string, unknown> }>;
  featureCode?: string;
  featureName: string;
  featureDescription?: string;
  // 主数据表的真实物理列（来自 information_schema），让 SKILL.md 自动包含表的全部已有字段
  tableColumns?: Record<string, Array<{ column_name: string; data_type: string }>>;
  businessEventRelations?: {
    listensTo: BusinessEventRelation[];
    listenedBy: BusinessEventRelation[];
  };
}): string {
  const primaryTables = collectPrimaryTables(input.apiDsls);
  const lines: string[] = [];
  lines.push(`# ${input.featureName}`);
  lines.push("");
  lines.push("## 标准元数据");
  lines.push(`- 功能编码: ${input.featureCode ?? ""}`);
  lines.push(`- 功能名称: ${input.featureName}`);
  lines.push(`- 功能描述: ${input.featureDescription ?? input.pageDsl?.title ?? input.featureName}`);
  lines.push(`- 主数据表: ${primaryTables[0] ?? ""}`);
  lines.push("");

  lines.push("## 功能描述");
  lines.push(input.featureDescription ?? input.pageDsl?.title ?? input.featureName);
  lines.push("");

  lines.push("## 业务事件监听关系");
  lines.push("");
  lines.push("### 监听了哪些功能");
  const listensTo = input.businessEventRelations?.listensTo ?? [];
  if (listensTo.length > 0) {
    lines.push("| 规则 | 触发事件 | 被监听功能 | 触发命令 | 命令目标功能 |");
    lines.push("|------|----------|------------|----------|--------------|");
    for (const relation of listensTo) {
      lines.push(`| ${relation.ruleCode} ${relation.ruleName} | ${relation.triggerEvent} | ${relation.sourceFeatures.join(", ")} | ${relation.actionCommands.join(", ")} | ${relation.targetFeatures.join(", ")} |`);
    }
  } else {
    lines.push("（未监听其他功能）");
  }
  lines.push("");
  lines.push("### 被哪些功能监听");
  const listenedBy = input.businessEventRelations?.listenedBy ?? [];
  if (listenedBy.length > 0) {
    lines.push("| 监听方功能 | 规则 | 触发事件 | 触发命令 | 命令目标功能 |");
    lines.push("|------------|------|----------|----------|--------------|");
    for (const relation of listenedBy) {
      lines.push(`| ${relation.listenerFeatureCode} | ${relation.ruleCode} ${relation.ruleName} | ${relation.triggerEvent} | ${relation.actionCommands.join(", ")} | ${relation.targetFeatures.join(", ")} |`);
    }
  } else {
    lines.push("（未被其他功能监听）");
  }
  lines.push("");

  lines.push("## 数据表");
  if (primaryTables.length > 0) {
    for (const table of primaryTables) lines.push(`- 表: ${table}`);
  } else {
    lines.push("（未识别到数据表）");
  }
  lines.push("");

  const tableColumns = input.tableColumns ?? {};
  if (Object.keys(tableColumns).length > 0) {
    lines.push("## 物理字段（数据库真实列）");
    lines.push("");
    for (const table of primaryTables) {
      const columns = tableColumns[table];
      if (!columns || columns.length === 0) continue;
      lines.push(`### ${table}`);
      lines.push("| 字段 | 类型 |");
      lines.push("|------|------|");
      for (const column of columns) {
        lines.push(`| ${column.column_name} | ${column.data_type} |`);
      }
      lines.push("");
    }
  }

  lines.push("## 页面结构 (page_dsl)");
  lines.push("");
  lines.push("### 筛选条件 (filters)");
  const filters = input.pageDsl?.filters ?? [];
  if (filters.length > 0) {
    lines.push("| key | label | type | placeholder |");
    lines.push("|-----|-------|------|-------------|");
    for (const f of filters) {
      lines.push(`| ${f.key ?? ""} | ${f.label ?? ""} | ${f.type ?? ""} | ${f.placeholder ?? ""} |`);
    }
  } else {
    lines.push("（无筛选条件）");
  }
  lines.push("");

  lines.push("### 表格列 (table.columns)");
  const columns = input.pageDsl?.table?.columns ?? [];
  if (columns.length > 0) {
    lines.push("| key | label | type | width | sortable | badge | align |");
    lines.push("|-----|-------|------|-------|----------|-------|-------|");
    for (const c of columns) {
      lines.push(`| ${c.key ?? ""} | ${c.label ?? ""} | ${c.type ?? ""} | ${c.width ?? ""} | ${c.sortable ?? ""} | ${c.badge ?? ""} | ${c.align ?? ""} |`);
    }
  } else {
    lines.push("（无表格列）");
  }
  lines.push("");

  lines.push("### 工具栏 (toolbar)");
  const toolbar = input.pageDsl?.toolbar ?? [];
  if (toolbar.length > 0) {
    lines.push("| actionCode | label | variant | type |");
    lines.push("|------------|-------|---------|------|");
    for (const t of toolbar) {
      lines.push(`| ${t.actionCode ?? ""} | ${t.label ?? ""} | ${t.variant ?? ""} | ${t.type ?? ""} |`);
    }
  } else {
    lines.push("（无工具栏）");
  }
  lines.push("");

  lines.push("### 弹窗字段 (modal.fields)");
  const modalFields = input.pageDsl?.modal?.fields ?? [];
  if (modalFields.length > 0) {
    lines.push("| key | label | type | required | span |");
    lines.push("|-----|-------|------|----------|------|");
    for (const f of modalFields) {
      lines.push(`| ${f.key ?? ""} | ${f.label ?? ""} | ${f.type ?? ""} | ${f.required ?? ""} | ${f.span ?? ""} |`);
    }
  } else {
    lines.push("（无弹窗字段）");
  }
  lines.push("");

  lines.push("## API 定义 (api_dsl)");
  lines.push("");
  for (const api of input.apiDsls) {
    const d = api.dsl_json;
    lines.push(`### ${api.api_code} (${api.api_type})`);
    if (d) {
      if (d.table) lines.push(`- 表: ${d.table}`);
      if (d.joins?.length) lines.push(`- 关联: ${d.joins.map((j) => `${j.table ?? ""} ${j.alias ?? ""} ON ${j.on ? `${j.on.left ?? ""} = ${j.on.right ?? ""}` : ""}`).join(", ")}`);
      if (d.sort) {
        const sortStr = typeof d.sort === "string" ? d.sort : (d.sort as Array<{ field?: string; direction?: string }>).map((o) => `${o.field ?? ""} ${o.direction ?? ""}`).join(", ");
        lines.push(`- 排序: ${sortStr}`);
      }
      if (d.select?.length) lines.push(`- 选择字段: ${d.select.map((s) => s.as ? `${s.field ?? ""} AS ${s.as}` : s.field ?? "").join(", ")}`);
      if (d.where?.length) lines.push(`- 条件: ${d.where.map((w) => `${w.field ?? ""} ${w.op ?? ""} (${w.source ?? ""})`).join(", ")}`);
    } else {
      lines.push("待补充");
    }
    lines.push("");
  }

  lines.push("## 操作定义 (action_dsl)");
  lines.push("");
  if (input.actionDsls.length > 0) {
    lines.push("| actionCode | actionName | actionType |");
    lines.push("|------------|-----------|------------|");
    for (const a of input.actionDsls) {
      lines.push(`| ${a.action_code} | ${a.action_name ?? ""} | ${a.action_type ?? ""} |`);
    }
  } else {
    lines.push("（无操作定义）");
  }

  return lines.join("\n");
}

export async function syncSkillMd(schemaName: string, featureCode: string): Promise<void> {
  const { rows: pageRows } = await pool.query(
    `select dsl_json from admin.page_dsl where page_code = $1 and (schema_scope = 'tenant' and schema_name = $2 or (schema_scope = 'tenant' and schema_name = 'demo_school') or schema_scope = 'admin') and status = 'active' and deleted = false order by case when schema_scope = 'tenant' and schema_name = $2 then 0 when schema_scope = 'tenant' and schema_name = 'demo_school' then 1 else 2 end limit 1`,
    [featureCode, schemaName]
  );
  const pageDsl = pageRows[0]?.dsl_json as PageDslJson | null ?? null;
  if (!pageDsl && pageRows.length === 0) return;

  const { rows: apiRows } = await pool.query(
    `select api_code, api_type, dsl_json from admin.api_dsl where feature_code = $1 and (schema_scope = 'tenant' and schema_name = $2 or (schema_scope = 'tenant' and schema_name = 'demo_school') or schema_scope = 'admin') and status = 'active' and deleted = false order by case when schema_scope = 'tenant' and schema_name = $2 then 0 when schema_scope = 'tenant' and schema_name = 'demo_school' then 1 else 2 end`,
    [featureCode, schemaName]
  );
  const apiDsls = apiRows.map((r: { api_code: string; api_type: string; dsl_json: unknown }) => ({
    api_code: r.api_code,
    api_type: r.api_type,
    dsl_json: (typeof r.dsl_json === "string" ? JSON.parse(r.dsl_json) : r.dsl_json) as ApiDslJson | null,
  }));

  const { rows: actionRows } = await pool.query(
    `select action_code, action_name, action_type, dsl_json from admin.action_dsl where page_code = $1 and (schema_scope = 'tenant' and schema_name = $2 or (schema_scope = 'tenant' and schema_name = 'demo_school') or schema_scope = 'admin') and status = 'active' and deleted = false order by case when schema_scope = 'tenant' and schema_name = $2 then 0 when schema_scope = 'tenant' and schema_name = 'demo_school' then 1 else 2 end`,
    [featureCode, schemaName]
  );

  const skillCode = `skill_${featureCode}`;
  const { rows: skillRows } = await pool.query(
    `select skill_name, module_code, feature_code from admin.skill_registry where skill_code = $1 and (schema_scope = 'tenant' and schema_name = $2 or (schema_scope = 'tenant' and schema_name = 'demo_school') or schema_scope = 'admin') and status = 'active' and deleted = false order by case when schema_scope = 'tenant' and schema_name = $2 then 0 when schema_scope = 'tenant' and schema_name = 'demo_school' then 1 else 2 end limit 1`,
    [skillCode, schemaName]
  );
  const skillName = skillRows[0]?.skill_name ?? featureCode;
  const moduleCode = skillRows[0]?.module_code ?? null;
  const skillFeatureCode = skillRows[0]?.feature_code ?? featureCode;

  // 真实物理列：demo_school 用模板库 demo_school，真实租户用自己的 schema
  const tableColumns = await loadPhysicalTableColumns(
    schemaName === "demo_school" ? "demo_school" : schemaName,
    collectPrimaryTables(apiDsls),
  );
  const businessEventRelations = await loadBusinessEventRelations(schemaName, featureCode);

  const content = generateSkillMd({
    pageDsl,
    apiDsls,
    actionDsls: actionRows.map((r: Record<string, unknown>) => ({
      action_code: String(r.action_code ?? ""),
      action_name: String(r.action_name ?? ""),
      action_type: String(r.action_type ?? ""),
      dsl_json: r.dsl_json as Record<string, unknown>,
    })),
    featureCode,
    featureName: skillName,
    featureDescription: pageDsl?.title,
    tableColumns,
    businessEventRelations,
  });

  try {
    if (schemaName === "demo_school") {
      // 默认基线：只更新共享的 demo_school 行
      await pool.query(
        `update admin.skill_registry set skill_md_content = $1, updated_at = now()
         where skill_code = $2 and schema_scope = 'tenant' and schema_name = 'demo_school' and status = 'active' and deleted = false`,
        [content, skillCode]
      );
      return;
    }
    // 真实租户：写/建租户专属行，绝不污染共享 demo_school
    const { rows: tenantRows } = await pool.query(
      `select id from admin.skill_registry where skill_code = $1 and schema_scope = 'tenant' and schema_name = $2 and deleted = false limit 1`,
      [skillCode, schemaName]
    );
    if (tenantRows[0]) {
      await pool.query(
        `update admin.skill_registry set skill_md_content = $1, status = 'active', updated_at = now() where id = $2`,
        [content, tenantRows[0].id]
      );
    } else {
      await pool.query(
        `insert into admin.skill_registry(id, schema_scope, schema_name, module_code, feature_code, skill_code, skill_name, skill_md_content, status, deleted)
         values($1, 'tenant', $2, $3, $4, $5, $6, $7, 'active', false)`,
        [`skill_${schemaName}_${featureCode}`.slice(0, 120), schemaName, moduleCode, skillFeatureCode, skillCode, skillName, content]
      );
    }
  } catch (err) {
    console.warn("[SKILL.md] sync failed for %s: %s", featureCode, err instanceof Error ? err.message : String(err));
  }
}

function featureFromApiCode(apiCode: string) {
  return apiCode.replace(/\.(query|detail|create|update|delete|cancel)$/, "");
}

function eventSourceFeatures(event: string): string[] {
  return [...new Set(
    Object.entries(BUSINESS_API_EVENT_MAP)
      .filter(([, mappedEvent]) => mappedEvent === event)
      .map(([apiCode]) => featureFromApiCode(apiCode))
      .filter(Boolean)
  )];
}

function commandTargetFeatures(command: string): string[] {
  const event = BUSINESS_COMMAND_EVENT_MAP[command];
  if (event) return eventSourceFeatures(event);
  const directMap: Record<string, string> = {
    "student.assignManager": "student_list",
    "role.permission.save": "role_list",
    "user.create": "user_list",
    "user.update": "user_list",
    "user.softDelete": "user_list",
    "user.resetPassword": "user_list",
    "report.student": "student_list",
    "report.finance": "finance_report",
    "report.course": "course_report",
  };
  return directMap[command] ? [directMap[command]] : [];
}

function relationFromRule(ruleCode: string, rule: Record<string, unknown>): BusinessEventRelation | null {
  if (String(rule.category ?? "") !== "workflow") return null;
  const trigger = rule.trigger && typeof rule.trigger === "object" && !Array.isArray(rule.trigger) ? rule.trigger as Record<string, unknown> : {};
  const triggerEvent = String(trigger.event ?? "");
  if (!triggerEvent) return null;
  const actions = Array.isArray(rule.actions) ? rule.actions.filter((item) => item && typeof item === "object" && !Array.isArray(item)) as Array<Record<string, unknown>> : [];
  const actionCommands = actions.map((action) => String(action.command ?? "")).filter(Boolean);
  return {
    ruleCode,
    ruleName: String(rule.ruleName ?? rule.rule_name ?? ""),
    listenerFeatureCode: String(rule.featureCode ?? rule.feature_code ?? ""),
    triggerEvent,
    sourceFeatures: eventSourceFeatures(triggerEvent),
    actionCommands,
    targetFeatures: [...new Set(actionCommands.flatMap(commandTargetFeatures))],
  };
}

export function collectBusinessEventRelationsForFeature(featureCode: string, rules: Array<{ ruleCode: string; rule: Record<string, unknown> }>) {
  const relations = rules.map(({ ruleCode, rule }) => relationFromRule(ruleCode, rule)).filter((item): item is BusinessEventRelation => Boolean(item));
  return {
    listensTo: relations.filter((relation) => relation.listenerFeatureCode === featureCode),
    listenedBy: relations.filter((relation) => relation.sourceFeatures.includes(featureCode)),
  };
}

export function collectBusinessEventRelatedFeatureCodes(rule: Record<string, unknown>) {
  const relation = relationFromRule(String(rule.ruleCode ?? rule.rule_code ?? ""), rule);
  if (!relation) return [];
  return [...new Set([
    relation.listenerFeatureCode,
    ...relation.sourceFeatures,
    ...relation.targetFeatures,
  ].filter(Boolean))];
}

async function loadBusinessEventRelations(schemaName: string, featureCode: string) {
  const { rows } = await pool.query(
    `select rule_code, rule_json
     from admin.business_rule
     where status = 'active' and deleted = false
       and ((schema_scope = 'tenant' and schema_name = $1) or schema_scope = 'tenant_default')
       and coalesce(rule_json->>'category', '') = 'workflow'
     order by case when schema_scope = 'tenant' then 0 else 1 end, created_at`,
    [schemaName]
  );
  return collectBusinessEventRelationsForFeature(
    featureCode,
    rows.map((row) => ({ ruleCode: String(row.rule_code ?? ""), rule: row.rule_json as Record<string, unknown> }))
  );
}

async function loadPhysicalTableColumns(
  schemaName: string,
  tables: string[],
): Promise<Record<string, Array<{ column_name: string; data_type: string }>>> {
  const safeSchema = /^[a-z][a-z0-9_]{0,62}$/.test(schemaName) ? schemaName : "";
  const safeTables = tables.filter((table) => /^[a-z][a-z0-9_]{0,62}$/.test(table));
  if (!safeSchema || safeTables.length === 0) return {};
  const { rows } = await pool.query(
    `select table_name, column_name, data_type from information_schema.columns
     where table_schema = $1 and table_name = any($2)
     order by table_name, ordinal_position`,
    [safeSchema, safeTables]
  );
  const result: Record<string, Array<{ column_name: string; data_type: string }>> = {};
  for (const row of rows) {
    const table = String(row.table_name);
    (result[table] ??= []).push({ column_name: String(row.column_name), data_type: String(row.data_type) });
  }
  return result;
}

export async function fillEmptySkillMd(schemaName: string): Promise<number> {
  const { rows } = await pool.query(
    `select skill_code, feature_code, schema_scope, skill_md_content from admin.skill_registry where status = 'active' and deleted = false`,
    []
  );
  let count = 0;
  for (const row of rows) {
    const content = String(row.skill_md_content ?? "");
    if (content.length >= 200 && hasStandardSkillMdMetadata(content)) continue;
    const featureCode = row.feature_code ?? row.skill_code.replace(/^skill_/, "");
    try {
      await syncSkillMd(schemaName, featureCode);
      count++;
    } catch {
      // skip failed
    }
  }
  return count;
}
