import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import * as XLSX from "xlsx";
import { pool } from "../db/pool.js";
import { executeGatewayApi, loadApiDsl } from "../gateway/api-executor.js";
import { executeApiDsl } from "../gateway/query-dsl-engine.js";
import { inferForeignKeyMeta } from "../common/foreign-key-meta.js";
import { loadTenantMenu } from "../gateway/menu.service.js";
import { loadPageFullDsl } from "../gateway/page.service.js";
import { canAccessPage, canExecuteApiOnPage } from "../permission/permission.service.js";
import { callWithToolCalling, loadLlmConfig, runWithLlmTraceContext } from "../agent/llm.service.js";
import { loadAttachments } from "./attachment.service.js";
import { executeTenantImport, resolveTenantImportConfig } from "./import.service.js";
import { writeCustomizationRecord } from "./tenant-customization-record.service.js";
import type { AgentProgressCallback, LlmMessage } from "../agent/types.js";
import type { SessionUser } from "../types.js";
import { TEMPLATE_SCHEMA } from "../common/template-schema.js";
import { SYSTEM_WRITE_FIELD_SET } from "../common/dsl-constants.js";

type AssistantToolName = "list_modules" | "list_features" | "query_data" | "analyze_data" | "execute_business_api" | "navigate" | "plan_excel_import" | "execute_excel_import";
type AssistantMessage = { role: string; content: string; timestamp?: string };
type ImportMapping = {
  attachmentId: string;
  fileName: string;
  sheetName: string;
  pageCode: string;
  apiCode?: string;
  order: number;
  confidence?: number;
  reason?: string;
  fieldMapping: Record<string, string>;
};

const importPageHints = [
  { pageCode: "student_list", apiCode: "student_list.create", names: ["学员", "学生", "student"], order: 10 },
  { pageCode: "contract_list", apiCode: "contract_list.create", names: ["合同", "报名", "contract"], order: 20 },
  { pageCode: "funds_history", apiCode: "funds_history.create", names: ["收款", "流水", "缴费", "funds"], order: 30 },
  { pageCode: "course_list", apiCode: "course_list.create", names: ["排课", "课程", "course"], order: 40 },
  { pageCode: "charge_record", apiCode: "charge_record.create", names: ["扣费", "消课", "charge"], order: 50 },
  { pageCode: "refund_record", apiCode: "refund_record.create", names: ["退费", "退款", "refund"], order: 60 },
];

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function parseToolArgs(raw: string) {
  try {
    return asObject(JSON.parse(raw || "{}"));
  } catch {
    return {};
  }
}

function toolDefinition(name: AssistantToolName, description: string, properties: Record<string, unknown>, required: string[] = []) {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: {
        type: "object",
        properties,
        required,
      },
    },
  };
}

const assistantTools = [
  toolDefinition("list_modules", "列出当前账号可访问的业务模块。", {}),
  toolDefinition("list_features", "列出某个模块下当前账号可访问的功能页面。", {
    moduleCode: { type: "string", description: "模块编码，如 student、finance、education、system" },
  }),
  toolDefinition("query_data", "按页面查询业务数据。必须先确定 pageCode；查询会自动应用当前账号的数据权限。", {
    pageCode: { type: "string", description: "页面编码，如 student_list、contract_list、funds_history、course_list、charge_record、refund_record" },
    filters: { type: "object", description: "页面筛选条件，如 { name: '张三' } 或 { student_name: '张三' }" },
    pageSize: { type: "number", description: "返回条数，默认 10，最大 50" },
  }, ["pageCode"]),
  toolDefinition("analyze_data", "数据分析/聚合统计。按维度分组并计算指标（求和、计数、平均、最大/最小、去重计数），用于校区收款汇总、各老师课时、续费率、按月趋势、排行等。会自动应用当前账号数据权限。", {
    pageCode: { type: "string", description: "页面编码，如 funds_history、course_list、contract_list、student_list" },
    dimensions: { type: "array", items: { type: "string" }, description: "分组维度字段名（真实物理列），如 ['organization_id']、['teacher_id']。外键 *_id 会自动展示名称。可为空表示只算总计。" },
    metrics: { type: "array", items: { type: "object" }, description: "统计指标数组，每项 {field, type}。type ∈ count/sum/avg/min/max/distinct_count。如 [{field:'transaction_amount',type:'sum'}]；count 可省略 field。" },
    filters: { type: "object", description: "等值过滤，如 { organization_id: 'xxx', funds_type: 'CONTRACT_PAY' }，字段须为真实列。" },
    timeRange: { type: "object", description: "时间范围 { field, start, end }，如 { field:'transaction_time', start:'2026-01-01', end:'2026-01-31' }。" },
    sort: { type: "object", description: "排序 { field, direction }，field 可为指标别名（如 transaction_amount_sum）或维度，direction asc/desc。" },
    rank: { type: "boolean", description: "是否输出排名列（用于排行榜）。" },
    limit: { type: "number", description: "返回分组数，默认 20，最大 100。" },
  }, ["pageCode"]),
  toolDefinition("execute_business_api", "调用已有业务接口执行操作。仅用于用户明确要求新增、更新、删除或业务动作。必须提供完整的 params.data 对象。", {
    pageCode: { type: "string", description: "页面编码" },
    apiCode: { type: "string", description: "接口编码，如 student_list.create、product_list.create、funds_history.create" },
    params: { type: "object", description: "接口参数，必须包含 data 字段。data 中的外键字段（如 student_id、organization_id）需传 ID，如不知 ID 可先 query_data 查询。" },
  }, ["pageCode", "apiCode"]),
  toolDefinition("navigate", "业务导航：当用户想“去/打开/跳转到”某功能页面，或想查看某筛选条件下的列表时，返回目标页面与预置筛选，前端会直接打开该页面。不要用它执行查询或写操作。", {
    pageCode: { type: "string", description: "目标页面编码，如 student_list、funds_history、course_list" },
    filters: { type: "object", description: "预置筛选条件（可选），如 { student_status: 'ARREARS' } 或 { name: '张三' }。" },
    reason: { type: "string", description: "一句话说明为什么跳转这个页面。" },
  }, ["pageCode"]),
  toolDefinition("plan_excel_import", "根据已上传 Excel/CSV 附件规划导入顺序和字段映射。会读取附件的 sheet 结构、表头、样例行，自动判断每个 sheet 应导入到哪个功能模块，并给出字段映射。按学员→合同→收款→排课→扣费→退费的依赖排序。", {
    attachmentIds: { type: "array", items: { type: "string" }, description: "附件 ID，必须使用系统提示里给出的 attachmentId，不要使用文件名" },
    fieldMappingOverrides: { type: "object", description: "可选。当用户在对话中纠正列映射时传入，形如 { student_list: { contact: '手机号码' } }，key 为 pageCode，value 为 {目标字段: 源表头}，会覆盖自动映射。" },
  }),
  toolDefinition("execute_excel_import", "执行 Excel/CSV 自动导入。必须先调用 plan_excel_import 获得导入计划，再调用本工具执行。校验失败时返回 failures（逐行原因），请逐条向用户解释并给出修正建议。", {
    attachmentIds: { type: "array", items: { type: "string" }, description: "附件 ID，必须使用系统提示里给出的 attachmentId，不要使用文件名" },
    mode: { type: "string", enum: ["validate", "import", "validate_import"], description: "validate 仅校验，import 正式导入，validate_import 按依赖逐项校验通过后自动导入" },
    fieldMappingOverrides: { type: "object", description: "可选。用户纠正列映射时传入，形如 { student_list: { contact: '手机号码' } }，会覆盖自动映射后重跑。" },
  }),
];

async function ensureSession(schemaName: string, userId: string, sessionId?: string) {
  if (sessionId) {
    const { rows } = await pool.query(
      `select id, context from admin.agent_chat_session where id = $1 and schema_name = $2 and user_id = $3 and status = 'active' and deleted = false`,
      [sessionId, schemaName, userId]
    );
    if (rows[0]) return { sessionId, context: asObject(rows[0].context) };
  }
  const id = randomUUID();
  const context = { mode: "business_assistant", messages: [] as AssistantMessage[] };
  await pool.query(
    `insert into admin.agent_chat_session(id, schema_name, user_id, context, status) values($1,$2,$3,$4,'active')`,
    [id, schemaName, userId, JSON.stringify(context)]
  );
  return { sessionId: id, context };
}

