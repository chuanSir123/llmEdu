import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";
import type { AgentProgressCallback, ChangePlan, HarnessResult, HarnessStepResult, IntentResult, ContextResult, DslDiff } from "./types.js";
import { executeIntentClassification } from "./steps/intent-classification.step.js";
import { executeContextInjection } from "./steps/context-injection.step.js";
import { executeRequirementPlanning } from "./steps/requirement-planning.step.js";
import { executeChangePlanning } from "./steps/change-planning.step.js";
import { executeValidationRepair } from "./steps/validation-repair.step.js";
import { executePreview } from "./steps/execute-preview.step.js";
import { executeDiffs } from "./diff-executor.js";
import { executeDomainToolPlanning } from "./domain-tools.js";
import { loadTenantAgentPolicy } from "./tenant-policy.service.js";
import { evaluateHarnessRisk } from "./risk-evaluator.js";
import { formatHarnessImpactMessage, summarizeHarnessImpact } from "./impact-summarizer.js";
import { runWithLlmTraceContext } from "./llm.service.js";
import { needsContextRefresh, classifyFeedback } from "./harness-errors.js";

export async function harnessRun(input: {
  userMessage: string;
  schemaName: string;
  sessionId: string;
  userId: string;
  chatHistory?: Array<{ role: string; content: string }>;
  onProgress?: AgentProgressCallback;
}): Promise<HarnessResult> {
  return runWithLlmTraceContext(
    { schemaName: input.schemaName, sessionId: input.sessionId, userId: input.userId },
    () => harnessRunInner(input),
  );
}

