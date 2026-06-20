import { executeDiffs } from "./diff-executor.js";
import { parsePlanDiffsFromToolArguments } from "./dsl-diff-parser.js";
import { executeDomainToolPlanning } from "./domain-tools.js";
import { formatHarnessImpactMessage, summarizeHarnessImpact } from "./impact-summarizer.js";
import { evaluateHarnessRisk } from "./risk-evaluator.js";
import { executeRequirementPlanning } from "./steps/requirement-planning.step.js";
import {
  executeValidationRepair,
  findApiFieldConflictErrors,
  findModifiedApiDuplicateErrors,
  findModifiedPageDuplicateErrors,
  findPageActionConflictErrors,
  findPageFieldConflictErrors,
  buildRepairUserPrompt,
} from "./steps/validation-repair.step.js";
import { extractSkillMdMetadata, formatSkillSummaryFromMd, hasStandardSkillMdMetadata } from "./skill-md.service.js";
import { summarizeActionDsl, summarizeApiDsl, summarizePageDsl } from "./steps/context-injection.step.js";
import { defaultTenantAgentPolicy } from "./tenant-policy.service.js";
import type { DslDiff } from "./types.js";
import { validateEduDomainGuardrails } from "./validators/edu-domain.validator.js";

type TestCase = {
  name: string;
  run: () => void | Promise<void>;
};

const policy = defaultTenantAgentPolicy();
const emptyContext = { skillMdContent: "", tableColumns: {}, relevantDslCodes: ["contract_list"], dslSummary: { pages: [], apis: [], actions: [] }, tokenEstimate: 0 };

