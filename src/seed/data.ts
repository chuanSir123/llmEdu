import bcrypt from "bcryptjs";
import { env } from "../config/env.js";

export const modules = [
  ["frontdesk", "前台", "business", "快速入口、待办和检索", 10, "LayoutDashboard"],
  ["recruit", "招生", "business", "线索、跟进和转化", 20, "Megaphone"],
  ["student", "学员", "business", "学员档案和回访", 30, "GraduationCap"],
  ["education", "教务", "business", "排课、上课和扣费", 40, "CalendarDays"],
  ["finance", "财务", "business", "收款、分配和退费", 50, "Wallet"],
  ["oa", "OA", "business", "通知、审批和任务", 60, "Bell"],
  ["report", "报表", "business", "经营数据分析", 70, "BarChart3"],
  ["system", "系统", "business", "组织、角色和权限", 80, "Settings"],
  ["ai_agent", "AI 工程化", "platform", "自然语言变更任务", 90, "Bot"],
  ["ai_customization", "AI 定制", "business", "AI 定制化记录与对话", 85, "Sparkles"]
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

const statusMap = {
  student_status: { FORMAL: "green", LEAD: "blue", LOST: "gray" },
  paid_status: { PAID: "green", PART_PAID: "amber", UNPAID: "red", REFUNDED: "gray" },
  contract_status: { ACTIVE: "green", CLOSED: "gray", CANCELLED: "red", REFUNDED: "amber" },
  course_status: { SCHEDULED: "blue", FINISHED: "green", CANCELLED: "red" },
  charge_status: { CONFIRMED: "green", PENDING: "amber", REVERSED: "gray" },
  attendance_status: { PENDING: "amber", PRESENT: "green", ABSENT: "red", LEAVE: "gray" },
  status: { ACTIVE: "green", PUBLISHED: "blue", draft: "amber", active: "green", archived: "gray" },
  mode: { draft: "amber", publish_after_confirm: "blue" }
};

const valueLabels = {
  student_status: { FORMAL: "正式", LEAD: "线索", LOST: "流失" },
  paid_status: { PAID: "已付清", PART_PAID: "部分付款", UNPAID: "未付款", REFUNDED: "已退费" },
  contract_status: { ACTIVE: "生效中", CLOSED: "已结清", CANCELLED: "已取消", REFUNDED: "已退费" },
  course_status: { SCHEDULED: "待上课", FINISHED: "已完成", CANCELLED: "已取消" },
  charge_status: { CONFIRMED: "已确认", PENDING: "待确认", REVERSED: "已撤销" },
  status: { ACTIVE: "启用", PUBLISHED: "已发布", draft: "草稿", active: "生效", archived: "归档" },
  mode: { draft: "草稿", publish_after_confirm: "确认后发布" },
  staff_type: { MANAGER: "校长", TEACHER: "老师", STUDY_MANAGER: "学管师", SALES: "顾问" },
  funds_type: { CONTRACT_PAY: "合同收款", PRE_STORE: "预存" },
  source_type: { REFERRAL: "转介绍", WALK_IN: "到访", ONLINE: "线上" },
  course_type: { ONE_ON_ONE_COURSE: "一对一", SMALL_CLASS: "小班", ONE_ON_N_GROUP: "一对N" },
  product_type: { ONE_ON_ONE_COURSE: "一对一", SMALL_CLASS: "小班", ONE_ON_N_GROUP: "一对N" },
  contract_type: { ONE_ON_ONE_COURSE: "一对一", SMALL_CLASS: "小班", ONE_ON_N_GROUP: "一对N" },
  follow_type: { PHONE: "电话", VISIT: "到访", WECHAT: "微信" },
  charge_type: { NORMAL: "实收扣费", PROMOTION: "优惠扣费", PROMOTION_HOUR: "赠课扣费" },
  pay_way_type: { CASH: "现金", WECHAT: "微信", ALIPAY: "支付宝", ELE_ACCOUNT: "电子账户" },
  promotion_type: { REDUCE: "立减", DISCOUNT: "折扣" },
  change_type: { PRESTORE_IN: "预存入账", CONTRACT_PAY_OUT: "合同扣款", REFUND_IN: "退费入账", PRESTORE_DELETE: "删除预存", CONTRACT_PAY_DELETE: "删除合同扣款", REFUND_DELETE: "删除退费" },
  attendance_status: { PENDING: "待签到", PRESENT: "已签到", ABSENT: "缺勤", LEAVE: "请假" },
  refund_type: { CONTRACT_PRODUCT: "合同产品退费", CONTRACT: "合同退费" },
  target_type: { bundle: "整包配置", page: "页面", action: "按钮动作", api: "接口", modal: "弹窗", business_rule: "业务规则", print_template: "打印模板" },
  schema_scope: { tenant_default: "默认模板", tenant: "租户自定义", admin: "平台管理" },
  source_label: { "租户自定义": "租户自定义", "默认模板": "默认模板" }
};

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
const derivedArrangePages = new Set(["money_arrange_list", "promotion_arrange_list", "performance_arrange_list"]);
const readOnlyPages = new Set(["money_arrange_list", "promotion_arrange_list", "performance_arrange_list", "student_ele_account", "student_ele_account_record"]);
const standardImportPageCodes = new Set(["student_list", "contract_list", "funds_history", "course_list", "charge_record", "refund_record"]);

function fieldComponent(field: Field) {
  const base = isLongTextField(field)
    ? { type: "textarea", span: "full" as const, rows: 4 }
    : { type: field.type ?? "text" };
  const optionSource =
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
                    : undefined;
  return optionSource ? { ...base, optionSource } : base;
}

const contractCreateFields = [
  { key: "student_id", label: "选择学员", type: "text", optionSource: allStudentSelect, searchable: true },
  { key: "product_ids", label: "报读课程", type: "multiSelect", span: 2 as const, optionSource: { ...productSelect, includeRow: true }, searchable: true },
  { key: "promotion_id", label: "合同优惠", type: "text", optionSource: { ...promotionSelect, includeRow: true }, searchable: true },
  { key: "contract_type", label: "合同类型", type: "text" },
  { key: "organization_id", label: "校区", type: "text", optionSource: orgSelect, searchable: true },
  { key: "sign_staff_id", label: "签约人", type: "text", optionSource: userSelect, searchable: true },
  { key: "sign_time", label: "签约时间", type: "datetime" },
  { key: "remark", label: "备注", type: "textarea", span: "full" as const, rows: 3 }
];

const preStoreFields = [
  { key: "student_id", label: "学员", type: "text", optionSource: studentSelect },
  { key: "organization_id", label: "校区", type: "text", optionSource: orgSelect },
  { key: "transaction_amount", label: "预存金额", type: "number" },
  { key: "pay_way_config_id", label: "支付方式", type: "text", optionSource: payWaySelect },
  { key: "transaction_time", label: "收款时间", type: "datetime" },
  { key: "remark", label: "备注", type: "textarea", span: "full" as const, rows: 3 }
];

const contextPreStoreFields = preStoreFields.filter((field) => !["student_id"].includes(field.key));

const fundsCreateFields = [
  { key: "contract_id", label: "合同", type: "text", optionSource: contractSelect },
  { key: "student_id", label: "学员", type: "text", optionSource: studentSelect },
  { key: "organization_id", label: "校区", type: "text", optionSource: orgSelect },
  { key: "transaction_amount", label: "收款金额", type: "number" },
  { key: "pay_way_config_id", label: "支付方式", type: "text", optionSource: payWaySelect },
  { key: "transaction_time", label: "收款时间", type: "datetime" },
  { key: "funds_type", label: "流水类型", type: "text" },
  { key: "remark", label: "备注", type: "textarea", span: "full" as const, rows: 3 }
];

const contractFundsFields = fundsCreateFields.filter((field) => !["contract_id", "student_id", "organization_id", "funds_type"].includes(field.key));

const courseCreateFields = [
  { key: "course_title", label: "课程名称", type: "text", span: 2 as const },
  { key: "course_type", label: "课程类型", type: "text" },
  { key: "course_date", label: "上课日期", type: "date" },
  { key: "start_time", label: "开始时间", type: "text" },
  { key: "end_time", label: "结束时间", type: "text" },
  { key: "teacher_id", label: "老师", type: "text", optionSource: userSelect },
  { key: "study_manager_id", label: "学管师", type: "text", optionSource: userSelect },
  { key: "mini_class_id", label: "班级", type: "text", optionSource: miniClassSelect },
  { key: "one_on_n_group_id", label: "1对N小组", type: "text", optionSource: oneOnNGroupSelect },
  { key: "student_id", label: "上课学员", type: "text", optionSource: studentSelect },
  { key: "contract_product_id", label: "合同产品", type: "text", optionSource: contractProductSelect },
  { key: "organization_id", label: "校区", type: "text", optionSource: orgSelect },
  { key: "course_hour", label: "课时", type: "number" }
];

const chargeCreateFields = [
  { key: "course_id", label: "课程", type: "text", optionSource: { pageCode: "course_list", apiCode: "course_list.query", labelField: "course_title" } },
  { key: "student_id", label: "学员", type: "text", optionSource: studentSelect },
  { key: "contract_product_id", label: "合同产品", type: "text", optionSource: contractProductSelect },
  { key: "organization_id", label: "校区", type: "text", optionSource: orgSelect },
  { key: "charge_type", label: "扣费类型", type: "text" },
  { key: "charge_hour", label: "扣课时", type: "number" },
  { key: "charge_amount", label: "扣费金额", type: "number" }
];

const refundCreateFields = [
  { key: "student_id", label: "学员", type: "text", optionSource: studentSelect },
  { key: "contract_product_id", label: "合同产品", type: "text", optionSource: contractProductSelect },
  { key: "refund_real_hour", label: "退课时", type: "number" },
  { key: "refund_real_amount", label: "退金额", type: "number" },
  { key: "refund_promotion_amount", label: "退优惠金额", type: "number" },
  { key: "refund_promotion_hour", label: "退赠课时", type: "number" },
  { key: "refund_way_config_id", label: "退费方式", type: "text", optionSource: payWaySelect },
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
        { key: "contract_type", label: "合同类型", valueLabels: valueLabels.product_type },
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
  { key: "refund_way_config_id", label: "退费方式", type: "text", optionSource: payWaySelect },
  { key: "refund_time", label: "退费时间", type: "datetime" },
  { key: "remark", label: "备注", type: "textarea", span: "full" as const, rows: 3 }
];

const attendanceCheckInFields = [
  { key: "course_id", label: "课程", type: "text", hidden: true },
  { key: "students", label: "学员考勤", type: "attendance_table", span: "full" as const }
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
      { key: "school_name", label: "学校" }
    ]
  },
  {
    module: "ai_customization",
    feature: "customization_record_list",
    page: "customization_record_list",
    name: "AI 对话记录",
    table: "agent_customization_record",
    softDelete: false,
    apiSchema: "admin",
    group: "AI 助手",
    fields: [
      { key: "change_summary", label: "变更摘要" },
      { key: "created_at", label: "创建时间", type: "datetime" }
    ],
    fixedFilters: [{ field: "schema_name", op: "eq", valueFromParam: "schemaName" }]
  },
  {
    module: "ai_customization",
    feature: "tenant_version_list",
    page: "tenant_version_list",
    name: "版本管理",
    table: "dsl_version",
    softDelete: false,
    apiSchema: "admin",
    group: "AI 定制",
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
      { key: "product_name", label: "产品" },
      { key: "remaining_real_hour", label: "剩余课时" },
      { key: "remaining_real_amount", label: "剩余金额" },
      { key: "remaining_promotion_hour", label: "剩余赠课" },
      { key: "remaining_promotion_amount", label: "剩余优惠" }
    ],
    joins: [
      { table: "contract", alias: "ct", on: { left: "contract_id", right: "id" }, fields: [{ source: "id", as: "contract_no" }] },
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
      { key: "student_id", label: "学员ID", hidden: true },
      { key: "organization_id", label: "校区ID", hidden: true },
      { key: "organization_name", label: "校区" },
      { key: "paid_status", label: "付款状态", filter: true },
      { key: "contract_type", label: "合同类型" },
      { key: "total_amount", label: "应收金额" },
      { key: "paid_amount", label: "已收金额" },
      { key: "contract_status", label: "合同状态" }
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
      { key: "pay_way_name", label: "支付方式" }
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
      { key: "type", label: "优惠类型" },
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
      { key: "remark", label: "备注" }
    ],
    joins: [
      { table: "student", alias: "stu", on: { left: "student_id", right: "id" }, fields: [{ source: "name", as: "student_name" }] }
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
      { key: "status", label: "状态", filter: true }
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
      { key: "organization_id", label: "校区" }
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
      { key: "student_id", label: "学员" },
      { key: "follow_type", label: "跟进方式" },
      { key: "follow_content", label: "跟进内容" },
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
    group: "招生",
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
    module: "education",
    feature: "charge_record",
    page: "charge_record",
    name: "扣费记录",
    table: "account_charge_records",
    group: "消课扣费",
    fields: [
      { key: "student_id", label: "学员" },
      { key: "charge_type", label: "扣费类型" },
      { key: "charge_hour", label: "课时" },
      { key: "charge_amount", label: "金额" },
      { key: "charge_status", label: "状态" }
    ]
  },
  {
    module: "education",
    feature: "course_list",
    page: "course_list",
    name: "排课列表",
    table: "generic_course",
    group: "教务管理",
    fields: [
      { key: "course_title", label: "课程名称", filter: true },
      { key: "course_type", label: "课程类型", filter: true },
      { key: "course_date", label: "上课日期", type: "date" },
      { key: "teacher_id", label: "授课老师" },
      { key: "course_status", label: "状态", filter: true }
    ]
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
      { key: "capacity", label: "容量", type: "number" },
      { key: "status", label: "状态", filter: true }
    ]
  },
  {
    module: "education",
    feature: "mini_class_student_list",
    page: "mini_class_student_list",
    name: "班级学员",
    table: "mini_class_student",
    group: "班级管理",
    softDelete: false,
    fields: [
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
    softDelete: false,
    fields: [
      { key: "student_id", label: "学员" },
      { key: "join_date", label: "入组日期", type: "date" },
      { key: "status", label: "状态", filter: true }
    ],
    fixedFilters: [{ field: "one_on_n_group_id", op: "eq", valueFromParam: "one_on_n_group_id" }]
  }
];

