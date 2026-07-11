import { callWithToolCalling } from "./llm.service.js";
import { inferForeignKeyMeta } from "../common/foreign-key-meta.js";
import type { ContextResult, DslDiff, HarnessStepResult, IntentResult, TenantAgentPolicy } from "./types.js";
import { SYSTEM_DICTIONARIES } from "../dictionary.service.js";
import { SYSTEM_FIELD_SET } from "../common/dsl-constants.js";
import { inferDslFieldType } from "../common/field-type.js";

export type ToolInvocation = {
  toolName: string;
  args: Record<string, unknown>;
};

type FieldDef = {
  key: string;
  label: string;
  type?: string;
  required?: boolean;
};

const SYSTEM_FIELD_KEYS = SYSTEM_FIELD_SET;
const dictDefault = (dictCode: string, itemValue: unknown) => ({ dictCode, itemValue });

const SELECT_DOMAIN_TOOLS_TOOL = {
  type: "function" as const,
  function: {
    name: "select_domain_tools",
    description: "选择适合教务系统租户定制的高频工具，并填写工具参数",
    parameters: {
      type: "object",
      properties: {
        invocations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              toolName: {
                type: "string",
                enum: [
                  "add_ext_field_to_page",
                  "add_physical_filter_field",
                  "create_import_flow",
                  "create_report_page",
                  "add_followup_workflow",
                  "add_charge_workflow",
                  "add_contract_payment_workflow",
                  "add_refund_workflow",
                  "add_course_scheduling_workflow",
                  "create_custom_feature",
                  "modify_permission_policy",
                  "create_approval_flow",
                  "add_export_action",
                  "create_print_template",
                  "create_business_rule",
                  "create_business_event_listener",
                ],
              },
              args: { type: "object" },
            },
            required: ["toolName", "args"],
          },
        },
      },
      required: ["invocations"],
    },
  },
};

