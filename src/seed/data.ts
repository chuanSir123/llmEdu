import bcrypt from "bcryptjs";
import { env } from "../config/env.js";
import { dictionaryItemId, DICTIONARY_FIELD_ALIASES, SYSTEM_DICTIONARIES } from "../dictionary.service.js";
import { businessRuleEditorSchema } from "../business-rule-editor-schema.js";
import { inferForeignKeyMeta } from "../common/foreign-key-meta.js";

export const modules = [
  ["frontdesk", "前台", "business", "快速入口、待办和检索", 10, "LayoutDashboard"],
  ["recruit", "招生", "business", "意向学员、跟进和转化", 20, "Megaphone"],
  ["student", "学员", "business", "学员档案和回访", 30, "GraduationCap"],
  ["education", "教务", "business", "排课、上课和扣费", 40, "CalendarDays"],
  ["finance", "财务", "business", "收款、分配和退费", 50, "Wallet"],
  ["marketing", "营销", "business", "公众号、微商城、活动和微信推送", 55, "ShoppingBag"],
  ["oa", "OA", "business", "通知、审批和任务", 60, "Bell"],
  ["report", "报表", "business", "经营数据分析", 70, "BarChart3"],
  ["system", "系统", "business", "组织、角色和权限", 80, "Settings"],
  ["ai_agent", "AI 工程化", "platform", "自然语言变更任务", 90, "Bot"],
] as const;

type Field = {
  key: string;
  label: string;
  type?: string;
  sortable?: boolean;
  filter?: boolean;
  optionApi?: string;
  width?: number;
  align?: "left" | "center" | "right";
  badge?: boolean;
  hidden?: boolean;
  span?: 1 | 2 | 3 | "full";
  defaultValue?: unknown;
  defaultFutureOnly?: boolean;
  required?: boolean;
  maxRangeDays?: number;
  defaultRange?: "current_month";
  field?: string;
  dictCode?: string;
};

type PageSeed = {
  module: string;
  feature: string;
  page: string;
  name: string;
  table: string;
  group?: string;
  fields: Field[];
  joins?: unknown[];
  fixedFilters?: Array<{ field: string; op?: "eq" | "ne"; value?: unknown; valueFromParam?: string }>;
  sort?: string;
  apiFilters?: string[];
  commands?: Partial<Record<"create", { command: string; ruleCode: string }>>;
  softDelete?: boolean;
  apiSchema?: string;
};

const statusFields = new Set([
  "status",
  "student_status",
  "paid_status",
  "contract_status",
  "course_status",
  "charge_status",
  "attendance_status",
  "refund_type",
  "funds_type",
  "staff_type",
  "mode"
]);

const longTextFields = new Set(["content", "remark", "change_summary", "user_prompt", "follow_content"]);

const pageSubtitles: Record<string, string> = {
  frontdesk_home: "汇总今日待办、学员检索和关键运营入口",
  student_list: "统一维护学员档案、校区归属、学校年级和跟进入口",
  contract_list: "跟踪合同状态、应收实收和付款进度",
  course_list: "查看课程安排、上课时间和课程状态",
  funds_history: "核对收款流水、支付方式和交易时间",
  product_list: "维护课程产品、课时、单价和启用状态",
  dsl_version: "查看 DSL 版本、发布状态和变更摘要",
  tenant_version_list: "查看版本历史、回滚和发布操作",
  tenant_manage: "管理机构租户、到期状态和负责人信息"
};

function dictionaryToneMap(dictCode: string) {
  return Object.fromEntries(
    Object.entries(SYSTEM_DICTIONARIES[dictCode] ?? {})
      .map(([itemValue, item]) => [dictionaryItemId(dictCode, itemValue), String(item.metadata?.tone ?? "")])
      .filter(([, tone]) => Boolean(tone))
  );
}

const statusMap = Object.fromEntries(
  ["student_status", "paid_status", "contract_status", "course_status", "charge_status", "attendance_status", "status", "mode"]
    .map((dictCode) => [dictCode, dictionaryToneMap(dictCode)])
    .filter(([, tones]) => Object.keys(tones).length > 0)
);

const valueLabels = Object.fromEntries(
  Object.entries(SYSTEM_DICTIONARIES).map(([dictCode, items]) => [
    dictCode,
    Object.fromEntries(Object.entries(items).map(([itemValue, item]) => [dictionaryItemId(dictCode, itemValue), item.label]))
  ])
) as Record<string, Record<string, string>>;


const extraDictionaryFieldKeys = [
  "organization_type", "channel_type", "trial_status", "conversion_status", "task_type", "task_status", "follow_result",
  "account_type", "leave_type", "holiday_type", "performance_type", "goods_status", "activity_type", "group_status",
  "member_status", "order_status", "payment_status", "fulfillment_status", "service_type", "binding_type", "authorized_status",
  "publish_status", "subscribe_status", "send_status", "reward_status", "action_type", "api_type", "cost_type",
  "pay_type", "receiver_scope", "resource_type", "organization_scope", "target_status", "business_rule_category", "business_type"
];
const dictionaryFieldKeys = new Set([...Object.keys(valueLabels), ...extraDictionaryFieldKeys]);
function dictCodeForField(field: { key: string; dictCode?: string }) {
  return field.dictCode ?? DICTIONARY_FIELD_ALIASES[field.key] ?? (dictionaryFieldKeys.has(field.key) ? field.key : undefined);
}


function dictionaryOption(dictCode: string) {
  return { type: "dictionary" as const, apiCode: "dictionary.options", dictCode, valueField: "value", labelField: "label" };
}

function dictionaryDefault(dictCode: string, itemValue: unknown) {
  return dictionaryItemId(dictCode, itemValue);
}

function normalizeDictionaryDefault(fieldKey: string, rawValue: unknown) {
  const dictCode = dictCodeForField({ key: fieldKey });
  if (!dictCode || rawValue === undefined || rawValue === null || typeof rawValue === "object") return rawValue;
  return dictionaryDefault(dictCode, rawValue);
}

function normalizeDictionaryMap(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  return Object.fromEntries(Object.entries(raw as Record<string, unknown>).map(([fieldKey, fieldValue]) => [fieldKey, normalizeDictionaryDefault(fieldKey, fieldValue)]));
}

export function enhanceDictionaryFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => enhanceDictionaryFields(item));
  if (!value || typeof value !== "object") return value;
  const obj = { ...(value as Record<string, unknown>) };
  const key = typeof obj.key === "string" ? obj.key : "";
  const dictCode = typeof obj.dictCode === "string" ? obj.dictCode : key ? dictCodeForField({ key }) : undefined;
  if (dictCode) {
    obj.dictCode = obj.dictCode ?? dictCode;
    obj.optionSource = obj.optionSource ?? dictionaryOption(dictCode);
    obj.type = obj.type ?? "select";
    if ("defaultValue" in obj) obj.defaultValue = normalizeDictionaryDefault(key, obj.defaultValue);
  }
  if ("defaultValues" in obj) obj.defaultValues = normalizeDictionaryMap(obj.defaultValues);
  if ("visibleWhen" in obj) obj.visibleWhen = normalizeDictionaryMap(obj.visibleWhen);
  for (const [childKey, childValue] of Object.entries(obj)) {
    if (childKey === "optionSource" || childKey === "defaultValue" || childKey === "defaultValues" || childKey === "visibleWhen") continue;
    obj[childKey] = enhanceDictionaryFields(childValue);
  }
  return obj;
}


const studentSelect = { pageCode: "student_list", apiCode: "student_list.query", labelField: "name" };
const allStudentSelect = { pageCode: "frontdesk_home", apiCode: "frontdesk_home.query", labelField: "name" };
const orgSelect = { pageCode: "organization_list", apiCode: "organization_list.query", labelField: "name" };
const userSelect = { pageCode: "user_list", apiCode: "user_list.query", labelField: "name" };
const payWaySelect = { pageCode: "pay_way_list", apiCode: "pay_way_list.query", labelField: "name" };
const productSelect = { pageCode: "product_list", apiCode: "product_list.query", labelField: "name", filters: { status: "ACTIVE" } };
const promotionSelect = { pageCode: "promotion_list", apiCode: "promotion_list.query", labelField: "name", filters: { status: "ACTIVE" } };
const contractSelect = { pageCode: "contract_list", apiCode: "contract_list.query", labelField: "contract_no" };
const contractProductSelect = { pageCode: "contract_product_list", apiCode: "contract_product_list.query", labelField: "product_name" };
const miniClassSelect = { pageCode: "mini_class_list", apiCode: "mini_class_list.query", labelField: "name" };
const oneOnNGroupSelect = { pageCode: "one_on_n_group_list", apiCode: "one_on_n_group_list.query", labelField: "name" };
const channelSelect = { pageCode: "recruit_channel_list", apiCode: "recruit_channel_list.query", labelField: "channel_name" };
const mallActivitySelect = { pageCode: "mall_activity", apiCode: "mall_activity.query", labelField: "activity_name" };
const couponClaimSelect = { pageCode: "coupon_claim_list", apiCode: "coupon_claim_list.query", labelField: "coupon_code" };
const derivedArrangePages = new Set(["money_arrange_list", "promotion_arrange_list", "performance_arrange_list"]);
const readOnlyPages = new Set(["money_arrange_list", "promotion_arrange_list", "performance_arrange_list", "student_ele_account", "student_ele_account_record"]);
const standardImportPageCodes = new Set(["student_list", "contract_list", "funds_history", "course_list", "charge_record", "refund_record"]);

const businessTimeFieldCandidates = [
  "course_date",
  "transaction_time",
  "sign_time",
  "refund_time",
  "created_at",
  "updated_at",
  "published_at",
  "claim_time",
  "used_at",
  "cost_date",
  "target_month",
  "trial_time",
  "next_follow_time"
];

function businessTimeField(page: Pick<PageSeed, "fields" | "table">) {
  const fieldKeys = new Set(page.fields.map((field) => field.key));
  return businessTimeFieldCandidates.find((field) => fieldKeys.has(field)) ?? "created_at";
}


function shouldDefaultFilter(field: Field) {
  if (field.filter) return true;
  if (field.hidden) return false;
  const dictCode = dictCodeForField(field);
  if (dictCode && (statusFields.has(field.key) || field.key.endsWith("_type") || field.key.endsWith("_status"))) return true;
  if (inferForeignKeyMeta(field.key)) return true;
  return ["name", "title", "contact", "contract_no", "order_no", "coupon_code", "course_title", "task_title", "channel_name", "activity_name", "goods_name", "page_title", "rule_name", "flow_name"].includes(field.key);
}

function filterLabelFor(page: PageSeed, field: Field) {
  if (!inferForeignKeyMeta(field.key)) return field.label;
  const displayKey = inferForeignKeyMeta(field.key)?.displayKey;
  const displayField = page.fields.find((item) => item.key === displayKey && !item.hidden);
  if (displayField) return displayField.label;
  return field.label.replace(/ID$/, "").replace(/id$/i, "").trim() || field.label;
}

function apiFiltersFor(page: PageSeed) {
  const timeField = businessTimeField(page);
  const filters: Array<string | { key: string; field: string; type?: string; op?: "eq" | "ilike" | "between" | "in" | "gt" | "gte" | "lt" | "lte"; dictCode?: string; optionSource?: Record<string, unknown> }> = [
    { key: timeField, field: timeField, type: "date_range", op: "between" }
  ];
  for (const field of page.fields.filter((item) => shouldDefaultFilter(item) && item.key !== timeField)) {
    const dictCode = dictCodeForField(field);
    // ID 类过滤（跨页跳转/详情区块联动）必须精确匹配，ilike 子串匹配会把 100001 误命中 1000012
    const isIdFilter = field.key === "id" || field.key.endsWith("_id");
    filters.push({
      key: field.key,
      field: field.field ?? field.key,
      type: dictCode ? "select" : field.type ?? "text",
      op: dictCode || isIdFilter ? "eq" : field.type === "date" ? "eq" : "ilike",
      ...(dictCode ? { dictCode, optionSource: dictionaryOption(dictCode) } : {})
    });
  }
  for (const key of page.apiFilters ?? []) {
    if (filters.some((filter) => (typeof filter === "string" ? filter : filter.key) === key)) continue;
    // ID 类过滤精确匹配（字符串形态在查询引擎里默认 ilike，会出现子串误命中）
    filters.push(key === "id" || key.endsWith("_id") ? { key, field: key, op: "eq" } : key);
  }
  return filters;
}

function optionSourceForField(field: Field) {
  const meta = inferForeignKeyMeta(field.key);
  if (meta) return { pageCode: meta.pageCode, apiCode: meta.apiCode, labelField: meta.labelField };
  return undefined;
}

function fieldComponent(field: Field) {
  const base = isLongTextField(field)
    ? { type: "textarea", span: "full" as const, rows: 4 }
    : { type: field.type ?? "text" };
  const optionSource = optionSourceForField(field) ?? (
    field.key === "student_id"
      ? studentSelect
      : field.key === "organization_id"
        ? orgSelect
        : field.key.endsWith("staff_id") || field.key.endsWith("teacher_id") || field.key.endsWith("user_id")
          ? userSelect
          : field.key === "contract_id"
            ? contractSelect
            : field.key === "contract_product_id"
              ? contractProductSelect
              : field.key === "pay_way_config_id" || field.key === "refund_way_config_id"
                ? payWaySelect
                : field.key === "mini_class_id"
                  ? miniClassSelect
                  : field.key === "one_on_n_group_id"
                    ? oneOnNGroupSelect
                    : undefined);
  const dictCode = dictCodeForField(field);
  const dictionary = dictCode ? { dictCode, optionSource: dictionaryOption(dictCode) } : {};
  return optionSource ? { ...base, ...dictionary, optionSource } : { ...base, ...dictionary };
}

const contractCreateFields = [
  { key: "student_ids", label: "选择学员", type: "multiSelect", span: 2 as const, optionSource: allStudentSelect, searchable: true, required: true },
  { key: "product_ids", label: "报读课程", type: "multiSelect", span: 2 as const, optionSource: { ...productSelect, includeRow: true }, searchable: true, required: true },
  { key: "promotion_id", label: "合同优惠", type: "text", optionSource: { ...promotionSelect, includeRow: true }, searchable: true },
  { key: "contract_type", label: "合同类型", type: "text", defaultValue: "NEW_SIGN" },
  { key: "organization_id", label: "校区", type: "text", optionSource: orgSelect, searchable: true },
  { key: "sign_staff_id", label: "签约人", type: "text", optionSource: userSelect, searchable: true },
  { key: "sign_time", label: "签约时间", type: "datetime" },
  { key: "remark", label: "备注", type: "textarea", span: "full" as const, rows: 3 }
];

const preStoreFields = [
  { key: "student_id", label: "学员", type: "text", optionSource: studentSelect, required: true },
  { key: "organization_id", label: "校区", type: "text", optionSource: orgSelect },
  { key: "transaction_amount", label: "预存金额", type: "number", required: true, min: 0.01 },
  { key: "pay_way_config_id", label: "支付方式", type: "text", optionSource: payWaySelect },
  { key: "transaction_time", label: "收款时间", type: "datetime" },
  { key: "remark", label: "备注", type: "textarea", span: "full" as const, rows: 3 }
];

const contextPreStoreFields = [
  { key: "student_id", label: "学员", type: "text", hidden: true },
  { key: "student_name", label: "学员", type: "text", readonly: true },
  ...preStoreFields.filter((field) => !["student_id"].includes(field.key))
];

const followupCreateFields = [
  { key: "student_id", label: "学员", type: "text", hidden: true },
  { key: "follow_type", label: "跟进方式", type: "text", defaultValue: "PHONE" },
  { key: "follow_result", label: "跟进结果", type: "text", defaultValue: "CONTACTED" },
  { key: "follow_content", label: "跟进内容", type: "textarea", span: "full" as const, rows: 4 },
  { key: "next_follow_time", label: "下次跟进时间", type: "datetime" }
];

const leadCreateFields = [
  { key: "name", label: "学员姓名", type: "text", required: true },
  { key: "contact", label: "联系电话", type: "text", required: true },
  { key: "organization_id", label: "校区", type: "text", optionSource: orgSelect, searchable: true },
  { key: "owner_user_id", label: "招生顾问", type: "text", optionSource: userSelect, searchable: true },
  { key: "channel_id", label: "招生渠道", type: "text" },
  { key: "source_type", label: "来源", type: "text", defaultValue: "MANUAL" },
  { key: "school_name", label: "学校", type: "text" },
  { key: "grade", label: "年级", type: "text" },
  { key: "next_follow_time", label: "下次跟进时间", type: "datetime" },
  { key: "remark", label: "备注", type: "textarea", span: "full" as const, rows: 3 }
];

const trialLessonCreateFields = [
  { key: "student_id", label: "学员", type: "text", hidden: true },
  { key: "course_title", label: "试听课程", type: "text", required: true },
  { key: "trial_time", label: "试听时间", type: "datetime", required: true },
  { key: "teacher_id", label: "试听老师", type: "text", optionSource: userSelect, searchable: true },
  { key: "sales_user_id", label: "邀约顾问", type: "text", optionSource: userSelect, searchable: true },
  { key: "organization_id", label: "校区", type: "text", optionSource: orgSelect, searchable: true },
  { key: "course_hour", label: "试听课时", type: "number", defaultValue: 1 },
  { key: "remark", label: "备注", type: "textarea", span: "full" as const, rows: 3 }
];


const couponClaimFields = [
  { key: "coupon_template_id", label: "优惠券模板", type: "text", hidden: true },
  { key: "student_id", label: "领取学员", type: "text", optionSource: studentSelect, searchable: true, required: true },
  { key: "source", label: "领取来源", type: "text", defaultValue: "manual" }
];

const landingLeadSubmitFields = [
  { key: "page_id", label: "落地页", type: "text", hidden: true },
  { key: "name", label: "学员姓名", type: "text", required: true },
  { key: "contact", label: "联系电话", type: "text", required: true },
  { key: "channel_id", label: "投放渠道", type: "text", optionSource: channelSelect, searchable: true },
  { key: "school_name", label: "学校", type: "text" },
  { key: "grade", label: "年级", type: "text" },
  { key: "referrer_student_id", label: "推荐人", type: "text", optionSource: studentSelect, searchable: true }
];

const channelCostFields = [
  { key: "channel_id", label: "招生渠道", type: "text", hidden: true },
  { key: "cost_date", label: "投放日期", type: "date", required: true },
  { key: "cost_amount", label: "投放成本", type: "number", required: true },
  { key: "cost_type", label: "成本类型", type: "text", defaultValue: "ONLINE_ADS" },
  { key: "remark", label: "备注", type: "textarea", span: "full" as const, rows: 3 }
];

const leadAssignFields = [
  { key: "student_id", label: "意向学员", type: "text", hidden: true },
  { key: "owner_user_id", label: "分配顾问", type: "text", optionSource: userSelect, searchable: true, required: true },
  { key: "reason", label: "分配原因", type: "textarea", span: "full" as const, rows: 3 }
];

const trialFeedbackFields = [
  { key: "id", label: "试听记录", type: "text", hidden: true },
  { key: "trial_status", label: "试听状态", type: "text", defaultValue: "COMPLETED" },
  { key: "conversion_status", label: "转化状态", type: "text", defaultValue: "PENDING" },
  { key: "feedback", label: "试听反馈", type: "textarea", span: "full" as const, rows: 3 }
];



const wechatBindStudentFields = [
  { key: "binding_id", label: "公众号绑定", type: "text", hidden: true },
  { key: "openid", label: "OpenID", type: "text", hidden: true },
  { key: "student_id", label: "绑定学员", type: "text", optionSource: studentSelect, searchable: true, required: true },
  { key: "student_name", label: "学员姓名校验", type: "text" },
  { key: "phone_last4", label: "手机号后四位", type: "text", required: true }
];

const mallOrderCreateFields = [
  { key: "goods_id", label: "商品", type: "text", hidden: true },
  { key: "activity_id", label: "活动", type: "text", optionSource: mallActivitySelect, searchable: true },
  { key: "student_id", label: "下单学员", type: "text", optionSource: studentSelect, searchable: true, required: true },
  { key: "quantity", label: "购买数量", type: "number", defaultValue: 1 },
  { key: "coupon_claim_id", label: "使用优惠券", type: "text", optionSource: couponClaimSelect, searchable: true }
];

const fundsCreateFields = [
  { key: "contract_id", label: "合同", type: "text", optionSource: contractSelect },
  { key: "student_id", label: "学员", type: "text", optionSource: studentSelect },
  { key: "organization_id", label: "校区", type: "text", optionSource: orgSelect },
  { key: "transaction_amount", label: "收款金额", type: "number", required: true, min: 0.01 },
  { key: "pay_way_config_id", label: "支付方式", type: "text", optionSource: payWaySelect, required: true },
  { key: "transaction_time", label: "收款时间", type: "datetime" },
  { key: "funds_type", label: "流水类型", type: "text" },
  { key: "remark", label: "备注", type: "textarea", span: "full" as const, rows: 3 }
];

const contractFundsFields = [
  { key: "contract_id", label: "合同ID", type: "text", hidden: true },
  { key: "student_id", label: "学员ID", type: "text", hidden: true },
  { key: "organization_id", label: "校区ID", type: "text", hidden: true },
  { key: "funds_type", label: "流水类型", type: "text", hidden: true },
  { key: "contract_no", label: "合同号", type: "text", readonly: true },
  { key: "student_name", label: "学员", type: "text", readonly: true },
  { key: "organization_name", label: "校区", type: "text", readonly: true },
  ...fundsCreateFields.filter((field) => !["contract_id", "student_id", "organization_id", "funds_type"].includes(field.key))
];

const fundsVoidFields = [
  { key: "id", label: "收款记录", type: "text", hidden: true },
  { key: "void_reason", label: "作废原因", type: "textarea", required: true, span: "full" as const, rows: 3 }
];

const classTransferFields = [
  { key: "target_type", label: "调班类型", type: "text", defaultValue: "mini_class" },
  { key: "from_target_id", label: "原班级/小组ID", type: "text", required: true },
  { key: "to_target_id", label: "目标班级/小组ID", type: "text", required: true },
  { key: "student_ids", label: "调班学员", type: "multiSelect", span: "full" as const, optionSource: studentSelect, searchable: true },
  { key: "reason", label: "调班原因", type: "textarea", span: "full" as const, rows: 3 }
];

const performanceAdjustFields = [
  { key: "contract_product_id", label: "合同产品", type: "text", optionSource: contractProductSelect },
  { key: "funds_change_history_id", label: "关联收款", type: "text", optionSource: { pageCode: "funds_history", apiCode: "funds_history.query", labelField: "id" } },
  { key: "performance_type", label: "业绩类型", type: "text", defaultValue: "MANUAL_ADJUST" },
  { key: "organization_performance_organization_id", label: "校区业绩归属", type: "text", optionSource: orgSelect },
  { key: "organization_performance_amount", label: "校区业绩金额", type: "number" },
  { key: "personal_performance_user_id", label: "个人业绩归属", type: "text", optionSource: userSelect },
  { key: "personal_performance_amount", label: "个人业绩金额", type: "number" },
  { key: "organization_id", label: "业务校区", type: "text", optionSource: orgSelect },
  { key: "source_type", label: "调整来源", type: "text", defaultValue: "MANUAL_ADJUSTMENT" },
  { key: "source_id", label: "来源单据ID", type: "text" },
  { key: "adjustment_reason", label: "调整原因", type: "textarea", required: true, span: "full" as const, rows: 3 },
  { key: "items", label: "多人分摊", type: "performance_split_table", span: "full" as const }
];

const courseCreateFields = [
  { key: "course_title", label: "课程名称", type: "text", span: 2 as const },
  { key: "course_type", label: "课程类型", type: "text" },
  { key: "course_dates", label: "上课日期", type: "multiDate", span: 2 as const, defaultFutureOnly: true, required: true },
  { key: "course_date", label: "单次日期", type: "date", hidden: true },
  { key: "start_time", label: "开始时间", type: "time", required: true },
  { key: "end_time", label: "结束时间", type: "time", required: true },
  { key: "teacher_id", label: "老师", type: "text", optionSource: userSelect },
  { key: "study_manager_id", label: "学管师", type: "text", optionSource: userSelect },
  { key: "mini_class_id", label: "班级", type: "text", optionSource: miniClassSelect, visibleWhen: { course_type: "SMALL_CLASS" } },
  { key: "one_on_n_group_id", label: "1对N小组", type: "text", optionSource: oneOnNGroupSelect, visibleWhen: { course_type: "ONE_ON_N_GROUP" } },
  { key: "product_id", label: "排课产品", type: "text", optionSource: productSelect },
  { key: "grade", label: "年级", type: "text" },
  { key: "subject", label: "科目", type: "text" },
  { key: "students", label: "上课学员", type: "student_cp_table", span: "full" as const, optionSource: studentSelect, visibleWhen: { course_type: { op: "notIn", value: ["SMALL_CLASS", "ONE_ON_N_GROUP"] } } },
  { key: "organization_id", label: "校区", type: "text", optionSource: orgSelect },
  { key: "course_hour", label: "课时", type: "number" }
];

// 编辑排课：单次课程改期改时，不提供批量日期；学员调整走 student_ids（后端 course.update 校验考勤/扣费防护）
const courseEditFields = [
  { key: "course_title", label: "课程名称", type: "text", span: 2 as const },
  { key: "course_type", label: "课程类型", type: "text" },
  { key: "course_date", label: "上课日期", type: "date", required: true },
  { key: "start_time", label: "开始时间", type: "time", required: true },
  { key: "end_time", label: "结束时间", type: "time", required: true },
  { key: "teacher_id", label: "老师", type: "text", optionSource: userSelect },
  { key: "study_manager_id", label: "学管师", type: "text", optionSource: userSelect },
  { key: "students", label: "上课学员", type: "student_cp_table", span: "full" as const, optionSource: studentSelect, visibleWhen: { course_type: { op: "notIn", value: ["SMALL_CLASS", "ONE_ON_N_GROUP"] } } },
  { key: "organization_id", label: "校区", type: "text", optionSource: orgSelect },
  { key: "course_hour", label: "课时", type: "number", min: 0 }
];

const chargeCreateFields = [
  { key: "course_id", label: "课程", type: "text", optionSource: { pageCode: "course_list", apiCode: "course_list.query", labelField: "course_title" } },
  { key: "student_id", label: "学员", type: "text", optionSource: studentSelect, required: true },
  { key: "contract_product_id", label: "合同产品", type: "text", optionSource: contractProductSelect, required: true },
  { key: "organization_id", label: "校区", type: "text", optionSource: orgSelect },
  { key: "charge_type", label: "扣费类型", type: "text" },
  { key: "charge_hour", label: "扣课时", type: "number", min: 0 },
  { key: "charge_amount", label: "扣费金额", type: "number", min: 0 }
];

const chargeReverseFields = [
  { key: "id", label: "扣费记录", type: "text", hidden: true },
  { key: "cancel_reason", label: "取消原因", type: "textarea", required: true, span: "full" as const, rows: 3 }
];

const refundCreateFields = [
  { key: "refund_type", label: "退费类型", type: "text", defaultValue: "CONTRACT_PRODUCT", helpText: "合同产品部分退费；整单退费请从合同列表发起" },
  { key: "student_id", label: "学员", type: "text", optionSource: studentSelect, required: true },
  { key: "contract_product_id", label: "合同产品", type: "text", optionSource: contractProductSelect, required: true },
  { key: "available_refund_real_hour", label: "可退课时", type: "number", computed: true },
  { key: "available_refund_real_amount", label: "可退金额", type: "number", computed: true },
  { key: "available_refund_promotion_hour", label: "可退赠课时", type: "number", computed: true },
  { key: "available_refund_promotion_amount", label: "可退优惠金额", type: "number", computed: true },
  { key: "refund_real_hour", label: "退课时", type: "number", min: 0 },
  { key: "refund_real_amount", label: "退金额", type: "number", min: 0 },
  { key: "refund_promotion_amount", label: "退优惠金额", type: "number", min: 0 },
  { key: "refund_promotion_hour", label: "退赠课时", type: "number", min: 0 },
  { key: "refund_way_config_id", label: "退费方式", type: "text", optionSource: payWaySelect, required: true },
  { key: "refund_time", label: "退费时间", type: "datetime" },
  { key: "remark", label: "备注", type: "textarea", span: "full" as const, rows: 3 }
];

export const standardImportConfigs = [
  {
    importCode: "student_list.import",
    importName: "学员导入",
    module: "student",
    feature: "student_list",
    dsl: {
      pageCode: "student_list",
      apiCode: "student_list.create",
      title: "学员导入模板",
      duplicateStrategy: "insert",
      fields: [
        { key: "name", label: "学员姓名", required: true },
        { key: "contact", label: "联系电话" },
        { key: "organization_id", label: "校区", required: true, optionSource: orgSelect },
        { key: "student_status", label: "状态", required: true, valueLabels: valueLabels.student_status },
        { key: "school_name", label: "学校" },
        { key: "grade", label: "年级" },
        { key: "remark", label: "备注" }
      ]
    }
  },
  {
    importCode: "contract_list.import",
    importName: "合同导入",
    module: "finance",
    feature: "contract_list",
    dsl: {
      pageCode: "contract_list",
      apiCode: "contract_list.create",
      title: "合同导入模板",
      duplicateStrategy: "insert",
      fields: [
        { key: "student_id", label: "学员", required: true, optionSource: allStudentSelect },
        { key: "product_ids", label: "报读课程", type: "multiSelect", required: true, optionSource: productSelect },
        { key: "promotion_id", label: "合同优惠", optionSource: promotionSelect },
        { key: "contract_type", label: "合同类型", valueLabels: valueLabels.contract_type },
        { key: "organization_id", label: "校区", required: true, optionSource: orgSelect },
        { key: "sign_staff_id", label: "签约人", optionSource: userSelect },
        { key: "sign_time", label: "签约时间", type: "datetime" },
        { key: "remark", label: "备注" }
      ]
    }
  },
  {
    importCode: "funds_history.import",
    importName: "收款导入",
    module: "finance",
    feature: "funds_history",
    dsl: {
      pageCode: "funds_history",
      apiCode: "funds_history.create",
      title: "收款导入模板",
      duplicateStrategy: "insert",
      fields: [
        { key: "contract_id", label: "合同", optionSource: contractSelect },
        { key: "student_id", label: "学员", required: true, optionSource: studentSelect },
        { key: "organization_id", label: "校区", required: true, optionSource: orgSelect },
        { key: "transaction_amount", label: "收款金额", type: "number", required: true },
        { key: "pay_way_config_id", label: "支付方式", required: true, optionSource: payWaySelect },
        { key: "transaction_time", label: "收款时间", type: "datetime" },
        { key: "funds_type", label: "流水类型", required: true, valueLabels: valueLabels.funds_type },
        { key: "remark", label: "备注" }
      ]
    }
  },
  {
    importCode: "course_list.import",
    importName: "排课导入",
    module: "education",
    feature: "course_list",
    dsl: {
      pageCode: "course_list",
      apiCode: "course_list.create",
      title: "排课导入模板",
      duplicateStrategy: "insert",
      fields: [
        { key: "course_title", label: "课程名称", required: true },
        { key: "course_type", label: "课程类型", required: true, valueLabels: valueLabels.course_type },
        { key: "course_date", label: "上课日期", type: "date", required: true },
        { key: "start_time", label: "开始时间", type: "time", required: true },
        { key: "end_time", label: "结束时间", type: "time", required: true },
        { key: "teacher_id", label: "老师", required: true, optionSource: userSelect },
        { key: "study_manager_id", label: "学管师", optionSource: userSelect },
        { key: "student_id", label: "上课学员", required: true, optionSource: studentSelect },
        { key: "contract_product_id", label: "合同产品", optionSource: contractProductSelect },
        { key: "organization_id", label: "校区", required: true, optionSource: orgSelect },
        { key: "course_hour", label: "课时", type: "number", required: true }
      ]
    }
  },
  {
    importCode: "charge_record.import",
    importName: "扣费导入",
    module: "education",
    feature: "charge_record",
    dsl: {
      pageCode: "charge_record",
      apiCode: "charge_record.create",
      title: "扣费导入模板",
      duplicateStrategy: "insert",
      fields: [
        { key: "course_id", label: "课程", required: true, optionSource: { pageCode: "course_list", apiCode: "course_list.query", labelField: "course_title" } },
        { key: "student_id", label: "学员", required: true, optionSource: studentSelect },
        { key: "contract_product_id", label: "合同产品", required: true, optionSource: contractProductSelect },
        { key: "organization_id", label: "校区", required: true, optionSource: orgSelect },
        { key: "charge_type", label: "扣费类型", required: true, valueLabels: valueLabels.charge_type },
        { key: "charge_hour", label: "扣课时", type: "number", required: true },
        { key: "charge_amount", label: "扣费金额", type: "number", required: true }
      ]
    }
  },
  {
    importCode: "refund_record.import",
    importName: "退费导入",
    module: "finance",
    feature: "refund_record",
    dsl: {
      pageCode: "refund_record",
      apiCode: "refund_record.create",
      title: "退费导入模板",
      duplicateStrategy: "insert",
      fields: [
        { key: "student_id", label: "学员", required: true, optionSource: studentSelect },
        { key: "contract_product_id", label: "合同产品", required: true, optionSource: contractProductSelect },
        { key: "refund_real_hour", label: "退课时", type: "number" },
        { key: "refund_real_amount", label: "退金额", type: "number", required: true },
        { key: "refund_promotion_amount", label: "退优惠金额", type: "number" },
        { key: "refund_promotion_hour", label: "退赠课时", type: "number" },
        { key: "refund_way_config_id", label: "退费方式", required: true, optionSource: payWaySelect },
        { key: "refund_time", label: "退费时间", type: "datetime" },
        { key: "remark", label: "备注" }
      ]
    }
  }
] as const;

