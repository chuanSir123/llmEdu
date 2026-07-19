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
  validateBusinessEventRuleCycles,
  errorFingerprint,
} from "./steps/validation-repair.step.js";
import { resolveExistingFeatureCode } from "./steps/intent-classification.step.js";
import { makeGetTableColumnsTool, makeGetDslContentTool, makeValidateDraftTool } from "./agent-tools.js";
import { completeDisplayDiffs } from "./diff-completion.js";
import { collectBusinessEventRelationsForFeature, extractSkillMdMetadata, formatSkillSummaryFromMd, generateSkillMd, hasStandardSkillMdMetadata } from "./skill-md.service.js";
import { summarizeActionDsl, summarizeApiDsl, summarizePageDsl } from "./steps/context-injection.step.js";
import { defaultTenantAgentPolicy } from "./tenant-policy.service.js";
import type { DslDiff } from "./types.js";
import { validateEduDomainGuardrails } from "./validators/edu-domain.validator.js";
import { classifyHarnessError, classifyFeedback, needsContextRefresh, HarnessErrorCode } from "./harness-errors.js";
import { EDU_RULES } from "./rules/edu-rules.js";
import { TEMPLATE_SCHEMA } from "../common/template-schema.js";
import { validateDeclarativeRuleJson, evaluateFieldCheck } from "../common/declarative-rules.js";

type TestCase = {
  name: string;
  run: () => void | Promise<void>;
};

const policy = defaultTenantAgentPolicy();
const emptyContext = { skillMdContent: "", tableColumns: {}, relevantDslCodes: ["contract_list"], dslSummary: { pages: [], apis: [], actions: [] }, tokenEstimate: 0 };

