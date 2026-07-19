import { HarnessErrorCode } from "../harness-errors.js";
import { DATA_PERMISSION_ENUM_TEXT } from "../../common/dsl-constants.js";

// 教务领域规则注册表（附加式单一真相源）
//
// 背景：目前教务规则散落在三处——prompts.ts 的规则文本、edu-domain.validator.ts 的
// 校验逻辑、harness-errors.ts 的错误码。三者各自维护，容易漂移（prompt 说能、校验说不能）。
//
// 本注册表把"一条教务规则 = 描述 + 适用范围 + 错误码 + few-shot 示例 + prompt 提示"
// 绑定到一处。**附加式**：不改写已稳定工作的 prompts.ts / edu-domain.validator.ts，
// 仅作为：
//   1) 新增规则的唯一落点；
//   2) 错误码 ↔ 规则的映射（harness-regression 交叉校验 classifyHarnessError 与本表一致）；
//   3) Golden 评测集按 ruleCode 打标签、断言护栏命中。
// 后续可逐步把 prompt/validator 文本迁移为从本表生成。

export type EduRuleScope =
  | "field_storage"
  | "report"
  | "import"
  | "export"
  | "permission"
  | "business_rule"
  | "foreign_key"
  | "field_type"
  | "funds"
  | "refund"
  | "scheduling";

export type EduRule = {
  /** 稳定规则码，评测用例据此打标签 */
  code: string;
  /** 一句话规则标题 */
  title: string;
  /** 适用范围 */
  scope: EduRuleScope;
  /** 违反该规则时校验器抛出的错误归类码 */
  errorCode: HarnessErrorCode;
  /** 给模型看的简短提示（可被 prompt 生成引用） */
  promptHint: string;
  /** 触发该规则的典型用户意图（few-shot / 评测线索） */
  triggers: string[];
};