function compactRows(rows: Record<string, unknown>[]) {
  return rows.slice(0, 50).map((row) => {
    const result: Record<string, unknown> = {};
    // 保留 id，便于后续 update/delete 引用该记录；仅剔除冗长的 ext_json
    for (const [key, value] of Object.entries(row)) {
      if (key === "ext_json") continue;
      result[key] = value;
    }
    return result;
  });
}

const SAFE_FIELD_RE = /^[a-z][a-z0-9_]{0,62}$/;
const AGG_TYPES = new Set(["count", "sum", "avg", "min", "max", "distinct_count"]);

async function loadTableColumnSet(schemaName: string, table: string): Promise<Set<string>> {
  if (!SAFE_FIELD_RE.test(schemaName) || !SAFE_FIELD_RE.test(table)) return new Set();
  const { rows } = await pool.query(
    `select column_name from information_schema.columns where table_schema = $1 and table_name = $2`,
    [schemaName, table]
  );
  return new Set(rows.map((r: { column_name: string }) => String(r.column_name)));
}

async function featureCatalog(schemaName: string, user: SessionUser, moduleCode?: string) {
  const modules = await loadTenantMenu(schemaName, user);
  const result: Array<{ moduleCode: string; moduleName: string; featureName: string; pageCode: string }> = [];
  for (const mod of modules as Array<{ moduleCode: string; moduleName: string; groups: Record<string, Array<{ featureName: string; pageCode: string }>> }>) {
    if (moduleCode && mod.moduleCode !== moduleCode) continue;
    for (const items of Object.values(mod.groups)) {
      for (const item of items) result.push({ moduleCode: mod.moduleCode, moduleName: mod.moduleName, featureName: item.featureName, pageCode: item.pageCode });
    }
  }
  return result;
}

// 不规则别名：name_hint 前缀 → 实际目标字段（其余按 ${base}_id 通用推导，覆盖任意定制外键）
const HINT_TARGET_ALIASES: Record<string, string> = {
  pay_way: "pay_way_config_id",
  refund_way: "refund_way_config_id",
  product: "product_ids",
};

async function resolveNameHints(schemaName: string, data: Record<string, unknown>, user: SessionUser) {
  for (const key of Object.keys(data)) {
    if (!key.endsWith("_name_hint")) continue;
    const base = key.slice(0, -"_name_hint".length);
    const targetKey = HINT_TARGET_ALIASES[base] ?? `${base}_id`;
    const nameValue = String(data[key] ?? "").trim();
    delete data[key];
    if (!nameValue || data[targetKey]) continue;
    // product_ids 是数组型外键，外键元数据按 product_id 推导
    const isArrayTarget = targetKey === "product_ids";
    const metaKey = isArrayTarget ? "product_id" : targetKey;
    const meta = inferForeignKeyMeta(metaKey);
    if (!meta) continue;
    try {
      const result = await executeGatewayApi("tenant", schemaName, meta.apiCode, {
        filters: { [meta.labelField]: nameValue },
        page: 1,
        pageSize: 5,
      }, user) as { rows?: Record<string, unknown>[] };
      const matched = (result.rows ?? []).filter((row) => String(row[meta.labelField] ?? "").trim() === nameValue);
      if (matched.length === 1) {
        data[targetKey] = isArrayTarget ? [matched[0].id] : matched[0].id;
      }
    } catch {
      // ignore resolution errors
    }
  }
  if (data.student_id && !data.contract_id && String(data.funds_type ?? "").includes("CONTRACT_PAY")) {
    try {
      const schema = `"${schemaName}"`;
      const { rows } = await pool.query(
        `select id from ${schema}.contract where student_id = $1 and deleted = false and contract_status = 'ACTIVE' order by created_at desc limit 2`,
        [data.student_id]
      );
      if (rows.length === 1) data.contract_id = rows[0].id;
    } catch {
      // ignore
    }
  }
}

