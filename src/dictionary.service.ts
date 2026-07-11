import { pool } from "./db/pool.js";

type DictionaryItemInput = {
  id?: string;
  dictCode?: string;
  itemValue?: string;
  itemLabel?: string;
  sortNo?: number;
  status?: string;
  metadata?: Record<string, unknown>;
};

export const SYSTEM_DICTIONARIES: Record<string, Record<string, { label: string; metadata?: Record<string, unknown> }>> = {
  student_status: { FORMAL: { label: "正式", metadata: { tone: "green" } }, LEAD: { label: "意向", metadata: { tone: "blue" } }, LOST: { label: "流失", metadata: { tone: "gray" } } },
  paid_status: { PAID: { label: "已付清", metadata: { tone: "green" } }, PART_PAID: { label: "部分付款", metadata: { tone: "amber" } }, UNPAID: { label: "未付款", metadata: { tone: "red" } }, REFUNDED: { label: "已退费", metadata: { tone: "gray" } } },
  contract_status: {
    ACTIVE: { label: "生效中", metadata: { tone: "green", businessState: true, transitionPolicy: "command_controlled", systemSemantic: "effective" } },
    CLOSED: { label: "已结清", metadata: { tone: "gray", businessState: true, transitionPolicy: "command_controlled", terminal: true } },
    CANCELLED: { label: "已取消", metadata: { tone: "red", businessState: true, transitionPolicy: "command_controlled", terminal: true } },
    REFUNDED: { label: "已退费", metadata: { tone: "amber", businessState: true, transitionPolicy: "command_controlled", terminal: true } }
  },
  course_status: { SCHEDULED: { label: "待上课", metadata: { tone: "blue" } }, FINISHED: { label: "已完成", metadata: { tone: "green", businessSemantic: "finished" } }, CANCELLED: { label: "已取消", metadata: { tone: "gray", businessSemantic: "cancelled" } } },
  charge_status: { CONFIRMED: { label: "已确认", metadata: { tone: "green", businessSemantic: "charged" } }, PENDING: { label: "待确认", metadata: { tone: "amber" } }, REVERSED: { label: "已撤销", metadata: { tone: "gray" } } },
  attendance_status: { PENDING: { label: "待签到", metadata: { tone: "amber" } }, PRESENT: { label: "已签到", metadata: { tone: "green" } }, ABSENT: { label: "缺勤", metadata: { tone: "red" } }, LEAVE: { label: "请假", metadata: { tone: "gray" } } },
  approval_status: { PENDING: { label: "审批中", metadata: { tone: "amber" } }, APPROVED: { label: "已通过", metadata: { tone: "green" } }, REJECTED: { label: "已驳回", metadata: { tone: "red" } }, CANCELED: { label: "已撤回", metadata: { tone: "gray" } } },
  approval_flow_status: { ACTIVE: { label: "已开启", metadata: { tone: "green" } }, INACTIVE: { label: "已关闭", metadata: { tone: "gray" } } },
  status: { ACTIVE: { label: "启用", metadata: { tone: "green" } }, INACTIVE: { label: "停用" }, ENABLED: { label: "启用" }, DISABLED: { label: "停用" }, PUBLISHED: { label: "已发布", metadata: { tone: "blue" } }, DRAFT: { label: "草稿" }, draft: { label: "草稿", metadata: { tone: "amber" } }, active: { label: "生效", metadata: { tone: "green" } }, archived: { label: "归档", metadata: { tone: "gray" } }, rejected: { label: "已驳回" }, pending: { label: "待处理" }, success: { label: "成功" }, failed: { label: "失败" }, running: { label: "执行中" }, skipped: { label: "已跳过" }, APPROVED: { label: "已通过" }, REJECTED: { label: "已拒绝" }, CANCELED: { label: "已取消" } },
  mode: { draft: { label: "草稿" }, publish_after_confirm: { label: "确认后发布", metadata: { tone: "blue" } }, import: { label: "导入" }, validate: { label: "校验" } },
  staff_type: { MANAGER: { label: "校长" }, TEACHER: { label: "老师" }, STUDY_MANAGER: { label: "学管师" }, SALES: { label: "顾问" } },
  grade: { PRESCHOOL: { label: "幼儿园" }, GRADE_1: { label: "一年级" }, GRADE_2: { label: "二年级" }, GRADE_3: { label: "三年级" }, GRADE_4: { label: "四年级" }, GRADE_5: { label: "五年级" }, GRADE_6: { label: "六年级" }, GRADE_7: { label: "初一" }, GRADE_8: { label: "初二" }, GRADE_9: { label: "初三" }, GRADE_10: { label: "高一" }, GRADE_11: { label: "高二" }, GRADE_12: { label: "高三" }, ADULT: { label: "成人" } },
  subject: { CHINESE: { label: "语文" }, MATH: { label: "数学" }, ENGLISH: { label: "英语" }, PHYSICS: { label: "物理" }, CHEMISTRY: { label: "化学" }, BIOLOGY: { label: "生物" }, HISTORY: { label: "历史" }, GEOGRAPHY: { label: "地理" }, POLITICS: { label: "政治" }, SCIENCE: { label: "科学" }, ART: { label: "美术" }, MUSIC: { label: "音乐" }, SPORTS: { label: "体育" }, OTHER: { label: "其他" } },
  gender: { MALE: { label: "男" }, FEMALE: { label: "女" }, UNKNOWN: { label: "未知" } },
  organization_type: { HEAD: { label: "总部" }, BRANCH: { label: "校区" }, DEPARTMENT: { label: "部门" }, TENANT: { label: "机构" }, CAMPUS: { label: "校区" }, COMPANY: { label: "分公司" }, CUSTOM: { label: "自定义架构" } },
  contract_type: { NEW_SIGN: { label: "新签" }, RENEWAL: { label: "续费" }, REFERRAL: { label: "引流" } },
  course_type: { ONE_ON_ONE_COURSE: { label: "一对一" }, SMALL_CLASS: { label: "小班" }, ONE_ON_N_GROUP: { label: "一对N" } },
  product_type: { ONE_ON_ONE_COURSE: { label: "一对一" }, SMALL_CLASS: { label: "小班" }, ONE_ON_N_GROUP: { label: "一对N" } },
  funds_type: { CONTRACT_PAY: { label: "合同收款" }, PRE_STORE: { label: "预存" } },
  charge_type: { NORMAL: { label: "实收扣费" }, PROMOTION: { label: "优惠扣费" }, PROMOTION_HOUR: { label: "赠课扣费" }, MAKE_UP: { label: "补课扣费" }, REFUND_REVERSE: { label: "退费冲销" } },
  pay_way_type: { CASH: { label: "现金" }, WECHAT: { label: "微信" }, ALIPAY: { label: "支付宝" }, ELE_ACCOUNT: { label: "电子账户" } },
  promotion_type: { REDUCE: { label: "立减" }, DISCOUNT: { label: "折扣" } },
  follow_type: { PHONE: { label: "电话" }, VISIT: { label: "到访" }, WECHAT: { label: "微信" } },
  follow_result: { CONTACTED: { label: "已联系" }, NO_ANSWER: { label: "未接通" }, INTERESTED: { label: "有意向" }, NOT_INTERESTED: { label: "无意向" } },
  source_type: { REFERRAL: { label: "转介绍" }, WALK_IN: { label: "到访" }, ONLINE: { label: "线上" }, MANUAL: { label: "手工录入" }, MANUAL_ADJUSTMENT: { label: "手工调整" } },
  channel_type: { ONLINE: { label: "线上" }, REFERRAL: { label: "转介绍" }, OFFLINE: { label: "线下" } },
  trial_status: { SCHEDULED: { label: "已预约" }, FINISHED: { label: "已试听" }, COMPLETED: { label: "已试听" }, CANCELLED: { label: "已取消" } },
  conversion_status: { PENDING: { label: "待转化" }, CONVERTED: { label: "已转化" }, LOST: { label: "未转化" } },
  task_type: { FOLLOWUP: { label: "跟进" }, TRIAL_FOLLOWUP: { label: "试听跟进" } },
  task_status: { PENDING: { label: "待处理" }, COMPLETED: { label: "已完成" }, CANCELED: { label: "已取消" } },
  lead_stage: { NEW: { label: "新线索" }, FOLLOWING: { label: "跟进中" }, TRIAL_SCHEDULED: { label: "已邀约试听" }, TRIAL_COMPLETED: { label: "已试听" }, CONVERTED: { label: "已转化" }, LOST: { label: "已流失" } },
  lead_assignment_action_type: { ASSIGN: { label: "分配" }, TRANSFER: { label: "转移" }, RECLAIM: { label: "回收" } },
  business_rule_category: { funds_allocation: { label: "资金分配" }, promotion_allocation: { label: "优惠分配" }, performance_allocation: { label: "业绩分配" }, approval_trigger: { label: "审批触发" }, validation: { label: "校验规则" }, workflow: { label: "业务流转" }, refund: { label: "退费规则" }, charge: { label: "扣费规则" }, attendance: { label: "考勤规则" } },
  business_type: { contract_create: { label: "新增合同" }, contract_update: { label: "编辑合同" }, funds_create: { label: "新增收款" }, course_create: { label: "新增排课" }, course_delete: { label: "删除排课" }, holiday_course_impact: { label: "停课处理" }, attendance: { label: "考勤签到" }, charge: { label: "扣费确认" }, charge_reverse: { label: "取消扣费" }, refund_create: { label: "新增退费" }, contract_refund: { label: "合同退费" }, product_price: { label: "编辑产品" }, performance: { label: "业绩分配" }, performance_adjust: { label: "业绩调整" }, leave: { label: "请假" }, makeup: { label: "补课" } },
  action_type: { open_page: { label: "打开页面" }, execute_api: { label: "执行接口" }, open_modal: { label: "打开弹窗" }, open_ai_customization: { label: "AI 定制" }, dropdown: { label: "下拉菜单" }, input: { label: "输入" }, display: { label: "展示" }, tab: { label: "页签" }, export: { label: "导出" }, import: { label: "导入" } },
  api_type: { query: { label: "查询" }, detail: { label: "详情" }, create: { label: "新增" }, update: { label: "更新" }, delete: { label: "删除" }, command: { label: "命令" } },
  resource_type: { page: { label: "页面" }, action: { label: "动作" }, field: { label: "字段" } },
  page_permission: { read: { label: "只读" }, all: { label: "全部操作" } },
  data_permission: { self_only: { label: "本人创建" }, own_organization: { label: "当前管理架构" }, organization_or_sub: { label: "当前管理架构及下级" }, own_students: { label: "负责学员" }, own_courses: { label: "负责课程" }, all: { label: "全部数据" } },
  organization_scope: { role_organization: { label: "角色组织" }, all: { label: "全部" } },
  receiver_scope: { student: { label: "学员" }, staff: { label: "员工" }, all: { label: "全部" } },
  pay_type: { PREPAID: { label: "预付" }, POSTPAID: { label: "后付" }, TRIAL: { label: "试用" } },
  cost_type: { ONLINE_ADS: { label: "线上投放" }, OFFLINE: { label: "线下成本" }, OTHER: { label: "其他" } },
  target_status: { FULL: { label: "已满" }, CLOSED: { label: "已关闭" }, ACTIVE: { label: "启用" } },
  funds_allocation_method: { byCpPaidRatio: { label: "按合同产品应收比例" }, byCpRemainingAmount: { label: "按合同产品剩余金额比例" }, oldestContractFirst: { label: "优先最早合同" }, manual: { label: "手工分配" } },
  allocation_split_by: { contract_product: { label: "合同产品" }, contract: { label: "合同" }, organization: { label: "校区" }, product_type: { label: "产品类型" } },
  generated_log_table: { money_arrange_log: { label: "资金分配记录" }, promotion_arrange_log: { label: "优惠分配记录" }, performance_arrange_log: { label: "业绩分配记录" } },
  performance_allocation_method: { byCpPaidRatio: { label: "按合同产品实收比例" }, byCpReceivableRatio: { label: "按合同产品应收比例" }, oneToOneFirst: { label: "优先一对一" }, classCourseFirst: { label: "优先班课" }, salesOwnerOnly: { label: "归属签约顾问" } },
  product_priority: { none: { label: "不区分" }, oneToOneFirst: { label: "一对一优先" }, classCourseFirst: { label: "班课优先" }, oneOnNFirst: { label: "一对N优先" } },
  promotion_allocation_method: { byCpAmountRatio: { label: "按合同产品金额比例" }, byCpHourRatio: { label: "按合同产品课时比例" }, oneToOneFirst: { label: "优先一对一产品" }, classCourseFirst: { label: "优先班课产品" }, manual: { label: "手工分配" } },
  refund_allocation_method: { byCpRemainingAmount: { label: "按产品剩余金额比例" }, originalPaymentReverse: { label: "按原收款反向冲减" }, manual: { label: "手工指定" } },
  record_type: { customization: { label: "AI 定制" }, assistant: { label: "AI 助手" } },
  change_type: { PRESTORE_IN: { label: "预存入账" }, CONTRACT_PAY_OUT: { label: "合同扣款" }, REFUND_IN: { label: "退费入账" }, PRESTORE_DELETE: { label: "删除预存" }, CONTRACT_PAY_DELETE: { label: "删除合同扣款" }, REFUND_DELETE: { label: "删除退费" }, update: { label: "更新" }, rollback: { label: "回滚" }, init: { label: "初始化" } },
  refund_type: { CONTRACT_PRODUCT: { label: "合同产品退费" }, CONTRACT: { label: "合同退费" } },
  target_type: { bundle: { label: "整包配置" }, page: { label: "页面" }, action: { label: "按钮动作" }, api: { label: "接口" }, modal: { label: "弹窗" }, skill: { label: "技能" }, import: { label: "导入" }, report: { label: "报表" }, business_rule: { label: "业务规则" }, print_template: { label: "打印模板" }, page_dsl: { label: "页面" }, api_dsl: { label: "接口" }, action_dsl: { label: "按钮动作" }, skill_registry: { label: "技能" }, import_dsl: { label: "导入" }, report_dsl: { label: "报表" }, db_schema: { label: "数据表" }, permission_policy: { label: "权限策略" }, approval_flow: { label: "审批流" }, feature_registry: { label: "功能" }, mini_class: { label: "小班" }, one_on_n_group: { label: "1对N小组" } },
  schema_scope: { tenant: { label: "机构模板/租户自定义" }, admin: { label: "平台管理" } },
  source_label: { 租户自定义: { label: "租户自定义" }, 模板机构: { label: "模板机构" } },
  account_type: { DEFAULT: { label: "默认账户" } },
  leave_type: { PERSONAL: { label: "事假" }, SICK: { label: "病假" }, OTHER: { label: "其他" } },
  holiday_type: { CAMPUS_CLOSED: { label: "校区停课" }, PUBLIC_HOLIDAY: { label: "节假日" }, OTHER: { label: "其他" } },
  performance_type: { SALES: { label: "销售业绩" }, MANUAL_ADJUST: { label: "手工调整" }, SALES_REVERSE: { label: "销售业绩冲减" } },
  goods_status: { ON_SALE: { label: "上架中" }, OFF_SALE: { label: "已下架" } },
  activity_type: { SECKILL: { label: "秒杀" }, GROUP_BUY: { label: "拼团" }, NORMAL: { label: "普通活动" } },
  group_status: { OPEN: { label: "拼团中" }, SUCCESS: { label: "已成团" }, CLOSED: { label: "已关闭" } },
  member_status: { JOINED: { label: "已参团" }, LEFT: { label: "已退出" } },
  order_status: { CREATED: { label: "已创建" }, PAID: { label: "已支付" }, CLOSED: { label: "已关闭" }, REFUNDED: { label: "已退款" } },
  service_type: { SERVICE_ACCOUNT: { label: "服务号" }, SUBSCRIPTION_ACCOUNT: { label: "订阅号" } },
  binding_type: { PUBLIC: { label: "公有服务号" }, PRIVATE: { label: "自有公众号" } },
  authorized_status: { AUTHORIZED: { label: "已授权" }, UNAUTHORIZED: { label: "未授权" }, EXPIRED: { label: "已过期" } },
  publish_status: { DRAFT: { label: "草稿" }, PUBLISHED: { label: "已发布" }, FAILED: { label: "发布失败" } },
  subscribe_status: { SUBSCRIBED: { label: "已关注" }, UNSUBSCRIBED: { label: "已取关" } },
  send_status: { PENDING: { label: "待发送" }, SUCCESS: { label: "发送成功" }, FAILED: { label: "发送失败" } },
  reward_status: { PENDING: { label: "待处理" }, LOCKED: { label: "锁定中" }, ELIGIBLE: { label: "可发放" }, ISSUED: { label: "已发放" } },
  payment_status: { PENDING: { label: "待支付" }, PAID: { label: "已支付" }, FAILED: { label: "支付失败" }, CLOSED: { label: "已关闭" }, REFUNDED: { label: "已退款" } },
  organization_performance_owner: { contractOrganization: { label: "合同所属校区" }, courseOrganization: { label: "上课校区" }, receiptOrganization: { label: "收款校区" } },
  personal_performance_owner: { signStaff: { label: "签约顾问" }, ownerStaff: { label: "学员归属顾问" }, classTeacher: { label: "任课老师" }, splitByProductOwner: { label: "按产品归属人拆分" } },
  business_action_code: { "lead_list.enroll": { label: "新增报名" }, "contract_list.create": { label: "新增合同" }, "funds_history.create": { label: "新增收款" }, "refund_record.create": { label: "新增退费" }, "course_list.create": { label: "新增排课" }, "course_list.delete": { label: "删除排课" }, "course_holiday_calendar.cancelCourses": { label: "批量取消课程" }, "course_holiday_calendar.postponeCourses": { label: "批量顺延课程" }, "charge_record.create": { label: "扣费确认" }, "charge_record.reverse": { label: "取消扣费" }, "product_list.edit": { label: "编辑产品" }, "contract_list.delete": { label: "作废合同" } },
  approval_flow_code: { contract_discount_approval: { label: "合同优惠审批" }, refund_create_approval: { label: "退费审批" }, course_delete_approval: { label: "删除排课审批" }, charge_reverse_approval: { label: "取消扣费审批" }, product_price_approval: { label: "产品价格审批" } },
  approval_trigger_event: { contract_discount_submit: { label: "合同优惠提交" }, lead_enroll_submit: { label: "新生报名提交" }, contract_create_submit: { label: "合同创建提交" }, funds_create_submit: { label: "收款提交" }, refund_create_submit: { label: "退费提交" }, course_create_submit: { label: "排课提交" }, course_delete_submit: { label: "删除排课提交" }, charge_reverse_submit: { label: "取消扣费提交" }, product_price_change_submit: { label: "产品改价提交" } },
  approval_trigger_page: { contract_list: { label: "合同列表" }, lead_list: { label: "新生报名" }, funds_history: { label: "收款记录" }, refund_record: { label: "退费记录" }, course_list: { label: "排课列表" }, charge_record: { label: "扣费记录" }, product_list: { label: "产品列表" } },
  approval_action_code: { "contract_list.funds": { label: "允许合同收款" }, "contract_list.create": { label: "允许新增合同" }, "lead_list.enroll": { label: "允许报名转化" }, "funds_history.create": { label: "允许新增收款" }, "refund_record.create": { label: "允许新增退费" }, "course_list.create": { label: "允许新增排课" }, "course_list.delete": { label: "允许删除排课" }, "charge_record.reverse": { label: "允许取消扣费" }, "product_list.edit": { label: "允许编辑产品" } },
  approval_role: { PRINCIPAL: { label: "校长" }, MANAGER: { label: "校长" }, SALES: { label: "顾问" }, TEACHER: { label: "老师" }, STUDY_MANAGER: { label: "学管师" } },
  rule_condition_field: { transaction_amount: { label: "收款金额" }, refund_real_amount: { label: "退费金额" }, charge_amount: { label: "扣费金额" }, promotion_amount: { label: "优惠金额" }, unit_price: { label: "产品单价" }, old_unit_price: { label: "原产品单价" }, start_time: { label: "开始时间" }, end_time: { label: "结束时间" }, teacher_id: { label: "授课老师" }, student_id: { label: "上课学员" }, course_date: { label: "上课日期" } },
  rule_system_value: { start_time: { label: "开始时间" }, end_time: { label: "结束时间" }, old_unit_price: { label: "原产品单价" }, "course_date,start_time,end_time": { label: "同一天同时间段" }, "teacher_course_date,start_time,end_time": { label: "老师同一天同时间段" }, "student_course_date,start_time,end_time": { label: "学员同一天同时间段" } },
  rule_operator: { ">": { label: "大于" }, ">=": { label: "大于等于" }, "<": { label: "小于" }, "<=": { label: "小于等于" }, "=": { label: "等于" }, "!=": { label: "不等于" }, no_time_overlap: { label: "不可时间冲突" }, lt: { label: "小于" }, unique_combo: { label: "组合不可重复" } },
  fulfillment_status: { PENDING: { label: "待履约" }, PROCESSING: { label: "处理中" }, SUCCESS: { label: "已完成" }, FAILED: { label: "履约失败" } }
};