async function harnessRunInner(input: {
  userMessage: string;
  schemaName: string;
  sessionId: string;
  userId: string;
  chatHistory?: Array<{ role: string; content: string }>;
  onProgress?: AgentProgressCallback;
}): Promise<HarnessResult> {
  const startTime = Date.now();
  const emit = async (
    stage: Parameters<AgentProgressCallback>[0]["stage"],
    title: string,
    message: string,
    detail?: unknown,
    meta?: { toolName?: string; status?: "running" | "success" | "failed" | "skipped" },
  ) => {
    await input.onProgress?.({
      stage,
      title,
      message,
      detail,
      toolName: meta?.toolName,
      status: meta?.status,
      visibleToTenant: true,
      createdAt: new Date().toISOString(),
    });
  };

  await emit("understanding", "正在了解需求", "正在了解用户需求，确定需要修改的功能范围。");
  const effectiveUserMessage = buildEffectiveUserMessage(input.userMessage, input.chatHistory);
  const persistedSteps: Array<HarnessStepResult<unknown>> = [];

  const intent = await runStep("intent_classification", () =>
    executeIntentClassification(input.userMessage, input.schemaName, input.chatHistory)
  );
  persistedSteps.push(intent);

  if (intent.error || !intent.data) {
    await emit("failed", "需求理解失败", "AI 定制助手暂时无法理解本次需求，请稍后重试或联系管理员。");
    const failedResult = buildFailedResult(intent, input.userMessage, intent.error ?? "intent classification returned empty result");
    await writeStepLogs(input.sessionId, persistedSteps);
    return failedResult;
  }

  if (!intent.data.featureCode) {
    await emit("need_confirm", "需要更多信息", "暂时无法确定要修改哪个功能，请补充页面名称或业务场景。");
    const emptyResult = buildEmptyResult(intent, input.userMessage);
    await writeStepLogs(input.sessionId, persistedSteps);
    return emptyResult;
  }

  await emit(
    "scope_detected",
    "已确定修改范围",
    `已确定目标功能：${intent.data.featureCode}，本轮将进行${intent.data.action === "create" ? "新增" : "修改"}。`,
    intent.data,
  );

  await emit("context_loading", "正在读取配置", "正在读取当前页面、接口、字段和租户配置。");
  let context = await runStep("context_injection", () =>
    executeContextInjection(intent.data, input.schemaName, effectiveUserMessage)
  );
  persistedSteps.push(context);
  if (context.error || !context.data) {
    await emit("failed", "上下文加载失败", "读取当前页面、接口或租户配置时失败，请稍后重试或联系管理员。");
    const failedResult = buildFailedResult(intent, input.userMessage, context.error ?? "context injection returned empty result", context);
    await writeStepLogs(input.sessionId, persistedSteps);
    return failedResult;
  }
  await emit(
    "tool_result",
    "上下文已就绪",
    `已加载 ${context.data.relevantDslCodes.length} 个相关功能、${Object.keys(context.data.tableColumns).length} 张相关表，当前上下文约 ${context.data.tokenEstimate} tokens。`,
    {
      relevantDslCodes: context.data.relevantDslCodes,
      tableCount: Object.keys(context.data.tableColumns).length,
      tokenEstimate: context.data.tokenEstimate,
      pages: context.data.dslSummary.pages.length,
      apis: context.data.dslSummary.apis.length,
      actions: context.data.dslSummary.actions.length,
    },
    { toolName: "context_injection", status: "success" },
  );
  const policy = await loadTenantAgentPolicy(input.schemaName);

  const requirement = await runStep("requirement_planning", () =>
    executeRequirementPlanning(effectiveUserMessage, intent.data, context.data, input.schemaName)
  );
  persistedSteps.push(requirement);
  if (requirement.error || !requirement.data) {
    await emit("failed", "定制计划生成失败", "根据当前需求生成定制计划时失败，请补充更明确的需求后重试。");
    const failedResult = buildFailedResult(intent, input.userMessage, requirement.error ?? "requirement planning returned empty result", context, requirement);
    await writeStepLogs(input.sessionId, persistedSteps);
    return failedResult;
  }

  await emit(
    requirement.data.canProceed ? "planning" : "need_confirm",
    requirement.data.canProceed ? "已形成定制计划" : "需要确认定制细节",
    requirement.data.canProceed
      ? requirement.data.summary
      : `${requirement.data.summary}。${requirement.data.questions.join(" ")}`,
    requirement.data,
  );

  if (!requirement.data.canProceed) {
    const emptyPlanning = buildSkippedPlanning("skipped: requirement confirmation needed");
    const emptyValidation = buildSkippedValidation("skipped: requirement confirmation needed");
    const emptyExecution = buildSkippedExecution("skipped: requirement confirmation needed");
    persistedSteps.push(emptyPlanning, emptyValidation, emptyExecution);
    await writeStepLogs(input.sessionId, persistedSteps);
    return {
      intent,
      context,
      requirement,
      planning: emptyPlanning,
      validation: emptyValidation,
      execution: emptyExecution,
      totalDuration_ms: Date.now() - startTime,
    };
  }

  let planning = buildSkippedPlanning("not started");
  let validation = buildSkippedValidation("not started");
  let execution: HarnessStepResult<Array<{ versionId: string; versionNo: number }>> = buildSkippedExecution("not started");
  let repairFeedback = "";
  let contextRefreshCount = 0;
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (repairFeedback && contextRefreshCount < maxAttempts - 1 && needsContextRefresh(repairFeedback)) {
      contextRefreshCount += 1;
      await emit("context_loading", "正在补充上下文", "上一次错误显示字段或筛选定义缺失，正在重新定位相关 skill 并读取完整表结构。");
      context = await runStep("context_injection", () =>
        executeContextInjection(
          intent.data,
          input.schemaName,
          `${effectiveUserMessage}\n\n上一次错误：${repairFeedback}\n\n请重新选择能解释这些字段和指标的相关功能，加载完整 SKILL.md 后再生成 DSL。`,
        )
      );
      persistedSteps.push({ ...context, input_summary: `${context.input_summary} refresh=${contextRefreshCount}` });
    }
    await emit(
      "planning",
      attempt === 1 ? "正在生成方案" : "正在重新生成方案",
      attempt === 1
        ? "正在根据租户需求生成 DSL 变更方案。"
        : `已把上一次错误注入上下文，正在第 ${attempt} 次重新生成 DSL 变更方案。`,
    );
    if (!repairFeedback) {
      const toolPlanning = await runStep("domain_tool_planning", () =>
        executeDomainToolPlanning({
          userMessage: effectiveUserMessage,
          schemaName: input.schemaName,
          intent: intent.data,
          context: context.data,
          policy,
        })
      );
      planning = toolPlanning.data.length > 0 && !toolPlanning.error
        ? toolPlanning
        : await runStep("change_planning", () =>
          executeChangePlanning(effectiveUserMessage, intent.data, context.data, input.schemaName)
        );
    } else {
      // 增量修复：把上一轮生成的 diff 回传给模型，保留通过项只修报错项
      const priorDiffs = planning.data;
      planning = await runStep("change_planning", () =>
        executeChangePlanning(effectiveUserMessage, intent.data, context.data, input.schemaName, repairFeedback, priorDiffs)
      );
    }
    persistedSteps.push({ ...planning, input_summary: `${planning.input_summary} attempt=${attempt}` });

    await emit(
      "dsl_generating",
      "已生成草稿方案",
      planning.data.length > 0
        ? `已生成 ${planning.data.length} 项 DSL 变更，正在进入校验。`
        : "没有生成可执行的 DSL 变更，正在尝试修正。",
      { attempt, diffsCount: planning.data.length, ops: planning.data.map((d) => d.op) },
    );
    if (planning.data.length > 0) {
      await emit(
        "tool_start",
        "准备更新配置",
        summarizePlannedDiffs(planning.data),
        {
          attempt,
          diffs: planning.data.map((diff) => ({
            targetType: diff.targetType,
            targetCode: diff.targetCode,
            op: diff.op,
            field: diff.field ?? diff.fieldDef?.key ?? diff.resourceDef?.tableName,
          })),
        },
        { toolName: "batch_update", status: "running" },
      );
    }

    await emit("validating", "正在验证配置", "正在验证 DSL 结构、字段定义和预览兼容性。");
    validation = await runStep("validation_repair", () =>
      executeValidationRepair(planning.data, intent.data, context.data, input.schemaName, effectiveUserMessage)
    );
    persistedSteps.push({ ...validation, input_summary: `${validation.input_summary} attempt=${attempt}` });

    if (validation.error) {
      repairFeedback = validation.error;
      await emit(
        attempt < maxAttempts ? "validating" : "failed",
        attempt < maxAttempts ? "验证失败，正在修正" : "验证失败",
        attempt < maxAttempts
          ? `校验未通过：${validation.error}。我会把错误反馈给模型重新生成。`
          : `DSL 校验未通过：${validation.error}`,
      );
      continue;
    }
    await emit(
      "tool_result",
      "配置校验通过",
      `已校验 ${validation.data.length} 项变更，页面、接口和资源定义可以进入预览。`,
      { diffsCount: validation.data.length },
      { toolName: "validation_repair", status: "success" },
    );
    const impact = summarizeHarnessImpact(validation.data);
    await emit(
      "tool_result",
      "已生成影响摘要",
      formatHarnessImpactMessage(impact),
      impact,
      { toolName: "impact_summarizer", status: "success" },
    );
    const risk = evaluateHarnessRisk(validation.data, policy);
    if (risk.level !== "low") {
      await emit(
        "validating",
        risk.level === "high" ? "已识别高风险变更" : "已识别中风险变更",
        risk.requiresManualReview
          ? "租户策略要求平台审核后发布，本轮仍可先生成预览草稿。"
          : risk.highRiskDiffs.length > 0
            ? `包含高风险项：${risk.highRiskDiffs.map((item) => item.reason).join("、")}。`
            : "包含导入、报表等中风险配置，请预览确认后再发布。",
        risk,
        { toolName: "risk_evaluator", status: "success" },
      );
    }

    await emit("preview_preparing", "正在生成预览", "校验通过，正在生成可预览的草稿版本。");
    execution = await runStep("execute_preview", () =>
      executePreview(validation.data, input.schemaName, input.userId, { executeDiffs })
    );
    persistedSteps.push({ ...execution, input_summary: `${execution.input_summary} attempt=${attempt}` });

    if (execution.error) {
      repairFeedback = execution.error;
      await emit(
        attempt < maxAttempts ? "preview_preparing" : "failed",
        attempt < maxAttempts ? "预览准备失败，正在修正" : "预览准备失败",
        attempt < maxAttempts
          ? `草稿生成失败：${execution.error}。我会把错误反馈给模型重新生成。`
          : `草稿生成失败：${execution.error}`,
      );
      continue;
    }
    await emit(
      "tool_result",
      "草稿生成完成",
      execution.data.length > 0 ? `已生成 ${execution.data.length} 个可预览草稿。` : "本轮没有生成可预览草稿。",
      { draftResults: execution.data },
      { toolName: "execute_preview", status: execution.data.length > 0 ? "success" : "skipped" },
    );

    if (execution.data.length > 0) {
      await emit(
        "preview_ready",
        "可预览",
        `验证成功，本轮生成了 ${execution.data.length} 个草稿版本，请点击预览查看效果。`,
        { draftResults: execution.data },
      );
      break;
    }

    repairFeedback = "没有生成可预览的草稿版本";
    await emit(
      attempt < maxAttempts ? "planning" : "need_confirm",
      attempt < maxAttempts ? "未生成草稿，正在修正" : "未生成草稿",
      attempt < maxAttempts ? "没有生成可预览草稿，我会重新生成方案。" : "没有生成可预览的草稿，请补充更明确的修改内容。",
    );
  }

  await writeStepLogs(input.sessionId, persistedSteps);

  return {
    intent,
    context,
    requirement,
    planning,
    validation,
    execution,
    totalDuration_ms: Date.now() - startTime,
  };
}

