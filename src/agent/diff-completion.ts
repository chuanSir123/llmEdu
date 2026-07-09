import { pool } from "../db/pool.js";
import { TEMPLATE_SCHEMA } from "../common/template-schema.js";
import { inferDslFieldType } from "../common/field-type.js";
import type { DslDiff } from "./types.js";

/**
 * 反向显示补全：模型有时只生成 API 侧放行（api_dsl add_allowed_field），
 * 漏掉页面表单字段（page_dsl add_modal_field），结果字段"能存不能显"——
 * 新增/编辑/详情弹窗都不回显（ext_json 有值但 UI 无字段定义）。
 *
 * 本函数在扩展/校验前做确定性补全：create/update/detail 接口放行了新字段、
 * 同批没有该字段的任何显示位变更、页面现有表单也没有该字段时，
 * 自动合成一条 page_dsl add_modal_field（后续正向扩展会联动补 action_dsl 弹窗字段）。
 * 列表列（add_column）与筛选（add_filter）不自动补——用户可能明确只要详情/表单。
 */
export async function completeDisplayDiffs(diffs: DslDiff[], schemaName: string): Promise<DslDiff[]> {
  const candidates = new Map<string, { pageCode: string; field: string }>();
  for (const diff of diffs) {
    if (diff.targetType !== "api_dsl" || diff.op !== "add_allowed_field") continue;
    const match = diff.targetCode.match(/^(.+)\.(create|update|detail)$/);
    if (!match) continue;
    const field = String(diff.fieldDef?.field ?? diff.fieldDef?.key ?? diff.field ?? "");
    if (!field) continue;
    candidates.set(`${match[1]}::${field}`, { pageCode: match[1], field });
  }
  if (candidates.size === 0) return [];

  const fieldOf = (diff: DslDiff) => String(diff.fieldDef?.key ?? diff.fieldDef?.field ?? diff.field ?? "");
  const hasDisplayDiff = (pageCode: string, field: string) =>
    diffs.some((diff) => {
      if (diff.targetType === "page_dsl" && diff.targetCode === pageCode) {
        if (diff.op === "modify") return true; // 整页替换时不做补全，避免与替换内容冲突
        if ((diff.op === "add_modal_field" || diff.op === "add_column") && fieldOf(diff) === field) return true;
      }
      if (diff.targetType === "action_dsl" && diff.op === "add_modal_field" && fieldOf(diff) === field) return true;
      return false;
    });

  const completions: DslDiff[] = [];
  const modalFieldCache = new Map<string, Set<string> | null>();
  for (const { pageCode, field } of candidates.values()) {
    if (hasDisplayDiff(pageCode, field)) continue;
    let existing = modalFieldCache.get(pageCode);
    if (existing === undefined) {
      existing = await loadPageModalFieldKeys(schemaName, pageCode);
      modalFieldCache.set(pageCode, existing);
    }
    if (existing === null) continue; // targetCode 前缀不是页面（如子接口），不补
    if (existing.has(field)) continue; // 页面表单已有该字段
    const label = findFieldLabel(diffs, field) ?? field;
    completions.push({
      targetType: "page_dsl",
      targetCode: pageCode,
      op: "add_modal_field",
      field,
      fieldDef: { key: field, label, type: inferDslFieldType(field, label, "text") },
    } as DslDiff);
  }
  return completions;
}

/** 读取页面当前生效 DSL 的表单字段 key 集合；页面不存在返回 null。 */
async function loadPageModalFieldKeys(schemaName: string, pageCode: string): Promise<Set<string> | null> {
  const { rows } = await pool.query(
    `select dsl_json from admin.page_dsl
     where page_code = $1 and status = 'active' and deleted = false
       and ((schema_scope = 'tenant' and schema_name = $2) or (schema_scope = 'tenant' and schema_name = '${TEMPLATE_SCHEMA}'))
     order by case when schema_scope = 'tenant' and schema_name = $2 then 0 else 1 end
     limit 1`,
    [pageCode, schemaName]
  );
  if (!rows[0]) return null;
  const dsl = rows[0].dsl_json;
  if (!dsl || typeof dsl !== "object" || Array.isArray(dsl)) return null;
  const modal = (dsl as Record<string, unknown>).modal;
  const keys = new Set<string>();
  if (modal && typeof modal === "object" && !Array.isArray(modal)) {
    for (const item of ((modal as Record<string, unknown>).fields as unknown[] | undefined) ?? []) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const key = String((item as Record<string, unknown>).key ?? (item as Record<string, unknown>).field ?? "");
        if (key) keys.add(key);
      }
    }
  }
  return keys;
}

/** 从同批 diffs 中找该字段的中文 label（模型的 db/page diff 或 resourceDef.fields 里可能带）。 */
function findFieldLabel(diffs: DslDiff[], field: string): string | undefined {
  for (const diff of diffs) {
    const def = diff.fieldDef;
    if (def && String(def.key ?? def.field ?? "") === field && typeof def.label === "string" && def.label) {
      return def.label;
    }
    const resourceFields = Array.isArray(diff.resourceDef?.fields) ? diff.resourceDef.fields : [];
    for (const item of resourceFields) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const obj = item as Record<string, unknown>;
        if (String(obj.key ?? obj.field ?? "") === field && typeof obj.label === "string" && obj.label) {
          return obj.label;
        }
      }
    }
  }
  return undefined;
}
