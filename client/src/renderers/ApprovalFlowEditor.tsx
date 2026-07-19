import { token } from "../styles/designTokens";
import { dictionaryOptionEntries, firstDictionaryOptionValue } from "../dsl/dictionaryLabels";

type Step = {
  stepCode?: string;
  stepName?: string;
  assigneeRole?: string;
};

function optionsFor(valueLabels: Record<string, Record<string, string>>, dictCode: string) {
  return valueLabels[dictCode] ?? {};
}

function firstOptionValue(options: Record<string, string>, fallback = "") {
  return firstDictionaryOptionValue(options, fallback);
}


function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stepsOf(config: Record<string, unknown>): Step[] {
  return Array.isArray(config.steps) ? config.steps as Step[] : [];
}

export function ApprovalFlowEditor({
  value,
  onChange,
  valueLabels = {}
}: {
  value: unknown;
  onChange: (next: Record<string, unknown>) => void;
  valueLabels?: Record<string, Record<string, string>>;
}) {
  const config = asObject(value);
  const steps = stepsOf(config);
  const triggerEvents = optionsFor(valueLabels, "approval_trigger_event");
  const pageOptions = optionsFor(valueLabels, "approval_trigger_page");
  const actionOptions = optionsFor(valueLabels, "approval_action_code");
  const roleOptions = optionsFor(valueLabels, "approval_role");

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
            {dictionaryOptionEntries(triggerEvents).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
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
            {dictionaryOptionEntries(pageOptions).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
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
            {dictionaryOptionEntries(actionOptions).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
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
            <select className={token.input} value={String(step.assigneeRole ?? "")} onChange={(event) => updateStep(index, { assigneeRole: event.target.value })}>
              <option value="">请选择</option>
              {dictionaryOptionEntries(roleOptions).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
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
        onClick={() => updateConfig({ steps: [...steps, { stepCode: `step_${steps.length + 1}`, stepName: "审批", assigneeRole: firstOptionValue(roleOptions) }] })}
      >
        新增步骤
      </button>
    </div>
  );
}
