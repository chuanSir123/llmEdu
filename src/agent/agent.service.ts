import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";

import { createDraftVersion } from "../version/version.service.js";
import { harnessRun } from "./harness-runner.js";
import type { DslDiff as NewDslDiff } from "./types.js";

export async function loadAgentContext(schemaName: string, targetModuleCode?: string, targetFeatureCode?: string) {
  const moduleFilter = targetModuleCode ? ` and module_code = '${targetModuleCode}'` : "";
  const featureFilter = targetFeatureCode ? ` and feature_code = '${targetFeatureCode}'` : "";

  const [pageDsls, apiDsls, skills, versions, columns] = await Promise.all([
    pool.query(`select page_code, page_name, dsl_json from admin.page_dsl where (schema_scope = 'tenant_default' or (schema_scope = 'tenant' and schema_name = $1)) and status = 'active' and deleted = false${moduleFilter}${featureFilter}`, [schemaName]),
    pool.query(`select api_code, api_type, dsl_json from admin.api_dsl where (schema_scope = 'tenant_default' or (schema_scope = 'tenant' and schema_name = $1)) and status = 'active' and deleted = false${moduleFilter}${featureFilter}`, [schemaName]),
    pool.query(`select skill_code, skill_name, skill_md_content from admin.skill_registry where (schema_scope = 'tenant_default' or (schema_scope = 'tenant' and schema_name = $1)) and status = 'active' and deleted = false${moduleFilter}${featureFilter}`, [schemaName]),
    pool.query(`select target_type, target_code, version_no, status, change_summary from admin.dsl_version where schema_name = $1 and deleted = false order by created_at desc limit 10`, [schemaName]),
    pool.query(`select table_name, column_name from information_schema.columns where table_schema = $1`, [schemaName]),
  ]);

  return {
    pageDsls: pageDsls.rows,
    apiDsls: apiDsls.rows,
    skillContent: skills.rows,
    versionHistory: versions.rows,
    tableColumns: columns.rows,
  };
}

type DslDiff = NewDslDiff;

type GenerateResult = {
  type: string;
  schemaChangeRequest: boolean;
  reason: string;
  diffs: DslDiff[];
};