/** 历史枚举值→当前字典项值别名；用于兼容旧数据，不再作为可选项写入字典。 */
const LEGACY_DICTIONARY_VALUE_ALIASES: Record<string, Record<string, string>> = {
  business_type: {
    contract: "contract_create",
    funds: "funds_create",
    course: "course_create",
    refund: "refund_create"
  }
};

function canonicalDictionaryItemValue(dictCode: string, value: unknown) {
  const raw = dictionaryItemValueFromId(dictCode, value);
  return LEGACY_DICTIONARY_VALUE_ALIASES[dictCode]?.[raw] ?? raw;
}

/** 字段名→字典码别名（单一来源；seed 与运行时共用，不要在别处再复制一份）。 */
export const DICTIONARY_FIELD_ALIASES: Record<string, string> = {
  category: "business_rule_category",
  businessType: "business_type",
  business_type: "business_type",
  grade_ids: "grade",
  subject_ids: "subject",
  stage: "lead_stage",
  assigneeRole: "approval_role",
  event: "approval_trigger_event",
  pageCode: "approval_trigger_page",
  actionCode: "approval_action_code",
  targetAction: "business_action_code",
  targetApi: "business_action_code",
  triggerApprovalFlow: "approval_flow_code",
  requireApprovalFlow: "approval_flow_code",
  fundsAllocation: "funds_allocation_method",
  promotionAllocation: "promotion_allocation_method",
  performanceAllocation: "performance_allocation_method",
  refundAllocation: "refund_allocation_method",
  splitBy: "allocation_split_by",
  generateLogTable: "generated_log_table",
  organizationPerformanceOwner: "organization_performance_owner",
  personalPerformanceOwner: "personal_performance_owner",
  productPriority: "product_priority",
  defaultChargeType: "charge_type",
  field: "rule_condition_field",
  operator: "rule_operator",
  valueField: "rule_system_value"
};