const contractRefundFields = [
  { key: "contract_id", label: "合同", type: "text", hidden: true },
  { key: "student_name", label: "学员", type: "text", readonly: true },
  { key: "refund_real_amount", label: "退费金额", type: "number", required: true },
  { key: "refund_promotion_amount", label: "退优惠金额", type: "number" },
  { key: "refund_real_hour", label: "退课时", type: "number" },
  { key: "refund_promotion_hour", label: "退赠课时", type: "number" },
  { key: "refund_way_config_id", label: "退费方式", type: "text", required: true, optionSource: payWaySelect },
  { key: "refund_time", label: "退费时间", type: "datetime" },
  { key: "remark", label: "备注", type: "textarea", span: "full" as const, rows: 3 }
];

const attendanceCheckInFields = [
  { key: "course_id", label: "课程", type: "text", hidden: true },
  { key: "students", label: "学员考勤", type: "attendance_table", span: "full" as const }
];

const leaveCreateFields = [
  { key: "course_id", label: "关联课程", type: "text", optionSource: { pageCode: "course_list", apiCode: "course_list.query", labelField: "course_title" } },
  { key: "student_id", label: "请假学员", type: "text", optionSource: studentSelect, required: true },
  { key: "leave_type", label: "请假类型", type: "text", defaultValue: "PERSONAL" },
  { key: "leave_time", label: "请假时间", type: "datetime" },
  { key: "status", label: "状态", type: "text", defaultValue: "APPROVED" },
  { key: "organization_id", label: "校区", type: "text", optionSource: orgSelect },
  { key: "leave_reason", label: "请假原因", type: "textarea", span: "full" as const, rows: 3 }
];

const makeupCreateFields = [
  { key: "original_course_id", label: "原课程", type: "text", optionSource: { pageCode: "course_list", apiCode: "course_list.query", labelField: "course_title" } },
  { key: "student_id", label: "补课学员", type: "text", optionSource: studentSelect, required: true },
  { key: "course_title", label: "补课标题", type: "text", defaultValue: "补课" },
  { key: "course_date", label: "补课日期", type: "date", defaultFutureOnly: true, required: true },
  { key: "start_time", label: "开始时间", type: "time", required: true },
  { key: "end_time", label: "结束时间", type: "time", required: true },
  { key: "teacher_id", label: "授课老师", type: "text", optionSource: userSelect },
  { key: "contract_product_id", label: "合同产品", type: "text", optionSource: contractProductSelect },
  { key: "organization_id", label: "校区", type: "text", optionSource: orgSelect },
  { key: "course_hour", label: "课时", type: "number", defaultValue: 1 },
  { key: "makeup_reason", label: "补课原因", type: "textarea", span: "full" as const, rows: 3 }
];

const holidayCreateFields = [
  { key: "name", label: "停课事项", type: "text", required: true },
  { key: "holiday_date", label: "开始日期", type: "date", required: true },
  { key: "end_date", label: "结束日期", type: "date" },
  { key: "organization_id", label: "适用校区", type: "text", optionSource: orgSelect },
  { key: "holiday_type", label: "类型", type: "text", defaultValue: "CAMPUS_CLOSED" },
  { key: "block_course", label: "禁止排课", type: "boolean", defaultValue: true },
  { key: "remark", label: "备注", type: "textarea", span: "full" as const, rows: 3 }
];

const addStudentFields = [
  { key: "mini_class_id", label: "班级", type: "text", hidden: true },
  { key: "one_on_n_group_id", label: "1对N小组", type: "text", hidden: true },
  { key: "student_ids", label: "选择学员", type: "multiSelect", span: "full" as const, optionSource: studentSelect, searchable: true }
];

function isLongTextField(field: Field) {
  return longTextFields.has(field.key) || field.key.includes("content") || field.key.includes("remark") || field.key.includes("summary") || field.key.includes("prompt");
}

function sortModalFields(fields: Field[]) {
  return [...fields].sort((a, b) => Number(isLongTextField(a)) - Number(isLongTextField(b)));
}

function columnWidth(field: Field) {
  if (field.width) return field.width;
  if (field.type === "datetime") return 180;
  if (field.type === "date") return 130;
  if (field.key.includes("amount") || field.key.includes("price") || field.key.includes("hour")) return 120;
  if (statusFields.has(field.key)) return 120;
  if (field.key.includes("content") || field.key.includes("summary") || field.key.includes("prompt")) return 260;
  if (field.key.includes("name") || field.key.includes("title")) return 180;
  return 150;
}

function columnAlign(field: Field) {
  if (field.align) return field.align;
  if (field.key.includes("amount") || field.key.includes("price") || field.key.includes("hour") || field.key === "version_no") return "right";
  if (statusFields.has(field.key)) return "center";
  return "left";
}

function metricsFor(page: PageSeed) {
  const metrics: Array<Record<string, unknown>> = [{ label: "记录总数", source: "total" }];
  const statusField = page.fields.find((field) => statusFields.has(field.key));
  if (statusField) {
    const defaultValue =
      statusField.key === "student_status"
        ? "FORMAL"
        : statusField.key === "paid_status"
          ? "PAID"
          : statusField.key === "course_status"
            ? "SCHEDULED"
            : statusField.key === "status"
              ? "ACTIVE"
              : undefined;
    if (defaultValue) {
      const label = (valueLabels as Record<string, Record<string, string>>)[statusField.key]?.[defaultValue] ?? String(defaultValue);
      metrics.push({ label, source: "countBy", field: statusField.key, value: defaultValue });
    }
  }
  const amountField = page.fields.find((field) => field.key.includes("amount"));
  if (amountField) metrics.push({ label: amountField.label, source: "sum", field: amountField.key, suffix: "元" });
  return metrics.slice(0, 3);
}

export const pages: PageSeed[] = [
  {
    module: "frontdesk",
    feature: "frontdesk_home",
    page: "frontdesk_home",
    name: "后台首页",
    table: "student",
    group: "工作台",
    fields: [
      { key: "name", label: "学员姓名", filter: true },
      { key: "contact", label: "联系电话" },
      { key: "student_status", label: "状态" },
      { key: "school_name", label: "学校" },
      { key: "created_at", label: "创建时间", type: "datetime" }
    ]
  },
  {
    module: "system",
    feature: "customization_record_list",
    page: "customization_record_list",
    name: "AI 定制记录",
    table: "agent_customization_record",
    softDelete: false,
    apiSchema: "admin",
    group: "AI 能力",
    fields: [
      { key: "user_prompt", label: "用户需求" },
      { key: "record_type", label: "类型", hidden: true },
      { key: "created_at", label: "创建时间", type: "datetime" }
    ],
    fixedFilters: [
      { field: "schema_name", op: "eq", valueFromParam: "schemaName" },
      { field: "record_type", op: "eq", value: "customization" }
    ]
  },
  {
    module: "system",
    feature: "assistant_record_list",
    page: "assistant_record_list",
    name: "AI 助手记录",
    table: "agent_customization_record",
    softDelete: false,
    apiSchema: "admin",
    group: "AI 能力",
    fields: [
      { key: "user_prompt", label: "用户提问" },
      { key: "record_type", label: "类型", hidden: true },
      { key: "created_at", label: "创建时间", type: "datetime" }
    ],
    fixedFilters: [
      { field: "schema_name", op: "eq", valueFromParam: "schemaName" },
      { field: "record_type", op: "eq", value: "assistant" }
    ]
  },
  {
    module: "system",
    feature: "tenant_version_list",
    page: "tenant_version_list",
    name: "版本管理",
    table: "dsl_version",
    softDelete: false,
    apiSchema: "admin",
    group: "AI 能力",
    fields: [
      { key: "target_type", label: "对象类型", filter: true },
      { key: "target_code", label: "对象编码", filter: true },
      { key: "version_no", label: "版本", sortable: true },
      { key: "status", label: "状态" },
      { key: "change_type", label: "变更类型" },
      { key: "change_summary", label: "摘要" },
      { key: "created_at", label: "创建时间", type: "datetime" }
    ],
    fixedFilters: [{ field: "schema_name", op: "eq", valueFromParam: "schemaName" }],
    sort: "version_no desc"
  },
  {
    module: "finance",
    feature: "contract_product_list",
    page: "contract_product_list",
    name: "合同产品",
    table: "contract_product",
    group: "合同收费",
    fields: [
      { key: "contract_no", label: "合同编号" },
      { key: "contract_id", label: "合同ID", hidden: true, filter: true },
      { key: "student_id", label: "学员ID", hidden: true },
      { key: "organization_id", label: "校区ID", hidden: true },
      { key: "product_id", label: "产品ID", hidden: true },
      { key: "product_name", label: "产品" },
      { key: "remaining_real_hour", label: "剩余课时" },
      { key: "remaining_real_amount", label: "剩余金额" },
      { key: "remaining_promotion_hour", label: "剩余赠课" },
      { key: "remaining_promotion_amount", label: "剩余优惠" },
      { key: "paid_real_amount", label: "已分配实收" },
      { key: "paid_promotion_amount", label: "已分配优惠" },
      { key: "consumed_real_amount", label: "已扣实收" }
    ],
    joins: [
      { table: "contract", alias: "ct", on: { left: "contract_id", right: "id" }, fields: [{ source: "id", as: "contract_no" }, { source: "student_id", as: "student_id" }, { source: "contract_status", as: "contract_status" }] },
      { table: "product", alias: "pd", on: { left: "product_id", right: "id" }, fields: [{ source: "name", as: "product_name" }] }
    ]
  },
  {
    module: "finance",
    feature: "contract_list",
    page: "contract_list",
    name: "合同列表",
    table: "contract",
    commands: { create: { command: "contract.create", ruleCode: "contract_create_rule" } },
    group: "合同收费",
    fields: [
      { key: "contract_no", label: "合同编号" },
      { key: "student_name", label: "学员" },
      { key: "student_id", label: "学员ID", hidden: true, filter: true },
      { key: "organization_id", label: "校区ID", hidden: true },
      { key: "sign_staff_id", label: "签约人ID", hidden: true },
      { key: "organization_name", label: "校区" },
      { key: "paid_status", label: "付款状态", filter: true },
      { key: "contract_type", label: "合同类型" },
      { key: "total_amount", label: "应收金额" },
      { key: "paid_amount", label: "已收金额" },
      { key: "contract_status", label: "合同状态" },
      { key: "sign_time", label: "签约时间", type: "datetime" }
    ],
    joins: [
      { table: "student", alias: "stu", on: { left: "student_id", right: "id" }, fields: [{ source: "name", as: "student_name" }] },
      { table: "organization", alias: "org", on: { left: "organization_id", right: "id" }, fields: [{ source: "name", as: "organization_name" }] },
      { table: "contract", alias: "self_contract", on: { left: "id", right: "id" }, fields: [{ source: "id", as: "contract_no" }] }
    ]
  },
  {
    module: "finance",
    feature: "funds_history",
    page: "funds_history",
    name: "收款记录",
    table: "funds_change_history",
    commands: { create: { command: "funds.create", ruleCode: "funds_create_rule" } },
    group: "财务流水",
    fields: [
      { key: "student_name", label: "学员" },
      { key: "organization_name", label: "校区" },
      { key: "transaction_amount", label: "金额" },
      { key: "transaction_time", label: "交易时间", type: "datetime" },
      { key: "funds_type", label: "流水类型", filter: true },
      { key: "pay_way_name", label: "支付方式" },
      { key: "contract_id", label: "合同ID", hidden: true, filter: true },
      { key: "organization_id", label: "校区ID", hidden: true }
    ],
    joins: [
      { table: "student", alias: "stu", on: { left: "student_id", right: "id" }, fields: [{ source: "name", as: "student_name" }] },
      { table: "organization", alias: "org", on: { left: "organization_id", right: "id" }, fields: [{ source: "name", as: "organization_name" }] },
      { table: "pay_way_config", alias: "pay", on: { left: "pay_way_config_id", right: "id" }, fields: [{ source: "name", as: "pay_way_name" }] }
    ]
  },
  {
    module: "finance",
    feature: "refund_record",
    page: "refund_record",
    name: "退费记录",
    table: "refund_record",
    commands: { create: { command: "refund.create", ruleCode: "refund_create_rule" } },
    group: "财务流水",
    fields: [
      { key: "student_name", label: "学员" },
      { key: "refund_real_hour", label: "退课时" },
      { key: "refund_real_amount", label: "退金额" },
      { key: "refund_time", label: "退费时间", type: "datetime" },
      { key: "refund_type", label: "退费类型", filter: true },
      { key: "contract_id", label: "合同ID", hidden: true, filter: true },
      { key: "organization_id", label: "校区ID", hidden: true },
      { key: "remark", label: "备注" }
    ],
    joins: [
      { table: "student", alias: "stu", on: { left: "student_id", right: "id" }, fields: [{ source: "name", as: "student_name" }] }
    ]
  },
  {
    module: "finance",
    feature: "product_list",
    page: "product_list",
    name: "产品列表",
    table: "product",
    group: "产品优惠",
    fields: [
      { key: "name", label: "产品名称", filter: true },
      { key: "product_type", label: "产品类型" },
      { key: "subject_ids", label: "适用科目" },
      { key: "grade_ids", label: "适用年级" },
      { key: "unit_price", label: "单价" },
      { key: "default_course_hour", label: "课时" },
      { key: "total_amount", label: "总价" },
      { key: "status", label: "状态", filter: true }
    ]
  },
  {
    module: "finance",
    feature: "promotion_list",
    page: "promotion_list",
    name: "优惠方案",
    table: "promotion",
    group: "产品优惠",
    fields: [
      { key: "name", label: "优惠名称", filter: true },
      { key: "type", label: "优惠类型", dictCode: "promotion_type" },
      { key: "value", label: "优惠值" },
      { key: "status", label: "状态", filter: true }
    ]
  },
  {
    module: "finance",
    feature: "student_ele_account",
    page: "student_ele_account",
    name: "电子账户",
    table: "student_ele_account",
    group: "电子账户",
    fields: [
      { key: "student_name", label: "学员" },
      { key: "balance_amount", label: "账户余额" },
      { key: "frozen_amount", label: "冻结金额" },
      { key: "status", label: "状态", filter: true }
    ],
    joins: [
      { table: "student", alias: "stu", on: { left: "student_id", right: "id" }, fields: [{ source: "name", as: "student_name" }] }
    ]
  },
  {
    module: "finance",
    feature: "student_ele_account_record",
    page: "student_ele_account_record",
    name: "账户流水",
    table: "student_ele_account_record",
    group: "电子账户",
    fields: [
      { key: "student_name", label: "学员" },
      { key: "change_type", label: "变动类型", filter: true },
      { key: "change_amount", label: "变动金额" },
      { key: "balance_after", label: "变动后余额" },
      { key: "contract_id", label: "合同", hidden: true },
      { key: "source_type", label: "来源类型", filter: true },
      { key: "source_id", label: "来源单据ID" },
      { key: "operator_id", label: "操作人" },
      { key: "remark", label: "备注" }
    ],
    joins: [
      { table: "student", alias: "stu", on: { left: "student_id", right: "id" }, fields: [{ source: "name", as: "student_name" }] }
    ]
  },


  {
    module: "marketing",
    feature: "wechat_account_binding",
    page: "wechat_account_binding",
    name: "公众号绑定",
    table: "wechat_account_binding",
    group: "公众号",
    fields: [
      { key: "account_name", label: "公众号名称", filter: true },
      { key: "appid", label: "AppID" },
      { key: "service_type", label: "账号类型", filter: true },
      { key: "binding_type", label: "绑定类型", filter: true },
      { key: "authorized_status", label: "授权状态", filter: true },
      { key: "is_default", label: "默认服务号", type: "boolean" },
      { key: "oauth_domain", label: "统一回调域名" },
      { key: "updated_at", label: "更新时间", type: "datetime" }
    ]
  },
  {
    module: "marketing",
    feature: "wechat_menu_config",
    page: "wechat_menu_config",
    name: "公众号菜单",
    table: "wechat_menu_config",
    group: "公众号",
    fields: [
      { key: "binding_id", label: "公众号绑定" },
      { key: "menu_name", label: "菜单名称", filter: true },
      { key: "menu_json", label: "菜单DSL", type: "textarea" },
      { key: "publish_status", label: "发布状态", filter: true },
      { key: "last_published_at", label: "发布时间", type: "datetime" }
    ]
  },
  {
    module: "marketing",
    feature: "wechat_student_fan",
    page: "wechat_student_fan",
    name: "学员微信绑定",
    table: "wechat_student_fan",
    group: "公众号",
    fields: [
      { key: "student_name", label: "学员" },
      { key: "openid", label: "OpenID" },
      { key: "nickname", label: "微信名", filter: true },
      { key: "avatar_url", label: "头像" },
      { key: "subscribe_status", label: "关注状态", filter: true },
      { key: "bound_at", label: "绑定时间", type: "datetime" }
    ],
    joins: [{ table: "student", alias: "stu", on: { left: "student_id", right: "id" }, fields: [{ source: "name", as: "student_name" }] }]
  },
  {
    module: "marketing",
    feature: "mall_goods",
    page: "mall_goods",
    name: "商城商品",
    table: "mall_goods",
    group: "微商城",
    fields: [
      { key: "goods_name", label: "商品名称", filter: true },
      { key: "product_id", label: "绑定产品" },
      { key: "sale_price", label: "售价", type: "number" },
      { key: "stock_qty", label: "库存", type: "number" },
      { key: "goods_status", label: "上下架", filter: true },
      { key: "activity_type", label: "活动类型", filter: true },
      { key: "updated_at", label: "更新时间", type: "datetime" }
    ]
  },
  {
    module: "marketing",
    feature: "mall_activity",
    page: "mall_activity",
    name: "营销活动",
    table: "mall_activity",
    group: "微商城",
    fields: [
      { key: "activity_name", label: "活动名称", filter: true },
      { key: "activity_type", label: "活动类型", filter: true },
      { key: "goods_id", label: "活动商品" },
      { key: "start_time", label: "开始时间", type: "datetime" },
      { key: "end_time", label: "结束时间", type: "datetime" },
      { key: "activity_price", label: "活动价", type: "number" },
      { key: "group_size", label: "成团人数", type: "number" },
      { key: "status", label: "状态", filter: true }
    ]
  },

  {
    module: "marketing",
    feature: "mall_group_buy",
    page: "mall_group_buy",
    name: "团购团单",
    table: "mall_group_buy",
    group: "微商城",
    fields: [
      { key: "activity_id", label: "团购活动", filter: true },
      { key: "goods_id", label: "团购商品" },
      { key: "leader_student_id", label: "团长学员" },
      { key: "group_status", label: "团单状态", filter: true },
      { key: "group_size", label: "成团人数", type: "number" },
      { key: "joined_count", label: "已参团人数", type: "number" },
      { key: "expires_at", label: "过期时间", type: "datetime" },
      { key: "success_at", label: "成团时间", type: "datetime" }
    ]
  },

  {
    module: "marketing",
    feature: "mall_group_member",
    page: "mall_group_member",
    name: "团购成员",
    table: "mall_group_member",
    group: "微商城",
    fields: [
      { key: "group_id", label: "团单", filter: true },
      { key: "order_id", label: "订单" },
      { key: "student_id", label: "学员" },
      { key: "member_status", label: "成员状态", filter: true },
      { key: "created_at", label: "参团时间", type: "datetime" }
    ]
  },
  {
    module: "marketing",
    feature: "mall_order",
    page: "mall_order",
    name: "商城订单",
    table: "mall_order",
    group: "微商城",
    fields: [
      { key: "order_no", label: "订单号", filter: true },
      { key: "student_name", label: "学员" },
      { key: "goods_name", label: "商品" },
      { key: "original_amount", label: "原价金额", type: "number" },
      { key: "coupon_discount_amount", label: "优惠券抵扣", type: "number" },
      { key: "pay_amount", label: "付款金额", type: "number" },
      { key: "coupon_claim_id", label: "使用优惠券" },
      { key: "order_status", label: "订单状态", filter: true },
      { key: "payment_status", label: "支付状态", filter: true },
      { key: "contract_id", label: "生成合同" },
      { key: "created_at", label: "下单时间", type: "datetime" }
    ],
    joins: [
      { table: "student", alias: "stu", on: { left: "student_id", right: "id" }, fields: [{ source: "name", as: "student_name" }] },
      { table: "mall_goods", alias: "mg", on: { left: "goods_id", right: "id" }, fields: [{ source: "goods_name", as: "goods_name" }] }
    ]
  },
  {
    module: "marketing",
    feature: "wechat_push_rule",
    page: "wechat_push_rule",
    name: "微信推送规则",
    table: "wechat_push_rule",
    group: "微信推送",
    fields: [
      { key: "rule_name", label: "规则名称", filter: true },
      { key: "business_event", label: "业务事件", filter: true },
      { key: "template_id", label: "模板ID" },
      { key: "receiver_scope", label: "接收人" },
      { key: "rule_json", label: "规则DSL", type: "textarea" },
      { key: "status", label: "状态", filter: true }
    ]
  },
  {
    module: "marketing",
    feature: "wechat_push_log",
    page: "wechat_push_log",
    name: "微信推送日志",
    table: "wechat_push_log",
    group: "微信推送",
    softDelete: false,
    fields: [
      { key: "business_event", label: "业务事件", filter: true },
      { key: "student_id", label: "学员" },
      { key: "openid", label: "OpenID" },
      { key: "send_status", label: "发送状态", filter: true },
      { key: "error_message", label: "错误信息" },
      { key: "created_at", label: "发送时间", type: "datetime" }
    ]
  },
  {
    module: "oa",
    feature: "notice_list",
    page: "notice_list",
    name: "通知公告",
    table: "notice",
    apiFilters: ["id"],
    group: "协同办公",
    fields: [
      { key: "title", label: "标题", filter: true },
      { key: "content", label: "内容" },
      { key: "status", label: "状态" }
    ]
  },
  {
    module: "oa",
    feature: "approval_flow_list",
    page: "approval_flow_list",
    name: "审批设置",
    table: "approval_flow",
    group: "审批设置",
    fields: [
      { key: "name", label: "审批名称", filter: true },
      { key: "flow_code", label: "审批编码" },
      { key: "business_type", label: "业务类型" },
      { key: "organization_id", label: "组织架构" },
      { key: "steps_summary", label: "流转角色" },
      { key: "status", label: "状态", filter: true, dictCode: "approval_flow_status" }
    ]
  },
  {
    module: "oa",
    feature: "approval_task_list",
    page: "approval_task_list",
    name: "审批中心",
    table: "approval_task",
    group: "审批设置",
    fields: [
      { key: "flow_name", label: "审批流", filter: true },
      { key: "business_type", label: "业务类型", filter: true },
      { key: "business_id", label: "业务单据" },
      { key: "applicant_name", label: "申请人" },
      { key: "current_approver_name", label: "当前审批人" },
      { key: "status", label: "状态", filter: true, badge: true, dictCode: "approval_status" },
      { key: "current_step_index", label: "当前节点", hidden: true },
      { key: "form_json", label: "审批详情", hidden: true },
      { key: "created_at", label: "发起时间", type: "datetime" },
      { key: "updated_at", label: "更新时间", type: "datetime" }
    ],
    apiFilters: ["view"]
  },
  {
    module: "oa",
    feature: "approval_task_log_list",
    page: "approval_task_log_list",
    name: "审批流转日志",
    table: "approval_task_log",
    group: "审批设置",
    fields: [
      { key: "task_id", label: "审批任务", filter: true },
      { key: "step_name", label: "节点" },
      { key: "action", label: "操作", filter: true },
      { key: "operator_user_id", label: "操作人" },
      { key: "comment", label: "意见" },
      { key: "created_at", label: "操作时间", type: "datetime" }
    ]
  },
  {
    module: "report",
    feature: "student_report",
    page: "student_report",
    name: "学员报表",
    table: "student",
    group: "经营报表",
    fields: [
      { key: "name", label: "学员" },
      { key: "student_status", label: "状态" },
      { key: "source_type", label: "来源" },
      { key: "school_name", label: "学校" }
    ]
  },

  {
    module: "system",
    feature: "organization_list",
    page: "organization_list",
    name: "校区列表",
    table: "organization",
    group: "组织权限",
    fields: [
      { key: "name", label: "校区名称", filter: true },
      { key: "parent_id", label: "上级架构" },
      { key: "organization_type", label: "组织类型" },
      { key: "status", label: "状态", filter: true }
    ]
  },
  {
    module: "system",
    feature: "user_list",
    page: "user_list",
    name: "员工列表",
    table: "user",
    group: "组织权限",
    fields: [
      { key: "name", label: "员工姓名", filter: true },
      { key: "contact", label: "电话" },
      { key: "organization_id", label: "归属架构" },
      { key: "management_organization_ids", label: "管理架构" },
      { key: "staff_type", label: "类型" },
      { key: "status", label: "状态" }
    ]
  },

  {
    module: "marketing",
    feature: "coupon_template_list",
    page: "coupon_template_list",
    name: "优惠券模板",
    table: "coupon_template",
    group: "营销工具",
    fields: [
      { key: "coupon_name", label: "券名称", filter: true },
      { key: "coupon_type", label: "券类型", filter: true },
      { key: "discount_amount", label: "优惠金额", type: "number" },
      { key: "discount_rate", label: "折扣", type: "number" },
      { key: "valid_from", label: "有效开始", type: "datetime" },
      { key: "valid_to", label: "有效结束", type: "datetime" },
      { key: "total_qty", label: "发行量", type: "number" },
      { key: "status", label: "状态", filter: true }
    ]
  },
  {
    module: "marketing",
    feature: "coupon_claim_list",
    page: "coupon_claim_list",
    name: "优惠券领取",
    table: "coupon_claim",
    group: "营销工具",
    fields: [
      { key: "coupon_template_id", label: "优惠券模板", filter: true },
      { key: "student_id", label: "领取学员", filter: true },
      { key: "coupon_code", label: "券码", filter: true },
      { key: "claim_time", label: "领取时间", type: "datetime" },
      { key: "use_status", label: "使用状态", filter: true },
      { key: "used_order_id", label: "使用订单" },
      { key: "used_at", label: "使用时间", type: "datetime" }
    ]
  },
  {
    module: "marketing",
    feature: "landing_page_list",
    page: "landing_page_list",
    name: "活动落地页",
    table: "marketing_landing_page",
    group: "活动获客",
    fields: [
      { key: "page_title", label: "页面标题", filter: true },
      { key: "campaign_id", label: "关联活动" },
      { key: "channel_id", label: "投放渠道" },
      { key: "form_schema_json", label: "表单配置", type: "json_textarea" },
      { key: "pv_count", label: "访问量", type: "number" },
      { key: "lead_count", label: "意向学员数", type: "number" },
      { key: "publish_status", label: "发布状态", filter: true }
    ]
  },
  {
    module: "marketing",
    feature: "referral_reward_list",
    page: "referral_reward_list",
    name: "转介绍奖励",
    table: "referral_reward",
    group: "活动获客",
    fields: [
      { key: "referrer_student_id", label: "推荐人", filter: true },
      { key: "referred_student_id", label: "被推荐人", filter: true },
      { key: "reward_type", label: "奖励类型", filter: true },
      { key: "reward_amount", label: "奖励金额", type: "number" },
      { key: "reward_status", label: "奖励状态", filter: true },
      { key: "issued_at", label: "发放时间", type: "datetime" },
      { key: "remark", label: "备注" }
    ]
  },

  {
    module: "finance",
    feature: "pay_way_list",
    page: "pay_way_list",
    name: "支付方式",
    table: "pay_way_config",
    group: "财务配置",
    fields: [
      { key: "name", label: "支付方式", filter: true },
      { key: "pay_way_type", label: "支付类型" },
      { key: "status", label: "状态", filter: true }
    ]
  },
  {
    module: "system",
    feature: "role_list",
    page: "role_list",
    name: "角色权限",
    table: "role",
    group: "组织权限",
    fields: [
      { key: "name", label: "角色名称", filter: true },
      { key: "organization_id", label: "所属校区" }
    ]
  },
  {
    module: "system",
    feature: "business_rule_list",
    page: "business_rule_list",
    name: "规则设置",
    table: "business_rule",
    group: "配置中心",
    fields: [
      { key: "rule_name", label: "规则名称", filter: true },
      { key: "category", label: "规则分类", filter: true, dictCode: "business_rule_category", hidden: true },
      { key: "business_type", label: "业务类型", filter: true, dictCode: "business_type", hidden: true },
      { key: "category_label", label: "规则分类" },
      { key: "business_type_label", label: "业务类型" },
      { key: "source_label", label: "来源" },
      { key: "status", label: "状态" },
      { key: "updated_at", label: "更新时间", type: "datetime" }
    ]
  },
  {
    module: "finance",
    feature: "money_arrange_list",
    page: "money_arrange_list",
    name: "资金分配记录",
    table: "money_arrange_log",
    group: "分配记录",
    fields: [
      { key: "contract_product_id", label: "合同产品" },
      { key: "arrange_real_hour", label: "分配课时" },
      { key: "arrange_real_amount", label: "分配金额" },
      { key: "funds_change_history_id", label: "收款记录" },
      { key: "organization_id", label: "校区" }
    ]
  },
  {
    module: "finance",
    feature: "promotion_arrange_list",
    page: "promotion_arrange_list",
    name: "优惠分配记录",
    table: "promotion_arrange_log",
    group: "分配记录",
    fields: [
      { key: "contract_product_id", label: "合同产品" },
      { key: "arrange_promotion_hour", label: "分配赠课" },
      { key: "arrange_promotion_amount", label: "分配优惠金额" },
      { key: "funds_change_history_id", label: "收款记录" },
      { key: "organization_id", label: "校区" }
    ]
  },
  {
    module: "finance",
    feature: "performance_arrange_list",
    page: "performance_arrange_list",
    name: "业绩分配记录",
    table: "performance_arrange_log",
    group: "分配记录",
    fields: [
      { key: "contract_product_id", label: "合同产品" },
      { key: "performance_type", label: "业绩类型", filter: true },
      { key: "organization_performance_organization_id", label: "校区业绩组织" },
      { key: "organization_performance_amount", label: "校区业绩金额" },
      { key: "personal_performance_user_id", label: "个人业绩员工" },
      { key: "personal_performance_amount", label: "个人业绩金额" },
      { key: "organization_id", label: "校区" },
      { key: "source_type", label: "来源类型", filter: true },
      { key: "source_id", label: "来源单据ID" },
      { key: "adjustment_reason", label: "调整原因" }
    ]
  },
  {
    module: "report",
    feature: "finance_report",
    page: "finance_report",
    name: "财务报表",
    table: "funds_change_history",
    group: "经营报表",
    fields: [
      { key: "organization_id", label: "校区", filter: true },
      { key: "funds_type", label: "流水类型", filter: true },
      { key: "transaction_amount", label: "金额" },
      { key: "transaction_time", label: "交易时间", type: "datetime" }
    ]
  },
  {
    module: "report",
    feature: "course_report",
    page: "course_report",
    name: "课程报表",
    table: "generic_course",
    group: "经营报表",
    fields: [
      { key: "organization_id", label: "校区", filter: true },
      { key: "course_type", label: "课程类型", filter: true },
      { key: "course_status", label: "状态", filter: true },
      { key: "course_hour", label: "课时" },
      { key: "course_date", label: "上课日期", type: "date" }
    ]
  },
  {
    module: "student",
    feature: "student_list",
    page: "student_list",
    name: "学员列表",
    table: "student",
    softDelete: true,
    group: "学员管理",
    apiFilters: ["id"],
    fields: [
      { key: "name", label: "学员姓名", filter: true },
      { key: "contact", label: "联系电话" },
      { key: "organization_id", label: "校区", filter: true },
      { key: "student_status", label: "状态", filter: true },
      { key: "school_name", label: "学校" },
      { key: "grade", label: "年级" }
    ]
  },
  {
    module: "student",
    feature: "student_followup_list",
    page: "student_followup_list",
    name: "跟进记录",
    table: "student_followup",
    group: "跟进管理",
    fields: [
      { key: "student_id", label: "学员", filter: true },
      { key: "lead_stage_id", label: "关联招生阶段" },
      { key: "follow_type", label: "跟进方式" },
      { key: "follow_content", label: "跟进内容" },
      { key: "follow_result", label: "跟进结果", filter: true },
      { key: "next_follow_time", label: "下次跟进时间", type: "datetime" }
    ]
  },
  {
    module: "recruit",
    feature: "lead_list",
    page: "lead_list",
    name: "新生报名",
    table: "student",
    softDelete: true,
    group: "报名转化",
    fields: [
      { key: "name", label: "学员姓名", filter: true },
      { key: "contact", label: "联系电话" },
      { key: "student_status", label: "状态", filter: true },
      { key: "source_type", label: "来源", filter: true },
      { key: "school_name", label: "学校" }
    ],
    fixedFilters: [{ field: "student_status", op: "eq", value: "LEAD" }]
  },
  {
    module: "recruit",
    feature: "recruit_channel_list",
    page: "recruit_channel_list",
    name: "招生渠道",
    table: "recruit_channel",
    group: "渠道投放",
    fields: [
      { key: "channel_name", label: "渠道名称", filter: true },
      { key: "channel_type", label: "渠道类型", filter: true },
      { key: "owner_user_id", label: "负责人" },
      { key: "cost_amount", label: "投放成本", type: "number" },
      { key: "lead_count", label: "意向学员数", type: "number" },
      { key: "conversion_count", label: "转化数", type: "number" },
      { key: "roi_amount", label: "产出金额", type: "number" },
      { key: "status", label: "状态", filter: true }
    ]
  },
  {
    module: "recruit",
    feature: "lead_stage_list",
    page: "lead_stage_list",
    name: "招生漏斗",
    table: "lead_stage_record",
    group: "线索管理",
    fields: [
      { key: "student_id", label: "意向学员", filter: true },
      { key: "stage", label: "当前阶段", filter: true, dictCode: "lead_stage" },
      { key: "owner_user_id", label: "顾问" },
      { key: "channel_id", label: "来源渠道" },
      { key: "next_action", label: "下一步动作" },
      { key: "next_follow_time", label: "下次跟进", type: "datetime" },
      { key: "lost_reason", label: "流失原因" },
      { key: "status", label: "状态", filter: true }
    ]
  },
  {
    module: "recruit",
    feature: "trial_lesson_list",
    page: "trial_lesson_list",
    name: "试听邀约",
    table: "trial_lesson",
    group: "试听转化",
    fields: [
      { key: "student_id", label: "试听学员", filter: true },
      { key: "course_id", label: "生成课次" },
      { key: "course_title", label: "试听课程", filter: true },
      { key: "trial_time", label: "试听时间", type: "datetime", filter: true },
      { key: "teacher_id", label: "试听老师" },
      { key: "sales_user_id", label: "邀约顾问" },
      { key: "trial_status", label: "试听状态", filter: true },
      { key: "feedback", label: "试听反馈" },
      { key: "conversion_status", label: "转化状态", filter: true }
    ]
  },
  {
    module: "recruit",
    feature: "sales_task_list",
    page: "sales_task_list",
    name: "销售任务",
    table: "sales_task",
    group: "销售管理",
    fields: [
      { key: "task_title", label: "任务标题", filter: true },
      { key: "student_id", label: "关联学员" },
      { key: "owner_user_id", label: "负责人", filter: true },
      { key: "task_type", label: "任务类型", filter: true },
      { key: "due_time", label: "截止时间", type: "datetime", filter: true },
      { key: "complete_time", label: "完成时间", type: "datetime" },
      { key: "task_status", label: "任务状态", filter: true },
      { key: "remark", label: "备注" }
    ]
  },

  {
    module: "recruit",
    feature: "lead_assignment_history_list",
    page: "lead_assignment_history_list",
    name: "意向学员分配历史",
    table: "lead_assignment_history",
    group: "线索管理",
    softDelete: false,
    fields: [
      { key: "student_id", label: "意向学员", filter: true },
      { key: "from_user_id", label: "原负责人" },
      { key: "to_user_id", label: "新负责人" },
      { key: "action_type", label: "分配动作", filter: true, dictCode: "lead_assignment_action_type" },
      { key: "reason", label: "原因" },
      { key: "operator_id", label: "操作人" },
      { key: "created_at", label: "操作时间", type: "datetime" }
    ]
  },
  {
    module: "recruit",
    feature: "recruit_channel_cost_list",
    page: "recruit_channel_cost_list",
    name: "渠道成本",
    table: "recruit_channel_cost",
    group: "渠道投放",
    fields: [
      { key: "channel_id", label: "招生渠道", filter: true },
      { key: "cost_date", label: "投放日期", type: "date", filter: true },
      { key: "cost_amount", label: "投放成本", type: "number" },
      { key: "cost_type", label: "成本类型", filter: true },
      { key: "remark", label: "备注" }
    ]
  },
  {
    module: "recruit",
    feature: "sales_target_list",
    page: "sales_target_list",
    name: "销售目标",
    table: "sales_target",
    group: "销售管理",
    fields: [
      { key: "owner_user_id", label: "顾问", filter: true },
      { key: "target_month", label: "目标月份", filter: true },
      { key: "target_leads", label: "目标意向学员", type: "number" },
      { key: "target_trials", label: "目标试听", type: "number" },
      { key: "target_contracts", label: "目标报名", type: "number" },
      { key: "target_amount", label: "目标金额", type: "number" },
      { key: "status", label: "状态", filter: true }
    ]
  },
  {
    module: "education",
    feature: "charge_record",
    page: "charge_record",
    name: "扣费记录",
    table: "account_charge_records",
    group: "课消扣费",
    fields: [
      { key: "student_id", label: "学员" },
      { key: "charge_type", label: "扣费类型" },
      { key: "charge_hour", label: "课时" },
      { key: "charge_amount", label: "金额" },
      { key: "charge_status", label: "状态", filter: true },
      { key: "created_at", label: "扣费时间", type: "datetime" },
      { key: "organization_id", label: "校区ID", hidden: true },
      { key: "course_id", label: "课程", filter: true }
    ]
  },
  {
    module: "education",
    feature: "course_list",
    page: "course_list",
    name: "排课列表",
    table: "generic_course",
    group: "教务管理",
    apiFilters: ["id"],
    fields: [
      { key: "course_title", label: "课程名称", filter: true },
      { key: "course_type", label: "课程类型", filter: true },
      { key: "course_dates", label: "上课日期", type: "multiDate", span: 2 as const, defaultFutureOnly: true },
      { key: "course_date", label: "单次日期", type: "date", hidden: true, filter: true },
      { key: "start_time", label: "开始时间" },
      { key: "end_time", label: "结束时间" },
      { key: "course_hour", label: "课时" },
      { key: "organization_id", label: "上课校区", filter: true },
      { key: "teacher_id", label: "授课老师" },
      { key: "study_manager_id", label: "班主任" },
      { key: "course_status", label: "状态", filter: true },
      { key: "student_names", label: "上课学员", hidden: true },
      { key: "student_ids", label: "上课学员ID", hidden: true },
      { key: "students", label: "上课学员配置", hidden: true }
    ]
  },
  {
    module: "education",
    feature: "course_week_schedule",
    page: "course_week_schedule",
    name: "周课表",
    table: "generic_course",
    group: "教务管理",
    fields: [
      { key: "course_date", label: "日期", type: "date", filter: true },
      { key: "start_time", label: "开始时间" },
      { key: "end_time", label: "结束时间" },
      { key: "course_title", label: "课程" },
      { key: "course_type", label: "类型", filter: true },
      { key: "organization_id", label: "上课校区", filter: true },
      { key: "teacher_id", label: "老师", filter: true },
      { key: "study_manager_id", label: "班主任" },
      { key: "mini_class_id", label: "班级" },
      { key: "one_on_n_group_id", label: "1对N小组" },
      { key: "course_status", label: "状态", filter: true }
    ],
    sort: "course_date asc, start_time asc"
  },
  {
    module: "education",
    feature: "mini_class_list",
    page: "mini_class_list",
    name: "班级列表",
    table: "mini_class",
    group: "班级管理",
    fields: [
      { key: "name", label: "班级名称", filter: true },
      { key: "organization_id", label: "校区" },
      { key: "teacher_id", label: "授课老师" },
      { key: "study_manager_id", label: "学管师" },
      { key: "product_id", label: "排课产品" },
      { key: "grade", label: "年级" },
      { key: "subject", label: "科目" },
      { key: "capacity", label: "容量", type: "number" },
      { key: "status", label: "状态", filter: true }
    ]
  },
  {
    module: "education",
    feature: "one_on_n_group_list",
    page: "one_on_n_group_list",
    name: "1对N小组",
    table: "one_on_n_group",
    group: "班级管理",
    fields: [
      { key: "name", label: "小组名称", filter: true },
      { key: "organization_id", label: "校区" },
      { key: "teacher_id", label: "授课老师" },
      { key: "study_manager_id", label: "学管师" },
      { key: "product_id", label: "排课产品" },
      { key: "grade", label: "年级" },
      { key: "subject", label: "科目" },
      { key: "capacity", label: "容量", type: "number" },
      { key: "status", label: "状态", filter: true }
    ]
  },
  {
    module: "education",
    feature: "class_student_change_history",
    page: "class_student_change_history",
    name: "进退班历史",
    table: "class_student_change_history",
    group: "班级管理",
    softDelete: false,
    fields: [
      { key: "target_type", label: "班级类型", filter: true },
      { key: "target_id", label: "班级/小组" },
      { key: "student_id", label: "学员" },
      { key: "change_type", label: "变更类型", filter: true },
      { key: "reason", label: "原因" },
      { key: "created_at", label: "变更时间", type: "datetime" }
    ]
  },
  {
    module: "education",
    feature: "mini_class_student_list",
    page: "mini_class_student_list",
    name: "班级学员",
    table: "mini_class_student",
    group: "班级管理",
    fields: [
      { key: "mini_class_id", label: "所属班级", filter: true },
      { key: "student_id", label: "学员" },
      { key: "join_date", label: "入班日期", type: "date" },
      { key: "status", label: "状态", filter: true }
    ],
    fixedFilters: [{ field: "mini_class_id", op: "eq", valueFromParam: "mini_class_id" }]
  },
  {
    module: "education",
    feature: "one_on_n_group_student_list",
    page: "one_on_n_group_student_list",
    name: "1对N学员",
    table: "one_on_n_group_student",
    group: "班级管理",
    fields: [
      { key: "one_on_n_group_id", label: "所属小组", filter: true },
      { key: "student_id", label: "学员" },
      { key: "join_date", label: "入组日期", type: "date" },
      { key: "status", label: "状态", filter: true }
    ],
    fixedFilters: [{ field: "one_on_n_group_id", op: "eq", valueFromParam: "one_on_n_group_id" }]
  },
  {
    module: "education",
    feature: "leave_record",
    page: "leave_record",
    name: "请假管理",
    table: "course_leave_record",
    group: "考勤管理",
    commands: { create: { command: "leave.create", ruleCode: "leave_create_rule" } },
    fields: [
      { key: "course_id", label: "关联课程" },
      { key: "student_id", label: "学员", filter: true },
      { key: "leave_type", label: "请假类型", filter: true },
      { key: "leave_time", label: "请假时间", type: "datetime" },
      { key: "status", label: "状态", filter: true },
      { key: "organization_id", label: "校区" },
      { key: "source_type", label: "来源类型", filter: true },
      { key: "source_id", label: "来源单据ID" },
      { key: "adjustment_reason", label: "调整原因" }
    ]
  },
  {
    module: "education",
    feature: "makeup_course_record",
    page: "makeup_course_record",
    name: "补课管理",
    table: "makeup_course_record",
    group: "考勤管理",
    commands: { create: { command: "makeup.create", ruleCode: "makeup_create_rule" } },
    fields: [
      { key: "original_course_id", label: "原课程" },
      { key: "makeup_course_id", label: "补课课程" },
      { key: "student_id", label: "学员", filter: true },
      { key: "status", label: "状态", filter: true },
      { key: "organization_id", label: "校区" },
      { key: "source_type", label: "来源类型", filter: true },
      { key: "source_id", label: "来源单据ID" },
      { key: "adjustment_reason", label: "调整原因" }
    ]
  },
  {
    module: "education",
    feature: "course_holiday_calendar",
    page: "course_holiday_calendar",
    name: "停课日历",
    table: "course_holiday_calendar",
    group: "考勤管理",
    fields: [
      { key: "name", label: "停课事项", filter: true },
      { key: "holiday_date", label: "开始日期", type: "date", filter: true },
      { key: "end_date", label: "结束日期", type: "date" },
      { key: "organization_id", label: "校区" },
      { key: "holiday_type", label: "类型", filter: true },
      { key: "block_course", label: "禁止排课", type: "boolean" }
    ]
  }
];

