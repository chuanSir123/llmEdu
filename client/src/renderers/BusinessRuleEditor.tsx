import { token } from "../styles/designTokens";
import { dictionaryOptionEntries, firstDictionaryOptionValue, preferredDictionaryValue, dictionaryItemValue } from "../dsl/dictionaryLabels";

type RuleValue = Record<string, unknown>;
type ConditionRow = { field?: string; operator?: string; value?: unknown; valueField?: string; message?: string };
type RuleField = { key: string; label: string; dictCode?: string; options?: Record<string, string>; suffix?: string };
type RuleSection = { selects?: RuleField[]; switches?: RuleField[]; numbers?: RuleField[]; rows?: Array<"conditions" | "validations"> };
type RuleEditorSchema = { sections?: Record<string, RuleSection> };

function asEditorSchema(value: unknown): RuleEditorSchema {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RuleEditorSchema : {};
}

function hydrateOptions(section: RuleSection, valueLabels: Record<string, Record<string, string>>): RuleSection {
  const hydrate = (field: RuleField) => ({ ...field, options: field.options ?? (field.dictCode ? valueLabels[field.dictCode] : {}) ?? {} });
  return {
    ...section,
    selects: section.selects?.map(hydrate),
    switches: section.switches?.map(hydrate),
    numbers: section.numbers?.map(hydrate)
  };
}

function buildRuleSections(valueLabels: Record<string, Record<string, string>>, editorSchema?: unknown): Record<string, RuleSection> {
  const configured = asEditorSchema(editorSchema).sections ?? {};
  return Object.fromEntries(Object.entries(configured).map(([key, section]) => [key, hydrateOptions(section, valueLabels)]));
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

function categoryValues(rule: RuleValue) {
  const values = Array.isArray(rule.categories) ? rule.categories : [rule.category];
  return Array.from(new Set(values.map((item) => dictionaryItemValue(item)).filter(Boolean)));
}

function categoryLabels(values: string[], options: Record<string, string>) {
  return values.map((value) => options[value] ?? options[preferredDictionaryValue(options, value)] ?? value).join("、") || "未设置";
}

function displayValue(key: string, value: unknown, ruleSections: ReturnType<typeof buildRuleSections>) {
  if (value === undefined || value === null || value === "") return "未设置";
  const section = Object.values(ruleSections).find((item) => item.selects?.some((select) => select.key === key));
  const select = section?.selects?.find((item) => item.key === key);
  const options = select?.options ?? {};
  return options[String(value)] ?? options[preferredDictionaryValue(options, value)] ?? String(value);
}

export function BusinessRuleEditor({ value, onChange, readonly = false, valueLabels = {}, editorSchema }: { value: unknown; onChange: (next: RuleValue) => void; readonly?: boolean; valueLabels?: Record<string, Record<string, string>>; editorSchema?: unknown }) {
  const rule = toObject(value);
  const ruleSections = buildRuleSections(valueLabels, editorSchema);
  const selectedCategories = categoryValues(rule);
  const conditionFieldOptions = valueLabels.rule_condition_field ?? {};
  const systemValueOptions = valueLabels.rule_system_value ?? {};
  const operatorOptions = valueLabels.rule_operator ?? {};
  const categoryOptions = Object.fromEntries(Object.entries(valueLabels.business_rule_category ?? {}).filter(([value]) => Boolean(ruleSections[dictionaryItemValue(value)])));
  const businessTypeOptions = valueLabels.business_type ?? {};

  const patch = (key: string, nextValue: unknown) => onChange(cleanEmpty({ ...rule, [key]: nextValue }));
  const patchCategories = (next: string[]) => onChange(cleanEmpty({ ...rule, category: next[0] ?? "", categories: next }));

  const renderSelect = (field: RuleField) => (
    <label key={field.key} className="flex flex-col gap-1 text-sm">
      <span className="text-[#5f6b7a]">{field.label}</span>
      {readonly ? (
        <div className="min-h-9 border border-[#dde3ee] bg-[#f7f8fa] px-3 py-2 text-[#263445]">{displayValue(field.key, rule[field.key], ruleSections)}</div>
      ) : (
        <select className={token.input} value={preferredDictionaryValue(field.options ?? {}, rule[field.key])} onChange={(event) => patch(field.key, event.target.value)}>
          <option value="">不设置</option>
          {optionEntries(field.options ?? {}).map(([optionValue, label]) => <option key={optionValue} value={optionValue}>{label}</option>)}
        </select>
      )}
    </label>
  );

  const renderSwitch = (field: RuleField) => (
    <label key={field.key} className="flex items-center gap-2 border border-[#e8edf5] px-3 py-2 text-sm">
      <input type="checkbox" checked={Boolean(rule[field.key])} disabled={readonly} onChange={(event) => patch(field.key, event.target.checked)} />
      <span>{field.label}</span>
    </label>
  );

  const renderNumber = (field: RuleField) => (
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
            <div className="min-h-9 border border-[#dde3ee] bg-[#f7f8fa] px-3 py-2 text-[#263445]">{categoryLabels(selectedCategories, categoryOptions)}</div>
          ) : (
            <div className="grid gap-2 rounded border border-[#dde3ee] bg-white p-3 md:grid-cols-2">
              {optionEntries(categoryOptions).map(([optionValue, label]) => {
                const categoryValue = dictionaryItemValue(optionValue);
                return (
                  <label key={optionValue} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={selectedCategories.includes(categoryValue)}
                      onChange={(event) => patchCategories(event.target.checked ? [...selectedCategories, categoryValue] : selectedCategories.filter((item) => item !== categoryValue))}
                    />
                    <span>{label}</span>
                  </label>
                );
              })}
              {!optionEntries(categoryOptions).length && <div className="text-xs text-[#8b95a7]">当前页面 DSL 未配置可编辑规则分类</div>}
            </div>
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

      {selectedCategories.map((categoryKey) => {
        const section = ruleSections[categoryKey];
        if (!section) return null;
        return (
          <section key={categoryKey} className="space-y-4 rounded-lg border border-[#e8edf5] p-4">
            <div className="text-sm font-semibold text-[#263445]">{categoryLabels([categoryKey], categoryOptions)}</div>
            {section.selects?.length ? <div><div className="mb-2 text-sm font-medium text-[#263445]">业务规则</div><div className="grid gap-4 md:grid-cols-3">{section.selects.map(renderSelect)}</div></div> : null}
            {section.numbers?.length ? <div><div className="mb-2 text-sm font-medium text-[#263445]">数值设置</div><div className="grid gap-4 md:grid-cols-3">{section.numbers.map(renderNumber)}</div></div> : null}
            {section.switches?.length ? <div><div className="mb-2 text-sm font-medium text-[#263445]">规则开关</div><div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">{section.switches.map(renderSwitch)}</div></div> : null}
            {section.rows?.includes("conditions") && renderRows("conditions", "触发条件")}
            {section.rows?.includes("validations") && renderRows("validations", "校验条件")}
          </section>
        );
      })}
    </div>
  );
}
