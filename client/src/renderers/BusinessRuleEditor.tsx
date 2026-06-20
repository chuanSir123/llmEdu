import { token } from "../styles/designTokens";

type RuleValue = Record<string, unknown>;
type ConditionRow = { field?: string; operator?: string; value?: unknown; valueField?: string; message?: string };

const conditionFieldOptions = {
  transaction_amount: "收款金额",
  refund_real_amount: "退费金额",
  charge_amount: "扣费金额",
  promotion_amount: "优惠金额",
  unit_price: "产品单价",
  old_unit_price: "原产品单价",
  start_time: "开始时间",
  end_time: "结束时间",
  teacher_id: "授课老师",
  student_id: "上课学员",
  course_date: "上课日期"
};

const systemValueOptions = {
  start_time: "开始时间",
  end_time: "结束时间",
  old_unit_price: "原产品单价",
  "course_date,start_time,end_time": "同一天同时间段",
  "teacher_course_date,start_time,end_time": "老师同一天同时间段",
  "student_course_date,start_time,end_time": "学员同一天同时间段"
};

const operatorOptions = {
  ">": "大于",
  ">=": "大于等于",
  "<": "小于",
  "<=": "小于等于",
  "=": "等于",
  "!=": "不等于",
  no_time_overlap: "不可时间冲突",
  lt: "小于",
  unique_combo: "组合不可重复"
};

const categoryOptions = {
  funds_allocation: "资金分配",
  promotion_allocation: "优惠分配",
  performance_allocation: "业绩分配",
  approval_trigger: "审批触发",
  validation: "校验规则",
  workflow: "业务流转",
  refund: "退费规则",
  charge: "扣费规则",
  attendance: "考勤规则"
};

const businessTypeOptions = {
  contract: "合同签约",
  funds: "收款",
  course: "排课",
  course_cancel: "课程取消",
  attendance: "考勤",
  charge: "扣费",
  charge_reverse: "撤销扣费",
  refund: "退费",
  contract_refund: "合同退费",
  product_price: "产品价格",
  performance: "业绩"
};