async function callLlmApi(schemaName: string, messages: Array<{ role: string; content: string }>): Promise<string> {
  const { rows } = await pool.query(
    `select base_url, api_key_cipher, model, temperature from admin.llm_config
     where status = 'ACTIVE' and deleted = false and (schema_name = $1 or schema_name is null)
     order by schema_name desc nulls last limit 1`,
    [schemaName]
  );
  const config = rows[0];
  if (!config) throw new Error("LLM 配置不存在，请在 llm_config 表中为该租户配置 LLM");

  const apiKey = config.api_key_cipher ? Buffer.from(config.api_key_cipher, "base64").toString() : "";
  if (!config.base_url || !apiKey) throw new Error("LLM 配置不完整，缺少 base_url 或 api_key");

  const body = {
    model: config.model,
    messages,
    temperature: Number(config.temperature ?? 0.2),
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  console.log("[LLM] request: url=%s model=%s messages_count=%d system_prompt_length=%d user_prompt_length=%d",
    `${config.base_url}/chat/completions`, config.model, messages.length,
    messages[0]?.content?.length ?? 0, messages[messages.length - 1]?.content?.length ?? 0);
  console.log("[LLM] system_prompt_preview: %s", messages[0]?.content?.substring(0, 500));
  console.log("[LLM] user_prompt_preview: %s", messages[messages.length - 1]?.content?.substring(0, 500));
  try {
    const response = await fetch(`${config.base_url}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      console.log("[LLM] request failed: status=%d url=%s model=%s messages_count=%d request_body=%s response=%s",
        response.status, `${config.base_url}/chat/completions`, config.model, messages.length,
        JSON.stringify({ model: config.model, temperature: body.temperature, messages: messages.map(m => ({ role: m.role, contentLength: m.content.length })) }),
        errText.substring(0, 500));
      throw new Error(`LLM API error ${response.status}: ${errText}`);
    }
    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content ?? "";
    console.log("[LLM] model=%s response_length=%d content_preview=%s", config.model, content.length, content.substring(0, 300));
    return content;
  } finally {
    clearTimeout(timeout);
  }
}

function buildSystemPrompt(context: Awaited<ReturnType<typeof loadAgentContext>>): string {
  const pageSummaries = context.pageDsls.map((p) => {
    const dsl = p.dsl_json as Record<string, unknown> | null;
    const pageCode = p.page_code;
    const pageName = p.page_name;
    const columns = dsl && typeof dsl === "object" && "table" in dsl
      ? ((dsl as Record<string, unknown>).table as Record<string, unknown>)?.columns
        ? ((dsl as Record<string, unknown>).table as { columns: Array<{ key: string; label?: string }> }).columns.map((c) => c.key)
        : []
      : [];
    const filters = dsl && typeof dsl === "object" && "filters" in dsl
      ? ((dsl as Record<string, unknown>).filters as Array<{ key: string }>).map((f) => f.key)
      : [];
    return `  - ${pageCode} (${pageName}): columns=[${columns.join(",")}] filters=[${filters.join(",")}]`;
  });

  const apiSummaries = context.apiDsls.map((a) => `  - ${a.api_code} (${a.api_type})`);

  const tableColumns = context.tableColumns.reduce<Record<string, string[]>>((acc, row) => {
    const t = String(row.table_name);
    if (!acc[t]) acc[t] = [];
    acc[t].push(String(row.column_name));
    return acc;
  }, {});
  const tableSummaries = Object.entries(tableColumns).map(([table, cols]) => `  - ${table}: ${cols.join(", ")}`);

  return `你是一个教务管理系统的 DSL 变更助手。用户会用自然语言描述定制需求，你需要生成结构化的 DSL 变更计划。

## 系统架构
- 页面由 PageDsl 驱动渲染，包含 filters（筛选字段）、table.columns（表格列）、toolbar（操作按钮）、modal.fields（弹窗字段）
- API 由 ApiDsl 驱动，包含 queryDsl（查询条件、排序、表关联）
- 字段定义格式：{ key: "field_name", label: "显示名", type: "text|number|date|datetime", filter?: boolean, sortable?: boolean }

## 当前页面 DSL
${pageSummaries.join("\n")}

## 当前 API DSL
${apiSummaries.join("\n")}

## 数据库表结构
${tableSummaries.join("\n")}

## 输出格式要求
你必须输出一个 JSON 数组，每个元素代表一个 DSL 变更操作：
[
  {
    "targetType": "page_dsl",
    "targetCode": "student_list",
    "op": "add_column",
    "field": "address",
    "fieldDef": { "key": "address", "label": "地址", "type": "text" },
    "modifiedDslJson": { ... 修改后的完整 page DSL JSON ... }
  }
]

规则：
1. 如果用户要求增加字段，需要同时修改 page_dsl（增加 column 和/或 filter）和 api_dsl（增加 select 字段）
2. modifiedDslJson 必须是修改后的**完整** DSL JSON 对象（不是 diff，是完整替换）
3. 每个变更操作必须包含 modifiedDslJson
4. 字段名必须小写+下划线格式，如 address、parent_phone
5. 只输出 JSON 数组，不要输出其他文字
6. 如果无法理解需求或无法生成变更，返回空数组 []`;
}

function parseLlmResponse(content: string): DslDiff[] {
  const trimmed = content.trim();
  let jsonStr = trimmed;

  const codeBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1].trim();
  } else if (trimmed.startsWith("[")) {
    const endIdx = trimmed.lastIndexOf("]");
    if (endIdx > 0) {
      jsonStr = trimmed.slice(0, endIdx + 1);
    }
  }

  try {
    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) {
      console.log("[LLM] parseLlmResponse: not an array, type=%s", typeof parsed);
      return [];
    }
    const result = parsed.filter((d: Record<string, unknown>) =>
      d.targetType && d.targetCode && d.op && d.modifiedDslJson
    ).map((d: Record<string, unknown>) => ({
      targetType: String(d.targetType) as DslDiff["targetType"],
      targetCode: String(d.targetCode),
      op: String(d.op) as DslDiff["op"],
      field: d.field ? String(d.field) : undefined,
      fieldDef: d.fieldDef as Record<string, unknown> | undefined,
      modifiedDslJson: d.modifiedDslJson,
    }));
    console.log("[LLM] parseLlmResponse: total_items=%d valid_items=%d", parsed.length, result.length);
    return result;
  } catch (e) {
    console.log("[LLM] parseLlmResponse: JSON parse failed, input_preview=%s", jsonStr.substring(0, 200));
    return [];
  }
}

type PageDslContextRow = Awaited<ReturnType<typeof loadAgentContext>>["pageDsls"][number];

function findRelevantPageDsl(context: Awaited<ReturnType<typeof loadAgentContext>>, prompt: string) {
  void prompt;
  return context.pageDsls.slice(0, 20);
}

function findRelevantApiDsl(context: Awaited<ReturnType<typeof loadAgentContext>>, relevantPageCodes: string[]) {
  const related = context.apiDsls.filter((a) => relevantPageCodes.some((code) => a.api_code.startsWith(code + ".")));
  if (related.length > 0) return related.slice(0, 20);
  return context.apiDsls.slice(0, 10);
}

export async function generateDslDiff(context: Awaited<ReturnType<typeof loadAgentContext>>, prompt: string, schemaName: string): Promise<GenerateResult> {
  const systemPrompt = buildSystemPrompt(context);

  const relevantPages = findRelevantPageDsl(context, prompt);
  const relevantPageCodes = relevantPages.map((p) => p.page_code);
  const relevantApis = findRelevantApiDsl(context, relevantPageCodes);

  const pageDslMap: Record<string, unknown> = {};
  for (const p of relevantPages) {
    pageDslMap[p.page_code] = p.dsl_json;
  }
  const apiDslMap: Record<string, unknown> = {};
  for (const a of relevantApis) {
    apiDslMap[a.api_code] = a.dsl_json;
  }

  const userContent = `用户需求：${prompt}\n\n相关页面 DSL（供修改参考）：\n${JSON.stringify(pageDslMap, null, 2)}\n\n相关 API DSL（供修改参考）：\n${JSON.stringify(apiDslMap, null, 2)}`;

  const maxRetries = 3;
  let lastError = "";

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const messages: Array<{ role: string; content: string }> = [
      { role: "system", content: systemPrompt },
    ];
    if (lastError) {
      messages.push({ role: "assistant", content: "我需要修正上一次的输出。" });
      messages.push({ role: "user", content: `上一次输出校验失败：${lastError}\n\n请重新生成，确保：\n1. 输出是合法的 JSON 数组\n2. 每个元素包含 targetType、targetCode、op、modifiedDslJson\n3. modifiedDslJson 是完整的 DSL 对象\n\n原始需求：${prompt}` });
    } else {
      messages.push({ role: "user", content: userContent });
    }

    let llmContent: string;
    try {
      llmContent = await callLlmApi(schemaName, messages);
    } catch (err) {
      return {
        type: "dsl_diff",
        schemaChangeRequest: false,
        reason: `LLM 调用失败：${err instanceof Error ? err.message : String(err)}`,
        diffs: [],
      };
    }

    const diffs = parseLlmResponse(llmContent);
    if (diffs.length === 0) {
      lastError = "未能解析出有效的 DSL 变更，请确保输出为 JSON 数组且每个元素包含 targetType/targetCode/op/modifiedDslJson";
      continue;
    }

    const validation = validateDslDiff(diffs);
    if (!validation.valid) {
      lastError = validation.errors.join("; ");
      continue;
    }

    return {
      type: "dsl_diff",
      schemaChangeRequest: false,
      reason: `LLM 生成了 ${diffs.length} 项 DSL 变更`,
      diffs,
    };
  }

  return {
    type: "dsl_diff",
    schemaChangeRequest: false,
    reason: `经过 ${maxRetries} 次尝试仍无法生成有效的 DSL 变更，请重新描述需求或联系管理员`,
    diffs: [],
  };
}

export function validateDslDiff(diffs: DslDiff[]) {
  const errors: string[] = [];
  const FIELD_RE = /^[a-z][a-z0-9_]{0,62}$/;
  for (const diff of diffs) {
    if (!diff.targetType) errors.push(`diff missing targetType`);
    if (!diff.targetCode) errors.push(`diff missing targetCode`);
    if (!diff.op) errors.push(`diff missing op`);
    if (diff.field && !FIELD_RE.test(diff.field)) errors.push(`invalid field name: ${diff.field}`);
    if (!diff.modifiedDslJson) errors.push(`diff for ${diff.targetCode} missing modifiedDslJson`);
    if (diff.modifiedDslJson && typeof diff.modifiedDslJson !== "object") errors.push(`modifiedDslJson for ${diff.targetCode} must be an object`);
  }
  return { valid: errors.length === 0, errors };
}

export async function writeDraftFromDiff(schemaName: string, diffs: DslDiff[], userId: string) {
  const results: Array<{ versionId: string; versionNo: number }> = [];
  const typeMap: Record<string, string> = { page_dsl: "page", api_dsl: "api", action_dsl: "action", skill_registry: "skill" };

  for (const diff of diffs) {
    const targetType = typeMap[diff.targetType] ?? diff.targetType;
    const snapshot: Record<string, unknown> = { dsl_json: diff.modifiedDslJson };
    const version = await createDraftVersion({
      schemaScope: "tenant",
      schemaName,
      targetType,
      targetCode: diff.targetCode,
      changeSummary: `${diff.op}${diff.field ? ` ${diff.field}` : ""} via AI 定制`,
      diff: { targetType: diff.targetType, targetCode: diff.targetCode, op: diff.op, field: diff.field, fieldDef: diff.fieldDef },
      snapshot,
    });
    results.push({ versionId: version.id, versionNo: version.versionNo });
  }
  return results;
}

export async function submitAgentTask(schemaName: string, prompt: string, mode = "draft", targetModuleCode?: string, targetFeatureCode?: string) {
  const harnessResult = await harnessRun({
    userMessage: prompt,
    schemaName,
    sessionId: randomUUID(),
    userId: "agent",
  });

  const reason = harnessResult.intent.data.reason || harnessResult.intent.data.featureCode || "AI 定制化";
  const diffs = harnessResult.validation.data;
  const validation = harnessResult.validation.error
    ? { valid: false, errors: [harnessResult.validation.error] }
    : { valid: true, errors: [] as string[] };
  const draftResults = harnessResult.execution.data;

  const result: GenerateResult = {
    type: "dsl_diff",
    schemaChangeRequest: false,
    reason,
    diffs: diffs.map((d: NewDslDiff) => ({
      targetType: d.targetType,
      targetCode: d.targetCode,
      op: d.op as DslDiff["op"],
      field: d.field,
      fieldDef: d.fieldDef,
      resourceDef: d.resourceDef,
      modifiedDslJson: d.modifiedDslJson,
    })),
  };

  return { id: randomUUID(), ...result, validation, draftResults };
}