export function dictionaryItemId(dictCode: string, itemValue: unknown) {
  return `${dictCode}.${String(itemValue ?? "")}`;
}

function dictionaryItemValueFromId(dictCode: string, value: unknown) {
  const text = String(value ?? "");
  const prefix = `${dictCode}.`;
  return text.startsWith(prefix) ? text.slice(prefix.length) : text;
}

export function systemDictionaryLabel(dictCode: string, itemValue: unknown) {
  const value = canonicalDictionaryItemValue(dictCode, itemValue);
  return SYSTEM_DICTIONARIES[dictCode]?.[value]?.label;
}

export function dictionaryCodeForFieldName(fieldName: string) {
  return DICTIONARY_FIELD_ALIASES[fieldName] ?? (SYSTEM_DICTIONARIES[fieldName] ? fieldName : undefined);
}

/**
 * 字典值查询展开：业务入参可使用字典项 ID（status.ACTIVE）或 item_value（ACTIVE）。
 * 查询/登录判断需要同时匹配两种标准形态。返回 undefined 表示该字段/值无需展开。
 */
export function dictionaryCompatValues(field: string, value: unknown): string[] | undefined {
  const text = String(value ?? "");
  if (!text || !SYSTEM_DICTIONARIES[field]) return undefined;
  const raw = dictionaryItemValueFromId(field, text);
  const canonical = canonicalDictionaryItemValue(field, raw);
  if (!SYSTEM_DICTIONARIES[field][canonical]) return undefined;
  return [...new Set([raw, dictionaryItemId(field, raw), canonical, dictionaryItemId(field, canonical)])];
}

