// 声明式校验规则（category=validation）的共享定义：类型、白名单、纯函数求值与结构校验。
//
// 定位：AI 定制/租户配置"新增规则"的统一落点——规则是数据（admin.business_rule），
// 解释器是平台代码（gateway/declarative-rule.service.ts），不给任何租户新增逻辑代码。
// 安全模型：声明式规则在业务命令执行前追加校验，**只能收紧、不能放宽**；
// 引擎内置防护（余额校验/状态机/时间冲突）始终在命令内部执行，规则无法绕过。
//
// 本文件只放纯函数与常量：agent 校验器（edu-domain.validator）、规则保存接口
// （api-executor saveBusinessRule）、harness 回归都从这里引用，避免 gateway ↔ agent 循环依赖。

export type FieldCheck = {
  field: string;
  operator: string;
  value?: unknown;
  valueField?: string;
  message?: string;
  /** 前置条件：全部满足才执行本条校验（如仅 charge_type=NORMAL 时限制金额） */
  when?: FieldCheck[];
  /** 对数组入参逐项校验（如 attendance.checkIn 的 students） */
  each?: string;
};

export type CountLimitCheck = {
  type: "count_limit";
  table: string;
  where: Array<{ field: string; valueFrom?: string; value?: unknown }>;
  operator: string;
  value: number;
  message?: string;
  when?: FieldCheck[];
};

export type DeclarativeValidation = FieldCheck | CountLimitCheck;

/** 命令 → 可接受的 businessType（含历史别名，如 course_create 与 course） */
export const COMMAND_BUSINESS_TYPES: Record<string, string[]> = {
  "contract.create": ["contract_create", "contract"],
  "contract.update": ["contract_update"],
  "funds.create": ["funds_create", "funds"],
  "funds.delete": ["funds_delete"],
  "refund.create": ["refund_create", "refund"],
  "refund.delete": ["refund_delete"],
  "contract.refund": ["contract_refund"],
  "chargeRecord.create": ["charge_create", "charge"],
  "chargeRecord.reverse": ["charge_reverse"],
  "attendance.checkIn": ["attendance_check_in", "attendance"],
  "attendance.cancel": ["attendance_cancel"],
  "course.create": ["course_create", "course"],
  "course.update": ["course_update"],
  "course.delete": ["course_delete"],
  "course.cancel": ["course_cancel"],
  "leave.create": ["leave_create", "leave"],
  "makeup.create": ["makeup_create", "makeup"],
  "classStudent.transfer": ["class_student_transfer"],
  "miniClass.addStudent": ["mini_class_add_student"],
  "miniClass.removeStudent": ["mini_class_remove_student"],
  "oneOnNGroup.addStudent": ["one_on_n_group_add_student"],
  "oneOnNGroup.removeStudent": ["one_on_n_group_remove_student"],
};

export const ALL_VALIDATION_BUSINESS_TYPES = new Set(Object.values(COMMAND_BUSINESS_TYPES).flat());

/** 解释器真实执行的操作符 */
export const SUPPORTED_OPERATORS = new Set([
  "=", "==", "eq", "!=", "neq", ">", ">=", "<", "<=",
  "in", "not_in", "exists", "required", "regex", "min_length", "max_length",
]);

/** 引擎原生实现的操作符：结构校验放行，解释器跳过（由 preventTeacherTimeConflict 等旗标兜底） */
export const NATIVE_OPERATORS = new Set(["no_time_overlap", "unique"]);

/** context.<entity>.<column> 可引用的实体：按入参约定 ID 字段自动加载 */
export const CONTEXT_ENTITIES: Record<string, { table: string; idFields: string[] }> = {
  student: { table: "student", idFields: ["student_id"] },
  contract: { table: "contract", idFields: ["contract_id"] },
  contract_product: { table: "contract_product", idFields: ["contract_product_id"] },
  course: { table: "generic_course", idFields: ["course_id"] },
  product: { table: "product", idFields: ["product_id"] },
  organization: { table: "organization", idFields: ["organization_id"] },
};

/** count_limit 允许的目标表（租户业务事实表） */
export const COUNT_LIMIT_TABLES = new Set([
  "student", "contract", "contract_product", "funds_change_history", "refund_record",
  "account_charge_records", "generic_course", "generic_course_student",
  "course_leave_record", "makeup_course_record", "mini_class_student",
  "one_on_n_group_student", "student_followup", "trial_lesson",
]);

const FIELD_NAME_RE = /^[a-z][a-z0-9_]{0,62}$/;
const FIELD_PATH_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){0,3}$/;
const MAX_VALIDATIONS_PER_RULE = 20;
const MAX_REGEX_LENGTH = 200;

function str(value: unknown, fallback = "") {
  return value === undefined || value === null || value === "" ? fallback : String(value);
}

