import { callWithToolCalling } from "../llm.service.js";
import type { ChangeCapability, ChangeCapabilityType, ChangePlan, ContextResult, HarnessStepResult, IntentResult } from "../types.js";
import { TEMPLATE_SCHEMA } from "../../common/template-schema.js";

const CAPABILITY_TYPES: ChangeCapabilityType[] = [
  "add_field",
  "modify_field",
  "remove_field",
  "create_table",
  "add_import",
  "add_report",
  "add_filter",
  "add_permission",
  "add_data_permission",
  "add_approval_flow",
  "add_export",
  "add_print_template",
  "add_business_rule",
  "add_workflow_action",
  "modify_layout",
];

const PLAN_REQUIREMENT_TOOL = {
  type: "function" as const,
  function: {
    name: "plan_requirement",
    description: "判断租户自然语言需求需要哪些定制能力、是否还缺少关键信息",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string", description: "一句话总结识别到的定制能力" },
        capabilities: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: {
                type: "string",
                enum: CAPABILITY_TYPES,
                description: "能力类型",
              },
              label: { type: "string", description: "给租户看的能力名称" },
              risk: { type: "string", enum: ["low", "medium", "high"] },
              requiresConfirmation: { type: "boolean", description: "只有缺少必要业务口径或高风险破坏性操作时为 true" },
              params: { type: "object", description: "结构化补充参数，如 actionFamily/storageStrategy/sourceTable/dimensions/metrics/filters" },
            },
            required: ["type", "label", "risk", "requiresConfirmation"],
          },
        },
        questions: {
          type: "array",
          items: { type: "string" },
          description: "只有 canProceed=false 时给租户确认的问题",
        },
        canProceed: {
          type: "boolean",
          description: "已有足够信息生成 DSL 变更时为 true",
        },
      },
      required: ["summary", "capabilities", "questions", "canProceed"],
    },
  },
};

type RequirementPlanner = (input: {
  userMessage: string;
  intent: IntentResult;
  context: ContextResult;
  schemaName: string;
}) => Promise<ChangePlan>;

export async function executeRequirementPlanning(
  userMessage: string,
  intent: IntentResult,
  context: ContextResult,
  schemaName = TEMPLATE_SCHEMA,
  planner: RequirementPlanner = planRequirementWithLlm,
): Promise<HarnessStepResult<ChangePlan>> {
  const start = Date.now();
  const inputSummary = `featureCode=${intent.featureCode} userMessage=${userMessage.substring(0, 200)}`;

  let plan = await retryRequirementPlanner(() => planner({ userMessage, intent, context, schemaName }))
    .catch(() => llmUnavailablePlan(intent));
  plan = normalizePlan(plan, intent);

  return {
    stepName: "requirement_planning",
    input_summary: inputSummary,
    output_summary: `${plan.summary}; canProceed=${plan.canProceed}`.substring(0, 500),
    duration_ms: Date.now() - start,
    data: plan,
  };
}

async function retryRequirementPlanner(fn: () => Promise<ChangePlan>): Promise<ChangePlan> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

async function planRequirementWithLlm(input: {
  userMessage: string;
  intent: IntentResult;
  context: ContextResult;
  schemaName: string;
}): Promise<ChangePlan> {
  const system = [
    "你是教务 SaaS 的 AI 定制需求澄清器。",
    "你的任务是判断当前需求是否已经足够生成 DSL 变更，不要用固定关键词机械分类，要结合完整多轮上下文和业务语义。",
    "如果最后一条用户消息是在回答上一轮问题或确认口径，必须继承历史目标并尽量继续推进。",
    "只有在缺少生成 DSL 必需的信息时才提问；用户已经给出维度、指标、字段、范围、是否图表等口径时，不要重复确认。",
    "新建 CRUD 功能时，只要用户给出了功能名称、所属模块或业务场景、字段列表和需要列表/新增/编辑/详情/删除等范围，就可以继续；字段类型不明确时用合理默认值：姓名/备注/课程意向用 text/textarea，电话用 tel，时间用 datetime，校区/学员等常见外键用 select。",
    "不要因为下拉还是文本、是否关联现有表、备注字数限制这类可默认处理的问题阻塞生成；这些只能作为低风险假设写入 params，不能让 canProceed=false。",
    "区分报表/统计与业务动作：统计、汇总、排名、看板类需求选择报表能力；只有用户明确要按钮、入口、流程或执行动作时才选择 add_workflow_action。",
    "区分报表字段与业务表字段：报表页面展示列不等于给业务表新增字段。",
    "标准教务业务动作已有内置命令和默认字段：招生/学员跟进、排课/约课、课消扣费、合同收款/补缴、退费。用户明确说要这些按钮/行操作/弹窗时，必须 canProceed=true；不要询问 API Code、支付/退费方式选项、金额是否自动计算、是否二次确认，这些由标准工具和业务命令处理。",
    "审批流、导出、打印模板、数据权限、业务校验规则都是标准定制能力：用户已经说明页面/业务对象和基本规则时必须 canProceed=true；步骤、模板字段、导出列、校验表达式不完整时使用合理默认并在 params 中结构化表达。",
    "不要因为租户策略或高风险字样要求用户反复确认；只有删除、覆盖、资金/课时直接改写等仍缺少范围或回滚口径的情况才 requiresConfirmation=true。",
  ].join("\n");

  const user = JSON.stringify({
    userMessage: input.userMessage,
    intent: input.intent,
    contextSummary: {
      relevantDslCodes: input.context.relevantDslCodes,
      pages: input.context.dslSummary.pages,
      apis: input.context.dslSummary.apis,
      actions: input.context.dslSummary.actions,
      tableNames: Object.keys(input.context.tableColumns),
      tokenEstimate: input.context.tokenEstimate,
    },
    allowedCapabilityTypes: CAPABILITY_TYPES,
  }, null, 2);

  const result = await callWithToolCalling({
    schemaName: input.schemaName,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    tools: [PLAN_REQUIREMENT_TOOL],
    fallbackPrompt: "\n\n请只输出 JSON，格式与 plan_requirement 工具参数一致。",
  });

  if (result.type === "tool_call" && result.functionCall) {
    return JSON.parse(result.functionCall.arguments) as ChangePlan;
  }
  if (result.content) {
    return JSON.parse(extractJson(result.content)) as ChangePlan;
  }
  throw new Error("LLM requirement plan is empty");
}

