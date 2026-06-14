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
  ["system", "系统", "platform", "组织、角色和权限", 80, "Settings"],
  ["ai_agent", "AI 工程化", "platform", "自然语言变更任务", 90, "Bot"]
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
  fixedFilters?: Array<{ field: string; op?: "eq" | "ne"; value: unknown }>;
  sort?: string;
  apiFilters?: string[];
  commands?: Partial<Record<"create", { command: string; ruleCode: string }>>;
};

const statusFields = new Set([
  "status",
  "student_status",
  "paid_status",
  "contract_status",
  "course_status",
  "charge_status",
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
  tenant_manage: "管理机构租户、到期状态和负责人信息",
  agent_task: "跟踪自然语言变更任务和草稿结果"
};

const statusMap = {
  student_status: { FORMAL: "green", LEAD: "blue", LOST: "gray" },
  paid_status: { PAID: "green", PART_PAID: "amber", UNPAID: "red", REFUNDED: "gray" },
  contract_status: { ACTIVE: "green", CLOSED: "gray", CANCELLED: "red" },
  course_status: { SCHEDULED: "blue", FINISHED: "green", CANCELLED: "red" },
  charge_status: { CONFIRMED: "green", PENDING: "amber", REVERSED: "gray" },
  status: { ACTIVE: "green", PUBLISHED: "blue", draft: "amber", active: "green", archived: "gray" },
  mode: { draft: "amber", publish_after_confirm: "blue" }
};

const valueLabels = {
  student_status: { FORMAL: "正式", LEAD: "线索", LOST: "流失" },
  paid_status: { PAID: "已付清", PART_PAID: "部分付款", UNPAID: "未付款", REFUNDED: "已退费" },
  contract_status: { ACTIVE: "生效中", CLOSED: "已结清", CANCELLED: "已取消" },
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
  change_type: { PRESTORE_IN: "预存入账", CONTRACT_PAY_OUT: "合同扣款", REFUND_IN: "退费入账" }
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

function fieldComponent(field: Field) {
  return isLongTextField(field)
    ? { type: "textarea", span: "full" as const, rows: 4 }
    : { type: field.type ?? "text" };
}

const contractCreateFields = [
  { key: "student_id", label: "选择学员", type: "text", optionSource: allStudentSelect },
  { key: "product_ids", label: "报读课程", type: "multiSelect", span: 2 as const, optionSource: productSelect },
  { key: "promotion_id", label: "合同优惠", type: "text", optionSource: promotionSelect },
  { key: "contract_type", label: "合同类型", type: "text" },
  { key: "organization_id", label: "校区", type: "text", optionSource: orgSelect },
  { key: "sign_staff_id", label: "签约人", type: "text", optionSource: userSelect },
  { key: "sign_time", label: "签约时间", type: "datetime" },
  { key: "total_amount", label: "手工应收", type: "number" },
  { key: "promotion_amount", label: "手工优惠", type: "number" },
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

const courseCreateFields = [
  { key: "course_title", label: "课程名称", type: "text", span: 2 as const },
  { key: "course_type", label: "课程类型", type: "text" },
  { key: "course_date", label: "上课日期", type: "date" },
  { key: "start_time", label: "开始时间", type: "text" },
  { key: "end_time", label: "结束时间", type: "text" },
  { key: "teacher_id", label: "老师", type: "text", optionSource: userSelect },
  { key: "study_manager_id", label: "学管师", type: "text", optionSource: userSelect },
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
    module: "recruit",
    feature: "lead_list",
    page: "lead_list",
    name: "新生报名",
    table: "student",
    group: "招生管理",
    fields: [
      { key: "name", label: "姓名", filter: true },
      { key: "contact", label: "电话", filter: true },
      { key: "source_type", label: "来源" },
      { key: "student_status", label: "状态", filter: true }
    ],
    fixedFilters: [{ field: "student_status", op: "eq", value: "LEAD" }]
  },
  {
    module: "student",
    feature: "student_list",
    page: "student_list",
    name: "学员列表",
    table: "student",
    group: "学员管理",
    fields: [
      { key: "name", label: "学员姓名", filter: true, sortable: true },
      { key: "contact", label: "联系电话", filter: true },
      { key: "organization_name", label: "校区" },
      { key: "organization_id", label: "校区ID", hidden: true },
      { key: "student_status", label: "状态", filter: true },
      { key: "school_name", label: "学校名称", filter: true },
      { key: "grade", label: "年级" }
    ],
    joins: [
      {
        table: "organization",
        alias: "org",
        on: { left: "organization_id", right: "id" },
        fields: [{ source: "name", as: "organization_name" }]
      }
    ],
    fixedFilters: [{ field: "student_status", op: "ne", value: "LEAD" }]
  },
  {
    module: "student",
    feature: "student_followup_list",
    page: "student_followup_list",
    name: "跟进记录",
    table: "student_followup",
    apiFilters: ["id"],
    group: "学员管理",
    fields: [
      { key: "student_name", label: "学员" },
      { key: "follow_type", label: "跟进方式", filter: true },
      { key: "follow_content", label: "内容" },
      { key: "next_follow_time", label: "下次跟进", type: "datetime" }
    ],
    joins: [
      { table: "student", alias: "stu", on: { left: "student_id", right: "id" }, fields: [{ source: "name", as: "student_name" }] }
    ]
  },
  {
    module: "education",
    feature: "course_list",
    page: "course_list",
    name: "排课列表",
    table: "generic_course",
    commands: { create: { command: "course.create", ruleCode: "course_create_rule" } },
    group: "教务管理",
    fields: [
      { key: "course_title", label: "课程名称", filter: true },
      { key: "course_type", label: "课程类型" },
      { key: "course_date", label: "上课日期", type: "date", sortable: true },
      { key: "start_time", label: "开始" },
      { key: "end_time", label: "结束" },
      { key: "course_status", label: "状态", filter: true }
    ]
  },
  {
    module: "education",
    feature: "charge_record",
    page: "charge_record",
    name: "扣费记录",
    table: "account_charge_records",
    commands: { create: { command: "chargeRecord.create", ruleCode: "charge_create_rule" } },
    group: "消课扣费",
    fields: [
      { key: "student_name", label: "学员" },
      { key: "charge_type", label: "扣费类型" },
      { key: "charge_hour", label: "课时" },
      { key: "charge_amount", label: "金额" },
      { key: "charge_status", label: "状态", filter: true }
    ],
    joins: [
      { table: "student", alias: "stu", on: { left: "student_id", right: "id" }, fields: [{ source: "name", as: "student_name" }] }
    ]
  },
  {
    module: "finance",
    feature: "contract_product_list",
    page: "contract_product_list",
    name: "合同产品",
    table: "contract_product",
    group: "合同收费",
    fields: [
      { key: "contract_no", label: "合同编号", filter: true },
      { key: "product_name", label: "产品" },
      { key: "remaining_real_hour", label: "剩余课时" },
      { key: "remaining_real_amount", label: "剩余金额" },
      { key: "remaining_promotion_hour", label: "剩余赠课" },
      { key: "remaining_promotion_amount", label: "剩余优惠" }
    ],
    joins: [
      { table: "contract", alias: "c", on: { left: "contract_id", right: "id" }, fields: [{ source: "id", as: "contract_no" }] },
      { table: "product", alias: "p", on: { left: "product_id", right: "id" }, fields: [{ source: "name", as: "product_name" }] }
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
      { key: "contract_id", label: "合同ID" },
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
      { key: "role_code", label: "角色编码" },
      { key: "organization_id", label: "所属校区" }
    ]
  }
];

export const adminPages: PageSeed[] = [
  {
    module: "system",
    feature: "tenant_manage",
    page: "tenant_manage",
    name: "租户管理",
    table: "tenant_manage",
    fields: [
      { key: "name", label: "机构名称", filter: true },
      { key: "schema_name", label: "Schema" },
      { key: "status", label: "状态" },
      { key: "owner_name", label: "负责人" },
      { key: "expire_time", label: "到期时间", type: "datetime" }
    ]
  },
  {
    module: "ai_agent",
    feature: "agent_task",
    page: "agent_task",
    name: "AI 变更任务",
    table: "agent_task",
    fields: [
      { key: "user_prompt", label: "需求" },
      { key: "mode", label: "模式" },
      { key: "status", label: "状态" },
      { key: "created_at", label: "创建时间", type: "datetime" }
    ]
  },
  {
    module: "ai_agent",
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
    toolbar: [
      { actionCode: `${page.page}.create`, label: "新增", type: "open_modal", variant: "primary" },
      { actionCode: `${page.page}.refresh`, label: "刷新", type: "execute_api", variant: "default" }
    ],
    table: {
      rowKey: "id",
      columns: page.fields.map((field) => ({
        key: field.key,
        title: field.label,
        type: field.type ?? "text",
        sortable: Boolean(field.sortable),
        width: columnWidth(field),
        align: columnAlign(field),
        badge: field.badge ?? statusFields.has(field.key)
      })).filter((field) => !page.fields.find((source) => source.key === field.key)?.hidden),
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
        fields: preStoreFields,
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
        fields: fundsCreateFields,
        defaultValues: { funds_type: "CONTRACT_PAY", transaction_time: new Date().toISOString().slice(0, 16), pay_way_config_id: "pay_cash" },
        mapRowToValue: { contract_id: "id", student_id: "student_id", organization_id: "organization_id" }
      },
      { actionCode: "contract_list.delete", label: "删除", type: "execute_api", confirm: "确认删除这条记录？" }
    ];
    baseDsl.presentation.table.primaryRowActions = ["contract_list.detail", "contract_list.edit", "contract_list.funds", "contract_list.delete"];
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
    baseDsl.modal.fields = courseCreateFields;
  }

  if (page.page === "charge_record") {
    baseDsl.toolbar = [
      { actionCode: "charge_record.create", label: "新增扣费", type: "open_modal", variant: "primary", modalTitle: "新增扣费", fields: chargeCreateFields, defaultValues: { charge_type: "NORMAL", charge_hour: 1 } },
      { actionCode: "charge_record.refresh", label: "刷新", type: "execute_api", variant: "default" }
    ];
    baseDsl.modal.fields = chargeCreateFields;
  }

  if (page.page === "refund_record") {
    baseDsl.toolbar = [
      { actionCode: "refund_record.create", label: "新增退费", type: "open_modal", variant: "primary", modalTitle: "新增退费", fields: refundCreateFields, defaultValues: { refund_time: new Date().toISOString().slice(0, 16), refund_way_config_id: "pay_cash" } },
      { actionCode: "refund_record.refresh", label: "刷新", type: "execute_api", variant: "default" }
    ];
    baseDsl.modal.fields = refundCreateFields;
  }

  if (page.page === "funds_history") {
    baseDsl.toolbar = [
      { actionCode: "funds_history.create", label: "新增收款/预存", type: "open_modal", variant: "primary", modalTitle: "新增收款/预存", fields: fundsCreateFields, defaultValues: { funds_type: "PRE_STORE", transaction_time: new Date().toISOString().slice(0, 16), pay_way_config_id: "pay_cash" } },
      { actionCode: "funds_history.refresh", label: "刷新", type: "execute_api", variant: "default" }
    ];
    baseDsl.modal.fields = fundsCreateFields;
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
              label: "潜在学员",
              source: "countBy",
              field: "student_status",
              value: "LEAD",
              target: { pageCode: "lead_list", title: "潜在学员" }
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
  if (command) {
    return {
      operation: "command",
      command: command.command,
      ruleCode: command.ruleCode
    };
  }
  return {
    table: page.table,
    joins: page.joins ?? [],
    operation: apiType,
    softDelete: true,
    allowedFields: page.fields.filter((field) => !joinAliases.has(field.key)).map((field) => field.key),
    filters: [...new Set([...page.fields.filter((field) => field.filter).map((field) => field.key), ...(page.apiFilters ?? [])])],
    fixedFilters: page.fixedFilters ?? [],
    sort: page.sort ?? "created_at desc",
    pagination: true
  };
}

export const businessRules = [
  {
    rule_code: "contract_create_rule",
    rule_name: "签合同优惠分配规则",
    rule_json: {
      promotionAllocation: "proportional",
      requireAtLeastOneProduct: true,
      snapshotPromotion: true
    }
  },
  {
    rule_code: "funds_create_rule",
    rule_name: "收款资金分配规则",
    rule_json: {
      fundsAllocation: "oldest_first",
      updateContractPaidStatus: true,
      allowPreStoreWithoutContract: true
    }
  },
  {
    rule_code: "course_create_rule",
    rule_name: "排课冲突规则",
    rule_json: {
      preventTeacherTimeConflict: true,
      preventInvalidTimeRange: true,
      defaultCourseStatus: "SCHEDULED"
    }
  },
  {
    rule_code: "charge_create_rule",
    rule_name: "考勤扣费规则",
    rule_json: {
      defaultChargeType: "NORMAL",
      allowNegativeBalance: false,
      updateContractProductBalance: true
    }
  },
  {
    rule_code: "refund_create_rule",
    rule_name: "退费规则",
    rule_json: {
      allowRefundOverBalance: false,
      updateContractProductBalance: true,
      updateContractPaidStatus: true
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
  base_url: env.llm.baseUrl,
  api_key_cipher: env.llm.apiKey ? Buffer.from(env.llm.apiKey).toString("base64") : "",
  api_key_masked: maskApiKey(env.llm.apiKey),
  model: env.llm.model,
  provider: "openai-compatible",
  source_env_keys: ["LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL"]
};