async function runStep<T>(
  stepName: string,
  fn: () => Promise<HarnessStepResult<T>>,
): Promise<HarnessStepResult<T>> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      stepName,
      input_summary: "",
      output_summary: `error: ${msg}`.substring(0, 500),
      duration_ms: 0,
      data: undefined as unknown as T,
      error: msg,
    };
  }
}

function buildEmptyResult(
  intent: HarnessStepResult<IntentResult>,
  userMessage: string,
): HarnessResult {
  const emptyContext: HarnessStepResult<ContextResult> = {
    stepName: "context_injection",
    input_summary: "",
    output_summary: "skipped: no feature identified",
    duration_ms: 0,
    data: { skillMdContent: "", tableColumns: {}, relevantDslCodes: [], dslSummary: { pages: [], apis: [], actions: [] }, tokenEstimate: 0 },
  };
  const emptyRequirement: HarnessStepResult<ChangePlan> = {
    stepName: "requirement_planning",
    input_summary: userMessage.substring(0, 500),
    output_summary: "skipped: no feature identified",
    duration_ms: 0,
    data: { summary: "未识别到明确功能", capabilities: [], questions: ["请补充页面名称或业务场景。"], canProceed: false },
  };
  const emptyPlanning: HarnessStepResult<DslDiff[]> = {
    stepName: "change_planning",
    input_summary: "",
    output_summary: "skipped: no feature identified",
    duration_ms: 0,
    data: [],
  };
  const emptyValidation: HarnessStepResult<DslDiff[]> = {
    stepName: "validation_repair",
    input_summary: "",
    output_summary: "skipped: no feature identified",
    duration_ms: 0,
    data: [],
  };
  const emptyExecution: HarnessStepResult<Array<{ versionId: string; versionNo: number }>> = {
    stepName: "execute_preview",
    input_summary: "",
    output_summary: "skipped: no feature identified",
    duration_ms: 0,
    data: [],
  };
  return {
    intent,
    context: emptyContext,
    requirement: emptyRequirement,
    planning: emptyPlanning,
    validation: emptyValidation,
    execution: emptyExecution,
    totalDuration_ms: intent.duration_ms,
  };
}

