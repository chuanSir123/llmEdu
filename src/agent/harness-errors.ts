// 教务 harness 错误码分类器
//
// 目的：用稳定的错误码替代散落在校验器里的中文文案串匹配（原 harness-runner.ts
// 的 shouldRefreshContext 直接硬匹配中文，校验文案一改就失效）。
//
// 这里是错误码与匹配模式的【单一真相源】。校验器仍然抛中文错误字符串，
// 本模块负责把它们归类到稳定码，供：
//   1) harness-runner 决定是否需要刷新上下文（needsContextRefresh）
//   2) 收敛度量：把每轮错误码写入 agent_harness_step_log.error_codes
//   3) Golden 评测集按错误码断言
// edu-rules.ts 引用这些错误码，把"规则 ↔ 错误码 ↔ few-shot"绑定在一起。

export enum HarnessErrorCode {
  REPORT_FIELD_MISSING = "REPORT_FIELD_MISSING",
  FILTER_NOT_PHYSICAL = "FILTER_NOT_PHYSICAL",
  FIELD_SCHEMA_MISMATCH = "FIELD_SCHEMA_MISMATCH",
  FIELD_ECHO_MISSING = "FIELD_ECHO_MISSING",
  DUPLICATE = "DUPLICATE",
  FK_OPTION_SOURCE_MISSING = "FK_OPTION_SOURCE_MISSING",
  BUSINESS_RULE_INVALID = "BUSINESS_RULE_INVALID",
  FIELD_TYPE_INVALID = "FIELD_TYPE_INVALID",
  IMPORT_INVALID = "IMPORT_INVALID",
  EXPORT_INVALID = "EXPORT_INVALID",
  PERMISSION_INVALID = "PERMISSION_INVALID",
  MISSING_FIELD_DEF = "MISSING_FIELD_DEF",
  MISSING_RESOURCE_DEF = "MISSING_RESOURCE_DEF",
  INVALID_NAME = "INVALID_NAME",
  NO_DIFFS = "NO_DIFFS",
  TENANT_POLICY = "TENANT_POLICY",
  OTHER = "OTHER",
}

type ErrorPattern = {
  code: HarnessErrorCode;
  // 命中其中任一子串即归为该码（按声明顺序匹配，先具体后通用）
  patterns: string[];
  // 该类错误是否意味着上下文（SKILL.md/表结构）选错，需要重新注入
  refreshContext: boolean;
};

// 顺序敏感：更具体的模式放前面
export const ERROR_PATTERNS: ErrorPattern[] = [
  { code: HarnessErrorCode.REPORT_FIELD_MISSING, patterns: ["报表字段不存在"], refreshContext: true },
  { code: HarnessErrorCode.FILTER_NOT_PHYSICAL, patterns: ["筛选字段必须是物理列"], refreshContext: true },
  {
    code: HarnessErrorCode.FIELD_SCHEMA_MISMATCH,
    patterns: [
      "字段校验失败",
      "missing filter",
      "missing allowedField",
      "missing select field",
      "missing metric field",
      "missing dimension field",
      "missing table",
    ],
    refreshContext: true,
  },
  { code: HarnessErrorCode.FIELD_ECHO_MISSING, patterns: ["回显缺失"], refreshContext: false },
  { code: HarnessErrorCode.FK_OPTION_SOURCE_MISSING, patterns: ["外键字段", "optionSource", "displayKey"], refreshContext: false },
  {
    code: HarnessErrorCode.BUSINESS_RULE_INVALID,
    patterns: ["business_rule", "排课规则", "业绩规则", "资金规则", "优惠规则", "category", "businessType"],
    refreshContext: false,
  },
  { code: HarnessErrorCode.FIELD_TYPE_INVALID, patterns: ["字段类型", "必须用 text", "必须用 number", "不能用 number", "手机号", "金额"], refreshContext: false },
  { code: HarnessErrorCode.IMPORT_INVALID, patterns: ["导入按钮", "import_dsl", "duplicateStrategy"], refreshContext: false },
  { code: HarnessErrorCode.EXPORT_INVALID, patterns: ["导出按钮"], refreshContext: false },
  { code: HarnessErrorCode.PERMISSION_INVALID, patterns: ["permission", "dataPermission", "roleCode", "角色权限"], refreshContext: false },
  {
    code: HarnessErrorCode.DUPLICATE,
    patterns: ["重复", "已存在", "已开放"],
    refreshContext: false,
  },
  { code: HarnessErrorCode.MISSING_RESOURCE_DEF, patterns: ["requires resourceDef", "missing pageCode", "missing sourceTable", "missing fields", "missing steps", "missing flowName", "missing templateName", "missing moduleCode"], refreshContext: false },
  { code: HarnessErrorCode.MISSING_FIELD_DEF, patterns: ["requires fieldDef", "fieldDef missing", "missing key", "missing field"], refreshContext: false },
  { code: HarnessErrorCode.INVALID_NAME, patterns: ["invalid field name", "invalid table name", "invalid db field", "invalid fieldDef", "invalid API DSL", "不合法"], refreshContext: false },
  { code: HarnessErrorCode.NO_DIFFS, patterns: ["没有可执行的 DSL 变更", "没有生成可预览"], refreshContext: false },
  { code: HarnessErrorCode.TENANT_POLICY, patterns: ["租户策略", "不允许", "超出"], refreshContext: false },
];

/** 把单条错误信息归类到稳定错误码（无匹配返回 OTHER）。 */
export function classifyHarnessError(message: string): HarnessErrorCode {
  if (!message) return HarnessErrorCode.OTHER;
  for (const entry of ERROR_PATTERNS) {
    if (entry.patterns.some((pattern) => message.includes(pattern))) return entry.code;
  }
  return HarnessErrorCode.OTHER;
}

/** 把一段聚合错误反馈（可能含多条，以 ; 分隔）拆分并归类，返回去重后的错误码列表。 */
export function classifyFeedback(feedback: string): HarnessErrorCode[] {
  if (!feedback) return [];
  const cleaned = feedback.replace(/^校验失败[:：]\s*/, "");
  const parts = cleaned.split(/;\s*|；\s*/).map((part) => part.trim()).filter(Boolean);
  const source = parts.length > 0 ? parts : [feedback];
  const codes = new Set<HarnessErrorCode>();
  for (const part of source) codes.add(classifyHarnessError(part));
  return [...codes];
}

/**
 * 是否需要刷新上下文（重新选择相关 skill、重读表结构）。
 * 取代原 harness-runner 的中文串硬匹配，行为等价：只要反馈里含任一"上下文选错"类模式即为 true。
 */
export function needsContextRefresh(feedback: string): boolean {
  if (!feedback) return false;
  for (const entry of ERROR_PATTERNS) {
    if (entry.refreshContext && entry.patterns.some((pattern) => feedback.includes(pattern))) return true;
  }
  return false;
}

/** 统计错误码出现次数，用于收敛度量与离线分析。 */
export function countErrorCodes(feedback: string): Array<{ code: HarnessErrorCode; count: number }> {
  const cleaned = feedback.replace(/^校验失败[:：]\s*/, "");
  const parts = cleaned.split(/;\s*|；\s*/).map((part) => part.trim()).filter(Boolean);
  const counts = new Map<HarnessErrorCode, number>();
  for (const part of parts) {
    const code = classifyHarnessError(part);
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return [...counts.entries()].map(([code, count]) => ({ code, count }));
}
