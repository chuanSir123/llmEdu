export function dictionaryOptionEntries(options: Record<string, string>) {
  return Object.entries(options).map(([value, label]) => [value, String(label)] as [string, string]);
}

export function firstDictionaryOptionValue(options: Record<string, string>, fallback = "") {
  return dictionaryOptionEntries(options)[0]?.[0] ?? fallback;
}

export function dictionaryLabelFor(fieldKey: string | undefined, value: unknown, pageLabels?: Record<string, Record<string, string>>) {
  if (value === null || value === undefined || value === "") return undefined;
  const text = String(value);
  if (!fieldKey) return undefined;
  return pageLabels?.[fieldKey]?.[text];
}

export function dictionaryDisplayFor(fieldKey: string | undefined, value: unknown, pageLabels?: Record<string, Record<string, string>>): string {
  if (Array.isArray(value)) return value.map((item) => dictionaryDisplayFor(fieldKey, item, pageLabels)).filter(Boolean).join(", ");
  return dictionaryLabelFor(fieldKey, value, pageLabels) ?? String(value ?? "");
}

export function dictionaryItemValue(value: unknown) {
  return String(value ?? "");
}