export async function executeDomainToolPlanning(input: {
  userMessage: string;
  schemaName: string;
  intent: IntentResult;
  context: ContextResult;
  policy: TenantAgentPolicy;
  selectTools?: (input: {
    userMessage: string;
    schemaName: string;
    intent: IntentResult;
    context: ContextResult;
    policy: TenantAgentPolicy;
  }) => Promise<ToolInvocation[]>;
}): Promise<HarnessStepResult<DslDiff[]>> {
  const start = Date.now();
  const inputSummary = `featureCode=${input.intent.featureCode} allowedTools=${input.policy.allowedTools.join(",")}`;
  try {
    const invocations = await (input.selectTools ?? selectLlmTools)(input);
    const filtered = invocations.filter((item) => input.policy.allowedTools.length === 0 || input.policy.allowedTools.includes(item.toolName));
    const diffs = filtered.flatMap((item) => buildDiffs(item, input.intent, input.policy));
    return {
      stepName: "domain_tool_planning",
      input_summary: inputSummary,
      output_summary: diffs.length > 0
        ? `tools=${filtered.map((i) => i.toolName).join(",")} diffs=${diffs.length}`
        : "no matching high-frequency tool",
      duration_ms: Date.now() - start,
      data: diffs,
    };
  } catch (err) {
    return {
      stepName: "domain_tool_planning",
      input_summary: inputSummary,
      output_summary: "failed",
      duration_ms: Date.now() - start,
      data: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function selectLlmTools(input: {
  userMessage: string;
  schemaName: string;
  intent: IntentResult;
  context: ContextResult;
  policy: TenantAgentPolicy;
}): Promise<ToolInvocation[]> {
  const system = [
    "你是教务 SaaS 租户定制工具编排器。",
    "结合用户完整需求、意图分类、当前页面/API/动作摘要选择合适工具，不要按单个关键词机械匹配。",
    "只有在需求能明确映射到某个标准工具时才选择工具；不明确、需要自由组合 DSL、或工具参数不够时返回空 invocations。",
    "区分统计/报表与业务动作：统计资金、课时、学员等数据时选择报表类工具；只有用户明确要按钮、入口、流程或执行动作时才选择工作流工具。",
    "工具说明：add_ext_field_to_page=给现有页面增加普通展示/编辑扩展字段；add_physical_filter_field=增加需要查询、筛选、统计或唯一约束的物理字段；create_import_flow=新增导入模板/导入能力；create_report_page=新增报表，必须根据已加载的 skill.md 和表结构填写 sourceTable、dimensions、metrics、filters、rank、sort；add_followup_workflow=新增招生/学员跟进动作；add_charge_workflow=新增课消或扣费确认动作；add_contract_payment_workflow=新增合同收款/补缴/付款确认动作；add_refund_workflow=新增退费动作；add_course_scheduling_workflow=新增排课/约课动作；create_custom_feature=新增完整业务功能和数据表；modify_permission_policy=调整角色、按钮、字段或数据权限；create_approval_flow=新增审批流定义；add_export_action=给页面新增导出按钮；create_print_template=新增打印模板；create_business_rule=新增或调整教务业务规则；create_business_event_listener=新增业务事件触发/监听规则，用于在标准事件后执行通知、建待办、更新自定义表或调用已存在业务动作。",
    "业务规则 category 使用 business_rule_category 系统数据字典，businessType 使用 business_type 系统数据字典；需要新增业务枚举时使用 dictionary(create_dictionary_item)，系统项不可覆盖。业务事件监听用 category=workflow，并写明 triggerEvent/listeners。",
    "常规教务规则：排课冲突必须包含老师冲突和学员冲突；业绩规则使用 performanceAllocation=byCpPaidRatio/oneToOneFirst/classCourseFirst，productPriority=none/oneToOneFirst/classCourseFirst/oneOnNFirst；资金分配使用 fundsAllocation=byCpRemainingAmount/byCpPaidRatio/oldestContractFirst/manual；优惠分配使用 promotionAllocation=byCpAmountRatio/byCpHourRatio/oneToOneFirst/classCourseFirst/manual。",
    "工具边界：用户要新增按钮、行操作、弹窗流程、调用业务命令时，不要选择 add_ext_field_to_page；必须选择对应 workflow 工具。排课/约课/课程时间老师校区课时 => add_course_scheduling_workflow；课消/扣费/确认扣费 => add_charge_workflow；合同收款/补缴/付款确认 => add_contract_payment_workflow；退费/申请退费 => add_refund_workflow；跟进/新增跟进 => add_followup_workflow。",
    "新增完整业务功能、独立页面、完整 CRUD 或新数据表时，优先选择 create_custom_feature；即使 tableName/pageCode 不能完全确定，也要给出 featureCode、featureName、moduleName 和 fields，后续工程会推断缺省编码。",
    "目标必须真实存在：pageCode/tableName/featureCode 必须来自已注入的 skillMd/tableColumns/dslSummary。详情类需求（如“给学员详情加字段”）的 pageCode 用对应列表功能（如 student_list），不要用 student_detail 这种详情页编码；add_ext_field_to_page/add_physical_filter_field 的目标页面必须是真实存在的列表功能页。不要为了加一个扩展字段编造或假设不存在的表（如 student_detail），应加到当前功能对应的事实表（如 student）。",
    "如果选择工具，必须填写足够参数；字段 key/tableName/pageCode/featureCode 使用小写下划线编码；不要只输出解释，必须通过工具调用或 JSON 返回 invocations。",
  ].join("\n");
  const user = JSON.stringify({
    userMessage: input.userMessage,
    intent: input.intent,
    skillMd: input.context.skillMdContent.substring(0, 3000),
    tableColumns: input.context.tableColumns,
    dslSummary: input.context.dslSummary,
    allowedTools: input.policy.allowedTools,
  }, null, 2);

  const result = await callWithToolCalling({
    schemaName: input.schemaName,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    tools: [SELECT_DOMAIN_TOOLS_TOOL],
  });

  if (result.type === "tool_call" && result.functionCall) {
    return parseToolInvocations(result.functionCall.arguments);
  }
  const parsed = parseToolInvocations(result.content ?? "");
  if (parsed.length > 0) return parsed;
  if ((result.content ?? "").trim()) {
    return repairToolSelectionWithLlm(input, system, user, result.content ?? "");
  }
  return [];
}

async function repairToolSelectionWithLlm(
  input: {
    userMessage: string;
    schemaName: string;
    intent: IntentResult;
    context: ContextResult;
    policy: TenantAgentPolicy;
  },
  systemPrompt: string,
  userPrompt: string,
  previousOutput: string,
): Promise<ToolInvocation[]> {
  const result = await callWithToolCalling({
    schemaName: input.schemaName,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
      {
        role: "assistant",
        content: previousOutput,
      },
      {
        role: "user",
        content: [
          "上一条输出没有形成可执行的工具调用。",
          "请重新判断是否能命中标准工具，并只输出 JSON：",
          "{\"invocations\":[{\"toolName\":\"create_custom_feature\",\"args\":{\"featureCode\":\"...\",\"featureName\":\"...\",\"moduleName\":\"...\",\"fields\":[{\"key\":\"...\",\"label\":\"...\",\"type\":\"text\",\"required\":true}]}}]}",
          "如果确实没有合适工具，输出 {\"invocations\":[]}",
        ].join("\n"),
      },
    ],
    fallbackPrompt: "\n\n只输出 JSON，不要解释。",
  });
  if (result.type === "tool_call" && result.functionCall) return parseToolInvocations(result.functionCall.arguments);
  return parseToolInvocations(result.content ?? "");
}

function parseToolInvocations(content: string): ToolInvocation[] {
  try {
    const args = JSON.parse(extractJson(content)) as { invocations?: unknown };
    if (!Array.isArray(args.invocations)) return [];
    return args.invocations
    .filter((item: unknown): item is ToolInvocation => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return false;
      const obj = item as Record<string, unknown>;
      return typeof obj.toolName === "string" && Boolean(obj.args) && typeof obj.args === "object";
    })
    .map((item: ToolInvocation) => ({ toolName: item.toolName, args: item.args }));
  } catch {
    return [];
  }
}

function extractJson(content: string) {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) return fenced[1].trim();
  const first = content.indexOf("{");
  const last = content.lastIndexOf("}");
  if (first >= 0 && last > first) return content.slice(first, last + 1);
  return content;
}

