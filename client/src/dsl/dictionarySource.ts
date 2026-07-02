import type { FieldDsl } from "./types";

const fieldDictAliases: Record<string, string> = {
  category: "business_rule_category",
  businessType: "business_type",
  business_type: "business_type"
};

export function fieldDictCode(field: FieldDsl) {
  return field.dictCode ?? field.optionSource?.dictCode ?? (field.optionSource?.type === "dictionary" ? field.optionSource?.filters?.dictCode as string | undefined : undefined) ?? fieldDictAliases[field.key];
}

export function dictionaryOptionSource(field: FieldDsl) {
  const dictCode = fieldDictCode(field);
  if (!dictCode) return undefined;
  return {
    pageCode: field.optionSource?.pageCode ?? "__dictionary__",
    apiCode: field.optionSource?.apiCode ?? "dictionary.options",
    filters: { ...(field.optionSource?.filters ?? {}), dictCode },
    valueField: field.optionSource?.valueField ?? "value",
    labelField: field.optionSource?.labelField ?? "label",
    pageSize: field.optionSource?.pageSize ?? 200,
    includeRow: field.optionSource?.includeRow
  };
}

export function effectiveOptionSource(field: FieldDsl) {
  return dictionaryOptionSource(field) ?? field.optionSource;
}