export const extraPages: Array<{ pageCode: string; pageKind: string; module: string; feature: string; name: string; dsl: Record<string, unknown> }> = [
  {
    pageCode: "admin_login",
    pageKind: "public",
    module: "system",
    feature: "admin_login",
    name: "管理员登录",
    dsl: {
      pageCode: "admin_login",
      title: "管理平台登录",
      subtitle: "请输入管理员账号和密码",
      pageKind: "public",
      layout: "public_form",
      presentation: { theme: "flatTech", density: "compact" },
      form: {
        fields: [
          { key: "contact", label: "账号", type: "text", required: true, placeholder: "请输入管理员账号" },
          { key: "psw", label: "密码", type: "password", required: true, placeholder: "请输入密码" }
        ],
        submitLabel: "登录",
        submitAction: { actionCode: "admin_login.submit", actionType: "execute_api", apiCode: "admin_login.submit" }
      }
    }
  },
  {
    pageCode: "tenant_login",
    pageKind: "public",
    module: "system",
    feature: "tenant_login",
    name: "租户登录",
    dsl: {
      pageCode: "tenant_login",
      title: "机构登录",
      subtitle: "请输入您的账号和密码",
      pageKind: "public",
      layout: "public_form",
      presentation: { theme: "flatTech", density: "compact" },
      form: {
        fields: [
          { key: "contact", label: "账号", type: "text", required: true, placeholder: "请输入手机号" },
          { key: "psw", label: "密码", type: "password", required: true, placeholder: "请输入密码" }
        ],
        submitLabel: "登录",
        submitAction: { actionCode: "tenant_login.submit", actionType: "execute_api", apiCode: "tenant_login.submit" }
      }
    }
  },
  {
    pageCode: "app_shell",
    pageKind: "shell",
    module: "system",
    feature: "app_shell",
    name: "应用框架",
    dsl: {
      pageCode: "app_shell",
      title: "应用框架",
      pageKind: "shell",
      layout: "shell",
      presentation: { theme: "flatTech", density: "compact" },
      shell: {
        sidebar: { collapsible: true, defaultCollapsed: false },
        header: { showUserInfo: true, showNotifications: true },
        tabs: { enabled: true, maxTabs: 10 }
      }
    }
  },
  {
    pageCode: "today_course",
    pageKind: "shtml",
    module: "education",
    feature: "today_course",
    name: "今日课程",
    dsl: {
      pageCode: "today_course",
      title: "今日课程",
      subtitle: "查看今日所有课程安排",
      pageKind: "shtml",
      layout: "calendar",
      dataApi: "course_list.query",
      presentation: { theme: "flatTech", density: "compact", type: "calendar", calendarField: "course_date" },
      filters: [
        { key: "course_date", label: "上课日期", type: "date", placeholder: "选择日期" },
        { key: "course_status", label: "状态", type: "text", placeholder: "课程状态" }
      ],
      table: {
        rowKey: "id",
        columns: [
          { key: "course_title", title: "课程名称", width: 180 },
          { key: "course_type", title: "课程类型", width: 120 },
          { key: "course_date", title: "上课日期", type: "date", width: 130 },
          { key: "start_time", title: "开始", width: 80 },
          { key: "end_time", title: "结束", width: 80 },
          { key: "course_status", title: "状态", width: 100, align: "center", badge: true }
        ],
        rowActions: [
          { actionCode: "today_course.detail", label: "详情", type: "open_modal" }
        ]
      }
    }
  },
  {
    pageCode: "student_handover",
    pageKind: "shtml",
    module: "student",
    feature: "student_handover",
    name: "学员交接表",
    dsl: {
      pageCode: "student_handover",
      title: "学员交接表",
      subtitle: "管理学员学管师变更和交接记录",
      pageKind: "shtml",
      layout: "list",
      dataApi: "student_list.query",
      detailApi: "student_list.detail",
      presentation: { theme: "flatTech", density: "compact", header: { subtitle: "管理学员学管师变更和交接记录" } },
      filters: [
        { key: "name", label: "学员姓名", type: "text", placeholder: "请输入学员姓名" },
        { key: "student_status", label: "状态", type: "text", placeholder: "学员状态" }
      ],
      toolbar: [
        { actionCode: "student_handover.assignManager", label: "批量分配学管师", type: "execute_api", variant: "primary" }
      ],
      table: {
        rowKey: "id",
        columns: [
          { key: "name", title: "学员姓名", width: 180 },
          { key: "contact", title: "联系电话", width: 150 },
          { key: "organization_name", title: "校区", width: 150 },
          { key: "student_status", title: "状态", width: 100, align: "center", badge: true },
          { key: "study_manager_id", title: "学管师", width: 150 }
        ],
        rowActions: [
          { actionCode: "student_handover.assignManager", label: "分配学管师", type: "open_modal" }
        ]
      }
    }
  },
  {
    pageCode: "student_visit",
    pageKind: "shtml",
    module: "student",
    feature: "student_visit",
    name: "学员到离校",
    dsl: {
      pageCode: "student_visit",
      title: "学员到离校",
      subtitle: "记录学员到校和离校时间",
      pageKind: "shtml",
      layout: "list",
      dataApi: "course_list.query",
      presentation: { theme: "flatTech", density: "compact", header: { subtitle: "记录学员到校和离校时间" } },
      filters: [
        { key: "course_date", label: "上课日期", type: "date", placeholder: "选择日期" }
      ],
      table: {
        rowKey: "id",
        columns: [
          { key: "course_title", title: "课程", width: 180 },
          { key: "course_date", title: "日期", type: "date", width: 130 },
          { key: "start_time", title: "开始", width: 80 },
          { key: "end_time", title: "结束", width: 80 },
          { key: "course_status", title: "状态", width: 100, align: "center", badge: true }
        ],
        rowActions: [
          { actionCode: "student_visit.sign_in", label: "签到", type: "execute_api" },
          { actionCode: "student_visit.sign_out", label: "签退", type: "execute_api" }
        ]
      }
    }
  },
  {
    pageCode: "student_detail",
    pageKind: "shtml",
    module: "student",
    feature: "student_detail",
    name: "学员详情",
    dsl: {
      pageCode: "student_detail",
      title: "学员详情",
      subtitle: "查看学员完整档案信息",
      pageKind: "shtml",
      layout: "detail",
      dataApi: "student_list.detail",
      presentation: { theme: "flatTech", density: "compact" },
      sections: [
        { title: "基本信息", fields: [
          { key: "name", label: "姓名", type: "text" },
          { key: "contact", label: "联系电话", type: "text" },
          { key: "student_status", label: "状态", type: "text", badge: true },
          { key: "organization_name", label: "校区", type: "text" },
          { key: "school_name", label: "学校", type: "text" },
          { key: "grade", label: "年级", type: "text" },
          { key: "birthday", label: "生日", type: "date" },
          { key: "gender", label: "性别", type: "text" },
          { key: "student_no", label: "学号", type: "text" }
        ]},
        { title: "合同信息", dataSource: { pageCode: "contract_list", apiCode: "contract_list.query", filterField: "student_id" }, type: "table" },
        { title: "课程记录", dataSource: { pageCode: "course_list", apiCode: "course_list.query" }, type: "table" }
      ]
    }
  },
  {
    pageCode: "contract_detail",
    pageKind: "shtml",
    module: "finance",
    feature: "contract_detail",
    name: "合同详情",
    dsl: {
      pageCode: "contract_detail",
      title: "合同详情",
      subtitle: "查看合同完整信息和关联产品",
      pageKind: "shtml",
      layout: "detail",
      dataApi: "contract_list.detail",
      presentation: { theme: "flatTech", density: "compact" },
      sections: [
        { title: "合同信息", fields: [
          { key: "contract_no", label: "合同编号", type: "text" },
          { key: "student_name", label: "学员", type: "text" },
          { key: "organization_name", label: "校区", type: "text" },
          { key: "paid_status", label: "付款状态", type: "text", badge: true },
          { key: "contract_type", label: "合同类型", type: "text", defaultValue: "NEW_SIGN" },
          { key: "total_amount", label: "应收金额", type: "text" },
          { key: "paid_amount", label: "已收金额", type: "text" },
          { key: "contract_status", label: "合同状态", type: "text", badge: true }
        ]},
        { title: "合同产品", dataSource: { pageCode: "contract_product_list", apiCode: "contract_product_list.query", filterField: "contract_id" }, type: "table" },
        { title: "收款记录", dataSource: { pageCode: "funds_history", apiCode: "funds_history.query", filterField: "contract_id" }, type: "table" }
      ]
    }
  },
  {
    pageCode: "course_detail",
    pageKind: "shtml",
    module: "education",
    feature: "course_detail",
    name: "课程详情",
    dsl: {
      pageCode: "course_detail",
      title: "课程详情",
      subtitle: "查看课程完整信息和上课学员",
      pageKind: "shtml",
      layout: "detail",
      dataApi: "course_list.detail",
      presentation: { theme: "flatTech", density: "compact" },
      sections: [
        { title: "课程信息", fields: [
          { key: "course_title", label: "课程名称", type: "text" },
          { key: "course_type", label: "课程类型", type: "text" },
          { key: "course_dates", label: "上课日期", type: "multiDate", span: 2 as const, defaultFutureOnly: true },
  { key: "course_date", label: "单次日期", type: "date", hidden: true },
          { key: "start_time", label: "开始时间", type: "text" },
          { key: "end_time", label: "结束时间", type: "text" },
          { key: "course_status", label: "状态", type: "text", badge: true },
          { key: "course_hour", label: "课时", type: "text" }
        ]},
        { title: "上课学员", dataSource: { pageCode: "course_list", apiCode: "course_list.detail" }, type: "table" }
      ]
    }
  }
];

