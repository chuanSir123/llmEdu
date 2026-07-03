import type { FieldDsl, PageDsl } from "../dsl/types";
import { token } from "../styles/designTokens";
import { enumDisplayFor } from "../dsl/enumLabels";
import { BusinessRuleEditor } from "./BusinessRuleEditor";
import { GenericFormRenderer } from "./GenericFormRenderer";

export function ModalRenderer({
  scope,
  schemaName,
  title,
  fields,
  value,
  readonly,
  onChange,
  onClose,
  onSubmit,
  presentation,
  size
}: {
  scope: "admin" | "tenant";
  schemaName?: string;
  title: string;
  fields: FieldDsl[];
  value: Record<string, unknown>;
  readonly?: boolean;
  onChange: (next: Record<string, unknown>) => void;
  onClose: () => void;
  onSubmit?: () => void;
  presentation?: PageDsl["presentation"];
  size?: "default" | "large" | "fullscreen";
}) {
  const modalStyle = presentation?.modal?.style ?? "default";
  const visibleFields = fields.filter((field) => field.key !== "id" && !field.hidden);
  const columns = presentation?.modal?.columns ?? (visibleFields.length >= 4 ? 3 : 2);
  const labelAlign = presentation?.modal?.labelAlign ?? "left";
  const modalSize = size ?? presentation?.modal?.size ?? (visibleFields.length >= 12 ? "fullscreen" : visibleFields.length >= 6 ? "large" : "default");
  const isBoss = modalStyle === "bossForm";
  const widthClass =
    modalSize === "fullscreen"
      ? "h-[92vh] max-w-[1280px]"
      : modalSize === "large"
        ? "min-h-[560px] max-w-[1180px]"
        : "min-h-[460px] max-w-[1040px]";
  const spanClass = (field: FieldDsl) => {
    if (field.span === "full" || field.span === columns) return columns === 3 ? "md:col-span-3" : "md:col-span-2";
    if (field.span === 2) return "md:col-span-2";
    return "";
  };
  const displayValue = (field: FieldDsl) => {
    const raw = field.displayKey && value[field.displayKey] !== undefined && value[field.displayKey] !== null && value[field.displayKey] !== ""
      ? value[field.displayKey]
      : value[field.key];
    if (raw === null || raw === undefined || raw === "") return "-";
    return enumDisplayFor(field.key, raw, presentation?.valueLabels);
  };
  const readonlyFieldClass = (field: FieldDsl) =>
    field.type === "textarea"
      ? `flex flex-col gap-2 ${spanClass(field)}`
      : `grid grid-cols-[72px_minmax(0,1fr)] items-center gap-2 ${spanClass(field)}`;
  return (
    <div className={isBoss ? "fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4" : token.modalBackdrop}>
      <div className={isBoss ? `flex max-h-[92vh] w-full flex-col ${widthClass} rounded-[3px] bg-white shadow-[0_18px_48px_rgba(15,23,42,0.28)]` : `flex max-h-[92vh] w-full flex-col ${widthClass} rounded-[4px] border border-[#e5e8ef] bg-white shadow-xl`}>
        <div className={isBoss ? "flex h-12 shrink-0 items-center justify-between border-b border-[#e8edf5] px-5" : "flex h-12 shrink-0 items-center justify-between border-b border-line px-4"}>
          <h3 className={isBoss ? "text-base font-semibold text-[#263445]" : "text-base font-semibold"}>{title}</h3>
          <button className="text-xl leading-none text-[#9aa4b5] hover:text-[#526075]" onClick={onClose}>
            ×
          </button>
        </div>
        <div className={isBoss ? "min-h-0 flex-1 overflow-auto px-8 py-7" : "min-h-0 flex-1 overflow-auto p-4"}>
          {readonly ? (
            <div className={`grid grid-cols-1 gap-x-8 gap-y-5 ${columns === 3 ? "md:grid-cols-3" : "md:grid-cols-2"}`}>
              {visibleFields.map((field) => (
                <div key={field.key} className={readonlyFieldClass(field)}>
                  <div className={`${field.type === "textarea" ? "text-left" : "text-right"} text-sm text-[#5f6b7a]`}>
                    {field.label ?? field.title ?? field.key}
                  </div>
                  {field.type === "business_rule_editor" ? (
                    <div className="border border-[#dde3ee] bg-white p-3">
                      <BusinessRuleEditor value={value[field.key]} valueLabels={presentation?.valueLabels} readonly onChange={() => undefined} />
                    </div>
                  ) : (
                    <div
                      className={`min-h-8 border border-[#dde3ee] bg-[#f7f8fa] px-3 py-1.5 text-sm leading-5 text-[#263445] ${
                        field.type === "textarea" ? "min-h-[120px] whitespace-pre-wrap py-3" : ""
                      }`}
                    >
                      {displayValue(field)}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <GenericFormRenderer
              scope={scope}
              schemaName={schemaName}
              fields={fields}
              value={value}
              onChange={onChange}
              presentation={presentation}
              columns={columns}
              labelAlign={labelAlign}
            />
          )}
        </div>
        {!readonly && (
          <div className={isBoss ? "flex shrink-0 justify-end gap-2 border-t border-[#e8edf5] px-6 py-4" : "flex shrink-0 justify-end gap-2 border-t border-line p-4"}>
            <button className={`${token.button} ${token.defaultButton}`} onClick={onClose}>
              取消
            </button>
            <button className={`${token.button} ${token.primaryButton}`} onClick={onSubmit}>
              保存
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