async function runTool(input: {
  name: string;
  args: Record<string, unknown>;
  schemaName: string;
  user: SessionUser;
  attachmentIds: string[];
}) {
  const { name, args, schemaName, user } = input;
  if (name === "list_modules") {
    const modules = await loadTenantMenu(schemaName, user) as Array<{ moduleCode: string; moduleName: string }>;
    return { modules: modules.map((m) => ({ moduleCode: m.moduleCode, moduleName: m.moduleName })) };
  }
  if (name === "list_features") {
    return { features: await featureCatalog(schemaName, user, String(args.moduleCode ?? "")) };
  }
  if (name === "query_data") {
    const pageCode = String(args.pageCode ?? "");
    if (!(await canAccessPage(user, schemaName, pageCode))) {
      return { ok: false, pageCode, error: `当前账号没有页面 ${pageCode} 的访问权限，无法查询。` };
    }
    const page = await loadPageFullDsl("tenant", pageCode, schemaName, user);
    const dsl = asObject(page.page.dsl_json);
    const dataApi = String(dsl.dataApi ?? `${pageCode}.query`);
    const result = await executeGatewayApi("tenant", schemaName, dataApi, {
      filters: asObject(args.filters),
      page: 1,
      pageSize: Math.min(Math.max(Number(args.pageSize ?? 10), 1), 50),
    }, user) as { rows?: Record<string, unknown>[]; total?: number };
    return { pageCode, total: result.total ?? result.rows?.length ?? 0, rows: compactRows(result.rows ?? []) };
  }
  if (name === "analyze_data") {
    const pageCode = String(args.pageCode ?? "");
    if (!(await canAccessPage(user, schemaName, pageCode))) {
      return { ok: false, pageCode, error: `当前账号没有页面 ${pageCode} 的访问权限，无法分析该页数据。` };
    }
    const queryDsl = asObject(await loadApiDsl("tenant", `${pageCode}.query`, schemaName).catch(() => ({})));
    const table = String(queryDsl.table ?? pageCode.replace(/_(list|history|record)$/, ""));
    const realCols = await loadTableColumnSet(schemaName, table);
    if (realCols.size === 0) return { ok: false, pageCode, error: `未找到 ${pageCode} 的数据表，无法分析。请确认 pageCode 是否正确。` };

    const dimensions = (Array.isArray(args.dimensions) ? args.dimensions : []).map(String).filter((f) => realCols.has(f));
    const metrics = (Array.isArray(args.metrics) ? args.metrics : [])
      .map((m) => asObject(m))
      .map((m) => ({ field: String(m.field ?? ""), type: String(m.type ?? "count").toLowerCase() }))
      .filter((m) => AGG_TYPES.has(m.type) && (m.type === "count" || realCols.has(m.field)))
      .map((m) => ({ field: m.field || "id", type: m.type, as: `${m.field || "row"}_${m.type}` }));
    if (dimensions.length === 0 && metrics.length === 0) {
      return { ok: false, pageCode, error: "请至少提供一个有效分组维度 dimensions 或统计指标 metrics（field 必须是真实列、type 合法）。" };
    }

    const where: Array<Record<string, unknown>> = [];
    const callParams: Record<string, unknown> = { page: 1, pageSize: Math.min(Math.max(Number(args.limit ?? 20), 1), 100) };
    for (const [key, value] of Object.entries(asObject(args.filters))) {
      if (realCols.has(key) && value != null && value !== "") {
        where.push({ field: key, op: "eq", source: "param", param: key, ignoreEmpty: true });
        callParams[key] = value;
      }
    }
    const timeRange = asObject(args.timeRange);
    const timeField = String(timeRange.field ?? "");
    if (timeField && realCols.has(timeField) && timeRange.start && timeRange.end) {
      where.push({ field: timeField, op: "between", source: "param", param: "__time_range", ignoreEmpty: true });
      callParams.__time_range = [timeRange.start, timeRange.end];
    }
    const sort = asObject(args.sort);
    const dsl = {
      table,
      operation: "query",
      security: queryDsl.security,
      dimensions,
      metrics,
      where,
      sort: sort.field ? { field: String(sort.field), direction: String(sort.direction) === "asc" ? "asc" : "desc" } : undefined,
      rank: Boolean(args.rank),
    };
    try {
      const result = await executeApiDsl(schemaName, dsl as never, callParams, user) as { rows?: unknown[]; total?: number };
      return { pageCode, table, dimensions, metrics: metrics.map((m) => m.as), groups: result.rows ?? [], total: result.total ?? 0 };
    } catch (err) {
      return { ok: false, pageCode, error: `数据分析失败: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  if (name === "navigate") {
    const pageCode = String(args.pageCode ?? "");
    if (!pageCode) return { ok: false, error: "navigate 需要 pageCode" };
    try {
      // 校验页面存在
      await loadPageFullDsl("tenant", pageCode, schemaName, user);
    } catch {
      return { ok: false, pageCode, error: `页面 ${pageCode} 不存在` };
    }
    // 校验当前账号页面权限（loadPageFullDsl 只过滤按钮，不校验页面访问权）
    if (!(await canAccessPage(user, schemaName, pageCode))) {
      return { ok: false, pageCode, error: `当前账号没有页面 ${pageCode} 的访问权限` };
    }
    return { ok: true, navigate: { pageCode, filters: asObject(args.filters) }, reason: String(args.reason ?? "") };
  }
  if (name === "execute_business_api") {
    const pageCode = String(args.pageCode ?? "");
    const apiCode = String(args.apiCode ?? "");
    // 页面权限 + 按钮权限：与前端点按钮同等的权限口径，AI 对话不能成为绕过权限的后门
    if (!(await canAccessPage(user, schemaName, pageCode))) {
      return { ok: false, pageCode, apiCode, error: `当前账号没有页面 ${pageCode} 的访问权限，无法执行业务操作。` };
    }
    if (!(await canExecuteApiOnPage(user, schemaName, pageCode, apiCode))) {
      return { ok: false, pageCode, apiCode, error: `当前账号在页面 ${pageCode} 没有执行 ${apiCode} 的按钮权限。` };
    }
    if (!apiCode.endsWith(".create") && !apiCode.endsWith(".update") && !apiCode.endsWith(".delete")) {
      try {
        const apiDsl = asObject(await loadApiDsl("tenant", apiCode, schemaName));
        if (!["create", "update", "delete", "command"].includes(String(apiDsl.operation ?? ""))) {
          return { ok: false, pageCode, apiCode, error: `接口 ${apiCode} 不是新增/更新/删除/命令类接口，无法执行业务操作。请检查 apiCode 是否正确。` };
        }
      } catch {
        if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(apiCode)) {
          return { ok: false, pageCode, apiCode, error: `接口 ${apiCode} 不存在或格式不正确，无法执行业务操作。` };
        }
      }
    }
    const params = asObject(args.params);
    const data = asObject(params.data);
    if (!apiCode.endsWith(".delete") && Object.keys(data).length === 0) {
      return { ok: false, pageCode, apiCode, error: `调用 ${apiCode} 时 params.data 为空。请提供完整的业务数据。如果需要先查询 ID（如 student_id、organization_id），请先调用 query_data 查询后再传入。` };
    }
    await resolveNameHints(schemaName, data, user);
    params.data = data;
    try {
      const result = await executeGatewayApi("tenant", schemaName, apiCode, params, user);
      return { ok: true, pageCode, apiCode, data: result };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return { ok: false, pageCode, apiCode, error: `调用 ${apiCode} 失败: ${errorMsg}` };
    }
  }
  if (name === "plan_excel_import" || name === "execute_excel_import") {
    const requestedIds = (Array.isArray(args.attachmentIds) ? args.attachmentIds.map(String) : input.attachmentIds).filter(Boolean);
    const attachmentIds = requestedIds.some((id) => input.attachmentIds.includes(id)) ? requestedIds : input.attachmentIds;
    const plan = await planExcelImport(schemaName, attachmentIds, user);
    // 对话内纠正列映射：覆盖自动映射后再返回/执行
    const overrides = asObject(args.fieldMappingOverrides);
    for (const item of plan) {
      const pageOverride = asObject(overrides[item.pageCode]);
      for (const [field, header] of Object.entries(pageOverride)) {
        if (header) item.fieldMapping[field] = String(header);
        else delete item.fieldMapping[field];
      }
    }
    if (name === "plan_excel_import") return { plan };
    const rawMode = String(args.mode ?? "validate");
    const mode = rawMode === "import" ? "import" : rawMode === "validate_import" ? "validate_import" : "validate";
    const results = [];
    // 纯校验模式下，前序 sheet 将生成的名称集合（pageCode → 该页各 label 值）。
    // 后续 sheet 的外键名称命中集合时降级为提示，消除"前序还没入库"导致的校验误报。
    const plannedRowsByPage = new Map<string, Record<string, unknown>[]>();
    for (const item of plan) {
      if (!item.localPath) continue;
      const config = await resolveTenantImportConfig({ schemaName, pageCode: item.pageCode, apiCode: item.apiCode });
      // 执行前校验写权限（计划可能来自历史会话或模型直接给出的 pageCode）
      if (!(await canAccessPage(user, schemaName, item.pageCode)) || !(await canExecuteApiOnPage(user, schemaName, item.pageCode, config.apiCode))) {
        results.push({ ...item, mode: "denied", total: 0, success: 0, failed: 0, failures: [{ row: 0, message: `当前账号没有页面 ${item.pageCode} 的导入权限，已跳过` }], resultFile: undefined });
        continue;
      }
      const sourceRows = await buildMappedRows(item.localPath, item.sheetName, item.fieldMapping);
      const pendingForeignNames = mode === "validate"
        ? collectPendingForeignNames(config.fields, plannedRowsByPage)
        : undefined;
      const runImport = (validateOnly: boolean) => executeTenantImport({
        schemaName,
        pageCode: item.pageCode,
        apiCode: config.apiCode,
        fileName: `${item.fileName}-${item.sheetName}`,
        contentBase64: "",
        fields: config.fields,
        idResolutionStrategy: "error",
        validateOnly,
        user,
        sourceRows,
        pendingForeignNames,
      });
      plannedRowsByPage.set(item.pageCode, [...(plannedRowsByPage.get(item.pageCode) ?? []), ...sourceRows]);
      if (mode === "validate_import") {
        const validateResult = await runImport(true);
        results.push({ ...item, mode: "validate", total: validateResult.total, success: validateResult.success, failed: validateResult.failed, failures: validateResult.failures, resultFile: validateResult.resultFile });
        if (validateResult.failed > 0) break;
        const importResult = await runImport(false);
        results.push({ ...item, mode: "import", total: importResult.total, success: importResult.success, failed: importResult.failed, failures: importResult.failures, resultFile: importResult.resultFile });
        if (importResult.failed > 0) break;
        continue;
      }
      const result = await runImport(mode === "validate");
      results.push({ ...item, mode, total: result.total, success: result.success, failed: result.failed, failures: result.failures, resultFile: result.resultFile });
    }
    return { plan, results };
  }
  throw Object.assign(new Error(`未知工具: ${name}`), { statusCode: 400 });
}

/**
 * 收集"将由前序 sheet 导入生成"的外键名称：
 * 当前 sheet 的外键字段（optionSource.pageCode 指向前序已规划的页面）
 * 可在纯校验时容忍名称暂未入库，只要该名称出现在前序 sheet 的 label 列中。
 */
function collectPendingForeignNames(
  fields: Array<{ key: string; optionSource?: { pageCode?: string; labelField?: string } }>,
  plannedRowsByPage: Map<string, Record<string, unknown>[]>,
): Record<string, Set<string>> | undefined {
  const result: Record<string, Set<string>> = {};
  for (const field of fields) {
    const sourcePage = field.optionSource?.pageCode;
    if (!sourcePage) continue;
    const plannedRows = plannedRowsByPage.get(sourcePage);
    if (!plannedRows?.length) continue;
    const labelField = field.optionSource?.labelField ?? "name";
    const names = new Set<string>();
    for (const row of plannedRows) {
      const label = String(row[labelField] ?? "").trim();
      if (label) names.add(label);
    }
    if (names.size > 0) result[field.key] = names;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

// 枚举该租户已配置导入能力的页面（import_dsl，含 tenant 覆盖与 demo_school），覆盖定制新增的导入功能
async function loadImportablePageCodes(schemaName: string): Promise<string[]> {
  const { rows } = await pool.query(
    `select distinct coalesce(dsl_json->>'pageCode', dsl_json->>'page_code') as page_code
     from admin.import_dsl
     where status = 'active' and deleted = false
       and ((schema_scope = 'tenant' and schema_name = $1) or (schema_scope = 'tenant' and schema_name = '${TEMPLATE_SCHEMA}'))`,
    [schemaName]
  );
  return rows.map((r: { page_code: string | null }) => String(r.page_code ?? "")).filter((code) => SAFE_FIELD_RE.test(code));
}

async function planExcelImport(schemaName: string, attachmentIds: string[], user: SessionUser) {
  const attachments = await loadAttachments(attachmentIds, schemaName);
  const spreadsheetAttachments = attachments
    .filter((item) => asObject(item.content_summary).kind === "spreadsheet")
    .map((item) => ({ ...item, local_path: (item as { local_path?: string }).local_path }));
  if (!spreadsheetAttachments.length) return [];

  const features = await featureCatalog(schemaName, user);
  // 核心依赖链（学员→合同→收款→排课→扣费→退费）+ 动态发现的其它已配置导入功能（含 AI 定制新增）
  const dynamicImportPages = await loadImportablePageCodes(schemaName);
  const importHintMap = new Map(importPageHints.map((hint) => [hint.pageCode, hint]));
  const importPlan = [
    ...importPageHints,
    ...dynamicImportPages
      .filter((pageCode) => !importHintMap.has(pageCode))
      .map((pageCode, index) => ({ pageCode, apiCode: `${pageCode}.create`, order: 100 + index, names: [pageCode] as string[] })),
  ];
  const importTargets = [];
  for (const hint of importPlan) {
    try {
      // 当前账号无该页面权限时不纳入导入计划（AI 导入与手工导入同权限口径）
      if (!(await canAccessPage(user, schemaName, hint.pageCode))) continue;
      const config = await resolveTenantImportConfig({ schemaName, pageCode: hint.pageCode, apiCode: hint.apiCode });
      importTargets.push({
        pageCode: hint.pageCode,
        apiCode: config.apiCode,
        order: hint.order,
        names: hint.names,
        fields: config.fields.map((field) => ({ key: field.key, label: field.label ?? field.title ?? field.key, required: field.required, type: field.type, optionSource: field.optionSource ? { pageCode: field.optionSource.pageCode, apiCode: field.optionSource.apiCode, labelField: field.optionSource.labelField } : undefined })),
      });
    } catch {
      // Page may be disabled for the tenant.
    }
  }
  const workbookSummaries = spreadsheetAttachments.map((item) => ({
    attachmentId: item.id,
    fileName: item.file_name,
    sheets: asObject(item.content_summary).sheets ?? [{
      sheetName: asObject(item.content_summary).sheetName,
      headers: asObject(item.content_summary).headers,
      sampleRows: asObject(item.content_summary).sampleRows,
      rowCount: asObject(item.content_summary).rowCount,
    }],
  }));

  let raw = "[]";
  try {
    const llmPlan = await callWithToolCalling({
      schemaName,
      messages: [
        {
          role: "system",
          content: [
            "你是教培系统 Excel 导入映射规划器。",
            "用户上传的 Excel 可能不是系统模板，可能包含多个文件、多个 sheet、合并口径、不同字段名。",
            "请根据每个 sheet 的名称、表头、样例行，判断该 sheet 应导入到哪个功能 pageCode，并给出完整的 fieldMapping。",
            "",
            "## fieldMapping 规则",
            "- fieldMapping 的 key 必须是下方 importTargets 中该 pageCode 对应的字段 key（如 name、contact、organization_id）。",
            "- fieldMapping 的 value 是源 Excel 的表头名（如 姓名、电话、校区名称）。",
            "- 不要映射源 Excel 中不存在的表头。",
            "- 必须映射所有 required 字段。如果源 Excel 中没有对应的列，但 required 字段有常见默认值，请在 reason 中说明。",
            "- 常见字段名对应：姓名→name, 电话→contact, 校区/校区名称→organization_id, 阶段/状态/学员状态→student_status, 学校→school_name, 年级→grade, 备注→remark。",
            "- 对于 optionSource 字段（如 organization_id、student_id），系统导入时会自动按名称解析为 ID，value 填写名称列的表头即可。",
            "",
            "## 依赖排序规则",
            "必须按依赖排序：学员 student_list(10) → 合同 contract_list(20) → 收款 funds_history(30) → 排课 course_list(40) → 扣费 charge_record(50) → 退费 refund_record(60)。",
            "合同必须在学员之后，因为合同需要学员 ID；收款/扣费/退费必须在合同之后。",
            "",
            "## 输出格式",
            "输出 JSON 数组，每个元素包含：attachmentId、sheetName、pageCode、apiCode、order、fieldMapping、confidence(0-1)、reason。",
            "一个文件有多个 sheet 时，必须为每个 sheet 分别输出一个元素，不要遗漏任何 sheet。",
            "多个文件时，必须为每个文件的每个 sheet 都输出一个元素。",
            "无法确定的 sheet 不要纳入计划。",
            "只输出 JSON 数组，不要输出其他文字。",
          ].join("\n"),
        },
        {
          role: "user",
          content: JSON.stringify({ features, importTargets, workbooks: workbookSummaries }, null, 2),
        },
      ],
    });
    raw = llmPlan.content ?? "[]";
  } catch {
    raw = "[]";
  }
  const parsed = parseJsonArray(raw);
  const byAttachment = new Map(spreadsheetAttachments.map((item) => [item.id, item]));
  const targetByPage = new Map(importTargets.map((item) => [item.pageCode, item]));
  const llmPlan = parsed
    .map((item) => normalizeImportMapping(item, byAttachment, targetByPage))
    .filter((item): item is NonNullable<ReturnType<typeof normalizeImportMapping>> => Boolean(item))
    .sort((a, b) => a.order - b.order);

  const fallbackPlan = fallbackExcelImportPlan(spreadsheetAttachments, targetByPage);

  if (llmPlan.length === 0) return fallbackPlan;

  const fallbackByKey = new Map(fallbackPlan.map((item) => [`${item.attachmentId}::${item.sheetName}::${item.pageCode}`, item] as const));

  for (const llmItem of llmPlan) {
    const fallbackItem = fallbackByKey.get(`${llmItem.attachmentId}::${llmItem.sheetName}::${llmItem.pageCode}`);
    if (fallbackItem) {
      for (const [field, header] of Object.entries(fallbackItem.fieldMapping)) {
        if (!llmItem.fieldMapping[field]) {
          llmItem.fieldMapping[field] = String(header);
        }
      }
    }
  }

  const coveredKeys = new Set(llmPlan.map((item) => `${item.attachmentId}::${item.sheetName}`));
  for (const fallbackItem of fallbackPlan) {
    if (!coveredKeys.has(`${fallbackItem.attachmentId}::${fallbackItem.sheetName}`)) {
      llmPlan.push(fallbackItem);
    }
  }
  llmPlan.sort((a, b) => a.order - b.order);

  return llmPlan;
}

function parseJsonArray(raw: string): unknown[] {
  const trimmed = raw.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    const match = trimmed.match(/\[[\s\S]*\]/);
    if (!match) return [];
    try {
      const parsed = JSON.parse(match[0]);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
}

function normalizeImportMapping(
  value: unknown,
  byAttachment: Map<string, { id: string; file_name: string; local_path?: string; content_summary: Record<string, unknown> }>,
  targetByPage: Map<string, { pageCode: string; apiCode: string; order: number; fields: Array<{ key: string }> }>,
) {
  const obj = asObject(value);
  const rawAttachmentId = String(obj.attachmentId ?? obj.attachment_id ?? "");
  const attachmentId = rawAttachmentId || (byAttachment.size === 1 ? [...byAttachment.keys()][0] : "");
  const attachment = byAttachment.get(attachmentId);
  const pageCode = String(obj.pageCode ?? obj.page_code ?? "");
  const target = targetByPage.get(pageCode);
  const fieldMapping = asObject(obj.fieldMapping ?? obj.field_mapping);
  if (!attachment || !target || !Object.keys(fieldMapping).length) return null;
  const allowedFields = new Set(target.fields.map((field) => field.key));
  const cleanedMapping: Record<string, string> = {};
  for (const [targetField, sourceHeader] of Object.entries(fieldMapping)) {
    if (allowedFields.has(targetField) && sourceHeader) cleanedMapping[targetField] = String(sourceHeader);
  }
  if (!Object.keys(cleanedMapping).length) return null;
  return {
    attachmentId,
    fileName: attachment.file_name,
    localPath: attachment.local_path,
    sheetName: String(obj.sheetName ?? obj.sheet_name ?? asObject(attachment.content_summary).sheetName ?? ""),
    pageCode: target.pageCode,
    apiCode: String(obj.apiCode ?? obj.api_code ?? target.apiCode),
    order: Number(obj.order ?? target.order),
    confidence: Number(obj.confidence ?? 0),
    reason: String(obj.reason ?? "LLM 根据 sheet 名、表头和样例自动匹配"),
    fieldMapping: cleanedMapping,
  };
}

function requestedImportMode(message: string) {
  if (/正式导入|直接导入|校验.*导入|导入.*校验|先校验.*导入|先校验.*再.*导入/.test(message)) return "validate_import";
  if (/不要\s*正式|不要\s*写入|不\s*写入|不\s*正式|仅\s*校验|只\s*校验/.test(message)) return "validate";
  if (/导入/.test(message)) return "validate_import";
  if (/校验|验证|检查|试导入|预导入/.test(message)) return "validate";
  return "";
}

function headerAliases(pageCode: string, fieldKey: string, label: string) {
  const aliases: Record<string, Record<string, string[]>> = {
    student_list: {
      name: ["姓名", "学生姓名", "孩子姓名", "学员姓名"],
      contact: ["电话", "手机号", "联系电话"],
      organization_id: ["校区", "校区名称", "所在校区"],
      student_status: ["阶段", "当前阶段", "状态", "学员状态"],
      school_name: ["学校", "就读学校"],
      grade: ["年级"],
      remark: ["备注", "备注信息"],
    },
    contract_list: {
      student_id: ["学生姓名", "学员姓名", "学生", "学员"],
      product_ids: ["课程包", "报读课程", "课程", "产品"],
      contract_type: ["类型", "合同类型"],
      organization_id: ["签约校区", "校区"],
      sign_staff_id: ["签约老师", "签约人", "签约员工"],
      sign_time: ["签约日期", "签约时间"],
      remark: ["备注"],
    },
    funds_history: {
      contract_id: ["合同", "合同编号"],
      student_id: ["学员姓名", "学生姓名", "学生", "学员"],
      organization_id: ["校区"],
      transaction_amount: ["金额", "收款金额", "缴费金额"],
      pay_way_config_id: ["支付渠道", "支付方式"],
      transaction_time: ["缴费时间", "收款时间", "交易时间"],
      funds_type: ["类型", "流水类型"],
      remark: ["备注"],
    },
    course_list: {
      course_title: ["标题", "课程名称", "课次"],
      course_type: ["课程类别", "课程类型", "类型"],
      course_date: ["日期", "上课日期"],
      start_time: ["开始", "开始时间"],
      end_time: ["结束", "结束时间"],
      teacher_id: ["授课老师", "老师"],
      study_manager_id: ["管理老师", "学管师"],
      student_id: ["学生", "学员", "学生姓名", "学员姓名"],
      contract_product_id: ["合同课程", "合同产品", "课程包"],
      organization_id: ["校区"],
      course_hour: ["课时数", "课时"],
    },
    charge_record: {
      course_id: ["课次", "课程", "课程名称"],
      student_id: ["学生", "学员", "学生姓名", "学员姓名"],
      contract_product_id: ["合同课程", "合同产品", "课程包"],
      organization_id: ["校区"],
      charge_type: ["类型", "扣费类型"],
      charge_hour: ["课时", "扣课时"],
      charge_amount: ["金额", "扣费金额"],
    },
    refund_record: {
      student_id: ["学生", "学员", "学生姓名", "学员姓名"],
      contract_product_id: ["合同课程", "合同产品", "课程包"],
      refund_real_hour: ["退课时数", "退课时"],
      refund_real_amount: ["退款金额", "退金额"],
      refund_way_config_id: ["退款方式", "退费方式"],
      refund_time: ["退款时间", "退费时间"],
      remark: ["说明", "备注"],
    },
  };
  return [label, fieldKey, ...(aliases[pageCode]?.[fieldKey] ?? [])].filter(Boolean);
}

function chooseFallbackImportTarget(text: string) {
  const normalized = text.toLowerCase();
  const scored = importPageHints.map((hint) => ({
    hint,
    score: hint.names.reduce((sum, name) => sum + (normalized.includes(name.toLowerCase()) ? 3 : 0), 0)
      + (hint.pageCode === "contract_list" && /报名|签约/.test(text) ? 4 : 0)
      + (hint.pageCode === "funds_history" && /缴费|收款|支付|流水/.test(text) ? 4 : 0)
      + (hint.pageCode === "course_list" && /排课|课程安排|上课|授课|课次/.test(text) ? 4 : 0)
      + (hint.pageCode === "charge_record" && /扣费|课消|消课/.test(text) ? 5 : 0)
      + (hint.pageCode === "refund_record" && /退费|退款/.test(text) ? 5 : 0)
      + (hint.pageCode === "student_list" && /学生名单|学员名单|花名册/.test(text) ? 5 : 0),
  })).sort((a, b) => b.score - a.score || a.hint.order - b.hint.order);
  return scored[0]?.score ? scored[0].hint : importPageHints[0];
}

function buildFallbackFieldMapping(pageCode: string, fields: Array<{ key: string; label?: string; title?: string }>, headers: string[]) {
  const mapping: Record<string, string> = {};
  for (const field of fields) {
    const candidates = headerAliases(pageCode, field.key, String(field.label ?? field.title ?? field.key));
    const header = headers.find((item) => candidates.some((candidate) => item === candidate || item.includes(candidate) || candidate.includes(item)));
    if (header) mapping[field.key] = header;
  }
  return mapping;
}

function fallbackExcelImportPlan(
  attachments: Array<{ id: string; file_name: string; local_path?: string; content_summary: Record<string, unknown> }>,
  targetByPage?: Map<string, { pageCode: string; apiCode: string; order: number; fields: Array<{ key: string; label?: string; title?: string }> }>,
) {
  const items: Array<{
    attachmentId: string; fileName: string; localPath: string | undefined; sheetName: string;
    pageCode: string; apiCode: string; order: number; confidence: number; reason: string; fieldMapping: Record<string, string>;
  }> = [];
  for (const item of attachments) {
    const summary = asObject(item.content_summary);
    const sheets = Array.isArray(summary.sheets) ? summary.sheets.map(asObject) : [summary];
    for (const sheet of sheets) {
      const headers = (Array.isArray(sheet.headers) ? sheet.headers : []).map(String);
      const text = `${item.file_name} ${String(sheet.sheetName ?? "")} ${headers.join(" ")}`;
      const matched = chooseFallbackImportTarget(text);
      const target = targetByPage?.get(matched.pageCode);
      const mapping = target ? buildFallbackFieldMapping(matched.pageCode, target.fields, headers) : {};
      if (Object.keys(mapping).length === 0) continue;
      items.push({
        attachmentId: item.id, fileName: item.file_name, localPath: item.local_path,
        sheetName: String(sheet.sheetName ?? summary.sheetName ?? ""),
        pageCode: matched.pageCode, apiCode: target?.apiCode ?? matched.apiCode,
        order: matched.order, confidence: 0.55, reason: "未能使用 LLM 生成映射，按文件名和表头关键词兜底匹配",
        fieldMapping: mapping,
      });
    }
  }
  return items.sort((a, b) => a.order - b.order);
}

async function buildMappedRows(localPath: string, sheetName: string, fieldMapping: Record<string, string>) {
  const buffer = await fs.readFile(localPath);
  const lower = localPath.toLowerCase();
  const workbook = lower.endsWith(".csv")
    ? XLSX.read(buffer.toString("utf8").replace(/^\uFEFF/, ""), { type: "string" })
    : XLSX.read(buffer, { type: "buffer" });
  const selectedSheetName = sheetName && workbook.Sheets[sheetName] ? sheetName : workbook.SheetNames[0];
  const sheet = workbook.Sheets[selectedSheetName];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "", raw: false });
  if (!Object.keys(fieldMapping).length) return rows;
  return rows.map((row) => {
    const mapped: Record<string, unknown> = {};
    for (const [targetField, sourceHeader] of Object.entries(fieldMapping)) {
      mapped[targetField] = row[sourceHeader] ?? "";
    }
    return mapped;
  });
}

type WriteApi = { apiCode: string; operation: string; pageCode: string; fields: string[] };
type PageActionApi = { apiCode: string; pageCode: string; fields: string[] };

const SYSTEM_WRITE_FIELDS = SYSTEM_WRITE_FIELD_SET;
const OPERATION_LABEL: Record<string, string> = { create: "新增", update: "修改", delete: "删除", command: "业务命令" };

function collectPageActionApis(pageCode: string, dsl: unknown): PageActionApi[] {
  const pageDsl = asObject(dsl);
  const table = asObject(pageDsl.table);
  const actions = [
    ...(Array.isArray(pageDsl.toolbar) ? pageDsl.toolbar : []),
    ...(Array.isArray(table.rowActions) ? table.rowActions : []),
  ];
  const apis: PageActionApi[] = [];
  for (const item of actions) {
    const action = asObject(item);
    const actionType = String(action.type ?? action.actionType ?? "");
    const apiCode = String(action.apiCode ?? (actionType === "execute_api" ? action.actionCode ?? "" : ""));
    if (!apiCode || apiCode.endsWith(".query") || apiCode.endsWith(".detail")) continue;
    const fields = (Array.isArray(action.fields) ? action.fields : [])
      .map((field) => String(asObject(field).key ?? ""))
      .filter((field) => field && !SYSTEM_WRITE_FIELDS.has(field))
      .slice(0, 14);
    apis.push({ apiCode, pageCode, fields });
  }
  return apis;
}

// 从实时 api_dsl 派生当前账号可用的写接口与字段，让新功能/AI 定制新增的字段自动出现在助手知识里
async function loadWriteApiCatalog(schemaName: string, pageCodes: string[]): Promise<WriteApi[]> {
  const pages = [...new Set(pageCodes.filter((p) => /^[a-z][a-z0-9_]{0,62}$/.test(p)))];
  if (pages.length === 0) return [];
  const { rows: pageRows } = await pool.query(
    `select distinct on (page_code) page_code, dsl_json from admin.page_dsl
     where page_code = any($1)
       and status = 'active' and deleted = false
       and ((schema_scope = 'tenant' and schema_name = $2) or (schema_scope = 'tenant' and schema_name = '${TEMPLATE_SCHEMA}'))
     order by page_code, case when schema_scope = 'tenant' then 0 else 1 end`,
    [pages, schemaName]
  );
  const actionApis = pageRows.flatMap((row: { page_code: string; dsl_json: unknown }) =>
    collectPageActionApis(row.page_code, typeof row.dsl_json === "string" ? (() => { try { return JSON.parse(row.dsl_json as string); } catch { return {}; } })() : row.dsl_json)
  );
  const actionApiCodes = [...new Set(actionApis.map((api) => api.apiCode))];
  const likeCodes = pages.map((p) => `${p}.%`);
  const { rows } = await pool.query(
    `select distinct on (api_code) api_code, dsl_json->>'operation' as operation, dsl_json from admin.api_dsl
     where (api_code like any($1) or api_code = any($3))
       and dsl_json->>'operation' in ('create','update','delete','command')
       and status = 'active' and deleted = false
       and ((schema_scope = 'tenant' and schema_name = $2) or (schema_scope = 'tenant' and schema_name = '${TEMPLATE_SCHEMA}'))
     order by api_code, case when schema_scope = 'tenant' and schema_name = $2 then 0 when schema_scope = 'tenant' and schema_name = '${TEMPLATE_SCHEMA}' then 1 else 2 end`,
    [likeCodes, schemaName, actionApiCodes]
  );
  const catalog = rows.map((row: { api_code: string; operation: string; dsl_json: unknown }) => {
    const dsl = asObject(typeof row.dsl_json === "string" ? (() => { try { return JSON.parse(row.dsl_json as string); } catch { return {}; } })() : row.dsl_json);
    const allowed = Array.isArray(dsl.allowedFields) ? dsl.allowedFields.map(String) : [];
    const apiCode = String(row.api_code);
    const actionApi = actionApis.find((api) => api.apiCode === apiCode);
    return {
      apiCode,
      operation: String(row.operation),
      pageCode: actionApi?.pageCode ?? apiCode.replace(/\.[^.]+$/, ""),
      fields: (allowed.length > 0 ? allowed : actionApi?.fields ?? []).filter((f) => !SYSTEM_WRITE_FIELDS.has(f)).slice(0, 14),
    };
  });
  const found = new Set(catalog.map((api) => api.apiCode));
  for (const actionApi of actionApis) {
    if (!found.has(actionApi.apiCode)) {
      catalog.push({ ...actionApi, operation: "command" });
      found.add(actionApi.apiCode);
    }
  }
  return catalog.sort((a: WriteApi, b: WriteApi) => a.apiCode.localeCompare(b.apiCode));
}

function buildSystemPrompt(
  features: Array<{ moduleName: string; featureName: string; pageCode: string }>,
  attachments: Array<Record<string, unknown>>,
  apiCatalog: WriteApi[],
) {
  const apiLines = apiCatalog.length > 0
    ? apiCatalog.map((api) => `- ${api.apiCode}（${OPERATION_LABEL[api.operation] ?? api.operation}）${api.fields.length ? `字段: ${api.fields.join(", ")}` : ""}`)
    : ["（未发现可用写接口，可用 list_features 查看）"];
  return [
    "你是教培系统的 AI 助手。你可以查询数据、解释数据、调用已有业务接口、规划并执行 Excel 导入。",
    "所有数据查询和业务操作必须通过工具完成，工具调用会自动使用当前账号的数据权限。",
    "",
    "## 工具选择规则",
    "1. 查询数据 → 直接调用 query_data，传入 pageCode 和 filters。不要先调用 list_modules 或 list_features。",
    "2. 执行业务操作（新增/修改/删除）→ 直接调用 execute_business_api，传入 pageCode、apiCode 和完整的 params.data。不要先查询再新增，直接新增。",
    "3. list_modules / list_features 仅在用户明确要求列出模块或功能时才调用。",
    "4. 不要连续调用 list_modules → list_features → 目标工具，直接调用目标工具。",
    "5. 新增学员时，直接调用 execute_business_api(pageCode='student_list', apiCode='student_list.create')，不要先查询。",
    "",
    "## 可用业务接口（实时，含定制新增字段）",
    "调用 execute_business_api 时，apiCode 从下表选择，params.data 至少包含对应字段（外键传 ID 或用 *_name_hint）：",
    ...apiLines,
    "",
    "## 业务操作规则",
    "- 如果缺少关键字段，先追问，不要猜测；以上表实时字段为准，不要凭空编造字段。",
    "- 外键字段（如 student_id、organization_id）需要传 ID。如果不知道 ID，先调用 query_data 按名称查询获取 ID。",
    "- 也可以用名称 hint 字段代替 ID：organization_id → organization_name_hint, student_id → student_name_hint, teacher_id → teacher_name_hint, product_ids → product_name_hint。系统会自动将名称解析为 ID。例如：{ organization_name_hint: '全量校长校区', student_name_hint: '张三' }。",
    "- 收款必须带 contract_id；排课必须带 course_date/start_time/end_time/teacher_id/course_hour，由业务命令执行冲突校验。",
    "- 如果 execute_business_api 返回 ok:false，说明参数有误，请根据 error 信息修正后重试。",
    "",
    "## Excel 导入规则",
    "- 用户上传 Excel 并要求导入时，先调用 plan_excel_import 规划导入顺序和字段映射，再调用 execute_excel_import 执行。",
    "- 调用 Excel 工具时 attachmentIds 必须使用下方附件中的 attachmentId 原值，不要使用文件名。",
    "- 如果用户要求只校验，mode=validate；如果要求校验后自动导入，mode=validate_import；如果明确直接导入，mode=import。",
    "- execute_excel_import 返回里若有 failures，必须按 {row, message} 逐条向用户说明失败原因（如缺必填、外键名未找到、枚举非法、重复），并给出具体修正建议，不要只报“失败N行”。",
    "- 如果失败是列映射错误或用户主动纠正某列映射，调用时传 fieldMappingOverrides（如 { student_list: { contact: '手机号码' } }）覆盖后重跑，不要让用户改 Excel。",
    "- 正式导入前若发现疑似重复（如同名学员、重复合同），先提醒用户确认再 import。",
    "",
    "## 跨模块查询规则",
    "- 当用户要求跨模块查询或汇总某学员的完整数据时，必须依次调用 query_data 查询以下所有相关页面：student_list、contract_list、funds_history、course_list、charge_record、refund_record。",
    "- 每次查询使用 name 或 student_name 筛选条件定位该学员的数据。",
    "- 不要省略任何页面，用户要求汇总时必须查询所有相关模块。",
    "",
    "回答中文，短而具体。查询结果只总结关键字段，不要编造不存在的数据。",
    `可访问功能：${features.map((f) => `${f.moduleName}/${f.featureName}(${f.pageCode})`).join("、")}`,
    attachments.length ? `已上传附件：\n${attachments.map((item) => `attachmentId=${item.id}; fileName=${item.file_name}; summary=${JSON.stringify(item.content_summary)}`).join("\n")}` : "",
  ].join("\n");
}

function hasSpreadsheetAttachment(attachments: Array<{ content_summary?: unknown }>) {
  return attachments.some((item) => asObject(item.content_summary).kind === "spreadsheet");
}

function toolStartMessage(name: string, args: Record<string, unknown>): string {
  const pageCode = String(args.pageCode ?? "");
  const apiCode = String(args.apiCode ?? "");
  const filters = args.filters as Record<string, unknown> | undefined;
  switch (name) {
    case "list_modules": return "正在获取业务模块列表…";
    case "list_features": return `正在获取模块 ${pageCode || ""} 的功能页面…`;
    case "query_data": return filters && Object.keys(filters).length > 0 ? `正在查询 ${pageCode} 数据，筛选条件：${Object.entries(filters).map(([k, v]) => `${k}=${v}`).join("、")}` : `正在查询 ${pageCode} 数据…`;
    case "analyze_data": return `正在分析 ${pageCode} 数据…`;
    case "execute_business_api": return apiCode.includes(".create") ? `正在新增 ${pageCode} 数据…` : apiCode.includes(".update") ? `正在更新 ${pageCode} 数据…` : apiCode.includes(".delete") ? `正在删除 ${pageCode} 数据…` : `正在执行 ${apiCode}…`;
    case "plan_excel_import": return "正在识别 Excel 文件结构，规划导入方案…";
    case "execute_excel_import": return `正在${String(args.mode) === "validate" ? "校验" : String(args.mode) === "import" ? "导入" : "校验并导入"} Excel 数据…`;
    case "navigate": return `正在跳转到 ${pageCode}…`;
    default: return `正在执行 ${name}…`;
  }
}

function toolResultMessage(name: string, result: unknown): string {
  const obj = asObject(result);
  if (name === "query_data") {
    const total = Number(obj.total ?? 0);
    return total > 0 ? `查询到 ${total} 条记录` : "未查询到数据";
  }
  if (name === "analyze_data") {
    const groups = Array.isArray(obj.groups) ? obj.groups : [];
    return groups.length > 0 ? `分析完成，共 ${groups.length} 个分组` : "分析完成";
  }
  if (name === "execute_business_api") {
    return obj.ok === false ? `操作失败：${String(obj.error ?? "未知错误")}` : "操作成功";
  }
  if (name === "plan_excel_import") {
    const plan = Array.isArray(obj.plan) ? obj.plan : [];
    return plan.length > 0 ? `识别到 ${plan.length} 个导入项` : "未识别到可导入的内容";
  }
  if (name === "execute_excel_import") {
    const results = Array.isArray(obj.results) ? obj.results : [];
    const total = results.length;
    const failed = results.filter((r: unknown) => Number(asObject(r).failed ?? 0) > 0).length;
    return failed > 0 ? `导入完成，${total} 项中有 ${failed} 项失败` : `导入完成，共 ${total} 项`;
  }
  if (name === "list_modules" || name === "list_features") {
    return "获取完成";
  }
  if (name === "navigate") {
    return "跳转成功";
  }
  return obj.ok === false ? `执行失败：${String(obj.error ?? "未知错误")}` : "执行完成";
}

async function executeExcelImportTool(input: {
  schemaName: string;
  user: SessionUser;
  attachmentIds: string[];
  mode: "validate" | "import" | "validate_import";
  onProgress?: AgentProgressCallback;
}) {
  const executeArgs = { attachmentIds: input.attachmentIds, mode: input.mode };
  await input.onProgress?.({ stage: "tool_start", title: "导入数据", message: toolStartMessage("execute_excel_import", { mode: input.mode }), toolName: "execute_excel_import", status: "running", visibleToTenant: true, createdAt: new Date().toISOString() });
  const result = await runTool({ name: "execute_excel_import", args: executeArgs, schemaName: input.schemaName, user: input.user, attachmentIds: input.attachmentIds });
  await input.onProgress?.({ stage: "tool_result", title: "导入数据", message: toolResultMessage("execute_excel_import", result), toolName: "execute_excel_import", status: "success", visibleToTenant: true, createdAt: new Date().toISOString() });
  return { name: "execute_excel_import", args: executeArgs, result };
}

// 把工具结果压缩到适合回灌给模型的体积：大数组截断、整体长度封顶
function truncateToolResultForModel(result: unknown): string {
  let payload = result;
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const obj: Record<string, unknown> = { ...(result as Record<string, unknown>) };
    for (const key of ["rows", "groups", "plan", "results"]) {
      const arr = obj[key];
      if (Array.isArray(arr) && arr.length > 20) {
        obj[`${key}_omitted`] = arr.length - 20;
        obj[key] = arr.slice(0, 20);
      }
    }
    payload = obj;
  }
  let text = JSON.stringify(payload);
  if (text.length > 6000) text = `${text.slice(0, 6000)}...(已截断，完整结果共 ${text.length} 字符)`;
  return text;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

async function buildHistoryMessages(schemaName: string, history: AssistantMessage[]): Promise<LlmMessage[]> {
  if (history.length === 0) return [];
  const config = await loadLlmConfig(schemaName);
  const tokenBudget = Math.floor(config.maxContextTokens * 0.8);
  const allMessages = history.map((msg) => ({ role: msg.role, content: msg.content }));
  const totalTokens = allMessages.reduce((sum, msg) => sum + estimateTokens(msg.content), 0);
  if (totalTokens <= tokenBudget) {
    return allMessages;
  }
  const KEEP_RECENT = 6;
  const recent = allMessages.slice(-KEEP_RECENT);
  const recentTokens = recent.reduce((sum, msg) => sum + estimateTokens(msg.content), 0);
  const older = allMessages.slice(0, -KEEP_RECENT);
  let summary = "";
  try {
    const result = await callWithToolCalling({
      schemaName,
      messages: [
        { role: "system", content: "把以下教培助手历史对话压缩成简短中文要点，保留：用户目标、已确认的关键实体（学员/合同/校区的名称与ID）、已完成的操作、待办与未决问题。只输出要点列表，不要寒暄。" },
        { role: "user", content: older.map((m) => `${m.role === "user" ? "用户" : "助手"}：${m.content}`).join("\n") },
      ],
    });
    summary = (result.content ?? "").trim();
  } catch {
    summary = "";
  }
  const messages: LlmMessage[] = [];
  if (summary) messages.push({ role: "system", content: `## 历史对话摘要\n${summary}` });
  messages.push(...recent);
  return messages;
}

const MAX_LLM_ROUNDS = 8;

export async function tenantAssistantChat(input: {
  schemaName: string;
  user: SessionUser;
  message: string;
  sessionId?: string;
  attachmentIds?: string[];
  onProgress?: AgentProgressCallback;
  onSummary?: (summary: string) => void | Promise<void>;
  onDelta?: (text: string) => void;
}) {
  const session = await ensureSession(input.schemaName, input.user.userId, input.sessionId);
  const attachmentIds = input.attachmentIds ?? [];
  const attachments = await loadAttachments(attachmentIds, input.schemaName);
  const features = await featureCatalog(input.schemaName, input.user);
  const apiCatalog = await loadWriteApiCatalog(input.schemaName, features.map((f) => f.pageCode));
  const history = (Array.isArray(session.context.messages) ? session.context.messages : []) as AssistantMessage[];
  const historyMessages = await buildHistoryMessages(input.schemaName, history);
  // 顺序：静态/动态系统提示在前（利于前缀缓存）→ 压缩后的历史 → 本轮用户消息
  const messages: LlmMessage[] = [
    { role: "system", content: buildSystemPrompt(features, attachments as unknown as Array<Record<string, unknown>>, apiCatalog) },
    ...historyMessages,
    { role: "user", content: input.message },
  ];

  await input.onProgress?.({ stage: "planning", title: "理解需求", message: "正在判断需要查询、操作还是导入", status: "running", visibleToTenant: true, createdAt: new Date().toISOString() });

  const toolResults: Array<{ name: string; args: Record<string, unknown>; result: unknown }> = [];
  let finalText = "";
  const importMode = requestedImportMode(input.message);

  await runWithLlmTraceContext({ schemaName: input.schemaName, sessionId: session.sessionId, userId: input.user.userId }, async () => {
    for (let i = 0; i < MAX_LLM_ROUNDS; i++) {
      // 流式：工具调用轮不产生文本增量，最终自然语言回复逐字回调 onDelta
      const llm = await callWithToolCalling({ schemaName: input.schemaName, messages, tools: assistantTools, onDelta: input.onDelta });
      const calls = llm.type === "tool_call" ? (llm.functionCalls ?? (llm.functionCall ? [{ id: "call_0", name: llm.functionCall.name, arguments: llm.functionCall.arguments }] : [])) : [];

      if (calls.length > 0) {
        // 原生协议：一条 assistant(tool_calls) + 每个调用一条 role:tool 结果
        messages.push({
          role: "assistant",
          content: llm.content && llm.content.trim() ? llm.content : null,
          tool_calls: calls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: c.arguments } })),
        });

        // 并行执行本轮全部工具调用
        const executed = await Promise.all(calls.map(async (call) => {
          const args = parseToolArgs(call.arguments);
          await input.onProgress?.({ stage: "tool_start", title: "执行操作", message: toolStartMessage(call.name, args), toolName: call.name, status: "running", visibleToTenant: true, createdAt: new Date().toISOString() });
          let result: unknown;
          try {
            result = await runTool({ name: call.name, args, schemaName: input.schemaName, user: input.user, attachmentIds });
          } catch (err) {
            result = { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
          toolResults.push({ name: call.name, args, result });
          const resultObj = asObject(result);
          // 业务导航：把结构化跳转通过进度事件透传给前端
          if (call.name === "navigate" && resultObj.navigate) {
            await input.onProgress?.({ stage: "tool_result", title: "页面跳转", message: `跳转到 ${String(asObject(resultObj.navigate).pageCode ?? "")}`, toolName: "navigate", status: "success", detail: resultObj.navigate, visibleToTenant: true, createdAt: new Date().toISOString() });
          } else {
            await input.onProgress?.({ stage: "tool_result", title: "执行操作", message: toolResultMessage(call.name, result), toolName: call.name, status: (resultObj.ok === false || resultObj.error) ? "failed" : "success", visibleToTenant: true, createdAt: new Date().toISOString() });
          }
          return { call, result };
        }));

        for (const { call, result } of executed) {
          messages.push({ role: "tool", tool_call_id: call.id, content: truncateToolResultForModel(result) });
        }

        // Excel：plan 之后按用户意图自动执行校验/导入
        if (importMode && executed.some((e) => e.call.name === "plan_excel_import") && !toolResults.some((item) => item.name === "execute_excel_import")) {
          const executeMode = importMode === "validate_import" ? "validate_import" : "validate";
          const executeToolResult = await executeExcelImportTool({ schemaName: input.schemaName, user: input.user, attachmentIds, mode: executeMode, onProgress: input.onProgress });
          toolResults.push(executeToolResult);
          messages.push({ role: "user", content: `已自动执行 execute_excel_import，返回：${truncateToolResultForModel(executeToolResult.result)}\n请总结导入结果，如有失败请逐条说明原因和修正建议。` });
        }

        continue;
      }

      finalText = (llm.content ?? "").trim();
      break;
    }
    if (importMode && attachmentIds.length && hasSpreadsheetAttachment(attachments) && !toolResults.some((item) => item.name === "plan_excel_import")) {
      const planArgs = { attachmentIds };
      await input.onProgress?.({ stage: "tool_start", title: "规划导入", message: toolStartMessage("plan_excel_import", {}), toolName: "plan_excel_import", status: "running", visibleToTenant: true, createdAt: new Date().toISOString() });
      const planResult = await runTool({ name: "plan_excel_import", args: planArgs, schemaName: input.schemaName, user: input.user, attachmentIds });
      toolResults.push({ name: "plan_excel_import", args: planArgs, result: planResult });
      await input.onProgress?.({ stage: "tool_result", title: "规划导入", message: toolResultMessage("plan_excel_import", planResult), toolName: "plan_excel_import", status: "success", visibleToTenant: true, createdAt: new Date().toISOString() });
    }
    if (importMode && attachmentIds.length && toolResults.some((item) => item.name === "plan_excel_import") && !toolResults.some((item) => item.name === "execute_excel_import")) {
      const executeMode = importMode === "validate_import" ? "validate_import" : "validate";
      const executeToolResult = await executeExcelImportTool({ schemaName: input.schemaName, user: input.user, attachmentIds, mode: executeMode, onProgress: input.onProgress });
      toolResults.push(executeToolResult);
      finalText = "";
    }
    if (!finalText) {
      const resultText = JSON.stringify(toolResults.map((item) => ({ tool: item.name, result: item.result })));
      try {
        const summary = await callWithToolCalling({
          schemaName: input.schemaName,
          messages: [
            { role: "system", content: "把工具结果整理成简洁中文回复，包含关键数据、导入校验结果或下一步提醒。" },
            { role: "user", content: resultText },
          ],
          onDelta: input.onDelta,
        });
        finalText = summary.content || "已完成处理。";
      } catch {
        finalText = "已完成处理。";
      }
    }
  });

  await input.onSummary?.(finalText);
  const nextMessages = [
    ...history,
    { role: "user", content: input.message, timestamp: new Date().toISOString() },
    { role: "assistant", content: finalText, timestamp: new Date().toISOString() },
  ];
  const previousToolResults = Array.isArray((session.context as Record<string, unknown>).toolResults)
    ? (session.context as Record<string, unknown>).toolResults as unknown[]
    : [];
  await pool.query(
    `update admin.agent_chat_session set context = $1, updated_at = now() where id = $2`,
    [JSON.stringify({ ...session.context, mode: "business_assistant", messages: nextMessages, toolResults: [...previousToolResults, ...toolResults].slice(-30) }), session.sessionId]
  );
  await writeCustomizationRecord({
    schemaName: input.schemaName,
    sessionId: session.sessionId,
    userId: input.user.userId,
    recordType: "assistant",
    chatRound: { userInput: input.message, aiReply: finalText, dslDiff: toolResults, timestamp: new Date().toISOString() },
    changeSummary: toolResults.length ? { type: "assistant", tools: toolResults.map((item) => item.name), summary: finalText } : { type: "assistant", summary: finalText },
  });
  return { sessionId: session.sessionId, reply: finalText, toolResults };
}