function buildDiffs(invocation: ToolInvocation, intent: IntentResult, policy: TenantAgentPolicy): DslDiff[] {
  switch (invocation.toolName) {
    case "add_ext_field_to_page":
      return addExtFieldToPage(invocation.args, intent);
    case "add_physical_filter_field":
      return addPhysicalFilterField(invocation.args, intent, policy);
    case "create_import_flow":
      return createImportFlow(invocation.args, intent, policy);
    case "create_report_page":
      return createReportPage(invocation.args, intent);
    case "add_followup_workflow":
      return addFollowupWorkflow(invocation.args, intent);
    case "add_course_scheduling_workflow":
      return addCourseSchedulingWorkflow(invocation.args, intent);
    case "add_charge_workflow":
      return addChargeWorkflow(invocation.args, intent);
    case "add_contract_payment_workflow":
      return addContractPaymentWorkflow(invocation.args, intent);
    case "add_refund_workflow":
      return addRefundWorkflow(invocation.args, intent);
    case "create_custom_feature":
      return createCustomFeature(invocation.args, intent);
    case "modify_permission_policy":
      return modifyPermissionPolicy(invocation.args, intent);
    case "create_approval_flow":
      return createApprovalFlow(invocation.args, intent);
    case "add_export_action":
      return addExportAction(invocation.args, intent);
    case "create_print_template":
      return createPrintTemplate(invocation.args, intent);
    case "create_business_rule":
      return createBusinessRule(invocation.args, intent);
    case "create_business_event_listener":
      return createBusinessEventListener(invocation.args, intent);
    default:
      return [];
  }
}

function pageCode(args: Record<string, unknown>, intent: IntentResult) {
  return String(args.pageCode ?? intent.featureCode ?? "").replace(/^skill_/, "");
}

function fields(args: Record<string, unknown>): FieldDef[] {
  const raw = Array.isArray(args.fields) ? args.fields : [];
  return raw
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    .map((item) => ({
      key: String(item.key ?? item.field ?? ""),
      label: String(item.label ?? item.name ?? item.key ?? item.field ?? ""),
      type: normalizeFieldType(String(item.key ?? item.field ?? ""), String(item.label ?? item.name ?? item.key ?? item.field ?? ""), String(item.type ?? "text")),
      required: item.required === true,
    }))
    .filter((field) => /^[a-z][a-z0-9_]{0,62}$/.test(field.key));
}

const normalizeFieldType = inferDslFieldType;

function pageFieldDef(field: FieldDef, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const meta = inferForeignKeyMeta(field.key);
  const base: Record<string, unknown> = {
    key: field.key,
    label: field.label,
    type: meta ? "select" : field.type,
    ...extra,
  };
  if (!meta) return base;
  return {
    ...base,
    displayKey: meta.displayKey,
    optionSource: {
      pageCode: meta.pageCode,
      apiCode: meta.apiCode,
      valueField: meta.valueField,
      labelField: meta.labelField,
    },
  };
}

function apiFieldDef(field: FieldDef): Record<string, unknown> {
  return { field: field.key };
}

function importFieldDef(field: FieldDef): Record<string, unknown> {
  const meta = inferForeignKeyMeta(field.key);
  const base: Record<string, unknown> = {
    key: field.key,
    label: meta ? field.label.replace(/ID$/i, "").replace(/编号$/, "") || meta.displayKey.replace(/_name$/, "") : field.label,
    type: meta ? "select" : field.type,
    required: field.required,
  };
  if (!meta) return base;
  return {
    ...base,
    optionSource: {
      pageCode: meta.pageCode,
      apiCode: meta.apiCode,
      valueField: meta.valueField,
      labelField: meta.labelField,
      pageSize: 500,
    },
  };
}

function addExtFieldToPage(args: Record<string, unknown>, intent: IntentResult): DslDiff[] {
  const targetCode = pageCode(args, intent);
  if (!targetCode) return [];
  return fields(args).flatMap((field) => [
    {
      targetType: "page_dsl",
      targetCode,
      op: "add_column",
      field: field.key,
      fieldDef: pageFieldDef(field, { width: field.type === "textarea" ? 220 : 140 }),
    },
    {
      targetType: "page_dsl",
      targetCode,
      op: "add_modal_field",
      field: field.key,
      fieldDef: pageFieldDef(field, { required: field.required }),
    },
  ] as DslDiff[]);
}

function addPhysicalFilterField(args: Record<string, unknown>, intent: IntentResult, policy: TenantAgentPolicy): DslDiff[] {
  const targetCode = pageCode(args, intent);
  const tableName = String(args.tableName ?? targetCode.replace(/_list$/, ""));
  const fs = fields(args).slice(0, policy.fieldPolicy.maxPhysicalFieldsPerRequest);
  if (!targetCode || !tableName || fs.length === 0) return [];
  return [
    {
      targetType: "db_schema",
      targetCode: tableName,
      op: "add_field",
      resourceDef: { tableName, fields: fs },
    },
    ...fs.flatMap((field) => [
      {
        targetType: "page_dsl",
        targetCode,
        op: "add_column",
        field: field.key,
        fieldDef: pageFieldDef(field, { width: 140 }),
      },
      {
        targetType: "page_dsl",
        targetCode,
        op: "add_filter",
        field: field.key,
        fieldDef: pageFieldDef(field, { placeholder: `请输入${field.label}` }),
      },
      {
        targetType: "page_dsl",
        targetCode,
        op: "add_modal_field",
        field: field.key,
        fieldDef: pageFieldDef(field, { required: field.required }),
      },
      {
        targetType: "api_dsl",
        targetCode: `${targetCode}.query`,
        op: "add_allowed_field",
        field: field.key,
        fieldDef: apiFieldDef(field),
      },
    ] as DslDiff[]),
  ];
}