export const actionDslSeeds: Array<{ actionCode: string; actionName: string; actionType: string; pageCode: string; module: string; feature: string; dsl: Record<string, unknown> }> = [
  { actionCode: "student_list.create", actionName: "新增学员", actionType: "open_modal", pageCode: "student_list", module: "student", feature: "student_list", dsl: { actionCode: "student_list.create", actionName: "新增学员", actionType: "open_modal", modalCode: "student_add_modal", afterSuccess: [{ type: "toast", message: "学员创建成功" }, { type: "refreshPage" }] } },
  { actionCode: "student_list.edit", actionName: "编辑学员", actionType: "open_modal", pageCode: "student_list", module: "student", feature: "student_list", dsl: { actionCode: "student_list.edit", actionName: "编辑学员", actionType: "open_modal", modalCode: "student_edit_modal", afterSuccess: [{ type: "toast", message: "学员更新成功" }, { type: "refreshPage" }] } },
  { actionCode: "student_list.detail", actionName: "学员详情", actionType: "open_modal", pageCode: "student_list", module: "student", feature: "student_list", dsl: { actionCode: "student_list.detail", actionName: "学员详情", actionType: "open_modal", modalCode: "student_detail_modal" } },
  { actionCode: "student_list.delete", actionName: "删除学员", actionType: "execute_api", pageCode: "student_list", module: "student", feature: "student_list", dsl: { actionCode: "student_list.delete", actionName: "删除学员", actionType: "execute_api", apiCode: "student_list.delete", confirm: true, afterSuccess: [{ type: "toast", message: "学员已删除" }, { type: "refreshPage" }] } },
  { actionCode: "student_list.prestore", actionName: "学员预存", actionType: "open_modal", pageCode: "student_list", module: "student", feature: "student_list", dsl: { actionCode: "student_list.prestore", actionName: "学员预存", actionType: "open_modal", modalCode: "funds_add_modal", afterSuccess: [{ type: "toast", message: "预存成功" }, { type: "refreshPage" }] } },
  { actionCode: "student_list.followup", actionName: "新增跟进", actionType: "open_modal", pageCode: "student_list", module: "student", feature: "student_list", dsl: { actionCode: "student_list.followup", actionName: "新增跟进", actionType: "open_modal", afterSuccess: [{ type: "toast", message: "跟进已记录" }, { type: "refreshPage" }] } },
  { actionCode: "student_list.refresh", actionName: "刷新", actionType: "execute_api", pageCode: "student_list", module: "student", feature: "student_list", dsl: { actionCode: "student_list.refresh", actionName: "刷新", actionType: "execute_api", apiCode: "student_list.query" } },
  { actionCode: "lead_list.enroll", actionName: "新增报名", actionType: "open_modal", pageCode: "lead_list", module: "recruit", feature: "lead_list", dsl: { actionCode: "lead_list.enroll", actionName: "新增报名", actionType: "open_modal", modalCode: "contract_add_modal", afterSuccess: [{ type: "toast", message: "报名成功" }, { type: "refreshPage" }] } },
  { actionCode: "lead_list.create", actionName: "新增意向学员", actionType: "open_modal", pageCode: "lead_list", module: "recruit", feature: "lead_list", dsl: { actionCode: "lead_list.create", actionName: "新增意向学员", actionType: "open_modal", apiCode: "lead_list.create", modalCode: "student_add_modal", defaultValues: { student_status: "LEAD", source_type: "MANUAL" }, afterSuccess: [{ type: "toast", message: "意向学员创建成功" }, { type: "refreshPage" }] } },
  { actionCode: "lead_list.edit", actionName: "编辑意向学员", actionType: "open_modal", pageCode: "lead_list", module: "recruit", feature: "lead_list", dsl: { actionCode: "lead_list.edit", actionName: "编辑意向学员", actionType: "open_modal", modalCode: "student_edit_modal", afterSuccess: [{ type: "toast", message: "意向学员更新成功" }, { type: "refreshPage" }] } },
  { actionCode: "lead_list.detail", actionName: "意向学员详情", actionType: "open_modal", pageCode: "lead_list", module: "recruit", feature: "lead_list", dsl: { actionCode: "lead_list.detail", actionName: "意向学员详情", actionType: "open_modal", modalCode: "student_detail_modal" } },
  { actionCode: "lead_list.delete", actionName: "删除意向学员", actionType: "execute_api", pageCode: "lead_list", module: "recruit", feature: "lead_list", dsl: { actionCode: "lead_list.delete", actionName: "删除意向学员", actionType: "execute_api", apiCode: "lead_list.delete", confirm: true, afterSuccess: [{ type: "toast", message: "意向学员已删除" }, { type: "refreshPage" }] } },
  { actionCode: "lead_list.refresh", actionName: "刷新", actionType: "execute_api", pageCode: "lead_list", module: "recruit", feature: "lead_list", dsl: { actionCode: "lead_list.refresh", actionName: "刷新", actionType: "execute_api", apiCode: "lead_list.query" } },
  { actionCode: "contract_list.create", actionName: "新增合同", actionType: "open_page", pageCode: "contract_list", module: "finance", feature: "contract_list", dsl: { actionCode: "contract_list.create", actionName: "新增合同", actionType: "open_page", targetPageCode: "lead_list", target: { pageCode: "lead_list", title: "新生报名" } } },
  { actionCode: "contract_list.edit", actionName: "编辑合同", actionType: "open_modal", pageCode: "contract_list", module: "finance", feature: "contract_list", dsl: { actionCode: "contract_list.edit", actionName: "编辑合同", actionType: "open_modal", modalCode: "contract_add_modal", afterSuccess: [{ type: "toast", message: "合同更新成功" }, { type: "refreshPage" }] } },
  { actionCode: "contract_list.detail", actionName: "合同详情", actionType: "open_modal", pageCode: "contract_list", module: "finance", feature: "contract_list", dsl: { actionCode: "contract_list.detail", actionName: "合同详情", actionType: "open_modal", modalCode: "contract_detail_modal" } },
  { actionCode: "contract_list.funds", actionName: "合同收款", actionType: "open_modal", pageCode: "contract_list", module: "finance", feature: "contract_list", dsl: { actionCode: "contract_list.funds", actionName: "合同收款", actionType: "open_modal", modalCode: "funds_add_modal", afterSuccess: [{ type: "toast", message: "收款成功" }, { type: "refreshPage" }] } },
  { actionCode: "contract_list.delete", actionName: "删除合同", actionType: "execute_api", pageCode: "contract_list", module: "finance", feature: "contract_list", dsl: { actionCode: "contract_list.delete", actionName: "删除合同", actionType: "execute_api", apiCode: "contract_list.delete", confirm: true, afterSuccess: [{ type: "toast", message: "合同已删除" }, { type: "refreshPage" }] } },
  { actionCode: "contract_list.refresh", actionName: "刷新", actionType: "execute_api", pageCode: "contract_list", module: "finance", feature: "contract_list", dsl: { actionCode: "contract_list.refresh", actionName: "刷新", actionType: "execute_api", apiCode: "contract_list.query" } },
  { actionCode: "course_list.create", actionName: "新增排课", actionType: "open_modal", pageCode: "course_list", module: "education", feature: "course_list", dsl: { actionCode: "course_list.create", actionName: "新增排课", actionType: "open_modal", modalCode: "course_add_modal", afterSuccess: [{ type: "toast", message: "排课创建成功" }, { type: "refreshPage" }] } },
  { actionCode: "course_list.edit", actionName: "编辑排课", actionType: "open_modal", pageCode: "course_list", module: "education", feature: "course_list", dsl: { actionCode: "course_list.edit", actionName: "编辑排课", actionType: "open_modal", apiCode: "course.update", afterSuccess: [{ type: "toast", message: "排课更新成功" }, { type: "refreshPage" }] } },
  { actionCode: "course_list.detail", actionName: "课程详情", actionType: "open_modal", pageCode: "course_list", module: "education", feature: "course_list", dsl: { actionCode: "course_list.detail", actionName: "课程详情", actionType: "open_modal", modalCode: "course_detail_modal" } },
  { actionCode: "course_list.delete", actionName: "删除课程", actionType: "execute_api", pageCode: "course_list", module: "education", feature: "course_list", dsl: { actionCode: "course_list.delete", actionName: "删除课程", actionType: "execute_api", apiCode: "course_list.delete", confirm: true, afterSuccess: [{ type: "toast", message: "课程已删除" }, { type: "refreshPage" }] } },
  { actionCode: "course_list.refresh", actionName: "刷新", actionType: "execute_api", pageCode: "course_list", module: "education", feature: "course_list", dsl: { actionCode: "course_list.refresh", actionName: "刷新", actionType: "execute_api", apiCode: "course_list.query" } },
  { actionCode: "charge_record.create", actionName: "新增扣费", actionType: "open_modal", pageCode: "charge_record", module: "education", feature: "charge_record", dsl: { actionCode: "charge_record.create", actionName: "新增扣费", actionType: "open_modal", modalCode: "charge_confirm_modal", afterSuccess: [{ type: "toast", message: "扣费成功" }, { type: "refreshPage" }] } },
  { actionCode: "charge_record.detail", actionName: "扣费详情", actionType: "open_modal", pageCode: "charge_record", module: "education", feature: "charge_record", dsl: { actionCode: "charge_record.detail", actionName: "扣费详情", actionType: "open_modal", modalCode: "charge_detail_modal" } },
  { actionCode: "charge_record.refresh", actionName: "刷新", actionType: "execute_api", pageCode: "charge_record", module: "education", feature: "charge_record", dsl: { actionCode: "charge_record.refresh", actionName: "刷新", actionType: "execute_api", apiCode: "charge_record.query" } },
  { actionCode: "funds_history.create", actionName: "新增收款", actionType: "open_modal", pageCode: "funds_history", module: "finance", feature: "funds_history", dsl: { actionCode: "funds_history.create", actionName: "新增收款", actionType: "open_modal", modalCode: "funds_add_modal", afterSuccess: [{ type: "toast", message: "收款成功" }, { type: "refreshPage" }] } },
  { actionCode: "funds_history.detail", actionName: "收款详情", actionType: "open_modal", pageCode: "funds_history", module: "finance", feature: "funds_history", dsl: { actionCode: "funds_history.detail", actionName: "收款详情", actionType: "open_modal", modalCode: "funds_detail_modal" } },
  { actionCode: "funds_history.delete", actionName: "作废收款", actionType: "open_modal", pageCode: "funds_history", module: "finance", feature: "funds_history", dsl: { actionCode: "funds_history.delete", actionName: "作废收款", actionType: "open_modal", apiCode: "funds.delete", variant: "danger", confirm: "作废后将回滚排款、优惠、业绩与电子账户，确认继续？", afterSuccess: [{ type: "toast", message: "收款已作废并回滚" }, { type: "refreshPage" }] } },
  { actionCode: "funds_history.refresh", actionName: "刷新", actionType: "execute_api", pageCode: "funds_history", module: "finance", feature: "funds_history", dsl: { actionCode: "funds_history.refresh", actionName: "刷新", actionType: "execute_api", apiCode: "funds_history.query" } },
  { actionCode: "refund_record.create", actionName: "新增退费", actionType: "open_modal", pageCode: "refund_record", module: "finance", feature: "refund_record", dsl: { actionCode: "refund_record.create", actionName: "新增退费", actionType: "open_modal", modalCode: "refund_add_modal", afterSuccess: [{ type: "toast", message: "退费成功" }, { type: "refreshPage" }] } },
  { actionCode: "refund_record.refresh", actionName: "刷新", actionType: "execute_api", pageCode: "refund_record", module: "finance", feature: "refund_record", dsl: { actionCode: "refund_record.refresh", actionName: "刷新", actionType: "execute_api", apiCode: "refund_record.query" } },
  { actionCode: "product_list.create", actionName: "新增产品", actionType: "open_modal", pageCode: "product_list", module: "finance", feature: "product_list", dsl: { actionCode: "product_list.create", actionName: "新增产品", actionType: "open_modal", modalCode: "product_add_modal", afterSuccess: [{ type: "toast", message: "产品创建成功" }, { type: "refreshPage" }] } },
  { actionCode: "product_list.edit", actionName: "编辑产品", actionType: "open_modal", pageCode: "product_list", module: "finance", feature: "product_list", dsl: { actionCode: "product_list.edit", actionName: "编辑产品", actionType: "open_modal", modalCode: "product_edit_modal", afterSuccess: [{ type: "toast", message: "产品更新成功" }, { type: "refreshPage" }] } },
  { actionCode: "product_list.refresh", actionName: "刷新", actionType: "execute_api", pageCode: "product_list", module: "finance", feature: "product_list", dsl: { actionCode: "product_list.refresh", actionName: "刷新", actionType: "execute_api", apiCode: "product_list.query" } },
  { actionCode: "promotion_list.create", actionName: "新增优惠", actionType: "open_modal", pageCode: "promotion_list", module: "finance", feature: "promotion_list", dsl: { actionCode: "promotion_list.create", actionName: "新增优惠", actionType: "open_modal", modalCode: "promotion_add_modal", afterSuccess: [{ type: "toast", message: "优惠创建成功" }, { type: "refreshPage" }] } },
  { actionCode: "promotion_list.refresh", actionName: "刷新", actionType: "execute_api", pageCode: "promotion_list", module: "finance", feature: "promotion_list", dsl: { actionCode: "promotion_list.refresh", actionName: "刷新", actionType: "execute_api", apiCode: "promotion_list.query" } },
  { actionCode: "role_list.create", actionName: "新增角色", actionType: "open_modal", pageCode: "role_list", module: "system", feature: "role_list", dsl: { actionCode: "role_list.create", actionName: "新增角色", actionType: "open_modal", modalCode: "role_permission_modal", afterSuccess: [{ type: "toast", message: "角色创建成功" }, { type: "refreshPage" }] } },
  { actionCode: "role_list.edit", actionName: "编辑权限", actionType: "open_modal", pageCode: "role_list", module: "system", feature: "role_list", dsl: { actionCode: "role_list.edit", actionName: "编辑权限", actionType: "open_modal", modalCode: "role_permission_modal", afterSuccess: [{ type: "toast", message: "权限更新成功" }, { type: "refreshPage" }] } },
  { actionCode: "role_list.refresh", actionName: "刷新", actionType: "execute_api", pageCode: "role_list", module: "system", feature: "role_list", dsl: { actionCode: "role_list.refresh", actionName: "刷新", actionType: "execute_api", apiCode: "role_list.query" } },
  { actionCode: "approval_flow_list.create", actionName: "新增审批", actionType: "open_modal", pageCode: "approval_flow_list", module: "oa", feature: "approval_flow_list", dsl: { actionCode: "approval_flow_list.create", actionName: "新增审批", actionType: "open_modal", afterSuccess: [{ type: "toast", message: "审批配置创建成功" }, { type: "refreshPage" }] } },
  { actionCode: "approval_flow_list.edit", actionName: "编辑审批", actionType: "open_modal", pageCode: "approval_flow_list", module: "oa", feature: "approval_flow_list", dsl: { actionCode: "approval_flow_list.edit", actionName: "编辑审批", actionType: "open_modal", afterSuccess: [{ type: "toast", message: "审批配置已更新" }, { type: "refreshPage" }] } },
  { actionCode: "approval_flow_list.delete", actionName: "删除审批", actionType: "execute_api", pageCode: "approval_flow_list", module: "oa", feature: "approval_flow_list", dsl: { actionCode: "approval_flow_list.delete", actionName: "删除审批", actionType: "execute_api", apiCode: "approval_flow_list.delete", confirm: true, afterSuccess: [{ type: "toast", message: "审批配置已删除" }, { type: "refreshPage" }] } },
  { actionCode: "approval_flow_list.refresh", actionName: "刷新", actionType: "execute_api", pageCode: "approval_flow_list", module: "oa", feature: "approval_flow_list", dsl: { actionCode: "approval_flow_list.refresh", actionName: "刷新", actionType: "execute_api", apiCode: "approval_flow_list.query" } },
  { actionCode: "approval_task_list.detail", actionName: "查看详情", actionType: "open_modal", pageCode: "approval_task_list", module: "oa", feature: "approval_task_list", dsl: { actionCode: "approval_task_list.detail", actionName: "查看详情", actionType: "open_modal", modalCode: "approval_task_detail_modal" } },
  { actionCode: "approval_task_list.approve", actionName: "同意", actionType: "execute_api", pageCode: "approval_task_list", module: "oa", feature: "approval_task_list", dsl: { actionCode: "approval_task_list.approve", actionName: "同意", actionType: "execute_api", apiCode: "approvalTask.approve", confirm: true, afterSuccess: [{ type: "toast", message: "审批已同意" }, { type: "refreshPage" }] } },
  { actionCode: "approval_task_list.reject", actionName: "驳回", actionType: "execute_api", pageCode: "approval_task_list", module: "oa", feature: "approval_task_list", dsl: { actionCode: "approval_task_list.reject", actionName: "驳回", actionType: "execute_api", apiCode: "approvalTask.reject", confirm: true, afterSuccess: [{ type: "toast", message: "审批已驳回" }, { type: "refreshPage" }] } },
  { actionCode: "approval_task_list.cancel", actionName: "撤回", actionType: "execute_api", pageCode: "approval_task_list", module: "oa", feature: "approval_task_list", dsl: { actionCode: "approval_task_list.cancel", actionName: "撤回", actionType: "execute_api", apiCode: "approvalTask.cancel", confirm: true, afterSuccess: [{ type: "toast", message: "审批已撤回" }, { type: "refreshPage" }] } },
  { actionCode: "approval_task_list.refresh", actionName: "刷新", actionType: "execute_api", pageCode: "approval_task_list", module: "oa", feature: "approval_task_list", dsl: { actionCode: "approval_task_list.refresh", actionName: "刷新", actionType: "execute_api", apiCode: "approval_task_list.query" } },
  { actionCode: "approval_task_log_list.refresh", actionName: "刷新", actionType: "execute_api", pageCode: "approval_task_log_list", module: "oa", feature: "approval_task_log_list", dsl: { actionCode: "approval_task_log_list.refresh", actionName: "刷新", actionType: "execute_api", apiCode: "approval_task_log_list.query" } },
  { actionCode: "business_rule_list.create", actionName: "新增规则", actionType: "open_modal", pageCode: "business_rule_list", module: "system", feature: "business_rule_list", dsl: { actionCode: "business_rule_list.create", actionName: "新增规则", actionType: "open_modal", afterSuccess: [{ type: "toast", message: "规则创建成功" }, { type: "refreshPage" }] } },
  { actionCode: "business_rule_list.edit", actionName: "编辑规则", actionType: "open_modal", pageCode: "business_rule_list", module: "system", feature: "business_rule_list", dsl: { actionCode: "business_rule_list.edit", actionName: "编辑规则", actionType: "open_modal", afterSuccess: [{ type: "toast", message: "规则已更新" }, { type: "refreshPage" }] } },
  { actionCode: "business_rule_list.delete", actionName: "删除规则", actionType: "execute_api", pageCode: "business_rule_list", module: "system", feature: "business_rule_list", dsl: { actionCode: "business_rule_list.delete", actionName: "删除规则", actionType: "execute_api", apiCode: "business_rule_list.delete", confirm: true, afterSuccess: [{ type: "toast", message: "租户自定义规则已删除" }, { type: "refreshPage" }] } },
  { actionCode: "business_rule_list.refresh", actionName: "刷新", actionType: "execute_api", pageCode: "business_rule_list", module: "system", feature: "business_rule_list", dsl: { actionCode: "business_rule_list.refresh", actionName: "刷新", actionType: "execute_api", apiCode: "business_rule_list.query" } },
  { actionCode: "user_list.create", actionName: "新增员工", actionType: "open_modal", pageCode: "user_list", module: "system", feature: "user_list", dsl: { actionCode: "user_list.create", actionName: "新增员工", actionType: "open_modal", modalCode: "user_add_modal", afterSuccess: [{ type: "toast", message: "员工创建成功" }, { type: "refreshPage" }] } },
  { actionCode: "user_list.edit", actionName: "编辑员工", actionType: "open_modal", pageCode: "user_list", module: "system", feature: "user_list", dsl: { actionCode: "user_list.edit", actionName: "编辑员工", actionType: "open_modal", modalCode: "user_add_modal", afterSuccess: [{ type: "toast", message: "员工更新成功" }, { type: "refreshPage" }] } },
  { actionCode: "user_list.refresh", actionName: "刷新", actionType: "execute_api", pageCode: "user_list", module: "system", feature: "user_list", dsl: { actionCode: "user_list.refresh", actionName: "刷新", actionType: "execute_api", apiCode: "user_list.query" } },
  { actionCode: "organization_list.refresh", actionName: "刷新", actionType: "execute_api", pageCode: "organization_list", module: "system", feature: "organization_list", dsl: { actionCode: "organization_list.refresh", actionName: "刷新", actionType: "execute_api", apiCode: "organization_list.query" } },
  { actionCode: "notice_list.refresh", actionName: "刷新", actionType: "execute_api", pageCode: "notice_list", module: "oa", feature: "notice_list", dsl: { actionCode: "notice_list.refresh", actionName: "刷新", actionType: "execute_api", apiCode: "notice_list.query" } },
  { actionCode: "pay_way_list.refresh", actionName: "刷新", actionType: "execute_api", pageCode: "pay_way_list", module: "finance", feature: "pay_way_list", dsl: { actionCode: "pay_way_list.refresh", actionName: "刷新", actionType: "execute_api", apiCode: "pay_way_list.query" } },
  { actionCode: "student_report.refresh", actionName: "刷新", actionType: "execute_api", pageCode: "student_report", module: "report", feature: "student_report", dsl: { actionCode: "student_report.refresh", actionName: "刷新", actionType: "execute_api", apiCode: "student_report.query" } },
  { actionCode: "student_handover.assignManager", actionName: "分配学管师", actionType: "open_modal", pageCode: "student_handover", module: "student", feature: "student_handover", dsl: { actionCode: "student_handover.assignManager", actionName: "分配学管师", actionType: "open_modal", modalCode: "assign_manager_modal", afterSuccess: [{ type: "toast", message: "学管师分配成功" }, { type: "refreshPage" }] } },
  { actionCode: "today_course.detail", actionName: "课程详情", actionType: "open_modal", pageCode: "today_course", module: "education", feature: "today_course", dsl: { actionCode: "today_course.detail", actionName: "课程详情", actionType: "open_modal", modalCode: "course_detail_modal" } },
  { actionCode: "student_visit.sign_in", actionName: "签到", actionType: "execute_api", pageCode: "student_visit", module: "student", feature: "student_visit", dsl: { actionCode: "student_visit.sign_in", actionName: "签到", actionType: "execute_api", apiCode: "course.update", afterSuccess: [{ type: "toast", message: "签到成功" }, { type: "refreshPage" }] } },
  { actionCode: "student_visit.sign_out", actionName: "签退", actionType: "execute_api", pageCode: "student_visit", module: "student", feature: "student_visit", dsl: { actionCode: "student_visit.sign_out", actionName: "签退", actionType: "execute_api", apiCode: "course.update", afterSuccess: [{ type: "toast", message: "签退成功" }, { type: "refreshPage" }] } },
  { actionCode: "money_arrange_list.refresh", actionName: "刷新", actionType: "execute_api", pageCode: "money_arrange_list", module: "finance", feature: "money_arrange_list", dsl: { actionCode: "money_arrange_list.refresh", actionName: "刷新", actionType: "execute_api", apiCode: "money_arrange_list.query" } },
  { actionCode: "money_arrange_list.detail", actionName: "详情", actionType: "open_modal", pageCode: "money_arrange_list", module: "finance", feature: "money_arrange_list", dsl: { actionCode: "money_arrange_list.detail", actionName: "详情", actionType: "open_modal", modalCode: "money_arrange_detail_modal" } },
  { actionCode: "promotion_arrange_list.refresh", actionName: "刷新", actionType: "execute_api", pageCode: "promotion_arrange_list", module: "finance", feature: "promotion_arrange_list", dsl: { actionCode: "promotion_arrange_list.refresh", actionName: "刷新", actionType: "execute_api", apiCode: "promotion_arrange_list.query" } },
  { actionCode: "promotion_arrange_list.detail", actionName: "详情", actionType: "open_modal", pageCode: "promotion_arrange_list", module: "finance", feature: "promotion_arrange_list", dsl: { actionCode: "promotion_arrange_list.detail", actionName: "详情", actionType: "open_modal", modalCode: "promotion_arrange_detail_modal" } },
  { actionCode: "performance_arrange_list.refresh", actionName: "刷新", actionType: "execute_api", pageCode: "performance_arrange_list", module: "finance", feature: "performance_arrange_list", dsl: { actionCode: "performance_arrange_list.refresh", actionName: "刷新", actionType: "execute_api", apiCode: "performance_arrange_list.query" } },
  { actionCode: "performance_arrange_list.detail", actionName: "详情", actionType: "open_modal", pageCode: "performance_arrange_list", module: "finance", feature: "performance_arrange_list", dsl: { actionCode: "performance_arrange_list.detail", actionName: "详情", actionType: "open_modal", modalCode: "performance_arrange_detail_modal" } },
  { actionCode: "finance_report.refresh", actionName: "刷新", actionType: "execute_api", pageCode: "finance_report", module: "report", feature: "finance_report", dsl: { actionCode: "finance_report.refresh", actionName: "刷新", actionType: "execute_api", apiCode: "finance_report.query" } },
  { actionCode: "course_report.refresh", actionName: "刷新", actionType: "execute_api", pageCode: "course_report", module: "report", feature: "course_report", dsl: { actionCode: "course_report.refresh", actionName: "刷新", actionType: "execute_api", apiCode: "course_report.query" } },
  { actionCode: "customization_record_list.new_customization", actionName: "新增定制化", actionType: "open_ai_customization", pageCode: "customization_record_list", module: "system", feature: "customization_record_list", dsl: { actionCode: "customization_record_list.new_customization", actionName: "新增定制化", actionType: "open_ai_customization", variant: "primary" } },
  { actionCode: "tenant_version_list.publish", actionName: "发布版本", actionType: "execute_api", pageCode: "tenant_version_list", module: "system", feature: "tenant_version_list", dsl: { actionCode: "tenant_version_list.publish", actionName: "发布版本", actionType: "execute_api", apiCode: "dsl_version.publish", confirm: "确认发布此版本？", afterSuccess: [{ type: "toast", message: "版本已发布" }, { type: "refreshPage" }] } },
  { actionCode: "tenant_version_list.rollback", actionName: "回滚到此版本", actionType: "execute_api", pageCode: "tenant_version_list", module: "system", feature: "tenant_version_list", dsl: { actionCode: "tenant_version_list.rollback", actionName: "回滚到此版本", actionType: "execute_api", apiCode: "dsl_version.rollback", confirm: "确认回滚到此版本？将创建新版本并恢复DSL。", afterSuccess: [{ type: "toast", message: "回滚成功" }, { type: "refreshPage" }] } },
  { actionCode: "tenant_version_list.rollback_preview", actionName: "回滚预览", actionType: "execute_api", pageCode: "tenant_version_list", module: "system", feature: "tenant_version_list", dsl: { actionCode: "tenant_version_list.rollback_preview", actionName: "回滚预览", actionType: "execute_api", apiCode: "dsl_version.rollback_preview", afterSuccess: [{ type: "toast", message: "回滚预览已生成" }, { type: "refreshPage" }] } },
  { actionCode: "tenant_version_list.refresh", actionName: "刷新", actionType: "execute_api", pageCode: "tenant_version_list", module: "system", feature: "tenant_version_list", dsl: { actionCode: "tenant_version_list.refresh", actionName: "刷新", actionType: "execute_api", apiCode: "tenant_version_list.query" } },
  { actionCode: "contract_list.refund", actionName: "合同退费", actionType: "open_modal", pageCode: "contract_list", module: "finance", feature: "contract_list", dsl: { actionCode: "contract_list.refund", actionName: "合同退费", actionType: "open_modal", modalCode: "contract_refund_modal", afterSuccess: [{ type: "toast", message: "退费成功" }, { type: "refreshPage" }] } },
  { actionCode: "contract_product_list.refund", actionName: "合同产品退费", actionType: "open_modal", pageCode: "contract_product_list", module: "finance", feature: "contract_product_list", dsl: { actionCode: "contract_product_list.refund", actionName: "合同产品退费", actionType: "open_modal", afterSuccess: [{ type: "toast", message: "退费成功" }, { type: "refreshPage" }] } },
  { actionCode: "refund_record.delete", actionName: "删除退费记录", actionType: "execute_api", pageCode: "refund_record", module: "finance", feature: "refund_record", dsl: { actionCode: "refund_record.delete", actionName: "删除退费记录", actionType: "execute_api", apiCode: "refund.delete", confirm: "确认删除该退费记录？删除后将恢复合同产品余额", afterSuccess: [{ type: "toast", message: "退费记录已删除，余额已恢复" }, { type: "refreshPage" }] } },
  { actionCode: "course_list.attendance", actionName: "考勤签到", actionType: "open_modal", pageCode: "course_list", module: "education", feature: "course_list", dsl: { actionCode: "course_list.attendance", actionName: "考勤签到", actionType: "open_modal", modalCode: "attendance_check_in_modal", afterSuccess: [{ type: "toast", message: "考勤成功" }, { type: "refreshPage" }] } },
  { actionCode: "course_list.cancel", actionName: "取消排课", actionType: "execute_api", pageCode: "course_list", module: "education", feature: "course_list", dsl: { actionCode: "course_list.cancel", actionName: "取消排课", actionType: "execute_api", apiCode: "course.cancel", confirm: "确认取消该排课？已有考勤或扣费的课程不能取消", variant: "danger", afterSuccess: [{ type: "toast", message: "排课已取消" }, { type: "refreshPage" }] } },
  { actionCode: "course_list.leave", actionName: "学员请假", actionType: "open_modal", pageCode: "course_list", module: "education", feature: "course_list", dsl: { actionCode: "course_list.leave", actionName: "学员请假", actionType: "open_modal", apiCode: "leave_record.create", afterSuccess: [{ type: "toast", message: "请假已登记" }, { type: "refreshPage" }] } },
  { actionCode: "course_list.makeup", actionName: "安排补课", actionType: "open_modal", pageCode: "course_list", module: "education", feature: "course_list", dsl: { actionCode: "course_list.makeup", actionName: "安排补课", actionType: "open_modal", apiCode: "makeup_course_record.create", afterSuccess: [{ type: "toast", message: "补课已安排" }, { type: "refreshPage" }] } },
  { actionCode: "contract_list.export", actionName: "导出合同", actionType: "export", pageCode: "contract_list", module: "finance", feature: "contract_list", dsl: { actionCode: "contract_list.export", actionName: "导出合同", actionType: "export", apiCode: "contract_list.query" } },
  { actionCode: "contract_list.import", actionName: "导入合同", actionType: "import", pageCode: "contract_list", module: "finance", feature: "contract_list", dsl: { actionCode: "contract_list.import", actionName: "导入合同", actionType: "import", apiCode: "contract_list.create" } },
  { actionCode: "contract_list.print", actionName: "打印合同收据", actionType: "display", pageCode: "contract_list", module: "finance", feature: "contract_list", dsl: { actionCode: "contract_list.print", actionName: "打印合同收据", actionType: "display", printTemplateCode: "contract_receipt_print" } },
  { actionCode: "refund_record.detail", actionName: "退费详情", actionType: "open_modal", pageCode: "refund_record", module: "finance", feature: "refund_record", dsl: { actionCode: "refund_record.detail", actionName: "退费详情", actionType: "open_modal" } },
  { actionCode: "course_holiday_calendar.cancelCourses", actionName: "批量取消课程", actionType: "execute_api", pageCode: "course_holiday_calendar", module: "education", feature: "course_holiday_calendar", dsl: { actionCode: "course_holiday_calendar.cancelCourses", actionName: "批量取消课程", actionType: "execute_api", apiCode: "holiday.apply", confirm: "确认按停课规则批量取消影响课程？", afterSuccess: [{ type: "toast", message: "已按停课规则处理" }, { type: "refreshPage" }] } },
  { actionCode: "course_holiday_calendar.postponeCourses", actionName: "批量顺延课程", actionType: "execute_api", pageCode: "course_holiday_calendar", module: "education", feature: "course_holiday_calendar", dsl: { actionCode: "course_holiday_calendar.postponeCourses", actionName: "批量顺延课程", actionType: "execute_api", apiCode: "holiday.apply", confirm: "确认按停课规则批量顺延影响课程？", afterSuccess: [{ type: "toast", message: "已按停课规则处理" }, { type: "refreshPage" }] } },
  { actionCode: "course_week_schedule.attendance", actionName: "周课表考勤", actionType: "open_modal", pageCode: "course_week_schedule", module: "education", feature: "course_week_schedule", dsl: { actionCode: "course_week_schedule.attendance", actionName: "周课表考勤", actionType: "open_modal", modalCode: "attendance_check_in_modal", afterSuccess: [{ type: "toast", message: "考勤成功" }, { type: "refreshPage" }] } },
  { actionCode: "course_week_schedule.leave", actionName: "周课表请假", actionType: "open_modal", pageCode: "course_week_schedule", module: "education", feature: "course_week_schedule", dsl: { actionCode: "course_week_schedule.leave", actionName: "周课表请假", actionType: "open_modal", apiCode: "leave_record.create", afterSuccess: [{ type: "toast", message: "请假已登记" }, { type: "refreshPage" }] } },
  { actionCode: "course_week_schedule.makeup", actionName: "周课表补课", actionType: "open_modal", pageCode: "course_week_schedule", module: "education", feature: "course_week_schedule", dsl: { actionCode: "course_week_schedule.makeup", actionName: "周课表补课", actionType: "open_modal", apiCode: "makeup_course_record.create", afterSuccess: [{ type: "toast", message: "补课已安排" }, { type: "refreshPage" }] } },
  { actionCode: "course_list.cancelAttendance", actionName: "取消考勤", actionType: "execute_api", pageCode: "course_list", module: "education", feature: "course_list", dsl: { actionCode: "course_list.cancelAttendance", actionName: "取消考勤", actionType: "execute_api", apiCode: "attendance.cancel", confirm: "确认取消该学员考勤？", afterSuccess: [{ type: "toast", message: "考勤已取消" }, { type: "refreshPage" }] } },
  { actionCode: "charge_record.reverse", actionName: "取消扣费", actionType: "open_modal", pageCode: "charge_record", module: "finance", feature: "charge_record", dsl: { actionCode: "charge_record.reverse", actionName: "取消扣费", actionType: "open_modal", modalCode: "charge_reverse_modal", mapRowToValue: { id: "id" }, afterSuccess: [{ type: "toast", message: "扣费已取消" }, { type: "refreshPage" }] } },
  { actionCode: "mini_class_list.create", actionName: "新增班级", actionType: "open_modal", pageCode: "mini_class_list", module: "education", feature: "mini_class_list", dsl: { actionCode: "mini_class_list.create", actionName: "新增班级", actionType: "open_modal", modalCode: "mini_class_add_modal", afterSuccess: [{ type: "toast", message: "班级创建成功" }, { type: "refreshPage" }] } },
  { actionCode: "mini_class_list.edit", actionName: "编辑班级", actionType: "open_modal", pageCode: "mini_class_list", module: "education", feature: "mini_class_list", dsl: { actionCode: "mini_class_list.edit", actionName: "编辑班级", actionType: "open_modal", modalCode: "mini_class_add_modal", afterSuccess: [{ type: "toast", message: "班级更新成功" }, { type: "refreshPage" }] } },
  { actionCode: "mini_class_list.detail", actionName: "班级详情", actionType: "open_modal", pageCode: "mini_class_list", module: "education", feature: "mini_class_list", dsl: { actionCode: "mini_class_list.detail", actionName: "班级详情", actionType: "open_modal", modalCode: "mini_class_detail_modal" } },
  { actionCode: "mini_class_list.addStudent", actionName: "添加班级学员", actionType: "open_modal", pageCode: "mini_class_list", module: "education", feature: "mini_class_list", dsl: { actionCode: "mini_class_list.addStudent", actionName: "添加班级学员", actionType: "open_modal", modalCode: "mini_class_add_student_modal", afterSuccess: [{ type: "toast", message: "学员添加成功" }, { type: "refreshPage" }] } },
  { actionCode: "mini_class_list.delete", actionName: "删除班级", actionType: "execute_api", pageCode: "mini_class_list", module: "education", feature: "mini_class_list", dsl: { actionCode: "mini_class_list.delete", actionName: "删除班级", actionType: "execute_api", apiCode: "mini_class_list.delete", confirm: true, afterSuccess: [{ type: "toast", message: "班级已删除" }, { type: "refreshPage" }] } },
  { actionCode: "mini_class_list.refresh", actionName: "刷新", actionType: "execute_api", pageCode: "mini_class_list", module: "education", feature: "mini_class_list", dsl: { actionCode: "mini_class_list.refresh", actionName: "刷新", actionType: "execute_api", apiCode: "mini_class_list.query" } },
  { actionCode: "one_on_n_group_list.create", actionName: "新增1对N小组", actionType: "open_modal", pageCode: "one_on_n_group_list", module: "education", feature: "one_on_n_group_list", dsl: { actionCode: "one_on_n_group_list.create", actionName: "新增1对N小组", actionType: "open_modal", modalCode: "one_on_n_group_add_modal", afterSuccess: [{ type: "toast", message: "1对N小组创建成功" }, { type: "refreshPage" }] } },
  { actionCode: "one_on_n_group_list.edit", actionName: "编辑1对N小组", actionType: "open_modal", pageCode: "one_on_n_group_list", module: "education", feature: "one_on_n_group_list", dsl: { actionCode: "one_on_n_group_list.edit", actionName: "编辑1对N小组", actionType: "open_modal", modalCode: "one_on_n_group_add_modal", afterSuccess: [{ type: "toast", message: "1对N小组更新成功" }, { type: "refreshPage" }] } },
  { actionCode: "one_on_n_group_list.detail", actionName: "1对N小组详情", actionType: "open_modal", pageCode: "one_on_n_group_list", module: "education", feature: "one_on_n_group_list", dsl: { actionCode: "one_on_n_group_list.detail", actionName: "1对N小组详情", actionType: "open_modal", modalCode: "one_on_n_group_detail_modal" } },
  { actionCode: "one_on_n_group_list.addStudent", actionName: "添加1对N学员", actionType: "open_modal", pageCode: "one_on_n_group_list", module: "education", feature: "one_on_n_group_list", dsl: { actionCode: "one_on_n_group_list.addStudent", actionName: "添加1对N学员", actionType: "open_modal", modalCode: "one_on_n_group_add_student_modal", afterSuccess: [{ type: "toast", message: "学员添加成功" }, { type: "refreshPage" }] } },
  { actionCode: "one_on_n_group_list.delete", actionName: "删除1对N小组", actionType: "execute_api", pageCode: "one_on_n_group_list", module: "education", feature: "one_on_n_group_list", dsl: { actionCode: "one_on_n_group_list.delete", actionName: "删除1对N小组", actionType: "execute_api", apiCode: "one_on_n_group_list.delete", confirm: true, afterSuccess: [{ type: "toast", message: "1对N小组已删除" }, { type: "refreshPage" }] } },
  { actionCode: "one_on_n_group_list.refresh", actionName: "刷新", actionType: "execute_api", pageCode: "one_on_n_group_list", module: "education", feature: "one_on_n_group_list", dsl: { actionCode: "one_on_n_group_list.refresh", actionName: "刷新", actionType: "execute_api", apiCode: "one_on_n_group_list.query" } },
  { actionCode: "mini_class_student_list.refresh", actionName: "刷新", actionType: "execute_api", pageCode: "mini_class_student_list", module: "education", feature: "mini_class_student_list", dsl: { actionCode: "mini_class_student_list.refresh", actionName: "刷新", actionType: "execute_api", apiCode: "mini_class_student_list.query" } },
  { actionCode: "mini_class_student_list.detail", actionName: "详情", actionType: "open_modal", pageCode: "mini_class_student_list", module: "education", feature: "mini_class_student_list", dsl: { actionCode: "mini_class_student_list.detail", actionName: "详情", actionType: "open_modal", modalCode: "mini_class_student_detail_modal" } },
  { actionCode: "mini_class_student_list.removeStudent", actionName: "移除学员", actionType: "execute_api", pageCode: "mini_class_student_list", module: "education", feature: "mini_class_student_list", dsl: { actionCode: "mini_class_student_list.removeStudent", actionName: "移除学员", actionType: "execute_api", apiCode: "miniClass.removeStudent", confirm: "确认移除该学员？", afterSuccess: [{ type: "toast", message: "学员已移除" }, { type: "refreshPage" }] } },
  { actionCode: "one_on_n_group_student_list.refresh", actionName: "刷新", actionType: "execute_api", pageCode: "one_on_n_group_student_list", module: "education", feature: "one_on_n_group_student_list", dsl: { actionCode: "one_on_n_group_student_list.refresh", actionName: "刷新", actionType: "execute_api", apiCode: "one_on_n_group_student_list.query" } },
  { actionCode: "one_on_n_group_student_list.detail", actionName: "详情", actionType: "open_modal", pageCode: "one_on_n_group_student_list", module: "education", feature: "one_on_n_group_student_list", dsl: { actionCode: "one_on_n_group_student_list.detail", actionName: "详情", actionType: "open_modal", modalCode: "one_on_n_group_student_detail_modal" } },
  { actionCode: "one_on_n_group_student_list.removeStudent", actionName: "移除学员", actionType: "execute_api", pageCode: "one_on_n_group_student_list", module: "education", feature: "one_on_n_group_student_list", dsl: { actionCode: "one_on_n_group_student_list.removeStudent", actionName: "移除学员", actionType: "execute_api", apiCode: "oneOnNGroup.removeStudent", confirm: "确认移除该学员？", afterSuccess: [{ type: "toast", message: "学员已移除" }, { type: "refreshPage" }] } }
];