export const EDU_RULES: EduRule[] = [
  {
    code: "scheduling_time_conflict",
    title: "排课必须校验老师与学员的时间冲突",
    scope: "scheduling",
    errorCode: HarnessErrorCode.BUSINESS_RULE_INVALID,
    promptHint:
      "排课冲突规则(business_rule, category=validation, businessType=course)必须同时包含老师 no_time_overlap、学员 no_time_overlap、结束时间晚于开始时间三条校验，并置 preventTeacherTimeConflict/preventStudentTimeConflict/preventInvalidTimeRange=true。",
    triggers: ["排课冲突", "老师时间冲突", "同一时间不能重复排课", "排课校验"],
  },
  {
    code: "funds_via_row_action",
    title: "收款/补缴必须走收款弹窗，不能直接改合同金额",
    scope: "funds",
    errorCode: HarnessErrorCode.BUSINESS_RULE_INVALID,
    promptHint:
      "合同收款/补缴必须用 page_dsl add_row_action 打开收款弹窗，apiCode=funds_history.create，并 mapRowToValue.contract_id='id'；禁止直接改 contract.paid_amount/paid_status 或 contract_product 的 paid/remaining/arrange 字段。",
    triggers: ["收款", "补缴", "付款确认", "缴费"],
  },
  {
    code: "refund_via_row_action",
    title: "退费必须走退费弹窗与 refund.create 命令",
    scope: "refund",
    errorCode: HarnessErrorCode.BUSINESS_RULE_INVALID,
    promptHint:
      "退费必须用 page_dsl add_row_action 打开退费弹窗，apiCode=refund_record.create；禁止直接改 contract_product.remaining_* 或 contract.paid_amount/paid_status，由 refund.create 命令处理余额校验与回滚。",
    triggers: ["退费", "退款"],
  },
  {
    code: "foreign_key_option_source",
    title: "外键字段必须配置 optionSource 与 displayKey",
    scope: "foreign_key",
    errorCode: HarnessErrorCode.FK_OPTION_SOURCE_MISSING,
    promptHint:
      "任何 *_id 外键字段（organization_id/student_id/teacher_id 等）列表与详情显示名称、编辑用下拉：fieldDef 必须含 optionSource{pageCode,apiCode,labelField} 和 displayKey。",
    triggers: ["校区", "下拉", "选择老师", "选择学员", "关联", "外键"],
  },
  {
    code: "field_type_constraints",
    title: "教务字段类型约束（手机号/金额/日期/课时）",
    scope: "field_type",
    errorCode: HarnessErrorCode.FIELD_TYPE_INVALID,
    promptHint:
      "手机号/电话用 text/tel 不能用 number；金额/学费/余额/欠费用 number/decimal/currency；日期/生日用 date/datetime；课时/次数/数量用 number/integer。",
    triggers: ["手机号", "电话", "金额", "学费", "课时", "生日", "日期"],
  },
  {
    code: "filter_requires_physical_column",
    title: "筛选字段必须是物理列",
    scope: "field_storage",
    errorCode: HarnessErrorCode.FILTER_NOT_PHYSICAL,
    promptHint:
      "用户要求筛选/搜索/统计/排序某字段时，该字段必须走物理列；先使用 db_schema add_field，再生成 page_dsl add_filter 和 api_dsl 相关变更。禁止在 filters/select/where/allowedFields 中写 ext_json->>'xxx' 表达式，只能写字段名。",
    triggers: ["筛选", "搜索", "按...查询", "统计", "排序"],
  },
  {
    code: "extjson_first_storage",
    title: "普通展示/编辑字段默认存 ext_json",
    scope: "field_storage",
    errorCode: HarnessErrorCode.FIELD_ECHO_MISSING,
    promptHint:
      "新增展示/编辑字段（地址、备注）默认存 ext_json，不新增物理列；但必须保证列表显示、详情回显、编辑保存：生成 page_dsl add_column/add_modal_field，并让 query/detail/create/update API 允许该字段。一旦用户同时要求筛选/搜索/排序/统计，必须改为物理列。",
    triggers: ["增加字段", "新增列", "加一个", "备注", "地址"],
  },
  {
    code: "physical_for_mixed_requirements",
    title: "展示+筛选/排序/统计时必须整体走物理列",
    scope: "field_storage",
    errorCode: HarnessErrorCode.FILTER_NOT_PHYSICAL,
    promptHint:
      "若用户同时要求'展示/编辑某字段'和'筛选/搜索/排序/统计该字段'，该字段必须整体作为物理列，先 db_schema add_field，再生成 page_dsl 展示与筛选。不能因为默认 ext_json 策略而忽略筛选需求。",
    triggers: ["增加列并筛选", "加字段并搜索", "显示并能查询", "展示并筛选"],
  },
  {
    code: "report_real_source_fields",
    title: "报表口径必须来自真实表与字段",
    scope: "report",
    errorCode: HarnessErrorCode.REPORT_FIELD_MISSING,
    promptHint:
      "report_dsl 的 sourceTable/dimensions/metrics.field/filters.field 必须是已加载 SKILL.md 与表结构里的真实物理字段；不要因字段名相似跨功能用不相关表，名称展示交给 displayKey/外键。",
    triggers: ["报表", "统计", "汇总", "看板", "排行", "排名"],
  },
  {
    code: "report_tenant_scope",
    title: "租户报表维度必须含 organization_id",
    scope: "report",
    errorCode: HarnessErrorCode.REPORT_FIELD_MISSING,
    promptHint: "租户级报表 dimensions 必须包含 organization_id 以保证校区/租户隔离，并默认带时间范围 filters。",
    triggers: ["校区报表", "各校区", "按校区统计"],
  },
  {
    code: "import_single_toolbar",
    title: "导入只生成 import_dsl，不重复加导入按钮",
    scope: "import",
    errorCode: HarnessErrorCode.IMPORT_INVALID,
    promptHint:
      "导入只需 import_dsl(create_import)，系统自动补导入按钮；若必须改 toolbar，导入按钮唯一且 type=import、importConfig.apiCode 指向 .create（禁止 .query）。导入模板禁止包含 id/created_at 等系统字段。",
    triggers: ["导入", "Excel 导入", "批量导入"],
  },
  {
    code: "export_toolbar_action",
    title: "导出用 export action 指向 query API",
    scope: "export",
    errorCode: HarnessErrorCode.EXPORT_INVALID,
    promptHint: "导出用 page_dsl add_toolbar，type=export、actionType=export、apiCode 指向当前页 .query；禁止用 execute_api 指向 create/update。",
    triggers: ["导出", "下载列表", "导出 Excel"],
  },
  {
    code: "declarative_validation_rule",
    title: "新增业务校验用声明式 validation 规则，运行时真实拦截",
    scope: "business_rule",
    errorCode: HarnessErrorCode.BUSINESS_RULE_INVALID,
    promptHint:
      "新增业务限制/校验（如单次扣课时上限、学员状态门槛、每日排课上限）用 business_rule(create_business_rule)，category=validation + validations 数组；解释器在业务命令前逐条求值，不通过则阻断。字段可引用入参、data.xxx、context.<student|contract|contract_product|course|product|organization>.<列>；计数上限用 type=count_limit；只能收紧不能放宽引擎内置防护。",
    triggers: ["限制", "不允许", "上限", "不能超过", "必须满足", "才能", "校验", "拦截"],
  },
  {
    code: "permission_via_policy",
    title: "权限变更必须走 permission_policy",
    scope: "permission",
    errorCode: HarnessErrorCode.PERMISSION_INVALID,
    promptHint:
      `权限调整用 permission_policy(modify_permission)，禁止直接改 role_resource；dataPermission 在 ${DATA_PERMISSION_ENUM_TEXT} 中选，roleCode 用当前租户已有角色编码。`,
    triggers: ["权限", "只能看自己", "隐藏字段", "角色"],
  },
];

export const EDU_RULES_BY_CODE: Record<string, EduRule> = Object.fromEntries(EDU_RULES.map((rule) => [rule.code, rule]));

/** 渲染为可追加到 prompt 的规则提示段（供后续逐步迁移；当前不强制使用）。 */
export function renderEduRulesPromptSection(): string {
  return ["## 教务规则速查", ...EDU_RULES.map((rule) => `- 【${rule.code}】${rule.promptHint}`)].join("\n");
}