const tests: TestCase[] = [
  {
    name: "error fingerprint is order-insensitive and detects change",
    run: () => {
      const a = errorFingerprint(["字段不存在: a", "缺少 fieldDef"]);
      const b = errorFingerprint(["缺少 fieldDef", "字段不存在: a", "字段不存在: a"]);
      const c = errorFingerprint(["缺少 fieldDef"]);
      expectEqual(a === b, true, "same errors in different order should share fingerprint");
      expectEqual(a === c, false, "different error sets must differ");
    },
  },
  {
    name: "execution policy defaults are positive budgets",
    run: () => {
      const { maxPlanAttempts, maxRepairRounds, repairTimeoutMs, maxToolCallsPerRepair } = policy.executionPolicy;
      expectEqual(maxPlanAttempts >= 1, true, "maxPlanAttempts must be >= 1");
      expectEqual(maxRepairRounds >= 3, true, "maxRepairRounds should not shrink below legacy 3");
      expectEqual(repairTimeoutMs >= 30000, true, "repairTimeoutMs should not shrink below legacy 30s");
      expectEqual(maxToolCallsPerRepair >= 1, true, "maxToolCallsPerRepair must be >= 1");
    },
  },
  {
    name: "agent self-check tools reject invalid arguments without touching db",
    run: async () => {
      const tableTool = makeGetTableColumnsTool(TEMPLATE_SCHEMA);
      const emptyResult = JSON.parse(await tableTool.execute({ tables: [] }));
      expectEqual(typeof emptyResult.error, "string", "empty tables should return an error message");
      const badNameResult = JSON.parse(await tableTool.execute({ tables: ["DROP TABLE x;"] }));
      expectEqual(typeof badNameResult.error, "string", "illegal table names should be rejected");
      const dslTool = makeGetDslContentTool(TEMPLATE_SCHEMA);
      const badTypeResult = JSON.parse(await dslTool.execute({ targetType: "not_a_type", targetCode: "student_list" }));
      expectEqual(typeof badTypeResult.error, "string", "unknown targetType should be rejected");
      const validateTool = makeValidateDraftTool(async () => ({ valid: true, errors: [] }));
      const emptyDraft = JSON.parse(await validateTool.execute({ diffs: [] }));
      expectEqual(emptyDraft.valid, false, "empty draft should not validate");
    },
  },
  {
    name: "completes missing modal field when model only allows api fields (qq_number case)",
    run: async () => {
      const apiOnlyDiffs: DslDiff[] = ["detail", "create", "update"].map((suffix) => ({
        targetType: "api_dsl",
        targetCode: `student_list.${suffix}`,
        op: "add_allowed_field",
        field: "qq_number",
        fieldDef: { field: "qq_number", label: "QQ号" },
      } as DslDiff));
      const completions = await completeDisplayDiffs(apiOnlyDiffs, TEMPLATE_SCHEMA);
      expectEqual(completions.length, 1, "api-only field addition must synthesize one page modal field");
      expectEqual(completions[0]?.targetType, "page_dsl", "completion must target page_dsl");
      expectEqual(completions[0]?.targetCode, "student_list", "completion must target the page");
      expectEqual(completions[0]?.op, "add_modal_field", "completion op must be add_modal_field");
      expectEqual(completions[0]?.fieldDef?.label, "QQ号", "completion should reuse label from sibling diffs");

      // 同批已有显示位变更时不重复补
      const withDisplay = await completeDisplayDiffs([
        ...apiOnlyDiffs,
        { targetType: "page_dsl", targetCode: "student_list", op: "add_modal_field", field: "qq_number", fieldDef: { key: "qq_number", label: "QQ号" } } as DslDiff,
      ], TEMPLATE_SCHEMA);
      expectEqual(withDisplay.length, 0, "must not duplicate when display diff already present");

      // 页面表单已有的字段不补（name 是 student_list 模板表单既有字段）
      const existingField = await completeDisplayDiffs([
        { targetType: "api_dsl", targetCode: "student_list.update", op: "add_allowed_field", field: "name", fieldDef: { field: "name" } } as DslDiff,
      ], TEMPLATE_SCHEMA);
      expectEqual(existingField.length, 0, "existing modal fields must not be re-added");
    },
  },
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
    name: "removes existing page field additions during deterministic repair",
    run: async () => {
      const validation = await executeValidationRepair(
        [
          {
            targetType: "page_dsl",
            targetCode: "student_list",
            op: "add_column",
            fieldDef: { key: "name", label: "学员姓名" },
          },
          {
            targetType: "page_dsl",
            targetCode: "student_list",
            op: "add_filter",
            fieldDef: { key: "student_status", label: "状态" },
          },
          {
            targetType: "page_dsl",
            targetCode: "student_list",
            op: "add_modal_field",
            fieldDef: { key: "remark", label: "备注" },
          },
          {
            targetType: "print_template",
            targetCode: "student_field_dedupe_print_regression",
            op: "create_print_template",
            resourceDef: {
              templateCode: "student_field_dedupe_print_regression",
              templateName: "学员字段去重回归模板",
              pageCode: "student_list",
              fields: ["name", "phone", "student_status"],
            },
          },
        ],
        { featureCode: "student_list", action: "modify", reason: "字段去重回归" },
        emptyContext,
        TEMPLATE_SCHEMA,
        "给学员列表补充已有字段并新增打印模板",
      );
      expectEqual(validation.error, undefined, `unexpected validation error: ${validation.error}`);
      expectEqual(validation.data.some((diff) => diff.targetType === "page_dsl" && diff.op === "add_column"), false, "duplicate column should be removed");
      expectEqual(validation.data.some((diff) => diff.targetType === "page_dsl" && diff.op === "add_filter"), false, "duplicate filter should be removed");
      expectEqual(validation.data.some((diff) => diff.targetType === "page_dsl" && diff.op === "add_modal_field"), false, "duplicate modal field should be removed");
      expectEqual(validation.data.some((diff) => diff.targetType === "print_template" && diff.op === "create_print_template"), true, "valid print template should remain");
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
        schemaName: TEMPLATE_SCHEMA,
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

      const executed = await executeDiffs(result.data, TEMPLATE_SCHEMA);
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
        schemaName: TEMPLATE_SCHEMA,
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
        schemaName: TEMPLATE_SCHEMA,
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
              businessType: "contract_create",
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
        TEMPLATE_SCHEMA,
        "给合同列表增加审批流、导出、打印模板、数据权限和业务校验规则",
      );
      expectEqual(validation.error, undefined, `unexpected validation error: ${validation.error}`);

      const executed = await executeDiffs(result.data, TEMPLATE_SCHEMA);
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
    name: "renders business event listener relationships in skill md",
    run: () => {
      const rules = [{
        ruleCode: "contract_created_create_funds",
        rule: {
          ruleCode: "contract_created_create_funds",
          ruleName: "合同后自动收款",
          category: "workflow",
          businessType: "contract_create",
          featureCode: "funds_history",
          trigger: { event: "contract.created" },
          actions: [{ type: "execute_command", command: "funds.create" }],
        },
      }];
      const fundsRelations = collectBusinessEventRelationsForFeature("funds_history", rules);
      const contractRelations = collectBusinessEventRelationsForFeature("contract_list", rules);
      const fundsMd = generateSkillMd({
        pageDsl: { title: "收款流水" },
        apiDsls: [],
        actionDsls: [],
        featureCode: "funds_history",
        featureName: "收款流水",
        businessEventRelations: fundsRelations,
      });
      const contractMd = generateSkillMd({
        pageDsl: { title: "合同列表" },
        apiDsls: [],
        actionDsls: [],
        featureCode: "contract_list",
        featureName: "合同列表",
        businessEventRelations: contractRelations,
      });
      expectEqual(fundsMd.includes("## 业务事件监听关系"), true, "missing listener relationship section");
      expectEqual(fundsMd.includes("contract.created"), true, "listener skill should list listened event");
      expectEqual(fundsMd.includes("contract_list"), true, "listener skill should list listened feature");
      expectEqual(contractMd.includes("funds_history"), true, "source skill should list listening feature");
      expectEqual(contractMd.includes("funds.create"), true, "source skill should list triggered command");
    },
  },
  {
    name: "detects workflow business event self cycles in harness validation",
    run: () => {
      const errors = validateBusinessEventRuleCycles([{
        targetCode: "funds_created_create_funds_loop",
        resource: {
          ruleCode: "funds_created_create_funds_loop",
          ruleName: "收款后再次收款循环规则",
          category: "workflow",
          businessType: "funds_create",
          trigger: { event: "funds.created" },
          actions: [{ type: "execute_command", command: "funds.create" }],
        },
      }]);
      expectEqual(errors.some((error) => error.includes("自循环")), true, `expected self cycle error, got ${errors.join("; ")}`);
    },
  },
  {
    name: "detects workflow business event cross-rule cycles in harness validation",
    run: () => {
      const errors = validateBusinessEventRuleCycles([
        {
          targetCode: "contract_created_create_funds",
          resource: {
            ruleCode: "contract_created_create_funds",
            ruleName: "合同后收款",
            category: "workflow",
            businessType: "contract_create",
            trigger: { event: "contract.created" },
            actions: [{ type: "execute_command", command: "funds.create" }],
          },
        },
        {
          targetCode: "funds_created_create_contract",
          resource: {
            ruleCode: "funds_created_create_contract",
            ruleName: "收款后合同",
            category: "workflow",
            businessType: "funds_create",
            trigger: { event: "funds.created" },
            actions: [{ type: "execute_command", command: "contract.create" }],
          },
        },
      ]);
      expectEqual(errors.some((error) => error.includes("事件链存在循环")), true, `expected cross-rule cycle error, got ${errors.join("; ")}`);
    },
  },
  {
    name: "recognizes standard workflow action requests without extra confirmation",
    run: async () => {
      const result = await executeRequirementPlanning(
        "给合同列表增加一个合同收款按钮",
        { featureCode: "contract_list", action: "modify", reason: "合同列表收款动作" },
        { skillMdContent: "", tableColumns: {}, relevantDslCodes: ["contract_list"], dslSummary: { pages: [], apis: [], actions: [] }, tokenEstimate: 0 },
        TEMPLATE_SCHEMA,
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
        TEMPLATE_SCHEMA,
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
        TEMPLATE_SCHEMA,
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
        TEMPLATE_SCHEMA,
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
        TEMPLATE_SCHEMA,
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
        TEMPLATE_SCHEMA,
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
        TEMPLATE_SCHEMA,
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
      const result = await executeDiffs(diffs, TEMPLATE_SCHEMA);
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
      ], TEMPLATE_SCHEMA);
      const snapshot = result[0]?.modifiedDslJson;
      if (!isObject(snapshot)) throw new Error("missing page snapshot");
      const table = isObject(snapshot.table) ? snapshot.table : {};
      const rowActions = Array.isArray(table.rowActions) ? table.rowActions : [];
      expectEqual(rowActions.length, 1, "unexpected row action count");
      expectEqual(isObject(rowActions[0]) ? rowActions[0].actionCode : "", "empty_page.charge", "unexpected row action code");
    },
  },
  {
    name: "context-refresh classifier preserves legacy shouldRefreshContext behavior",
    run: () => {
      // 旧 shouldRefreshContext 的全部触发文案都必须仍判定为需要刷新上下文
      const legacyRefreshPhrases = [
        "报表字段不存在: employee.performance_amount",
        "API DSL 字段校验失败: x",
        "missing filter foo",
        "missing allowedField foo",
        "missing select field foo",
        "missing metric field foo",
        "missing dimension field foo",
        "missing table foo",
        "筛选字段必须是物理列: student.parent_phone 不存在",
      ];
      for (const phrase of legacyRefreshPhrases) {
        expectEqual(needsContextRefresh(phrase), true, `expected refresh for: ${phrase}`);
      }
      // 回显缺失、重复等不应触发上下文刷新
      expectEqual(needsContextRefresh("列表查询回显缺失: student_list.query 未返回字段 parent_phone"), false, "echo-missing should not refresh");
      expectEqual(needsContextRefresh("列表列已存在: student_list.parent_phone"), false, "duplicate should not refresh");
    },
  },
  {
    name: "classifyHarnessError maps known messages to stable codes",
    run: () => {
      expectEqual(classifyHarnessError("报表字段不存在: a.b"), HarnessErrorCode.REPORT_FIELD_MISSING, "report code");
      expectEqual(classifyHarnessError("筛选字段必须是物理列: a.b 不存在"), HarnessErrorCode.FILTER_NOT_PHYSICAL, "filter code");
      expectEqual(classifyHarnessError("详情接口回显缺失: x.detail 未包含字段 y"), HarnessErrorCode.FIELD_ECHO_MISSING, "echo code");
      expectEqual(classifyHarnessError("student_list add_column 外键字段 organization_id 缺少 optionSource"), HarnessErrorCode.FK_OPTION_SOURCE_MISSING, "fk code");
      expectEqual(classifyHarnessError("某种没人见过的错误"), HarnessErrorCode.OTHER, "fallback OTHER");
      // 聚合反馈拆分去重
      const codes = classifyFeedback("校验失败: 报表字段不存在: a.b; 列表列已存在: c.d");
      expectIncludes(codes, HarnessErrorCode.REPORT_FIELD_MISSING);
      expectIncludes(codes, HarnessErrorCode.DUPLICATE);
    },
  },
  {
    name: "edu rule registry codes are all valid harness error codes",
    run: () => {
      const valid = new Set(Object.values(HarnessErrorCode));
      for (const rule of EDU_RULES) {
        expectEqual(valid.has(rule.errorCode), true, `rule ${rule.code} has invalid errorCode ${rule.errorCode}`);
        expectEqual(Boolean(rule.promptHint && rule.title && rule.triggers.length > 0), true, `rule ${rule.code} missing fields`);
      }
      // 规则码唯一
      const seen = new Set<string>();
      for (const rule of EDU_RULES) {
        expectEqual(seen.has(rule.code), false, `duplicate rule code ${rule.code}`);
        seen.add(rule.code);
      }
    },
  },
  {
    name: "resolveExistingFeatureCode maps detail codes to existing list features",
    run: () => {
      const existing = ["student_list", "contract_list", "course_list", "organization_list"];
      // student_detail 不在列表，应归一到 student_list
      const detail = resolveExistingFeatureCode("student_detail", existing);
      expectEqual(detail.matched, true, "student_detail should resolve to existing feature");
      expectEqual(detail.featureCode, "student_list", "student_detail should map to student_list");
      // 已存在编码保持不变
      const direct = resolveExistingFeatureCode("contract_list", existing);
      expectEqual(direct.matched, true, "existing code should match");
      expectEqual(direct.featureCode, "contract_list", "existing code should be unchanged");
      // 完全编造的编码无法归一时保留原值且不 matched
      const invented = resolveExistingFeatureCode("totally_invented_xyz", existing);
      expectEqual(invented.matched, false, "invented code should not match");
      expectEqual(invented.featureCode, "totally_invented_xyz", "invented code should be preserved for validator to reject");
      // 唯一前缀匹配：lead 列表不存在但只有一个以 lead_ 开头的也应归一（这里测试无匹配分支）
      const singlePrefix = resolveExistingFeatureCode("lead_detail", ["lead_list"]);
      expectEqual(singlePrefix.matched, true, "lead_detail should resolve via suffix to lead_list");
      expectEqual(singlePrefix.featureCode, "lead_list", "lead_detail should map to lead_list");
    },
  },
  {
    name: "validate rejects diffs targeting non-existent pages/apis/tables (detail-code case)",
    run: async () => {
      // 模型给"学员详情"加 QQ 字段时编造的典型错误：用不存在的详情页编码与详情表
      // student_profile 在模板机构中既不是页面也不是物理表，应被确定性兜底拦截
      const badDiffs: DslDiff[] = [
        { targetType: "page_dsl", targetCode: "student_profile", op: "add_column", field: "qq_number", fieldDef: { key: "qq_number", label: "QQ号", type: "text" } },
        { targetType: "db_schema", targetCode: "student_profile", op: "add_field", resourceDef: { tableName: "student_profile", fields: [{ key: "qq_number", label: "QQ号", type: "text" }] } },
      ];
      const result = await executeValidationRepair(badDiffs, { featureCode: "student_profile", action: "modify", reason: "", relatedFeatureCodes: [] }, emptyContext, TEMPLATE_SCHEMA, "给学员详情新增QQ号字段");
      expectEqual(Boolean(result.error), true, "should fail validation for non-existent targets");
      const err = result.error ?? "";
      expectIncludes([err], "页面不存在");
      expectIncludes([err], "物理表不存在");
    },
  },
  {
    name: "validate accepts add_field to a real existing table",
    run: async () => {
      // student 是模板机构真实存在的物理表，加一个新字段应通过表存在性检查
      const goodDiffs: DslDiff[] = [
        { targetType: "db_schema", targetCode: "student", op: "add_field", resourceDef: { tableName: "student", fields: [{ key: "qq_number_extra", label: "QQ号", type: "text" }] } },
      ];
      const result = await executeValidationRepair(goodDiffs, { featureCode: "student_list", action: "modify", reason: "", relatedFeatureCodes: [] }, emptyContext, TEMPLATE_SCHEMA, "给学员加QQ号");
      // 可能因其他关联校验（回显缺失等）失败，但绝不能因"物理表不存在: student"失败
      const err = result.error ?? "";
      expectEqual(err.includes("物理表不存在: student"), false, "real table student must not be flagged as missing");
    },
  },
  {
    name: "declarative rule structure validation rejects bad shapes and accepts good ones",
    run: () => {
      // 好结构：单次扣课时上限（含 when 前置条件）
      const good = validateDeclarativeRuleJson({
        ruleCode: "charge_hour_limit", ruleName: "单次扣课时上限", category: "validation", businessType: "charge_create",
        validations: [{ field: "charge_hour", operator: "<=", value: 4, message: "单次扣课时不能超过4", when: [{ field: "charge_type", operator: "=", value: "NORMAL" }] }],
      });
      expectEqual(good.length, 0, `good rule should pass, got: ${good.join(";")}`);
      // 好结构：context 引用 + count_limit
      const goodCtx = validateDeclarativeRuleJson({
        category: "validation", businessType: "course_create",
        validations: [
          { field: "context.student.student_status", operator: "=", value: "FORMAL", message: "仅正式学员可排课" },
          { type: "count_limit", table: "generic_course_student", where: [{ field: "student_id", valueFrom: "student_id" }], operator: "<", value: 10, message: "未完成课程已达上限" },
        ],
      });
      expectEqual(goodCtx.length, 0, `context/count_limit rule should pass, got: ${goodCtx.join(";")}`);
      // 坏结构：未知实体、未知 operator、count_limit 无 where、businessType 不支持
      const bad = validateDeclarativeRuleJson({
        category: "validation", businessType: "not_a_command",
        validations: [
          { field: "context.invoice.amount", operator: "=", value: 1 },
          { field: "charge_hour", operator: "sql_inject", value: 1 },
          { type: "count_limit", table: "generic_course_student", where: [], operator: "<", value: 5 },
          { type: "count_limit", table: "admin_secret", where: [{ field: "id", value: "1" }], operator: "<", value: 5 },
        ],
      });
      expectEqual(bad.some((e) => e.includes("不支持的上下文实体")), true, "should flag unknown context entity");
      expectEqual(bad.some((e) => e.includes("operator 不支持")), true, "should flag unknown operator");
      expectEqual(bad.some((e) => e.includes("禁止全表计数")), true, "should flag empty count_limit where");
      expectEqual(bad.some((e) => e.includes("不在白名单")), true, "should flag non-whitelisted table");
      expectEqual(bad.some((e) => e.includes("businessType 不受声明式校验支持")), true, "should flag unsupported businessType");
      // 非 validation 分类（如 funds_allocation）不做结构校验
      const nonValidation = validateDeclarativeRuleJson({ category: "funds_allocation", businessType: "funds_create", fundsAllocation: "byCpRemainingAmount" });
      expectEqual(nonValidation.length, 0, "non-validation categories must not be structure-checked");
      // 旗标类 validation 规则（无 validations 数组，如排课冲突 preventXxx）继续放行
      const flagsOnly = validateDeclarativeRuleJson({ category: "validation", businessType: "course_create", preventTeacherTimeConflict: true });
      expectEqual(flagsOnly.length, 0, "flag-only validation rules must pass");
    },
  },
  {
    name: "declarative field check evaluator semantics (empty-skip, when, each, dict-compat, native-skip)",
    run: () => {
      const src = (data: Record<string, unknown>, context: Record<string, unknown> = {}) => ({ data, context });
      // 基本比较 + message 透传
      const over = evaluateFieldCheck({ field: "charge_hour", operator: "<=", value: 4, message: "超限" }, src({ charge_hour: 5 }));
      expectEqual(over.passed, false, "5 <= 4 must fail");
      expectEqual(over.message, "超限", "message must pass through");
      expectEqual(evaluateFieldCheck({ field: "charge_hour", operator: "<=", value: 4 }, src({ charge_hour: 4 })).passed, true, "4 <= 4 must pass");
      // 左值缺失：比较类跳过（规则不适用），required 拦截
      expectEqual(evaluateFieldCheck({ field: "charge_hour", operator: "<=", value: 4 }, src({})).passed, true, "missing left must skip compare");
      expectEqual(evaluateFieldCheck({ field: "remark", operator: "required" }, src({})).passed, false, "required must fail on missing");
      // when 前置条件不满足 → 直接通过
      expectEqual(evaluateFieldCheck(
        { field: "charge_hour", operator: "<=", value: 1, when: [{ field: "charge_type", operator: "=", value: "NORMAL" }] },
        src({ charge_hour: 9, charge_type: "PROMOTION" })
      ).passed, true, "when-precondition unmatched must skip");
      // 字典点号形态与裸值等价
      expectEqual(evaluateFieldCheck(
        { field: "context.student.student_status", operator: "=", value: "FORMAL" },
        src({}, { student: { student_status: "student_status.FORMAL" } })
      ).passed, true, "dict-id form must equal bare value");
      // each 逐项校验：任一项不满足即失败
      expectEqual(evaluateFieldCheck(
        { each: "students", field: "charge_hour", operator: "<=", value: 2 },
        src({ students: [{ charge_hour: 1 }, { charge_hour: 3 }] })
      ).passed, false, "each must fail when any item violates");
      // valueField 字段间比较（时间字符串字典序）
      expectEqual(evaluateFieldCheck({ field: "end_time", operator: ">", valueField: "start_time" }, src({ start_time: "10:00", end_time: "09:00" })).passed, false, "09:00 > 10:00 must fail");
      // 原生操作符（no_time_overlap）由引擎兜底，解释器跳过
      expectEqual(evaluateFieldCheck({ field: "teacher_id", operator: "no_time_overlap" }, src({ teacher_id: "t1" })).passed, true, "native operators must be skipped");
      // in / regex
      expectEqual(evaluateFieldCheck({ field: "student_status", operator: "in", value: ["FORMAL", "TRIAL"] }, src({ student_status: "LEAD" })).passed, false, "in must fail for excluded value");
      expectEqual(evaluateFieldCheck({ field: "contact", operator: "regex", value: "^1\\d{10}$" }, src({ contact: "abc" })).passed, false, "regex must fail on mismatch");
    },
  },
  {
    name: "edu guardrails reject bad declarative rules in create_business_rule diffs",
    run: () => {
      const errors = validateEduDomainGuardrails([
        {
          targetType: "business_rule", targetCode: "bad_rule", op: "create_business_rule",
          resourceDef: {
            ruleCode: "bad_rule", ruleName: "坏规则", category: "validation", businessType: "charge_create",
            validations: [{ field: "context.payroll.salary", operator: "magic", value: 1 }],
          },
        } as DslDiff,
      ], defaultTenantAgentPolicy());
      expectEqual(errors.some((e) => e.includes("不支持的上下文实体")), true, "guardrails must surface entity error");
      expectEqual(errors.some((e) => e.includes("operator 不支持")), true, "guardrails must surface operator error");
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