export async function normalizeDictionaryInputValues(schemaName: string, input: Record<string, unknown>, fields: string[]) {
  const normalized = { ...input };
  const candidates = fields
    .map((field) => ({ field, dictCode: dictionaryCodeForFieldName(field), value: input[field] }))
    .filter((item): item is { field: string; dictCode: string; value: string | string[] } => {
      if (!item.dictCode) return false;
      if (typeof item.value === "string") return item.value.trim() !== "";
      return Array.isArray(item.value) && item.value.some((value) => typeof value === "string" && value.trim() !== "");
    });
  if (!candidates.length) return normalized;

  const values = [...new Set(candidates.flatMap((item) => Array.isArray(item.value) ? item.value.map(String) : [String(item.value)]))];
  const dictCodes = [...new Set(candidates.map((item) => item.dictCode))];
  const { rows } = await pool.query(
    `select id, dict_code, item_value, item_label
       from admin.dictionary_item
      where dict_code = any($2::text[]) and deleted = false
        and (id = any($1::text[]) or item_value = any($1::text[]) or item_label = any($1::text[]))
        and ((schema_scope = 'admin' and schema_name = '') or (schema_scope = 'tenant' and schema_name = $3))`,
    [values, dictCodes, schemaName]
  );
  const byInputAndCode = new Map(rows.flatMap((row) => [[`${row.dict_code}:${row.id}`, row.id], [`${row.dict_code}:${row.item_value}`, row.id], [`${row.dict_code}:${row.item_label}`, row.id]]));
  for (const item of candidates) {
    if (Array.isArray(item.value)) {
      normalized[item.field] = item.value.map((value) => byInputAndCode.get(`${item.dictCode}:${String(value)}`) ?? value);
      continue;
    }
    const itemId = byInputAndCode.get(`${item.dictCode}:${String(item.value)}`);
    if (itemId !== undefined) normalized[item.field] = itemId;
  }
  return normalized;
}

