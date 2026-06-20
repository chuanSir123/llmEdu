import type { DslDiff, TenantAgentPolicy } from "../types.js";

export function validateTenantPolicy(diffs: DslDiff[], policy: TenantAgentPolicy): string[] {
  const errors: string[] = [];

  if (!policy.dataPolicy.allowImport && diffs.some((diff) => diff.targetType === "import_dsl")) {
    errors.push("租户策略不允许导入能力定制");
  }
  if (policy.moduleScope.length > 0) {
    const blockedModules = diffs
      .map(resolveModuleCode)
      .filter((moduleCode): moduleCode is string => Boolean(moduleCode) && !policy.moduleScope.includes(moduleCode));
    if (blockedModules.length > 0) {
      errors.push(`租户策略不允许定制模块: ${[...new Set(blockedModules)].join(", ")}`);
    }
  }

  const sensitive = policy.fieldPolicy.sensitiveFieldBlocklist.map((item) => item.toLowerCase());
  for (const diff of diffs) {
    const names = [
      diff.field,
      diff.fieldDef?.key,
      diff.fieldDef?.field,
      ...resourceFields(diff),
    ].filter(Boolean).map((item) => String(item).toLowerCase());
    for (const name of names) {
      if (sensitive.some((blocked) => name === blocked || name.includes(blocked))) {
        errors.push(`字段 ${name} 命中租户敏感字段黑名单`);
      }
    }
  }

  const physicalFieldAdds = diffs
    .filter((diff) => diff.targetType === "db_schema" && diff.op === "add_field")
    .flatMap(resourceFields);
  if (physicalFieldAdds.length > policy.fieldPolicy.maxPhysicalFieldsPerRequest) {
    errors.push(`单次新增物理字段数量 ${physicalFieldAdds.length} 超过上限 ${policy.fieldPolicy.maxPhysicalFieldsPerRequest}`);
  }

  return errors;
}

function resolveModuleCode(diff: DslDiff) {
  const resourceModule = diff.resourceDef?.moduleCode;
  if (typeof resourceModule === "string") return resourceModule;
  const modified = diff.modifiedDslJson;
  if (modified && typeof modified === "object" && !Array.isArray(modified)) {
    const moduleCode = (modified as Record<string, unknown>).moduleCode;
    if (typeof moduleCode === "string") return moduleCode;
  }
  return "";
}

function resourceFields(diff: DslDiff): string[] {
  const fields = Array.isArray(diff.resourceDef?.fields) ? diff.resourceDef.fields : [];
  return fields
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    .map((item) => String(item.key ?? item.field ?? ""))
    .filter(Boolean);
}