function createImportFlow(args: Record<string, unknown>, intent: IntentResult, policy: TenantAgentPolicy): DslDiff[] {
  if (!policy.dataPolicy.allowImport) return [];
  const targetCode = pageCode(args, intent);
  const importCode = String(args.importCode ?? `${targetCode}.import`);
  const importFields = fields(args)
    .filter((field) => !SYSTEM_FIELD_KEYS.has(field.key))
    .map(importFieldDef);
  if (!targetCode || importFields.length === 0) return [];
  return [{
    targetType: "import_dsl",
    targetCode: importCode,
    op: "create_import",
    resourceDef: {
      pageCode: targetCode,
      apiCode: args.apiCode ?? `${targetCode}.create`,
      fields: importFields,
      duplicateStrategy: policy.dataPolicy.allowOverwrite ? (args.duplicateStrategy ?? "upsert") : "insert",
    },
  }];
}

function createReportPage(args: Record<string, unknown>, intent: IntentResult): DslDiff[] {
  const targetCode = String(args.pageCode ?? `${intent.featureCode || "custom"}_report`);
  const sourceTable = String(args.sourceTable ?? intent.featureCode.replace(/_list$/, ""));
  if (!targetCode || !sourceTable) return [];
  return [{
    targetType: "report_dsl",
    targetCode,
    op: "create_report",
    resourceDef: {
      pageCode: targetCode,
      featureCode: args.featureCode ?? targetCode,
      moduleCode: args.moduleCode ?? intent.moduleCode ?? "report",
      title: args.title ?? "定制报表",
      sourceTable,
      dimensions: Array.isArray(args.dimensions) ? args.dimensions : [],
      metrics: Array.isArray(args.metrics) ? args.metrics : [],
      filters: Array.isArray(args.filters) ? args.filters : undefined,
      rank: args.rank ?? args.ranking,
      sort: args.sort,
      chartType: args.chartType ?? "table",
    },
  }];
}

function addFollowupWorkflow(args: Record<string, unknown>, intent: IntentResult): DslDiff[] {
  const targetCode = pageCode(args, intent) || "lead_list";
  const actionCode = String(args.actionCode ?? `${targetCode}.followup`);
  const label = String(args.label ?? "新增跟进");
  return [{
    targetType: "page_dsl",
    targetCode,
    op: "add_row_action",
    fieldDef: {
      actionCode,
      label,
      type: "open_modal",
      apiCode: "student_followup_list.create",
      mapRowToValue: { student_id: "id" },
      defaultValues: {
        follow_type: args.defaultFollowType ?? "PHONE",
      },
      fields: [
        pageFieldDef({ key: "student_id", label: "学员", type: "select", required: true }),
        {
          key: "follow_type",
          label: "跟进方式",
          type: "select",
          required: true,
          options: [
            { label: "电话", value: "PHONE" },
            { label: "到访", value: "VISIT" },
            { label: "微信", value: "WECHAT" },
          ],
        },
        { key: "follow_content", label: "跟进内容", type: "textarea", required: true, span: "full", rows: 4 },
        { key: "next_follow_time", label: "下次跟进时间", type: "datetime" },
      ],
    },
  }];
}

function addCourseSchedulingWorkflow(args: Record<string, unknown>, intent: IntentResult): DslDiff[] {
  const targetCode = pageCode(args, intent) || "course_list";
  const actionCode = String(args.actionCode ?? `${targetCode}.create`);
  const label = String(args.label ?? "新增排课");
  return [{
    targetType: "page_dsl",
    targetCode,
    op: "add_toolbar",
    fieldDef: {
      actionCode,
      label,
      type: "open_modal",
      apiCode: "course_list.create",
      variant: "primary",
      modalTitle: "新增排课",
      defaultValues: {
        course_type: dictDefault("course_type", args.defaultCourseType ?? "ONE_ON_ONE_COURSE"),
        course_status: dictDefault("course_status", "SCHEDULED"),
        course_hour: args.defaultCourseHour ?? 1,
      },
      fields: [
        { key: "course_title", label: "课程名称", type: "text", required: true },
        { key: "course_type", label: "课程类型", type: "select", required: true },
        { key: "course_date", label: "上课日期", type: "date", required: true },
        { key: "start_time", label: "开始时间", type: "time", required: true },
        { key: "end_time", label: "结束时间", type: "time", required: true },
        { key: "course_hour", label: "课时", type: "number", required: true },
        pageFieldDef({ key: "teacher_id", label: "老师", type: "select", required: true }),
        pageFieldDef({ key: "study_manager_id", label: "学管", type: "select" }),
        pageFieldDef({ key: "organization_id", label: "校区", type: "select", required: true }),
        pageFieldDef({ key: "student_id", label: "学员", type: "select" }),
        pageFieldDef({ key: "contract_product_id", label: "合同产品", type: "select" }),
      ],
    },
  }];
}

