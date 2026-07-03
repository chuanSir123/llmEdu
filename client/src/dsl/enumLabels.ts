const enumFieldAliases: Record<string, string> = {
  category: "business_rule_category",
  businessType: "business_type",
  business_type: "business_type",
  recordType: "record_type"
};

export function enumLabelFor(fieldKey: string | undefined, value: unknown, pageLabels?: Record<string, Record<string, string>>) {
  if (value === null || value === undefined || value === "") return undefined;
  const text = String(value);
  if (!fieldKey) return undefined;
  const normalizedKey = enumFieldAliases[fieldKey] ?? fieldKey;
  return pageLabels?.[fieldKey]?.[text] ?? pageLabels?.[normalizedKey]?.[text];
}

export function enumDisplayFor(fieldKey: string | undefined, value: unknown, pageLabels?: Record<string, Record<string, string>>) {
  return enumLabelFor(fieldKey, value, pageLabels) ?? String(value ?? "");
}