function normalizePlan(plan: ChangePlan, intent: IntentResult): ChangePlan {
  const planObj = plan as ChangePlan & { dslChange?: { changes?: unknown[]; reason?: string; summary?: string } };
  const rawCapabilities = parseCapabilities(plan.capabilities ?? planObj.dslChange?.changes);
  const capabilities = Array.isArray(rawCapabilities)
    ? rawCapabilities.map(normalizeCapability).filter((item): item is ChangeCapability => Boolean(item))
    : [];
  const questions = Array.isArray(plan.questions) ? plan.questions.map(String).filter(Boolean) : [];
  const summary = String(plan.summary || planObj.dslChange?.summary || planObj.dslChange?.reason || (capabilities.length > 0
    ? `识别到 ${capabilities.length} 类定制能力：${capabilities.map((item) => item.label).join("、")}`
    : "暂未识别到明确的定制能力"));
  const needsConfirmation = capabilities.some((item) => item.requiresConfirmation);
  const canProceed = (Boolean(plan.canProceed) || canProceedWithDefaults(plan, intent, capabilities)) && capabilities.length > 0 && !needsConfirmation;

  return {
    targetModule: intent.moduleCode,
    targetFeature: intent.featureCode,
    targetPage: intent.featureCode,
    ...plan,
    summary,
    capabilities,
    questions,
    canProceed,
  };
}

function parseCapabilities(value: unknown): unknown {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : value;
  } catch {
    return value;
  }
}

function normalizeCapability(value: unknown): ChangeCapability | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  const params = obj.params && typeof obj.params === "object" && !Array.isArray(obj.params)
    ? obj.params as Record<string, unknown>
    : {};
  const type = inferCapabilityType(obj, params);
  if (!CAPABILITY_TYPES.includes(type)) return undefined;
  const risk = obj.risk === "high" || obj.risk === "medium" || obj.risk === "low" ? obj.risk : "medium";
  return {
    type,
    label: String(obj.label ?? type),
    risk,
    requiresConfirmation: obj.requiresConfirmation === true,
    params,
  };
}

function inferCapabilityType(obj: Record<string, unknown>, params: Record<string, unknown>): ChangeCapabilityType {
  const explicit = String(obj.type ?? "");
  if (CAPABILITY_TYPES.includes(explicit as ChangeCapabilityType)) return explicit as ChangeCapabilityType;
  if (explicit === "add_business_rule") return "add_business_rule";
  if (explicit === "add_approval_flow") return "add_approval_flow";
  if (explicit === "add_export") return "add_export";
  if (explicit === "add_print_template") return "add_print_template";
  if (explicit === "add_data_permission") return "add_data_permission";
  const actionFamily = String(params.actionFamily ?? params.capabilityType ?? "");
  if (CAPABILITY_TYPES.includes(actionFamily as ChangeCapabilityType)) return actionFamily as ChangeCapabilityType;
  const label = String(obj.label ?? "");
  if (/报表|统计|排行|排名|汇总/.test(label)) return "add_report";
  if (/导入/.test(label)) return "add_import";
  if (/审批/.test(label)) return "add_approval_flow";
  if (/导出/.test(label)) return "add_export";
  if (/打印|模板/.test(label)) return "add_print_template";
  if (/数据权限|权限范围/.test(label)) return "add_data_permission";
  if (/校验|规则|限制/.test(label)) return "add_business_rule";
  if (/新建数据表|新增数据表|建表/.test(label)) return "create_table";
  if (/字段/.test(label)) return "add_field";
  return "" as ChangeCapabilityType;
}

function canProceedWithDefaults(plan: ChangePlan, intent: IntentResult, capabilities: ChangeCapability[]): boolean {
  if (capabilities.length === 0) return false;
  if (capabilities.some((item) => item.requiresConfirmation)) return false;
  if (capabilities.some((item) => item.type === "add_report" || item.type === "add_import")) return true;
  if (intent.action === "create" && capabilities.some((item) => item.type === "create_table")) {
    const text = [plan.summary, ...(Array.isArray(plan.questions) ? plan.questions : [])].join(" ");
    return !/删除.*范围|覆盖.*规则|资金.*回滚|课时.*回滚/.test(text);
  }
  return false;
}

function llmUnavailablePlan(intent: IntentResult): ChangePlan {
  return {
    targetModule: intent.moduleCode,
    targetFeature: intent.featureCode,
    targetPage: intent.featureCode,
    summary: "暂时无法完成需求理解",
    capabilities: [],
    questions: ["AI 暂时无法稳定理解本次需求，请补充更明确的页面、字段、统计口径或操作目标后重试。"],
    canProceed: false,
  };
}

function extractJson(content: string) {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) return fenced[1].trim();
  const first = content.indexOf("{");
  const last = content.lastIndexOf("}");
  if (first >= 0 && last > first) return content.slice(first, last + 1);
  return content;
}