function addChargeWorkflow(args: Record<string, unknown>, intent: IntentResult): DslDiff[] {
  const targetCode = pageCode(args, intent) || "course_list";
  const actionCode = String(args.actionCode ?? `${targetCode}.charge`);
  const label = String(args.label ?? "确认扣费");
  return [{
    targetType: "page_dsl",
    targetCode,
    op: "add_row_action",
    fieldDef: {
      actionCode,
      label,
      type: "open_modal",
      apiCode: "charge_record.create",
      visibleWhen: { course_status: dictDefault("course_status", "FINISHED") },
      mapRowToValue: {
        course_id: "id",
        organization_id: "organization_id",
        student_id: "student_id",
        contract_product_id: "contract_product_id",
      },
      defaultValues: {
        charge_type: dictDefault("charge_type", args.defaultChargeType ?? "NORMAL"),
        charge_hour: args.defaultChargeHour ?? 1,
      },
      fields: [
        pageFieldDef({ key: "course_id", label: "课程", type: "select", required: true }),
        pageFieldDef({ key: "student_id", label: "学员", type: "select", required: true }),
        pageFieldDef({ key: "contract_product_id", label: "合同产品", type: "select", required: true }),
        pageFieldDef({ key: "organization_id", label: "校区", type: "select", required: true }),
        {
          key: "charge_type",
          label: "扣费类型",
          type: "select",
          required: true,
          dictCode: "charge_type",
          optionSource: { type: "dictionary", apiCode: "dictionary.options", dictCode: "charge_type", valueField: "value", labelField: "label" },
        },
        { key: "charge_hour", label: "扣课时", type: "number", required: true },
        { key: "charge_amount", label: "扣费金额", type: "number", required: true },
      ],
    },
  }];
}

function addContractPaymentWorkflow(args: Record<string, unknown>, intent: IntentResult): DslDiff[] {
  const targetCode = pageCode(args, intent) || "contract_list";
  const actionCode = String(args.actionCode ?? `${targetCode}.funds`);
  const label = String(args.label ?? "合同收款");
  return [{
    targetType: "page_dsl",
    targetCode,
    op: "add_row_action",
    fieldDef: {
      actionCode,
      label,
      type: "open_modal",
      apiCode: "funds_history.create",
      visibleWhen: { contract_status: dictDefault("contract_status", "ACTIVE") },
      mapRowToValue: {
        contract_id: "id",
        student_id: "student_id",
        organization_id: "organization_id",
      },
      defaultValues: {
        funds_type: dictDefault("funds_type", args.defaultFundsType ?? "CONTRACT_PAY"),
      },
      fields: [
        pageFieldDef({ key: "contract_id", label: "合同", type: "select", required: true }),
        pageFieldDef({ key: "student_id", label: "学员", type: "select", required: true }),
        pageFieldDef({ key: "organization_id", label: "校区", type: "select", required: true }),
        { key: "transaction_amount", label: "收款金额", type: "number", required: true },
        pageFieldDef({ key: "pay_way_config_id", label: "支付方式", type: "select", required: true }),
        { key: "transaction_time", label: "收款时间", type: "datetime", required: true },
        { key: "funds_type", label: "收款类型", type: "select", required: true, dictCode: "funds_type", optionSource: { type: "dictionary", apiCode: "dictionary.options", dictCode: "funds_type", valueField: "value", labelField: "label" } },
      ],
    },
  }];
}

function addRefundWorkflow(args: Record<string, unknown>, intent: IntentResult): DslDiff[] {
  const targetCode = pageCode(args, intent) || "contract_product_list";
  const actionCode = String(args.actionCode ?? `${targetCode}.refund`);
  const label = String(args.label ?? "申请退费");
  return [{
    targetType: "page_dsl",
    targetCode,
    op: "add_row_action",
    fieldDef: {
      actionCode,
      label,
      type: "open_modal",
      apiCode: "refund_record.create",
      visibleWhen: { has_remaining_balance: true },
      mapRowToValue: {
        contract_product_id: "id",
        student_id: "student_id",
      },
      fields: [
        pageFieldDef({ key: "student_id", label: "学员", type: "select", required: true }),
        pageFieldDef({ key: "contract_product_id", label: "合同产品", type: "select", required: true }),
        { key: "refund_real_hour", label: "退课时", type: "number", required: true },
        { key: "refund_real_amount", label: "退金额", type: "number", required: true },
        { key: "refund_promotion_amount", label: "退优惠金额", type: "number" },
        { key: "refund_promotion_hour", label: "退赠课时", type: "number" },
        pageFieldDef({ key: "refund_way_config_id", label: "退费方式", type: "select", required: true }),
        { key: "refund_time", label: "退费时间", type: "datetime", required: true },
        { key: "remark", label: "备注", type: "textarea", span: "full", rows: 3 },
      ],
    },
  }];
}