const tests: TestCase[] = [
  {
    name: "parses tool call diffs when model returns a JSON string",
    run: () => {
      const diffs = parsePlanDiffsFromToolArguments(JSON.stringify({
        diffs: JSON.stringify([
          {
            targetType: "report_dsl",
            targetCode: "performance_ranking_report",
            op: "create_report",
            resourceDef: { sourceTable: "performance_arrange_log" },
          },
        ]),
      }));
      expectEqual(diffs.length, 1, "expected one parsed diff");
      expectEqual(diffs[0]?.targetType, "report_dsl", "unexpected target type");
      expectEqual(diffs[0]?.resourceDef?.sourceTable, "performance_arrange_log", "unexpected source table");
    },
  },
  {
    name: "injects problematic diffs and skill context into repair prompt",
    run: () => {
      const prompt = buildRepairUserPrompt(
        ["报表字段不存在: employee.performance_amount"],
        "新增业绩报表",
        JSON.stringify({
          PROBLEMATIC_DIFFS: [{ targetType: "report_dsl", targetCode: "performance_report", op: "create_report" }],
          SKILL_MD_CONTEXT: "## 标准元数据\n- 功能编码: funds_history\n- 功能名称: 收款流水",
          TABLE_COLUMNS: { funds_history: [{ column_name: "transaction_amount", data_type: "numeric" }] },
          DSL_SUMMARY: { apis: [{ apiCode: "funds_history.query", table: "funds_history" }] },
        }),
      );
      expectEqual(prompt.includes("## 本次修正上下文"), true, "missing repair context heading");
      expectEqual(prompt.includes("PROBLEMATIC_DIFFS"), true, "missing problematic diffs");
      expectEqual(prompt.includes("SKILL_MD_CONTEXT"), true, "missing skill md context");
      expectEqual(prompt.includes("TABLE_COLUMNS"), true, "missing table columns");
      expectEqual(prompt.includes("DSL_SUMMARY"), true, "missing dsl summary");
    },
  },
  {
    name: "extracts standard skill metadata before falling back to text length",
    run: () => {
      const md = [
        "# 收款流水",
        "",
        "## 标准元数据",
        "- 功能编码: funds_history",
        "- 功能名称: 收款流水",
        "- 功能描述: 记录合同收款、补缴和支付方式。",
        "- 主数据表: funds_history",
        "",
        "## 页面结构 (page_dsl)",
        "很长的页面结构不应该成为摘要开头",
      ].join("\n");
      const metadata = extractSkillMdMetadata(md);
      expectEqual(metadata.featureCode, "funds_history", "unexpected feature code");
      expectEqual(metadata.featureName, "收款流水", "unexpected feature name");
      expectEqual(metadata.featureDescription, "记录合同收款、补缴和支付方式。", "unexpected feature description");
      expectEqual(metadata.primaryTable, "funds_history", "unexpected primary table");
      expectEqual(hasStandardSkillMdMetadata(md), true, "expected standard metadata");
      const summary = formatSkillSummaryFromMd({ skillCode: "skill_funds_history", skillName: "旧名称", content: md });
      expectEqual(summary.includes("功能编码：funds_history"), true, "summary should include parsed feature code");
      expectEqual(summary.includes("功能描述：记录合同收款、补缴和支付方式。"), true, "summary should include parsed description");
      expectEqual(summary.includes("页面结构"), false, "summary should not use raw leading section text");
    },
  },
  {
    name: "detects conflicts with existing api fields before preview",
    run: () => {
      const existing = emptyApi({
        allowedFields: ["phone"],
        filters: ["student_status"],
        selectFields: ["name"],
        selectAliases: ["student_name"],
      });
      expectIncludes(findApiFieldConflictErrors({
        targetType: "api_dsl",
        targetCode: "student_list.query",
        op: "add_allowed_field",
        fieldDef: { field: "phone" },
      }, existing), "API 字段已开放");
      expectIncludes(findApiFieldConflictErrors({
        targetType: "api_dsl",
        targetCode: "student_list.query",
        op: "add_filter",
        fieldDef: { field: "student_status" },
      }, existing), "API 筛选已存在");
      expectIncludes(findApiFieldConflictErrors({
        targetType: "api_dsl",
        targetCode: "student_list.query",
        op: "add_select_field",
        fieldDef: { field: "student_id", as: "student_name" },
      }, existing), "API 查询字段已存在");
    },
  },
  {
    name: "detects conflicts with existing page actions before preview",
    run: () => {
      const toolbarErrors = findPageActionConflictErrors({
        targetType: "page_dsl",
        targetCode: "course_list",
        op: "add_toolbar",
        fieldDef: { actionCode: "course_list.create", label: "新增排课" },
      }, emptyExisting({ toolbar: ["course_list.create"] }));
      expectIncludes(toolbarErrors, "工具栏按钮已存在");

      const rowActionErrors = findPageActionConflictErrors({
        targetType: "page_dsl",
        targetCode: "contract_list",
        op: "add_row_action",
        fieldDef: { actionCode: "contract_list.funds", label: "合同收款" },
      }, emptyExisting({ rowActions: ["contract_list.funds"] }));
      expectIncludes(rowActionErrors, "行操作已存在");
    },
  },
  {
    name: "detects conflicts with existing page fields before preview",
    run: () => {
      const existing = emptyExisting({
        columns: ["phone"],
        filters: ["student_status"],
        modalFields: ["remark"],
      });
      expectIncludes(findPageFieldConflictErrors({
        targetType: "page_dsl",
        targetCode: "student_list",
        op: "add_column",
        fieldDef: { key: "phone", label: "手机号" },
      }, existing), "列表列已存在");
      expectIncludes(findPageFieldConflictErrors({
        targetType: "page_dsl",
        targetCode: "student_list",
        op: "add_filter",
        fieldDef: { key: "student_status", label: "状态" },
      }, existing), "筛选条件已存在");
      expectIncludes(findPageFieldConflictErrors({
        targetType: "page_dsl",
        targetCode: "student_list",
        op: "add_modal_field",
        fieldDef: { key: "remark", label: "备注" },
      }, existing), "表单字段已存在");
    },
  },
  {
    name: "detects duplicate fields in full page and api replacements",
    run: () => {
      const pageErrors = findModifiedPageDuplicateErrors({
        targetType: "page_dsl",
        targetCode: "student_list",
        op: "modify",
        modifiedDslJson: {
          filters: [{ key: "student_status" }, { key: "student_status" }],
          table: { columns: [{ key: "name" }, { key: "name" }] },
          modal: { fields: [{ key: "phone" }, { key: "phone" }] },
        },
      });
      expectIncludes(pageErrors, "filters.student_status");
      expectIncludes(pageErrors, "table.columns.name");
      expectIncludes(pageErrors, "modal.fields.phone");

      const apiErrors = findModifiedApiDuplicateErrors({
        targetType: "api_dsl",
        targetCode: "student_list.query",
        op: "modify",
        modifiedDslJson: {
          allowedFields: ["name", "name"],
          filters: [{ field: "student_status" }, { field: "student_status" }],
          select: [
            { field: "student_id", as: "student_name" },
            { field: "student_id", as: "student_label" },
            { field: "name", as: "student_name" },
          ],
        },
      });
      expectIncludes(apiErrors, "allowedFields.name");
      expectIncludes(apiErrors, "filters.student_status");
      expectIncludes(apiErrors, "select.student_id");
      expectIncludes(apiErrors, "select.student_name");
    },
  },
  {
    name: "summarizes harness impact for tenant review",
    run: () => {
      const summary = summarizeHarnessImpact([
        {
          targetType: "page_dsl",
          targetCode: "contract_list",
          op: "add_row_action",
          fieldDef: {
            actionCode: "contract_list.funds",
            label: "合同收款",
            type: "open_modal",
            apiCode: "funds_history.create",
          },
        },
        {
          targetType: "report_dsl",
          targetCode: "tuition_arrears_report",
          op: "create_report",
          resourceDef: { title: "欠费统计", sourceTable: "contract", metrics: [] },
        },
      ]);
      expectIncludes(summary.businessActions, "合同收款入口");
      expectIncludes(summary.uiChanges, "contract_list 新增行操作 合同收款");
      expectIncludes(summary.dataChanges, "新增报表 欠费统计");
      expectIncludes(summary.reviewNotes, "资金或课时余额");
      expectEqual(formatHarnessImpactMessage(summary).includes("业务动作"), true, "missing impact message business section");
    },
  },
  {
    name: "creates custom feature from llm-selected tool defaults",
    run: async () => {
      const result = await executeDomainToolPlanning({
        userMessage: "新增一个到访记录功能，放在招生模块，记录校区、学员姓名、联系电话、到访时间、意向课程、跟进备注；需要列表、新增、编辑、详情和删除。",
        schemaName: "demo_school",
        intent: { featureCode: "lead_visit_record", action: "create", reason: "新增到访记录" },
        context: emptyContext,
        policy,
        selectTools: async () => [{
          toolName: "create_custom_feature",
          args: {
            featureCode: "lead_visit_record",
            featureName: "到访记录",
            moduleName: "招生",
            fields: [
              { key: "organization_id", label: "校区", type: "select", required: true },
              { key: "student_name", label: "学员姓名", type: "text", required: true },
              { key: "phone", label: "联系电话", type: "text", required: true },
              { key: "visit_time", label: "到访时间", type: "datetime", required: true },
              { key: "intended_course", label: "意向课程", type: "text" },
              { key: "remark", label: "跟进备注", type: "textarea" },
            ],
          },
        }],
      });
      expectEqual(result.error, undefined, `unexpected custom feature tool error: ${result.error}`);
      expectEqual(result.data.length, 1, "expected create_table diff");
      expectEqual(result.data[0]?.targetCode, "lead_visit_record", "unexpected inferred table name");
      expectEqual(result.data[0]?.resourceDef?.pageCode, "lead_visit_record_list", "unexpected inferred page code");
      expectEqual(result.data[0]?.resourceDef?.moduleCode, "lead", "unexpected inferred module code");

      const executed = await executeDiffs(result.data, "demo_school");
      const page = executed.find((item) => item.diff.targetType === "page_dsl" && item.diff.targetCode === "lead_visit_record_list")?.modifiedDslJson as Record<string, unknown> | undefined;
      if (!page) throw new Error("missing generated page dsl");
      const modal = isObject(page.modal) ? page.modal : {};
      const modalFields = Array.isArray(modal.fields) ? modal.fields as Array<Record<string, unknown>> : [];
      const organization = modalFields.find((field) => field.key === "organization_id");
      const visitTime = modalFields.find((field) => field.key === "visit_time");
      expectEqual(isObject(organization) ? organization.displayKey : undefined, "organization_name", "missing organization displayKey");
      expectEqual(isObject(visitTime) ? visitTime.type : undefined, "datetime", "unexpected visit time type");
    },
  },
  {
    name: "plans payment workflow from llm tool selection",
    run: async () => {
      const result = await executeDomainToolPlanning({
        userMessage: "给合同列表加收款按钮",
        schemaName: "demo_school",
        intent: { featureCode: "contract_list", action: "modify", reason: "合同收款" },
        context: emptyContext,
        policy,
        selectTools: async () => [{ toolName: "add_contract_payment_workflow", args: { pageCode: "contract_list" } }],
      });
      expectEqual(result.error, undefined, `unexpected domain tool error: ${result.error}`);
      expectEqual(result.data.length, 1, "expected one payment workflow diff");
      expectEqual(result.data[0]?.op, "add_row_action", "unexpected deterministic op");
      expectEqual(result.data[0]?.fieldDef?.apiCode, "funds_history.create", "unexpected payment api");
    },
  },
  {
    name: "plans approval flow export print rule and data permission tools",
    run: async () => {
      const result = await executeDomainToolPlanning({
        userMessage: "给合同列表增加审批流、导出、打印模板、数据权限和业务校验规则",
        schemaName: "demo_school",
        intent: { featureCode: "contract_list", action: "modify", reason: "合同定制" },
        context: emptyContext,
        policy,
        selectTools: async () => [
          {
            toolName: "create_approval_flow",
            args: {
              flowCode: "contract_discount_approval",
              flowName: "合同优惠审批",
              pageCode: "contract_list",
              businessType: "contract",
              steps: [
                { stepCode: "submit", stepName: "提交", assigneeRole: "SALES" },
                { stepCode: "principal_review", stepName: "校长审批", assigneeRole: "PRINCIPAL" },
              ],
            },
          },
          { toolName: "add_export_action", args: { pageCode: "contract_list", columns: ["contract_no", "student_id", "total_amount"] } },
          { toolName: "create_print_template", args: { pageCode: "contract_list", templateCode: "contract_receipt_print", templateName: "合同收据打印模板", fields: ["student_id", "total_amount"] } },
          { toolName: "modify_permission_policy", args: { pageCode: "contract_list", roleCode: "TEACHER", dataPermission: "own_students", fieldPermission: { total_amount: "hidden" } } },
          {
            toolName: "create_business_rule",
            args: {
              ruleCode: "contract_discount_rule",
              ruleName: "合同优惠校验规则",
              targetApi: "contract_list.create",
              validations: [{ field: "discount_amount", operator: "<=", value: "total_amount", message: "优惠金额不能大于合同金额" }],
            },
          },
        ],
      });
      expectEqual(result.error, undefined, `unexpected domain tool error: ${result.error}`);
      expectEqual(result.data.some((diff) => diff.targetType === "approval_flow" && diff.op === "create_approval_flow"), true, "missing approval flow diff");
      expectEqual(result.data.some((diff) => diff.targetType === "page_dsl" && diff.op === "add_toolbar" && diff.fieldDef?.type === "export"), true, "missing export toolbar diff");
      expectEqual(result.data.some((diff) => diff.targetType === "print_template" && diff.op === "create_print_template"), true, "missing print template diff");
      expectEqual(result.data.some((diff) => diff.targetType === "permission_policy" && diff.resourceDef?.dataPermission === "own_students"), true, "missing data permission diff");
      expectEqual(result.data.some((diff) => diff.targetType === "business_rule" && diff.op === "create_business_rule"), true, "missing business rule diff");

      const validation = await executeValidationRepair(
        result.data,
        { featureCode: "contract_list", action: "modify", reason: "合同定制" },
        emptyContext,
        "demo_school",
        "给合同列表增加审批流、导出、打印模板、数据权限和业务校验规则",
      );
      expectEqual(validation.error, undefined, `unexpected validation error: ${validation.error}`);

      const executed = await executeDiffs(result.data, "demo_school");
      const exportPage = executed.find((item) => item.diff.targetType === "page_dsl" && item.diff.targetCode === "contract_list" && item.diff.op === "add_toolbar")?.modifiedDslJson as Record<string, unknown> | undefined;
      const toolbar = Array.isArray(exportPage?.toolbar) ? exportPage.toolbar as Array<Record<string, unknown>> : [];
      const exportAction = toolbar.find((action) => action.actionCode === "contract_list.export");
      expectEqual(exportAction?.type, "export", "export toolbar should use export type");
      expectEqual(exportAction?.apiCode, "contract_list.query", "export toolbar should use query api");
      const print = executed.find((item) => item.diff.targetType === "print_template")?.modifiedDslJson as Record<string, unknown> | undefined;
      expectEqual(print?.templateCode, "contract_receipt_print", "unexpected print template code");
      const rule = executed.find((item) => item.diff.targetType === "business_rule")?.modifiedDslJson as Record<string, unknown> | undefined;
      expectEqual(rule?.ruleCode, "contract_discount_rule", "unexpected business rule code");
    },
  },
  {
    name: "recognizes standard workflow action requests without extra confirmation",
    run: async () => {
      const result = await executeRequirementPlanning(
        "给合同列表增加一个合同收款按钮",
        { featureCode: "contract_list", action: "modify", reason: "合同列表收款动作" },
        { skillMdContent: "", tableColumns: {}, relevantDslCodes: ["contract_list"], dslSummary: { pages: [], apis: [], actions: [] }, tokenEstimate: 0 },
        "demo_school",
        async () => ({
          summary: "识别到新增业务动作",
          capabilities: [{ type: "add_workflow_action", label: "新增业务动作", risk: "medium", requiresConfirmation: false, params: { actionFamily: "payment" } }],
          questions: [],
          canProceed: true,
        }),
      );
      expectEqual(result.data.canProceed, true, "expected workflow action request to proceed");
      expectEqual(result.data.capabilities.some((item) => item.type === "add_workflow_action"), true, "missing workflow action capability");
    },
  },
  {
    name: "normalizes requirement capability type from action family",
    run: async () => {
      const result = await executeRequirementPlanning(
        "新增收款排行报表，按校区统计收款金额，页面字段包含排名、校区、收款金额，并且有时间范围筛选。",
        { featureCode: "school_collection_ranking_report", action: "create", reason: "新增报表", relatedFeatureCodes: ["funds_history"] },
        emptyContext,
        "demo_school",
        async () => ({
          summary: "新增收款排行报表。",
          capabilities: [
            {
              label: "新增收款排行报表",
              risk: "medium",
              requiresConfirmation: false,
              params: { actionFamily: "add_report", sourceTable: "funds_history" },
            } as never,
          ],
          questions: [],
          canProceed: true,
        }),
      );
      expectEqual(result.data.canProceed, true, "expected report actionFamily capability to proceed");
      expectEqual(result.data.capabilities[0]?.type, "add_report", "expected add_report capability");
    },
  },
  {
    name: "does not block explicit new crud feature on defaultable field details",
    run: async () => {
      const result = await executeRequirementPlanning(
        "新增一个到访记录功能，放在招生模块，记录校区、学员姓名、联系电话、到访时间、意向课程、跟进备注；需要列表、新增、编辑、详情和删除。",
        { featureCode: "lead_visit_record_list", action: "create", reason: "新增 CRUD 功能" },
        emptyContext,
        "demo_school",
        async () => ({
          summary: "新建到访记录表和管理页面。",
          capabilities: [
            {
              type: "create_table",
              label: "新建数据表",
              risk: "low",
              requiresConfirmation: false,
              params: { tableName: "visit_records", fields: ["organization_id", "student_name", "phone", "visit_time", "intended_course", "follow_up_remarks"] },
            },
            {
              type: "add_workflow_action",
              label: "配置管理页面",
              risk: "low",
              requiresConfirmation: false,
              params: { pageType: "crud" },
            },
          ],
          questions: ["请确认意向课程是下拉选择现有课程，还是自由文本输入？"],
          canProceed: false,
        }),
      );
      expectEqual(result.data.canProceed, true, "expected explicit CRUD feature to proceed with defaults");
    },
  },
  {
    name: "lets specified payment report proceed without workflow confirmation",
    run: async () => {
      const result = await executeRequirementPlanning(
        "帮我在报表新增收款报表，统计每个校区的收款金额，按校区分组，页面字段有校区、金额",
        { featureCode: "payment_report", action: "create", reason: "新增收款统计报表" },
        emptyContext,
        "demo_school",
        async () => ({
          summary: "识别到新增报表/统计",
          capabilities: [{ type: "add_report", label: "新增报表/统计", risk: "medium", requiresConfirmation: false, params: {} }],
          questions: [],
          canProceed: true,
        }),
      );
      expectEqual(result.data.canProceed, true, `expected specified report to proceed, got questions: ${result.data.questions.join("; ")}`);
      expectEqual(result.data.capabilities.some((item) => item.type === "add_report"), true, "missing report capability");
      expectEqual(result.data.capabilities.some((item) => item.type === "add_field"), false, "report columns should not be treated as added data fields");
      expectEqual(result.data.capabilities.some((item) => item.type === "add_workflow_action"), false, "payment report should not be treated as workflow action");
    },
  },
  {
    name: "treats follow-up report answer as confirmation",
    run: async () => {
      const result = await executeRequirementPlanning(
        "请基于以下多轮对话理解完整需求，最后一条用户消息是对前文需求的补充或确认，不要丢失前文目标。\n\n## 历史对话\n用户：帮我在报表新增收款报表，统计每个校区的收款金额，按校区分组，页面字段有校区、金额\n助手：为了避免生成错误配置，请先确认报表口径：统计维度、指标、时间范围和是否需要图表展示。\n\n## 当前用户消息\n统计维度是校区，指标含校区和金额，时间范围由筛选觉得，不需要图标展示",
        { featureCode: "payment_report", action: "create", reason: "新增收款统计报表" },
        emptyContext,
        "demo_school",
        async () => ({
          summary: "识别到已确认的新增报表/统计",
          capabilities: [{ type: "add_report", label: "新增报表/统计", risk: "medium", requiresConfirmation: false, params: {} }],
          questions: [],
          canProceed: true,
        }),
      );
      expectEqual(result.data.canProceed, true, `expected confirmed report to proceed, got questions: ${result.data.questions.join("; ")}`);
      expectEqual(result.data.capabilities.some((item) => item.type === "add_workflow_action"), false, "confirmed payment report should not be treated as workflow action");
    },
  },
  {
    name: "does not guess capabilities when requirement llm fails",
    run: async () => {
      const result = await executeRequirementPlanning(
        "帮我改一下",
        { featureCode: "student_list", action: "modify", reason: "用户表达不完整" },
        emptyContext,
        "demo_school",
        async () => {
          throw new Error("llm unavailable");
        },
      );
      expectEqual(result.data.canProceed, false, "expected failed requirement planning to stop");
      expectEqual(result.data.capabilities.length, 0, "expected no guessed capabilities");
      expectEqual(result.data.questions.join("; ").includes("请补充"), true, "expected supplement question");
    },
  },
  {
    name: "does not block confirmed requirement because context is large",
    run: async () => {
      const result = await executeRequirementPlanning(
        "不是修改页面，是新增一个报表统计页面",
        { featureCode: "collection_report", action: "create", reason: "新增收款统计报表", relatedFeatureCodes: ["funds_history"] },
        { ...emptyContext, tokenEstimate: 5000 },
        "demo_school",
        async () => ({
          summary: "新增一个按校区分组的收款金额统计报表。",
          capabilities: [{ type: "add_report", label: "新增报表/统计", risk: "medium", requiresConfirmation: false, params: {} }],
          questions: [],
          canProceed: true,
        }),
      );
      expectEqual(result.data.canProceed, true, `expected large confirmed context to proceed, got questions: ${result.data.questions.join("; ")}`);
      expectEqual(result.data.questions.length, 0, "expected no context-size confirmation question");
    },
  },
  {
    name: "summarizes DSL context for prompt injection",
    run: () => {
      const page = summarizePageDsl("student_list", {
        title: "学员管理",
        filters: [{ key: "name" }, { key: "phone" }],
        table: {
          columns: [{ key: "name" }, { key: "organization_id" }],
          rowActions: [{ actionCode: "student_list.followup" }],
        },
        toolbar: [{ actionCode: "student_list.import" }],
      }, "学员列表");
      expectEqual(page.pageName, "学员列表", "unexpected page name");
      expectIncludes(page.filters, "phone");
      expectIncludes(page.columns, "organization_id");
      expectIncludes(page.toolbarActions, "student_list.import");
      expectIncludes(page.rowActions, "student_list.followup");

      const api = summarizeApiDsl("student_list.query", {
        operation: "query",
        table: "student",
        select: [{ field: "id" }, { field: "name" }],
        allowedFields: ["name", "phone"],
        where: [{ field: "deleted" }],
        joins: [{ table: "organization" }],
        sorts: [{ field: "created_at" }],
      });
      expectEqual(api.table, "student", "unexpected api table");
      expectIncludes(api.selectFields, "name");
      expectIncludes(api.allowedFields, "phone");
      expectIncludes(api.filters, "deleted");
      expectIncludes(api.joins, "organization");
      expectIncludes(api.sorts, "created_at");

      const action = summarizeActionDsl("student_list.create", {
        type: "open_modal",
        apiCode: "student_list.create",
        modal: { code: "student_create_modal", fields: [{ key: "name" }, { key: "phone" }] },
      });
      expectEqual(action.actionType, "open_modal", "unexpected action type");
      expectEqual(action.modalCode, "student_create_modal", "unexpected modal code");
      expectIncludes(action.fields, "phone");
    },
  },
  {
    name: "blocks phone fields modeled as number",
    run: () => {
      const errors = validateEduDomainGuardrails([
        {
          targetType: "page_dsl",
          targetCode: "student_list",
          op: "add_column",
          field: "parent_phone",
          fieldDef: { key: "parent_phone", label: "家长手机号", type: "number" },
        },
      ], policy);
      expectIncludes(errors, "手机/电话字段必须使用 text/tel");
    },
  },
  {
    name: "blocks import system fields and overwrite when tenant policy disallows it",
    run: () => {
      const errors = validateEduDomainGuardrails([
        {
          targetType: "import_dsl",
          targetCode: "student_list.import",
          op: "create_import",
          resourceDef: {
            pageCode: "student_list",
            fields: [{ key: "id", label: "ID" }],
            duplicateStrategy: "upsert",
          },
        },
      ], policy);
      expectIncludes(errors, "不能要求租户填写系统字段 id");
      expectIncludes(errors, "租户策略不允许覆盖导入");
    },
  },
  {
    name: "blocks unsafe import foreign keys and non-create api",
    run: () => {
      const errors = validateEduDomainGuardrails([
        {
          targetType: "import_dsl",
          targetCode: "student_list.import",
          op: "create_import",
          resourceDef: {
            pageCode: "student_list",
            apiCode: "student_list.query",
            fields: [
              { key: "student_id", label: "学员ID" },
              { key: "student_id", label: "学员ID" },
            ],
            duplicateStrategy: "insert",
          },
        },
      ], policy);
      expectIncludes(errors, "apiCode 必须指向 create 接口");
      expectIncludes(errors, "重复字段 key: student_id");
      expectIncludes(errors, "外键字段 student_id 必须配置 optionSource");
      expectIncludes(errors, "模板列名应使用业务名称");
    },
  },
  {
    name: "allows import fields with name based foreign key resolution",
    run: () => {
      const errors = validateEduDomainGuardrails([
        {
          targetType: "import_dsl",
          targetCode: "student_followup_list.import",
          op: "create_import",
          resourceDef: {
            pageCode: "student_followup_list",
            apiCode: "student_followup_list.create",
            fields: [
              {
                key: "student_id",
                label: "学员",
                optionSource: { apiCode: "student_list.query", labelField: "name", valueField: "id" },
              },
              { key: "follow_type", label: "跟进方式", options: [{ label: "电话", value: "PHONE" }] },
              { key: "follow_content", label: "跟进内容" },
            ],
            duplicateStrategy: "insert",
          },
        },
      ], policy);
      expectEqual(errors.length, 0, `expected no import errors, got ${errors.join("; ")}`);
    },
  },
  {
    name: "blocks unsafe report dimensions and metric aggregation",
    run: () => {
      const errors = validateEduDomainGuardrails([
        {
          targetType: "report_dsl",
          targetCode: "bad_report",
          op: "create_report",
          resourceDef: {
            pageCode: "bad_report",
            sourceTable: "student;drop",
            dimensions: ["organization_id", "学生"],
            metrics: [{ field: "paid amount", type: "median", as: "bad-alias" }],
          },
        },
      ], policy);
      expectIncludes(errors, "sourceTable 不合法");
      expectIncludes(errors, "维度字段不合法");
      expectIncludes(errors, "指标字段不合法");
      expectIncludes(errors, "使用了不支持的聚合类型 median");
    },
  },
  {
    name: "requires tenant scope for sensitive edu reports and query APIs",
    run: () => {
      const errors = validateEduDomainGuardrails([
        {
          targetType: "report_dsl",
          targetCode: "unsafe_student_report",
          op: "create_report",
          resourceDef: {
            pageCode: "unsafe_student_report",
            sourceTable: "student",
            dimensions: ["student_status"],
            metrics: [{ field: "id", type: "count", as: "student_count" }],
          },
        },
        {
          targetType: "api_dsl",
          targetCode: "student_export.query",
          op: "modify",
          modifiedDslJson: {
            operation: "query",
            table: "student",
            select: [{ field: "id" }, { field: "name" }],
          },
        },
      ], policy);
      expectIncludes(errors, "报表 unsafe_student_report 基于租户业务表 student");
      expectIncludes(errors, "API student_export.query 查询租户业务表 student");
    },
  },
  {
    name: "allows tenant scoped edu reports and query APIs",
    run: () => {
      const errors = validateEduDomainGuardrails([
        {
          targetType: "report_dsl",
          targetCode: "student_by_org_report",
          op: "create_report",
          resourceDef: {
            pageCode: "student_by_org_report",
            sourceTable: "student",
            dimensions: ["organization_id", "student_status"],
            metrics: [{ field: "id", type: "count", as: "student_count" }],
          },
        },
        {
          targetType: "api_dsl",
          targetCode: "student_export.query",
          op: "modify",
          modifiedDslJson: {
            operation: "query",
            table: "student",
            security: { dataPermission: "own_organization" },
            select: [{ field: "id" }, { field: "name" }],
          },
        },
      ], policy);
      expectEqual(errors.length, 0, `expected no tenant scope errors, got ${errors.join("; ")}`);
    },
  },
  {
    name: "blocks custom tables without tenant scope and recovery fields",
    run: () => {
      const errors = validateEduDomainGuardrails([
        {
          targetType: "db_schema",
          targetCode: "custom_visit",
          op: "create_table",
          resourceDef: {
            tableName: "custom_visit",
            softDelete: false,
            extJson: false,
            fields: [{ key: "visit_name", label: "到访名称", type: "text" }],
          },
        },
      ], policy);
      expectIncludes(errors, "必须启用 softDelete");
      expectIncludes(errors, "必须保留 extJson");
      expectIncludes(errors, "必须包含 organization_id");
    },
  },
  {
    name: "allows tenant scoped custom tables with extension fields",
    run: () => {
      const errors = validateEduDomainGuardrails([
        {
          targetType: "db_schema",
          targetCode: "custom_visit",
          op: "create_table",
          resourceDef: {
            tableName: "custom_visit",
            softDelete: true,
            extJson: true,
            fields: [
              { key: "organization_id", label: "校区", type: "select" },
              { key: "visit_name", label: "到访名称", type: "text" },
            ],
          },
        },
      ], policy);
      expectEqual(errors.length, 0, `expected no custom table errors, got ${errors.join("; ")}`);
    },
  },
  {
    name: "flags high risk schema changes without blocking confirmation",
    run: () => {
      const assessment = evaluateHarnessRisk([
        {
          targetType: "db_schema",
          targetCode: "student",
          op: "add_field",
          resourceDef: { tableName: "student", fields: [{ key: "wechat", label: "微信" }] },
        },
      ], policy);
      expectEqual(assessment.level, "high", "unexpected risk level");
      expectEqual(assessment.requiresConfirmation, false, "unexpected confirmation requirement");
      expectEqual(assessment.errors.length, 0, `expected no risk errors, got ${assessment.errors.join("; ")}`);
    },
  },
  {
    name: "allows confirmed high risk schema changes",
    run: () => {
      const assessment = evaluateHarnessRisk([
        {
          targetType: "db_schema",
          targetCode: "student",
          op: "add_field",
          resourceDef: { tableName: "student", fields: [{ key: "wechat", label: "微信" }] },
        },
      ], policy);
      expectEqual(assessment.level, "high", "unexpected risk level");
      expectEqual(assessment.errors.length, 0, `expected no risk errors, got ${assessment.errors.join("; ")}`);
    },
  },
  {
    name: "auto risk policy does not require high risk confirmation",
    run: () => {
      const assessment = evaluateHarnessRisk([
        {
          targetType: "db_schema",
          targetCode: "student",
          op: "add_field",
          resourceDef: { tableName: "student", fields: [{ key: "wechat", label: "微信" }] },
        },
      ], { ...policy, riskPolicy: "auto" });
      expectEqual(assessment.level, "high", "unexpected risk level");
      expectEqual(assessment.requiresConfirmation, false, "unexpected confirmation requirement");
      expectEqual(assessment.errors.length, 0, `expected no risk errors, got ${assessment.errors.join("; ")}`);
    },
  },
  {
    name: "allows broad or system permission changes without high risk confirmation",
    run: () => {
      const errors = validateEduDomainGuardrails([
        {
          targetType: "permission_policy",
          targetCode: "TEACHER.role_list",
          op: "modify_permission",
          resourceDef: {
            roleCode: "TEACHER",
            pageCode: "role_list",
            pagePermission: "all",
            dataPermission: "all",
            buttonPermission: ["edit"],
            fieldPermission: { phone: "hidden" },
          },
        },
      ], policy);
      expectEqual(errors.length, 0, `expected no permission confirmation errors, got ${errors.join("; ")}`);
    },
  },
  {
    name: "blocks unsafe followup row actions",
    run: () => {
      const errors = validateEduDomainGuardrails([
        {
          targetType: "page_dsl",
          targetCode: "lead_list",
          op: "add_row_action",
          fieldDef: {
            actionCode: "lead_list.followup",
            label: "新增跟进",
            type: "execute_api",
            apiCode: "student_followup_list.create",
            fields: [{ key: "follow_content", label: "跟进内容", type: "textarea" }],
          },
        },
      ], policy);
      expectIncludes(errors, "必须使用 open_modal");
      expectIncludes(errors, "缺少字段 student_id");
      expectIncludes(errors, "mapRowToValue.student_id");
    },
  },
  {
    name: "allows standard followup row action",
    run: () => {
      const errors = validateEduDomainGuardrails([
        {
          targetType: "page_dsl",
          targetCode: "lead_list",
          op: "add_row_action",
          fieldDef: {
            actionCode: "lead_list.followup",
            label: "新增跟进",
            type: "open_modal",
            apiCode: "student_followup_list.create",
            mapRowToValue: { student_id: "id" },
            fields: [
              { key: "student_id", label: "学员", type: "select" },
              { key: "follow_type", label: "跟进方式", type: "select" },
              { key: "follow_content", label: "跟进内容", type: "textarea" },
              { key: "next_follow_time", label: "下次跟进时间", type: "datetime" },
            ],
          },
        },
      ], policy);
      expectEqual(errors.length, 0, `expected no followup errors, got ${errors.join("; ")}`);
    },
  },
  {
    name: "blocks unsafe charge row actions",
    run: () => {
      const errors = validateEduDomainGuardrails([
        {
          targetType: "page_dsl",
          targetCode: "course_list",
          op: "add_row_action",
          fieldDef: {
            actionCode: "course_list.charge",
            label: "课消扣费",
            type: "execute_api",
            apiCode: "charge_record.create",
            fields: [{ key: "charge_hour", label: "扣课时", type: "number" }],
          },
        },
      ], policy);
      expectIncludes(errors, "扣费动作 course_list.charge 必须使用 open_modal");
      expectIncludes(errors, "visibleWhen.course_status");
      expectIncludes(errors, "缺少字段 course_id");
      expectIncludes(errors, "mapRowToValue.course_id");
    },
  },
  {
    name: "blocks unsafe course scheduling actions",
    run: () => {
      const errors = validateEduDomainGuardrails([
        {
          targetType: "page_dsl",
          targetCode: "course_list",
          op: "add_toolbar",
          fieldDef: {
            actionCode: "course_list.create",
            label: "新增排课",
            type: "execute_api",
            apiCode: "course_list.create",
            fields: [{ key: "course_date", label: "上课日期", type: "date" }],
          },
        },
      ], policy);
      expectIncludes(errors, "排课动作 course_list.create 必须使用 open_modal");
      expectIncludes(errors, "缺少字段 start_time");
      expectIncludes(errors, "缺少字段 teacher_id");
    },
  },
  {
    name: "allows standard course scheduling action",
    run: () => {
      const errors = validateEduDomainGuardrails([
        {
          targetType: "page_dsl",
          targetCode: "course_list",
          op: "add_toolbar",
          fieldDef: {
            actionCode: "course_list.create",
            label: "新增排课",
            type: "open_modal",
            apiCode: "course_list.create",
            fields: [
              { key: "course_title", label: "课程名称", type: "text" },
              { key: "course_type", label: "课程类型", type: "select" },
              { key: "course_date", label: "上课日期", type: "date" },
              { key: "start_time", label: "开始时间", type: "time" },
              { key: "end_time", label: "结束时间", type: "time" },
              { key: "teacher_id", label: "老师", type: "select" },
              { key: "organization_id", label: "校区", type: "select" },
              { key: "course_hour", label: "课时", type: "number" },
            ],
          },
        },
      ], policy);
      expectEqual(errors.length, 0, `expected no scheduling errors, got ${errors.join("; ")}`);
    },
  },
  {
    name: "allows standard charge row action",
    run: () => {
      const errors = validateEduDomainGuardrails([
        {
          targetType: "page_dsl",
          targetCode: "course_list",
          op: "add_row_action",
          fieldDef: {
            actionCode: "course_list.charge",
            label: "确认扣费",
            type: "open_modal",
            apiCode: "charge_record.create",
            visibleWhen: { course_status: "FINISHED" },
            mapRowToValue: { course_id: "id" },
            fields: [
              { key: "course_id", label: "课程", type: "select" },
              { key: "student_id", label: "学员", type: "select" },
              { key: "contract_product_id", label: "合同产品", type: "select" },
              { key: "charge_type", label: "扣费类型", type: "select" },
              { key: "charge_hour", label: "扣课时", type: "number" },
              { key: "charge_amount", label: "扣费金额", type: "number" },
            ],
          },
        },
      ], policy);
      expectEqual(errors.length, 0, `expected no charge errors, got ${errors.join("; ")}`);
    },
  },
  {
    name: "blocks unsafe contract payment actions and direct finance writes",
    run: () => {
      const errors = validateEduDomainGuardrails([
        {
          targetType: "page_dsl",
          targetCode: "contract_list",
          op: "add_row_action",
          fieldDef: {
            actionCode: "contract_list.funds",
            label: "合同收款",
            type: "execute_api",
            apiCode: "funds_history.create",
            fields: [{ key: "transaction_amount", label: "收款金额", type: "number" }],
          },
        },
        {
          targetType: "api_dsl",
          targetCode: "contract_list.update",
          op: "add_allowed_field",
          field: "paid_amount",
          fieldDef: { field: "paid_amount" },
        },
      ], policy);
      expectIncludes(errors, "收款动作 contract_list.funds 必须使用 open_modal");
      expectIncludes(errors, "visibleWhen.contract_status");
      expectIncludes(errors, "缺少字段 contract_id");
      expectIncludes(errors, "mapRowToValue.contract_id");
      expectIncludes(errors, "禁止直接写入财务派生字段 paid_amount");
    },
  },
  {
    name: "allows standard contract payment row action",
    run: () => {
      const errors = validateEduDomainGuardrails([
        {
          targetType: "page_dsl",
          targetCode: "contract_list",
          op: "add_row_action",
          fieldDef: {
            actionCode: "contract_list.funds",
            label: "合同收款",
            type: "open_modal",
            apiCode: "funds_history.create",
            visibleWhen: { contract_status: "ACTIVE" },
            mapRowToValue: { contract_id: "id", student_id: "student_id", organization_id: "organization_id" },
            fields: [
              { key: "contract_id", label: "合同", type: "select" },
              { key: "student_id", label: "学员", type: "select" },
              { key: "organization_id", label: "校区", type: "select" },
              { key: "transaction_amount", label: "收款金额", type: "number" },
              { key: "pay_way_config_id", label: "支付方式", type: "select" },
              { key: "transaction_time", label: "收款时间", type: "datetime" },
              { key: "funds_type", label: "收款类型", type: "select" },
            ],
          },
        },
      ], policy);
      expectEqual(errors.length, 0, `expected no payment errors, got ${errors.join("; ")}`);
    },
  },
  {
    name: "blocks unsafe refund row actions",
    run: () => {
      const errors = validateEduDomainGuardrails([
        {
          targetType: "page_dsl",
          targetCode: "contract_product_list",
          op: "add_row_action",
          fieldDef: {
            actionCode: "contract_product_list.refund",
            label: "退费",
            type: "execute_api",
            apiCode: "refund_record.create",
            fields: [{ key: "refund_real_amount", label: "退金额", type: "number" }],
          },
        },
      ], policy);
      expectIncludes(errors, "退费动作 contract_product_list.refund 必须使用 open_modal");
      expectIncludes(errors, "缺少字段 student_id");
      expectIncludes(errors, "mapRowToValue.contract_product_id");
    },
  },
  {
    name: "allows standard refund row action",
    run: () => {
      const errors = validateEduDomainGuardrails([
        {
          targetType: "page_dsl",
          targetCode: "contract_product_list",
          op: "add_row_action",
          fieldDef: {
            actionCode: "contract_product_list.refund",
            label: "申请退费",
            type: "open_modal",
            apiCode: "refund_record.create",
            mapRowToValue: { contract_product_id: "id", student_id: "student_id" },
            fields: [
              { key: "student_id", label: "学员", type: "select" },
              { key: "contract_product_id", label: "合同产品", type: "select" },
              { key: "refund_real_hour", label: "退课时", type: "number" },
              { key: "refund_real_amount", label: "退金额", type: "number" },
              { key: "refund_promotion_amount", label: "退优惠金额", type: "number" },
              { key: "refund_promotion_hour", label: "退赠课时", type: "number" },
              { key: "refund_way_config_id", label: "退费方式", type: "select" },
              { key: "refund_time", label: "退费时间", type: "datetime" },
            ],
          },
        },
      ], policy);
      expectEqual(errors.length, 0, `expected no refund errors, got ${errors.join("; ")}`);
    },
  },
  {
    name: "allows confirmed scoped permission policy",
    run: () => {
      const errors = validateEduDomainGuardrails([
        {
          targetType: "permission_policy",
          targetCode: "TEACHER.student_list",
          op: "modify_permission",
          resourceDef: {
            roleCode: "TEACHER",
            pageCode: "student_list",
            pagePermission: "read",
            dataPermission: "own_courses",
            buttonPermission: ["detail"],
            fieldPermission: { phone: "hidden" },
          },
        },
      ], policy);
      expectEqual(errors.length, 0, `expected no permission errors, got ${errors.join("; ")}`);
    },
  },
  {
    name: "renders permission policy preview resource",
    run: async () => {
      const diffs: DslDiff[] = [
        {
          targetType: "permission_policy",
          targetCode: "TEACHER.student_list",
          op: "modify_permission",
          resourceDef: {
            roleCode: "TEACHER",
            pageCode: "student_list",
            pagePermission: "read",
            dataPermission: "own_courses",
            buttonPermission: ["detail"],
            fieldPermission: { phone: "hidden" },
          },
        },
      ];
      const result = await executeDiffs(diffs, "demo_school");
      const snapshot = result[0]?.modifiedDslJson;
      if (!isObject(snapshot)) throw new Error("missing permission policy snapshot");
      expectEqual(snapshot.resourceType, "permission_policy", "unexpected resourceType");
      expectEqual(snapshot.roleCode, "TEACHER", "unexpected roleCode");
      expectEqual(snapshot.pageCode, "student_list", "unexpected pageCode");
    },
  },
  {
    name: "renders row action into page table actions",
    run: async () => {
      const result = await executeDiffs([
        {
          targetType: "page_dsl",
          targetCode: "empty_page",
          op: "add_row_action",
          fieldDef: {
            actionCode: "empty_page.charge",
            label: "确认扣费",
            type: "open_modal",
            apiCode: "charge_record.create",
          },
        },
      ], "demo_school");
      const snapshot = result[0]?.modifiedDslJson;
      if (!isObject(snapshot)) throw new Error("missing page snapshot");
      const table = isObject(snapshot.table) ? snapshot.table : {};
      const rowActions = Array.isArray(table.rowActions) ? table.rowActions : [];
      expectEqual(rowActions.length, 1, "unexpected row action count");
      expectEqual(isObject(rowActions[0]) ? rowActions[0].actionCode : "", "empty_page.charge", "unexpected row action code");
    },
  },
];

