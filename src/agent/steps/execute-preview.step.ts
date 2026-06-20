import type { DslDiff, HarnessStepResult } from "../types.js";
import { createDraftBundleVersion } from "../../version/version.service.js";
import { pool } from "../../db/pool.js";
import { validateApiDslAgainstSchema } from "../../db/dsl-validator.js";

export async function executePreview(
  validDiffs: DslDiff[],
  schemaName: string,
  userId: string,
  diffExecutor: { executeDiffs: (diffs: DslDiff[], schemaName: string) => Promise<Array<{ diff: DslDiff; modifiedDslJson: unknown }>> },
): Promise<HarnessStepResult<Array<{ versionId: string; versionNo: number }>>> {
  const start = Date.now();
  const inputSummary = `diffs_count=${validDiffs.length}`;

  try {
    const executed = await diffExecutor.executeDiffs(validDiffs, schemaName);
    const results: Array<{ versionId: string; versionNo: number }> = [];
    const pendingColumns = collectPendingColumns(validDiffs);
    const typeMap: Record<string, string> = {
      page_dsl: "page",
      api_dsl: "api",
      action_dsl: "action",
      skill_registry: "skill",
      db_schema: "db_schema",
      import_dsl: "import",
      report_dsl: "report",
      permission_policy: "permission_policy",
      approval_flow: "approval_flow",
      print_template: "print_template",
      business_rule: "business_rule",
      feature_registry: "feature",
    };
    const latestByTarget = new Map<string, { diff: DslDiff; modifiedDslJson: unknown }>();
    for (const item of executed) {
      const targetType = typeMap[item.diff.targetType] ?? item.diff.targetType;
      latestByTarget.set(`${targetType}:${item.diff.targetCode}`, item);
    }

    const items = [];
    for (const { diff, modifiedDslJson } of latestByTarget.values()) {
      const targetType = typeMap[diff.targetType] ?? diff.targetType;
      if (targetType === "api") {
        const problems = await validateApiDslAgainstSchema(schemaName, diff.targetCode, modifiedDslJson as Record<string, unknown>, pendingColumns);
        if (problems.length > 0) {
          throw new Error(`API DSL 字段校验失败: ${problems.map((p) => `${p.apiCode}.${p.field ?? ""} ${p.problem}`).join("; ")}`);
        }
      }
      const snapshot: Record<string, unknown> = targetType === "skill"
        ? { skill_md_content: modifiedDslJson }
        : ["db_schema", "import", "report", "permission_policy", "approval_flow", "print_template", "business_rule", "feature"].includes(targetType)
          ? { resource_json: modifiedDslJson }
          : { dsl_json: modifiedDslJson };
      const previousSnapshot = await loadCurrentSnapshot(targetType, diff.targetCode, schemaName);
      items.push({
        targetType,
        targetCode: diff.targetCode,
        snapshot,
        previousSnapshot,
        diff: { targetType: diff.targetType, targetCode: diff.targetCode, op: diff.op, field: diff.field, fieldDef: diff.fieldDef, resourceDef: diff.resourceDef },
      });
    }

    const version = await createDraftBundleVersion({
      schemaScope: "tenant",
      schemaName,
      changeSummary: `${items.length} 项配置 via AI 定制`,
      items,
    });
    results.push({ versionId: version.id, versionNo: version.versionNo });

    return {
      stepName: "execute_preview",
      input_summary: inputSummary,
      output_summary: `created ${results.length} draft versions`,
      duration_ms: Date.now() - start,
      data: results,
    };
  } catch (err) {
    return {
      stepName: "execute_preview",
      input_summary: inputSummary,
      output_summary: "failed",
      duration_ms: Date.now() - start,
      data: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function collectPendingColumns(diffs: DslDiff[]) {
  const result: Record<string, string[]> = {};
  for (const diff of diffs) {
    if (diff.targetType !== "db_schema" || !diff.resourceDef) continue;
    const tableName = String(diff.resourceDef.tableName ?? diff.targetCode ?? "");
    const fields = Array.isArray(diff.resourceDef.fields) ? diff.resourceDef.fields as Array<Record<string, unknown>> : [];
    if (!tableName) continue;
    result[tableName] ??= [];
    for (const field of fields) {
      const key = String(field.key ?? "");
      if (key && !result[tableName].includes(key)) result[tableName].push(key);
    }
  }
  return result;
}

async function loadCurrentSnapshot(targetType: string, targetCode: string, schemaName: string): Promise<Record<string, unknown> | null> {
  const tableMap: Record<string, { table: string; codeCol: string; contentCol: string }> = {
    page: { table: "admin.page_dsl", codeCol: "page_code", contentCol: "dsl_json" },
    api: { table: "admin.api_dsl", codeCol: "api_code", contentCol: "dsl_json" },
    action: { table: "admin.action_dsl", codeCol: "action_code", contentCol: "dsl_json" },
    skill: { table: "admin.skill_registry", codeCol: "skill_code", contentCol: "skill_md_content" },
    import: { table: "admin.import_dsl", codeCol: "import_code", contentCol: "dsl_json" },
    report: { table: "admin.report_dsl", codeCol: "report_code", contentCol: "dsl_json" },
    print_template: { table: "admin.print_template", codeCol: "template_code", contentCol: "dsl_json" },
    business_rule: { table: "admin.business_rule", codeCol: "rule_code", contentCol: "rule_json" },
  };
  if (["db_schema", "feature", "permission_policy", "approval_flow"].includes(targetType)) return null;
  const mapping = tableMap[targetType];
  if (!mapping) return null;
  const { rows } = await pool.query(
    `select ${mapping.contentCol} as content from ${mapping.table}
     where ${mapping.codeCol} = $1
       and ((schema_scope = 'tenant' and schema_name = $2) or schema_scope = 'tenant_default')
       and status = 'active' and deleted = false
     order by case when schema_scope = 'tenant' then 0 else 1 end limit 1`,
    [targetCode, schemaName]
  );
  if (!rows[0]) return null;
  if (targetType === "skill") return { skill_md_content: rows[0].content };
  if (targetType === "import" || targetType === "report" || targetType === "print_template" || targetType === "business_rule") return { resource_json: rows[0].content };
  return { dsl_json: rows[0].content };
}
