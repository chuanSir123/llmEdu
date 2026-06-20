import type { DslDiff, TenantAgentPolicy } from "./types.js";

export type HarnessRiskLevel = "low" | "medium" | "high";

export type HarnessRiskAssessment = {
  level: HarnessRiskLevel;
  highRiskDiffs: Array<{ targetCode: string; reason: string }>;
  requiresConfirmation: boolean;
  requiresManualReview: boolean;
  errors: string[];
};

export function evaluateHarnessRisk(diffs: DslDiff[], policy: TenantAgentPolicy): HarnessRiskAssessment {
  const highRiskDiffs = diffs.flatMap((diff) => {
    const reason = highRiskReason(diff);
    return reason ? [{ targetCode: diff.targetCode, reason }] : [];
  });
  const hasHighRisk = highRiskDiffs.length > 0;
  const hasMediumRisk = diffs.some((diff) => ["import_dsl", "report_dsl"].includes(diff.targetType));
  const requiresManualReview = false;
  const requiresConfirmation = false;
  const errors: string[] = [];

  return {
    level: hasHighRisk ? "high" : hasMediumRisk ? "medium" : "low",
    highRiskDiffs,
    requiresConfirmation,
    requiresManualReview,
    errors,
  };
}

function highRiskReason(diff: DslDiff): string | undefined {
  if (diff.targetType === "permission_policy") return "权限策略变更";
  if (diff.targetType === "db_schema" && diff.op === "create_table") return "新增租户数据表";
  if (diff.targetType === "db_schema" && diff.op === "add_field") return "新增物理字段";
  if (diff.op.startsWith("remove_")) return "删除或隐藏配置";
  if (diff.op === "modify") return "完整替换配置";
  if (diff.targetType === "feature_registry" || diff.op === "create_feature") return "新增功能入口";
  return undefined;
}
