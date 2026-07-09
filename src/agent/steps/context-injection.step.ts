import { pool } from "../../db/pool.js";
import { callWithToolCalling, loadLlmConfig } from "../llm.service.js";
import { formatSkillSummaryFromMd } from "../skill-md.service.js";
import type { ContextResult, DslActionSummary, DslApiSummary, DslContextSummary, DslPageSummary, IntentResult, HarnessStepResult } from "../types.js";
import { TEMPLATE_SCHEMA } from "../../common/template-schema.js";

const EMPTY_DSL_SUMMARY: DslContextSummary = { pages: [], apis: [], actions: [] };

export async function executeContextInjection(
  intent: IntentResult,
  schemaName: string,
  userMessage = "",
): Promise<HarnessStepResult<ContextResult>> {
  const start = Date.now();
  const inputSummary = `featureCode=${intent.featureCode} action=${intent.action}`;

  try {
    let skillMdContent = "";
    let tableColumns: Record<string, Array<{ column_name: string; data_type: string }>> = {};
    let relevantDslCodes: string[] = [];
    let dslSummary: DslContextSummary = EMPTY_DSL_SUMMARY;
    const llmRelatedFeatureCodes = intent.action === "create" && intent.featureCode.includes("report")
      ? await selectReportRelatedFeatureCodes(schemaName, userMessage, intent).catch(() => [])
      : [];
    const relatedFeatureCodes = [...new Set([...(intent.relatedFeatureCodes ?? []), ...llmRelatedFeatureCodes].filter(Boolean))].slice(0, 5);

    if (intent.action === "modify" && intent.featureCode) {
      skillMdContent = await loadSkillMd(schemaName, intent.featureCode);
      tableColumns = await loadRelevantTableColumns(schemaName, skillMdContent);
      if (Object.keys(tableColumns).length === 0 && intent.featureCode) {
        const fallbackTable = intent.featureCode.replace(/_list$/, "").replace(/_detail$/, "");
        tableColumns = await loadRelevantTableColumns(schemaName, `- 表: ${fallbackTable}`);
      }
      relevantDslCodes = [intent.featureCode];
      dslSummary = await loadDslSummary(schemaName, [intent.featureCode], intent.featureCode);
    } else if (intent.action === "create" && intent.moduleCode) {
      skillMdContent = await loadReferenceSkillMd(schemaName, intent.moduleCode);
      tableColumns = await loadModuleTableColumns(schemaName, intent.moduleCode);
      const modulePageCodes = await loadModulePageCodes(intent.moduleCode);
      relevantDslCodes = modulePageCodes;
      dslSummary = await loadDslSummary(schemaName, modulePageCodes, intent.featureCode);
    } else if (intent.action === "create") {
      skillMdContent = await loadReferenceSkillMd(schemaName);
      if (intent.featureCode.includes("report")) {
        tableColumns = await loadReportCandidateTableColumns(schemaName);
      }
    }

    if (intent.action === "create" && relatedFeatureCodes.length > 0) {
      const relatedSkillMd = await loadCombinedSkillMd(schemaName, relatedFeatureCodes);
      const relatedTables = await loadRelevantTableColumns(schemaName, relatedSkillMd);
      skillMdContent = [relatedSkillMd, skillMdContent].filter(Boolean).join("\n\n---\n\n");
      tableColumns = { ...tableColumns, ...relatedTables };
      relevantDslCodes = [...new Set([...relatedFeatureCodes, ...relevantDslCodes])];
      dslSummary = await loadDslSummary(schemaName, relevantDslCodes, intent.featureCode);
    }

    const context = await fitContextToModel(schemaName, { skillMdContent, tableColumns, relevantDslCodes, dslSummary, tokenEstimate: 0 });

    return {
      stepName: "context_injection",
      input_summary: inputSummary,
      output_summary: `skillMd=${skillMdContent.length}chars tables=${Object.keys(tableColumns).length} related=${relatedFeatureCodes.join(",")} pages=${context.dslSummary.pages.length} apis=${context.dslSummary.apis.length} actions=${context.dslSummary.actions.length} tokens≈${context.tokenEstimate}`.substring(0, 500),
      duration_ms: Date.now() - start,
      data: context,
    };
  } catch (err) {
    return {
      stepName: "context_injection",
      input_summary: inputSummary,
      output_summary: "failed",
      duration_ms: Date.now() - start,
      data: { skillMdContent: "", tableColumns: {}, relevantDslCodes: [], dslSummary: EMPTY_DSL_SUMMARY, tokenEstimate: 0 },
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function loadCombinedSkillMd(schemaName: string, featureCodes: string[]): Promise<string> {
  const parts: string[] = [];
  for (const featureCode of featureCodes) {
    const content = await loadSkillMd(schemaName, featureCode);
    if (content) parts.push(`## 相关功能: ${featureCode}\n${content}`);
  }
  return parts.join("\n\n");
}

const SELECT_RELATED_FEATURES_TOOL = {
  type: "function" as const,
  function: {
    name: "select_related_features",
    description: "为新建报表从功能摘要中选择数据来源或最相关功能",
    parameters: {
      type: "object",
      properties: {
        relatedFeatureCodes: {
          type: "array",
          items: { type: "string" },
          description: "必须来自候选功能 featureCode；无法确定则返回空数组",
        },
      },
      required: ["relatedFeatureCodes"],
    },
  },
};

async function selectReportRelatedFeatureCodes(schemaName: string, userMessage: string, intent: IntentResult): Promise<string[]> {
  if (!userMessage.trim()) return [];
  const summaries = await loadSkillSummaries(schemaName);
  if (summaries.length === 0) return [];
  const result = await callWithToolCalling({
    schemaName,
    messages: [
      {
        role: "system",
        content: [
          "你是教务系统报表数据来源选择器。",
          "根据用户需求和功能摘要，选择应该加载完整 SKILL.md 的相关功能。",
          "只选择候选功能中最能解释报表 source table、分组字段、指标字段、时间字段的功能。",
          "如果用户消息包含上一次错误，尤其是“报表字段不存在”“missing metric/dimension/filter field”，说明之前选错了表或字段；这时必须重新选择能提供真实字段的相关 skill，而不是继续沿用错误表名。",
          "选择后系统会加载完整 SKILL.md 和真实数据库字段，因此你必须优先选择业务事实表所在功能，再选择用于名称展示的关联功能。",
          "不要按单个关键词机械匹配；无法确定时返回空数组。",
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify({
          userMessage,
          intent,
          candidates: summaries,
        }, null, 2),
      },
    ],
    tools: [SELECT_RELATED_FEATURES_TOOL],
    fallbackPrompt: "只输出 JSON：{\"relatedFeatureCodes\":[]}",
  });
  const content = result.functionCall?.arguments ?? result.content ?? "";
  const parsed = JSON.parse(extractJson(content)) as { relatedFeatureCodes?: unknown };
  if (!Array.isArray(parsed.relatedFeatureCodes)) return [];
  const allowed = new Set(summaries.map((item) => item.featureCode));
  return [...new Set(parsed.relatedFeatureCodes.map(String).map((code) => code.replace(/^skill_/, "")).filter((code) => allowed.has(code)))].slice(0, 5);
}

async function loadSkillSummaries(schemaName: string): Promise<Array<{ featureCode: string; skillName: string; summary: string }>> {
  const { rows } = await pool.query(
    `select skill_code, feature_code, skill_name, skill_md_content
     from admin.skill_registry
     where (schema_scope = 'tenant' and schema_name = $1 or (schema_scope = 'tenant' and schema_name = '${TEMPLATE_SCHEMA}'))
       and status = 'active' and deleted = false and feature_code is not null
     order by module_code, feature_code`,
    [schemaName]
  );
  return rows.map((row: { skill_code?: string; feature_code?: string; skill_name?: string; skill_md_content?: string }) => ({
    featureCode: String(row.feature_code ?? "").replace(/^skill_/, ""),
    skillName: String(row.skill_name ?? ""),
    summary: formatSkillSummaryFromMd({
      skillCode: String(row.skill_code ?? ""),
      skillName: String(row.skill_name ?? ""),
      featureCode: row.feature_code ? String(row.feature_code) : undefined,
      content: String(row.skill_md_content ?? ""),
      fallbackChars: 500,
    }),
  })).filter((row) => row.featureCode);
}

async function loadReportCandidateTableColumns(schemaName: string): Promise<Record<string, Array<{ column_name: string; data_type: string }>>> {
  const { rows } = await pool.query(
    `select table_name, column_name, data_type from information_schema.columns
     where table_schema = $1
       and table_name not like 'pg_%'
       and table_name not in ('role_resource', 'login_session')
     order by table_name, ordinal_position`,
    [schemaName]
  );
  const result: Record<string, Array<{ column_name: string; data_type: string }>> = {};
  for (const row of rows) {
    const table = String(row.table_name);
    result[table] ??= [];
    if (result[table].length < 20) {
      result[table].push({ column_name: String(row.column_name), data_type: String(row.data_type) });
    }
  }
  return result;
}

async function loadSkillMd(schemaName: string, featureCode: string): Promise<string> {
  const skillCode = `skill_${featureCode}`;
  const { rows } = await pool.query(
    `select skill_md_content from admin.skill_registry
     where skill_code = $1 and (schema_scope = 'tenant' and schema_name = $2 or (schema_scope = 'tenant' and schema_name = '${TEMPLATE_SCHEMA}'))
       and status = 'active' and deleted = false
     order by case when schema_scope = 'tenant' and schema_name = $2 then 0 when schema_scope = 'tenant' and schema_name = '${TEMPLATE_SCHEMA}' then 1 else 2 end limit 1`,
    [skillCode, schemaName]
  );
  const content = rows[0]?.skill_md_content ?? "";
  if (content && content.length > 50) return content;

  const { rows: pageRows } = await pool.query(
    `select page_code, page_name, dsl_json from admin.page_dsl
     where page_code = $1 and (schema_scope = 'tenant' and schema_name = $2 or (schema_scope = 'tenant' and schema_name = '${TEMPLATE_SCHEMA}'))
       and status = 'active' and deleted = false
     order by case when schema_scope = 'tenant' and schema_name = $2 then 0 when schema_scope = 'tenant' and schema_name = '${TEMPLATE_SCHEMA}' then 1 else 2 end limit 1`,
    [featureCode, schemaName]
  );
  if (pageRows.length > 0) {
    return `[SKILL.md 未填充，回退到 DSL 摘要]\n页面: ${pageRows[0].page_name} (${pageRows[0].page_code})\nDSL: ${JSON.stringify(pageRows[0].dsl_json).substring(0, 2000)}`;
  }
  return "";
}

async function loadRelevantTableColumns(schemaName: string, skillMd: string): Promise<Record<string, Array<{ column_name: string; data_type: string }>>> {
  const tableNames = extractTableNamesFromSkillMd(skillMd);
  if (tableNames.length === 0) return {};

  const { rows } = await pool.query(
    `select table_name, column_name, data_type from information_schema.columns
     where table_schema = $1 and table_name = ANY($2)
     order by table_name, ordinal_position`,
    [schemaName, tableNames]
  );

  const result: Record<string, Array<{ column_name: string; data_type: string }>> = {};
  for (const row of rows) {
    const t = String(row.table_name);
    if (!result[t]) result[t] = [];
    if (result[t].length < 20) {
      result[t].push({ column_name: String(row.column_name), data_type: String(row.data_type) });
    }
  }
  return result;
}

async function loadReferenceSkillMd(schemaName: string, moduleCode?: string): Promise<string> {
  if (moduleCode) {
    const { rows } = await pool.query(
      `select skill_md_content from admin.skill_registry
       where module_code = $1 and (schema_scope = 'tenant' and schema_name = $2 or (schema_scope = 'tenant' and schema_name = '${TEMPLATE_SCHEMA}'))
         and status = 'active' and deleted = false and length(skill_md_content) > 50
       order by case when schema_scope = 'tenant' and schema_name = $2 then 0 when schema_scope = 'tenant' and schema_name = '${TEMPLATE_SCHEMA}' then 1 else 2 end limit 1`,
      [moduleCode, schemaName]
    );
    if (rows[0]?.skill_md_content) return rows[0].skill_md_content;
  }

  const { rows } = await pool.query(
    `select skill_md_content from admin.skill_registry
     where (schema_scope = 'tenant' and schema_name = '${TEMPLATE_SCHEMA}')
       and status = 'active' and deleted = false and length(skill_md_content) > 50
     limit 1`
  );
  return rows[0]?.skill_md_content ?? "";
}

async function loadModuleTableColumns(schemaName: string, moduleCode: string): Promise<Record<string, Array<{ column_name: string; data_type: string }>>> {
  const { rows: featureRows } = await pool.query(
    `select distinct f.page_code from admin.feature_registry f
     join admin.skill_registry s on s.feature_code = f.feature_code
     where f.module_code = $1 and f.status = 'ACTIVE' and f.deleted = false limit 5`,
    [moduleCode]
  );
  const tableNames = featureRows.map((r: { page_code: string }) => r.page_code.replace(/_list$/, "").replace(/_detail$/, ""));
  if (tableNames.length === 0) return {};

  const { rows } = await pool.query(
    `select table_name, column_name, data_type from information_schema.columns
     where table_schema = $1 and table_name = ANY($2)
     order by table_name, ordinal_position`,
    [schemaName, tableNames]
  );

  const result: Record<string, Array<{ column_name: string; data_type: string }>> = {};
  for (const row of rows) {
    const t = String(row.table_name);
    if (!result[t]) result[t] = [];
    if (result[t].length < 20) {
      result[t].push({ column_name: String(row.column_name), data_type: String(row.data_type) });
    }
  }
  return result;
}

async function loadModulePageCodes(moduleCode: string): Promise<string[]> {
  const { rows } = await pool.query(
    `select distinct page_code from admin.feature_registry
     where module_code = $1 and status = 'ACTIVE' and deleted = false and page_code is not null
     order by page_code limit 5`,
    [moduleCode]
  );
  return rows.map((row: { page_code: string }) => String(row.page_code)).filter(Boolean);
}

async function loadDslSummary(schemaName: string, pageCodes: string[], featureCode?: string): Promise<DslContextSummary> {
  const safePageCodes = [...new Set(pageCodes.filter((code) => /^[a-z][a-z0-9_]{0,62}$/.test(code)))].slice(0, 5);
  if (safePageCodes.length === 0 && !featureCode) return EMPTY_DSL_SUMMARY;

  const pages = await loadPageSummaries(schemaName, safePageCodes);
  const apiLikeCodes = safePageCodes.map((code) => `${code}.%`);
  const apis = await loadApiSummaries(schemaName, apiLikeCodes, featureCode);
  const actions = await loadActionSummaries(schemaName, safePageCodes, featureCode);
  return { pages, apis, actions };
}

async function loadPageSummaries(schemaName: string, pageCodes: string[]): Promise<DslPageSummary[]> {
  if (pageCodes.length === 0) return [];
  const { rows } = await pool.query(
    `select distinct on (page_code) page_code, page_name, dsl_json
     from admin.page_dsl
     where page_code = ANY($1::text[])
       and (schema_scope = 'tenant' and schema_name = $2 or (schema_scope = 'tenant' and schema_name = '${TEMPLATE_SCHEMA}'))
       and status = 'active' and deleted = false
     order by page_code, case when schema_scope = 'tenant' then 0 else 1 end`,
    [pageCodes, schemaName]
  );
  return rows.map((row: { page_code: string; page_name?: string; dsl_json: unknown }) =>
    summarizePageDsl(String(row.page_code), row.dsl_json, row.page_name ? String(row.page_name) : undefined)
  );
}

async function loadApiSummaries(schemaName: string, apiLikeCodes: string[], featureCode?: string): Promise<DslApiSummary[]> {
  if (apiLikeCodes.length === 0 && !featureCode) return [];
  const { rows } = await pool.query(
    `select distinct on (api_code) api_code, dsl_json
     from admin.api_dsl
     where (api_code like any($1::text[]) or feature_code = $2)
       and (schema_scope = 'tenant' and schema_name = $3 or (schema_scope = 'tenant' and schema_name = '${TEMPLATE_SCHEMA}'))
       and status = 'active' and deleted = false
     order by api_code, case when schema_scope = 'tenant' and schema_name = $3 then 0 when schema_scope = 'tenant' and schema_name = '${TEMPLATE_SCHEMA}' then 1 else 2 end
     limit 20`,
    [apiLikeCodes, featureCode ?? "", schemaName]
  );
  return rows.map((row: { api_code: string; dsl_json: unknown }) => summarizeApiDsl(String(row.api_code), row.dsl_json));
}

async function loadActionSummaries(schemaName: string, pageCodes: string[], featureCode?: string): Promise<DslActionSummary[]> {
  if (pageCodes.length === 0 && !featureCode) return [];
  const { rows } = await pool.query(
    `select distinct on (action_code) action_code, action_name, page_code, action_type, dsl_json
     from admin.action_dsl
     where (page_code = any($1::text[]) or feature_code = $2)
       and (schema_scope = 'tenant' and schema_name = $3 or (schema_scope = 'tenant' and schema_name = '${TEMPLATE_SCHEMA}'))
       and status = 'active' and deleted = false
     order by action_code, case when schema_scope = 'tenant' and schema_name = $3 then 0 when schema_scope = 'tenant' and schema_name = '${TEMPLATE_SCHEMA}' then 1 else 2 end
     limit 20`,
    [pageCodes, featureCode ?? "", schemaName]
  );
  return rows.map((row: { action_code: string; action_name?: string; page_code?: string; action_type?: string; dsl_json: unknown }) =>
    summarizeActionDsl(String(row.action_code), row.dsl_json, {
      actionName: row.action_name ? String(row.action_name) : undefined,
      pageCode: row.page_code ? String(row.page_code) : undefined,
      actionType: row.action_type ? String(row.action_type) : undefined,
    })
  );
}

function extractTableNamesFromSkillMd(skillMd: string): string[] {
  const names = new Set<string>();
  const lines = skillMd.split("\n");
  for (const line of lines) {
    const match = line.match(/[-•]\s*表[：:]\s*(\w+)/);
    if (match) {
      names.add(match[1]);
    }
  }
  return [...names];
}

export function summarizePageDsl(pageCode: string, dsl: unknown, pageName?: string): DslPageSummary {
  const root = asObject(dsl);
  const table = asObject(root.table);
  return {
    pageCode,
    pageName,
    title: stringValue(root.title ?? root.pageTitle ?? root.page_name),
    filters: collectKeys(root.filters).slice(0, 20),
    columns: collectKeys(table.columns).slice(0, 30),
    toolbarActions: collectActionCodes(root.toolbar ?? table.toolbar).slice(0, 20),
    rowActions: collectActionCodes(table.rowActions ?? root.rowActions).slice(0, 20),
  };
}

export function summarizeApiDsl(apiCode: string, dsl: unknown): DslApiSummary {
  const root = asObject(dsl);
  return {
    apiCode,
    operation: stringValue(root.operation ?? root.type ?? root.method),
    table: stringValue(root.table ?? root.tableName ?? root.from),
    selectFields: collectFields(root.select ?? root.fields ?? root.columns).slice(0, 30),
    allowedFields: collectFields(root.allowedFields ?? root.allowed_fields ?? root.writeFields).slice(0, 30),
    filters: collectFields(root.filters ?? root.where ?? root.conditions).slice(0, 20),
    joins: collectJoinNames(root.joins).slice(0, 10),
    sorts: collectFields(root.sorts ?? root.orderBy ?? root.order_by).slice(0, 10),
  };
}

export function summarizeActionDsl(actionCode: string, dsl: unknown, meta: Partial<DslActionSummary> = {}): DslActionSummary {
  const root = asObject(dsl);
  const modal = asObject(root.modal);
  return {
    actionCode,
    actionName: meta.actionName ?? stringValue(root.actionName ?? root.name ?? root.label),
    actionType: meta.actionType ?? stringValue(root.actionType ?? root.type),
    pageCode: meta.pageCode ?? stringValue(root.pageCode),
    apiCode: stringValue(root.apiCode ?? root.api_code ?? modal.apiCode),
    modalCode: stringValue(root.modalCode ?? root.modal_code ?? modal.code),
    fields: collectKeys(root.fields ?? modal.fields ?? root.formFields).slice(0, 30),
  };
}

async function fitContextToModel(schemaName: string, context: ContextResult): Promise<ContextResult> {
  const estimated = withTokenEstimate(context);
  const config = await loadLlmConfig(schemaName);
  const threshold = Math.floor(config.maxContextTokens * 0.8);
  if (estimated.tokenEstimate < threshold) return estimated;
  return compressContextWithLlm(schemaName, estimated, threshold).catch(() => mechanicalCompressContext(estimated, threshold));
}

function withTokenEstimate(context: ContextResult): ContextResult {
  const totalChars = context.skillMdContent.length + JSON.stringify(context.tableColumns).length + JSON.stringify(context.dslSummary).length;
  const tokenEstimate = Math.ceil(totalChars / 3);
  return { ...context, tokenEstimate };
}

async function compressContextWithLlm(schemaName: string, context: ContextResult, targetTokens: number): Promise<ContextResult> {
  const result = await callWithToolCalling({
    schemaName,
    messages: [
      {
        role: "system",
        content: [
          "你是教务系统 DSL 上下文压缩器。",
          "请保留生成 DSL 所需的信息：真实表名、字段名、API 编码、页面编码、动作编码、字段含义、关联关系和业务约束。",
          "不要翻译或改写任何编码字段；不要丢失 source table、allowedFields、filters、joins、modal fields。",
          `目标是把上下文压缩到约 ${targetTokens} tokens 以内。`,
          "只输出 JSON，格式为 {skillMdContent:string, tableColumns:object, dslSummary:object, relevantDslCodes:string[]}。",
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify(context),
      },
    ],
    fallbackPrompt: "只输出 JSON，不要输出解释。",
  });

  const content = result.content ?? result.functionCall?.arguments ?? "";
  const parsed = JSON.parse(extractJson(content)) as Partial<ContextResult>;
  return withTokenEstimate({
    skillMdContent: typeof parsed.skillMdContent === "string" ? parsed.skillMdContent : context.skillMdContent,
    tableColumns: isRecord(parsed.tableColumns) ? parsed.tableColumns as ContextResult["tableColumns"] : context.tableColumns,
    relevantDslCodes: Array.isArray(parsed.relevantDslCodes) ? parsed.relevantDslCodes.map(String).filter(Boolean) : context.relevantDslCodes,
    dslSummary: isRecord(parsed.dslSummary) ? parsed.dslSummary as ContextResult["dslSummary"] : context.dslSummary,
    tokenEstimate: 0,
  });
}

function mechanicalCompressContext(context: ContextResult, targetTokens: number): ContextResult {
  let result = withTokenEstimate(context);
  if (result.tokenEstimate <= targetTokens) return result;

  const trimmed: Record<string, Array<{ column_name: string; data_type: string }>> = {};
  for (const [table, cols] of Object.entries(context.tableColumns)) {
    trimmed[table] = cols.slice(0, 15);
  }
  const dslSummary: DslContextSummary = {
    pages: context.dslSummary.pages.slice(0, 3).map((page) => ({
      ...page,
      filters: page.filters.slice(0, 12),
      columns: page.columns.slice(0, 18),
      toolbarActions: page.toolbarActions.slice(0, 10),
      rowActions: page.rowActions.slice(0, 10),
    })),
    apis: context.dslSummary.apis.slice(0, 8).map((api) => ({
      ...api,
      selectFields: api.selectFields.slice(0, 18),
      allowedFields: api.allowedFields.slice(0, 18),
      filters: api.filters.slice(0, 12),
      joins: api.joins.slice(0, 8),
      sorts: api.sorts.slice(0, 8),
    })),
    actions: context.dslSummary.actions.slice(0, 8).map((action) => ({
      ...action,
      fields: action.fields.slice(0, 18),
    })),
  };
  result = withTokenEstimate({ ...context, tableColumns: trimmed, dslSummary });
  if (result.tokenEstimate <= targetTokens) return result;
  return withTokenEstimate({
    ...result,
    skillMdContent: result.skillMdContent.slice(0, Math.max(12000, targetTokens * 2)),
  });
}

function extractJson(content: string) {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) return fenced[1].trim();
  const first = content.indexOf("{");
  const last = content.lastIndexOf("}");
  if (first >= 0 && last > first) return content.slice(first, last + 1);
  return content;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asObject(value: unknown): Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function collectKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return unique(value.map((item) => {
    if (typeof item === "string") return item;
    const obj = asObject(item);
    return stringValue(obj.key ?? obj.field ?? obj.name ?? obj.code ?? obj.actionCode);
  }));
}

function collectFields(value: unknown): string[] {
  if (Array.isArray(value)) {
    return unique(value.map((item) => {
      if (typeof item === "string") return item;
      const obj = asObject(item);
      return stringValue(obj.field ?? obj.key ?? obj.name ?? obj.as);
    }));
  }
  const obj = asObject(value);
  return unique(Object.keys(obj));
}

function collectActionCodes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return unique(value.map((item) => {
    if (typeof item === "string") return item;
    const obj = asObject(item);
    return stringValue(obj.actionCode ?? obj.code ?? obj.key);
  }));
}

function collectJoinNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return unique(value.map((item) => {
    const obj = asObject(item);
    return stringValue(obj.table ?? obj.name ?? obj.alias);
  }));
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((item): item is string => Boolean(item)))];
}
