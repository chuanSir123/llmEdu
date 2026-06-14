import { useEffect, useState } from "react";
import { GatewayClient } from "../api/GatewayClient";
import type { FieldDsl, PageDsl } from "../dsl/types";
import { token } from "../styles/designTokens";

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
  const gridClass = columns === 3 ? "md:grid-cols-3" : "md:grid-cols-2";
  const spanClass = (field: FieldDsl) => {
    if (field.span === "full" || field.span === columns) return columns === 3 ? "md:col-span-3" : "md:col-span-2";
    if (field.span === 2) return "md:col-span-2";
    return "";
  };

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

  return (
    <div className={`grid grid-cols-1 gap-x-8 gap-y-4 ${gridClass}`}>
      {fields.map((field) => {
        const options = presentation?.valueLabels?.[field.key];
        const labelClass =
          labelAlign === "left" && field.type !== "textarea"
            ? "grid grid-cols-[72px_minmax(0,1fr)] items-center gap-2 text-sm"
            : "flex flex-col gap-1 text-sm";
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
            ) : field.type === "multiSelect" && field.optionSource ? (
              <select
                multiple
                className={`${token.input} h-28 w-full min-w-0 py-2`}
                value={(Array.isArray(value[field.key]) ? (value[field.key] as unknown[]) : []).map(String)}
                onChange={(event) => applySelectValue(field, Array.from(event.target.selectedOptions).map((option) => option.value))}
              >
                {(remoteOptions[field.key] ?? []).map(({ value: optionValue, label: optionLabel }) => (
                  <option key={optionValue} value={optionValue}>
                    {optionLabel}
                  </option>
                ))}
              </select>
            ) : field.optionSource || options ? (
              <select
                className={`${token.input} w-full min-w-0`}
                value={String(value[field.key] ?? "")}
                onChange={(event) => applySelectValue(field, event.target.value)}
              >
                <option value="">请选择</option>
                {(field.optionSource ? remoteOptions[field.key] ?? [] : Object.entries(options ?? {}).map(([optionValue, optionLabel]) => ({ value: optionValue, label: optionLabel }))).map(({ value: optionValue, label: optionLabel }) => (
                  <option key={optionValue} value={optionValue}>
                    {optionLabel}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className={`${token.input} w-full min-w-0`}
                type={field.type === "date" ? "date" : field.type === "datetime" ? "datetime-local" : field.type === "number" ? "number" : "text"}
                value={String(value[field.key] ?? "")}
                placeholder={field.placeholder}
                onChange={(event) => onChange({ ...value, [field.key]: event.target.value })}
              />
            )}
          </label>
        );
      })}
    </div>
  );
}