function buildFailedResult(
  intent: HarnessStepResult<IntentResult>,
  userMessage: string,
  reason: string,
  context?: HarnessStepResult<ContextResult>,
  requirement?: HarnessStepResult<ChangePlan>,
): HarnessResult {
  const failedContext: HarnessStepResult<ContextResult> = context ?? {
    stepName: "context_injection",
    input_summary: "",
    output_summary: `skipped: ${reason}`.substring(0, 500),
    duration_ms: 0,
    data: { skillMdContent: "", tableColumns: {}, relevantDslCodes: [], dslSummary: { pages: [], apis: [], actions: [] }, tokenEstimate: 0 },
    error: reason,
  };
  const failedRequirement: HarnessStepResult<ChangePlan> = requirement ?? {
    stepName: "requirement_planning",
    input_summary: userMessage.substring(0, 500),
    output_summary: `skipped: ${reason}`.substring(0, 500),
    duration_ms: 0,
    data: { summary: "AI 定制流程中断", capabilities: [], questions: ["请稍后重试或联系管理员。"], canProceed: false },
    error: reason,
  };
  const failedPlanning: HarnessStepResult<DslDiff[]> = {
    stepName: "change_planning",
    input_summary: "",
    output_summary: `skipped: ${reason}`.substring(0, 500),
    duration_ms: 0,
    data: [],
    error: reason,
  };
  const failedValidation: HarnessStepResult<DslDiff[]> = {
    stepName: "validation_repair",
    input_summary: "",
    output_summary: `skipped: ${reason}`.substring(0, 500),
    duration_ms: 0,
    data: [],
    error: reason,
  };
  const failedExecution: HarnessStepResult<Array<{ versionId: string; versionNo: number }>> = {
    stepName: "execute_preview",
    input_summary: "",
    output_summary: `skipped: ${reason}`.substring(0, 500),
    duration_ms: 0,
    data: [],
    error: reason,
  };
  return {
    intent,
    context: failedContext,
    requirement: failedRequirement,
    planning: failedPlanning,
    validation: failedValidation,
    execution: failedExecution,
    totalDuration_ms: intent.duration_ms + failedContext.duration_ms + failedRequirement.duration_ms,
  };
}

