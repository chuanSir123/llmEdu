import { dictionaryItemValue } from "../dsl/dictionaryLabels";
import { token } from "../styles/designTokens";

type ApprovalTaskDetailProps = {
  value: Record<string, unknown>;
  onClose: () => void;
  onApprove?: () => void;
  onReject?: () => void;
};

const statusLabels: Record<string, string> = { PENDING: "审批中", APPROVED: "已通过", REJECTED: "已驳回", CANCELED: "已撤回" };
const actionLabels: Record<string, string> = { SUBMIT: "发起", APPROVE: "同意", REJECT: "驳回", CANCEL: "撤回" };

function asObject(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === "object") as Record<string, unknown>[] : [];
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "-";
  if (Array.isArray(value)) return value.map(displayValue).join("，");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function labelForKey(key: string) {
  const labels: Record<string, string> = {
    student_ids: "学员", product_ids: "报读课程", promotion_id: "合同优惠", contract_type: "合同类型",
    organization_id: "校区", sign_staff_id: "签约人", sign_time: "签约时间", total_amount: "应收金额",
    promotion_amount: "优惠金额", paid_amount: "已收金额", remark: "备注"
  };
  return labels[key] ?? key;
}

export function ApprovalTaskDetail({ value, onClose, onApprove, onReject }: ApprovalTaskDetailProps) {
  const form = asObject(value.form_json);
  const payload = asObject(form.payload);
  const steps = asArray(form.steps);
  const logs = asArray(value.logs ?? form.logs);
  const currentIndex = Number(value.current_step_index ?? 0);
  const status = dictionaryItemValue(value.status ?? "");
  const businessEntries = Object.entries(payload).filter(([key]) => !["approval_comment", "approval_task_id", "approvalTaskId"].includes(key));

  return (
    <div className="fixed inset-0 z-[200] flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-6 sm:p-6 sm:pt-8">
      <div className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-[#e8edf5] px-5 py-4">
          <div>
            <div className="text-base font-semibold text-[#172033]">审批详情</div>
            <div className="mt-1 text-xs text-[#7a8494]">{String(value.flow_name ?? form.flowName ?? "审批流")} · {statusLabels[status] ?? status}</div>
          </div>
          <button className="text-xl text-[#8b95a7] hover:text-[#2f80ed]" onClick={onClose}>×</button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-5 text-sm text-[#263445]">
          <section className="mb-6">
            <h3 className="mb-3 text-sm font-semibold text-[#172033]">业务详情</h3>
            <div className="grid grid-cols-3 gap-x-8 gap-y-3">
              <div><span className="text-[#7a8494]">业务类型：</span>{displayValue(value.business_type)}</div>
              <div><span className="text-[#7a8494]">业务单据：</span>{displayValue(value.business_id)}</div>
              <div><span className="text-[#7a8494]">申请人：</span>{displayValue(value.applicant_name)}</div>
              {businessEntries.map(([key, val]) => (
                <div key={key} className="min-w-0"><span className="text-[#7a8494]">{labelForKey(key)}：</span><span className="break-all">{displayValue(val)}</span></div>
              ))}
            </div>
          </section>
          <section className="mb-6">
            <h3 className="mb-3 text-sm font-semibold text-[#172033]">业务流转顺序</h3>
            <div className="flex flex-wrap items-start gap-3">
              {steps.map((step, index) => {
                const active = status === "PENDING" && index === currentIndex;
                const done = status !== "PENDING" ? status === "APPROVED" : index < currentIndex;
                return (
                  <div key={String(step.stepCode ?? index)} className="flex items-center gap-3">
                    <div className={`flex h-8 w-8 items-center justify-center rounded-full border text-sm font-semibold ${active ? "border-[#2f80ed] bg-[#2f80ed] text-white" : done ? "border-[#2f80ed] bg-[#eaf3ff] text-[#2f80ed]" : "border-[#cfd8e6] bg-white text-[#8b95a7]"}`}>{index + 1}</div>
                    <div>
                      <div className={active ? "font-medium text-[#1765d8]" : "text-[#526075]"}>{displayValue(step.stepName)}</div>
                      <div className="text-xs text-[#8b95a7]">{displayValue(step.assigneeRole)}</div>
                    </div>
                    {index < steps.length - 1 && <div className="h-px w-12 bg-[#cfe0ff]" />}
                  </div>
                );
              })}
              {!steps.length && <div className="text-[#8b95a7]">暂无流转步骤</div>}
            </div>
          </section>
          <section>
            <h3 className="mb-3 text-sm font-semibold text-[#172033]">当前审批位置</h3>
            <div className="mb-3 text-[#526075]">当前节点：{steps[currentIndex]?.stepName ? displayValue(steps[currentIndex].stepName) : statusLabels[status] ?? status}</div>
            <div className="grid grid-cols-1 gap-2">
              {logs.map((log, index) => <div key={index} className="border border-[#edf1f6] bg-[#fbfcfe] p-3"><span className="font-medium">{actionLabels[String(log.action)] ?? displayValue(log.action)}</span> · {displayValue(log.step_name ?? log.stepName)} · {displayValue(log.comment)}</div>)}
              {!logs.length && <div className="text-[#8b95a7]">暂无审批日志</div>}
            </div>
          </section>
        </div>
        <div className="flex justify-end gap-2 border-t border-[#e8edf5] px-5 py-3">
          <button className={`${token.button} ${token.defaultButton}`} onClick={onClose}>关闭</button>
          {status === "PENDING" && onReject && <button className={`${token.button} ${token.defaultButton}`} onClick={onReject}>驳回</button>}
          {status === "PENDING" && onApprove && <button className={`${token.button} ${token.primaryButton}`} onClick={onApprove}>同意</button>}
        </div>
      </div>
    </div>
  );
}
