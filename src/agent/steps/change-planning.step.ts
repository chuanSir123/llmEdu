import { callWithToolCalling } from "../llm.service.js";
import { PLAN_CHANGES_TOOL, PLANNING_SYSTEM_PROMPT_TEMPLATE, FALLBACK_PLANNING_PROMPT } from "../prompts.js";
import { parsePlanDiffsFromToolArguments } from "../dsl-diff-parser.js";
import type { ContextResult, DslDiff, IntentResult, HarnessStepResult } from "../types.js";

export async function executeChangePlanning(
  userMessage: string,
  intent: IntentResult,
  context: ContextResult,
  schemaName: string,
  repairFeedback?: string,
): Promise<HarnessStepResult<DslDiff[]>> {
  const start = Date.now();
  const inputSummary = `userMessage=${userMessage.substring(0, 200)} featureCode=${intent.featureCode}${repairFeedback ? " repair=true" : ""}`;

  try {
    const systemPrompt = PLANNING_SYSTEM_PROMPT_TEMPLATE
      .replace("{skillMdContent}", context.skillMdContent)
      .replace("{tableColumns}", JSON.stringify(context.tableColumns, null, 2))
      .replace("{dslSummary}", JSON.stringify(context.dslSummary, null, 2));

    const messages: Array<{ role: string; content: string }> = [
      { role: "system", content: systemPrompt },
    ];
    if (repairFeedback) {
      messages.push({
        role: "assistant",
        content: [
          `上一次生成的变更在校验或预览执行时失败。错误信息：${repairFeedback}`,
          "请避免重复错误，必要时补充关联的 page/api/action 变更。",
          "如果错误是报表字段不存在、missing metric/dimension/filter field 或字段校验失败，必须回到已注入的 SKILL.md 和 tableColumns 重新选择真实 sourceTable 与字段；不要根据用户措辞编造 employee/student/amount/name 等字段，也不要为了找到 name 字段切到无关表。",
        ].join("\n"),
      });
    }
    messages.push({ role: "user", content: userMessage });

    const result = await callWithToolCalling({
      schemaName,
      messages,
      tools: [PLAN_CHANGES_TOOL],
      fallbackPrompt: FALLBACK_PLANNING_PROMPT,
    });

    let diffs: DslDiff[];
    if (result.type === "tool_call" && result.functionCall) {
      diffs = parsePlanDiffsFromToolArguments(result.functionCall.arguments);
    } else {
      diffs = parseTextDiffs(result.content ?? "");
    }

    return {
      stepName: "change_planning",
      input_summary: inputSummary,
      output_summary: `diffs_count=${diffs.length} ops=${diffs.map((d) => d.op).join(",")}`.substring(0, 500),
      duration_ms: Date.now() - start,
      llm_tokens_used: result.tokensUsed,
      data: diffs,
    };
  } catch (err) {
    return {
      stepName: "change_planning",
      input_summary: inputSummary,
      output_summary: "failed",
      duration_ms: Date.now() - start,
      data: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function parseTextDiffs(content: string): DslDiff[] {
  try {
    const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    let jsonStr = codeBlockMatch ? codeBlockMatch[1].trim() : content.trim();
    if (!jsonStr.startsWith("[")) {
      const bracketStart = jsonStr.indexOf("[");
      const bracketEnd = jsonStr.lastIndexOf("]");
      if (bracketStart >= 0 && bracketEnd > bracketStart) {
        jsonStr = jsonStr.slice(bracketStart, bracketEnd + 1);
      } else return [];
    }
    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      if (obj.diffs && Array.isArray(obj.diffs)) return parseDiffArray(obj.diffs as Record<string, unknown>[]);
      return [];
    }
    return parseDiffArray(parsed as Record<string, unknown>[]);
  } catch {
    return [];
  }
}

function parseDiffArray(arr: Record<string, unknown>[]): DslDiff[] {
  return arr.filter((d) => d.targetType && d.targetCode && d.op).map((d) => ({
    targetType: String(d.targetType) as DslDiff["targetType"],
    targetCode: String(d.targetCode),
    op: String(d.op) as DslDiff["op"],
    field: d.field ? String(d.field) : undefined,
    fieldDef: d.fieldDef as Record<string, unknown> | undefined,
    resourceDef: d.resourceDef as Record<string, unknown> | undefined,
    sortOrder: d.sortOrder != null ? Number(d.sortOrder) : undefined,
    modifiedDslJson: d.modifiedDslJson,
  }));
}
