/**
 * DSL 资源类型 → 存储表 / 编码列 / 内容列 的单一注册表。
 * version / tenant 发布、初始化、回滚等路径统一遍历此表，避免 DSL_TABLE_MAP /
 * DSL_SOURCES / initializeTenantVersion.dslTables 三份拷贝漂移。
 */

export type DslResourceEntry = {
  /** 版本/快照使用的 targetType（page / api / action ...） */
  targetType: string;
  /** 物理表，含 schema 前缀 */
  table: string;
  /** 业务编码列 */
  codeCol: string;
  /** 主内容列（dsl_json 或 skill_md_content / rule_json） */
  contentCol: string;
};

export const DSL_RESOURCE_REGISTRY: readonly DslResourceEntry[] = [
  { targetType: "page", table: "admin.page_dsl", codeCol: "page_code", contentCol: "dsl_json" },
  { targetType: "api", table: "admin.api_dsl", codeCol: "api_code", contentCol: "dsl_json" },
  { targetType: "action", table: "admin.action_dsl", codeCol: "action_code", contentCol: "dsl_json" },
  { targetType: "skill", table: "admin.skill_registry", codeCol: "skill_code", contentCol: "skill_md_content" },
  { targetType: "import", table: "admin.import_dsl", codeCol: "import_code", contentCol: "dsl_json" },
  { targetType: "report", table: "admin.report_dsl", codeCol: "report_code", contentCol: "dsl_json" },
  { targetType: "print_template", table: "admin.print_template", codeCol: "template_code", contentCol: "dsl_json" },
  { targetType: "business_rule", table: "admin.business_rule", codeCol: "rule_code", contentCol: "rule_json" },
] as const;

/** targetType → 物理表（兼容旧 DSL_TABLE_MAP 调用方）。 */
export const DSL_TABLE_MAP: Record<string, string> = Object.fromEntries(
  DSL_RESOURCE_REGISTRY.map((entry) => [entry.targetType, entry.table])
);

/** 仅含「页面/接口/动作/技能/导入/报表/打印模板」的映射（不含 business_rule 时部分路径曾用此子集）。 */
export const DSL_TABLE_MAP_CORE: Record<string, string> = Object.fromEntries(
  DSL_RESOURCE_REGISTRY
    .filter((entry) => entry.targetType !== "business_rule")
    .map((entry) => [entry.targetType, entry.table])
);

export function getDslResourceByType(targetType: string): DslResourceEntry | undefined {
  return DSL_RESOURCE_REGISTRY.find((entry) => entry.targetType === targetType);
}