const ruleSections: Record<string, {
  selects?: Array<{ key: string; label: string; options: Record<string, string> }>;
  switches?: Array<{ key: string; label: string }>;
  numbers?: Array<{ key: string; label: string; suffix?: string }>;
  rows?: Array<"conditions" | "validations">;
}> = {
  funds_allocation: {
    selects: [
      { key: "fundsAllocation", label: "资金分配方式", options: { byCpPaidRatio: "按合同产品应收比例", byCpRemainingAmount: "按合同产品剩余金额比例", oldestContractFirst: "优先最早合同", manual: "手工分配" } },
      { key: "splitBy", label: "拆分维度", options: { contract_product: "合同产品", contract: "合同", organization: "校区" } },
      { key: "generateLogTable", label: "生成明细", options: { money_arrange_log: "资金分配记录" } }
    ],
    switches: [
      { key: "updateContractPaidStatus", label: "自动更新合同收款状态" },
      { key: "allowPreStoreWithoutContract", label: "允许无合同预存" },
      { key: "allowManualAdjust", label: "允许手工调整" }
    ],
    rows: ["validations"]
  },
  promotion_allocation: {
    selects: [
      { key: "promotionAllocation", label: "优惠分配方式", options: { byCpAmountRatio: "按合同产品金额比例", byCpHourRatio: "按合同产品课时比例", oneToOneFirst: "优先一对一产品", classCourseFirst: "优先班课产品", manual: "手工分配" } },
      { key: "splitBy", label: "拆分维度", options: { contract_product: "合同产品", product_type: "产品类型" } },
      { key: "generateLogTable", label: "生成明细", options: { promotion_arrange_log: "优惠分配记录" } }
    ],
    switches: [
      { key: "requireAtLeastOneProduct", label: "合同至少包含一个产品" },
      { key: "snapshotPromotion", label: "签约时保存优惠快照" },
      { key: "allowManualAdjust", label: "允许手工调整" }
    ]
  },
  performance_allocation: {
    selects: [
      { key: "performanceAllocation", label: "业绩分配方式", options: { byCpPaidRatio: "按合同产品实收比例", byCpReceivableRatio: "按合同产品应收比例", oneToOneFirst: "优先一对一", classCourseFirst: "优先班课", salesOwnerOnly: "归属签约顾问" } },
      { key: "organizationPerformanceOwner", label: "校区业绩归属", options: { contractOrganization: "合同所属校区", courseOrganization: "上课校区", receiptOrganization: "收款校区" } },
      { key: "personalPerformanceOwner", label: "个人业绩归属", options: { signStaff: "签约顾问", ownerStaff: "学员归属顾问", classTeacher: "任课老师", splitByProductOwner: "按产品归属人拆分" } },
      { key: "productPriority", label: "产品优先级", options: { none: "不区分", oneToOneFirst: "一对一优先", classCourseFirst: "班课优先", oneOnNFirst: "一对N优先" } },
      { key: "generateLogTable", label: "生成明细", options: { performance_arrange_log: "业绩分配记录" } }
    ],
    switches: [
      { key: "includePromotionAmount", label: "优惠金额计入业绩" },
      { key: "includeRefundDeduction", label: "退费自动冲减业绩" },
      { key: "allowManualAdjust", label: "允许手工调整" }
    ],
    numbers: [
      { key: "oneToOneWeight", label: "一对一权重", suffix: "%" },
      { key: "classCourseWeight", label: "班课权重", suffix: "%" }
    ]
  },
  approval_trigger: {
    selects: [
      { key: "targetAction", label: "触发动作", options: { "contract_list.create": "新增合同", "refund_record.create": "新增退费", "course_list.cancel": "取消课程", "charge_record.reverse": "撤销扣费", "product_list.edit": "编辑产品" } },
      { key: "triggerApprovalFlow", label: "审批流", options: { contract_discount_approval: "合同优惠审批", refund_create_approval: "退费审批", course_cancel_approval: "课程取消审批", charge_reverse_approval: "撤销扣费审批", product_price_approval: "产品价格审批" } }
    ],
    numbers: [{ key: "thresholdAmount", label: "触发金额阈值", suffix: "元" }],
    rows: ["conditions"]
  },
  validation: {
    selects: [
      { key: "targetApi", label: "校验接口", options: { "course_list.create": "新增排课", "contract_list.create": "新增合同", "funds_history.create": "新增收款" } }
    ],
    switches: [
      { key: "preventTeacherTimeConflict", label: "防止老师时间冲突" },
      { key: "preventStudentTimeConflict", label: "防止学员时间冲突" },
      { key: "preventInvalidTimeRange", label: "防止无效时间范围" }
    ],
    rows: ["validations"]
  },
  workflow: {
    selects: [
      { key: "targetAction", label: "业务动作", options: { "course_list.cancel": "取消课程", "charge_record.reverse": "撤销扣费", "contract_list.delete": "作废合同" } },
      { key: "requireApprovalFlow", label: "必须审批流", options: { course_cancel_approval: "课程取消审批", charge_reverse_approval: "扣费冲销审批", contract_discount_approval: "合同优惠审批" } }
    ],
    switches: [{ key: "allowAfterFinished", label: "允许完成后操作" }]
  },
  refund: {
    selects: [
      { key: "refundAllocation", label: "退费冲减方式", options: { byCpRemainingAmount: "按产品剩余金额比例", originalPaymentReverse: "按原收款反向冲减", manual: "手工指定" } }
    ],
    switches: [
      { key: "allowRefundOverBalance", label: "允许超过余额退费" },
      { key: "updateContractProductBalance", label: "自动更新产品余额" },
      { key: "updateContractPaidStatus", label: "自动更新合同收款状态" },
      { key: "autoRefundToEleAccount", label: "退回电子账户" }
    ],
    rows: ["validations"]
  },
  charge: {
    selects: [
      { key: "defaultChargeType", label: "默认扣费类型", options: { NORMAL: "正常扣费", MAKE_UP: "补课扣费", REFUND_REVERSE: "退费冲销" } }
    ],
    switches: [
      { key: "allowNegativeBalance", label: "允许负余额扣费" },
      { key: "updateContractProductBalance", label: "自动更新产品余额" },
      { key: "autoCalculateChargeAmount", label: "自动计算扣费金额" }
    ],
    rows: ["validations"]
  },
  attendance: {
    switches: [
      { key: "requireCheckInBeforeCharge", label: "签到后才允许扣费" },
      { key: "autoCalculateChargeAmount", label: "按课时自动计算扣费" },
      { key: "allowAfterFinished", label: "允许课后补签" }
    ],
    rows: ["validations"]
  }
};