/** 字典值双格式兼容：course_status.CANCELLED 与 CANCELLED 等价比较 */
function dictBare(text: string): string {
  const match = /^[a-z][a-z0-9_]*\.(.+)$/.exec(text);
  return match ? match[1] : text;
}

/** 操作符读取：字典归一化可能把 "<=" 存成 "rule_operator.<="，读取时剥离前缀 */
function opOf(value: unknown, fallback = "="): string {
  return dictBare(str(value, fallback));
}

function isEmpty(value: unknown) {
  return value === undefined || value === null || value === "";
}

/** 从 {data, context} 源解析路径；裸字段名视为 data.<field> */
export function resolveRulePath(source: Record<string, unknown>, path: string): unknown {
  const normalized = path.startsWith("data.") || path.startsWith("context.") ? path : `data.${path}`;
  return normalized.split(".").reduce<unknown>((current, part) => {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    return (current as Record<string, unknown>)[part];
  }, source);
}

export function compareRuleValues(left: unknown, operator: string, right: unknown): boolean {
  const normalized = dictBare(operator);
  const op = normalized === "==" || normalized === "eq" ? "=" : normalized === "neq" ? "!=" : normalized;
  if (op === "exists" || op === "required") return !isEmpty(left);
  if (op === "in") return Array.isArray(right) && right.map((item) => dictBare(str(item))).includes(dictBare(str(left)));
  if (op === "not_in") return Array.isArray(right) && !right.map((item) => dictBare(str(item))).includes(dictBare(str(left)));
  if (op === "regex") {
    const pattern = str(right);
    if (!pattern || pattern.length > MAX_REGEX_LENGTH) return true;
    try { return new RegExp(pattern).test(str(left)); } catch { return true; }
  }
  if (op === "min_length") return str(left).length >= Number(right ?? 0);
  if (op === "max_length") return str(left).length <= Number(right ?? Infinity);
  const leftNum = Number(left);
  const rightNum = Number(right);
  const numeric = !isEmpty(left) && !isEmpty(right) && Number.isFinite(leftNum) && Number.isFinite(rightNum)
    && str(left).trim() !== "" && str(right).trim() !== "";
  if (op === "=") return numeric ? leftNum === rightNum : dictBare(str(left)) === dictBare(str(right));
  if (op === "!=") return numeric ? leftNum !== rightNum : dictBare(str(left)) !== dictBare(str(right));
  // 大小比较：双数字走数值，否则字符串字典序（对 "09:00" < "10:00" 这类时间正确）
  const l: number | string = numeric ? leftNum : str(left);
  const r: number | string = numeric ? rightNum : str(right);
  if (op === ">") return l > r;
  if (op === ">=") return l >= r;
  if (op === "<") return l < r;
  if (op === "<=") return l <= r;
  return true; // 未知操作符：跳过（前向兼容；新规则由结构校验拦截）
}

export type FieldCheckResult = { passed: boolean; message?: string };

/**
 * 纯函数求值单条字段校验。
 * 语义：required/exists 之外的比较，左值为空时视为"规则不适用"直接通过——
 * 避免部分更新/可选字段被误拦；必填语义请显式用 operator=required。
 */
export function evaluateFieldCheck(check: FieldCheck, source: Record<string, unknown>): FieldCheckResult {
  const operator = opOf(check.operator);
  if (NATIVE_OPERATORS.has(operator)) return { passed: true };
  if (!SUPPORTED_OPERATORS.has(operator) && operator !== "==") return { passed: true };
  for (const pre of Array.isArray(check.when) ? check.when : []) {
    const preLeft = resolveRulePath(source, str(pre.field));
    const preRight = pre.valueField ? resolveRulePath(source, str(pre.valueField)) : pre.value;
    if (!compareRuleValues(preLeft, opOf(pre.operator), preRight)) return { passed: true };
  }
  const evalOne = (root: Record<string, unknown>): boolean => {
    const left = resolveRulePath(root, str(check.field));
    const op = opOf(check.operator);
    if (op !== "exists" && op !== "required" && isEmpty(left)) return true;
    const right = check.valueField ? resolveRulePath(root, str(check.valueField)) : check.value;
    return compareRuleValues(left, op, right);
  };
  if (check.each) {
    const list = resolveRulePath(source, str(check.each));
    const items = Array.isArray(list) ? list : [];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const itemSource = { data: item as Record<string, unknown>, context: (source.context as Record<string, unknown>) ?? {} };
      if (!evalOne(itemSource)) return { passed: false, message: check.message };
    }
    return { passed: true };
  }
  return evalOne(source) ? { passed: true } : { passed: false, message: check.message };
}

function validateFieldPath(errors: string[], label: string, path: unknown) {
  const text = str(path);
  if (!text) { errors.push(`${label} 缺少字段路径`); return; }
  if (!FIELD_PATH_RE.test(text)) { errors.push(`${label} 字段路径不合法: ${text}`); return; }
  if (text.startsWith("context.")) {
    const entity = text.split(".")[1] ?? "";
    if (!CONTEXT_ENTITIES[entity]) errors.push(`${label} 引用了不支持的上下文实体: ${entity}（可选: ${Object.keys(CONTEXT_ENTITIES).join("/")}）`);
  }
}