export async function normalizeDictionaryConfigValues(schemaName: string, value: unknown): Promise<unknown> {
  if (Array.isArray(value)) return Promise.all(value.map((item) => normalizeDictionaryConfigValues(schemaName, item)));
  if (!value || typeof value !== "object") return value;
  const normalized = await normalizeDictionaryInputValues(schemaName, value as Record<string, unknown>, Object.keys(value as Record<string, unknown>));
  const entries = await Promise.all(Object.entries(normalized).map(async ([key, child]) => [key, await normalizeDictionaryConfigValues(schemaName, child)] as const));
  return Object.fromEntries(entries);
}

function safeDictCode(value: unknown) {
  const text = String(value ?? "").trim();
  if (!/^[a-z][a-z0-9_]{1,80}$/.test(text)) throw Object.assign(new Error(`数据字典编码不合法: ${text}`), { statusCode: 400 });
  return text;
}

function safeItemValue(value: unknown) {
  const text = String(value ?? "").trim();
  if (!/^[A-Za-z][A-Za-z0-9_]{0,80}$/.test(text)) throw Object.assign(new Error(`字典项值不合法: ${text}`), { statusCode: 400 });
  return text;
}

export async function seedSystemDictionaries() {
  let sort = 10;
  for (const [dictCode, items] of Object.entries(SYSTEM_DICTIONARIES)) {
    sort = 10;
    for (const [itemValue, item] of Object.entries(items)) {
      await pool.query(
        `insert into admin.dictionary_item(id, dict_code, item_value, item_label, schema_scope, schema_name, is_system, locked, sort_no, status, metadata_json, deleted)
         values($1,$2,$3,$4,'admin','',true,true,$5,'ACTIVE',$6,false)
         on conflict (dict_code, schema_name, item_value) do update
           set id = excluded.id,
               item_label = excluded.item_label,
               is_system = true,
               locked = true,
               status = 'ACTIVE',
               metadata_json = admin.dictionary_item.metadata_json || excluded.metadata_json,
               deleted = false,
               updated_at = now()`,
        [dictionaryItemId(dictCode, itemValue), dictCode, itemValue, item.label, sort, JSON.stringify(item.metadata ?? {})]
      );
      sort += 10;
    }
    await pool.query(
      `update admin.dictionary_item
          set status = 'INACTIVE', deleted = true, updated_at = now()
        where dict_code = $1 and schema_scope = 'admin' and schema_name = ''
          and is_system = true and item_value <> all($2::text[])`,
      [dictCode, Object.keys(items)]
    );
  }
}