async function main() {
  const failures: Array<{ name: string; error: unknown }> = [];
  for (const test of tests) {
    try {
      await test.run();
      console.log(`PASS ${test.name}`);
    } catch (error) {
      failures.push({ name: test.name, error });
      console.error(`FAIL ${test.name}`);
      console.error(error instanceof Error ? error.message : error);
    }
  }

  if (failures.length > 0) {
    console.error(`Harness regression failed: ${failures.length}/${tests.length}`);
    process.exit(1);
  }
  console.log(`Harness regression passed: ${tests.length}/${tests.length}`);
}

function expectIncludes(values: string[], expected: string) {
  if (!values.some((value) => value.includes(expected))) {
    throw new Error(`expected error containing "${expected}", got: ${values.join("; ")}`);
  }
}

function expectEqual(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function emptyExisting(input: { toolbar?: string[]; rowActions?: string[]; columns?: string[]; filters?: string[]; modalFields?: string[] }) {
  return {
    toolbar: new Set(input.toolbar ?? []),
    rowActions: new Set(input.rowActions ?? []),
    columns: new Set(input.columns ?? []),
    filters: new Set(input.filters ?? []),
    modalFields: new Set(input.modalFields ?? []),
  };
}

function emptyApi(input: { allowedFields?: string[]; selectFields?: string[]; selectAliases?: string[]; filters?: string[] }) {
  return {
    allowedFields: new Set(input.allowedFields ?? []),
    selectFields: new Set(input.selectFields ?? []),
    selectAliases: new Set(input.selectAliases ?? []),
    filters: new Set(input.filters ?? []),
  };
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