function validateSingleCheck(errors: string[], index: number, raw: unknown) {
  const check = raw as Record<string, unknown>;
  if (!check || typeof check !== "object") { errors.push(`validations[${index}] 必须是对象`); return; }
  if (str(check.type) === "count_limit") {
    const table = str(check.table);
    if (!COUNT_LIMIT_TABLES.has(table)) errors.push(`validations[${index}] count_limit 的 table 不在白名单: ${table}`);
    const where = Array.isArray(check.where) ? check.where : [];
    if (!where.length) errors.push(`validations[${index}] count_limit 必须至少包含一个 where 条件（禁止全表计数）`);
    for (const [wi, rawWhere] of where.entries()) {
      const cond = rawWhere as Record<string, unknown>;
      if (!FIELD_NAME_RE.test(str(cond?.field))) errors.push(`validations[${index}].where[${wi}] 字段名不合法: ${str(cond?.field)}`);
      if (cond?.valueFrom !== undefined) validateFieldPath(errors, `validations[${index}].where[${wi}].valueFrom`, cond.valueFrom);
    }
    if (![">", ">=", "<", "<=", "=", "==", "eq", "!=", "neq"].includes(opOf(check.operator))) {
      errors.push(`validations[${index}] count_limit 的 operator 不合法: ${opOf(check.operator)}`);
    }
    if (!Number.isFinite(Number(check.value))) errors.push(`validations[${index}] count_limit 的 value 必须是数字`);
    return;
  }
  validateFieldPath(errors, `validations[${index}].field`, check.field);
  const operator = opOf(check.operator);
  if (!SUPPORTED_OPERATORS.has(operator) && !NATIVE_OPERATORS.has(operator)) {
    errors.push(`validations[${index}] operator 不支持: ${operator}（可选: ${[...SUPPORTED_OPERATORS].join("/")}）`);
  }
  if (operator === "regex" && str(check.value).length > MAX_REGEX_LENGTH) {
    errors.push(`validations[${index}] regex 模式过长（>${MAX_REGEX_LENGTH}）`);
  }
  if (!["exists", "required"].includes(operator) && !NATIVE_OPERATORS.has(operator)
    && check.value === undefined && check.valueField === undefined) {
    errors.push(`validations[${index}] 比较类 operator 必须提供 value 或 valueField`);
  }
  if (check.valueField !== undefined) validateFieldPath(errors, `validations[${index}].valueField`, check.valueField);
  if (check.each !== undefined && !FIELD_NAME_RE.test(str(check.each))) {
    errors.push(`validations[${index}] each 必须是入参中的数组字段名: ${str(check.each)}`);
  }
  for (const [pi, pre] of (Array.isArray(check.when) ? check.when : []).entries()) {
    const cond = pre as Record<string, unknown>;
    validateFieldPath(errors, `validations[${index}].when[${pi}].field`, cond?.field);
  }
}

/**
 * 声明式规则结构校验（确定性）。仅对含 validation 分类的规则生效；
 * AI 定制（create_business_rule diff）与规则保存接口共用，保证坏结构进不了库。
 */
export function validateDeclarativeRuleJson(ruleJson: Record<string, unknown> | null | undefined): string[] {
  const errors: string[] = [];
  if (!ruleJson || typeof ruleJson !== "object") return errors;
  // category 可能被字典归一成 business_rule_category.validation 形态，比较前剥离前缀
  const categories = [
    ...(Array.isArray(ruleJson.categories) ? ruleJson.categories.map((item) => dictBare(str(item))) : []),
    dictBare(str(ruleJson.category)),
  ].filter(Boolean);
  if (!categories.includes("validation")) return errors;
  const validations = ruleJson.validations;
  if (validations === undefined) return errors; // 仅旗标类 validation 规则（preventXxx 等）无需 validations
  if (!Array.isArray(validations)) { errors.push("validations 必须是数组"); return errors; }
  if (validations.length > MAX_VALIDATIONS_PER_RULE) errors.push(`validations 最多 ${MAX_VALIDATIONS_PER_RULE} 条`);
  const businessType = dictBare(str(ruleJson.businessType ?? ruleJson.business_type));
  if (!businessType) errors.push("validation 规则必须包含 businessType（决定拦截哪个业务命令）");
  else if (!ALL_VALIDATION_BUSINESS_TYPES.has(businessType)) {
    errors.push(`businessType 不受声明式校验支持: ${businessType}（可选: ${[...ALL_VALIDATION_BUSINESS_TYPES].join("/")}）`);
  }
  for (const [index, check] of validations.slice(0, MAX_VALIDATIONS_PER_RULE).entries()) {
    validateSingleCheck(errors, index, check);
  }
  return errors;
}