export const extraPages: Array<{ pageCode: string; pageKind: string; module: string; feature: string; name: string; dsl: Record<string, unknown> }> = [
  {
    pageCode: "tenant_select",
    pageKind: "public",
    module: "system",
    feature: "tenant_select",
    name: "租户选择",
    dsl: {
      pageCode: "tenant_select",
      title: "选择机构",
      subtitle: "请选择您要登录的机构",
      pageKind: "public",
      layout: "public_form",
      presentation: { theme: "flatTech", density: "compact" },
      form: {
        fields: [
          { key: "schema_name", label: "机构编码", type: "text", required: true, placeholder: "请输入机构编码" }
        ],
        submitLabel: "进入系统",
        submitAction: { actionCode: "tenant_select.submit", actionType: "execute_api", apiCode: "tenant_select.submit" }
      }
    }
  },
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
          { key: "contract_type", label: "合同类型", type: "text" },
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
          { key: "course_date", label: "上课日期", type: "date" },
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
  { actionCode: "student_list.refresh", actionName: "刷新", actionType: "execute_api", pageCode: "student_list", module: "student", feature: "student_list", dsl: { actionCode: "student_list.refresh", actionName: "刷新", actionType: "execute_api", apiCode: "student_list.query" } },
  { actionCode: "lead_list.enroll", actionName: "新增报名", actionType: "open_modal", pageCode: "lead_list", module: "recruit", feature: "lead_list", dsl: { actionCode: "lead_list.enroll", actionName: "新增报名", actionType: "open_modal", modalCode: "contract_add_modal", afterSuccess: [{ type: "toast", message: "报名成功" }, { type: "refreshPage" }] } },
  { actionCode: "lead_list.create", actionName: "新增线索", actionType: "open_modal", pageCode: "lead_list", module: "recruit", feature: "lead_list", dsl: { actionCode: "lead_list.create", actionName: "新增线索", actionType: "open_modal", modalCode: "student_add_modal", afterSuccess: [{ type: "toast", message: "线索创建成功" }, { type: "refreshPage" }] } },
  { actionCode: "lead_list.edit", actionName: "编辑线索", actionType: "open_modal", pageCode: "lead_list", module: "recruit", feature: "lead_list", dsl: { actionCode: "lead_list.edit", actionName: "编辑线索", actionType: "open_modal", modalCode: "student_edit_modal", afterSuccess: [{ type: "toast", message: "线索更新成功" }, { type: "refreshPage" }] } },
  { actionCode: "lead_list.detail", actionName: "线索详情", actionType: "open_modal", pageCode: "lead_list", module: "recruit", feature: "lead_list", dsl: { actionCode: "lead_list.detail", actionName: "线索详情", actionType: "open_modal", modalCode: "student_detail_modal" } },
  { actionCode: "lead_list.delete", actionName: "删除线索", actionType: "execute_api", pageCode: "lead_list", module: "recruit", feature: "lead_list", dsl: { actionCode: "lead_list.delete", actionName: "删除线索", actionType: "execute_api", apiCode: "lead_list.delete", confirm: true, afterSuccess: [{ type: "toast", message: "线索已删除" }, { type: "refreshPage" }] } },
  { actionCode: "lead_list.refresh", actionName: "刷新", actionType: "execute_api", pageCode: "lead_list", module: "recruit", feature: "lead_list", dsl: { actionCode: "lead_list.refresh", actionName: "刷新", actionType: "execute_api", apiCode: "lead_list.query" } },
  { actionCode: "contract_list.create", actionName: "新增合同", actionType: "open_modal", pageCode: "contract_list", module: "finance", feature: "contract_list", dsl: { actionCode: "contract_list.create", actionName: "新增合同", actionType: "open_modal", modalCode: "contract_add_modal", afterSuccess: [{ type: "toast", message: "合同创建成功" }, { type: "refreshPage" }] } },
  { actionCode: "contract_list.edit", actionName: "编辑合同", actionType: "open_modal", pageCode: "contract_list", module: "finance", feature: "contract_list", dsl: { actionCode: "contract_list.edit", actionName: "编辑合同", actionType: "open_modal", modalCode: "contract_add_modal", afterSuccess: [{ type: "toast", message: "合同更新成功" }, { type: "refreshPage" }] } },
  { actionCode: "contract_list.detail", actionName: "合同详情", actionType: "open_modal", pageCode: "contract_list", module: "finance", feature: "contract_list", dsl: { actionCode: "contract_list.detail", actionName: "合同详情", actionType: "open_modal", modalCode: "contract_detail_modal" } },
  { actionCode: "contract_list.funds", actionName: "合同收款", actionType: "open_modal", pageCode: "contract_list", module: "finance", feature: "contract_list", dsl: { actionCode: "contract_list.funds", actionName: "合同收款", actionType: "open_modal", modalCode: "funds_add_modal", afterSuccess: [{ type: "toast", message: "收款成功" }, { type: "refreshPage" }] } },
  { actionCode: "contract_list.delete", actionName: "删除合同", actionType: "execute_api", pageCode: "contract_list", module: "finance", feature: "contract_list", dsl: { actionCode: "contract_list.delete", actionName: "删除合同", actionType: "execute_api", apiCode: "contract_list.delete", confirm: true, afterSuccess: [{ type: "toast", message: "合同已删除" }, { type: "refreshPage" }] } },
  { actionCode: "contract_list.refresh", actionName: "刷新", actionType: "execute_api", pageCode: "contract_list", module: "finance", feature: "contract_list", dsl: { actionCode: "contract_list.refresh", actionName: "刷新", actionType: "execute_api", apiCode: "contract_list.query" } },
  { actionCode: "course_list.create", actionName: "新增排课", actionType: "open_modal", pageCode: "course_list", module: "education", feature: "course_list", dsl: { actionCode: "course_list.create", actionName: "新增排课", actionType: "open_modal", modalCode: "course_add_modal", afterSuccess: [{ type: "toast", message: "排课创建成功" }, { type: "refreshPage" }] } },
  { actionCode: "course_list.edit", actionName: "编辑排课", actionType: "open_modal", pageCode: "course_list", module: "education", feature: "course_list", dsl: { actionCode: "course_list.edit", actionName: "编辑排课", actionType: "open_modal", modalCode: "course_add_modal", afterSuccess: [{ type: "toast", message: "排课更新成功" }, { type: "refreshPage" }] } },
  { actionCode: "course_list.detail", actionName: "课程详情", actionType: "open_modal", pageCode: "course_list", module: "education", feature: "course_list", dsl: { actionCode: "course_list.detail", actionName: "课程详情", actionType: "open_modal", modalCode: "course_detail_modal" } },
  { actionCode: "course_list.delete", actionName: "删除课程", actionType: "execute_api", pageCode: "course_list", module: "education", feature: "course_list", dsl: { actionCode: "course_list.delete", actionName: "删除课程", actionType: "execute_api", apiCode: "course_list.delete", confirm: true, afterSuccess: [{ type: "toast", message: "课程已删除" }, { type: "refreshPage" }] } },
  { actionCode: "course_list.refresh", actionName: "刷新", actionType: "execute_api", pageCode: "course_list", module: "education", feature: "course_list", dsl: { actionCode: "course_list.refresh", actionName: "刷新", actionType: "execute_api", apiCode: "course_list.query" } },
  { actionCode: "charge_record.create", actionName: "新增扣费", actionType: "open_modal", pageCode: "charge_record", module: "education", feature: "charge_record", dsl: { actionCode: "charge_record.create", actionName: "新增扣费", actionType: "open_modal", modalCode: "charge_confirm_modal", afterSuccess: [{ type: "toast", message: "扣费成功" }, { type: "refreshPage" }] } },
  { actionCode: "charge_record.detail", actionName: "扣费详情", actionType: "open_modal", pageCode: "charge_record", module: "education", feature: "charge_record", dsl: { actionCode: "charge_record.detail", actionName: "扣费详情", actionType: "open_modal", modalCode: "charge_confirm_modal" } },
  { actionCode: "charge_record.refresh", actionName: "刷新", actionType: "execute_api", pageCode: "charge_record", module: "education", feature: "charge_record", dsl: { actionCode: "charge_record.refresh", actionName: "刷新", actionType: "execute_api", apiCode: "charge_record.query" } },
  { actionCode: "funds_history.create", actionName: "新增收款", actionType: "open_modal", pageCode: "funds_history", module: "finance", feature: "funds_history", dsl: { actionCode: "funds_history.create", actionName: "新增收款", actionType: "open_modal", modalCode: "funds_add_modal", afterSuccess: [{ type: "toast", message: "收款成功" }, { type: "refreshPage" }] } },
  { actionCode: "funds_history.detail", actionName: "收款详情", actionType: "open_modal", pageCode: "funds_history", module: "finance", feature: "funds_history", dsl: { actionCode: "funds_history.detail", actionName: "收款详情", actionType: "open_modal", modalCode: "funds_add_modal" } },
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
  { actionCode: "student_visit.sign_in", actionName: "签到", actionType: "execute_api", pageCode: "student_visit", module: "student", feature: "student_visit", dsl: { actionCode: "student_visit.sign_in", actionName: "签到", actionType: "execute_api", apiCode: "course_list.update", afterSuccess: [{ type: "toast", message: "签到成功" }, { type: "refreshPage" }] } },
  { actionCode: "student_visit.sign_out", actionName: "签退", actionType: "execute_api", pageCode: "student_visit", module: "student", feature: "student_visit", dsl: { actionCode: "student_visit.sign_out", actionName: "签退", actionType: "execute_api", apiCode: "course_list.update", afterSuccess: [{ type: "toast", message: "签退成功" }, { type: "refreshPage" }] } },
  { actionCode: "money_arrange_list.refresh", actionName: "刷新", actionType: "execute_api", pageCode: "money_arrange_list", module: "finance", feature: "money_arrange_list", dsl: { actionCode: "money_arrange_list.refresh", actionName: "刷新", actionType: "execute_api", apiCode: "money_arrange_list.query" } },
  { actionCode: "money_arrange_list.detail", actionName: "详情", actionType: "open_modal", pageCode: "money_arrange_list", module: "finance", feature: "money_arrange_list", dsl: { actionCode: "money_arrange_list.detail", actionName: "详情", actionType: "open_modal", modalCode: "money_arrange_detail_modal" } },
  { actionCode: "promotion_arrange_list.refresh", actionName: "刷新", actionType: "execute_api", pageCode: "promotion_arrange_list", module: "finance", feature: "promotion_arrange_list", dsl: { actionCode: "promotion_arrange_list.refresh", actionName: "刷新", actionType: "execute_api", apiCode: "promotion_arrange_list.query" } },
  { actionCode: "promotion_arrange_list.detail", actionName: "详情", actionType: "open_modal", pageCode: "promotion_arrange_list", module: "finance", feature: "promotion_arrange_list", dsl: { actionCode: "promotion_arrange_list.detail", actionName: "详情", actionType: "open_modal", modalCode: "promotion_arrange_detail_modal" } },
  { actionCode: "performance_arrange_list.refresh", actionName: "刷新", actionType: "execute_api", pageCode: "performance_arrange_list", module: "finance", feature: "performance_arrange_list", dsl: { actionCode: "performance_arrange_list.refresh", actionName: "刷新", actionType: "execute_api", apiCode: "performance_arrange_list.query" } },
  { actionCode: "performance_arrange_list.detail", actionName: "详情", actionType: "open_modal", pageCode: "performance_arrange_list", module: "finance", feature: "performance_arrange_list", dsl: { actionCode: "performance_arrange_list.detail", actionName: "详情", actionType: "open_modal", modalCode: "performance_arrange_detail_modal" } },
  { actionCode: "finance_report.refresh", actionName: "刷新", actionType: "execute_api", pageCode: "finance_report", module: "report", feature: "finance_report", dsl: { actionCode: "finance_report.refresh", actionName: "刷新", actionType: "execute_api", apiCode: "finance_report.query" } },
  { actionCode: "course_report.refresh", actionName: "刷新", actionType: "execute_api", pageCode: "course_report", module: "report", feature: "course_report", dsl: { actionCode: "course_report.refresh", actionName: "刷新", actionType: "execute_api", apiCode: "course_report.query" } },
  { actionCode: "customization_record_list.new_customization", actionName: "新增定制化", actionType: "open_ai_customization", pageCode: "customization_record_list", module: "ai_customization", feature: "customization_record_list", dsl: { actionCode: "customization_record_list.new_customization", actionName: "新增定制化", actionType: "open_ai_customization", variant: "primary" } },
  { actionCode: "tenant_version_list.publish", actionName: "发布版本", actionType: "execute_api", pageCode: "tenant_version_list", module: "ai_customization", feature: "tenant_version_list", dsl: { actionCode: "tenant_version_list.publish", actionName: "发布版本", actionType: "execute_api", apiCode: "dsl_version.publish", confirm: "确认发布此版本？", afterSuccess: [{ type: "toast", message: "版本已发布" }, { type: "refreshPage" }] } },
  { actionCode: "tenant_version_list.rollback", actionName: "回滚到此版本", actionType: "execute_api", pageCode: "tenant_version_list", module: "ai_customization", feature: "tenant_version_list", dsl: { actionCode: "tenant_version_list.rollback", actionName: "回滚到此版本", actionType: "execute_api", apiCode: "dsl_version.rollback", confirm: "确认回滚到此版本？将创建新版本并恢复DSL。", afterSuccess: [{ type: "toast", message: "回滚成功" }, { type: "refreshPage" }] } },
  { actionCode: "tenant_version_list.rollback_preview", actionName: "回滚预览", actionType: "execute_api", pageCode: "tenant_version_list", module: "ai_customization", feature: "tenant_version_list", dsl: { actionCode: "tenant_version_list.rollback_preview", actionName: "回滚预览", actionType: "execute_api", apiCode: "dsl_version.rollback_preview", afterSuccess: [{ type: "toast", message: "回滚预览已生成" }, { type: "refreshPage" }] } },
  { actionCode: "tenant_version_list.refresh", actionName: "刷新", actionType: "execute_api", pageCode: "tenant_version_list", module: "ai_customization", feature: "tenant_version_list", dsl: { actionCode: "tenant_version_list.refresh", actionName: "刷新", actionType: "execute_api", apiCode: "tenant_version_list.query" } },
  { actionCode: "contract_list.refund", actionName: "合同退费", actionType: "open_modal", pageCode: "contract_list", module: "finance", feature: "contract_list", dsl: { actionCode: "contract_list.refund", actionName: "合同退费", actionType: "open_modal", modalCode: "contract_refund_modal", afterSuccess: [{ type: "toast", message: "退费成功" }, { type: "refreshPage" }] } },
  { actionCode: "refund_record.delete", actionName: "删除退费记录", actionType: "execute_api", pageCode: "refund_record", module: "finance", feature: "refund_record", dsl: { actionCode: "refund_record.delete", actionName: "删除退费记录", actionType: "execute_api", apiCode: "refund.delete", confirm: "确认删除该退费记录？删除后将恢复合同产品余额", afterSuccess: [{ type: "toast", message: "退费记录已删除，余额已恢复" }, { type: "refreshPage" }] } },
  { actionCode: "course_list.attendance", actionName: "考勤签到", actionType: "open_modal", pageCode: "course_list", module: "education", feature: "course_list", dsl: { actionCode: "course_list.attendance", actionName: "考勤签到", actionType: "open_modal", modalCode: "attendance_check_in_modal", afterSuccess: [{ type: "toast", message: "考勤成功" }, { type: "refreshPage" }] } },
  { actionCode: "course_list.cancelAttendance", actionName: "取消考勤", actionType: "execute_api", pageCode: "course_list", module: "education", feature: "course_list", dsl: { actionCode: "course_list.cancelAttendance", actionName: "取消考勤", actionType: "execute_api", apiCode: "attendance.cancel", confirm: "确认取消该学员考勤？", afterSuccess: [{ type: "toast", message: "考勤已取消" }, { type: "refreshPage" }] } },
  { actionCode: "charge_record.reverse", actionName: "撤销扣费", actionType: "execute_api", pageCode: "charge_record", module: "education", feature: "charge_record", dsl: { actionCode: "charge_record.reverse", actionName: "撤销扣费", actionType: "execute_api", apiCode: "chargeRecord.reverse", confirm: "确认撤销该扣费记录？", afterSuccess: [{ type: "toast", message: "扣费已撤销" }, { type: "refreshPage" }] } },
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
    { key: "contract_type", label: "合同类型", type: "text" }, { key: "total_amount", label: "应收金额", type: "number" },
    { key: "paid_amount", label: "已收金额", type: "number" }, { key: "contract_status", label: "合同状态", type: "text" },
    { key: "remark", label: "备注", type: "textarea", span: "full", rows: 3 }
  ] } },
  { actionCode: "funds_add_modal", actionName: "新增收款弹窗", pageCode: "funds_history", module: "finance", feature: "funds_history", dsl: { modalCode: "funds_add_modal", modalName: "新增收款", size: "medium", columns: 3, labelAlign: "left", submitApiCode: "funds_history.create", fields: fundsCreateFields } },
  { actionCode: "refund_add_modal", actionName: "新增退费弹窗", pageCode: "refund_record", module: "finance", feature: "refund_record", dsl: { modalCode: "refund_add_modal", modalName: "新增退费", size: "medium", columns: 3, labelAlign: "left", submitApiCode: "refund_record.create", fields: refundCreateFields } },
  { actionCode: "course_add_modal", actionName: "新增排课弹窗", pageCode: "course_list", module: "education", feature: "course_list", dsl: { modalCode: "course_add_modal", modalName: "新增排课", size: "medium", columns: 3, labelAlign: "left", submitApiCode: "course_list.create", fields: courseCreateFields } },
  { actionCode: "course_detail_modal", actionName: "课程详情弹窗", pageCode: "course_list", module: "education", feature: "course_list", dsl: { modalCode: "course_detail_modal", modalName: "课程详情", size: "large", columns: 3, labelAlign: "left", readOnly: true, fields: [
    { key: "course_title", label: "课程名称", type: "text", span: 2 }, { key: "course_type", label: "课程类型", type: "text" },
    { key: "course_date", label: "上课日期", type: "date" }, { key: "start_time", label: "开始时间", type: "text" },
    { key: "end_time", label: "结束时间", type: "text" }, { key: "teacher_id", label: "老师", type: "text", optionSource: userSelect },
    { key: "study_manager_id", label: "学管师", type: "text", optionSource: userSelect }, { key: "student_id", label: "上课学员", type: "text", optionSource: studentSelect },
    { key: "organization_id", label: "校区", type: "text", optionSource: orgSelect }, { key: "course_hour", label: "课时", type: "number" },
    { key: "course_status", label: "状态", type: "text" }
  ] } },
  { actionCode: "charge_confirm_modal", actionName: "扣费确认弹窗", pageCode: "charge_record", module: "education", feature: "charge_record", dsl: { modalCode: "charge_confirm_modal", modalName: "扣费确认", size: "medium", columns: 3, labelAlign: "left", submitApiCode: "charge_record.create", fields: chargeCreateFields } },
  { actionCode: "product_add_modal", actionName: "新增产品弹窗", pageCode: "product_list", module: "finance", feature: "product_list", dsl: { modalCode: "product_add_modal", modalName: "新增产品", size: "medium", columns: 3, labelAlign: "left", submitApiCode: "product_list.create", fields: [
    { key: "name", label: "产品名称", type: "text", required: true }, { key: "product_type", label: "产品类型", type: "text" },
    { key: "unit_price", label: "单价", type: "number" }, { key: "default_course_hour", label: "课时", type: "number" },
    { key: "total_amount", label: "总价", type: "number" }, { key: "status", label: "状态", type: "text" }
  ] } },
  { actionCode: "product_edit_modal", actionName: "编辑产品弹窗", pageCode: "product_list", module: "finance", feature: "product_list", dsl: { modalCode: "product_edit_modal", modalName: "编辑产品", size: "medium", columns: 3, labelAlign: "left", submitApiCode: "product_list.update", fields: [
    { key: "name", label: "产品名称", type: "text", required: true }, { key: "product_type", label: "产品类型", type: "text" },
    { key: "unit_price", label: "单价", type: "number" }, { key: "default_course_hour", label: "课时", type: "number" },
    { key: "total_amount", label: "总价", type: "number" }, { key: "status", label: "状态", type: "text" }
  ] } },
  { actionCode: "promotion_add_modal", actionName: "新增优惠弹窗", pageCode: "promotion_list", module: "finance", feature: "promotion_list", dsl: { modalCode: "promotion_add_modal", modalName: "新增优惠", size: "small", columns: 2, labelAlign: "left", submitApiCode: "promotion_list.create", fields: [
    { key: "name", label: "优惠名称", type: "text", required: true }, { key: "type", label: "优惠类型", type: "text" },
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
    { key: "organization_id", label: "校区", type: "text", optionSource: orgSelect }
  ] } },
  { actionCode: "contract_refund_modal", actionName: "合同退费弹窗", pageCode: "contract_list", module: "finance", feature: "contract_list", dsl: { modalCode: "contract_refund_modal", modalName: "合同退费", size: "medium", columns: 3, labelAlign: "left", submitApiCode: "contract.refund", fields: contractRefundFields } },
  { actionCode: "attendance_check_in_modal", actionName: "考勤签到弹窗", pageCode: "course_list", module: "education", feature: "course_list", dsl: { modalCode: "attendance_check_in_modal", modalName: "学员考勤", size: "large", columns: 1, labelAlign: "left", submitApiCode: "attendance.checkIn", fields: attendanceCheckInFields } },
  { actionCode: "mini_class_add_modal", actionName: "新增班级弹窗", pageCode: "mini_class_list", module: "education", feature: "mini_class_list", dsl: { modalCode: "mini_class_add_modal", modalName: "新增班级", size: "medium", columns: 3, labelAlign: "left", submitApiCode: "mini_class_list.create", fields: [
    { key: "name", label: "班级名称", type: "text", required: true }, { key: "organization_id", label: "校区", type: "text", optionSource: orgSelect },
    { key: "teacher_id", label: "授课老师", type: "text", optionSource: userSelect }, { key: "study_manager_id", label: "学管师", type: "text", optionSource: userSelect },
    { key: "capacity", label: "容量", type: "number" }
  ] } },
  { actionCode: "mini_class_detail_modal", actionName: "班级详情弹窗", pageCode: "mini_class_list", module: "education", feature: "mini_class_list", dsl: { modalCode: "mini_class_detail_modal", modalName: "班级详情", size: "large", columns: 3, labelAlign: "left", readOnly: true, fields: [
    { key: "name", label: "班级名称", type: "text" }, { key: "organization_id", label: "校区", type: "text", optionSource: orgSelect },
    { key: "teacher_id", label: "授课老师", type: "text", optionSource: userSelect }, { key: "study_manager_id", label: "学管师", type: "text", optionSource: userSelect },
    { key: "capacity", label: "容量", type: "number" }, { key: "status", label: "状态", type: "text" }
  ] } },
  { actionCode: "mini_class_add_student_modal", actionName: "添加班级学员弹窗", pageCode: "mini_class_list", module: "education", feature: "mini_class_list", dsl: { modalCode: "mini_class_add_student_modal", modalName: "添加班级学员", size: "medium", columns: 1, labelAlign: "left", submitApiCode: "miniClass.addStudent", fields: addStudentFields } },
  { actionCode: "one_on_n_group_add_modal", actionName: "新增1对N小组弹窗", pageCode: "one_on_n_group_list", module: "education", feature: "one_on_n_group_list", dsl: { modalCode: "one_on_n_group_add_modal", modalName: "新增1对N小组", size: "medium", columns: 3, labelAlign: "left", submitApiCode: "one_on_n_group_list.create", fields: [
    { key: "name", label: "小组名称", type: "text", required: true }, { key: "organization_id", label: "校区", type: "text", optionSource: orgSelect },
    { key: "teacher_id", label: "授课老师", type: "text", optionSource: userSelect }, { key: "study_manager_id", label: "学管师", type: "text", optionSource: userSelect },
    { key: "capacity", label: "容量", type: "number" }
  ] } },
  { actionCode: "one_on_n_group_detail_modal", actionName: "1对N小组详情弹窗", pageCode: "one_on_n_group_list", module: "education", feature: "one_on_n_group_list", dsl: { modalCode: "one_on_n_group_detail_modal", modalName: "1对N小组详情", size: "large", columns: 3, labelAlign: "left", readOnly: true, fields: [
    { key: "name", label: "小组名称", type: "text" }, { key: "organization_id", label: "校区", type: "text", optionSource: orgSelect },
    { key: "teacher_id", label: "授课老师", type: "text", optionSource: userSelect }, { key: "study_manager_id", label: "学管师", type: "text", optionSource: userSelect },
    { key: "capacity", label: "容量", type: "number" }, { key: "status", label: "状态", type: "text" }
  ] } },
  { actionCode: "one_on_n_group_add_student_modal", actionName: "添加1对N学员弹窗", pageCode: "one_on_n_group_list", module: "education", feature: "one_on_n_group_list", dsl: { modalCode: "one_on_n_group_add_student_modal", modalName: "添加1对N学员", size: "medium", columns: 1, labelAlign: "left", submitApiCode: "oneOnNGroup.addStudent", fields: addStudentFields } },
  { actionCode: "mini_class_student_detail_modal", actionName: "班级学员详情弹窗", pageCode: "mini_class_student_list", module: "education", feature: "mini_class_student_list", dsl: { modalCode: "mini_class_student_detail_modal", modalName: "班级学员详情", size: "medium", columns: 2, labelAlign: "left", readOnly: true, fields: [
    { key: "student_id", label: "学员", type: "text" }, { key: "join_date", label: "入班日期", type: "date" }, { key: "status", label: "状态", type: "text" }
  ] } },
  { actionCode: "one_on_n_group_student_detail_modal", actionName: "1对N学员详情弹窗", pageCode: "one_on_n_group_student_list", module: "education", feature: "one_on_n_group_student_list", dsl: { modalCode: "one_on_n_group_student_detail_modal", modalName: "1对N学员详情", size: "medium", columns: 2, labelAlign: "left", readOnly: true, fields: [
    { key: "student_id", label: "学员", type: "text" }, { key: "join_date", label: "入组日期", type: "date" }, { key: "status", label: "状态", type: "text" }
  ] } }
];

