export const enumValueLabels: Record<string, Record<string, string>> = {
  student_status: { FORMAL: "正式", LEAD: "意向", LOST: "流失" },
  paid_status: { PAID: "已付清", PART_PAID: "部分付款", UNPAID: "未付款", REFUNDED: "已退费" },
  contract_status: { ACTIVE: "生效中", CLOSED: "已结清", CANCELLED: "已取消", REFUNDED: "已退费" },
  course_status: { SCHEDULED: "待上课", FINISHED: "已完成", CANCELLED: "已取消" },
  charge_status: { CONFIRMED: "已确认", PENDING: "待确认", REVERSED: "已撤销" },
  attendance_status: { PENDING: "待签到", PRESENT: "已签到", ABSENT: "缺勤", LEAVE: "请假" },
  status: { ACTIVE: "启用", INACTIVE: "停用", ENABLED: "启用", DISABLED: "停用", PUBLISHED: "已发布", DRAFT: "草稿", draft: "草稿", active: "生效", archived: "归档", rejected: "已驳回", pending: "待处理", success: "成功", failed: "失败", running: "执行中", skipped: "已跳过" },
  mode: { draft: "草稿", publish_after_confirm: "确认后发布", import: "导入", validate: "校验" },
  staff_type: { MANAGER: "校长", TEACHER: "老师", STUDY_MANAGER: "学管师", SALES: "顾问" },
  organization_type: { HEAD: "总部", BRANCH: "校区", DEPARTMENT: "部门", TENANT: "机构", CAMPUS: "校区" },
  funds_type: { CONTRACT_PAY: "合同收款", PRE_STORE: "预存" },
  source_type: { REFERRAL: "转介绍", WALK_IN: "到访", ONLINE: "线上", MANUAL_ADJUSTMENT: "手工调整" },
  course_type: { ONE_ON_ONE_COURSE: "一对一", SMALL_CLASS: "小班", ONE_ON_N_GROUP: "一对N" },
  product_type: { ONE_ON_ONE_COURSE: "一对一", SMALL_CLASS: "小班", ONE_ON_N_GROUP: "一对N" },
  contract_type: { NEW_SIGN: "新签", RENEWAL: "续费", REFERRAL: "引流" },
  follow_type: { PHONE: "电话", VISIT: "到访", WECHAT: "微信" },
  charge_type: { NORMAL: "实收扣费", PROMOTION: "优惠扣费", PROMOTION_HOUR: "赠课扣费", MAKE_UP: "补课扣费", REFUND_REVERSE: "退费冲销" },
  pay_way_type: { CASH: "现金", WECHAT: "微信", ALIPAY: "支付宝", ELE_ACCOUNT: "电子账户" },
  promotion_type: { REDUCE: "立减", DISCOUNT: "折扣" },
  change_type: { PRESTORE_IN: "预存入账", CONTRACT_PAY_OUT: "合同扣款", REFUND_IN: "退费入账", PRESTORE_DELETE: "删除预存", CONTRACT_PAY_DELETE: "删除合同扣款", REFUND_DELETE: "删除退费", update: "更新", rollback: "回滚", init: "初始化" },
  trial_status: { SCHEDULED: "已预约", FINISHED: "已试听", CANCELLED: "已取消" },
  conversion_status: { PENDING: "待转化", CONVERTED: "已转化", LOST: "未转化" },
  task_type: { FOLLOWUP: "跟进", TRIAL_FOLLOWUP: "试听跟进" },
  task_status: { PENDING: "待处理", COMPLETED: "已完成", CANCELED: "已取消" },
  follow_result: { CONTACTED: "已联系", NO_ANSWER: "未接通", INTERESTED: "有意向", NOT_INTERESTED: "无意向" },
  business_rule_category: { funds_allocation: "资金分配", promotion_allocation: "优惠分配", performance_allocation: "业绩分配", approval_trigger: "审批触发", validation: "校验规则", workflow: "业务流转", refund: "退费规则", charge: "扣费规则", attendance: "考勤规则" },
  business_type: { contract: "合同签约", funds: "收款", course: "排课", course_cancel: "课程取消", attendance: "考勤", charge: "扣费", charge_reverse: "撤销扣费", refund: "退费", contract_refund: "合同退费", product_price: "产品价格", performance: "业绩" },
  action_type: { open_page: "打开页面", execute_api: "执行接口", open_modal: "打开弹窗", open_ai_customization: "AI 定制", dropdown: "下拉菜单", input: "输入", display: "展示", tab: "页签", export: "导出", import: "导入" },
  api_type: { query: "查询", detail: "详情", create: "新增", update: "更新", delete: "删除", command: "命令" },
  resource_type: { page: "页面", action: "动作", field: "字段" },
  organization_scope: { role_organization: "角色组织", all: "全部" },
  receiver_scope: { student: "学员", staff: "员工", all: "全部" },
  pay_type: { PREPAID: "预付", POSTPAID: "后付", TRIAL: "试用" },
  cost_type: { ONLINE_ADS: "线上投放", OFFLINE: "线下成本", OTHER: "其他" },
  target_status: { FULL: "已满", CLOSED: "已关闭", ACTIVE: "启用" },
  refund_type: { CONTRACT_PRODUCT: "合同产品退费", CONTRACT: "合同退费" },
  target_type: { bundle: "整包配置", page: "页面", action: "按钮动作", api: "接口", modal: "弹窗", skill: "技能", import: "导入", report: "报表", business_rule: "业务规则", print_template: "打印模板", page_dsl: "页面", api_dsl: "接口", action_dsl: "按钮动作", skill_registry: "技能", import_dsl: "导入", report_dsl: "报表", db_schema: "数据表", permission_policy: "权限策略", approval_flow: "审批流", feature_registry: "功能" },
  schema_scope: { tenant: "机构模板/租户自定义", admin: "平台管理" },
  record_type: { customization: "AI 定制", assistant: "AI 助手" },
  recordType: { customization: "AI 定制", assistant: "AI 助手" },
  account_type: { DEFAULT: "默认账户" },
  leave_type: { PERSONAL: "事假", SICK: "病假", OTHER: "其他" },
  holiday_type: { CAMPUS_CLOSED: "校区停课", PUBLIC_HOLIDAY: "节假日", OTHER: "其他" },
  performance_type: { SALES: "销售业绩", MANUAL_ADJUST: "手工调整", SALES_REVERSE: "销售业绩冲减" },
  goods_status: { ON_SALE: "上架中", OFF_SALE: "已下架" },
  activity_type: { SECKILL: "秒杀", GROUP_BUY: "拼团", NORMAL: "普通活动" },
  group_status: { OPEN: "拼团中", SUCCESS: "已成团", CLOSED: "已关闭" },
  member_status: { JOINED: "已参团", LEFT: "已退出" },
  order_status: { CREATED: "已创建", PAID: "已支付", CLOSED: "已关闭", REFUNDED: "已退款" },
  service_type: { SERVICE_ACCOUNT: "服务号", SUBSCRIPTION_ACCOUNT: "订阅号" },
  binding_type: { PUBLIC: "公有服务号", PRIVATE: "自有公众号" },
  authorized_status: { AUTHORIZED: "已授权", UNAUTHORIZED: "未授权", EXPIRED: "已过期" },
  publish_status: { DRAFT: "草稿", PUBLISHED: "已发布", FAILED: "发布失败" },
  subscribe_status: { SUBSCRIBED: "已关注", UNSUBSCRIBED: "已取关" },
  send_status: { PENDING: "待发送", SUCCESS: "发送成功", FAILED: "发送失败" },
  reward_status: { PENDING: "待处理", LOCKED: "锁定中", ELIGIBLE: "可发放", ISSUED: "已发放" },
  payment_status: { PENDING: "待支付", PAID: "已支付", FAILED: "支付失败", CLOSED: "已关闭", REFUNDED: "已退款" },
  fulfillment_status: { PENDING: "待履约", PROCESSING: "处理中", SUCCESS: "已完成", FAILED: "履约失败" }
};

const enumFieldAliases: Record<string, string> = {
  category: "business_rule_category",
  businessType: "business_type",
  business_type: "business_type"
};

export function enumLabelFor(fieldKey: string | undefined, value: unknown, pageLabels?: Record<string, Record<string, string>>) {
  if (value === null || value === undefined || value === "") return undefined;
  const text = String(value);
  if (!fieldKey) return undefined;
  const normalizedKey = enumFieldAliases[fieldKey] ?? fieldKey;
  return pageLabels?.[fieldKey]?.[text] ?? pageLabels?.[normalizedKey]?.[text] ?? enumValueLabels[normalizedKey]?.[text];
}

export function enumDisplayFor(fieldKey: string | undefined, value: unknown, pageLabels?: Record<string, Record<string, string>>) {
  return enumLabelFor(fieldKey, value, pageLabels) ?? String(value ?? "");
}