function createCustomFeature(args: Record<string, unknown>, intent: IntentResult): DslDiff[] {
  const featureCode = String(args.featureCode ?? intent.featureCode ?? "").replace(/^skill_/, "");
  const baseCode = featureCode.replace(/_list$/, "");
  const tableName = String(args.tableName ?? args.table ?? baseCode);
  const pageCodeValue = String(args.pageCode ?? (featureCode.endsWith("_list") ? featureCode : `${featureCode}_list`));
  const fs = ensureOrganizationField(fields(args));
  if (!tableName || !featureCode || !pageCodeValue || fs.length === 0) return [];
  const title = String(args.title ?? args.featureName ?? args.tableLabel ?? featureCode);
  return [{
    targetType: "db_schema",
    targetCode: tableName,
    op: "create_table",
    resourceDef: {
      tableName,
      tableLabel: title,
      pageCode: pageCodeValue,
      featureCode,
      moduleCode: args.moduleCode ?? moduleCodeFromName(String(args.moduleName ?? args.module ?? "")),
      pageTitle: title,
      fields: fs,
      softDelete: true,
      extJson: true,
    },
  }];
}

function moduleCodeFromName(moduleName: string) {
  if (moduleName.includes("招生")) return "lead";
  if (moduleName.includes("学员")) return "student";
  if (moduleName.includes("教务") || moduleName.includes("课程")) return "academic";
  if (moduleName.includes("财务")) return "finance";
  if (moduleName.includes("报表")) return "report";
  return "custom";
}

function ensureOrganizationField(fs: FieldDef[]): FieldDef[] {
  if (fs.some((field) => field.key === "organization_id")) return fs;
  return [{ key: "organization_id", label: "校区", type: "select", required: true }, ...fs];
}

function modifyPermissionPolicy(args: Record<string, unknown>, intent: IntentResult): DslDiff[] {
  const roleCode = String(args.roleCode ?? args.role_code ?? "").toUpperCase();
  const targetCode = pageCode(args, intent);
  if (!roleCode || !targetCode) return [];
  const resourceDef: Record<string, unknown> = {
    roleCode,
    pageCode: targetCode,
    pagePermission: args.pagePermission ?? args.page_permission ?? "read",
  };
  const buttonPermission = args.buttonPermission ?? args.button_permission;
  if (Array.isArray(buttonPermission)) resourceDef.buttonPermission = buttonPermission.map(String);
  const dataPermission = args.dataPermission ?? args.data_permission;
  if (dataPermission) resourceDef.dataPermission = String(dataPermission);
  const fieldPermission = args.fieldPermission ?? args.field_permission;
  if (fieldPermission && typeof fieldPermission === "object" && !Array.isArray(fieldPermission)) {
    resourceDef.fieldPermission = fieldPermission;
  }
  return [{
    targetType: "permission_policy",
    targetCode: `${roleCode}.${targetCode}`,
    op: "modify_permission",
    resourceDef,
  }];
}

function createApprovalFlow(args: Record<string, unknown>, intent: IntentResult): DslDiff[] {
  const targetCode = String(args.flowCode ?? args.approvalCode ?? `${pageCode(args, intent) || intent.featureCode}_approval`);
  const businessType = String(args.businessType ?? args.pageCode ?? pageCode(args, intent) ?? intent.featureCode);
  if (!targetCode || !businessType) return [];
  const steps = Array.isArray(args.steps) ? args.steps : [
    { stepCode: "submit", stepName: "提交", assigneeRole: "APPLICANT" },
    { stepCode: "principal_review", stepName: "校长审批", assigneeRole: "PRINCIPAL" },
  ];
  return [{
    targetType: "approval_flow",
    targetCode,
    op: "create_approval_flow",
    resourceDef: {
      flowCode: targetCode,
      flowName: args.flowName ?? args.name ?? "审批流",
      moduleCode: args.moduleCode ?? intent.moduleCode ?? "custom",
      businessType,
      trigger: args.trigger ?? { event: "submit" },
      steps,
      status: "ACTIVE",
    },
  }];
}

function addExportAction(args: Record<string, unknown>, intent: IntentResult): DslDiff[] {
  const targetCode = pageCode(args, intent);
  if (!targetCode) return [];
  const actionCode = String(args.actionCode ?? `${targetCode}.export`);
  return [{
    targetType: "page_dsl",
    targetCode,
    op: "add_toolbar",
    fieldDef: {
      actionCode,
      label: args.label ?? "导出",
      type: "export",
      actionType: "export",
      apiCode: args.apiCode ?? `${targetCode}.query`,
      exportConfig: {
        fileName: args.fileName ?? args.exportName ?? `${targetCode}_export`,
        columns: Array.isArray(args.columns) ? args.columns : undefined,
        includeCurrentFilters: args.includeCurrentFilters !== false,
      },
    },
  }];
}

