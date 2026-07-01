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
  refund_type: { CONTRACT_PRODUCT: "合同产品退费", CONTRACT: "合同退费" },
  target_type: { bundle: "整包配置", page: "页面", action: "按钮动作", api: "接口", modal: "弹窗", skill: "技能", import: "导入", report: "报表", business_rule: "业务规则", print_template: "打印模板", page_dsl: "页面", api_dsl: "接口", action_dsl: "按钮动作", skill_registry: "技能", import_dsl: "导入", report_dsl: "报表", db_schema: "数据表", permission_policy: "权限策略", approval_flow: "审批流", feature_registry: "功能" },
  schema_scope: { tenant: "机构模板/租户自定义", admin: "平台管理" },
  record_type: { customization: "AI 定制", assistant: "AI 助手" },
  recordType: { customization: "AI 定制", assistant: "AI 助手" },
  organization_type: { TENANT: "机构", CAMPUS: "校区", DEPARTMENT: "部门" },
  payment_status: { PENDING: "待支付", PAID: "已支付", FAILED: "支付失败", CLOSED: "已关闭", REFUNDED: "已退款" },
  fulfillment_status: { PENDING: "待履约", PROCESSING: "处理中", SUCCESS: "已完成", FAILED: "履约失败" }
};

export function enumLabelFor(fieldKey: string | undefined, value: unknown, pageLabels?: Record<string, Record<string, string>>) {
  if (value === null || value === undefined || value === "") return undefined;
  const text = String(value);
  if (!fieldKey) return undefined;
  return pageLabels?.[fieldKey]?.[text] ?? enumValueLabels[fieldKey]?.[text];
}

export function enumDisplayFor(fieldKey: string | undefined, value: unknown, pageLabels?: Record<string, Record<string, string>>) {
  return enumLabelFor(fieldKey, value, pageLabels) ?? String(value ?? "");
}
