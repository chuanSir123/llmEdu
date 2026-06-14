import { pool } from "../db/pool.js";
import { visiblePageCodes } from "../permission/permission.service.js";
import type { SessionUser } from "../types.js";

export async function loadTenantMenu(schemaName: string, user?: SessionUser) {
  const permitted = new Set(await visiblePageCodes(user, schemaName));
  const { rows } = await pool.query(
    `select m.module_code, m.module_name, m.icon, m.sort_no as module_sort,
            f.feature_code, f.feature_name, f.page_code, f.sort_no as feature_sort
     from admin.tenant_feature_subscription tfs
     join admin.feature_registry f on f.feature_code = tfs.feature_code and f.deleted = false and f.status = 'ACTIVE'
     join admin.module_registry m on m.module_code = f.module_code and m.deleted = false and m.status = 'ACTIVE'
     where tfs.schema_name = $1 and tfs.enabled = true and tfs.deleted = false
     order by m.sort_no, f.sort_no, f.feature_name`,
    [schemaName]
  );
  const modules = new Map<string, { moduleCode: string; moduleName: string; icon: string; groups: Record<string, unknown[]> }>();
  for (const row of rows) {
    if (permitted.size && !permitted.has(row.page_code)) continue;
    if (!modules.has(row.module_code)) {
      modules.set(row.module_code, { moduleCode: row.module_code, moduleName: row.module_name, icon: row.icon, groups: {} });
    }
    const group = row.module_code === "finance" ? (row.page_code.includes("product") ? "产品优惠" : row.page_code.includes("contract") ? "合同收费" : "财务流水") : "管理";
    modules.get(row.module_code)!.groups[group] ??= [];
    modules.get(row.module_code)!.groups[group].push({
      featureCode: row.feature_code,
      featureName: row.feature_name,
      pageCode: row.page_code
    });
  }
  return [...modules.values()];
}

export async function loadAdminMenu() {
  return [
    {
      moduleCode: "system",
      moduleName: "平台管理",
      icon: "Settings",
      groups: {
        管理: [
          { featureCode: "tenant_manage", featureName: "租户管理", pageCode: "tenant_manage" },
          { featureCode: "dsl_version", featureName: "DSL 版本", pageCode: "dsl_version" },
          { featureCode: "agent_task", featureName: "AI 变更任务", pageCode: "agent_task" }
        ]
      }
    }
  ];
}