export const optionApiDslSeeds: Array<{ apiCode: string; apiName: string; module: string; feature: string; dsl: Record<string, unknown> }> = [
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
  ["dsl_mgmt", "DSL 管理", "platform", "版本与AI变更", 92, "FileCode2"]
] as const;

export const adminPages: PageSeed[] = [
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
    feature: "tenant_customization_record",
    page: "tenant_customization_record",
    name: "定制化记录",
    table: "agent_customization_record",
    softDelete: false,
    fields: [
      { key: "schema_name", label: "租户", filter: true },
      { key: "session_id", label: "会话ID" },
      { key: "change_summary", label: "变更摘要" },
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
  const filters = page.fields.filter((field) => field.filter).map((field) => ({
    key: field.key,
    label: field.label,
    type: field.type ?? "text",
    placeholder: `请输入${field.label}`
  }));
  const baseDsl: Record<string, any> = {
    pageCode: page.page,
    title: page.name,
    subtitle: pageSubtitles[page.page] ?? `${page.name}业务数据维护`,
    designToken: "flatTech",
    presentation: {
      theme: "flatTech",
      density: "compact",
      header: {
        subtitle: pageSubtitles[page.page] ?? `${page.name}业务数据维护`,
        metrics: metricsFor(page)
      },
      table: {
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
        badge: field.badge ?? statusFields.has(field.key)
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
    baseDsl.subtitle = "查看 AI 助手对话、工具调用和导入处理记录";
    baseDsl.presentation.header.subtitle = "查看 AI 助手对话、工具调用和导入处理记录";
    baseDsl.table.rowActions = [
      { actionCode: "customization_record_list.detail", label: "详情", type: "open_modal" }
    ];
    baseDsl.presentation.table.primaryRowActions = ["customization_record_list.detail"];
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
    baseDsl.presentation.valueLabels = {
      ...(baseDsl.presentation.valueLabels ?? {}),
      organization_type: { COMPANY: "分公司", BRANCH: "校区", CUSTOM: "自定义架构", HEAD: "总部" }
    };
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
      { key: "status", label: "状态", type: "text" },
      { key: "organization_id", label: "组织架构", type: "text", optionSource: orgSelect },
      { key: "config_json", label: "审批配置", type: "approval_flow_editor", span: "full" }
    ];
    baseDsl.presentation.modal.size = "fullscreen";
    baseDsl.presentation.table.primaryRowActions = ["approval_flow_list.edit", "approval_flow_list.delete"];
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
      { key: "rule_json", label: "规则设置", type: "business_rule_editor", span: "full" }
    ];
    baseDsl.presentation.modal.size = "large";
    baseDsl.presentation.table.primaryRowActions = ["business_rule_list.detail", "business_rule_list.edit", "business_rule_list.delete"];
  }

  if (page.page === "student_list") {
    baseDsl.table.rowActions = [
      { actionCode: "student_list.detail", label: "详情", type: "open_modal" },
      { actionCode: "student_list.edit", label: "编辑", type: "open_modal" },
      {
        actionCode: "student_list.prestore",
        label: "预存",
        type: "open_modal",
        apiCode: "funds_history.create",
        modalTitle: "学员预存",
        fields: contextPreStoreFields,
        defaultValues: { funds_type: "PRE_STORE", transaction_time: new Date().toISOString().slice(0, 16), pay_way_config_id: "pay_cash" },
        mapRowToValue: { student_id: "id", organization_id: "organization_id" }
      },
      { actionCode: "student_list.delete", label: "删除", type: "execute_api", confirm: "确认删除这条记录？" }
    ];
    baseDsl.presentation.table.primaryRowActions = ["student_list.detail", "student_list.edit", "student_list.prestore", "student_list.delete"];
  }

  if (page.page === "contract_list") {
    baseDsl.toolbar = [
      { actionCode: "contract_list.create", label: "新增合同", type: "open_modal", variant: "primary", modalTitle: "新增合同", fields: contractCreateFields, defaultValues: { contract_type: "ONE_ON_ONE_COURSE", sign_time: new Date().toISOString().slice(0, 16) }, modalSize: "large" },
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
      { actionCode: "contract_list.refresh", label: "刷新", type: "execute_api", variant: "default" }
    ];
    baseDsl.table.rowActions = [
      { actionCode: "contract_list.detail", label: "详情", type: "open_modal" },
      { actionCode: "contract_list.edit", label: "编辑", type: "open_modal" },
      {
        actionCode: "contract_list.funds",
        label: "收款",
        type: "open_modal",
        apiCode: "funds_history.create",
        modalTitle: "合同收款",
        fields: contractFundsFields,
        defaultValues: { funds_type: "CONTRACT_PAY", transaction_time: new Date().toISOString().slice(0, 16), pay_way_config_id: "pay_cash" },
        mapRowToValue: { contract_id: "id", student_id: "student_id", organization_id: "organization_id" }
      },
      {
        actionCode: "contract_list.refund",
        label: "退费",
        type: "open_modal",
        apiCode: "contract.refund",
        modalTitle: "合同退费",
        fields: contractRefundFields,
        defaultValues: { refund_time: new Date().toISOString().slice(0, 16), refund_way_config_id: "pay_cash" },
        mapRowToValue: { contract_id: "id", student_name: "student_name" }
      },
      { actionCode: "contract_list.print", label: "打印", type: "display", actionType: "display", printTemplateCode: "contract_receipt_print" },
      { actionCode: "contract_list.delete", label: "删除", type: "execute_api", confirm: "确认删除这条记录？" }
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
    baseDsl.toolbar = [
      {
        actionCode: "lead_list.enroll",
        label: "新增报名",
        type: "open_modal",
        variant: "primary",
        apiCode: "contract_list.create",
        modalTitle: "新生报名",
        fields: contractCreateFields,
        defaultValues: { contract_type: "ONE_ON_ONE_COURSE", sign_time: new Date().toISOString().slice(0, 16) },
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
        defaultValues: { contract_type: "ONE_ON_ONE_COURSE", sign_time: new Date().toISOString().slice(0, 16) },
        mapRowToValue: { student_id: "id", organization_id: "organization_id" },
        modalSize: "large"
      },
      { actionCode: "lead_list.detail", label: "详情", type: "open_modal" },
      { actionCode: "lead_list.edit", label: "编辑", type: "open_modal" },
      { actionCode: "lead_list.delete", label: "删除", type: "execute_api", confirm: "确认删除这条记录？" }
    ];
    baseDsl.presentation.table.primaryRowActions = ["lead_list.enroll", "lead_list.detail", "lead_list.edit", "lead_list.delete"];
  }

  if (page.page === "course_list") {
    baseDsl.toolbar = [
      { actionCode: "course_list.create", label: "新增排课", type: "open_modal", variant: "primary", modalTitle: "新增排课", fields: courseCreateFields, defaultValues: { course_type: "ONE_ON_ONE_COURSE", course_status: "SCHEDULED", course_hour: 1 } },
      { actionCode: "course_list.refresh", label: "刷新", type: "execute_api", variant: "default" }
    ];
    baseDsl.table.rowActions = [
      { actionCode: "course_list.detail", label: "详情", type: "open_modal" },
      {
        actionCode: "course_list.attendance",
        label: "考勤",
        type: "open_modal",
        apiCode: "attendance.checkIn",
        modalTitle: "学员考勤",
        fields: attendanceCheckInFields,
        mapRowToValue: { course_id: "id" }
      },
      { actionCode: "course_list.delete", label: "删除", type: "execute_api", apiCode: "course.delete", confirm: "确认删除该排课？将回滚关联考勤和扣费", variant: "danger" }
    ];
    baseDsl.presentation.table.primaryRowActions = ["course_list.detail", "course_list.attendance", "course_list.delete"];
    baseDsl.modal.fields = courseCreateFields;
  }

  if (page.page === "charge_record") {
    baseDsl.toolbar = [
      { actionCode: "charge_record.refresh", label: "刷新", type: "execute_api", variant: "default" }
    ];
    baseDsl.table.rowActions = [
      { actionCode: "charge_record.detail", label: "详情", type: "open_modal" },
      { actionCode: "charge_record.reverse", label: "撤销", type: "execute_api", apiCode: "chargeRecord.reverse", confirm: "确认撤销该扣费记录？", variant: "danger" }
    ];
    baseDsl.presentation.table.primaryRowActions = ["charge_record.detail", "charge_record.reverse"];
    baseDsl.modal.fields = chargeCreateFields;
  }

  if (page.page === "refund_record") {
    baseDsl.toolbar = [
      { actionCode: "refund_record.create", label: "新增退费", type: "open_modal", variant: "primary", modalTitle: "新增退费", fields: refundCreateFields, defaultValues: { refund_time: new Date().toISOString().slice(0, 16), refund_way_config_id: "pay_cash" } },
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
      { actionCode: "mini_class_list.delete", label: "删除", type: "execute_api", confirm: "确认删除这条记录？" }
    ];
    baseDsl.presentation.table.primaryRowActions = ["mini_class_list.detail", "mini_class_list.edit", "mini_class_list.addStudent", "mini_class_list.delete"];
  }

  if (page.page === "one_on_n_group_list") {
    baseDsl.table.rowActions = [
      { actionCode: "one_on_n_group_list.detail", label: "详情", type: "open_modal" },
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
      { actionCode: "one_on_n_group_list.delete", label: "删除", type: "execute_api", confirm: "确认删除这条记录？" }
    ];
    baseDsl.presentation.table.primaryRowActions = ["one_on_n_group_list.detail", "one_on_n_group_list.edit", "one_on_n_group_list.addStudent", "one_on_n_group_list.delete"];
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
        confirm: "确认移除该学员？",
        variant: "danger"
      }
    ];
    baseDsl.presentation.table.primaryRowActions = [`${page.page}.detail`, `${page.page}.removeStudent`];
  }

  if (page.page === "funds_history") {
    baseDsl.toolbar = [
      { actionCode: "funds_history.create", label: "新增收款", type: "open_modal", variant: "primary", modalTitle: "新增收款", fields: fundsCreateFields, defaultValues: { funds_type: "CONTRACT_PAY", transaction_time: new Date().toISOString().slice(0, 16), pay_way_config_id: "pay_cash" } },
      { actionCode: "funds_history.refresh", label: "刷新", type: "execute_api", variant: "default" }
    ];
    baseDsl.table.rowActions = [
      { actionCode: "funds_history.detail", label: "详情", type: "open_modal" },
      { actionCode: "funds_history.delete", label: "删除", type: "execute_api", confirm: "确认删除这条收款记录？系统会回滚对应资金、优惠和业绩分配。" }
    ];
    baseDsl.presentation.table.primaryRowActions = ["funds_history.detail", "funds_history.delete"];
    baseDsl.modal.fields = fundsCreateFields;
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
              label: "学员总数",
              source: "countBy",
              field: "student_status",
              value: "FORMAL",
              target: { pageCode: "student_list", title: "学员列表" }
            },
            {
              label: "新生报名",
              source: "countBy",
              field: "student_status",
              value: "LEAD",
              target: { pageCode: "lead_list", title: "新生报名" }
            },
            { label: "客户总数", source: "total", target: { pageCode: "frontdesk_home", title: "运营首页" } }
          ]
        },
        dashboard: {
          quickActions: [
            { label: "学员列表", pageCode: "student_list", moduleCode: "student" },
            { label: "排课列表", pageCode: "course_list", moduleCode: "education" },
            { label: "合同列表", pageCode: "contract_list", moduleCode: "finance" },
            { label: "收款记录", pageCode: "funds_history", moduleCode: "finance" }
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

  return baseDsl;
}

export function apiDsl(page: (typeof pages)[number] | (typeof adminPages)[number], apiType: "query" | "detail" | "create" | "update" | "delete") {
  const joinAliases = new Set(
    (page.joins ?? []).flatMap((join) =>
      ((join as { fields?: Array<{ as: string }> }).fields ?? []).map((field) => field.as)
    )
  );
  const command = apiType === "create" ? page.commands?.create : undefined;
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
  if (page.page === "funds_history" && apiType === "delete") {
    return {
      operation: "command",
      command: "funds.delete",
      ruleCode: "funds_create_rule"
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
      ruleCode: "course_create_rule"
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
    filters: [...new Set([...page.fields.filter((field) => field.filter).map((field) => field.key), ...(page.apiFilters ?? [])])],
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
      businessType: "contract",
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
      businessType: "funds",
      fundsAllocation: "byCpRemainingAmount",
      splitBy: "contract_product",
      updateContractPaidStatus: true,
      allowPreStoreWithoutContract: true,
      allowManualAdjust: false,
      generateLogTable: "money_arrange_log",
      validations: [
        { field: "transaction_amount", operator: ">", value: 0, message: "收款金额必须大于 0" }
      ]
    }
  },
  {
    rule_code: "course_create_rule",
    rule_name: "排课冲突规则",
    rule_json: {
      category: "validation",
      businessType: "course",
      preventTeacherTimeConflict: true,
      preventStudentTimeConflict: true,
      preventInvalidTimeRange: true,
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
      allowNegativeBalance: false,
      updateContractProductBalance: true,
      autoCalculateChargeAmount: true,
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
      businessType: "refund",
      refundAllocation: "byCpRemainingAmount",
      allowRefundOverBalance: false,
      updateContractProductBalance: true,
      updateContractPaidStatus: true,
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
      updateContractPaidStatus: true
    }
  },
  {
    rule_code: "attendance_check_in_rule",
    rule_name: "考勤签到规则",
    rule_json: {
      category: "attendance",
      businessType: "attendance",
      requireCheckInBeforeCharge: true,
      autoCalculateChargeAmount: true,
      allowAfterFinished: true
    }
  },
  {
    rule_code: "course_time_validation_rule",
    rule_name: "排课时间校验规则",
    rule_json: {
      category: "validation",
      businessType: "course",
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
      businessType: "funds",
      fundsAllocation: "byCpRemainingAmount",
      splitBy: "contract_product",
      allowManualAdjust: false,
      generateLogTable: "money_arrange_log",
      validations: [
        { field: "transaction_amount", operator: ">", value: 0, message: "收款金额必须大于 0" }
      ]
    }
  },
  {
    rule_code: "promotion_allocation_rule",
    rule_name: "优惠分配通用规则",
    rule_json: {
      category: "promotion_allocation",
      businessType: "contract",
      promotionAllocation: "byCpAmountRatio",
      splitBy: "contract_product",
      snapshotPromotion: true,
      allowManualAdjust: false,
      generateLogTable: "promotion_arrange_log"
    }
  },
  {
    rule_code: "performance_allocation_rule",
    rule_name: "业绩分配通用规则",
    rule_json: {
      category: "performance_allocation",
      businessType: "performance",
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
    rule_code: "discount_approval_threshold_rule",
    rule_name: "优惠审批阈值规则",
    rule_json: {
      category: "approval_trigger",
      businessType: "contract",
      targetAction: "contract_list.create",
      triggerApprovalFlow: "contract_discount_approval",
      thresholdAmount: 0,
      conditions: [
        { field: "promotion_amount", operator: ">", value: 0, message: "合同存在优惠时进入优惠审批" }
      ]
    }
  },
  {
    rule_code: "refund_approval_threshold_rule",
    rule_name: "退费审批阈值规则",
    rule_json: {
      category: "approval_trigger",
      businessType: "refund",
      targetAction: "refund_record.create",
      triggerApprovalFlow: "refund_create_approval",
      thresholdAmount: 0,
      conditions: [
        { field: "refund_real_amount", operator: ">", value: 0, message: "发起退费时进入退费审批" }
      ]
    }
  },
  {
    rule_code: "product_price_approval_rule",
    rule_name: "产品改价审批规则",
    rule_json: {
      category: "approval_trigger",
      businessType: "product_price",
      targetAction: "product_list.edit",
      triggerApprovalFlow: "product_price_approval",
      conditions: [
        { field: "unit_price", operator: "!=", valueField: "old_unit_price", message: "产品单价变更时进入价格审批" }
      ]
    }
  },
  {
    rule_code: "charge_reverse_approval_rule",
    rule_name: "撤销扣费审批规则",
    rule_json: {
      category: "approval_trigger",
      businessType: "charge_reverse",
      targetAction: "charge_record.reverse",
      triggerApprovalFlow: "charge_reverse_approval",
      conditions: [
        { field: "charge_amount", operator: ">", value: 0, message: "撤销已扣费记录时进入冲销审批" }
      ]
    }
  },
  {
    rule_code: "prestore_funds_rule",
    rule_name: "预存款入账规则",
    rule_json: {
      category: "funds_allocation",
      businessType: "funds",
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
    rule_code: "course_cancel_rule",
    rule_name: "课程取消规则",
    rule_json: {
      category: "workflow",
      businessType: "course_cancel",
      targetAction: "course_list.cancel",
      allowAfterFinished: false,
      requireApprovalFlow: "course_cancel_approval"
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
    status: "ACTIVE",
    config_json: {
      resourceType: "approval_flow",
      flowCode: "contract_discount_approval",
      flowName: "合同优惠审批",
      moduleCode: "finance",
      businessType: "contract",
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
    status: "ACTIVE",
    config_json: {
      resourceType: "approval_flow",
      flowCode: "lead_enroll_approval",
      flowName: "新生报名审批",
      moduleCode: "recruit",
      businessType: "lead_enroll",
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
    status: "ACTIVE",
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
    flow_code: "funds_create_approval",
    flow_name: "收款审批",
    module_code: "finance",
    status: "ACTIVE",
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
    status: "ACTIVE",
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
    status: "ACTIVE",
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
    flow_code: "course_cancel_approval",
    flow_name: "课程取消审批",
    module_code: "education",
    status: "ACTIVE",
    config_json: {
      resourceType: "approval_flow",
      flowCode: "course_cancel_approval",
      flowName: "课程取消审批",
      moduleCode: "education",
      businessType: "course_cancel",
      trigger: { event: "course_cancel_submit", pageCode: "course_list" },
      steps: [
        { stepCode: "teacher_submit", stepName: "老师提交", assigneeRole: "TEACHER" },
        { stepCode: "principal_review", stepName: "校长审批", assigneeRole: "PRINCIPAL" }
      ],
      afterApproved: [{ type: "enable_action", actionCode: "course_list.cancel" }]
    }
  },
  {
    flow_code: "charge_reverse_approval",
    flow_name: "撤销扣费审批",
    module_code: "education",
    status: "ACTIVE",
    config_json: {
      resourceType: "approval_flow",
      flowCode: "charge_reverse_approval",
      flowName: "撤销扣费审批",
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
    status: "ACTIVE",
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
  lead_list: "# 新生报名\n\n## 功能描述\n按报名流程完成学员信息、报读课程、业务属性和结算，支持线索跟进和转化。\n\n## 使用说明\n- 点击「新增报名」打开全屏报名弹窗\n- 填写学员信息、选择报读课程和优惠方案\n- 线索状态学员可通过行操作「新增合同」完成转化\n\n## 注意事项\n- 线索学员不会出现在学员列表中\n- 合同创建后自动关联优惠分配规则",
  student_list: "# 学员列表\n\n## 功能描述\n统一维护学员档案、校区归属、学校年级和跟进入口，支持预存操作。\n\n## 使用说明\n- 支持按姓名、电话、状态、学校筛选\n- 行操作支持详情、编辑、预存、删除\n- 预存操作直接为学员充值电子账户\n\n## 注意事项\n- 正式学员和线索学员分开管理\n- 删除操作为软删除",
  student_followup_list: "# 跟进记录\n\n## 功能描述\n记录学员跟进历史，包括电话、到访、微信等多种跟进方式。\n\n## 使用说明\n- 按学员维度查看跟进记录\n- 支持设置下次跟进时间\n\n## 注意事项\n- 跟进记录不可删除，仅可新增",
  course_list: "# 排课列表\n\n## 功能描述\n查看课程安排、上课时间和课程状态，支持一对一、小班、一对N等多种课程类型。\n\n## 使用说明\n- 点击「新增排课」创建课程\n- 支持按课程名称和状态筛选\n- 课程状态包括待上课、已完成、已取消\n\n## 注意事项\n- 排课冲突规则会阻止老师时间冲突\n- 已取消课程不可扣费",
  charge_record: "# 扣费记录\n\n## 功能描述\n管理学员上课扣费，支持实收扣费、优惠扣费和赠课扣费。\n\n## 使用说明\n- 点击「新增扣费」选择课程和合同产品\n- 支持扣费撤销操作\n- 扣费自动更新合同产品余额\n\n## 注意事项\n- 余额不足时扣费会被拒绝\n- 撤销扣费会恢复合同产品余额",
  contract_list: "# 合同列表\n\n## 功能描述\n跟踪合同状态、应收实收和付款进度，支持合同收款操作。\n\n## 使用说明\n- 点击「新增合同」创建合同\n- 行操作支持收款、详情、编辑\n- 合同自动关联优惠分配\n\n## 注意事项\n- 收款后自动触发资金分配规则\n- 付款状态根据实收金额自动更新",
  contract_product_list: "# 合同产品\n\n## 功能描述\n查看合同关联的产品信息，包括剩余课时、剩余金额等。\n\n## 使用说明\n- 按合同维度查看产品列表\n- 显示实时剩余课时和金额\n\n## 注意事项\n- 剩余数据由扣费和退费操作自动维护",
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
