import { pool } from "../db/pool.js";
import { visiblePageCodes } from "../permission/permission.service.js";
import type { SessionUser } from "../types.js";

export async function loadTenantMenu(schemaName: string, user?: SessionUser) {
  const permitted = new Set(await visiblePageCodes(user, schemaName));
  const isPreviewTestSchema = schemaName.endsWith("_test");
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
    if (isPreviewTestSchema && ["customization_record_list", "tenant_version_list"].includes(row.page_code)) continue;
    if (permitted.size && !permitted.has(row.page_code)) continue;
    if (!modules.has(row.module_code)) {
      modules.set(row.module_code, { moduleCode: row.module_code, moduleName: row.module_name, icon: row.icon, groups: {} });
    }
    const group = (() => {
      const mc = row.module_code;
      const pc = row.page_code;
      if (mc === "finance") {
        if (pc.includes("arrange")) return "分配记录";
        if (pc.includes("product") || pc.includes("promotion")) return "产品优惠";
        if (pc.includes("contract") || pc.includes("ele_account")) return "合同收费";
        if (pc.includes("pay_way")) return "财务配置";
        return "财务流水";
      }
      if (mc === "student") return pc.includes("followup") ? "跟进管理" : "学员管理";
      if (mc === "education") {
        if (pc.includes("course_week") || pc.includes("course_list") || pc.includes("holiday") || pc.includes("makeup") || pc.includes("leave")) return "排课上课";
        if (pc.includes("mini_class") || pc.includes("one_on_n")) return "班级管理";
        if (pc.includes("charge")) return "消课扣费";
        return "教务配置";
      }
      if (mc === "oa") return pc.includes("approval") ? "审批流转" : "协同办公";
      if (mc === "report") return pc.includes("finance") ? "财务报表" : pc.includes("course") ? "课程报表" : "经营报表";
      if (mc === "system") {
        if (pc.includes("customization") || pc.includes("assistant_record") || pc.includes("tenant_version")) return "AI 能力";
        if (pc.includes("organization") || pc.includes("user") || pc.includes("role")) return "组织权限";
        return "系统配置";
      }
      return "管理";
    })();
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
  const { rows } = await pool.query(
    `select m.module_code, m.module_name, m.icon, m.sort_no as module_sort,
            f.feature_code, f.feature_name, f.page_code, f.sort_no as feature_sort
     from admin.module_registry m
     join admin.feature_registry f on f.module_code = m.module_code and f.deleted = false and f.status = 'ACTIVE'
     where m.deleted = false and m.status = 'ACTIVE'
       and m.module_group = 'platform'
     order by m.sort_no, f.sort_no, f.feature_name`
  );
  if (rows.length === 0) {
    return [
      {
        moduleCode: "system",
        moduleName: "平台管理",
        icon: "Settings",
        groups: {
          管理: [
            { featureCode: "tenant_manage", featureName: "租户管理", pageCode: "tenant_manage" },
            { featureCode: "dsl_version", featureName: "DSL 版本", pageCode: "dsl_version" }
          ],
          租户运营: [
            { featureCode: "tenant_recharge_record", featureName: "充值记录", pageCode: "tenant_recharge_record" },
            { featureCode: "assistant_record_list", featureName: "AI 助手记录", pageCode: "assistant_record_list" },
            { featureCode: "customization_record_list", featureName: "AI 定制记录", pageCode: "customization_record_list" }
          ]
        }
      }
    ];
  }
  const modules = new Map<string, { moduleCode: string; moduleName: string; icon: string; groups: Record<string, unknown[]> }>();
  for (const row of rows) {
    if (!modules.has(row.module_code)) {
      modules.set(row.module_code, { moduleCode: row.module_code, moduleName: row.module_name, icon: row.icon, groups: {} });
    }
    const group = row.page_code.includes("recharge") || row.page_code.includes("customization") ? "租户运营" : "管理";
    modules.get(row.module_code)!.groups[group] ??= [];
    modules.get(row.module_code)!.groups[group].push({
      featureCode: row.feature_code,
      featureName: row.feature_name,
      pageCode: row.page_code
    });
  }
  return [...modules.values()];
}
