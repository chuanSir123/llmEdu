import { useEffect, useRef, useState } from "react";
import { GatewayClient } from "../api/GatewayClient";
import type { FieldDsl, PageDsl } from "../dsl/types";
import { sortWithOrder } from "../dsl/sortWithOrder";
import { token } from "../styles/designTokens";
import { dictionaryDisplayFor, dictionaryOptionEntries } from "../dsl/dictionaryLabels";
import { effectiveOptionSource } from "../dsl/dictionarySource";
import { ApprovalFlowEditor } from "./ApprovalFlowEditor";
import { BusinessRuleEditor } from "./BusinessRuleEditor";
import { JsonTextarea } from "./JsonTextarea";
import { PermissionEditor } from "./PermissionEditor";

export function GenericFormRenderer({
  scope,
  schemaName,
  fields,
  value,
  onChange,
  presentation,
  columns = 3,
  labelAlign = "left"
}: {
  scope: "admin" | "tenant";
  schemaName?: string;
  fields: FieldDsl[];
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  presentation?: PageDsl["presentation"];
  columns?: 2 | 3;
  labelAlign?: "top" | "left";
}) {
  const [remoteOptions, setRemoteOptions] = useState<Record<string, Array<{ value: string; label: string; row: Record<string, unknown> }>>>({});
  const [searchText, setSearchText] = useState<Record<string, string>>({});
  const [openField, setOpenField] = useState<string | null>(null);
  const dropdownRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const gridClass = columns === 3 ? "md:grid-cols-3" : "md:grid-cols-2";
  const today = new Date().toISOString().slice(0, 10);
  const asStringArray = (raw: unknown) => Array.isArray(raw) ? raw.map((item) => String(item)).filter(Boolean) : String(raw ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  const spanClass = (field: FieldDsl) => {
    if (field.span === "full" || field.span === columns) return columns === 3 ? "md:col-span-3" : "md:col-span-2";
    if (field.span === 2) return "md:col-span-2";
    return "";
  };

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (!openField) return;
      const el = dropdownRefs.current[openField];
      if (el && !el.contains(e.target as Node)) setOpenField(null);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [openField]);

  useEffect(() => {
    let cancelled = false;
    const sourcedFields = fields.filter((field) => effectiveOptionSource(field));
    if (!sourcedFields.length) {
      setRemoteOptions({});
      return;
    }
    Promise.all(
      sourcedFields.map(async (field) => {
        const source = effectiveOptionSource(field)!;
        const result = await GatewayClient.executeApi({
          scope,
          schemaName,
          pageCode: source.pageCode,
          apiCode: source.apiCode,
          params: { filters: source.filters ?? {}, page: 1, pageSize: source.pageSize ?? 100 }
        });
        const data = result.data as { rows: Record<string, unknown>[] };
        const valueField = source.valueField ?? "id";
        const labelField = source.labelField ?? "name";
        return [
          field.key,
          data.rows.map((row) => ({
            value: String(row[valueField] ?? ""),
            label: String(row[labelField] ?? row[valueField] ?? ""),
            row
          }))
        ] as const;
      })
    )
      .then((entries) => {
        if (!cancelled) setRemoteOptions(Object.fromEntries(entries));
      })
      .catch(() => {
        if (!cancelled) setRemoteOptions({});
      });
    return () => {
      cancelled = true;
    };
  }, [scope, schemaName, JSON.stringify(fields.map((field) => effectiveOptionSource(field) ?? null))]);

  const applySelectValue = (field: FieldDsl, selectedValue: string | string[]) => {
    const next: Record<string, unknown> = { ...value, [field.key]: selectedValue };
    if (field.fillOnSelect && typeof selectedValue === "string") {
      const selected = (remoteOptions[field.key] ?? []).find((option) => option.value === selectedValue);
      for (const [targetKey, sourceKey] of Object.entries(field.fillOnSelect)) {
        next[targetKey] = selected?.row[sourceKey] ?? next[targetKey];
      }
    }
    onChange(next);
  };

  const normalizeSelectedValues = (raw: unknown) => {
    if (Array.isArray(raw)) return raw.map(String);
    if (typeof raw === "string" && raw.trim().startsWith("[")) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed.map(String);
      } catch {
        return [];
      }
    }
    return raw ? [String(raw)] : [];
  };

  const dedupeOptions = (options: Array<{ value: string; label: string; row: Record<string, unknown> }>) => {
    const byLabel = new Map<string, { value: string; label: string; row: Record<string, unknown> }>();
    for (const option of options) {
      const current = byLabel.get(option.label);
      const currentIsDictionaryId = current?.value.includes(".") ?? false;
      const nextIsDictionaryId = option.value.includes(".");
      if (!current || (nextIsDictionaryId && !currentIsDictionaryId)) byLabel.set(option.label, option);
    }
    return [...byLabel.values()];
  };

  const treeOptions = (field: FieldDsl, options?: Record<string, string>) => {
    const rawList = effectiveOptionSource(field) ? remoteOptions[field.key] ?? [] : dictionaryOptionEntries(options ?? {}).map(([value, label]) => ({ value, label, row: {} }));
    const list = dedupeOptions(rawList);
    if (!field.type?.startsWith("organizationTree")) return list.map((option) => ({ ...option, depth: 0 }));
    const byParent = new Map<string, typeof list>();
    for (const option of list) {
      const row = option.row as Record<string, unknown>;
      const parent = String(row.parent_id ?? "");
      byParent.set(parent, [...(byParent.get(parent) ?? []), option]);
    }
    const ordered: Array<(typeof list)[number] & { depth: number }> = [];
    const visit = (parentId: string, depth: number) => {
      for (const option of byParent.get(parentId) ?? []) {
        ordered.push({ ...option, depth });
        visit(option.value, depth + 1);
      }
    };
    visit("", 0);
    for (const option of list) {
      if (!ordered.some((item) => item.value === option.value)) ordered.push({ ...option, depth: 0 });
    }
    return ordered;
  };

  const fieldOptions = (field: FieldDsl, options?: Record<string, string>) => {
    const list = treeOptions(field, options);
    const query = String(searchText[field.key] ?? "").trim().toLowerCase();
    return query ? list.filter((option) => option.label.toLowerCase().includes(query) || option.value.toLowerCase().includes(query)) : list;
  };

  const optionMatchesRaw = (option: { value: string; row: Record<string, unknown> }, raw: unknown) => {
    const text = String(raw ?? "");
    if (!text) return false;
    const itemValue = String(option.row.itemValue ?? option.row.item_value ?? "");
    return option.value === text || option.value.endsWith(`.${text}`) || (Boolean(itemValue) && itemValue === text);
  };

  const formatInputValue = (field: FieldDsl, raw: unknown) => {
    if (raw === undefined || raw === null || raw === "") return "";
    const text = String(raw);
    if (field.type === "date") return text.slice(0, 10);
    if (field.type === "datetime") {
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text)) return text.slice(0, 16);
      const date = new Date(text);
      if (!Number.isNaN(date.getTime())) {
        const offsetMs = date.getTimezoneOffset() * 60000;
        return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
      }
    }
    return text;
  };

  const parseInputValue = (field: FieldDsl, raw: string) => {
    if (field.type === "number") return raw === "" ? "" : Number(raw);
    return raw;
  };

  const selectedLabel = (field: FieldDsl, options?: Record<string, string>) => {
    const raw = value[field.key];
    const selectedValues = normalizeSelectedValues(raw);
    if (field.type === "multiSelect" || field.type === "organizationTreeMultiSelect" || Array.isArray(raw)) {
      const allOptions = treeOptions(field, options);
      const labels = selectedValues
        .map((item) => allOptions.find((option) => optionMatchesRaw(option, item))?.label ?? String(item))
        .filter(Boolean);
      return labels.length ? labels.join("，") : "请选择";
    }
    if (!raw) return "请选择";
    return fieldOptions(field, options).find((option) => optionMatchesRaw(option, raw))?.label ?? String(raw);
  };

  function renderSearchableSelect(field: FieldDsl, options?: Record<string, string>) {
    const isMulti = (field.type === "multiSelect" && effectiveOptionSource(field)) || field.type === "organizationTreeMultiSelect";
    const opts = fieldOptions(field, options);
    const selLabel = selectedLabel(field, options);
    const isOpen = openField === field.key;

    return (
      <div className="relative min-w-0" ref={(el) => { dropdownRefs.current[field.key] = el; }}>
        <button
          type="button"
          className={`${token.input} w-full min-w-0 truncate text-left flex items-center justify-between gap-1`}
          onClick={() => { setOpenField(isOpen ? null : field.key); setSearchText({ ...searchText, [field.key]: "" }); }}
        >
          <span className="truncate">{selLabel}</span>
          <svg className={`h-4 w-4 shrink-0 text-[#8b95a7] transition-transform ${isOpen ? "rotate-180" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
        </button>
        {isOpen && (
          <div className="absolute left-0 right-0 top-[36px] z-50 border border-[#cfd8e6] bg-white shadow-[0_10px_24px_rgba(24,36,56,0.16)]">
            <div className="flex items-center border-b border-[#e8edf5] px-2">
              <svg className="h-4 w-4 shrink-0 text-[#8b95a7]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
              <input
                className="h-9 w-full border-0 px-2 text-sm outline-none"
                value={searchText[field.key] ?? ""}
                placeholder={`搜索${field.label ?? field.title ?? ""}...`}
                onChange={(event) => setSearchText({ ...searchText, [field.key]: event.target.value })}
                autoFocus
              />
            </div>
            <div className="max-h-52 overflow-auto py-1">
              {!isMulti && (
                <button type="button" className="block w-full px-3 py-2 text-left text-sm text-[#8b95a7] hover:bg-[#f2f7ff]" onClick={() => { applySelectValue(field, ""); setOpenField(null); }}>
                  请选择
                </button>
              )}
              {opts.map(({ value: optionValue, label: optionLabel, depth, row }) => {
                if (isMulti) {
                  const selected = normalizeSelectedValues(value[field.key]);
                  return (
                    <label key={optionValue} className="flex cursor-pointer items-center gap-2 py-2 pr-3 text-sm hover:bg-[#f2f7ff]" style={{ paddingLeft: 12 + (depth ?? 0) * 16 }}>
                      <input
                        type="checkbox"
                        checked={selected.some((item) => optionMatchesRaw({ value: optionValue, row }, item))}
                        onChange={(event) => {
                          const next = event.target.checked ? [...selected.filter((item) => !optionMatchesRaw({ value: optionValue, row }, item)), optionValue] : selected.filter((item) => !optionMatchesRaw({ value: optionValue, row }, item));
                          applySelectValue(field, next);
                        }}
                      />
                      <span className="truncate">{optionLabel}</span>
                    </label>
                  );
                }
                const isSelected = optionMatchesRaw({ value: optionValue, row }, value[field.key]);
                return (
                  <button
                    type="button"
                    key={optionValue}
                    className={`flex w-full items-center gap-2 truncate px-3 py-2 text-left text-sm hover:bg-[#f2f7ff] ${isSelected ? "bg-[#edf3ff] text-[#2f80ed] font-medium" : "text-[#263445]"}`}
                    style={{ paddingLeft: 12 + (depth ?? 0) * 16 }}
                    onClick={() => {
                      applySelectValue(field, optionValue);
                      setOpenField(null);
                    }}
                  >
                    {isSelected && <svg className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>}
                    <span className="truncate">{optionLabel}</span>
                  </button>
                );
              })}
              {!opts.length && <div className="px-3 py-3 text-sm text-[#8b95a7]">无匹配选项</div>}
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={`grid grid-cols-1 gap-x-8 gap-y-4 ${gridClass}`}>
      {sortWithOrder(fields).map((field) => {
        const options = presentation?.valueLabels?.[field.key];
        const labelClass =
          labelAlign === "left" && field.type !== "textarea"
            ? "grid grid-cols-[72px_minmax(0,1fr)] items-center gap-2 text-sm"
            : "flex flex-col gap-1 text-sm";
        const isReadonly = field.computed && !field.editable;
        return (
          <label key={field.key} className={`${labelClass} ${spanClass(field)}`}>
            <span className="text-sm text-[#5f6b7a]">{field.label ?? field.title ?? field.key}</span>
            {field.type === "textarea" ? (
              <textarea
                className={`${token.input} min-h-[96px] w-full min-w-0 resize-y py-2 leading-5`}
                rows={field.rows ?? 4}
                value={isReadonly ? dictionaryDisplayFor(field.key, value[field.key], presentation?.valueLabels) : formatInputValue(field, value[field.key])}
                placeholder={field.placeholder}
                onChange={(event) => onChange({ ...value, [field.key]: event.target.value })}
              />
            ) : field.type === "multiDate" ? (
              <div className="space-y-2">
                {asStringArray(value[field.key]).length ? asStringArray(value[field.key]).map((dateValue, idx) => (
                  <div key={`${field.key}-${idx}`} className="flex gap-2">
                    <input
                      className={`${token.input} flex-1`}
                      type="date"
                      min={field.defaultFutureOnly ? today : undefined}
                      value={dateValue}
                      onChange={(event) => {
                        const next = asStringArray(value[field.key]);
                        next[idx] = event.target.value;
                        onChange({ ...value, [field.key]: [...new Set(next.filter(Boolean))] });
                      }}
                    />
                    <button type="button" className={token.defaultButton} onClick={() => onChange({ ...value, [field.key]: asStringArray(value[field.key]).filter((_, nextIdx) => nextIdx !== idx) })}>移除</button>
                  </div>
                )) : null}
                <button type="button" className={token.defaultButton} onClick={() => onChange({ ...value, [field.key]: [...asStringArray(value[field.key]), today] })}>添加日期</button>
              </div>
            ) : field.type === "multiText" ? (
              <input
                className={`${token.input} w-full min-w-0`}
                value={asStringArray(value[field.key]).join(",")}
                placeholder={field.placeholder ?? "多个值用逗号分隔"}
                onChange={(event) => onChange({ ...value, [field.key]: asStringArray(event.target.value) })}
              />
            ) : field.type === "performance_split_table" ? (
              <div className="space-y-2">
                {(Array.isArray(value[field.key]) ? value[field.key] as Record<string, unknown>[] : []).map((item, idx) => (
                  <div key={`${field.key}-${idx}`} className="grid grid-cols-1 gap-2 rounded border border-[#e8edf5] bg-[#fbfcff] p-2 md:grid-cols-5">
                    <input className={token.input} placeholder="员工ID" value={String(item.personal_performance_user_id ?? "")} onChange={(event) => { const rows = [...(value[field.key] as Record<string, unknown>[] ?? [])]; rows[idx] = { ...rows[idx], personal_performance_user_id: event.target.value }; onChange({ ...value, [field.key]: rows, items: rows }); }} />
                    <input className={token.input} type="number" placeholder="个人金额" value={String(item.personal_performance_amount ?? "")} onChange={(event) => { const rows = [...(value[field.key] as Record<string, unknown>[] ?? [])]; rows[idx] = { ...rows[idx], personal_performance_amount: Number(event.target.value || 0) }; onChange({ ...value, [field.key]: rows, items: rows }); }} />
                    <input className={token.input} placeholder="校区ID" value={String(item.organization_performance_organization_id ?? "")} onChange={(event) => { const rows = [...(value[field.key] as Record<string, unknown>[] ?? [])]; rows[idx] = { ...rows[idx], organization_performance_organization_id: event.target.value, organization_id: event.target.value }; onChange({ ...value, [field.key]: rows, items: rows }); }} />
                    <input className={token.input} type="number" placeholder="校区金额" value={String(item.organization_performance_amount ?? "")} onChange={(event) => { const rows = [...(value[field.key] as Record<string, unknown>[] ?? [])]; rows[idx] = { ...rows[idx], organization_performance_amount: Number(event.target.value || 0) }; onChange({ ...value, [field.key]: rows, items: rows }); }} />
                    <button type="button" className={token.defaultButton} onClick={() => { const rows = (value[field.key] as Record<string, unknown>[] ?? []).filter((_, nextIdx) => nextIdx !== idx); onChange({ ...value, [field.key]: rows, items: rows }); }}>移除</button>
                  </div>
                ))}
                <button type="button" className={token.defaultButton} onClick={() => { const rows = [...(Array.isArray(value[field.key]) ? value[field.key] as Record<string, unknown>[] : []), { performance_type: value.performance_type ?? "MANUAL_ADJUST", source_type: value.source_type ?? "MANUAL_ADJUSTMENT", contract_product_id: value.contract_product_id, funds_change_history_id: value.funds_change_history_id, adjustment_reason: value.adjustment_reason }]; onChange({ ...value, [field.key]: rows, items: rows }); }}>添加分摊行</button>
              </div>
            ) : field.type === "json_textarea" ? (
              <JsonTextarea
                value={value[field.key]}
                rows={field.rows ?? 12}
                onChange={(next) => onChange({ ...value, [field.key]: next })}
              />
            ) : field.type === "approval_flow_editor" ? (
              <ApprovalFlowEditor
                value={value[field.key]}
                valueLabels={presentation?.valueLabels}
                onChange={(next) => onChange({ ...value, [field.key]: next, business_type: next.businessType ?? value.business_type })}
              />
            ) : field.type === "business_rule_editor" ? (
              <BusinessRuleEditor
                value={value[field.key]}
                valueLabels={presentation?.valueLabels}
                editorSchema={field.editorSchema}
                onChange={(next) => onChange({ ...value, [field.key]: next })}
              />
            ) : field.type === "permission_editor" ? (
              <PermissionEditor
                scope={scope}
                schemaName={schemaName}
                roleId={String(value.id ?? value.role_id ?? "")}
                value={value[field.key]}
                onChange={(items) => onChange({ ...value, [field.key]: items, items })}
              />
            ) : effectiveOptionSource(field) || options ? (
              renderSearchableSelect(field, options)
            ) : (
              <input
                className={`${token.input} w-full min-w-0 ${isReadonly ? "bg-[#f5f7fa] text-[#8b95a7] cursor-default" : ""}`}
                type={field.type === "date" ? "date" : field.type === "datetime" ? "datetime-local" : field.type === "number" ? "number" : "text"}
                value={isReadonly ? dictionaryDisplayFor(field.key, value[field.key], presentation?.valueLabels) : formatInputValue(field, value[field.key])}
                placeholder={field.placeholder}
                readOnly={isReadonly}
                onChange={(event) => onChange({ ...value, [field.key]: parseInputValue(field, event.target.value) })}
              />
            )}
          </label>
        );
      })}
    </div>
  );
}
