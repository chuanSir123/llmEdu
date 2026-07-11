import { token } from "../styles/designTokens";
import { dictionaryOptionEntries, firstDictionaryOptionValue, preferredDictionaryValue, dictionaryItemValue } from "../dsl/dictionaryLabels";

type RuleValue = Record<string, unknown>;
type ConditionRow = { field?: string; operator?: string; value?: unknown; valueField?: string; message?: string };



function buildRuleSections(valueLabels: Record<string, Record<string, string>>): Record<string, {
  selects?: Array<{ key: string; label: string; options: Record<string, string> }>;
  switches?: Array<{ key: string; label: string }>;
  numbers?: Array<{ key: string; label: string; suffix?: string }>;
  rows?: Array<"conditions" | "validations">;
}> {
  return {
  funds_allocation: {
    selects: [
      { key: "fundsAllocation", label: "资金分配方式", options: valueLabels.funds_allocation_method ?? {} },
      { key: "splitBy", label: "拆分维度", options: valueLabels.allocation_split_by ?? {} },
      { key: "generateLogTable", label: "生成明细", options: valueLabels.generated_log_table ?? {} }
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
      { key: "promotionAllocation", label: "优惠分配方式", options: valueLabels.promotion_allocation_method ?? {} },
      { key: "splitBy", label: "拆分维度", options: valueLabels.allocation_split_by ?? {} },
      { key: "generateLogTable", label: "生成明细", options: valueLabels.generated_log_table ?? {} }
    ],
    switches: [
      { key: "requireAtLeastOneProduct", label: "合同至少包含一个产品" },
      { key: "snapshotPromotion", label: "签约时保存优惠快照" },
      { key: "allowManualAdjust", label: "允许手工调整" }
    ]
  },
  performance_allocation: {
    selects: [
      { key: "performanceAllocation", label: "业绩分配方式", options: valueLabels.performance_allocation_method ?? {} },
      { key: "organizationPerformanceOwner", label: "校区业绩归属", options: valueLabels.organization_performance_owner ?? {} },
      { key: "personalPerformanceOwner", label: "个人业绩归属", options: valueLabels.personal_performance_owner ?? {} },
      { key: "productPriority", label: "产品优先级", options: valueLabels.product_priority ?? {} },
      { key: "generateLogTable", label: "生成明细", options: valueLabels.generated_log_table ?? {} }
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
      { key: "targetAction", label: "触发动作", options: valueLabels.business_action_code ?? {} },
      { key: "triggerApprovalFlow", label: "审批流", options: valueLabels.approval_flow_code ?? {} }
    ],
    numbers: [{ key: "thresholdAmount", label: "触发金额阈值", suffix: "元" }],
    rows: ["conditions"]
  },
  validation: {
    selects: [
      { key: "targetApi", label: "校验接口", options: valueLabels.business_action_code ?? {} }
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
      { key: "targetAction", label: "业务动作", options: valueLabels.business_action_code ?? {} },
      { key: "requireApprovalFlow", label: "必须审批流", options: valueLabels.approval_flow_code ?? {} }
    ],
    switches: [{ key: "allowAfterFinished", label: "允许完成后操作" }]
  },
  refund: {
    selects: [
      { key: "refundAllocation", label: "退费冲减方式", options: valueLabels.refund_allocation_method ?? {} }
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
      { key: "defaultChargeType", label: "默认扣费类型", options: valueLabels.charge_type ?? {} }
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
}

function optionEntries(options: Record<string, string>) {
  return dictionaryOptionEntries(options);
}

function firstOptionValue(options: Record<string, string>, fallback = "") {
  return firstDictionaryOptionValue(options, fallback);
}

function toObject(value: unknown): RuleValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RuleValue : {};
}

function toRows(value: unknown): ConditionRow[] {
  return Array.isArray(value) ? value.map((item) => toObject(item) as ConditionRow) : [];
}

function cleanEmpty(next: RuleValue) {
  return Object.fromEntries(Object.entries(next).filter(([, value]) => value !== "" && value !== undefined)) as RuleValue;
}

function displayValue(key: string, value: unknown, ruleSections: ReturnType<typeof buildRuleSections>) {
  if (value === undefined || value === null || value === "") return "未设置";
  const section = Object.values(ruleSections).find((item) => item.selects?.some((select) => select.key === key));
  const select = section?.selects?.find((item) => item.key === key);
  return select?.options[String(value)] ?? select?.options[preferredDictionaryValue(select.options, value)] ?? String(value);
}

export function BusinessRuleEditor({ value, onChange, readonly = false, valueLabels = {} }: { value: unknown; onChange: (next: RuleValue) => void; readonly?: boolean; valueLabels?: Record<string, Record<string, string>> }) {
  const rule = toObject(value);
  const category = String(rule.category ?? "");
  const categoryKey = dictionaryItemValue(category);
  const ruleSections = buildRuleSections(valueLabels);
  const conditionFieldOptions = valueLabels.rule_condition_field ?? {};
  const systemValueOptions = valueLabels.rule_system_value ?? {};
  const operatorOptions = valueLabels.rule_operator ?? {};
  const categoryOptions = valueLabels.business_rule_category ?? {};
  const businessTypeOptions = valueLabels.business_type ?? {};
  const businessTypeKey = dictionaryItemValue(rule.businessType);
  const baseSection = ruleSections[categoryKey] ?? {};
  const courseDeleteSwitches = businessTypeKey === "course_delete" ? [
    { key: "allowDeleteWithAttendance", label: "允许删除已有考勤的排课" },
    { key: "allowDeleteWithCharges", label: "允许删除已有扣费的排课" },
    { key: "reverseChargesOnDelete", label: "自动取消已确认扣费" },
    { key: "resetAttendanceOnDelete", label: "自动重置已签到考勤" },
    { key: "requireDeleteReason", label: "必须填写删除原因" }
  ] : [];
  const section = courseDeleteSwitches.length ? { ...baseSection, switches: [...(baseSection.switches ?? []), ...courseDeleteSwitches] } : baseSection;

  const patch = (key: string, nextValue: unknown) => onChange(cleanEmpty({ ...rule, [key]: nextValue }));

  const renderSelect = (field: NonNullable<typeof section.selects>[number]) => (
    <label key={field.key} className="flex flex-col gap-1 text-sm">
      <span className="text-[#5f6b7a]">{field.label}</span>
      {readonly ? (
        <div className="min-h-9 border border-[#dde3ee] bg-[#f7f8fa] px-3 py-2 text-[#263445]">{displayValue(field.key, rule[field.key], ruleSections)}</div>
      ) : (
        <select className={token.input} value={preferredDictionaryValue(field.options, rule[field.key])} onChange={(event) => patch(field.key, event.target.value)}>
          <option value="">不设置</option>
          {optionEntries(field.options).map(([optionValue, label]) => <option key={optionValue} value={optionValue}>{label}</option>)}
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
          {!readonly && <button type="button" className="text-xs text-[#2f80ed]" onClick={() => patch(key, [...rows, { field: "", operator: firstOptionValue(operatorOptions), value: "" }])}>新增</button>}
        </div>
        <div className="divide-y divide-[#eef2f7]">
          {rows.map((row, idx) => (
            <div key={idx} className="grid gap-2 p-3 md:grid-cols-[1.1fr_120px_120px_1.2fr_1.5fr_40px]">
              <select className={token.input} disabled={readonly} value={String(row.field ?? "")} onChange={(event) => updateRow(idx, { field: event.target.value })}>
                <option value="">选择业务字段</option>
                {optionEntries(conditionFieldOptions).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
              <select className={token.input} disabled={readonly} value={String(row.operator ?? "")} onChange={(event) => updateRow(idx, { operator: event.target.value })}>
                <option value="">选择关系</option>
                {optionEntries(operatorOptions).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
              <select
                className={token.input}
                disabled={readonly}
                value={row.valueField ? "system" : "fixed"}
                onChange={(event) => updateRow(idx, event.target.value === "system" ? { value: "", valueField: firstOptionValue(systemValueOptions) } : { valueField: "", value: "" })}
              >
                <option value="fixed">固定值</option>
                <option value="system">系统值</option>
              </select>
              {row.valueField ? (
                <select className={token.input} disabled={readonly} value={String(row.valueField ?? "")} onChange={(event) => updateRow(idx, { valueField: event.target.value })}>
                  <option value="">选择系统值</option>
                  {optionEntries(systemValueOptions).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
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
            <div className="min-h-9 border border-[#dde3ee] bg-[#f7f8fa] px-3 py-2 text-[#263445]">{categoryOptions[category] ?? categoryOptions[preferredDictionaryValue(categoryOptions, category)] ?? category}</div>
          ) : (
            <select className={token.input} value={preferredDictionaryValue(categoryOptions, category)} onChange={(event) => patch("category", event.target.value)}>
              <option value="">请选择</option>
              {optionEntries(categoryOptions).map(([optionValue, label]) => <option key={optionValue} value={optionValue}>{label}</option>)}
            </select>
          )}
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[#5f6b7a]">业务类型</span>
          {readonly ? (
            <div className="min-h-9 border border-[#dde3ee] bg-[#f7f8fa] px-3 py-2 text-[#263445]">{businessTypeOptions[String(rule.businessType)] ?? businessTypeOptions[preferredDictionaryValue(businessTypeOptions, rule.businessType)] ?? String(rule.businessType ?? "未设置")}</div>
          ) : (
            <select className={token.input} value={preferredDictionaryValue(businessTypeOptions, rule.businessType)} onChange={(event) => patch("businessType", event.target.value)}>
              <option value="">请选择</option>
              {optionEntries(businessTypeOptions).map(([optionValue, label]) => <option key={optionValue} value={optionValue}>{label}</option>)}
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
