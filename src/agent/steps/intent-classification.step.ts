import { pool } from "../../db/pool.js";
import { callWithToolCalling } from "../llm.service.js";
import { CLASSIFY_INTENT_TOOL, INTENT_SYSTEM_PROMPT_STATIC, INTENT_FEATURES_TEMPLATE, FALLBACK_INTENT_PROMPT } from "../prompts.js";
import { formatSkillSummaryFromMd } from "../skill-md.service.js";
import type { IntentResult, SkillSummary, HarnessStepResult } from "../types.js";
import { TEMPLATE_SCHEMA } from "../../common/template-schema.js";

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
    intent = normalizeIntentAgainstExistingFeatures(intent, summaries);

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
     where (schema_scope = 'tenant' and schema_name = $1 or (schema_scope = 'tenant' and schema_name = '${TEMPLATE_SCHEMA}'))
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

/**
 * 把模型可能编造的功能编码归一到系统中真实存在的功能：
 * "学员详情/详情页"不是独立功能，属于对应列表功能（student_detail → student_list）。
 * 无法归一时保留原值，由校验层的目标存在性检查兜底报错。
 */
export function resolveExistingFeatureCode(
  featureCode: string,
  existingCodes: string[],
): { featureCode: string; matched: boolean } {
  if (!featureCode) return { featureCode, matched: false };
  const codes = new Set(existingCodes);
  if (codes.has(featureCode)) return { featureCode, matched: true };
  const base = featureCode.replace(/_(detail|page|view|form|modal|edit|info)$/, "");
  for (const candidate of [`${base}_list`, base, `${featureCode}_list`]) {
    if (candidate && candidate !== featureCode && codes.has(candidate)) {
      return { featureCode: candidate, matched: true };
    }
  }
  const prefixMatches = existingCodes.filter((code) => code === base || code.startsWith(`${base}_`));
  if (prefixMatches.length === 1) return { featureCode: prefixMatches[0], matched: true };
  return { featureCode, matched: false };
}

function normalizeIntentAgainstExistingFeatures(intent: IntentResult, summaries: SkillSummary[]): IntentResult {
  const existingCodes = summaries.map((s) => s.skill_code.replace(/^skill_/, "")).filter(Boolean);
  let next = intent;
  if (next.action === "modify" && next.featureCode) {
    const resolved = resolveExistingFeatureCode(next.featureCode, existingCodes);
    if (resolved.matched && resolved.featureCode !== next.featureCode) {
      next = {
        ...next,
        featureCode: resolved.featureCode,
        reason: `${next.reason}（编码 ${intent.featureCode} 不在功能列表中，已归一到现有功能 ${resolved.featureCode}）`.trim(),
      };
    }
  }
  if (next.relatedFeatureCodes && next.relatedFeatureCodes.length > 0) {
    next = {
      ...next,
      relatedFeatureCodes: [...new Set(next.relatedFeatureCodes.map((code) => resolveExistingFeatureCode(code, existingCodes).featureCode))],
    };
  }
  return next;
}

function emptyIntent(reason: string): IntentResult {
  return { featureCode: "", action: "modify", reason, relatedFeatureCodes: [] };
}
