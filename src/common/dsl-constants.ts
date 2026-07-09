/**
 * DSL / 校验层共享常量的单一来源。
 * 之前这些集合散落在 diff-executor、domain-tools、edu-domain.validator、
 * tenant-assistant、permission.service 等多个文件里各写一份，改一处漏一处。
 */

/** 系统托管字段：所有租户业务表都有，禁止 AI 定制直接写入。 */
export const SYSTEM_FIELD_KEYS = ["id", "created_at", "updated_at", "deleted", "deleted_at"] as const;

export const SYSTEM_FIELD_SET = new Set<string>(SYSTEM_FIELD_KEYS);

/** 写接口额外保留字段（ext_json 由平台合并逻辑维护）。 */
export const SYSTEM_WRITE_FIELD_SET = new Set<string>([...SYSTEM_FIELD_KEYS, "ext_json"]);

/**
 * 数据权限档位（由低到高）。priority 越大范围越广。
 * 权限计算、AI 校验、prompt 生成都应引用这里，避免各写一份枚举。
 */
export const DATA_PERMISSION_LEVELS = [
  { code: "self_only", priority: 1 },
  { code: "own_courses", priority: 2 },
  { code: "own_students", priority: 3 },
  { code: "organization_or_sub", priority: 4 },
  { code: "own_organization", priority: 5 },
  { code: "all", priority: 6 },
] as const;

export type DataPermissionCode = (typeof DATA_PERMISSION_LEVELS)[number]["code"];

export const DATA_PERMISSION_PRIORITY: Record<string, number> = Object.fromEntries(
  DATA_PERMISSION_LEVELS.map((item) => [item.code, item.priority])
);

/** AI 定制允许下发的数据权限档位（all 需要平台侧授权，不在安全集合内）。 */
export const SAFE_DATA_PERMISSION_SET = new Set<string>(
  DATA_PERMISSION_LEVELS.filter((item) => item.code !== "all").map((item) => item.code)
);

/** 供 prompt 拼接的枚举文案，保证与校验集合一致。 */
export const DATA_PERMISSION_ENUM_TEXT = DATA_PERMISSION_LEVELS.map((item) => item.code).join("/");

/**
 * 平台内置核心业务规则编码（seed 时会同时在 rule_json 上打 coreRule/locked 标记）。
 * 判断"是否核心规则"应优先读 rule_json 元数据（isCoreBusinessRule），
 * 本清单仅作为 seed 与无元数据旧数据的兜底，避免各文件重复维护。
 */
export const CORE_BUSINESS_RULE_CODES = new Set([
  "funds_create_rule",
  "charge_create_rule",
  "refund_create_rule",
  "contract_refund_rule",
  "course_create_rule",
  "course_time_validation_rule",
]);

/** 核心规则判定：元数据优先（coreRule/locked），内置清单兜底。 */
export function isCoreBusinessRule(ruleCode: string, ruleJson?: Record<string, unknown> | null): boolean {
  if (ruleJson && (ruleJson.coreRule === true || ruleJson.locked === true)) return true;
  return CORE_BUSINESS_RULE_CODES.has(ruleCode);
}