export const modalDslSeeds: Array<{ actionCode: string; actionName: string; pageCode: string; module: string; feature: string; dsl: Record<string, unknown> }> = [
  { actionCode: "student_add_modal", actionName: "新增学员弹窗", pageCode: "student_list", module: "student", feature: "student_list", dsl: { modalCode: "student_add_modal", modalName: "新增学员", size: "medium", columns: 3, labelAlign: "left", submitApiCode: "student_list.create", fields: [
    { key: "name", label: "姓名", type: "text", required: true }, { key: "contact", label: "联系电话", type: "text", required: true },
    { key: "organization_id", label: "校区", type: "text", optionSource: orgSelect }, { key: "student_status", label: "状态", type: "text" },
    { key: "source_type", label: "来源", type: "text" }, { key: "school_name", label: "学校", type: "text" },
    { key: "grade", label: "年级", type: "text" }, { key: "birthday", label: "生日", type: "date" },
    { key: "gender", label: "性别", type: "text" }, { key: "student_no", label: "学号", type: "text" },
    { key: "remark", label: "备注", type: "textarea", span: "full", rows: 3 }
  ] } },
  { actionCode: "student_edit_modal", actionName: "编辑学员弹窗", pageCode: "student_list", module: "student", feature: "student_list", dsl: { modalCode: "student_edit_modal", modalName: "编辑学员", size: "medium", columns: 3, labelAlign: "left", submitApiCode: "student_list.update", fields: [
    { key: "name", label: "姓名", type: "text", required: true }, { key: "contact", label: "联系电话", type: "text", required: true },
    { key: "organization_id", label: "校区", type: "text", optionSource: orgSelect }, { key: "student_status", label: "状态", type: "text" },
    { key: "source_type", label: "来源", type: "text" }, { key: "school_name", label: "学校", type: "text" },
    { key: "grade", label: "年级", type: "text" }, { key: "birthday", label: "生日", type: "date" },
    { key: "gender", label: "性别", type: "text" }, { key: "student_no", label: "学号", type: "text" },
    { key: "remark", label: "备注", type: "textarea", span: "full", rows: 3 }
  ] } },
  { actionCode: "student_detail_modal", actionName: "学员详情弹窗", pageCode: "student_list", module: "student", feature: "student_list", dsl: { modalCode: "student_detail_modal", modalName: "学员详情", size: "large", columns: 3, labelAlign: "left", readOnly: true, fields: [
    { key: "name", label: "姓名", type: "text" }, { key: "contact", label: "联系电话", type: "text" },
    { key: "organization_id", label: "校区", type: "text", optionSource: orgSelect }, { key: "student_status", label: "状态", type: "text" },
    { key: "source_type", label: "来源", type: "text" }, { key: "school_name", label: "学校", type: "text" },
    { key: "grade", label: "年级", type: "text" }, { key: "birthday", label: "生日", type: "date" },
    { key: "gender", label: "性别", type: "text" }, { key: "student_no", label: "学号", type: "text" },
    { key: "remark", label: "备注", type: "textarea", span: "full", rows: 3 }
  ] } },
  { actionCode: "assign_manager_modal", actionName: "分配学管师弹窗", pageCode: "student_list", module: "student", feature: "student_list", dsl: { modalCode: "assign_manager_modal", modalName: "分配学管师", size: "small", columns: 1, labelAlign: "left", submitApiCode: "student.assignManager", fields: [
    { key: "study_manager_id", label: "学管师", type: "text", optionSource: userSelect, required: true }
  ] } },
  { actionCode: "contract_add_modal", actionName: "新增合同弹窗", pageCode: "contract_list", module: "finance", feature: "contract_list", dsl: { modalCode: "contract_add_modal", modalName: "新增合同", size: "large", columns: 3, labelAlign: "left", submitApiCode: "contract_list.create", fields: contractCreateFields } },
  { actionCode: "contract_detail_modal", actionName: "合同详情弹窗", pageCode: "contract_list", module: "finance", feature: "contract_list", dsl: { modalCode: "contract_detail_modal", modalName: "合同详情", size: "large", columns: 3, labelAlign: "left", readOnly: true, fields: [
    { key: "contract_no", label: "合同编号", type: "text" }, { key: "student_name", label: "学员", type: "text" },
    { key: "organization_name", label: "校区", type: "text" }, { key: "paid_status", label: "付款状态", type: "text" },
    { key: "contract_type", label: "合同类型", type: "text", defaultValue: "NEW_SIGN" }, { key: "total_amount", label: "应收金额", type: "number" },
    { key: "paid_amount", label: "已收金额", type: "number" }, { key: "contract_status", label: "合同状态", type: "text" },
    { key: "remark", label: "备注", type: "textarea", span: "full", rows: 3 }
  ] } },
  { actionCode: "funds_add_modal", actionName: "新增收款弹窗", pageCode: "funds_history", module: "finance", feature: "funds_history", dsl: { modalCode: "funds_add_modal", modalName: "新增收款", size: "medium", columns: 3, labelAlign: "left", submitApiCode: "funds_history.create", fields: fundsCreateFields } },
  { actionCode: "funds_detail_modal", actionName: "收款详情弹窗", pageCode: "funds_history", module: "finance", feature: "funds_history", dsl: { modalCode: "funds_detail_modal", modalName: "收款详情", size: "medium", columns: 3, labelAlign: "left", readOnly: true, fields: fundsCreateFields.map((field) => ({ ...field, required: false })) } },
  { actionCode: "charge_detail_modal", actionName: "扣费详情弹窗", pageCode: "charge_record", module: "education", feature: "charge_record", dsl: { modalCode: "charge_detail_modal", modalName: "扣费详情", size: "medium", columns: 3, labelAlign: "left", readOnly: true, fields: chargeCreateFields.map((field) => ({ ...field, required: false })) } },
  { actionCode: "refund_add_modal", actionName: "新增退费弹窗", pageCode: "refund_record", module: "finance", feature: "refund_record", dsl: { modalCode: "refund_add_modal", modalName: "新增退费", size: "medium", columns: 3, labelAlign: "left", submitApiCode: "refund_record.create", fields: refundCreateFields } },
  { actionCode: "course_add_modal", actionName: "新增排课弹窗", pageCode: "course_list", module: "education", feature: "course_list", dsl: { modalCode: "course_add_modal", modalName: "新增排课", size: "medium", columns: 3, labelAlign: "left", submitApiCode: "course_list.create", fields: courseCreateFields } },
  { actionCode: "course_detail_modal", actionName: "课程详情弹窗", pageCode: "course_list", module: "education", feature: "course_list", dsl: { modalCode: "course_detail_modal", modalName: "课程详情", size: "large", columns: 3, labelAlign: "left", readOnly: true, fields: [
    { key: "course_title", label: "课程名称", type: "text", span: 2 }, { key: "course_type", label: "课程类型", type: "text" },
    { key: "course_dates", label: "上课日期", type: "multiDate", span: 2 as const, defaultFutureOnly: true },
  { key: "course_date", label: "单次日期", type: "date", hidden: true }, { key: "start_time", label: "开始时间", type: "time" },
    { key: "end_time", label: "结束时间", type: "time" }, { key: "teacher_id", label: "老师", type: "text", optionSource: userSelect },
    { key: "study_manager_id", label: "学管师", type: "text", optionSource: userSelect }, { key: "student_ids", label: "上课学员", type: "multiSelect", optionSource: studentSelect, searchable: true },
    { key: "organization_id", label: "校区", type: "text", optionSource: orgSelect }, { key: "course_hour", label: "课时", type: "number" },
    { key: "course_status", label: "状态", type: "text" }
  ] } },
  { actionCode: "charge_confirm_modal", actionName: "扣费确认弹窗", pageCode: "charge_record", module: "education", feature: "charge_record", dsl: { modalCode: "charge_confirm_modal", modalName: "扣费确认", size: "medium", columns: 3, labelAlign: "left", submitApiCode: "charge_record.create", fields: chargeCreateFields } },
  { actionCode: "charge_reverse_modal", actionName: "取消扣费弹窗", pageCode: "charge_record", module: "finance", feature: "charge_record", dsl: { modalCode: "charge_reverse_modal", modalName: "取消扣费", size: "small", columns: 1, labelAlign: "left", submitApiCode: "chargeRecord.reverse", fields: chargeReverseFields } },
  { actionCode: "product_add_modal", actionName: "新增产品弹窗", pageCode: "product_list", module: "finance", feature: "product_list", dsl: { modalCode: "product_add_modal", modalName: "新增产品", size: "medium", columns: 3, labelAlign: "left", submitApiCode: "product_list.create", fields: [
    { key: "name", label: "产品名称", type: "text", required: true }, { key: "product_type", label: "产品类型", type: "text" },
    { key: "subject_ids", label: "适用科目", type: "multiText" }, { key: "grade_ids", label: "适用年级", type: "multiText" },
    { key: "unit_price", label: "单价", type: "number" }, { key: "default_course_hour", label: "课时", type: "number" },
    { key: "total_amount", label: "总价", type: "number" }, { key: "status", label: "状态", type: "text" }
  ] } },
  { actionCode: "product_edit_modal", actionName: "编辑产品弹窗", pageCode: "product_list", module: "finance", feature: "product_list", dsl: { modalCode: "product_edit_modal", modalName: "编辑产品", size: "medium", columns: 3, labelAlign: "left", submitApiCode: "product_list.update", fields: [
    { key: "name", label: "产品名称", type: "text", required: true }, { key: "product_type", label: "产品类型", type: "text" },
    { key: "subject_ids", label: "适用科目", type: "multiText" }, { key: "grade_ids", label: "适用年级", type: "multiText" },
    { key: "unit_price", label: "单价", type: "number" }, { key: "default_course_hour", label: "课时", type: "number" },
    { key: "total_amount", label: "总价", type: "number" }, { key: "status", label: "状态", type: "text" }
  ] } },
  { actionCode: "promotion_add_modal", actionName: "新增优惠弹窗", pageCode: "promotion_list", module: "finance", feature: "promotion_list", dsl: { modalCode: "promotion_add_modal", modalName: "新增优惠", size: "small", columns: 2, labelAlign: "left", submitApiCode: "promotion_list.create", fields: [
    { key: "name", label: "优惠名称", type: "text", required: true }, { key: "type", label: "优惠类型", type: "text", dictCode: "promotion_type" },
    { key: "value", label: "优惠值", type: "number" }, { key: "status", label: "状态", type: "text" }
  ] } },
  { actionCode: "role_permission_modal", actionName: "角色权限弹窗", pageCode: "role_list", module: "system", feature: "role_list", dsl: { modalCode: "role_permission_modal", modalName: "角色权限", size: "large", columns: 1, labelAlign: "left", submitApiCode: "role.permission.save", fields: [
    { key: "name", label: "角色名称", type: "text", required: true }, { key: "role_code", label: "角色编码", type: "text" },
    { key: "organization_id", label: "所属校区", type: "text", optionSource: orgSelect },
    { key: "permissions", label: "权限配置", type: "permission_editor", span: "full" }
  ] } },
  { actionCode: "user_add_modal", actionName: "新增员工弹窗", pageCode: "user_list", module: "system", feature: "user_list", dsl: { modalCode: "user_add_modal", modalName: "新增员工", size: "medium", columns: 3, labelAlign: "left", submitApiCode: "user.create", fields: [
    { key: "name", label: "员工姓名", type: "text", required: true }, { key: "contact", label: "电话", type: "text", required: true },
    { key: "organization_id", label: "归属架构", type: "organizationTreeSelect", optionSource: orgSelect },
    { key: "management_organization_ids", label: "管理架构", type: "organizationTreeMultiSelect", optionSource: orgSelect, span: 2 },
    { key: "staff_type", label: "类型", type: "text" },
    { key: "psw", label: "初始密码", type: "password" }
  ] } },
  { actionCode: "money_arrange_detail_modal", actionName: "资金分配详情弹窗", pageCode: "money_arrange_list", module: "finance", feature: "money_arrange_list", dsl: { modalCode: "money_arrange_detail_modal", modalName: "资金分配详情", size: "medium", columns: 2, labelAlign: "left", readOnly: true, fields: [
    { key: "contract_product_id", label: "合同产品", type: "text" }, { key: "arrange_real_hour", label: "分配课时", type: "number" },
    { key: "arrange_real_amount", label: "分配金额", type: "number" }, { key: "funds_change_history_id", label: "收款记录", type: "text" },
    { key: "organization_id", label: "校区", type: "text", optionSource: orgSelect }
  ] } },
  { actionCode: "promotion_arrange_detail_modal", actionName: "优惠分配详情弹窗", pageCode: "promotion_arrange_list", module: "finance", feature: "promotion_arrange_list", dsl: { modalCode: "promotion_arrange_detail_modal", modalName: "优惠分配详情", size: "medium", columns: 2, labelAlign: "left", readOnly: true, fields: [
    { key: "contract_product_id", label: "合同产品", type: "text" }, { key: "arrange_promotion_hour", label: "分配赠课", type: "number" },
    { key: "arrange_promotion_amount", label: "分配优惠金额", type: "number" }, { key: "funds_change_history_id", label: "收款记录", type: "text" },
    { key: "organization_id", label: "校区", type: "text", optionSource: orgSelect }
  ] } },
  { actionCode: "performance_arrange_detail_modal", actionName: "业绩分配详情弹窗", pageCode: "performance_arrange_list", module: "finance", feature: "performance_arrange_list", dsl: { modalCode: "performance_arrange_detail_modal", modalName: "业绩分配详情", size: "medium", columns: 2, labelAlign: "left", readOnly: true, fields: [
    { key: "contract_product_id", label: "合同产品", type: "text" }, { key: "performance_type", label: "业绩类型", type: "text" },
    { key: "organization_performance_organization_id", label: "校区业绩组织", type: "text", optionSource: orgSelect }, { key: "organization_performance_amount", label: "校区业绩金额", type: "number" },
    { key: "personal_performance_user_id", label: "个人业绩员工", type: "text", optionSource: userSelect }, { key: "personal_performance_amount", label: "个人业绩金额", type: "number" },
    { key: "organization_id", label: "校区", type: "text", optionSource: orgSelect }, { key: "source_type", label: "来源类型", type: "text" },
    { key: "source_id", label: "来源单据ID", type: "text" }, { key: "adjustment_reason", label: "调整原因", type: "textarea", span: "full" }
  ] } },
  { actionCode: "performance_arrange_adjust_modal", actionName: "业绩调整弹窗", pageCode: "performance_arrange_list", module: "finance", feature: "performance_arrange_list", dsl: { modalCode: "performance_arrange_adjust_modal", modalName: "业绩调整", size: "medium", columns: 3, labelAlign: "left", submitApiCode: "performanceArrange.save", fields: performanceAdjustFields } },
  { actionCode: "contract_refund_modal", actionName: "合同退费弹窗", pageCode: "contract_list", module: "finance", feature: "contract_list", dsl: { modalCode: "contract_refund_modal", modalName: "合同退费", size: "medium", columns: 3, labelAlign: "left", submitApiCode: "contract.refund", fields: contractRefundFields } },
  { actionCode: "attendance_check_in_modal", actionName: "考勤签到弹窗", pageCode: "course_list", module: "education", feature: "course_list", dsl: { modalCode: "attendance_check_in_modal", modalName: "学员考勤", size: "large", columns: 1, labelAlign: "left", submitApiCode: "attendance.checkIn", fields: attendanceCheckInFields } },
  { actionCode: "mini_class_add_modal", actionName: "新增班级弹窗", pageCode: "mini_class_list", module: "education", feature: "mini_class_list", dsl: { modalCode: "mini_class_add_modal", modalName: "新增班级", size: "medium", columns: 3, labelAlign: "left", submitApiCode: "mini_class_list.create", fields: [
    { key: "name", label: "班级名称", type: "text", required: true }, { key: "organization_id", label: "校区", type: "text", optionSource: orgSelect },
    { key: "teacher_id", label: "授课老师", type: "text", optionSource: userSelect }, { key: "study_manager_id", label: "学管师", type: "text", optionSource: userSelect },
    { key: "product_id", label: "排课产品", type: "text", optionSource: productSelect }, { key: "grade", label: "年级", type: "text" }, { key: "subject", label: "科目", type: "text" },
    { key: "capacity", label: "容量", type: "number" }
  ] } },
  { actionCode: "mini_class_detail_modal", actionName: "班级详情弹窗", pageCode: "mini_class_list", module: "education", feature: "mini_class_list", dsl: { modalCode: "mini_class_detail_modal", modalName: "班级详情", size: "large", columns: 3, labelAlign: "left", readOnly: true, fields: [
    { key: "name", label: "班级名称", type: "text" }, { key: "organization_id", label: "校区", type: "text", optionSource: orgSelect },
    { key: "teacher_id", label: "授课老师", type: "text", optionSource: userSelect }, { key: "study_manager_id", label: "学管师", type: "text", optionSource: userSelect },
    { key: "product_id", label: "排课产品", type: "text", optionSource: productSelect }, { key: "grade", label: "年级", type: "text" }, { key: "subject", label: "科目", type: "text" },
    { key: "capacity", label: "容量", type: "number" }, { key: "status", label: "状态", type: "text" }
  ] } },
  { actionCode: "mini_class_add_student_modal", actionName: "添加班级学员弹窗", pageCode: "mini_class_list", module: "education", feature: "mini_class_list", dsl: { modalCode: "mini_class_add_student_modal", modalName: "添加班级学员", size: "medium", columns: 1, labelAlign: "left", submitApiCode: "miniClass.addStudent", fields: addStudentFields } },
  { actionCode: "one_on_n_group_add_modal", actionName: "新增1对N小组弹窗", pageCode: "one_on_n_group_list", module: "education", feature: "one_on_n_group_list", dsl: { modalCode: "one_on_n_group_add_modal", modalName: "新增1对N小组", size: "medium", columns: 3, labelAlign: "left", submitApiCode: "one_on_n_group_list.create", fields: [
    { key: "name", label: "小组名称", type: "text", required: true }, { key: "organization_id", label: "校区", type: "text", optionSource: orgSelect },
    { key: "teacher_id", label: "授课老师", type: "text", optionSource: userSelect }, { key: "study_manager_id", label: "学管师", type: "text", optionSource: userSelect },
    { key: "product_id", label: "排课产品", type: "text", optionSource: productSelect }, { key: "grade", label: "年级", type: "text" }, { key: "subject", label: "科目", type: "text" },
    { key: "capacity", label: "容量", type: "number" }
  ] } },
  { actionCode: "one_on_n_group_detail_modal", actionName: "1对N小组详情弹窗", pageCode: "one_on_n_group_list", module: "education", feature: "one_on_n_group_list", dsl: { modalCode: "one_on_n_group_detail_modal", modalName: "1对N小组详情", size: "large", columns: 3, labelAlign: "left", readOnly: true, fields: [
    { key: "name", label: "小组名称", type: "text" }, { key: "organization_id", label: "校区", type: "text", optionSource: orgSelect },
    { key: "teacher_id", label: "授课老师", type: "text", optionSource: userSelect }, { key: "study_manager_id", label: "学管师", type: "text", optionSource: userSelect },
    { key: "product_id", label: "排课产品", type: "text", optionSource: productSelect }, { key: "grade", label: "年级", type: "text" }, { key: "subject", label: "科目", type: "text" },
    { key: "capacity", label: "容量", type: "number" }, { key: "status", label: "状态", type: "text" }
  ] } },
  { actionCode: "one_on_n_group_add_student_modal", actionName: "添加1对N学员弹窗", pageCode: "one_on_n_group_list", module: "education", feature: "one_on_n_group_list", dsl: { modalCode: "one_on_n_group_add_student_modal", modalName: "添加1对N学员", size: "medium", columns: 1, labelAlign: "left", submitApiCode: "oneOnNGroup.addStudent", fields: addStudentFields } },
  { actionCode: "mini_class_student_detail_modal", actionName: "班级学员详情弹窗", pageCode: "mini_class_student_list", module: "education", feature: "mini_class_student_list", dsl: { modalCode: "mini_class_student_detail_modal", modalName: "班级学员详情", size: "medium", columns: 2, labelAlign: "left", readOnly: true, fields: [
    { key: "student_id", label: "学员", type: "text" }, { key: "join_date", label: "入班日期", type: "date" }, { key: "status", label: "状态", type: "text" }
  ] } },
  { actionCode: "one_on_n_group_student_detail_modal", actionName: "1对N学员详情弹窗", pageCode: "one_on_n_group_student_list", module: "education", feature: "one_on_n_group_student_list", dsl: { modalCode: "one_on_n_group_student_detail_modal", modalName: "1对N学员详情", size: "medium", columns: 2, labelAlign: "left", readOnly: true, fields: [
    { key: "student_id", label: "学员", type: "text" }, { key: "join_date", label: "入组日期", type: "date" }, { key: "status", label: "状态", type: "text" }
  ] } },
  { actionCode: "leave_add_modal", actionName: "新增请假弹窗", pageCode: "leave_record", module: "education", feature: "leave_record", dsl: { modalCode: "leave_add_modal", modalName: "新增请假", size: "medium", columns: 3, labelAlign: "left", submitApiCode: "leave_record.create", fields: leaveCreateFields } },
  { actionCode: "makeup_add_modal", actionName: "新增补课弹窗", pageCode: "makeup_course_record", module: "education", feature: "makeup_course_record", dsl: { modalCode: "makeup_add_modal", modalName: "新增补课", size: "medium", columns: 3, labelAlign: "left", submitApiCode: "makeup_course_record.create", fields: makeupCreateFields } },
  { actionCode: "holiday_add_modal", actionName: "新增停课弹窗", pageCode: "course_holiday_calendar", module: "education", feature: "course_holiday_calendar", dsl: { modalCode: "holiday_add_modal", modalName: "新增停课", size: "medium", columns: 3, labelAlign: "left", submitApiCode: "course_holiday_calendar.create", fields: holidayCreateFields } }
];

export const optionApiDslSeeds: Array<{ apiCode: string; apiName: string; module: string; feature: string; dsl: Record<string, unknown> }> = [
  { apiCode: "miniClass.addStudent", apiName: "班级添加学员", module: "education", feature: "mini_class_list", dsl: { operation: "command", command: "miniClass.addStudent", ruleCode: "course_create_rule" } },
  { apiCode: "miniClass.removeStudent", apiName: "班级移除学员", module: "education", feature: "mini_class_list", dsl: { operation: "command", command: "miniClass.removeStudent", ruleCode: "course_create_rule" } },
  { apiCode: "oneOnNGroup.addStudent", apiName: "1对N添加学员", module: "education", feature: "one_on_n_group_list", dsl: { operation: "command", command: "oneOnNGroup.addStudent", ruleCode: "course_create_rule" } },
  { apiCode: "oneOnNGroup.removeStudent", apiName: "1对N移除学员", module: "education", feature: "one_on_n_group_list", dsl: { operation: "command", command: "oneOnNGroup.removeStudent", ruleCode: "course_create_rule" } },
  { apiCode: "attendance.checkIn", apiName: "学员考勤", module: "education", feature: "course_list", dsl: { operation: "command", command: "attendance.checkIn", ruleCode: "attendance_check_in_rule" } },
  { apiCode: "attendance.cancel", apiName: "取消考勤", module: "education", feature: "course_list", dsl: { operation: "command", command: "attendance.cancel", ruleCode: "attendance_check_in_rule" } },
  { apiCode: "leaveRecord.create", apiName: "新增请假", module: "education", feature: "leave_record", dsl: { operation: "command", command: "leave.create", ruleCode: "leave_create_rule" } },
  { apiCode: "makeupRecord.create", apiName: "新增补课", module: "education", feature: "makeup_course_record", dsl: { operation: "command", command: "makeup.create", ruleCode: "makeup_create_rule" } },
  { apiCode: "contract.refund", apiName: "合同退费", module: "finance", feature: "contract_list", dsl: { operation: "command", command: "contract.refund", ruleCode: "contract_refund_rule" } },
  { apiCode: "chargeRecord.reverse", apiName: "取消扣费", module: "finance", feature: "charge_record", dsl: { operation: "command", command: "chargeRecord.reverse", ruleCode: "charge_create_rule" } },
  { apiCode: "performanceArrange.save", apiName: "业绩调整", module: "finance", feature: "performance_arrange_list", dsl: { operation: "command", command: "performanceArrange.save", ruleCode: "performance_adjust_rule" } },
  { apiCode: "classStudent.transfer", apiName: "批量调班", module: "education", feature: "mini_class_list", dsl: { operation: "command", command: "classStudent.transfer", ruleCode: "course_create_rule" } },
  { apiCode: "class.changeStatus", apiName: "班级状态调整", module: "education", feature: "mini_class_list", dsl: { operation: "command", command: "class.changeStatus", ruleCode: "course_create_rule" } },
  { apiCode: "option.organization", apiName: "校区选项", module: "system", feature: "organization_list", dsl: { table: "organization", operation: "query", select: [{ field: "id", as: "value" }, { field: "name", as: "label" }], where: [{ field: "status", op: "eq", value: "ACTIVE" }], pagination: false, security: { dataPermission: "own_organization" } } },
  { apiCode: "option.staff", apiName: "员工选项", module: "system", feature: "user_list", dsl: { table: "user", operation: "query", select: [{ field: "id", as: "value" }, { field: "name", as: "label" }], where: [{ field: "status", op: "eq", value: "ACTIVE" }], pagination: false, security: { dataPermission: "own_organization" } } },
  { apiCode: "option.teacher", apiName: "老师选项", module: "system", feature: "user_list", dsl: { table: "user", operation: "query", select: [{ field: "id", as: "value" }, { field: "name", as: "label" }], where: [{ field: "staff_type", op: "eq", value: "TEACHER" }, { field: "status", op: "eq", value: "ACTIVE" }], pagination: false, security: { dataPermission: "own_organization" } } },
  { apiCode: "option.studyManager", apiName: "学管师选项", module: "system", feature: "user_list", dsl: { table: "user", operation: "query", select: [{ field: "id", as: "value" }, { field: "name", as: "label" }], where: [{ field: "staff_type", op: "eq", value: "STUDY_MANAGER" }, { field: "status", op: "eq", value: "ACTIVE" }], pagination: false, security: { dataPermission: "own_organization" } } },
  { apiCode: "option.product", apiName: "产品选项", module: "finance", feature: "product_list", dsl: { table: "product", operation: "query", select: [{ field: "id", as: "value" }, { field: "name", as: "label" }], where: [{ field: "status", op: "eq", value: "ACTIVE" }], pagination: false } },
  { apiCode: "option.promotion", apiName: "优惠选项", module: "finance", feature: "promotion_list", dsl: { table: "promotion", operation: "query", select: [{ field: "id", as: "value" }, { field: "name", as: "label" }], where: [{ field: "status", op: "eq", value: "ACTIVE" }], pagination: false } },
  { apiCode: "option.payWay", apiName: "支付方式选项", module: "finance", feature: "pay_way_list", dsl: { table: "pay_way_config", operation: "query", select: [{ field: "id", as: "value" }, { field: "name", as: "label" }], where: [{ field: "status", op: "eq", value: "ACTIVE" }], pagination: false } },
  { apiCode: "option.eleAccount", apiName: "电子账户选项", module: "finance", feature: "student_ele_account", dsl: { table: "ele_account", operation: "query", select: [{ field: "id", as: "value" }, { field: "name", as: "label" }], where: [{ field: "status", op: "eq", value: "ACTIVE" }], pagination: false } },
  { apiCode: "option.miniClass", apiName: "班级选项", module: "education", feature: "mini_class_list", dsl: { table: "mini_class", operation: "query", select: [{ field: "id", as: "value" }, { field: "name", as: "label" }], where: [{ field: "status", op: "eq", value: "ACTIVE" }], pagination: false } },
  { apiCode: "option.oneOnNGroup", apiName: "1对N小组选项", module: "education", feature: "one_on_n_group_list", dsl: { table: "one_on_n_group", operation: "query", select: [{ field: "id", as: "value" }, { field: "name", as: "label" }], where: [{ field: "status", op: "eq", value: "ACTIVE" }], pagination: false } }
];

export const adminModules = [
  ["tenant_mgmt", "租户管理", "platform", "租户运营与充值", 91, "Building2"],
  ["dsl_mgmt", "DSL 管理", "platform", "版本与AI变更", 92, "FileCode2"],
  ["wechat_platform", "微信平台", "platform", "第三方平台应用与公有服务号配置", 93, "MessageCircle"]
] as const;

export const adminPages: PageSeed[] = [

  {
    module: "wechat_platform",
    feature: "wechat_third_platform_app",
    page: "wechat_third_platform_app",
    name: "第三方平台应用",
    table: "wechat_third_platform_app",
    fields: [
      { key: "app_name", label: "应用名称", filter: true },
      { key: "component_appid", label: "Component AppID" },
      { key: "component_appsecret", label: "Component AppSecret" },
      { key: "token", label: "消息校验 Token" },
      { key: "encoding_aes_key", label: "EncodingAESKey" },
      { key: "auth_redirect_domain", label: "授权发起域名" },
      { key: "callback_domain", label: "统一回调域名" },
      { key: "ext_json", label: "扩展配置(JSON)", type: "json" },
      { key: "status", label: "状态", filter: true }
    ]
  },
  {
    module: "wechat_platform",
    feature: "public_wechat_account",
    page: "public_wechat_account",
    name: "公有服务号",
    table: "public_wechat_account",
    fields: [
      { key: "account_name", label: "服务号名称", filter: true },
      { key: "appid", label: "AppID" },
      { key: "component_appid", label: "第三方平台" },
      { key: "oauth_domain", label: "网页授权域名" },
      { key: "ext_json", label: "扩展配置/支付配置(JSON)", type: "json" },
      { key: "is_default", label: "默认绑定", type: "boolean" },
      { key: "status", label: "状态", filter: true }
    ]
  },
  {
    module: "tenant_mgmt",
    feature: "tenant_manage",
    page: "tenant_manage",
    name: "租户管理",
    table: "tenant_manage",
    fields: [
      { key: "name", label: "机构名称", filter: true },
      { key: "schema_name", label: "机构编码" },
      { key: "status", label: "状态" },
      { key: "owner_name", label: "负责人" },
      { key: "expire_time", label: "到期时间", type: "datetime" }
    ]
  },
  {
    module: "dsl_mgmt",
    feature: "dsl_version",
    page: "dsl_version",
    name: "DSL 版本",
    table: "dsl_version",
    fields: [
      { key: "target_type", label: "对象类型" },
      { key: "target_code", label: "对象编码" },
      { key: "version_no", label: "版本" },
      { key: "status", label: "状态" },
      { key: "change_summary", label: "摘要" }
    ]
  },
  {
    module: "tenant_mgmt",
    feature: "tenant_recharge_record",
    page: "tenant_recharge_record",
    name: "充值记录",
    table: "tenant_recharge_record",
    softDelete: false,
    fields: [
      { key: "schema_name", label: "租户", filter: true },
      { key: "amount", label: "充值金额" },
      { key: "expire_time", label: "本轮到期时间", type: "datetime" },
      { key: "operator_id", label: "操作人" },
      { key: "remark", label: "备注" },
      { key: "created_at", label: "充值时间", type: "datetime" }
    ]
  },
  {
    module: "tenant_mgmt",
    feature: "customization_record_list",
    page: "customization_record_list",
    name: "定制化记录",
    table: "agent_customization_record",
    apiSchema: "admin",
    softDelete: false,
    fixedFilters: [
      { field: "schema_name", op: "eq", valueFromParam: "schemaName" },
      { field: "record_type", op: "eq", value: "customization" }
    ],
    fields: [
      { key: "schema_name", label: "租户", filter: true },
      { key: "record_type", label: "类型", filter: true },
      { key: "session_id", label: "会话ID" },
      { key: "user_prompt", label: "用户提问/用户需求" },
      { key: "created_at", label: "创建时间", type: "datetime" }
    ]
  }
];

