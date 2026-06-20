import { token } from "../styles/designTokens";

type Step = {
  stepCode?: string;
  stepName?: string;
  assigneeRole?: string;
};

const triggerEvents = {
  contract_discount_submit: "合同优惠提交",
  lead_enroll_submit: "新生报名提交",
  contract_create_submit: "合同创建提交",
  funds_create_submit: "收款提交",
  refund_create_submit: "退费提交",
  course_create_submit: "排课提交",
  course_cancel_submit: "课程取消提交",
  charge_reverse_submit: "撤销扣费提交",
  product_price_change_submit: "产品改价提交"
};

const pageOptions = {
  contract_list: "合同列表",
  lead_list: "新生报名",
  funds_history: "收款记录",
  refund_record: "退费记录",
  course_list: "排课列表",
  charge_record: "扣费记录",
  product_list: "产品列表"
};

const actionOptions = {
  "contract_list.funds": "允许合同收款",
  "contract_list.create": "允许新增合同",
  "lead_list.enroll": "允许报名转化",
  "funds_history.create": "允许新增收款",
  "refund_record.create": "允许新增退费",
  "course_list.create": "允许新增排课",
  "course_list.cancel": "允许取消课程",
  "charge_record.reverse": "允许撤销扣费",
  "product_list.edit": "允许编辑产品"
};

const roleOptions = {
  PRINCIPAL: "校长",
  MANAGER: "校长",
  SALES: "顾问",
  TEACHER: "老师",
  STUDY_MANAGER: "学管师"
};

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stepsOf(config: Record<string, unknown>): Step[] {
  return Array.isArray(config.steps) ? config.steps as Step[] : [];
}

export function ApprovalFlowEditor({
  value,
  onChange
}: {
  value: unknown;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const config = asObject(value);
  const steps = stepsOf(config);

  const updateConfig = (patch: Record<string, unknown>) => onChange({ ...config, ...patch });
  const updateStep = (index: number, patch: Step) => {
    const nextSteps = steps.map((step, idx) => idx === index ? { ...step, ...patch } : step);
    updateConfig({ steps: nextSteps });
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[#5f6b7a]">触发事件</span>
          <select
            className={token.input}
            value={String(asObject(config.trigger).event ?? "")}
            onChange={(event) => updateConfig({ trigger: { ...asObject(config.trigger), event: event.target.value } })}
          >
            <option value="">请选择</option>
            {Object.entries(triggerEvents).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[#5f6b7a]">触发页面</span>
          <select
            className={token.input}
            value={String(asObject(config.trigger).pageCode ?? "")}
            onChange={(event) => updateConfig({ trigger: { ...asObject(config.trigger), pageCode: event.target.value } })}
          >
            <option value="">请选择</option>
            {Object.entries(pageOptions).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[#5f6b7a]">审批后动作</span>
          <select
            className={token.input}
            value={String((Array.isArray(config.afterApproved) ? config.afterApproved[0] as Record<string, unknown> : {})?.actionCode ?? "")}
            onChange={(event) => updateConfig({ afterApproved: event.target.value ? [{ type: "enable_action", actionCode: event.target.value }] : [] })}
          >
            <option value="">不设置</option>
            {Object.entries(actionOptions).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
      </div>

      <div className="overflow-hidden border border-[#dde3ee]">
        <div className="grid grid-cols-[1.2fr_1fr_56px] bg-[#f8fafc] px-3 py-2 text-xs font-medium text-[#607083]">
          <div>步骤名称</div>
          <div>流转角色</div>
          <div />
        </div>
        {steps.map((step, index) => (
          <div key={index} className="grid grid-cols-[1.2fr_1fr_56px] gap-2 border-t border-[#e8edf5] px-3 py-2">
            <input className={token.input} value={step.stepName ?? ""} onChange={(event) => updateStep(index, { stepName: event.target.value })} />
            <select className={token.input} value={step.assigneeRole ?? ""} onChange={(event) => updateStep(index, { assigneeRole: event.target.value })}>
              <option value="">请选择</option>
              {Object.entries(roleOptions).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
            <button
              type="button"
              className={`${token.button} ${token.defaultButton} h-8 px-2 text-[#b42332]`}
              onClick={() => updateConfig({ steps: steps.filter((_, idx) => idx !== index) })}
            >
              删除
            </button>
          </div>
        ))}
        {!steps.length && <div className="border-t border-[#e8edf5] px-3 py-6 text-center text-sm text-[#8b95a7]">暂无审批步骤</div>}
      </div>
      <button
        type="button"
        className={`${token.button} ${token.defaultButton}`}
        onClick={() => updateConfig({ steps: [...steps, { stepCode: `step_${steps.length + 1}`, stepName: "审批", assigneeRole: "PRINCIPAL" }] })}
      >
        新增步骤
      </button>
    </div>
  );
}
