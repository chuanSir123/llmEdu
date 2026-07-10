export function dictionaryOptionEntries(options: Record<string, string>) {
  const byLabel = new Map<string, [string, string]>();
  for (const [value, label] of Object.entries(options)) {
    const normalizedLabel = String(label);
    const current = byLabel.get(normalizedLabel);
    const currentIsDictionaryId = current?.[0].includes(".") ?? false;
    const nextIsDictionaryId = value.includes(".");
    if (!current || (nextIsDictionaryId && !currentIsDictionaryId)) byLabel.set(normalizedLabel, [value, normalizedLabel]);
  }
  return [...byLabel.values()];
}

export function preferredDictionaryValue(options: Record<string, string>, value: unknown) {
  const text = String(value ?? "");
  if (!text) return "";
  if (options[text] !== undefined && text.includes(".")) return text;
  const label = options[text];
  if (!label) return text;
  return dictionaryOptionEntries(options).find(([, optionLabel]) => optionLabel === label)?.[0] ?? text;
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
  const text = String(value ?? "");
  const dot = text.indexOf(".");
  return dot > 0 ? text.slice(dot + 1) : text;
}
