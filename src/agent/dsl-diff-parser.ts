import type { DslDiff } from "./types.js";

export function parsePlanDiffsFromToolArguments(argumentsJson: string): DslDiff[] {
  try {
    const args = JSON.parse(argumentsJson) as { diffs?: unknown };
    return parseDiffsValue(args.diffs);
  } catch {
    return [];
  }
}

function parseDiffsValue(value: unknown): DslDiff[] {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parseDiffsValue(parsed);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return value
    .filter((d): d is Record<string, unknown> => Boolean(d) && typeof d === "object" && !Array.isArray(d) && Boolean(d.targetType && d.targetCode && d.op))
    .map((d) => ({
      targetType: String(d.targetType) as DslDiff["targetType"],
      targetCode: String(d.targetCode),
      op: String(d.op) as DslDiff["op"],
      field: d.field ? String(d.field) : undefined,
      fieldDef: d.fieldDef as Record<string, unknown> | undefined,
      resourceDef: d.resourceDef as Record<string, unknown> | undefined,
      sortOrder: d.sortOrder != null ? Number(d.sortOrder) : undefined,
      modifiedDslJson: d.modifiedDslJson,
    }));
}