function createPrintTemplate(args: Record<string, unknown>, intent: IntentResult): DslDiff[] {
  const targetCode = String(args.templateCode ?? args.printCode ?? `${pageCode(args, intent) || intent.featureCode}_print`);
  const page = pageCode(args, intent);
  if (!targetCode || !page) return [];
  return [{
    targetType: "print_template",
    targetCode,
    op: "create_print_template",
    resourceDef: {
      templateCode: targetCode,
      templateName: args.templateName ?? args.name ?? "打印模板",
      pageCode: page,
      moduleCode: args.moduleCode ?? intent.moduleCode ?? "custom",
      paperSize: args.paperSize ?? "A4",
      orientation: args.orientation ?? "portrait",
      fields: Array.isArray(args.fields) ? args.fields : [],
      layout: args.layout ?? { sections: [] },
    },
  }, {
    targetType: "page_dsl",
    targetCode: page,
    op: "add_row_action",
    fieldDef: {
      actionCode: String(args.actionCode ?? `${page}.print`),
      label: args.label ?? "打印",
      type: "display",
      actionType: "display",
      printTemplateCode: targetCode,
    },
  }];
}

function createBusinessEventListener(args: Record<string, unknown>, intent: IntentResult): DslDiff[] {
  const event = String(args.triggerEvent ?? args.event ?? args.businessEvent ?? "").trim();
  const inferredCode = event
    ? `${event.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase()}_listener_rule`
    : `${pageCode(args, intent) || intent.featureCode}_listener_rule`;
  const targetCode = String(args.ruleCode ?? inferredCode);
  if (!targetCode) return [];
  const listenerList = Array.isArray(args.listeners)
    ? args.listeners
    : Array.isArray(args.actions)
      ? args.actions
      : [];
  return [{
    targetType: "business_rule",
    targetCode,
    op: "create_business_rule",
    resourceDef: {
      ruleCode: targetCode,
      ruleName: args.ruleName ?? args.name ?? "业务事件监听规则",
      moduleCode: args.moduleCode ?? intent.moduleCode ?? moduleCodeForBusinessType(String(args.businessType ?? inferBusinessType("workflow", intent.featureCode, JSON.stringify(args).toLowerCase()))),
      featureCode: args.featureCode ?? intent.featureCode,
      category: "workflow",
      businessType: args.businessType ?? inferBusinessType("workflow", intent.featureCode, JSON.stringify(args).toLowerCase()),
      triggerEvent: event || String(args.trigger ?? ""),
      trigger: typeof args.trigger === "object" && args.trigger !== null && !Array.isArray(args.trigger) ? args.trigger : { event: event || args.trigger },
      listeners: listenerList,
      conditions: Array.isArray(args.conditions) ? args.conditions : [],
      listenerMode: args.listenerMode ?? "after_commit",
      failurePolicy: args.failurePolicy ?? "record_and_continue",
      remark: args.remark ?? "由 AI 定制生成的业务事件监听规则",
    },
  }];
}

function createBusinessRule(args: Record<string, unknown>, intent: IntentResult): DslDiff[] {
  const nestedRule = args.rule && typeof args.rule === "object" && !Array.isArray(args.rule) ? args.rule as Record<string, unknown> : {};
  const targetCode = String(args.ruleCode ?? nestedRule.ruleCode ?? codeFromName(args.ruleName ?? args.name) ?? `${pageCode(args, intent) || intent.featureCode}_rule`);
  if (!targetCode) return [];
  const rule = normalizeBusinessRuleResource(targetCode, args, intent);
  return [{
    targetType: "business_rule",
    targetCode,
    op: "create_business_rule",
    resourceDef: rule,
  }];
}

function codeFromName(value: unknown) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (text.includes("班课") && text.includes("业绩")) return "performance_class_course_priority_rule";
  if ((text.includes("一对一") || text.includes("1对1")) && text.includes("业绩")) return "performance_one_to_one_priority_rule";
  if (text.includes("排课") && text.includes("冲突")) return "course_time_validation_rule";
  if (text.includes("资金")) return "money_allocation_rule";
  if (text.includes("优惠")) return "promotion_allocation_rule";
  return "";
}