function toObject(value: unknown): RuleValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RuleValue : {};
}

function toRows(value: unknown): ConditionRow[] {
  return Array.isArray(value) ? value.map((item) => toObject(item) as ConditionRow) : [];
}

function cleanEmpty(next: RuleValue) {
  return Object.fromEntries(Object.entries(next).filter(([, value]) => value !== "" && value !== undefined)) as RuleValue;
}

function displayValue(key: string, value: unknown) {
  if (value === undefined || value === null || value === "") return "未设置";
  const section = Object.values(ruleSections).find((item) => item.selects?.some((select) => select.key === key));
  const select = section?.selects?.find((item) => item.key === key);
  return select?.options[String(value)] ?? String(value);
}

export function BusinessRuleEditor({ value, onChange, readonly = false }: { value: unknown; onChange: (next: RuleValue) => void; readonly?: boolean }) {
  const rule = toObject(value);
  const category = String(rule.category ?? "");
  const section = ruleSections[category] ?? {};

  const patch = (key: string, nextValue: unknown) => onChange(cleanEmpty({ ...rule, [key]: nextValue }));

  const renderSelect = (field: NonNullable<typeof section.selects>[number]) => (
    <label key={field.key} className="flex flex-col gap-1 text-sm">
      <span className="text-[#5f6b7a]">{field.label}</span>
      {readonly ? (
        <div className="min-h-9 border border-[#dde3ee] bg-[#f7f8fa] px-3 py-2 text-[#263445]">{displayValue(field.key, rule[field.key])}</div>
      ) : (
        <select className={token.input} value={String(rule[field.key] ?? "")} onChange={(event) => patch(field.key, event.target.value)}>
          <option value="">不设置</option>
          {Object.entries(field.options).map(([optionValue, label]) => <option key={optionValue} value={optionValue}>{label}</option>)}
        </select>
      )}
    </label>
  );

  const renderSwitch = (field: NonNullable<typeof section.switches>[number]) => (
    <label key={field.key} className="flex items-center gap-2 border border-[#e8edf5] px-3 py-2 text-sm">
      <input type="checkbox" checked={Boolean(rule[field.key])} disabled={readonly} onChange={(event) => patch(field.key, event.target.checked)} />
      <span>{field.label}</span>
    </label>
  );

  const renderNumber = (field: NonNullable<typeof section.numbers>[number]) => (
    <label key={field.key} className="flex flex-col gap-1 text-sm">
      <span className="text-[#5f6b7a]">{field.label}</span>
      <div className="flex items-center gap-2">
        <input className={token.input} type="number" readOnly={readonly} value={String(rule[field.key] ?? "")} onChange={(event) => patch(field.key, event.target.value === "" ? "" : Number(event.target.value))} />
        {field.suffix && <span className="text-xs text-[#8b95a7]">{field.suffix}</span>}
      </div>
    </label>
  );

  const renderRows = (key: "conditions" | "validations", label: string) => {
    const rows = toRows(rule[key]);
    const updateRow = (idx: number, patchRow: Partial<ConditionRow>) => {
      patch(key, rows.map((row, rowIdx) => rowIdx === idx ? cleanEmpty({ ...row, ...patchRow }) : row));
    };
    return (
      <section className="border border-[#e8edf5]">
        <div className="flex items-center justify-between border-b border-[#e8edf5] bg-[#f8fafc] px-3 py-2">
          <div className="text-sm font-medium text-[#263445]">{label}</div>
          {!readonly && <button type="button" className="text-xs text-[#2f80ed]" onClick={() => patch(key, [...rows, { field: "", operator: ">", value: "" }])}>新增</button>}
        </div>
        <div className="divide-y divide-[#eef2f7]">
          {rows.map((row, idx) => (
            <div key={idx} className="grid gap-2 p-3 md:grid-cols-[1.1fr_120px_120px_1.2fr_1.5fr_40px]">
              <select className={token.input} disabled={readonly} value={String(row.field ?? "")} onChange={(event) => updateRow(idx, { field: event.target.value })}>
                <option value="">选择业务字段</option>
                {Object.entries(conditionFieldOptions).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
              <select className={token.input} disabled={readonly} value={String(row.operator ?? "")} onChange={(event) => updateRow(idx, { operator: event.target.value })}>
                <option value="">选择关系</option>
                {Object.entries(operatorOptions).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
              <select
                className={token.input}
                disabled={readonly}
                value={row.valueField ? "system" : "fixed"}
                onChange={(event) => updateRow(idx, event.target.value === "system" ? { value: "", valueField: "start_time" } : { valueField: "", value: "" })}
              >
                <option value="fixed">固定值</option>
                <option value="system">系统值</option>
              </select>
              {row.valueField ? (
                <select className={token.input} disabled={readonly} value={String(row.valueField ?? "")} onChange={(event) => updateRow(idx, { valueField: event.target.value })}>
                  <option value="">选择系统值</option>
                  {Object.entries(systemValueOptions).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              ) : (
                <input className={token.input} readOnly={readonly} placeholder="填写数值，例如 0" value={String(row.value ?? "")} onChange={(event) => updateRow(idx, { value: event.target.value })} />
              )}
              <input className={token.input} readOnly={readonly} placeholder="提示语" value={String(row.message ?? "")} onChange={(event) => updateRow(idx, { message: event.target.value })} />
              {!readonly && <button type="button" className="text-xs text-[#d92d20]" onClick={() => patch(key, rows.filter((_, rowIdx) => rowIdx !== idx))}>删除</button>}
            </div>
          ))}
          {!rows.length && <div className="px-3 py-5 text-center text-sm text-[#8b95a7]">暂无{label}</div>}
        </div>
      </section>
    );
  };

  return (
    <div className="space-y-5">
      <div className="grid gap-4 md:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[#5f6b7a]">规则分类</span>
          {readonly ? (
            <div className="min-h-9 border border-[#dde3ee] bg-[#f7f8fa] px-3 py-2 text-[#263445]">{categoryOptions[category as keyof typeof categoryOptions] ?? category}</div>
          ) : (
            <select className={token.input} value={category} onChange={(event) => patch("category", event.target.value)}>
              <option value="">请选择</option>
              {Object.entries(categoryOptions).map(([optionValue, label]) => <option key={optionValue} value={optionValue}>{label}</option>)}
            </select>
          )}
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[#5f6b7a]">业务类型</span>
          {readonly ? (
            <div className="min-h-9 border border-[#dde3ee] bg-[#f7f8fa] px-3 py-2 text-[#263445]">{businessTypeOptions[String(rule.businessType) as keyof typeof businessTypeOptions] ?? String(rule.businessType ?? "未设置")}</div>
          ) : (
            <select className={token.input} value={String(rule.businessType ?? "")} onChange={(event) => patch("businessType", event.target.value)}>
              <option value="">请选择</option>
              {Object.entries(businessTypeOptions).map(([optionValue, label]) => <option key={optionValue} value={optionValue}>{label}</option>)}
            </select>
          )}
        </label>
      </div>

      {section.selects?.length ? <section><div className="mb-2 text-sm font-medium text-[#263445]">业务规则</div><div className="grid gap-4 md:grid-cols-3">{section.selects.map(renderSelect)}</div></section> : null}
      {section.numbers?.length ? <section><div className="mb-2 text-sm font-medium text-[#263445]">数值设置</div><div className="grid gap-4 md:grid-cols-3">{section.numbers.map(renderNumber)}</div></section> : null}
      {section.switches?.length ? <section><div className="mb-2 text-sm font-medium text-[#263445]">规则开关</div><div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">{section.switches.map(renderSwitch)}</div></section> : null}
      {section.rows?.includes("conditions") && renderRows("conditions", "触发条件")}
      {section.rows?.includes("validations") && renderRows("validations", "校验条件")}
    </div>
  );
}
