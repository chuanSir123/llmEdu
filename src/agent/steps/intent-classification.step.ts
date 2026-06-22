import { pool } from "../../db/pool.js";
import { callWithToolCalling } from "../llm.service.js";
import { CLASSIFY_INTENT_TOOL, INTENT_SYSTEM_PROMPT_STATIC, INTENT_FEATURES_TEMPLATE, FALLBACK_INTENT_PROMPT } from "../prompts.js";
import { formatSkillSummaryFromMd } from "../skill-md.service.js";
import type { IntentResult, SkillSummary, HarnessStepResult } from "../types.js";

export async function executeIntentClassification(
  userMessage: string,
  schemaName: string,
  chatHistory?: Array<{ role: string; content: string }>,
): Promise<HarnessStepResult<IntentResult>> {
  const start = Date.now();
  const inputSummary = userMessage.substring(0, 500);

  try {
    const summaries = await loadSkillSummaries(schemaName);
    const featuresBlock = INTENT_FEATURES_TEMPLATE.replace("{skillSummaries}", summaries.map((s) => `- ${s.skill_code}: ${s.skill_name} — ${s.skill_summary}`).join("\n"));

    // 静态规则在前（全局可缓存），动态功能列表在后
    const messages: Array<{ role: string; content: string }> = [
      { role: "system", content: INTENT_SYSTEM_PROMPT_STATIC },
      { role: "system", content: featuresBlock },
    ];

    if (chatHistory && chatHistory.length > 0) {
      const recentHistory = chatHistory.slice(-100);
      for (const msg of recentHistory) {
        if (msg.role === "user" || msg.role === "assistant") {
          messages.push({ role: msg.role, content: msg.content.substring(0, 500) });
        }
      }
    }

    messages.push({ role: "user", content: userMessage });

    const result = await callWithToolCalling({
      schemaName,
      messages,
      tools: [CLASSIFY_INTENT_TOOL],
      fallbackPrompt: FALLBACK_INTENT_PROMPT,
    });

    let intent: IntentResult;
    if (result.type === "tool_call" && result.functionCall) {
      try {
        const args = JSON.parse(result.functionCall.arguments);
        intent = {
          featureCode: String(args.featureCode ?? "").replace(/^skill_/, ""),
          action: args.action === "create" ? "create" : "modify",
          reason: String(args.reason ?? ""),
          moduleCode: args.moduleCode ? String(args.moduleCode) : undefined,
          relatedFeatureCodes: normalizeRelatedFeatureCodes(args.relatedFeatureCodes),
        };
      } catch {
        intent = emptyIntent("LLM 意图结果解析失败");
      }
    } else {
      intent = parseTextIntent(result.content ?? "", summaries);
    }

    return {
      stepName: "intent_classification",
      input_summary: inputSummary,
      output_summary: `featureCode=${intent.featureCode} action=${intent.action} related=${intent.relatedFeatureCodes?.join(",") ?? ""} reason=${intent.reason}`.substring(0, 500),
      duration_ms: Date.now() - start,
      llm_tokens_used: result.tokensUsed,
      data: intent,
    };
  } catch (err) {
    const intent = emptyIntent("LLM 意图识别失败，请补充页面名称或业务场景");
    return {
      stepName: "intent_classification",
      input_summary: inputSummary,
      output_summary: `failed: featureCode=${intent.featureCode}`,
      duration_ms: Date.now() - start,
      data: intent,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function loadSkillSummaries(schemaName: string): Promise<SkillSummary[]> {
  const { rows } = await pool.query(
    `select skill_code, skill_name, feature_code, skill_md_content
     from admin.skill_registry
     where (schema_scope = 'tenant' and schema_name = $1 or schema_scope = 'tenant_default')
       and status = 'active' and deleted = false
     order by module_code, feature_code`,
    [schemaName]
  );
  return rows.map((row: { skill_code?: string; skill_name?: string; feature_code?: string; skill_md_content?: string }) => ({
    skill_code: String(row.skill_code ?? ""),
    skill_name: String(row.skill_name ?? ""),
    skill_summary: formatSkillSummaryFromMd({
      skillCode: String(row.skill_code ?? ""),
      skillName: String(row.skill_name ?? ""),
      featureCode: row.feature_code ? String(row.feature_code) : undefined,
      content: String(row.skill_md_content ?? ""),
      fallbackChars: 200,
    }),
  }));
}

function parseTextIntent(content: string, summaries: SkillSummary[]): IntentResult {
  try {
    const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = codeBlockMatch ? codeBlockMatch[1].trim() : content.trim();
    const parsed = JSON.parse(jsonStr);
    return {
      featureCode: String(parsed.featureCode ?? "").replace(/^skill_/, ""),
      action: parsed.action === "create" ? "create" : "modify",
      reason: String(parsed.reason ?? ""),
      moduleCode: parsed.moduleCode ? String(parsed.moduleCode) : undefined,
      relatedFeatureCodes: normalizeRelatedFeatureCodes(parsed.relatedFeatureCodes),
    };
  } catch {
    return { featureCode: "", action: "modify", reason: "" };
  }
}

function normalizeRelatedFeatureCodes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item).replace(/^skill_/, "").trim()).filter(Boolean))].slice(0, 5);
}

function emptyIntent(reason: string): IntentResult {
  return { featureCode: "", action: "modify", reason, relatedFeatureCodes: [] };
}