export function pageDsl(page: (typeof pages)[number] | (typeof adminPages)[number]) {
  const joinAliases = new Set(
    (page.joins ?? []).flatMap((join) =>
      ((join as { fields?: Array<{ as: string }> }).fields ?? []).map((field) => field.as)
    )
  );
  const timeField = businessTimeField(page);
  const timeFieldSeed = page.fields.find((field) => field.key === timeField);
  const fieldFilters = page.fields.filter((field) => shouldDefaultFilter(field) && field.key !== timeField).map((field) => {
    const dictCode = dictCodeForField(field);
    const fkOptionSource = optionSourceForField(field);
    const label = filterLabelFor(page, field);
    return {
      key: field.key,
      label,
      type: page.page === "course_week_schedule" && field.key === "course_date" ? "date_range" : dictCode || fkOptionSource ? "select" : field.type ?? "text",
      placeholder: fkOptionSource ? `请选择${label}` : `请输入${label}`,
      ...(dictCode ? { dictCode, optionSource: dictionaryOption(dictCode) } : {}),
      ...(fkOptionSource ? { optionSource: fkOptionSource, searchable: true } : {})
    };
  });
  const filters = [
    {
      key: timeField,
      field: timeField,
      label: timeFieldSeed?.label ?? "查询时间",
      type: "date_range",
      placeholder: "请选择日期范围",
      required: true,
      defaultRange: "current_month" as const,
      maxRangeDays: 366,
      sortOrder: -1000
    },
    ...fieldFilters
  ];
  const baseDsl: Record<string, any> = {
    pageCode: page.page,
    title: page.name,
    subtitle: pageSubtitles[page.page] ?? `${page.name}业务数据维护`,
    designToken: "flatTech",
    presentation: {
      theme: "flatTech",
      density: "compact",
      fontSize: "compact",
      header: {
        hidden: true,
        subtitle: pageSubtitles[page.page] ?? `${page.name}业务数据维护`,
        metrics: metricsFor(page)
      },
      filters: {
        showLabels: false,
        density: "compact"
      },
      toolbar: {
        align: "right"
      },
      table: {
        pageSize: 20,
        rowDensity: "compact",
        rowActionMode: "inline",
        rowActionStyle: "linkGroup",
        primaryRowActions: [`${page.page}.detail`, `${page.page}.edit`, `${page.page}.delete`],
        stickyHeader: true
      },
      modal: {
        style: "bossForm",
        columns: 3,
        labelAlign: "left"
      },
      statusMap,
      valueLabels
    },
    layout: "list",
    dataApi: `${page.page}.query`,
    detailApi: `${page.page}.detail`,
    createApi: `${page.page}.create`,
    updateApi: `${page.page}.update`,
    deleteApi: `${page.page}.delete`,
    filters,
    toolbar: page.page === "customization_record_list"
      ? [
          { actionCode: "customization_record_list.new_customization", label: "新增定制化", type: "open_ai_customization", actionType: "open_ai_customization", variant: "primary" },
          { actionCode: `${page.page}.refresh`, label: "刷新", type: "execute_api", variant: "default" }
        ]
      : [
          { actionCode: `${page.page}.create`, label: "新增", type: "open_modal", variant: "primary" },
          { actionCode: `${page.page}.refresh`, label: "刷新", type: "execute_api", variant: "default" }
        ],
    table: {
      rowKey: "id",
      columns: page.fields.map((field) => ({
        key: field.key,
        title: field.label,
        type: field.type ?? "text",
        hidden: field.hidden,
        sortable: Boolean(field.sortable),
        width: columnWidth(field),
        align: columnAlign(field),
        badge: field.badge ?? statusFields.has(field.key),
        ...(dictCodeForField(field) ? { dictCode: dictCodeForField(field) } : {}),
        ...(inferForeignKeyMeta(field.key) ? { displayKey: inferForeignKeyMeta(field.key)?.displayKey } : {})
      })).filter((field) => !field.hidden),
      rowActions: [
        { actionCode: `${page.page}.detail`, label: "详情", type: "open_modal" },
        { actionCode: `${page.page}.edit`, label: "编辑", type: "open_modal" },
        { actionCode: `${page.page}.delete`, label: "删除", type: "execute_api", confirm: "确认删除这条记录？" }
      ]
    },
    modal: {
      fields: page.fields
        .filter((field) => !joinAliases.has(field.key) && !field.hidden && field.key !== "id")
        .sort((a, b) => Number(isLongTextField(a)) - Number(isLongTextField(b)))
        .map((field) => ({ key: field.key, label: field.label, ...fieldComponent(field) }))
    }
  };

  if (derivedArrangePages.has(page.page)) {
    baseDsl.toolbar = [
      { actionCode: `${page.page}.refresh`, label: "刷新", type: "execute_api", variant: "default" }
    ];
    baseDsl.table.rowActions = [
      { actionCode: `${page.page}.detail`, label: "详情", type: "open_modal" }
    ];
    baseDsl.presentation.table.primaryRowActions = [`${page.page}.detail`];
  }

  if (readOnlyPages.has(page.page)) {
    baseDsl.toolbar = [
      { actionCode: `${page.page}.refresh`, label: "刷新", type: "execute_api", variant: "default" }
    ];
    baseDsl.table.rowActions = [
      { actionCode: `${page.page}.detail`, label: "详情", type: "open_modal" }
    ];
    baseDsl.presentation.table.primaryRowActions = [`${page.page}.detail`];
  }

  if (page.page === "tenant_version_list") {
    baseDsl.toolbar = [
      { actionCode: "tenant_version_list.refresh", label: "刷新", type: "execute_api", variant: "default" }
    ];
    baseDsl.table.rowActions = [
      { actionCode: "tenant_version_list.rollback", label: "回滚到此版本", type: "execute_api", confirm: "确认回滚到此版本？将创建新版本并恢复DSL。", visibleWhen: { status: ["active", "archived"] } },
      { actionCode: "tenant_version_list.rollback_preview", label: "回滚预览", type: "execute_api", visibleWhen: { status: "archived" } },
      { actionCode: "tenant_version_list.publish", label: "发布", type: "execute_api", confirm: "确认发布此版本？", visibleWhen: { status: "draft" } }
    ];
    baseDsl.presentation.table.primaryRowActions = ["tenant_version_list.rollback", "tenant_version_list.publish"];
  }

  if (page.page === "customization_record_list") {
    baseDsl.subtitle = "查看 AI 定制需求、对话和 DSL 变更记录";
    baseDsl.presentation.header.subtitle = "查看 AI 定制需求、对话和 DSL 变更记录";

    baseDsl.toolbar = [
      { actionCode: "customization_record_list.new_customization", label: "新增定制化", type: "open_ai_customization", actionType: "open_ai_customization", variant: "primary" },
      { actionCode: "customization_record_list.refresh", label: "刷新", type: "execute_api", variant: "default" }
    ];
    baseDsl.table.rowActions = [
      { actionCode: "customization_record_list.detail", label: "详情", type: "open_modal" }
    ];
    baseDsl.presentation.table.primaryRowActions = ["customization_record_list.detail"];
  }

  if (page.page === "assistant_record_list") {
    baseDsl.subtitle = "查看 AI 助手提问、回复和工具调用记录";
    baseDsl.presentation.header.subtitle = "查看 AI 助手提问、回复和工具调用记录";
    baseDsl.toolbar = [
      { actionCode: "assistant_record_list.refresh", label: "刷新", type: "execute_api", variant: "default" }
    ];
    baseDsl.table.rowActions = [
      { actionCode: "assistant_record_list.detail", label: "详情", type: "open_modal" }
    ];
    baseDsl.presentation.table.primaryRowActions = ["assistant_record_list.detail"];
  }

  if (page.page === "role_list") {
    baseDsl.createApi = "role.permission.save";
    baseDsl.updateApi = "role.permission.save";
    baseDsl.modal.fields = [
      { key: "name", label: "角色名称", type: "text", required: true },
      { key: "organization_id", label: "所属校区", type: "text", optionSource: orgSelect },
      { key: "permissions", label: "权限配置", type: "permission_editor", span: "full" }
    ];
    baseDsl.presentation.modal.size = "fullscreen";
    baseDsl.presentation.table.primaryRowActions = ["role_list.edit", "role_list.delete"];
  }

  if (page.page === "organization_list") {
    baseDsl.subtitle = "维护分公司、校区和自定义管理架构";
    baseDsl.presentation.header.subtitle = "维护分公司、校区和自定义管理架构";
    baseDsl.table.columns = [
      { key: "name", title: "架构名称", width: 180 },
      { key: "parent_id", title: "上级架构", width: 160, displayKey: "parent_name" },
      { key: "organization_type", title: "架构类型", width: 120, badge: true },
      { key: "status", title: "状态", width: 100, badge: true }
    ];
    baseDsl.modal.fields = [
      { key: "name", label: "架构名称", type: "text", required: true },
      { key: "parent_id", label: "上级架构", type: "organizationTreeSelect", optionSource: orgSelect, searchable: true },
      { key: "organization_type", label: "架构类型", type: "text" },
      { key: "status", label: "状态", type: "text" }
    ];
  }

  if (page.page === "user_list") {
    baseDsl.table.columns = [
      { key: "name", title: "员工姓名", width: 140 },
      { key: "contact", title: "电话", width: 150 },
      { key: "organization_id", title: "归属架构", width: 160, displayKey: "organization_name" },
      { key: "management_organization_ids", title: "管理架构", width: 220, displayKey: "management_organization_names" },
      { key: "staff_type", title: "类型", width: 120, badge: true },
      { key: "status", title: "状态", width: 100, badge: true }
    ];
    baseDsl.modal.fields = [
      { key: "name", label: "员工姓名", type: "text", required: true },
      { key: "contact", label: "电话", type: "text", required: true },
      { key: "email", label: "邮箱", type: "text" },
      { key: "organization_id", label: "归属架构", type: "organizationTreeSelect", optionSource: orgSelect, searchable: true },
      { key: "management_organization_ids", label: "管理架构", type: "organizationTreeMultiSelect", optionSource: orgSelect, searchable: true, span: 2 },
      { key: "staff_type", label: "类型", type: "text" },
      { key: "status", label: "状态", type: "text" }
    ];
  }

  if (page.page === "approval_flow_list") {
    baseDsl.subtitle = "按组织架构维护业务审批和流转角色";
    baseDsl.presentation.header.subtitle = "按组织架构维护业务审批和流转角色";
    baseDsl.table.columns = [
      { key: "name", title: "审批名称", width: 200 },
      { key: "module_label", title: "模块", width: 120 },
      { key: "business_type_label", title: "业务类型", width: 130 },
      { key: "steps_summary", title: "流转角色", width: 260 },
      { key: "status", title: "状态", width: 100, badge: true }
    ];
    baseDsl.modal.fields = [
      { key: "name", label: "审批名称", type: "text", required: true },
      { key: "status", label: "状态", type: "text", dictCode: "approval_flow_status", defaultValue: "INACTIVE" },
      { key: "organization_id", label: "组织架构", type: "text", optionSource: orgSelect },
      { key: "config_json", label: "审批配置", type: "approval_flow_editor", span: "full" }
    ];
    baseDsl.presentation.modal.size = "fullscreen";
    baseDsl.presentation.table.primaryRowActions = ["approval_flow_list.edit", "approval_flow_list.delete"];
  }

  if (page.page === "student_ele_account") {
    baseDsl.table.rowActions = [
      { actionCode: "student_ele_account.records", label: "流水", type: "open_page", target: { pageCode: "student_ele_account_record", title: "电子账户流水", filterField: "student_id", rowField: "student_id" } },
      { actionCode: "student_ele_account.withdraw", label: "退预存", type: "open_modal", apiCode: "eleAccount.withdraw", modalTitle: "退预存余额", variant: "danger", visibleWhen: { balance_amount: { op: "notIn", value: ["0", "0.00", 0] } }, fields: [
        { key: "student_id", label: "学员ID", type: "text", hidden: true },
        { key: "amount", label: "退款金额", type: "number", required: true, min: 0.01 },
        { key: "remark", label: "退款原因", type: "textarea", span: "full" as const, rows: 3, required: true }
      ], mapRowToValue: { student_id: "student_id" } }
    ];
    baseDsl.presentation.table.primaryRowActions = ["student_ele_account.records", "student_ele_account.withdraw"];
  }

  if (page.page === "approval_task_list") {
    baseDsl.subtitle = "集中处理我的待办、我发起的审批和历史审批";
    baseDsl.presentation.header.subtitle = "集中处理我的待办、我发起的审批和历史审批";
    baseDsl.table.columns = [
      { key: "flow_name", title: "审批流", width: 180 },
      { key: "business_type", title: "业务类型", width: 140 },
      { key: "business_id", title: "业务单据", width: 140 },
      { key: "applicant_name", title: "申请人", width: 120 },
      { key: "current_approver_name", title: "当前审批人", width: 120 },
      { key: "status", title: "状态", width: 100, badge: true },
      { key: "created_at", title: "发起时间", width: 170 },
      { key: "updated_at", title: "更新时间", width: 170 }
    ];
    baseDsl.toolbar = [
      { actionCode: "approval_task_list.refresh", label: "刷新", type: "execute_api", variant: "default" }
    ];
    baseDsl.table.rowActions = [
      { actionCode: "approval_task_list.detail", label: "详情", type: "open_modal" },
      { actionCode: "approval_task_list.approve", label: "同意", type: "execute_api", apiCode: "approvalTask.approve", confirm: "确认同意该审批？", visibleWhen: { status: "PENDING" } },
      { actionCode: "approval_task_list.reject", label: "驳回", type: "execute_api", apiCode: "approvalTask.reject", confirm: "确认驳回该审批？", variant: "danger", visibleWhen: { status: "PENDING" } },
      { actionCode: "approval_task_list.cancel", label: "撤回", type: "execute_api", apiCode: "approvalTask.cancel", confirm: "确认撤回该审批？", variant: "danger", visibleWhen: { status: "PENDING" } }
    ];
    baseDsl.presentation.table.primaryRowActions = ["approval_task_list.detail", "approval_task_list.approve", "approval_task_list.reject", "approval_task_list.cancel"];
  }

  if (page.page === "business_rule_list") {
    baseDsl.subtitle = "维护资金、优惠、业绩等业务规则，默认规则可覆盖为租户自定义";
    baseDsl.presentation.header.subtitle = "维护资金、优惠、业绩等业务规则，默认规则可覆盖为租户自定义";
    baseDsl.table.columns = [
      { key: "rule_name", title: "规则名称", width: 220 },
      { key: "category_label", title: "规则分类", width: 130 },
      { key: "business_type_label", title: "业务类型", width: 130 },
      { key: "source_label", title: "来源", width: 120 },
      { key: "status", title: "状态", width: 100, badge: true },
      { key: "updated_at", title: "更新时间", type: "datetime", width: 170 }
    ];
    baseDsl.modal.fields = [
      { key: "rule_name", label: "规则名称", type: "text", required: true },
      { key: "rule_json", label: "规则设置", type: "business_rule_editor", span: "full", editorSchema: businessRuleEditorSchema }
    ];
    baseDsl.presentation.modal.size = "large";
    baseDsl.presentation.table.primaryRowActions = ["business_rule_list.detail", "business_rule_list.edit", "business_rule_list.delete"];
  }

  if (page.page === "student_list") {
    baseDsl.table.selectable = true;
    baseDsl.toolbar = [
      { actionCode: "student_list.create", label: "新增", type: "open_modal", variant: "primary" },
      { actionCode: "student_list.batchEnroll", label: "批量报名", type: "open_modal", apiCode: "contract_list.create", modalTitle: "批量报名", fields: contractCreateFields, requiresSelection: true, requiresSelectionMessage: "请先选择学员", mapSelectedToValue: { student_ids: "id" }, defaultValues: { contract_type: "NEW_SIGN", sign_time: "$now" } },
      { actionCode: "student_list.refresh", label: "刷新", type: "execute_api", variant: "default" }
    ];
    baseDsl.table.rowActions = [
      { actionCode: "student_list.detail", label: "详情", type: "open_modal" },
      { actionCode: "student_list.edit", label: "编辑", type: "open_modal" },
      { actionCode: "student_list.contracts", label: "合同", type: "open_page", target: { pageCode: "contract_list", title: "合同收费", filterField: "student_id", rowField: "id" } },
      {
        actionCode: "student_list.prestore",
        label: "预存",
        type: "open_modal",
        apiCode: "funds_history.create",
        modalTitle: "为学员预存",
        fields: contextPreStoreFields,
        defaultValues: { funds_type: "PRE_STORE", transaction_time: "$now" },
        mapRowToValue: { student_id: "id", student_name: "name", organization_id: "organization_id" }
      },
      {
        actionCode: "student_list.followup",
        label: "跟进",
        type: "open_modal",
        apiCode: "student_followup_list.create",
        modalTitle: "新增跟进",
        fields: followupCreateFields,
        defaultValues: { follow_type: "PHONE" },
        mapRowToValue: { student_id: "id" }
      },
      { actionCode: "student_list.delete", label: "删除", type: "execute_api", confirm: "确认删除这条记录？" }
    ];
    baseDsl.presentation.table.primaryRowActions = ["student_list.detail", "student_list.edit", "student_list.contracts", "student_list.prestore", "student_list.followup", "student_list.delete"];
  }

  if (page.page === "contract_product_list") {
    baseDsl.table.rowActions = [
      { actionCode: "contract_product_list.detail", label: "详情", type: "open_modal" },
      {
        actionCode: "contract_product_list.refund",
        label: "申请退费",
        type: "open_modal",
        apiCode: "refund_record.create",
        modalTitle: "申请退费",
        fields: refundCreateFields,
        defaultValues: { refund_time: "$now" },
        mapRowToValue: {
          contract_product_id: "id",
          student_id: "student_id",
          contract_id: "contract_id",
          contract_no: "contract_no",
          product_name: "product_name"
        },
        visibleWhen: {
          remaining_real_amount: { op: "gt", value: 0 },
          contract_status: { op: "notIn", value: ["REFUNDED", "CLOSED", "CANCELLED"] }
        }
      }
    ];
    baseDsl.presentation.table.primaryRowActions = ["contract_product_list.detail", "contract_product_list.refund"];
  }

  if (page.page === "contract_list") {
    baseDsl.toolbar = [
      { actionCode: "contract_list.create", label: "新增合同", type: "open_page", variant: "primary", target: { pageCode: "lead_list", title: "新生报名" } },
      {
        actionCode: "contract_list.export",
        label: "导出",
        type: "export",
        actionType: "export",
        apiCode: "contract_list.query",
        exportConfig: {
          fileName: "contract_export",
          includeCurrentFilters: true,
          columns: ["contract_no", "student_id", "sign_time", "total_amount", "paid_amount", "contract_status"]
        }
      },
      { actionCode: "contract_list.import", label: "导入", type: "import", actionType: "import", variant: "default", importConfig: { importCode: "contract_list.import", apiCode: "contract_list.create" } },
      { actionCode: "contract_list.refresh", label: "刷新", type: "execute_api", variant: "default" }
    ];
    baseDsl.table.rowActions = [
      { actionCode: "contract_list.detail", label: "详情", type: "open_modal" },
      { actionCode: "contract_list.edit", label: "编辑", type: "open_modal", visibleWhen: { contract_status: "ACTIVE" } },
      {
        actionCode: "contract_list.funds",
        label: "收款",
        type: "open_modal",
        apiCode: "funds_history.create",
        modalTitle: "合同收款",
        fields: contractFundsFields,
        defaultValues: { funds_type: "CONTRACT_PAY", transaction_time: "$now" },
        mapRowToValue: { contract_id: "id", student_id: "student_id", organization_id: "organization_id", contract_no: "contract_no", student_name: "student_name", organization_name: "organization_name" },
        visibleWhen: { contract_status: "ACTIVE" }
      },
      {
        actionCode: "contract_list.refund",
        label: "退费",
        type: "open_modal",
        apiCode: "contract.refund",
        modalTitle: "合同退费",
        fields: contractRefundFields,
        defaultValues: { refund_time: "$now" },
        mapRowToValue: { contract_id: "id", student_name: "student_name" },
        visibleWhen: { contract_status: { op: "notIn", value: ["REFUNDED", "CLOSED", "CANCELLED"] } }
      },
      { actionCode: "contract_list.print", label: "打印", type: "display", actionType: "display", printTemplateCode: "contract_receipt_print" },
      { actionCode: "contract_list.delete", label: "删除", type: "execute_api", confirm: "确认删除这条记录？", visibleWhen: { paid_status: "UNPAID" } }
    ];
    baseDsl.presentation.table.primaryRowActions = ["contract_list.detail", "contract_list.edit", "contract_list.funds", "contract_list.refund", "contract_list.print", "contract_list.delete"];
    baseDsl.modal.fields = contractCreateFields;
  }

  if (page.page === "lead_list") {
    baseDsl.title = "新生报名";
    baseDsl.subtitle = "按报名流程完成学员信息、报读课程、业务属性和结算";
    baseDsl.layout = "enrollment";
    baseDsl.presentation.header.subtitle = "按报名流程完成学员信息、报读课程、业务属性和结算";
    baseDsl.presentation.modal.size = "fullscreen";
    baseDsl.presentation.enrollment = {
      sections: {
        student: { title: "学员信息", fieldKeys: ["student_ids"] },
        products: { title: "报读课程", fieldKeys: ["product_ids"], emptyText: "请选择要报读的课程" },
        attributes: { title: "业务属性", fieldKeys: ["contract_type", "organization_id", "sign_staff_id", "sign_time", "promotion_id", "remark"] },
        settlement: {
          title: "结算",
          labels: {
            total: "共 {count} 个课程，总金额",
            productPromotion: "课程优惠",
            contractPromotion: "合同优惠",
            receivable: "合同应收款",
            save: "保存合同"
          }
        }
      },
      productTable: {
        productIdsField: "product_ids",
        rowValuePrefix: "cp_",
        productNameField: "name",
        productTypeField: "product_type",
        defaultHourField: "default_course_hour",
        unitPriceField: "unit_price",
        totalAmountField: "total_amount",
        promotionAmountField: "promotion_amount",
        columns: { product: "课程产品", courseHour: "课时", unitPrice: "单价", totalAmount: "总价", promotionAmount: "优惠金额" }
      },
      promotion: { field: "promotion_id", typeField: "type", valueField: "value", reduceValue: "REDUCE", discountValue: "DISCOUNT" }
    };
    baseDsl.toolbar = [
      {
        actionCode: "lead_list.create",
        label: "新增意向学员",
        type: "open_modal",
        variant: "primary",
        apiCode: "lead_list.create",
        modalTitle: "新增意向学员",
        fields: leadCreateFields,
        defaultValues: { source_type: "MANUAL" },
        modalSize: "large"
      },
      {
        actionCode: "lead_list.enroll",
        label: "新增报名",
        type: "open_modal",
        variant: "default",
        apiCode: "contract_list.create",
        modalTitle: "新生报名",
        fields: contractCreateFields,
        defaultValues: { contract_type: "NEW_SIGN", sign_time: "$now" },
        modalSize: "fullscreen"
      },
      { actionCode: "lead_list.refresh", label: "刷新", type: "execute_api", variant: "default" }
    ];
    baseDsl.table.rowActions = [
      {
        actionCode: "lead_list.enroll",
        label: "新增合同",
        type: "open_modal",
        apiCode: "contract_list.create",
        modalTitle: "新生报名",
        fields: contractCreateFields,
        defaultValues: { contract_type: "NEW_SIGN", sign_time: "$now" },
        mapRowToValue: { student_ids: "id", organization_id: "organization_id" },
        modalSize: "large"
      },
      {
        actionCode: "lead_list.followup",
        label: "跟进",
        type: "open_modal",
        apiCode: "student_followup_list.create",
        modalTitle: "新增跟进",
        fields: followupCreateFields,
        defaultValues: { follow_type: "PHONE", follow_result: "CONTACTED" },
        mapRowToValue: { student_id: "id" }
      },
      {
        actionCode: "lead_list.trial",
        label: "邀约试听",
        type: "open_modal",
        apiCode: "trial_lesson_list.create",
        modalTitle: "邀约试听",
        fields: trialLessonCreateFields,
        defaultValues: { course_hour: 1 },
        mapRowToValue: { student_id: "id", organization_id: "organization_id", sales_user_id: "owner_user_id" }
      },
      { actionCode: "lead_list.detail", label: "详情", type: "open_modal" },
      { actionCode: "lead_list.edit", label: "编辑", type: "open_modal" },
      { actionCode: "lead_list.delete", label: "删除", type: "execute_api", confirm: "确认删除这条记录？" }
    ];
    baseDsl.presentation.table.primaryRowActions = ["lead_list.enroll", "lead_list.followup", "lead_list.trial", "lead_list.detail", "lead_list.edit", "lead_list.delete"];
  }

  if (page.page === "course_list") {
    baseDsl.toolbar = [
      { actionCode: "course_list.create", label: "新增排课", type: "open_modal", variant: "primary", modalTitle: "新增排课", fields: courseCreateFields, defaultValues: { course_type: "ONE_ON_ONE_COURSE", course_status: "SCHEDULED", course_hour: 1 } },
      { actionCode: "course_list.week", label: "周课表", type: "open_page", target: { pageCode: "course_week_schedule", title: "周课表" } },
      { actionCode: "course_list.refresh", label: "刷新", type: "execute_api", variant: "default" }
    ];
    baseDsl.table.rowActions = [
      { actionCode: "course_list.detail", label: "详情", type: "open_modal" },
      { actionCode: "course_list.edit", label: "编辑", type: "open_modal", apiCode: "course.update", modalTitle: "编辑排课", fields: courseEditFields, visibleWhen: { course_status: { op: "ne", value: "CANCELLED" } } },
      {
        actionCode: "course_list.attendance",
        label: "考勤",
        type: "open_modal",
        apiCode: "attendance.checkIn",
        modalTitle: "学员考勤",
        fields: attendanceCheckInFields,
        mapRowToValue: { course_id: "id" },
        visibleWhen: { course_status: { op: "ne", value: "CANCELLED" } }
      },
      { actionCode: "course_list.leave", label: "请假", type: "open_modal", apiCode: "leave_record.create", modalTitle: "学员请假", fields: leaveCreateFields, mapRowToValue: { course_id: "id", organization_id: "organization_id" }, visibleWhen: { course_status: { op: "ne", value: "CANCELLED" } } },
      { actionCode: "course_list.makeup", label: "安排补课", type: "open_modal", apiCode: "makeup_course_record.create", modalTitle: "安排补课", fields: makeupCreateFields, defaultValues: { course_hour: 1, course_title: "补课" }, mapRowToValue: { original_course_id: "id", organization_id: "organization_id", teacher_id: "teacher_id", study_manager_id: "study_manager_id" } },
      { actionCode: "course_list.cancel", label: "取消排课", type: "execute_api", apiCode: "course.cancel", confirm: "确认取消该排课？已有考勤或扣费的课程不能取消", variant: "danger", visibleWhen: { course_status: "SCHEDULED" } },
      { actionCode: "course_list.delete", label: "删除", type: "open_modal", apiCode: "course_list.delete", modalTitle: "删除排课", variant: "danger", confirm: "确认删除该排课？将回滚关联考勤和扣费", fields: [
        { key: "id", label: "课程ID", type: "text", hidden: true },
        { key: "delete_reason", label: "删除原因", type: "textarea", span: "full" as const, rows: 3, required: true }
      ], mapRowToValue: { id: "id" } }
    ];
    baseDsl.presentation.table.primaryRowActions = ["course_list.detail", "course_list.edit", "course_list.attendance", "course_list.leave", "course_list.makeup", "course_list.cancel", "course_list.delete"];
    baseDsl.table.columns = [
      { key: "course_title", title: "课程名称", width: 180 },
      { key: "course_type", title: "课程类型", width: 120 },
      { key: "course_date", title: "上课日期", type: "date", width: 120 },
      { key: "start_time", title: "开始", width: 90 },
      { key: "end_time", title: "结束", width: 90 },
      { key: "course_hour", title: "课时", width: 80, align: "right" },
      { key: "student_names", title: "上课学员", width: 180 },
      { key: "organization_id", title: "上课校区", width: 150, displayKey: "organization_name" },
      { key: "teacher_id", title: "授课老师", width: 130, displayKey: "teacher_name" },
      { key: "study_manager_id", title: "班主任", width: 130, displayKey: "study_manager_name" },
      { key: "course_status", title: "状态", width: 100, align: "center", badge: true }
    ];
    baseDsl.modal.fields = courseCreateFields;
  }

  if (page.page === "course_week_schedule") {
    baseDsl.layout = "calendar";
    baseDsl.presentation.type = "calendar";
    baseDsl.presentation.calendarField = "course_date";
    baseDsl.toolbar = [
      { actionCode: "course_week_schedule.create", label: "新增排课", type: "open_page", target: { pageCode: "course_list", title: "排课列表" }, variant: "primary" },
      { actionCode: "course_week_schedule.export", label: "导出", type: "export", actionType: "export", variant: "default" }
    ];
    baseDsl.table.rowActions = [
      { actionCode: "course_week_schedule.detail", label: "详情", type: "open_modal" },
      { actionCode: "course_week_schedule.attendance", label: "考勤", type: "open_modal", apiCode: "attendance.checkIn", modalTitle: "学员考勤", fields: attendanceCheckInFields, mapRowToValue: { course_id: "id" } },
      { actionCode: "course_week_schedule.leave", label: "请假", type: "open_modal", apiCode: "leave_record.create", modalTitle: "学员请假", fields: leaveCreateFields, mapRowToValue: { course_id: "id", organization_id: "organization_id" } },
      { actionCode: "course_week_schedule.makeup", label: "安排补课", type: "open_modal", apiCode: "makeup_course_record.create", modalTitle: "安排补课", fields: makeupCreateFields, defaultValues: { course_hour: 1, course_title: "补课" }, mapRowToValue: { original_course_id: "id", organization_id: "organization_id", teacher_id: "teacher_id", study_manager_id: "study_manager_id" } },
      { actionCode: "course_week_schedule.course", label: "打开排课", type: "open_page", target: { pageCode: "course_list", title: "排课列表", filterField: "id", rowField: "id" } }
    ];
    baseDsl.presentation.table.primaryRowActions = ["course_week_schedule.detail", "course_week_schedule.attendance", "course_week_schedule.leave", "course_week_schedule.makeup", "course_week_schedule.course"];
    baseDsl.table.columns = [
      { key: "course_date", title: "日期", type: "date", width: 120 },
      { key: "start_time", title: "开始时间", width: 110 },
      { key: "end_time", title: "结束时间", width: 110 },
      { key: "course_title", title: "课程", width: 180 },
      { key: "course_type", title: "类型", width: 120 },
      { key: "organization_id", title: "上课校区", width: 150, displayKey: "organization_name" },
      { key: "teacher_id", title: "老师", width: 130, displayKey: "teacher_name" },
      { key: "study_manager_id", title: "班主任", width: 130, displayKey: "study_manager_name" },
      { key: "mini_class_id", title: "班级", width: 140, displayKey: "mini_class_name" },
      { key: "one_on_n_group_id", title: "1对N小组", width: 140, displayKey: "one_on_n_group_name" },
      { key: "course_status", title: "状态", width: 100, align: "center", badge: true }
    ];
  }

  if (page.page === "contract_product_list") {
    baseDsl.table.rowActions = [
      { actionCode: "contract_product_list.detail", label: "详情", type: "open_modal" },
      {
        actionCode: "contract_product_list.refund",
        label: "退费",
        type: "open_modal",
        apiCode: "refund_record.create",
        modalTitle: "合同产品退费",
        fields: refundCreateFields,
        defaultValues: { refund_time: "$now", refund_type: "CONTRACT_PRODUCT" },
        mapRowToValue: {
          contract_product_id: "id",
          student_id: "student_id",
          available_refund_real_hour: "remaining_real_hour",
          available_refund_real_amount: "remaining_real_amount",
          available_refund_promotion_hour: "remaining_promotion_hour",
          available_refund_promotion_amount: "remaining_promotion_amount"
        },
        visibleWhen: {
          remaining_real_amount: { op: "gt", value: 0 },
          contract_status: { op: "notIn", value: ["REFUNDED", "CLOSED", "CANCELLED"] }
        }
      }
    ];
    baseDsl.presentation.table.primaryRowActions = ["contract_product_list.detail", "contract_product_list.refund"];
  }

  if (page.page === "charge_record") {
    baseDsl.toolbar = [
      { actionCode: "charge_record.create", label: "新增扣费", type: "open_modal", variant: "primary", modalTitle: "扣费确认", fields: chargeCreateFields },
      { actionCode: "charge_record.refresh", label: "刷新", type: "execute_api", variant: "default" }
    ];
    baseDsl.table.rowActions = [
      { actionCode: "charge_record.detail", label: "详情", type: "open_modal" },
      { actionCode: "charge_record.reverse", label: "取消扣费", type: "open_modal", apiCode: "chargeRecord.reverse", modalTitle: "取消扣费", fields: chargeReverseFields, mapRowToValue: { id: "id" }, variant: "danger", visibleWhen: { charge_status: "CONFIRMED" } }
    ];
    baseDsl.presentation.table.primaryRowActions = ["charge_record.detail", "charge_record.reverse"];
    baseDsl.modal.fields = chargeCreateFields;
  }

  if (page.page === "refund_record") {
    baseDsl.toolbar = [
      { actionCode: "refund_record.create", label: "新增退费", type: "open_modal", variant: "primary", modalTitle: "新增退费", fields: refundCreateFields, defaultValues: { refund_time: "$now" } },
      { actionCode: "refund_record.refresh", label: "刷新", type: "execute_api", variant: "default" }
    ];
    baseDsl.table.rowActions = [
      { actionCode: "refund_record.detail", label: "详情", type: "open_modal" },
      { actionCode: "refund_record.delete", label: "删除", type: "execute_api", apiCode: "refund.delete", confirm: "确认删除该退费记录？删除后将恢复合同产品余额", variant: "danger" }
    ];
    baseDsl.presentation.table.primaryRowActions = ["refund_record.detail", "refund_record.delete"];
    baseDsl.modal.fields = refundCreateFields;
  }

  if (page.page === "mini_class_list") {
    baseDsl.table.rowActions = [
      { actionCode: "mini_class_list.detail", label: "详情", type: "open_modal" },
      { actionCode: "mini_class_list.students", label: "班级学员", type: "open_page", target: { pageCode: "mini_class_student_list", title: "班级学员", filterField: "mini_class_id", rowField: "id" } },
      { actionCode: "mini_class_list.edit", label: "编辑", type: "open_modal" },
      {
        actionCode: "mini_class_list.addStudent",
        label: "添加学员",
        type: "open_modal",
        apiCode: "miniClass.addStudent",
        modalTitle: "添加班级学员",
        fields: addStudentFields,
        mapRowToValue: { mini_class_id: "id" }
      },
      { actionCode: "mini_class_list.schedule", label: "直接排课", type: "open_modal", apiCode: "course_list.create", modalTitle: "班级排课", fields: courseCreateFields, defaultValues: { course_type: "SMALL_CLASS", course_status: "SCHEDULED", course_hour: 1, course_dates: ["$today"] }, mapRowToValue: { mini_class_id: "id", organization_id: "organization_id", teacher_id: "teacher_id", study_manager_id: "study_manager_id", product_id: "product_id", grade: "grade", subject: "subject" } },
      { actionCode: "mini_class_list.transfer", label: "批量调班", type: "open_modal", apiCode: "classStudent.transfer", modalTitle: "批量调班", fields: classTransferFields, defaultValues: { target_type: "mini_class" }, mapRowToValue: { from_target_id: "id" } },
      { actionCode: "mini_class_list.markFull", label: "标记满班", type: "execute_api", apiCode: "class.changeStatus", defaultValues: { target_type: "mini_class", target_status: "FULL" } },
      { actionCode: "mini_class_list.close", label: "结班", type: "execute_api", apiCode: "class.changeStatus", confirm: "确认结班？结班后不建议继续排课。", defaultValues: { target_type: "mini_class", target_status: "CLOSED" } },
      { actionCode: "mini_class_list.delete", label: "删除", type: "execute_api", confirm: "确认删除这条记录？" }
    ];
    baseDsl.presentation.table.primaryRowActions = ["mini_class_list.detail", "mini_class_list.students", "mini_class_list.edit", "mini_class_list.addStudent", "mini_class_list.schedule", "mini_class_list.transfer", "mini_class_list.markFull", "mini_class_list.close", "mini_class_list.delete"];
  }

  if (page.page === "one_on_n_group_list") {
    baseDsl.table.rowActions = [
      { actionCode: "one_on_n_group_list.detail", label: "详情", type: "open_modal" },
      { actionCode: "one_on_n_group_list.students", label: "小组学员", type: "open_page", target: { pageCode: "one_on_n_group_student_list", title: "小组学员", filterField: "one_on_n_group_id", rowField: "id" } },
      { actionCode: "one_on_n_group_list.edit", label: "编辑", type: "open_modal" },
      {
        actionCode: "one_on_n_group_list.addStudent",
        label: "添加学员",
        type: "open_modal",
        apiCode: "oneOnNGroup.addStudent",
        modalTitle: "添加1对N学员",
        fields: addStudentFields,
        mapRowToValue: { one_on_n_group_id: "id" }
      },
      { actionCode: "one_on_n_group_list.schedule", label: "直接排课", type: "open_modal", apiCode: "course_list.create", modalTitle: "1对N排课", fields: courseCreateFields, defaultValues: { course_type: "ONE_ON_N_GROUP", course_status: "SCHEDULED", course_hour: 1, course_dates: ["$today"] }, mapRowToValue: { one_on_n_group_id: "id", organization_id: "organization_id", teacher_id: "teacher_id", study_manager_id: "study_manager_id", product_id: "product_id", grade: "grade", subject: "subject" } },
      { actionCode: "one_on_n_group_list.transfer", label: "批量调组", type: "open_modal", apiCode: "classStudent.transfer", modalTitle: "批量调组", fields: classTransferFields, defaultValues: { target_type: "one_on_n_group" }, mapRowToValue: { from_target_id: "id" } },
      { actionCode: "one_on_n_group_list.markFull", label: "标记满组", type: "execute_api", apiCode: "class.changeStatus", defaultValues: { target_type: "one_on_n_group", target_status: "FULL" } },
      { actionCode: "one_on_n_group_list.close", label: "结组", type: "execute_api", apiCode: "class.changeStatus", confirm: "确认结组？结组后不建议继续排课。", defaultValues: { target_type: "one_on_n_group", target_status: "CLOSED" } },
      { actionCode: "one_on_n_group_list.delete", label: "删除", type: "execute_api", confirm: "确认删除这条记录？" }
    ];
    baseDsl.presentation.table.primaryRowActions = ["one_on_n_group_list.detail", "one_on_n_group_list.students", "one_on_n_group_list.edit", "one_on_n_group_list.addStudent", "one_on_n_group_list.schedule", "one_on_n_group_list.transfer", "one_on_n_group_list.markFull", "one_on_n_group_list.close", "one_on_n_group_list.delete"];
  }

  if (page.page === "mini_class_student_list" || page.page === "one_on_n_group_student_list") {
    baseDsl.toolbar = [
      { actionCode: `${page.page}.refresh`, label: "刷新", type: "execute_api", variant: "default" }
    ];
    baseDsl.table.rowActions = [
      { actionCode: `${page.page}.detail`, label: "详情", type: "open_modal" },
      {
        actionCode: `${page.page}.removeStudent`,
        label: "移除",
        type: "execute_api",
        apiCode: page.page === "mini_class_student_list" ? "miniClass.removeStudent" : "oneOnNGroup.removeStudent",
        mapRowToValue: page.page === "mini_class_student_list" ? { mini_class_id: "mini_class_id", student_id: "student_id" } : { one_on_n_group_id: "one_on_n_group_id", student_id: "student_id" },
        confirm: "确认移除该学员？",
        variant: "danger"
      }
    ];
    baseDsl.presentation.table.primaryRowActions = [`${page.page}.detail`, `${page.page}.removeStudent`];
  }

  if (page.page === "leave_record") {
    baseDsl.toolbar = [
      { actionCode: "leave_record.create", label: "新增请假", type: "open_modal", variant: "primary", modalTitle: "新增请假", fields: leaveCreateFields, defaultValues: { status: "APPROVED", leave_type: "PERSONAL", leave_time: "$now" } },
      { actionCode: "leave_record.refresh", label: "刷新", type: "execute_api", variant: "default" }
    ];
    baseDsl.table.rowActions = [
      { actionCode: "leave_record.detail", label: "详情", type: "open_modal" },
      { actionCode: "leave_record.course", label: "查看课程", type: "open_page", target: { pageCode: "course_list", title: "排课列表", filterField: "id", rowField: "course_id" } },
      { actionCode: "leave_record.makeup", label: "安排补课", type: "open_modal", apiCode: "makeup_course_record.create", modalTitle: "安排补课", fields: makeupCreateFields, defaultValues: { course_hour: 1, course_title: "补课" }, mapRowToValue: { original_course_id: "course_id", student_id: "student_id", organization_id: "organization_id", source_id: "id" } }
    ];
    baseDsl.presentation.table.primaryRowActions = ["leave_record.detail", "leave_record.course", "leave_record.makeup"];
    baseDsl.modal.fields = leaveCreateFields;
  }

  if (page.page === "makeup_course_record") {
    baseDsl.toolbar = [
      { actionCode: "makeup_course_record.create", label: "新增补课", type: "open_modal", variant: "primary", modalTitle: "新增补课", fields: makeupCreateFields, defaultValues: { course_hour: 1, course_title: "补课" } },
      { actionCode: "makeup_course_record.refresh", label: "刷新", type: "execute_api", variant: "default" }
    ];
    baseDsl.table.rowActions = [
      { actionCode: "makeup_course_record.detail", label: "详情", type: "open_modal" },
      { actionCode: "makeup_course_record.originalCourse", label: "原课程", type: "open_page", target: { pageCode: "course_list", title: "排课列表", filterField: "id", rowField: "original_course_id" } },
      { actionCode: "makeup_course_record.makeupCourse", label: "补课课次", type: "open_page", target: { pageCode: "course_list", title: "排课列表", filterField: "id", rowField: "makeup_course_id" } },
      { actionCode: "makeup_course_record.student", label: "查看学员", type: "open_page", target: { pageCode: "student_list", title: "学员列表", filterField: "id", rowField: "student_id" } }
    ];
    baseDsl.presentation.table.primaryRowActions = ["makeup_course_record.detail", "makeup_course_record.originalCourse", "makeup_course_record.makeupCourse", "makeup_course_record.student"];
    baseDsl.modal.fields = makeupCreateFields;
  }

  if (page.page === "course_holiday_calendar") {
    baseDsl.toolbar = [
      { actionCode: "course_holiday_calendar.create", label: "新增停课", type: "open_modal", variant: "primary", modalTitle: "新增停课", fields: holidayCreateFields, defaultValues: { block_course: true, holiday_type: "CAMPUS_CLOSED" } },
      { actionCode: "course_holiday_calendar.refresh", label: "刷新", type: "execute_api", variant: "default" }
    ];
    baseDsl.table.rowActions = [
      { actionCode: "course_holiday_calendar.detail", label: "详情", type: "open_modal" },
      { actionCode: "course_holiday_calendar.courses", label: "影响课程", type: "open_page", target: { pageCode: "course_list", title: "排课列表", filterField: "course_date", rowField: "holiday_date" } },
      { actionCode: "course_holiday_calendar.cancelCourses", label: "批量取消课程", type: "execute_api", apiCode: "holiday.apply", defaultValues: { mode: "cancel" }, confirm: "确认按停课规则批量取消影响课程？" },
      { actionCode: "course_holiday_calendar.postponeCourses", label: "批量顺延课程", type: "execute_api", apiCode: "holiday.apply", defaultValues: { mode: "postpone" }, confirm: "确认按停课规则批量顺延影响课程？" }
    ];
    baseDsl.presentation.table.primaryRowActions = ["course_holiday_calendar.detail", "course_holiday_calendar.courses", "course_holiday_calendar.cancelCourses", "course_holiday_calendar.postponeCourses"];
    baseDsl.modal.fields = holidayCreateFields;
  }

  if (page.page === "performance_arrange_list") {
    baseDsl.toolbar = [
      { actionCode: "performance_arrange_list.adjust", label: "业绩调整", type: "open_modal", variant: "primary", apiCode: "performanceArrange.save", modalTitle: "业绩调整", fields: performanceAdjustFields, defaultValues: { performance_type: "MANUAL_ADJUST", source_type: "MANUAL_ADJUSTMENT" } },
      { actionCode: "performance_arrange_list.refresh", label: "刷新", type: "execute_api", variant: "default" }
    ];
    baseDsl.table.rowActions = [
      { actionCode: "performance_arrange_list.detail", label: "详情", type: "open_modal" }
    ];
    baseDsl.presentation.table.primaryRowActions = ["performance_arrange_list.detail"];
  }

  if (page.page === "funds_history") {
    baseDsl.toolbar = [
      { actionCode: "funds_history.create", label: "新增收款", type: "open_modal", variant: "primary", modalTitle: "新增收款", fields: fundsCreateFields, defaultValues: { funds_type: "CONTRACT_PAY", transaction_time: "$now" } },
      { actionCode: "funds_history.refresh", label: "刷新", type: "execute_api", variant: "default" }
    ];
    baseDsl.table.rowActions = [
      { actionCode: "funds_history.detail", label: "详情", type: "open_modal" },
      { actionCode: "funds_history.delete", label: "作废", type: "open_modal", apiCode: "funds.delete", modalTitle: "作废收款", fields: fundsVoidFields, mapRowToValue: { id: "id" }, variant: "danger", confirm: "作废后将回滚排款、优惠、业绩与电子账户，确认继续？" }
    ];
    baseDsl.presentation.table.primaryRowActions = ["funds_history.detail", "funds_history.delete"];
    baseDsl.modal.fields = fundsCreateFields;
  }



  if (page.page === "wechat_account_binding") {
    baseDsl.toolbar = [
      { actionCode: "wechat_account_binding.authorize", label: "扫码授权", type: "execute_api", apiCode: "wechat.authorizeUrl.create", variant: "primary", defaultValues: { account_name: "待授权服务号" } },
      { actionCode: "wechat_account_binding.refresh", label: "刷新", type: "execute_api", variant: "default" }
    ];
    baseDsl.table.rowActions = [
      { actionCode: "wechat_account_binding.detail", label: "详情", type: "open_modal" },
      { actionCode: "wechat_account_binding.authComplete", label: "授权回调补录", type: "execute_api", apiCode: "wechat.authorization.callback" },
      { actionCode: "wechat_account_binding.setDefault", label: "设为默认", type: "execute_api", apiCode: "wechat.binding.setDefault" },
      { actionCode: "wechat_account_binding.sync", label: "同步状态", type: "execute_api", apiCode: "wechat.status.sync" },
      { actionCode: "wechat_account_binding.refreshToken", label: "刷新Token", type: "execute_api", apiCode: "wechat.token.refresh" },
      { actionCode: "wechat_account_binding.unbind", label: "解绑", type: "execute_api", apiCode: "wechat.binding.unbind", confirm: "确认解绑该公众号？" },
      { actionCode: "wechat_account_binding.edit", label: "编辑", type: "open_modal" },
      { actionCode: "wechat_account_binding.delete", label: "删除", type: "execute_api", confirm: "确认删除该绑定？" }
    ];
    baseDsl.presentation.table.primaryRowActions = ["wechat_account_binding.detail", "wechat_account_binding.authComplete", "wechat_account_binding.setDefault", "wechat_account_binding.sync", "wechat_account_binding.refreshToken", "wechat_account_binding.unbind", "wechat_account_binding.edit", "wechat_account_binding.delete"];
  }

  if (page.page === "wechat_menu_config") {
    baseDsl.table.rowActions = [
      { actionCode: "wechat_menu_config.detail", label: "详情", type: "open_modal" },
      { actionCode: "wechat_menu_config.publish", label: "发布菜单", type: "execute_api", apiCode: "wechat.menu.publish", confirm: "确认发布菜单到公众号？" },
      { actionCode: "wechat_menu_config.edit", label: "编辑", type: "open_modal" },
      { actionCode: "wechat_menu_config.delete", label: "删除", type: "execute_api", confirm: "确认删除该菜单？" }
    ];
    baseDsl.presentation.table.primaryRowActions = ["wechat_menu_config.detail", "wechat_menu_config.publish", "wechat_menu_config.edit", "wechat_menu_config.delete"];
  }

  if (page.page === "wechat_push_rule") {
    baseDsl.table.rowActions = [
      { actionCode: "wechat_push_rule.detail", label: "详情", type: "open_modal" },
      { actionCode: "wechat_push_rule.testSend", label: "测试发送", type: "execute_api", apiCode: "wechat.template.send", defaultValues: { business_event: "manual.test" } },
      { actionCode: "wechat_push_rule.retry", label: "重试失败", type: "execute_api", apiCode: "wechat.push.retry" },
      { actionCode: "wechat_push_rule.processOutbox", label: "处理推送队列", type: "execute_api", apiCode: "wechat.push.outbox.process" },
      { actionCode: "wechat_push_rule.edit", label: "编辑", type: "open_modal" },
      { actionCode: "wechat_push_rule.delete", label: "删除", type: "execute_api", confirm: "确认删除该规则？" }
    ];
    baseDsl.presentation.table.primaryRowActions = ["wechat_push_rule.detail", "wechat_push_rule.testSend", "wechat_push_rule.retry", "wechat_push_rule.processOutbox", "wechat_push_rule.edit", "wechat_push_rule.delete"];
  }



  if (page.page === "mall_goods") {
    baseDsl.table.rowActions = [
      { actionCode: "mall_goods.detail", label: "详情", type: "open_modal" },
      { actionCode: "mall_goods.edit", label: "编辑", type: "open_modal" },
      { actionCode: "mall_goods.createOrder", label: "创建订单", type: "open_modal", apiCode: "mall.order.create", modalTitle: "创建商城订单", fields: mallOrderCreateFields, defaultValues: { quantity: 1 }, mapRowToValue: { goods_id: "id" } },
      { actionCode: "mall_goods.delete", label: "删除", type: "execute_api", confirm: "确认删除该商品？" }
    ];
    baseDsl.presentation.table.primaryRowActions = ["mall_goods.detail", "mall_goods.edit", "mall_goods.createOrder", "mall_goods.delete"];
  }

  if (page.page === "mall_activity") {
    baseDsl.table.rowActions = [
      { actionCode: "mall_activity.detail", label: "详情", type: "open_modal" },
      { actionCode: "mall_activity.goods", label: "查看商品", type: "open_page", target: { pageCode: "mall_goods", title: "商城商品", filterField: "id", rowField: "goods_id" } },
      { actionCode: "mall_activity.groups", label: "查看团单", type: "open_page", target: { pageCode: "mall_group_buy", title: "团购团单", filterField: "activity_id", rowField: "id" } },
      { actionCode: "mall_activity.orders", label: "查看订单", type: "open_page", target: { pageCode: "mall_order", title: "商城订单", filterField: "activity_id", rowField: "id" } },
      { actionCode: "mall_activity.edit", label: "编辑", type: "open_modal" },
      { actionCode: "mall_activity.delete", label: "删除", type: "execute_api", confirm: "确认删除该营销活动？" }
    ];
    baseDsl.presentation.table.primaryRowActions = ["mall_activity.detail", "mall_activity.goods", "mall_activity.groups", "mall_activity.orders", "mall_activity.edit", "mall_activity.delete"];
  }

  if (page.page === "mall_group_buy") {
    baseDsl.table.rowActions = [
      { actionCode: "mall_group_buy.detail", label: "详情", type: "open_modal" },
      { actionCode: "mall_group_buy.complete", label: "手动成团", type: "execute_api", apiCode: "mall.group.complete", confirm: "确认将该团单标记为成团？", visibleWhen: { group_status: "OPEN" } },
      { actionCode: "mall_group_buy.close", label: "关闭团单", type: "execute_api", apiCode: "mall.group.close", confirm: "确认关闭该团单？", visibleWhen: { group_status: ["OPEN", "FAILED"] } },
      { actionCode: "mall_group_buy.members", label: "查看成员", type: "open_page", target: { pageCode: "mall_group_member", title: "团购成员", filterField: "group_id", rowField: "id" } },
      { actionCode: "mall_group_buy.orders", label: "查看订单", type: "open_page", target: { pageCode: "mall_order", title: "商城订单", filterField: "activity_id", rowField: "activity_id" } },
      { actionCode: "mall_group_buy.activity", label: "查看活动", type: "open_page", target: { pageCode: "mall_activity", title: "营销活动", filterField: "id", rowField: "activity_id" } },
      { actionCode: "mall_group_buy.edit", label: "编辑", type: "open_modal" }
    ];
    baseDsl.presentation.table.primaryRowActions = ["mall_group_buy.detail", "mall_group_buy.complete", "mall_group_buy.close", "mall_group_buy.members", "mall_group_buy.orders", "mall_group_buy.activity", "mall_group_buy.edit"];
  }

  if (page.page === "mall_group_member") {
    baseDsl.table.rowActions = [
      { actionCode: "mall_group_member.detail", label: "详情", type: "open_modal" },
      { actionCode: "mall_group_member.leave", label: "退出团", type: "execute_api", apiCode: "mall.group.leave", confirm: "确认将该成员退出团单？", variant: "danger", visibleWhen: { member_status: "JOINED" } },
      { actionCode: "mall_group_member.order", label: "查看订单", type: "open_page", target: { pageCode: "mall_order", title: "商城订单", filterField: "id", rowField: "order_id" } },
      { actionCode: "mall_group_member.student", label: "查看学员", type: "open_page", target: { pageCode: "student_list", title: "学员列表", filterField: "id", rowField: "student_id" } },
      { actionCode: "mall_group_member.group", label: "查看团单", type: "open_page", target: { pageCode: "mall_group_buy", title: "团购团单", filterField: "id", rowField: "group_id" } }
    ];
    baseDsl.presentation.table.primaryRowActions = ["mall_group_member.detail", "mall_group_member.leave", "mall_group_member.order", "mall_group_member.student", "mall_group_member.group"];
  }

  if (page.page === "mall_order") {
    baseDsl.table.rowActions = [
      { actionCode: "mall_order.detail", label: "详情", type: "open_modal" },
      { actionCode: "mall_order.status", label: "查询状态", type: "execute_api", apiCode: "mall.order.status" },
      { actionCode: "mall_order.reconcile", label: "补单", type: "execute_api", apiCode: "mall.order.reconcile" },
      { actionCode: "mall_order.fulfillRetry", label: "重试履约", type: "execute_api", apiCode: "mall.order.fulfillRetry" },
      { actionCode: "mall_order.refund", label: "退款", type: "execute_api", apiCode: "mall.order.refund", confirm: "确认退款并关闭关联订单？" },
      { actionCode: "mall_order.close", label: "关闭", type: "execute_api", apiCode: "mall.order.close", confirm: "确认关闭未支付订单？" },
      { actionCode: "mall_order.edit", label: "编辑", type: "open_modal" }
    ];
    baseDsl.presentation.table.primaryRowActions = ["mall_order.detail", "mall_order.status", "mall_order.reconcile", "mall_order.fulfillRetry", "mall_order.refund", "mall_order.close", "mall_order.edit"];
  }


  if (page.page === "coupon_template_list") {
    baseDsl.table.rowActions = [
      { actionCode: "coupon_template_list.detail", label: "详情", type: "open_modal" },
      { actionCode: "coupon_template_list.claim", label: "发券", type: "open_modal", apiCode: "coupon.claim", modalTitle: "手工发券", fields: couponClaimFields, defaultValues: { source: "manual" }, mapRowToValue: { coupon_template_id: "id" } },
      { actionCode: "coupon_template_list.claims", label: "领取明细", type: "open_page", target: { pageCode: "coupon_claim_list", title: "优惠券领取", filterField: "coupon_template_id", rowField: "id" } },
      { actionCode: "coupon_template_list.edit", label: "编辑", type: "open_modal" },
      { actionCode: "coupon_template_list.delete", label: "删除", type: "execute_api", confirm: "确认删除该优惠券模板？" }
    ];
    baseDsl.presentation.table.primaryRowActions = ["coupon_template_list.detail", "coupon_template_list.claim", "coupon_template_list.claims", "coupon_template_list.edit", "coupon_template_list.delete"];
  }

  if (page.page === "coupon_claim_list") {
    baseDsl.table.rowActions = [
      { actionCode: "coupon_claim_list.detail", label: "详情", type: "open_modal" },
      { actionCode: "coupon_claim_list.template", label: "查看模板", type: "open_page", target: { pageCode: "coupon_template_list", title: "优惠券模板", filterField: "id", rowField: "coupon_template_id" } },
      { actionCode: "coupon_claim_list.student", label: "查看学员", type: "open_page", target: { pageCode: "student_list", title: "学员列表", filterField: "id", rowField: "student_id" } },
      { actionCode: "coupon_claim_list.order", label: "查看订单", type: "open_page", target: { pageCode: "mall_order", title: "商城订单", filterField: "id", rowField: "used_order_id" } }
    ];
    baseDsl.presentation.table.primaryRowActions = ["coupon_claim_list.detail", "coupon_claim_list.template", "coupon_claim_list.student", "coupon_claim_list.order"];
  }

  if (page.page === "wechat_student_fan") {
    baseDsl.table.rowActions = [
      { actionCode: "wechat_student_fan.detail", label: "详情", type: "open_modal" },
      { actionCode: "wechat_student_fan.bind", label: "绑定学员", type: "open_modal", apiCode: "wechat.openid.bind", modalTitle: "绑定微信学员", fields: wechatBindStudentFields, mapRowToValue: { binding_id: "binding_id", openid: "openid" } },
      { actionCode: "wechat_student_fan.student", label: "查看学员", type: "open_page", target: { pageCode: "student_list", title: "学员列表", filterField: "id", rowField: "student_id" } },
      { actionCode: "wechat_student_fan.edit", label: "编辑", type: "open_modal" }
    ];
    baseDsl.presentation.table.primaryRowActions = ["wechat_student_fan.detail", "wechat_student_fan.bind", "wechat_student_fan.student", "wechat_student_fan.edit"];
  }

  if (page.page === "wechat_push_log") {
    baseDsl.table.rowActions = [
      { actionCode: "wechat_push_log.detail", label: "详情", type: "open_modal" },
      { actionCode: "wechat_push_log.retry", label: "重试失败", type: "execute_api", apiCode: "wechat.push.retry" },
      { actionCode: "wechat_push_log.student", label: "查看学员", type: "open_page", target: { pageCode: "student_list", title: "学员列表", filterField: "id", rowField: "student_id" } }
    ];
    baseDsl.presentation.table.primaryRowActions = ["wechat_push_log.detail", "wechat_push_log.retry", "wechat_push_log.student"];
  }

  if (page.page === "landing_page_list") {
    baseDsl.table.rowActions = [
      { actionCode: "landing_page_list.detail", label: "详情", type: "open_modal" },
      { actionCode: "landing_page_list.submitLead", label: "录入线索", type: "open_modal", apiCode: "landing.lead.submit", modalTitle: "落地页线索", fields: landingLeadSubmitFields, mapRowToValue: { page_id: "id", channel_id: "channel_id" } },
      { actionCode: "landing_page_list.leads", label: "查看线索", type: "open_page", target: { pageCode: "lead_stage_list", title: "招生漏斗", filterField: "channel_id", rowField: "channel_id" } },
      { actionCode: "landing_page_list.edit", label: "编辑", type: "open_modal" },
      { actionCode: "landing_page_list.delete", label: "删除", type: "execute_api", confirm: "确认删除该落地页？" }
    ];
    baseDsl.presentation.table.primaryRowActions = ["landing_page_list.detail", "landing_page_list.submitLead", "landing_page_list.leads", "landing_page_list.edit", "landing_page_list.delete"];
  }

  if (page.page === "recruit_channel_list") {
    baseDsl.table.rowActions = [
      { actionCode: "recruit_channel_list.detail", label: "详情", type: "open_modal" },
      { actionCode: "recruit_channel_list.addCost", label: "登记成本", type: "open_modal", apiCode: "recruit_channel_cost_list.create", modalTitle: "登记渠道成本", fields: channelCostFields, defaultValues: { cost_date: "$today" }, mapRowToValue: { channel_id: "id" } },
      { actionCode: "recruit_channel_list.leads", label: "查看线索", type: "open_page", target: { pageCode: "lead_stage_list", title: "招生漏斗", filterField: "channel_id", rowField: "id" } },
      { actionCode: "recruit_channel_list.edit", label: "编辑", type: "open_modal" },
      { actionCode: "recruit_channel_list.delete", label: "删除", type: "execute_api", confirm: "确认删除该招生渠道？" }
    ];
    baseDsl.presentation.table.primaryRowActions = ["recruit_channel_list.detail", "recruit_channel_list.addCost", "recruit_channel_list.leads", "recruit_channel_list.edit", "recruit_channel_list.delete"];
  }

  if (page.page === "lead_stage_list") {
    baseDsl.table.rowActions = [
      { actionCode: "lead_stage_list.detail", label: "详情", type: "open_modal" },
      { actionCode: "lead_stage_list.assign", label: "分配", type: "open_modal", apiCode: "lead.assign", modalTitle: "分配意向学员", fields: leadAssignFields, mapRowToValue: { student_id: "student_id" } },
      { actionCode: "lead_stage_list.claim", label: "领取", type: "execute_api", apiCode: "lead.claim", mapRowToValue: { student_id: "student_id" } },
      { actionCode: "lead_stage_list.recycle", label: "回收", type: "execute_api", apiCode: "lead.recycle", mapRowToValue: { student_id: "student_id" } },
      { actionCode: "lead_stage_list.followup", label: "跟进", type: "open_modal", apiCode: "student_followup_list.create", modalTitle: "新增跟进", fields: followupCreateFields, defaultValues: { follow_type: "PHONE", follow_result: "CONTACTED" }, mapRowToValue: { student_id: "student_id", lead_stage_id: "id" } },
      { actionCode: "lead_stage_list.edit", label: "编辑", type: "open_modal" }
    ];
    baseDsl.presentation.table.primaryRowActions = ["lead_stage_list.detail", "lead_stage_list.assign", "lead_stage_list.claim", "lead_stage_list.recycle", "lead_stage_list.followup", "lead_stage_list.edit"];
  }

  if (page.page === "trial_lesson_list") {
    baseDsl.table.rowActions = [
      { actionCode: "trial_lesson_list.detail", label: "详情", type: "open_modal" },
      { actionCode: "trial_lesson_list.feedback", label: "试听反馈", type: "open_modal", apiCode: "trial_lesson_list.update", modalTitle: "试听反馈", fields: trialFeedbackFields, mapRowToValue: { id: "id" } },
      { actionCode: "trial_lesson_list.enroll", label: "转报名", type: "open_modal", apiCode: "contract_list.create", modalTitle: "新生报名", fields: contractCreateFields, defaultValues: { contract_type: "NEW_SIGN", sign_time: "$now" }, mapRowToValue: { student_ids: "student_id" }, modalSize: "fullscreen" },
      { actionCode: "trial_lesson_list.course", label: "查看课次", type: "open_page", target: { pageCode: "course_list", title: "排课列表", filterField: "id", rowField: "course_id" } },
      { actionCode: "trial_lesson_list.edit", label: "编辑", type: "open_modal" }
    ];
    baseDsl.presentation.table.primaryRowActions = ["trial_lesson_list.detail", "trial_lesson_list.feedback", "trial_lesson_list.enroll", "trial_lesson_list.course", "trial_lesson_list.edit"];
  }

  if (page.page === "sales_task_list") {
    baseDsl.table.rowActions = [
      { actionCode: "sales_task_list.detail", label: "详情", type: "open_modal" },
      { actionCode: "sales_task_list.complete", label: "完成", type: "execute_api", apiCode: "sales_task_list.update", defaultValues: { task_status: "COMPLETED", complete_time: "$now" } },
      { actionCode: "sales_task_list.followup", label: "写跟进", type: "open_modal", apiCode: "student_followup_list.create", modalTitle: "新增跟进", fields: followupCreateFields, defaultValues: { follow_type: "PHONE", follow_result: "CONTACTED" }, mapRowToValue: { student_id: "student_id" } },
      { actionCode: "sales_task_list.trial", label: "邀约试听", type: "open_modal", apiCode: "trial_lesson_list.create", modalTitle: "邀约试听", fields: trialLessonCreateFields, defaultValues: { course_hour: 1 }, mapRowToValue: { student_id: "student_id", sales_user_id: "owner_user_id" } },
      { actionCode: "sales_task_list.enroll", label: "转报名", type: "open_modal", apiCode: "contract_list.create", modalTitle: "新生报名", fields: contractCreateFields, defaultValues: { contract_type: "NEW_SIGN", sign_time: "$now" }, mapRowToValue: { student_ids: "student_id" }, modalSize: "fullscreen" },
      { actionCode: "sales_task_list.edit", label: "编辑", type: "open_modal" }
    ];
    baseDsl.presentation.table.primaryRowActions = ["sales_task_list.detail", "sales_task_list.complete", "sales_task_list.followup", "sales_task_list.trial", "sales_task_list.enroll", "sales_task_list.edit"];
  }

  if (page.page === "recruit_channel_cost_list") {
    baseDsl.table.rowActions = [
      { actionCode: "recruit_channel_cost_list.detail", label: "详情", type: "open_modal" },
      { actionCode: "recruit_channel_cost_list.channel", label: "查看渠道", type: "open_page", target: { pageCode: "recruit_channel_list", title: "招生渠道", filterField: "id", rowField: "channel_id" } },
      { actionCode: "recruit_channel_cost_list.leads", label: "查看线索", type: "open_page", target: { pageCode: "lead_stage_list", title: "招生漏斗", filterField: "channel_id", rowField: "channel_id" } },
      { actionCode: "recruit_channel_cost_list.edit", label: "编辑", type: "open_modal" }
    ];
    baseDsl.presentation.table.primaryRowActions = ["recruit_channel_cost_list.detail", "recruit_channel_cost_list.channel", "recruit_channel_cost_list.leads", "recruit_channel_cost_list.edit"];
  }

  if (page.page === "sales_target_list") {
    baseDsl.table.rowActions = [
      { actionCode: "sales_target_list.detail", label: "详情", type: "open_modal" },
      { actionCode: "sales_target_list.leads", label: "顾问线索", type: "open_page", target: { pageCode: "lead_stage_list", title: "招生漏斗", filterField: "owner_user_id", rowField: "owner_user_id" } },
      { actionCode: "sales_target_list.trials", label: "顾问试听", type: "open_page", target: { pageCode: "trial_lesson_list", title: "试听邀约", filterField: "sales_user_id", rowField: "owner_user_id" } },
      { actionCode: "sales_target_list.tasks", label: "销售任务", type: "open_page", target: { pageCode: "sales_task_list", title: "销售任务", filterField: "owner_user_id", rowField: "owner_user_id" } },
      { actionCode: "sales_target_list.edit", label: "编辑", type: "open_modal" }
    ];
    baseDsl.presentation.table.primaryRowActions = ["sales_target_list.detail", "sales_target_list.leads", "sales_target_list.trials", "sales_target_list.tasks", "sales_target_list.edit"];
  }

  if (page.page === "lead_assignment_history_list") {
    baseDsl.table.rowActions = [
      { actionCode: "lead_assignment_history_list.detail", label: "详情", type: "open_modal" },
      { actionCode: "lead_assignment_history_list.lead", label: "查看意向", type: "open_page", target: { pageCode: "lead_stage_list", title: "招生漏斗", filterField: "student_id", rowField: "student_id" } },
      { actionCode: "lead_assignment_history_list.student", label: "查看学员", type: "open_page", target: { pageCode: "student_list", title: "学员列表", filterField: "id", rowField: "student_id" } }
    ];
    baseDsl.presentation.table.primaryRowActions = ["lead_assignment_history_list.detail", "lead_assignment_history_list.lead", "lead_assignment_history_list.student"];
  }

  if (standardImportPageCodes.has(page.page)) {
    const importAction = {
      actionCode: `${page.page}.import`,
      label: "导入",
      type: "import",
      actionType: "import",
      variant: "default",
      importConfig: { importCode: `${page.page}.import`, apiCode: `${page.page}.create` }
    };
    const toolbar = Array.isArray(baseDsl.toolbar) ? baseDsl.toolbar : [];
    if (!toolbar.some((action: Record<string, unknown>) => action.actionCode === importAction.actionCode)) {
      const refreshIndex = toolbar.findIndex((action: Record<string, unknown>) => action.actionCode === `${page.page}.refresh`);
      baseDsl.toolbar = refreshIndex >= 0
        ? [...toolbar.slice(0, refreshIndex), importAction, ...toolbar.slice(refreshIndex)]
        : [...toolbar, importAction];
    }
  }

  if (page.page === "frontdesk_home") {
    return {
      ...baseDsl,
      title: "运营首页",
      subtitle: "今日教务、招生、财务和学员状态总览",
      layout: "dashboard",
      presentation: {
        ...baseDsl.presentation,
        header: {
          subtitle: "今日教务、招生、财务和学员状态总览",
          metrics: [
            {
              label: "今日新增学员",
              source: "todayCountBy",
              field: "student_status",
              value: "FORMAL",
              dateField: "created_at",
              target: { pageCode: "student_list", title: "学员列表", filters: { student_status: "FORMAL" } }
            },
            {
              label: "今日新生报名",
              source: "todayCountBy",
              field: "student_status",
              value: "LEAD",
              dateField: "created_at",
              target: { pageCode: "lead_list", title: "新生报名" }
            },
            { label: "学员总数", source: "total", target: { pageCode: "student_list", title: "学员列表" } }
          ]
        },
        dashboard: {
          quickActions: [
            { label: "学员列表", pageCode: "student_list", moduleCode: "student", icon: "🎓", description: "查看正式学员档案" },
            { label: "排课列表", pageCode: "course_list", moduleCode: "education", icon: "📅", description: "处理课程安排" },
            { label: "周课表", pageCode: "course_week_schedule", moduleCode: "education", icon: "🗓️", description: "查看本周课表" },
            { label: "合同列表", pageCode: "contract_list", moduleCode: "finance", icon: "📄", description: "管理报名合同" },
            { label: "收款记录", pageCode: "funds_history", moduleCode: "finance", icon: "💳", description: "核对校区收款" }
          ],
          rightRail: {
            title: "校区动态",
            sections: [
              {
                title: "校区公告",
                dataSource: {
                  pageCode: "notice_list",
                  apiCode: "notice_list.query",
                  limit: 3,
                  filters: { status: "PUBLISHED" },
                  tag: "通知公告",
                  textField: "title",
                  metaField: "created_at",
                  target: { pageCode: "notice_list", title: "通知公告", filterField: "id", rowField: "id" }
                },
                items: [
                  { tag: "通知公告", text: "暂无公告", meta: "-" }
                ]
              },
              {
                title: "待办提醒",
                dataSource: {
                  pageCode: "student_followup_list",
                  apiCode: "student_followup_list.query",
                  limit: 5,
                  tag: "跟进",
                  textField: "follow_content",
                  metaField: "next_follow_time",
                  target: { pageCode: "student_followup_list", title: "跟进记录", filterField: "id", rowField: "id" }
                },
                items: [
                  { tag: "跟进", text: "暂无待办", meta: "-" }
                ]
              }
            ]
          },
          panels: [
            {
              title: "最近学员",
              description: "用于前台快速检索和进入学员档案",
              apiCode: "frontdesk_home.query",
              limit: 6,
              columns: [
                { key: "name", title: "学员", width: 180 },
                { key: "contact", title: "电话", width: 150 },
                { key: "student_status", title: "状态", width: 100, align: "center", badge: true },
                { key: "school_name", title: "学校", width: 180 }
              ]
            }
          ]
        }
      }
    };
  }

  return enhanceDictionaryFields(baseDsl);
}