function normalizeBusinessRuleResource(targetCode: string, args: Record<string, unknown>, intent: IntentResult) {
  const text = JSON.stringify(args).toLowerCase();
  const category = String(args.category ?? inferRuleCategory(text, intent.featureCode));
  const businessType = String(args.businessType ?? args.business_type ?? inferBusinessType(category, intent.featureCode, text));
  const base: Record<string, unknown> = {
    ruleCode: targetCode,
    ruleName: args.ruleName ?? args.name ?? defaultRuleName(category),
    moduleCode: args.moduleCode ?? intent.moduleCode ?? moduleCodeForBusinessType(businessType),
    featureCode: args.featureCode ?? intent.featureCode,
    category,
    businessType,
  };
  const existingRule = args.rule && typeof args.rule === "object" && !Array.isArray(args.rule) ? args.rule as Record<string, unknown> : {};
  Object.assign(base, existingRule);

  if (category === "validation" && businessType === "course") {
    return {
      ...base,
      targetApi: args.targetApi ?? args.apiCode ?? "course_list.create",
      preventTeacherTimeConflict: true,
      preventStudentTimeConflict: true,
      preventInvalidTimeRange: true,
      validations: [
        { field: "end_time", operator: ">", valueField: "start_time", message: "结束时间必须晚于开始时间" },
        { field: "teacher_id", operator: "no_time_overlap", valueField: "teacher_course_date,start_time,end_time", message: "同一老师同一天同一时间段不能重复排课" },
        { field: "student_id", operator: "no_time_overlap", valueField: "student_course_date,start_time,end_time", message: "同一学员同一天同一时间段不能重复排课" },
      ],
    };
  }
  if (category === "performance_allocation") {
    const priority = text.includes("班课") ? "classCourseFirst" : text.includes("一对一") || text.includes("1对1") ? "oneToOneFirst" : String(args.productPriority ?? "none");
    return {
      ...base,
      performanceAllocation: priority === "none" ? String(args.performanceAllocation ?? "byCpPaidRatio") : priority,
      organizationPerformanceOwner: args.organizationPerformanceOwner ?? "contractOrganization",
      personalPerformanceOwner: args.personalPerformanceOwner ?? "signStaff",
      productPriority: priority,
      oneToOneWeight: priority === "oneToOneFirst" ? 100 : args.oneToOneWeight,
      classCourseWeight: priority === "classCourseFirst" ? 100 : args.classCourseWeight,
      includePromotionAmount: args.includePromotionAmount ?? false,
      includeRefundDeduction: args.includeRefundDeduction ?? true,
      allowManualAdjust: args.allowManualAdjust ?? false,
      generateLogTable: "performance_arrange_log",
    };
  }
  if (category === "funds_allocation") {
    return {
      ...base,
      fundsAllocation: args.fundsAllocation ?? "byCpRemainingAmount",
      splitBy: args.splitBy ?? "contract_product",
      updateContractPaidStatus: args.updateContractPaidStatus ?? true,
      allowPreStoreWithoutContract: args.allowPreStoreWithoutContract ?? true,
      allowManualAdjust: args.allowManualAdjust ?? false,
      generateLogTable: "money_arrange_log",
      validations: Array.isArray(args.validations) ? args.validations : [{ field: "transaction_amount", operator: ">", value: 0, message: "收款金额必须大于 0" }],
    };
  }
  if (category === "promotion_allocation") {
    const allocation = text.includes("班课") ? "classCourseFirst" : text.includes("一对一") || text.includes("1对1") ? "oneToOneFirst" : args.promotionAllocation ?? "byCpAmountRatio";
    return {
      ...base,
      promotionAllocation: allocation,
      splitBy: args.splitBy ?? "contract_product",
      requireAtLeastOneProduct: args.requireAtLeastOneProduct ?? true,
      snapshotPromotion: args.snapshotPromotion ?? true,
      allowManualAdjust: args.allowManualAdjust ?? false,
      generateLogTable: "promotion_arrange_log",
    };
  }
  if (category === "workflow") {
    return {
      ...base,
      trigger: args.trigger,
      actions: Array.isArray(args.actions) ? args.actions : [],
    };
  }
  return {
    ...base,
    targetApi: args.targetApi ?? args.apiCode,
    targetAction: args.targetAction ?? args.actionCode,
    validations: Array.isArray(args.validations) ? args.validations : undefined,
    severity: args.severity ?? "error",
  };
}

function inferRuleCategory(text: string, featureCode: string) {
  if (/业绩/.test(text)) return "performance_allocation";
  if (/资金|收款|预存/.test(text)) return "funds_allocation";
  if (/优惠|折扣/.test(text)) return "promotion_allocation";
  if (/审批/.test(text)) return "approval_trigger";
  if (/退费/.test(text)) return "refund";
  if (/扣费|课消/.test(text)) return "charge";
  if (/考勤|签到/.test(text)) return "attendance";
  if (/监听|触发|流转|事件|workflow|event/.test(text)) return "workflow";
  if (/course|排课|冲突/.test(`${text} ${featureCode}`)) return "validation";
  return "validation";
}

function inferBusinessType(category: string, featureCode: string, text: string) {
  if (category === "performance_allocation") return "performance";
  if (category === "funds_allocation") return "funds_create";
  if (category === "promotion_allocation") return "contract_create";
  if (category === "refund") return text.includes("合同") ? "contract_refund" : "refund_create";
  if (category === "charge") return "charge";
  if (category === "attendance") return "attendance";
  if (category === "approval_trigger" && text.includes("产品")) return "product_price";
  if (category === "workflow" && /删除排课|删除课程/.test(text)) return "course_delete";
  if (category === "workflow" && /停课|取消课程|顺延课程/.test(text)) return "holiday_course_impact";
  if (/course|排课/.test(`${featureCode} ${text}`)) return "course_create";
  return "contract_create";
}

function defaultRuleName(category: string) {
  const label = SYSTEM_DICTIONARIES.business_rule_category?.[category]?.label;
  return label ? `${label}规则` : "业务规则";
}

function moduleCodeForBusinessType(businessType: string) {
  if (["funds_create", "refund_create", "contract_refund", "product_price", "performance", "performance_adjust", "contract_create", "contract_update"].includes(businessType)) return "finance";
  if (["course_create", "course_delete", "holiday_course_impact", "attendance", "charge", "charge_reverse", "leave", "makeup"].includes(businessType)) return "education";
  return "finance";
}