export async function listDictionaryOptions(schemaName: string | undefined, dictCodeInput: unknown) {
  const dictCode = safeDictCode(dictCodeInput);
  const { rows } = await pool.query(
    `select distinct on (item_value)
        id, dict_code, item_value, item_label, schema_scope, schema_name, is_system, locked, sort_no, status, metadata_json
       from admin.dictionary_item
       where dict_code = $1 and status = 'ACTIVE' and deleted = false
         and ((schema_scope = 'admin' and schema_name = '') or (schema_scope = 'tenant' and schema_name = $2))
       order by item_value, case when schema_scope = 'tenant' then 0 else 1 end, sort_no, created_at`,
    [dictCode, schemaName ?? null]
  );
  return { rows: rows.sort((a, b) => Number(a.sort_no ?? 0) - Number(b.sort_no ?? 0)).map((row) => ({
    ...row,
    value: row.id,
    itemValue: row.item_value,
    label: row.item_label,
    metadata: row.metadata_json ?? {}
  })) };
}

export async function queryDictionaryItems(schemaName: string, params: Record<string, unknown>) {
  const filters = (params.filters && typeof params.filters === "object" && !Array.isArray(params.filters) ? params.filters : {}) as Record<string, unknown>;
  const values: unknown[] = [schemaName];
  const where = [`deleted = false`, `((schema_scope = 'admin' and schema_name = '') or (schema_scope = 'tenant' and schema_name = $1))`];
  if (filters.dict_code || filters.dictCode) { values.push(safeDictCode(filters.dict_code ?? filters.dictCode)); where.push(`dict_code = $${values.length}`); }
  if (filters.keyword) { values.push(`%${String(filters.keyword)}%`); where.push(`(item_value ilike $${values.length} or item_label ilike $${values.length})`); }
  const page = Math.max(Number(params.page ?? 1), 1);
  const pageSize = Math.min(Math.max(Number(params.pageSize ?? 20), 1), 100);
  values.push(pageSize, (page - 1) * pageSize);
  const { rows } = await pool.query(
    `select id, dict_code, item_value, item_label, schema_scope, schema_name, is_system, locked, sort_no, status, metadata_json, count(*) over() as __total
     from admin.dictionary_item where ${where.join(" and ")}
     order by dict_code, sort_no, item_value limit $${values.length - 1} offset $${values.length}`,
    values
  );
  return { rows, total: Number(rows[0]?.__total ?? 0) };
}