export function apiDsl(page: (typeof pages)[number] | (typeof adminPages)[number], apiType: "query" | "detail" | "create" | "update" | "delete") {
  const joinAliases = new Set(
    (page.joins ?? []).flatMap((join) =>
      ((join as { fields?: Array<{ as: string }> }).fields ?? []).map((field) => field.as)
    )
  );
  const command = apiType === "create" ? page.commands?.create : undefined;
  if (page.page === "student_ele_account_record" && apiType !== "query" && apiType !== "detail") {
    return {
      operation: "command",
      command: "ledger.denyMutation"
    };
  }
  if (page.page === "role_list" && (apiType === "create" || apiType === "update")) {
    return {
      operation: "command",
      command: "role.permission.save"
    };
  }
  if (command) {
    return {
      operation: "command",
      command: command.command,
      ruleCode: command.ruleCode
    };
  }
  if (page.page === "contract_list" && apiType === "update") {
    return {
      operation: "command",
      command: "contract.update",
      ruleCode: "contract_create_rule"
    };
  }
  if (page.page === "contract_list" && apiType === "delete") {
    return {
      operation: "command",
      command: "contract.delete",
      ruleCode: "contract_create_rule"
    };
  }
  if (page.page === "funds_history" && apiType === "delete") {
    return {
      operation: "command",
      command: "funds.delete",
      ruleCode: "funds_create_rule"
    };
  }
  if (page.page === "student_list" && apiType === "delete") {
    return {
      operation: "command",
      command: "student.delete"
    };
  }
  if (page.page === "leave_record" && apiType === "delete") {
    return {
      operation: "command",
      command: "leave.delete",
      ruleCode: "leave_create_rule"
    };
  }
  if (page.page === "refund_record" && apiType === "delete") {
    return {
      operation: "command",
      command: "refund.delete",
      ruleCode: "refund_create_rule"
    };
  }
  if (page.page === "course_list" && apiType === "delete") {
    return {
      operation: "command",
      command: "course.delete",
      ruleCode: "course_delete_rule"
    };
  }
  const hasOrganizationScope = page.table === "organization" || page.fields.some((field) => field.key === "organization_id");
  return {
    table: page.table,
    schema: page.apiSchema,
    joins: page.joins ?? [],
    operation: apiType,
    softDelete: page.softDelete ?? true,
    allowedFields: page.fields.filter((field) => !joinAliases.has(field.key)).map((field) => field.key),
    filters: apiFiltersFor(page),
    fixedFilters: page.page === "tenant_version_list"
      ? [...(page.fixedFilters ?? []), { field: "target_type", op: "eq", value: "bundle" }]
      : page.fixedFilters ?? [],
    sort: page.sort ?? "created_at desc",
    pagination: true,
    ...(hasOrganizationScope ? { security: { dataPermission: "organization_or_sub" } } : {})
  };
}

