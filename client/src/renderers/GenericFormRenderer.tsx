import { useEffect, useRef, useState } from "react";
import { GatewayClient } from "../api/GatewayClient";
import type { FieldDsl, PageDsl } from "../dsl/types";
import { sortWithOrder } from "../dsl/sortWithOrder";
import { token } from "../styles/designTokens";
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
    const sourcedFields = fields.filter((field) => field.optionSource);
    if (!sourcedFields.length) {
      setRemoteOptions({});
      return;
    }
    Promise.all(
      sourcedFields.map(async (field) => {
        const source = field.optionSource!;
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
  }, [scope, schemaName, JSON.stringify(fields.map((field) => field.optionSource ?? null))]);

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

  const fieldOptions = (field: FieldDsl, options?: Record<string, string>) => {
    const list = field.optionSource ? remoteOptions[field.key] ?? [] : Object.entries(options ?? {}).map(([value, label]) => ({ value, label, row: {} }));
    const query = String(searchText[field.key] ?? "").trim().toLowerCase();
    return query ? list.filter((option) => option.label.toLowerCase().includes(query) || option.value.toLowerCase().includes(query)) : list;
  };

  const selectedLabel = (field: FieldDsl, options?: Record<string, string>) => {
    const raw = value[field.key];
    if (Array.isArray(raw)) {
      const labels = raw
        .map((item) => fieldOptions(field, options).find((option) => option.value === String(item))?.label ?? String(item))
        .filter(Boolean);
      return labels.length ? labels.join("，") : "请选择";
    }
    if (!raw) return "请选择";
    return fieldOptions(field, options).find((option) => option.value === String(raw))?.label ?? String(raw);
  };

  function renderSearchableSelect(field: FieldDsl, options?: Record<string, string>) {
    const isMulti = field.type === "multiSelect" && field.optionSource;
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
              {opts.map(({ value: optionValue, label: optionLabel }) => {
                if (isMulti) {
                  const selected = (Array.isArray(value[field.key]) ? (value[field.key] as unknown[]) : []).map(String);
                  return (
                    <label key={optionValue} className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm hover:bg-[#f2f7ff]">
                      <input
                        type="checkbox"
                        checked={selected.includes(optionValue)}
                        onChange={(event) => {
                          const next = event.target.checked ? [...selected, optionValue] : selected.filter((item) => item !== optionValue);
                          applySelectValue(field, next);
                        }}
                      />
                      <span className="truncate">{optionLabel}</span>
                    </label>
                  );
                }
                const isSelected = String(value[field.key]) === optionValue;
                return (
                  <button
                    type="button"
                    key={optionValue}
                    className={`flex w-full items-center gap-2 truncate px-3 py-2 text-left text-sm hover:bg-[#f2f7ff] ${isSelected ? "bg-[#edf3ff] text-[#2f80ed] font-medium" : "text-[#263445]"}`}
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
                value={String(value[field.key] ?? "")}
                placeholder={field.placeholder}
                onChange={(event) => onChange({ ...value, [field.key]: event.target.value })}
              />
            ) : field.type === "json_textarea" ? (
              <JsonTextarea
                value={value[field.key]}
                rows={field.rows ?? 12}
                onChange={(next) => onChange({ ...value, [field.key]: next })}
              />
            ) : field.type === "approval_flow_editor" ? (
              <ApprovalFlowEditor
                value={value[field.key]}
                onChange={(next) => onChange({ ...value, [field.key]: next, business_type: next.businessType ?? value.business_type })}
              />
            ) : field.type === "business_rule_editor" ? (
              <BusinessRuleEditor
                value={value[field.key]}
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
            ) : field.optionSource || options ? (
              renderSearchableSelect(field, options)
            ) : (
              <input
                className={`${token.input} w-full min-w-0 ${isReadonly ? "bg-[#f5f7fa] text-[#8b95a7] cursor-default" : ""}`}
                type={field.type === "date" ? "date" : field.type === "datetime" ? "datetime-local" : field.type === "number" ? "number" : "text"}
                value={String(value[field.key] ?? "")}
                placeholder={field.placeholder}
                readOnly={isReadonly}
                onChange={(event) => onChange({ ...value, [field.key]: event.type === "number" ? (event.target.value === "" ? "" : Number(event.target.value)) : event.target.value })}
              />
            )}
          </label>
        );
      })}
    </div>
  );
}