export async function saveTenantDictionaryItem(schemaName: string, params: Record<string, unknown>) {
  const data = ((params.data && typeof params.data === "object" && !Array.isArray(params.data)) ? params.data : params) as DictionaryItemInput;
  const dictCode = safeDictCode(data.dictCode ?? (data as Record<string, unknown>).dict_code);
  const itemValue = safeItemValue(data.itemValue ?? (data as Record<string, unknown>).item_value);
  const itemLabel = String(data.itemLabel ?? (data as Record<string, unknown>).item_label ?? "").trim();
  if (!itemLabel) throw Object.assign(new Error("字典项中文名不能为空"), { statusCode: 400 });
  const system = await pool.query(`select id from admin.dictionary_item where dict_code = $1 and item_value = $2 and is_system = true and deleted = false limit 1`, [dictCode, itemValue]);
  if (system.rows[0]) throw Object.assign(new Error(`系统字典项不可覆盖: ${dictCode}.${itemValue}`), { statusCode: 409 });
  const id = data.id ? String(data.id) : null;
  const metadata = data.metadata ?? ((data as Record<string, unknown>).metadata_json as Record<string, unknown> | undefined) ?? {};
  const { rows } = await pool.query(
    `insert into admin.dictionary_item(id, dict_code, item_value, item_label, schema_scope, schema_name, is_system, locked, sort_no, status, metadata_json, deleted)
     values(coalesce($1, nextval('admin.dictionary_item_id_seq')::text),$2,$3,$4,'tenant',$5,false,false,$6,$7,$8,false)
     on conflict (dict_code, schema_name, item_value) do update
       set item_label = excluded.item_label,
           sort_no = excluded.sort_no,
           status = excluded.status,
           metadata_json = excluded.metadata_json,
           deleted = false,
           updated_at = now()
       where admin.dictionary_item.locked = false
     returning *`,
    [id, dictCode, itemValue, itemLabel, schemaName, Number(data.sortNo ?? (data as Record<string, unknown>).sort_no ?? 100), String(data.status ?? "ACTIVE"), JSON.stringify(metadata)]
  );
  if (!rows[0]) throw Object.assign(new Error("锁定字典项不可修改"), { statusCode: 403 });
  return rows[0];
}

export async function deleteTenantDictionaryItem(schemaName: string, id: unknown) {
  const { rows } = await pool.query(
    `update admin.dictionary_item set deleted = true, updated_at = now()
     where id = $1 and schema_scope = 'tenant' and schema_name = $2 and locked = false returning id`,
    [String(id ?? ""), schemaName]
  );
  if (!rows[0]) throw Object.assign(new Error("字典项不存在或不可删除"), { statusCode: 404 });
  return { deleted: true, id: rows[0].id };
}