export const businessRules = [
  {
    rule_code: "contract_create_rule",
    rule_name: "签合同基础规则",
    rule_json: {
      category: "promotion_allocation",
      businessType: "contract_create",
      promotionAllocation: "byCpAmountRatio",
      splitBy: "contract_product",
      requireAtLeastOneProduct: true,
      snapshotPromotion: true,
      allowManualAdjust: false,
      generateLogTable: "promotion_arrange_log"
    }
  },
  {
    rule_code: "funds_create_rule",
    rule_name: "收款资金分配规则",
    rule_json: {
      category: "funds_allocation",
      categories: ["funds_allocation", "promotion_allocation", "performance_allocation"],
      businessType: "funds_create",
      fundsAllocation: "byCpRemainingAmount",
      splitBy: "contract_product",
      updateContractPaidStatus: true,
      allowPreStoreWithoutContract: true,
      allowManualAdjust: false,
      generateLogTable: "money_arrange_log",
      promotionAllocation: "byCpAmountRatio",
      performanceAllocation: "byCpPaidRatio",
      organizationPerformanceOwner: "contractOrganization",
      personalPerformanceOwner: "signStaff",
      productPriority: "none",
      includePromotionAmount: false,
      includeRefundDeduction: true,
      voidGeneratesPerformanceReverse: true,
      validations: [
        { field: "transaction_amount", operator: ">", value: 0, message: "收款金额必须大于 0" }
      ]
    }
  },
  {
    rule_code: "performance_adjust_rule",
    rule_name: "业绩后置调整规则",
    rule_json: {
      category: "performance_allocation",
      businessType: "performance_adjust",
      allowManualAdjust: true,
      supportOrganizationAdjustment: true,
      supportPersonalOwnerAdjustment: true,
      supportMultiSplit: true
    }
  },
  {
    rule_code: "contract_update_rule",
    rule_name: "编辑合同重算规则",
    rule_json: {
      category: "promotion_allocation",
      categories: ["promotion_allocation", "funds_allocation", "performance_allocation"],
      businessType: "contract_update",
      promotionAllocation: "byCpAmountRatio",
      fundsAllocation: "byCpRemainingAmount",
      performanceAllocation: "byCpPaidRatio",
      splitBy: "contract_product",
      recalculateAfterPaid: true,
      recalculatePromotionArrange: true,
      recalculateMoneyArrange: true,
      recalculatePerformanceArrange: true
    }
  },
  {
    rule_code: "course_create_rule",
    rule_name: "排课冲突规则",
    rule_json: {
      category: "validation",
      businessType: "course_create",
      preventTeacherTimeConflict: true,
      preventStudentTimeConflict: true,
      preventInvalidTimeRange: true,
      preventHolidayScheduling: true,
      contractProductMatch: {
        requireRemainingRealHour: true,
        matchBy: ["product_id", "grade", "subject"],
        sortBy: "recent_charge_desc_then_sign_time_desc"
      },
      removeAttendedStudentPolicy: "block_attended",
      removeStudentPolicyOptions: ["block_attended", "cancel_attendance_and_charges", "delete_uncharged_course_students"],
      targetApi: "course_list.create",
      validations: [
        { field: "end_time", operator: ">", valueField: "start_time", message: "结束时间必须晚于开始时间" },
        { field: "teacher_id", operator: "no_time_overlap", valueField: "teacher_course_date,start_time,end_time", message: "同一老师同一天同一时间段不能重复排课" },
        { field: "student_id", operator: "no_time_overlap", valueField: "student_course_date,start_time,end_time", message: "同一学员同一天同一时间段不能重复排课" }
      ]
    }
  },
  {
    rule_code: "charge_create_rule",
    rule_name: "考勤扣费规则",
    rule_json: {
      category: "charge",
      businessType: "charge",
      defaultChargeType: "NORMAL",
      entranceChargeTypes: { attendance: "NORMAL", manualPromotion: "PROMOTION", giftHour: "PROMOTION_HOUR" },
      giftHourChargeAmount: 0,
      allowNegativeBalance: false,
      updateContractProductBalance: true,
      autoCalculateChargeAmount: true,
      requireCancelReason: true,
      recordCancelOperator: true,
      cancelAttendanceOnChargeReverse: true,
      rollbackContractProductBalanceOnReverse: true,
      validations: [
        { field: "charge_amount", operator: ">", value: 0, message: "扣费金额必须大于 0" }
      ]
    }
  },
  {
    rule_code: "refund_create_rule",
    rule_name: "退费规则",
    rule_json: {
      category: "refund",
      businessType: "refund_create",
      categories: ["refund"],
      refundAllocation: "byCpRemainingAmount",
      allowRefundOverBalance: false,
      updateContractProductBalance: true,
      updateContractPaidStatus: true,
      refundTypes: ["CONTRACT_PRODUCT"],
      generateNegativePerformance: true,
      validations: [
        { field: "refund_real_amount", operator: ">", value: 0, message: "退费金额必须大于 0" }
      ]
    }
  },
  {
    rule_code: "contract_refund_rule",
    rule_name: "合同退费规则",
    rule_json: {
      category: "refund",
      businessType: "contract_refund",
      refundAllocation: "originalPaymentReverse",
      allowRefundOverBalance: false,
      autoRefundToEleAccount: false,
      updateContractProductBalance: true,
      updateContractPaidStatus: true,
      refundTypes: ["CONTRACT"],
      generateNegativePerformance: true
    }
  },
  {
    rule_code: "leave_create_rule",
    rule_name: "请假处理规则",
    rule_json: {
      category: "attendance",
      businessType: "leave",
      approvedLeaveUpdatesAttendance: true,
      leaveCharge: false
    }
  },
  {
    rule_code: "makeup_create_rule",
    rule_name: "补课安排规则",
    rule_json: {
      category: "validation",
      businessType: "makeup",
      preventTeacherTimeConflict: true,
      preventStudentTimeConflict: true,
      preventHolidayScheduling: true,
      contractProductMatch: { requireRemainingRealHour: true, matchBy: ["product_id", "grade", "subject"], sortBy: "recent_charge_desc_then_sign_time_desc" }
    }
  },
  {
    rule_code: "attendance_check_in_rule",
    rule_name: "考勤签到规则",
    rule_json: {
      category: "attendance",
      businessType: "attendance",
      requireCheckInBeforeCharge: true,
      deductCourseHourOnAttendance: false,
      hourDeductionPriority: "promotion_first",
      autoCalculateChargeAmount: true,
      absentCharge: true,
      leaveCharge: false,
      autoFinishCourseWhenAllHandled: true,
      chargeRounding: "floor_2",
      finalHourChargeUsesRemainingAmount: true,
      allowAfterFinished: true
    }
  },
  {
    rule_code: "course_time_validation_rule",
    rule_name: "排课时间校验规则",
    rule_json: {
      category: "validation",
      businessType: "course_create",
      targetApi: "course_list.create",
      validations: [
        { field: "end_time", operator: ">", valueField: "start_time", message: "结束时间必须晚于开始时间" },
        { field: "teacher_id", operator: "no_time_overlap", valueField: "teacher_course_date,start_time,end_time", message: "同一老师同一天同一时间段不能重复排课" },
        { field: "student_id", operator: "no_time_overlap", valueField: "student_course_date,start_time,end_time", message: "同一学员同一天同一时间段不能重复排课" }
      ],
      preventTeacherTimeConflict: true,
      preventStudentTimeConflict: true,
      preventInvalidTimeRange: true
    }
  },
  {
    rule_code: "money_allocation_rule",
    rule_name: "资金分配通用规则",
    rule_json: {
      category: "funds_allocation",
      businessType: "funds_create",
      fundsAllocation: "byCpRemainingAmount",
      splitBy: "contract_product",
      allowManualAdjust: false,
      generateLogTable: "money_arrange_log",
      voidGeneratesPerformanceReverse: true,
      validations: [
        { field: "transaction_amount", operator: ">", value: 0, message: "收款金额必须大于 0" }
      ]
    }
  },
  {
    rule_code: "promotion_allocation_rule",
    rule_name: "收款优惠分配规则",
    rule_json: {
      category: "promotion_allocation",
      businessType: "funds_create",
      promotionAllocation: "byCpAmountRatio",
      splitBy: "contract_product",
      snapshotPromotion: true,
      allowManualAdjust: false,
      generateLogTable: "promotion_arrange_log"
    }
  },
  {
    rule_code: "performance_allocation_rule",
    rule_name: "收款业绩分配规则",
    rule_json: {
      category: "performance_allocation",
      businessType: "funds_create",
      performanceAllocation: "byCpPaidRatio",
      organizationPerformanceOwner: "contractOrganization",
      personalPerformanceOwner: "signStaff",
      productPriority: "none",
      includePromotionAmount: false,
      includeRefundDeduction: true,
      allowManualAdjust: false,
      generateLogTable: "performance_arrange_log"
    }
  },
  {
    rule_code: "performance_one_to_one_priority_rule",
    rule_name: "一对一业绩优先规则",
    rule_json: {
      category: "performance_allocation",
      businessType: "performance",
      performanceAllocation: "oneToOneFirst",
      organizationPerformanceOwner: "contractOrganization",
      personalPerformanceOwner: "signStaff",
      productPriority: "oneToOneFirst",
      oneToOneWeight: 100,
      classCourseWeight: 0,
      includePromotionAmount: false,
      includeRefundDeduction: true,
      generateLogTable: "performance_arrange_log"
    }
  },
  {
    rule_code: "performance_class_course_priority_rule",
    rule_name: "班课业绩优先规则",
    rule_json: {
      category: "performance_allocation",
      businessType: "performance",
      performanceAllocation: "classCourseFirst",
      organizationPerformanceOwner: "contractOrganization",
      personalPerformanceOwner: "signStaff",
      productPriority: "classCourseFirst",
      oneToOneWeight: 0,
      classCourseWeight: 100,
      includePromotionAmount: false,
      includeRefundDeduction: true,
      generateLogTable: "performance_arrange_log"
    }
  },
  {
    rule_code: "prestore_funds_rule",
    rule_name: "预存款入账规则",
    rule_json: {
      category: "funds_allocation",
      businessType: "funds_create",
      fundsAllocation: "manual",
      splitBy: "contract",
      allowPreStoreWithoutContract: true,
      updateContractPaidStatus: false,
      allowManualAdjust: false,
      validations: [
        { field: "transaction_amount", operator: ">", value: 0, message: "预存金额必须大于 0" }
      ]
    }
  },
  {
    rule_code: "funds_delete_rule",
    rule_name: "删除收款回滚规则",
    rule_json: {
      category: "funds_allocation",
      categories: ["funds_allocation", "performance_allocation", "promotion_allocation"],
      businessType: "funds_delete",
      fundsAllocation: "byCpRemainingAmount",
      reverseMoneyArrangeOnDelete: true,
      reversePerformanceOnDelete: true,
      reversePromotionArrangeOnDelete: true,
      updateContractPaidStatus: true,
      requireDeleteReason: true,
      generateLogTable: "money_arrange_log"
    }
  },
  {
    rule_code: "refund_delete_rule",
    rule_name: "删除退费回滚规则",
    rule_json: {
      category: "refund",
      categories: ["refund"],
      businessType: "refund_delete",
      refundAllocation: "originalPaymentReverse",
      restoreContractProductBalance: true,
      updateContractPaidStatus: true,
      requireDeleteReason: true
    }
  },
  {
    rule_code: "course_delete_rule",
    rule_name: "删除排课回滚规则",
    rule_json: {
      category: "charge",
      categories: ["charge", "attendance"],
      businessType: "course_delete",
      reverseChargesOnDelete: true,
      resetAttendanceOnDelete: true,
      restoreContractProductBalance: true,
      requireDeleteReason: true
    }
  }

];

export const printTemplates = [
  {
    template_code: "contract_receipt_print",
    template_name: "合同收据打印模板",
    dsl_json: {
      resourceType: "print_template",
      templateCode: "contract_receipt_print",
      templateName: "合同收据打印模板",
      pageCode: "contract_list",
      moduleCode: "finance",
      paperSize: "A4",
      orientation: "portrait",
      fields: ["student_id", "contract_no", "transaction_amount", "pay_way_config_id", "transaction_time", "organization_id"],
      layout: {
        sections: [
          { title: "收据信息", fields: ["student_id", "contract_no", "transaction_amount", "pay_way_config_id", "transaction_time", "organization_id"] },
          { title: "签字确认", fields: ["operator_signature", "customer_signature"] }
        ]
      }
    }
  }
];

export const approvalFlows = [
  {
    flow_code: "contract_discount_approval",
    flow_name: "合同优惠审批",
    module_code: "finance",
    status: "INACTIVE",
    config_json: {
      resourceType: "approval_flow",
      flowCode: "contract_discount_approval",
      flowName: "合同优惠审批",
      moduleCode: "finance",
      businessType: "contract_create",
      trigger: { event: "contract_discount_submit", pageCode: "contract_list" },
      steps: [
        { stepCode: "sales_submit", stepName: "销售提交", assigneeRole: "SALES" },
        { stepCode: "principal_review", stepName: "校长审批", assigneeRole: "PRINCIPAL" }
      ],
      afterApproved: [{ type: "enable_action", actionCode: "contract_list.funds" }]
    }
  },
  {
    flow_code: "lead_enroll_approval",
    flow_name: "新生报名审批",
    module_code: "recruit",
    status: "INACTIVE",
    config_json: {
      resourceType: "approval_flow",
      flowCode: "lead_enroll_approval",
      flowName: "新生报名审批",
      moduleCode: "recruit",
      businessType: "contract_create",
      trigger: { event: "lead_enroll_submit", pageCode: "lead_list" },
      steps: [
        { stepCode: "sales_submit", stepName: "顾问提交", assigneeRole: "SALES" },
        { stepCode: "principal_review", stepName: "校长审批", assigneeRole: "PRINCIPAL" }
      ],
      afterApproved: [{ type: "enable_action", actionCode: "lead_list.enroll" }]
    }
  },
  {
    flow_code: "contract_create_approval",
    flow_name: "合同创建审批",
    module_code: "finance",
    status: "INACTIVE",
    config_json: {
      resourceType: "approval_flow",
      flowCode: "contract_create_approval",
      flowName: "合同创建审批",
      moduleCode: "finance",
      businessType: "contract_create",
      trigger: { event: "contract_create_submit", pageCode: "contract_list" },
      steps: [
        { stepCode: "sales_submit", stepName: "顾问提交", assigneeRole: "SALES" },
        { stepCode: "finance_review", stepName: "财务复核", assigneeRole: "PRINCIPAL" }
      ],
      afterApproved: [{ type: "enable_action", actionCode: "contract_list.funds" }]
    }
  },
  {
    flow_code: "contract_update_approval",
    flow_name: "合同修改审批",
    module_code: "finance",
    status: "INACTIVE",
    config_json: {
      resourceType: "approval_flow",
      flowCode: "contract_update_approval",
      flowName: "合同修改审批",
      moduleCode: "finance",
      businessType: "contract_update",
      trigger: { event: "contract_update_submit", pageCode: "contract_list" },
      steps: [
        { stepCode: "sales_submit", stepName: "销售提交", assigneeRole: "SALES" },
        { stepCode: "principal_review", stepName: "校长审批", assigneeRole: "PRINCIPAL" }
      ],
      afterApproved: [{ type: "execute_original_command" }]
    }
  },
  {
    flow_code: "funds_create_approval",
    flow_name: "收款审批",
    module_code: "finance",
    status: "INACTIVE",
    config_json: {
      resourceType: "approval_flow",
      flowCode: "funds_create_approval",
      flowName: "收款审批",
      moduleCode: "finance",
      businessType: "funds_create",
      trigger: { event: "funds_create_submit", pageCode: "funds_history" },
      steps: [
        { stepCode: "cashier_submit", stepName: "经办提交", assigneeRole: "SALES" },
        { stepCode: "finance_review", stepName: "财务复核", assigneeRole: "PRINCIPAL" }
      ],
      afterApproved: [{ type: "enable_action", actionCode: "funds_history.create" }]
    }
  },
  {
    flow_code: "refund_create_approval",
    flow_name: "退费审批",
    module_code: "finance",
    status: "INACTIVE",
    config_json: {
      resourceType: "approval_flow",
      flowCode: "refund_create_approval",
      flowName: "退费审批",
      moduleCode: "finance",
      businessType: "refund_create",
      trigger: { event: "refund_create_submit", pageCode: "refund_record" },
      steps: [
        { stepCode: "operator_submit", stepName: "经办提交", assigneeRole: "STUDY_MANAGER" },
        { stepCode: "principal_review", stepName: "校长审批", assigneeRole: "PRINCIPAL" }
      ],
      afterApproved: [{ type: "enable_action", actionCode: "refund_record.create" }]
    }
  },
  {
    flow_code: "course_create_approval",
    flow_name: "排课审批",
    module_code: "education",
    status: "INACTIVE",
    config_json: {
      resourceType: "approval_flow",
      flowCode: "course_create_approval",
      flowName: "排课审批",
      moduleCode: "education",
      businessType: "course_create",
      trigger: { event: "course_create_submit", pageCode: "course_list" },
      steps: [
        { stepCode: "teacher_submit", stepName: "老师提交", assigneeRole: "TEACHER" },
        { stepCode: "manager_review", stepName: "学管复核", assigneeRole: "STUDY_MANAGER" }
      ],
      afterApproved: [{ type: "enable_action", actionCode: "course_list.create" }]
    }
  },
  {
    flow_code: "course_delete_approval",
    flow_name: "删除排课审批",
    module_code: "education",
    status: "INACTIVE",
    config_json: {
      resourceType: "approval_flow",
      flowCode: "course_delete_approval",
      flowName: "删除排课审批",
      moduleCode: "education",
      businessType: "course_delete",
      trigger: { event: "course_delete_submit", pageCode: "course_list" },
      steps: [
        { stepCode: "teacher_submit", stepName: "老师提交", assigneeRole: "TEACHER" },
        { stepCode: "principal_review", stepName: "校长审批", assigneeRole: "PRINCIPAL" }
      ],
      afterApproved: [{ type: "enable_action", actionCode: "course_list.delete" }]
    }
  },
  {
    flow_code: "charge_reverse_approval",
    flow_name: "取消扣费审批",
    module_code: "education",
    status: "INACTIVE",
    config_json: {
      resourceType: "approval_flow",
      flowCode: "charge_reverse_approval",
      flowName: "取消扣费审批",
      moduleCode: "education",
      businessType: "charge_reverse",
      trigger: { event: "charge_reverse_submit", pageCode: "charge_record" },
      steps: [
        { stepCode: "operator_submit", stepName: "经办提交", assigneeRole: "STUDY_MANAGER" },
        { stepCode: "principal_review", stepName: "校长审批", assigneeRole: "PRINCIPAL" }
      ],
      afterApproved: [{ type: "enable_action", actionCode: "charge_record.reverse" }]
    }
  },
  {
    flow_code: "product_price_approval",
    flow_name: "产品价格审批",
    module_code: "finance",
    status: "INACTIVE",
    config_json: {
      resourceType: "approval_flow",
      flowCode: "product_price_approval",
      flowName: "产品价格审批",
      moduleCode: "finance",
      businessType: "product_price",
      trigger: { event: "product_price_change_submit", pageCode: "product_list" },
      steps: [
        { stepCode: "operator_submit", stepName: "经办提交", assigneeRole: "PRINCIPAL" },
        { stepCode: "principal_review", stepName: "负责人审批", assigneeRole: "PRINCIPAL" }
      ],
      afterApproved: [{ type: "enable_action", actionCode: "product_list.edit" }]
    }
  }
];

export const passwordHash = bcrypt.hashSync("123456", 10);
export const adminPasswordHash = bcrypt.hashSync("admin123", 10);

export function maskApiKey(value: string) {
  if (!value) return "";
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

export const llmSeed = {
  id: "llm_default",
  config_code: "default_llm",
  schema_name: null,
  base_url: env.llm.baseUrl,
  api_key: env.llm.apiKey ?? "",
  model: env.llm.model,
  provider: "openai-compatible",
  max_context_tokens: 256000,
  source_env_keys: ["LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL"]
};

export const skillContentMap: Record<string, string> = {
  frontdesk_home: "# 运营首页\n\n## 功能描述\n汇总今日待办、学员检索和关键运营入口，提供仪表盘视图展示学员总数、新生报名等核心指标。\n\n## 使用说明\n- 顶部指标卡片可点击跳转至对应页面\n- 右侧边栏展示校区公告和待办提醒\n- 中间面板展示最近学员列表\n\n## 注意事项\n- 指标数据实时查询，数据量大时可能较慢\n- 新增可查询、筛选、排序、统计字段时必须基于真实表结构生成变更",
  lead_list: "# 新生报名\n\n## 功能描述\n按报名流程完成意向学员信息、跟进、试听邀约、报读课程和结算，支持从意向学员转化为正式学员。\n\n## 使用说明\n- 点击「新增意向学员」创建 student_status=LEAD 的意向学员，并自动生成招生阶段\n- 行操作「跟进」会写入跟进记录并同步招生阶段\n- 行操作「邀约试听」会生成试听课次并同步阶段为已邀约试听\n- 行操作「新增合同」完成报名转化\n\n## 注意事项\n- 意向学员与正式学员统一使用学员档案，使用 student_status 区分\n- 合同创建后自动关联优惠分配规则",
  student_list: "# 学员列表\n\n## 功能描述\n统一维护学员档案、校区归属、学校年级和跟进入口，支持预存操作。\n\n## 使用说明\n- 支持按姓名、电话、状态、学校筛选\n- 行操作支持详情、编辑、预存、删除\n- 预存操作直接为学员充值电子账户\n\n## 注意事项\n- 正式学员和意向学员使用同一学员档案，通过状态区分\n- 删除操作为软删除",
  student_followup_list: "# 学员跟进记录\n\n## 功能描述\n记录意向学员和正式学员的沟通历史，包括电话、到访、微信等多种跟进方式；招生阶段页只保存当前漏斗状态，跟进记录保存每次沟通明细。\n\n## 使用说明\n- 意向学员和正式学员统一使用 student 数据，student_status=LEAD 表示意向学员\n- 跟进记录通过 student_id 关联学员，并通过 lead_stage_id 关联当时的招生阶段\n- 新增跟进时会按跟进结果同步更新当前招生阶段，并可自动生成下次跟进任务\n\n## 注意事项\n- 跟进记录不可删除，仅可新增",
  leave_record: "# 请假管理\n\n## 功能描述\n记录学员请假，审批通过后可自动把课程学员考勤状态标记为请假。",
  makeup_course_record: "# 补课管理\n\n## 功能描述\n为缺勤、请假或临时调整的学员安排补课，并自动生成对应补课排课。",
  course_holiday_calendar: "# 停课日历\n\n## 功能描述\n维护校区停课日；开启禁止排课后，排课会按规则拦截停课日期。",
  course_week_schedule: "# 周课表\n\n## 功能描述\n按日期和时间查看一周课程安排，适合前台、教务和老师快速核对课表。",
  course_list: "# 排课列表\n\n## 功能描述\n查看课程安排、上课时间和课程状态，支持一对一、小班、一对N等多种课程类型。\n\n## 使用说明\n- 点击「新增排课」创建课程\n- 支持按课程名称和状态筛选\n- 课程状态包括待上课、已完成、已取消\n\n## 注意事项\n- 排课冲突规则会阻止老师时间冲突\n- 已取消课程不可扣费",
  charge_record: "# 扣费记录\n\n## 功能描述\n管理学员上课扣费，支持实收扣费、优惠扣费和赠课扣费。\n\n## 使用说明\n- 点击「新增扣费」选择课程和合同产品\n- 支持取消扣费操作\n- 扣费自动更新合同产品余额\n\n## 注意事项\n- 余额不足时扣费会被拒绝\n- 取消扣费会恢复合同产品余额",
  contract_list: "# 合同列表\n\n## 功能描述\n跟踪合同状态、应收实收和付款进度，支持合同收款操作。\n\n## 使用说明\n- 点击「新增合同」创建合同\n- 行操作支持收款、详情、编辑\n- 合同自动关联优惠分配\n\n## 注意事项\n- 收款后自动触发资金分配规则\n- 付款状态根据实收金额自动更新",
  contract_product_list: "# 合同产品\n\n## 功能描述\n查看合同关联的产品信息，包括剩余课时、剩余金额等。\n\n## 使用说明\n- 按合同维度查看产品列表\n- 显示实时剩余课时和金额\n- 合同产品为只读信息，不支持在列表中直接编辑或删除\n- 如需变更合同产品，请回到合同报名、合同调整或退费等业务流程处理\n\n## 注意事项\n- 剩余数据由扣费和退费操作自动维护\n- 退费应通过合同产品退费或合同退费流程发起，避免手工修改余额",
  funds_history: "# 收款记录\n\n## 功能描述\n核对收款流水、支付方式和交易时间，支持合同收款和预存两种类型。\n\n## 使用说明\n- 点击「新增收款」录入收款\n- 支持现金、微信、支付宝、电子账户等支付方式\n\n## 注意事项\n- 收款后自动触发资金分配规则\n- 预存类型不需要关联合同",
  refund_record: "# 退费记录\n\n## 功能描述\n管理学员退费，支持退课时、退金额、退优惠等操作。\n\n## 使用说明\n- 点击「新增退费」选择学员和合同产品\n- 填写退费金额和退费方式\n\n## 注意事项\n- 退费金额不能超过合同产品余额\n- 退费后自动更新合同产品余额和付款状态",
  product_list: "# 产品列表\n\n## 功能描述\n维护课程产品、课时、单价和启用状态。\n\n## 使用说明\n- 点击「新增产品」创建课程产品\n- 支持一对一、小班、一对N等产品类型\n\n## 注意事项\n- 已关联合同的产品不可删除\n- 产品价格变更不影响已有合同",
  promotion_list: "# 优惠方案\n\n## 功能描述\n维护优惠方案，支持立减和折扣两种类型。\n\n## 使用说明\n- 点击「新增优惠」创建优惠方案\n- 立减类型填写减免金额\n- 折扣类型填写折扣值（如9表示9折）\n\n## 注意事项\n- 优惠方案关联合同时会快照当前值\n- 后续修改优惠不影响已有合同",
  student_ele_account: "# 电子账户\n\n## 功能描述\n查看学员电子账户余额和冻结金额。\n\n## 使用说明\n- 按学员维度查看账户信息\n- 余额和冻结金额由系统自动维护\n\n## 注意事项\n- 冻结金额不可用于扣费",
  student_ele_account_record: "# 账户流水\n\n## 功能描述\n查看电子账户变动记录，包括预存入账、合同扣款、退费入账等。\n\n## 使用说明\n- 按学员维度查看流水\n- 显示变动类型、变动金额和变动后余额\n\n## 注意事项\n- 流水记录不可删除",
  notice_list: "# 通知公告\n\n## 功能描述\n发布和管理校区通知公告。\n\n## 使用说明\n- 新增公告并发布\n- 已发布公告在运营首页右侧边栏展示\n\n## 注意事项\n- 仅已发布公告对外可见",
  student_report: "# 学员报表\n\n## 功能描述\n学员统计报表，按校区和时间维度展示学员数据。\n\n## 使用说明\n- 支持按来源、状态等维度筛选\n- 数据来源于学员表实时查询\n\n## 注意事项\n- 报表数据量大时查询可能较慢",
  organization_list: "# 校区列表\n\n## 功能描述\n维护组织架构，支持总部和校区两级结构。\n\n## 使用说明\n- 新增校区并设置组织类型\n- 支持总部和分校两种类型\n\n## 注意事项\n- 校区关联网点和员工后不可删除",
  user_list: "# 员工列表\n\n## 功能描述\n管理员工信息，包括校长、老师、学管师、顾问等类型。\n\n## 使用说明\n- 点击「新增员工」创建员工\n- 支持编辑和重置密码\n\n## 注意事项\n- 员工密码使用 bcrypt 加密存储\n- 软删除后员工不可登录",
  role_list: "# 角色权限\n\n## 功能描述\n管理角色和权限配置，支持页面权限、按钮权限、数据权限和字段权限。\n\n## 使用说明\n- 点击「新增角色」创建角色\n- 编辑权限配置页面可见性和操作权限\n\n## 注意事项\n- 权限变更实时生效\n- 数据权限控制可见数据范围",
  pay_way_list: "# 支付方式\n\n## 功能描述\n维护支付方式配置，支持现金、微信、支付宝、电子账户等。\n\n## 使用说明\n- 新增支付方式并设置类型\n\n## 注意事项\n- 已关联流水的支付方式不可删除",
  tenant_manage: "# 租户管理\n\n## 功能描述\n管理平台租户，包括租户创建、模块开通和到期管理。\n\n## 使用说明\n- 新增租户并配置 Schema\n- 开通模块和功能\n- 设置学员、校区、员工数量限制\n\n## 注意事项\n- Schema 名称创建后不可修改\n- 到期租户自动禁用",
  dsl_version: "# DSL 版本\n\n## 功能描述\n查看 DSL 版本历史，支持发布、回滚和驳回操作。\n\n## 使用说明\n- 草稿版本可发布或驳回\n- 已归档版本可回滚\n- 回滚创建新版本，不修改历史记录\n\n## 注意事项\n- 同一 DSL 仅一个活跃版本\n- 版本操作需管理员权限",
  tenant_version_list: "# 版本管理\n\n## 功能描述\n租户侧查看 DSL 版本历史，支持回滚预览、发布和驳回操作。\n\n## 使用说明\n- 草稿版本可发布或驳回\n- 已归档版本可回滚或回滚预览\n- 回滚预览在测试环境中预览回滚效果\n- 回滚创建新版本并恢复DSL\n\n## 注意事项\n- 回滚预览需要先创建预览环境\n- 同一 DSL 仅一个活跃版本",
  today_course: "# 今日课程\n\n## 功能描述\n查看今日所有课程安排，支持日历视图展示。\n\n## 使用说明\n- 默认展示今日课程\n- 支持按日期和状态筛选\n- 点击课程查看详情\n\n## 注意事项\n- 日历视图按课程日期映射",
  student_handover: "# 学员交接表\n\n## 功能描述\n管理学员学管师变更和交接记录。\n\n## 使用说明\n- 选择学员后点击「分配学管师」\n- 支持批量分配\n\n## 注意事项\n- 分配后学员的学管师立即变更",
  student_visit: "# 学员到离校\n\n## 功能描述\n记录学员到校和离校时间，管理签到签退。\n\n## 使用说明\n- 按课程维度查看学员到离校记录\n- 支持签到和签退操作\n\n## 注意事项\n- 签到签退记录不可删除",
  student_detail: "# 学员详情\n\n## 功能描述\n查看学员完整档案信息，包括基本信息、合同信息和课程记录。\n\n## 使用说明\n- 展示学员基本信息、关联合同和课程\n- 支持从学员列表跳转\n\n## 注意事项\n- 详情页为只读视图",
  contract_detail: "# 合同详情\n\n## 功能描述\n查看合同完整信息和关联产品、收款记录。\n\n## 使用说明\n- 展示合同信息、合同产品和收款记录\n- 支持从合同列表跳转\n\n## 注意事项\n- 详情页为只读视图",
  course_detail: "# 课程详情\n\n## 功能描述\n查看课程完整信息和上课学员列表。\n\n## 使用说明\n- 展示课程信息和上课学员\n- 支持从排课列表跳转\n\n## 注意事项\n- 详情页为只读视图",
  money_arrange_list: "# 资金分配记录\n\n## 功能描述\n查看收款后自动生成的资金分配记录，记录每笔收款在各合同产品间的分配情况。\n\n## 使用说明\n- 收款后系统自动按比例分配资金到合同产品\n- 支持按校区筛选\n- 点击详情查看分配明细\n\n## 注意事项\n- 分配记录由系统自动生成，不可手动编辑\n- 分配规则遵循「最早合同优先」原则",
  promotion_arrange_list: "# 优惠分配记录\n\n## 功能描述\n查看收款后自动生成的优惠分配记录，记录每笔收款对应的优惠课时和金额分配。\n\n## 使用说明\n- 收款后系统自动按比例分配优惠到合同产品\n- 支持按校区筛选\n- 点击详情查看分配明细\n\n## 注意事项\n- 优惠分配与资金分配同步触发\n- 优惠分配基于合同产品关联的优惠快照",
  performance_arrange_list: "# 业绩分配记录\n\n## 功能描述\n查看收款后自动生成的业绩分配记录，包含校区业绩和个人业绩两部分。\n\n## 使用说明\n- 收款后系统自动分配校区业绩和个人业绩\n- 支持按业绩类型筛选\n- 点击详情查看分配明细\n\n## 注意事项\n- 校区业绩归属收款所在校区\n- 个人业绩归属合同签约人",
  finance_report: "# 财务报表\n\n## 功能描述\n按校区和流水类型维度展示财务数据汇总。\n\n## 使用说明\n- 支持按校区和流水类型筛选\n- 展示交易金额和交易时间\n\n## 注意事项\n- 报表数据来源于收款流水实时查询",
  course_report: "# 课程报表\n\n## 功能描述\n按校区、课程类型和状态维度展示课程数据汇总。\n\n## 使用说明\n- 支持按校区、课程类型和状态筛选\n- 展示课时和上课日期\n\n## 注意事项\n- 报表数据来源于课程表实时查询"
};
