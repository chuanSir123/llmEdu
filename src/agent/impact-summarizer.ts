import type { DslDiff } from "./types.js";

export type HarnessImpactSummary = {
  totalDiffs: number;
  affectedTargets: string[];
  businessActions: string[];
  dataChanges: string[];
  uiChanges: string[];
  reviewNotes: string[];
};

export function summarizeHarnessImpact(diffs: DslDiff[]): HarnessImpactSummary {
  const summary: HarnessImpactSummary = {
    totalDiffs: diffs.length,
    affectedTargets: unique(diffs.map((diff) => `${diff.targetType}:${diff.targetCode}`)),
    businessActions: [],
    dataChanges: [],
    uiChanges: [],
    reviewNotes: [],
  };

  for (const diff of diffs) {
    summarizeBusinessAction(summary, diff);
    summarizeDataChange(summary, diff);
    summarizeUiChange(summary, diff);
    summarizeReviewNote(summary, diff);
  }

  summary.businessActions = unique(summary.businessActions);
  summary.dataChanges = unique(summary.dataChanges);
  summary.uiChanges = unique(summary.uiChanges);
  summary.reviewNotes = unique(summary.reviewNotes);
  return summary;
}

export function formatHarnessImpactMessage(summary: HarnessImpactSummary): string {
  const parts = [
    summary.businessActions.length > 0 ? `业务动作：${summary.businessActions.join("、")}` : "",
    summary.uiChanges.length > 0 ? `界面变化：${summary.uiChanges.join("、")}` : "",
    summary.dataChanges.length > 0 ? `数据变化：${summary.dataChanges.join("、")}` : "",
    summary.reviewNotes.length > 0 ? `审核关注：${summary.reviewNotes.join("、")}` : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join("；") : `本轮包含 ${summary.totalDiffs} 项配置变更。`;
}

function summarizeBusinessAction(summary: HarnessImpactSummary, diff: DslDiff) {
  const action = actionDef(diff);
  if (!action) return;
  const actionCode = String(action.actionCode ?? "");
  const label = String(action.label ?? action.actionName ?? actionCode);
  const apiCode = String(action.apiCode ?? "");
  if (apiCode === "course_list.create") {
    summary.businessActions.push("新增排课/约课入口，走排课冲突校验");
  } else if (apiCode === "charge_record.create") {
    summary.businessActions.push("新增课消扣费入口，走余额校验和扣减");
  } else if (apiCode === "funds_history.create") {
    summary.businessActions.push("新增合同收款入口，走收款分配和付款状态更新");
  } else if (apiCode === "refund_record.create") {
    summary.businessActions.push("新增退费入口，走余额校验和付款状态回滚");
  } else if (apiCode === "student_followup_list.create") {
    summary.businessActions.push("新增学员跟进入口");
  } else if (actionCode || label) {
    summary.businessActions.push(`新增操作 ${label}`);
  }
}

function summarizeDataChange(summary: HarnessImpactSummary, diff: DslDiff) {
  if (diff.targetType === "db_schema" && diff.op === "create_table") {
    summary.dataChanges.push(`新增数据表 ${String(diff.resourceDef?.tableName ?? diff.targetCode)}`);
  }
  if (diff.targetType === "db_schema" && diff.op === "add_field") {
    const fields = Array.isArray(diff.resourceDef?.fields)
      ? diff.resourceDef.fields.map((field) => isRecord(field) ? String(field.key ?? field.field ?? "") : "").filter(Boolean)
      : [];
    summary.dataChanges.push(`新增物理字段 ${fields.join(",") || diff.targetCode}`);
  }
  if (diff.targetType === "import_dsl") {
    summary.dataChanges.push(`新增导入模板 ${diff.targetCode}`);
  }
  if (diff.targetType === "report_dsl") {
    summary.dataChanges.push(`新增报表 ${String(diff.resourceDef?.title ?? diff.targetCode)}`);
  }
  if (diff.targetType === "permission_policy") {
    summary.dataChanges.push(`调整权限 ${diff.targetCode}`);
  }
}

function summarizeUiChange(summary: HarnessImpactSummary, diff: DslDiff) {
  if (diff.targetType !== "page_dsl") return;
  if (diff.op === "add_column") summary.uiChanges.push(`${diff.targetCode} 新增列表列 ${fieldName(diff)}`);
  if (diff.op === "add_filter") summary.uiChanges.push(`${diff.targetCode} 新增筛选 ${fieldName(diff)}`);
  if (diff.op === "add_modal_field") summary.uiChanges.push(`${diff.targetCode} 新增表单字段 ${fieldName(diff)}`);
  if (diff.op === "add_toolbar") summary.uiChanges.push(`${diff.targetCode} 新增工具栏按钮 ${actionLabel(diff)}`);
  if (diff.op === "add_row_action") summary.uiChanges.push(`${diff.targetCode} 新增行操作 ${actionLabel(diff)}`);
  if (diff.op === "modify") summary.uiChanges.push(`${diff.targetCode} 替换页面配置`);
}

function summarizeReviewNote(summary: HarnessImpactSummary, diff: DslDiff) {
  if (diff.targetType === "db_schema") summary.reviewNotes.push("涉及租户数据库结构，请确认字段口径");
  if (diff.targetType === "permission_policy") summary.reviewNotes.push("涉及角色权限，请确认数据范围和按钮权限");
  if (diff.targetType === "import_dsl") summary.reviewNotes.push("涉及批量导入，请确认重复数据策略");
  const action = actionDef(diff);
  const apiCode = String(action?.apiCode ?? "");
  if (["funds_history.create", "refund_record.create", "charge_record.create"].includes(apiCode)) {
    summary.reviewNotes.push("涉及资金或课时余额，请预览后由管理员确认");
  }
}

function actionDef(diff: DslDiff): Record<string, unknown> | undefined {
  if ((diff.op === "add_toolbar" || diff.op === "add_row_action") && diff.fieldDef) return diff.fieldDef;
  return undefined;
}

function fieldName(diff: DslDiff) {
  return String(diff.fieldDef?.label ?? diff.fieldDef?.key ?? diff.fieldDef?.field ?? diff.field ?? "");
}

function actionLabel(diff: DslDiff) {
  return String(diff.fieldDef?.label ?? diff.fieldDef?.actionName ?? diff.fieldDef?.actionCode ?? "");
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
