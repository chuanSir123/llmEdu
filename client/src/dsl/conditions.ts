/**
 * visibleWhen / enabledWhen 条件求值器（与 seed DSL 的契约）：
 * - 原始值 = eq；数组 = in；对象 { op: "eq"|"ne"|"in"|"notIn"|"gt"|"gte"|"lt"|"lte", value } 按 op 比较。
 * - 行内字段缺失（undefined）时：eq/in/gt/gte/lt/lte 返回 false，ne/notIn 返回 true。
 * GenericTableRenderer / GenericFormRenderer / CalendarView 共用，勿在各处复制判断逻辑。
 */

const COMPARE_OPS = new Set(["eq", "ne", "in", "notIn", "gt", "gte", "lt", "lte"]);

function conditionValue(value: unknown): string {
  return String(value ?? "");
}

function businessValue(value: unknown): string {
  const text = conditionValue(value);
  return text.includes(".") ? text.split(".").pop() ?? text : text;
}

function isOpCondition(value: unknown): value is { op: string; value?: unknown } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const op = (value as Record<string, unknown>).op;
  return typeof op === "string" && COMPARE_OPS.has(op);
}

function toList(target: unknown): string[] {
  return Array.isArray(target) ? target.map(conditionValue) : [conditionValue(target)];
}

export function evaluateCondition(expected: unknown, actual: unknown): boolean {
  const missing = actual === undefined;
  // null 沿用旧求值器的 "" 口径；undefined 才算"字段缺失"
  const actualText = String(actual ?? "");
  if (isOpCondition(expected)) {
    const target = expected.value;
    if (expected.op === "ne") return missing ? true : businessValue(actualText) !== businessValue(target);
    if (expected.op === "notIn") return missing ? true : !toList(target).map(businessValue).includes(businessValue(actualText));
    if (missing) return false;
    if (expected.op === "eq") return businessValue(actualText) === businessValue(target);
    if (expected.op === "in") return toList(target).map(businessValue).includes(businessValue(actualText));
    const left = Number(actual);
    const right = Number(conditionValue(target));
    if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
    if (expected.op === "gt") return left > right;
    if (expected.op === "gte") return left >= right;
    if (expected.op === "lt") return left < right;
    return left <= right;
  }
  if (Array.isArray(expected)) {
    return missing ? false : expected.map(businessValue).includes(businessValue(actualText));
  }
  return missing ? false : businessValue(actualText) === businessValue(expected);
}

/** 对 visibleWhen / enabledWhen 整体求值；always/permission 键跳过（permission 由后端口径控制）。 */
export function evaluateWhen(when: Record<string, unknown> | undefined, row: Record<string, unknown>): boolean {
  if (!when) return true;
  if (when.always === false) return false;
  for (const [key, expected] of Object.entries(when)) {
    if (key === "always" || key === "permission" || expected === undefined) continue;
    if (!evaluateCondition(expected, row[key])) return false;
  }
  return true;
}