function buildEffectiveUserMessage(
  userMessage: string,
  chatHistory?: Array<{ role: string; content: string }>,
) {
  const recent = (chatHistory ?? [])
    .slice(-6)
    .filter((msg) => (msg.role === "user" || msg.role === "assistant") && msg.content.trim())
    .map((msg) => `${msg.role === "user" ? "用户" : "助手"}：${msg.content.substring(0, 800)}`);
  if (recent.length === 0) return userMessage;
  return `请基于以下多轮对话理解完整需求，最后一条用户消息是对前文需求的补充或确认，不要丢失前文目标。\n\n## 历史对话\n${recent.join("\n")}\n\n## 当前用户消息\n${userMessage}`;
}

function summarizePlannedDiffs(diffs: DslDiff[]) {
  const fieldLabels = [...new Set(diffs.map((diff) => diff.field ?? String(diff.fieldDef?.key ?? diff.resourceDef?.tableName ?? "")).filter(Boolean))];
  const targetLabels = [...new Set(diffs.map((diff) => diff.targetCode).filter(Boolean))];
  const opLabels = [...new Set(diffs.map((diff) => diff.op).filter(Boolean))];
  const fieldText = fieldLabels.length ? `内容：${fieldLabels.join("、")}` : `操作：${opLabels.join("、")}`;
  const targetText = targetLabels.length <= 3 ? targetLabels.join("、") : `${targetLabels.slice(0, 3).join("、")} 等 ${targetLabels.length} 个目标`;
  return `将合并执行 ${diffs.length} 项更新；目标：${targetText}；${fieldText}。`;
}

function toolTitle(diff: DslDiff) {
  const labels: Record<string, string> = {
    create_table: "准备新增数据表",
    add_field: "准备新增物理字段",
    create_import: "准备新增导入能力",
    create_report: "准备新增报表",
    create_feature: "准备注册功能入口",
    add_column: "准备更新列表展示",
    add_filter: "准备更新筛选条件",
    add_modal_field: "准备更新表单字段",
    add_allowed_field: "准备更新接口字段",
    modify: "准备替换配置",
  };
  return labels[diff.op] ?? "准备执行配置变更";
}

function toolMessage(diff: DslDiff) {
  const field = String(diff.field ?? diff.fieldDef?.label ?? diff.fieldDef?.key ?? diff.resourceDef?.tableLabel ?? diff.resourceDef?.title ?? diff.resourceDef?.featureName ?? "");
  const target = diff.resourceDef?.pageCode ?? diff.resourceDef?.tableName ?? diff.targetCode;
  return field
    ? `目标：${target}，内容：${field}。`
    : `目标：${target}，操作：${diff.op}。`;
}

function buildSkippedPlanning(reason: string): HarnessStepResult<DslDiff[]> {
  return {
    stepName: "change_planning",
    input_summary: "",
    output_summary: reason,
    duration_ms: 0,
    data: [],
  };
}

function buildSkippedValidation(reason: string): HarnessStepResult<DslDiff[]> {
  return {
    stepName: "validation_repair",
    input_summary: "",
    output_summary: reason,
    duration_ms: 0,
    data: [],
  };
}

function buildSkippedExecution(reason: string): HarnessStepResult<Array<{ versionId: string; versionNo: number }>> {
  return {
    stepName: "execute_preview",
    input_summary: "",
    output_summary: reason,
    duration_ms: 0,
    data: [],
  };
}

async function writeStepLogs(
  sessionId: string,
  steps: Array<HarnessStepResult<unknown>>,
): Promise<void> {
  try {
    for (const step of steps) {
      const id = randomUUID();
      const errorCodes = step.error ? classifyFeedback(step.error) : [];
      await pool.query(
        `INSERT INTO admin.agent_harness_step_log(id, session_id, step_name, input_summary, output_summary, duration_ms, llm_tokens_used, error_codes)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
        [
          id,
          sessionId,
          step.stepName,
          (step.input_summary ?? "").substring(0, 1000),
          [step.output_summary, step.error ? `error=${step.error}` : ""].filter(Boolean).join(" | ").substring(0, 4000),
          step.duration_ms,
          step.llm_tokens_used ?? null,
          JSON.stringify(errorCodes),
        ]
      );
    }
  } catch (err) {
    console.warn("[HarnessRunner] step log write failed:", err instanceof Error ? err.message : err);
  }
}
