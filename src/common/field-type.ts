/**
 * 教务领域字段类型推断的单一来源。
 * 之前 diff-executor / domain-tools 各有一份 normalize 实现、edu-domain.validator
 * 又有一份 HINTS 常量，三处关键词与判定顺序不一致（如 payment_time 一处推断为
 * datetime、另一处为 number）。统一后生成与校验共用同一口径。
 */

export const PHONE_HINTS = ["phone", "mobile", "tel", "手机号", "电话", "联系电话"];
export const MONEY_HINTS = ["amount", "fee", "price", "balance", "tuition", "payment", "refund", "arrears", "金额", "费用", "学费", "余额", "欠费", "收款", "退款"];
export const DATE_HINTS = ["date", "birthday", "birth_date", "日期", "生日"];
export const TIME_HINTS = ["time", "上课时间", "时间"];
export const COUNT_HINTS = ["count", "hours", "课时", "次数", "数量"];

export function hasFieldHint(text: string, hints: string[]): boolean {
  return hints.some((hint) => text.includes(hint));
}

/**
 * 根据字段 key/label 与原始类型推断 DSL 字段类型。
 * 判定顺序（时间类优先于金额类，避免 payment_time 之类被误判为 number）：
 * 手机号 → 生日 → 日期时间 → 日期 → 金额/数量 → 原始类型归一。
 */
export function inferDslFieldType(key: string, label: string, rawType: string): string {
  const text = `${key} ${label}`.toLowerCase();
  const normalized = rawType.toLowerCase();
  if (/(phone|mobile|tel|手机号|电话|联系电话)/.test(text)) return "text";
  if (/(birthday|birth_date|生日)/.test(text)) return "date";
  if (/(datetime|timestamp|time|时间)/.test(text)) return "datetime";
  if (/(date|日期)/.test(text)) return "date";
  if (/(amount|fee|price|balance|tuition|payment|refund|arrears|金额|费用|学费|余额|欠费|收款|退款|count|hours|课时|次数|数量)/.test(text)) return "number";
  if (/^(varchar|char|string|bigint|int|integer|uuid)$/.test(normalized) || normalized.startsWith("varchar")) return "text";
  if (normalized === "textarea" || normalized === "select" || normalized === "boolean") return normalized;
  return rawType || "text";
}
