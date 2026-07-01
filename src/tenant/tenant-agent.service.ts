import { randomUUID } from "node:crypto";
import { pool, withClient } from "../db/pool.js";
import { harnessRun } from "../agent/harness-runner.js";
import { publishVersionAndSyncSkillMd, rejectVersion } from "../version/version.service.js";
import { writeCustomizationRecord } from "./tenant-customization-record.service.js";
import { ensureTestSchema, writePreviewDslToTestSchema } from "./test-schema.service.js";
import type { AgentProgressCallback, AgentRunEvent, DslDiff, HarnessResult } from "../agent/types.js";
import { callWithToolCalling } from "../agent/llm.service.js";
import { validateApiDslAgainstSchema } from "../db/dsl-validator.js";
import { loadAttachments } from "./attachment.service.js";
import { dryRunPreviewApis } from "./preview-dry-run.service.js";
import { loadTenantAgentPolicy } from "../agent/tenant-policy.service.js";

function httpError(statusCode: number, message: string) {
  return Object.assign(new Error(message), { statusCode });
}

function isTestSchema(schemaName: string) {
  return schemaName.endsWith("_test");
}

async function validatePreviewDsl(
  schemaName: string,
  diff: { targetType: string; targetCode: string; modifiedDslJson: unknown },
  pendingColumns?: Record<string, string[]>,
) {
  const dsl = diff.modifiedDslJson;
  if (diff.targetType === "skill_registry") {
    if (typeof dsl !== "string" || !dsl.trim()) {
      throw httpError(400, `${diff.targetType}/${diff.targetCode} 预览 skill.md 为空或格式错误`);
    }
    return;
  }
  if (!dsl || typeof dsl !== "object" || Array.isArray(dsl)) {
    throw httpError(400, `${diff.targetType}/${diff.targetCode} 预览 DSL 为空或格式错误`);
  }

  const obj = dsl as Record<string, unknown>;
  if (diff.targetType === "page_dsl") {
    const table = obj.table as Record<string, unknown> | undefined;
    if (!obj.pageCode) throw httpError(400, `${diff.targetCode} 缺少 pageCode`);
    if (!obj.dataApi) throw httpError(400, `${diff.targetCode} 缺少 dataApi`);
    if (!table || !Array.isArray(table.columns)) throw httpError(400, `${diff.targetCode} 缺少 table.columns`);
    if (!obj.layout && !obj.presentation) obj.layout = "list";
  }

  if (diff.targetType === "api_dsl") {
    if (!obj.table) throw httpError(400, `${diff.targetCode} 缺少 table`);
    if (!obj.operation && !obj.queryDsl) throw httpError(400, `${diff.targetCode} 缺少 operation/queryDsl`);
    const problems = await validateApiDslAgainstSchema(schemaName, diff.targetCode, obj, pendingColumns);
    if (problems.length > 0) {
      throw httpError(400, `${diff.targetCode} 字段校验失败：${problems.map((p) => `${p.field ?? ""}${p.problem}`).join("；")}`);
    }
  }

  if (diff.targetType === "action_dsl") {
    const isModalDsl = Boolean(obj.modalCode) && Array.isArray(obj.fields);
    if (!isModalDsl) {
      if (!obj.actionCode) throw httpError(400, `${diff.targetCode} 缺少 actionCode`);
      if (!obj.actionType) throw httpError(400, `${diff.targetCode} 缺少 actionType`);
    }
  }
}

async function checkFeatureEnabled(schemaName: string) {
  if (isTestSchema(schemaName)) throw httpError(403, "预览环境不允许发起 AI 定制，请回到正式租户环境操作");
  const { rows } = await pool.query(
    `select agent_customization_enabled from admin.tenant_agent_config where schema_name = $1 and deleted = false`,
    [schemaName]
  );
  if (!rows[0]?.agent_customization_enabled) throw httpError(403, "AI 定制化功能未开通");
}

async function checkTenantAdmin(user: { kind: string; userId: string; schemaName?: string } | undefined, schemaName: string) {
  if (!user) throw httpError(401, "请先登录");
  if (user.kind === "admin") return;
  const { rows } = await pool.query(
    `select rr.role_id from "${schemaName}".role_resource rr
     join "${schemaName}".user_role ur on ur.role_id = rr.role_id and ur.deleted = false
     join "${schemaName}".role r on r.id = ur.role_id and r.deleted = false
     where ur.user_id = $1 and rr.deleted = false and r.role_code = 'PRINCIPAL' limit 1`,
    [user.userId]
  );
  if (rows.length === 0) throw httpError(403, "仅租户管理员可操作");
}

export async function tenantAgentChat(input: {
  schemaName: string;
  userId: string;
  message: string;
  sessionId?: string;
  attachmentIds?: string[];
  user: { kind: string; userId: string };
  onProgress?: AgentProgressCallback;
  onSummary?: (summary: string) => void | Promise<void>;
}) {
  await checkFeatureEnabled(input.schemaName);
  await checkTenantAdmin(input.user, input.schemaName);

  return withClient(async (client) => {
    let sessionId = input.sessionId;
    let context: Record<string, unknown> = {};

    if (sessionId) {
      const { rows } = await client.query(
        `select id, context from admin.agent_chat_session where id = $1 and schema_name = $2 and user_id = $3 and status = 'active' and deleted = false`,
        [sessionId, input.schemaName, input.userId]
      );
      if (rows[0]) {
        context = (rows[0].context ?? {}) as Record<string, unknown>;
      } else {
        sessionId = undefined;
      }
    }

    if (!sessionId) {
      sessionId = randomUUID();
      await client.query(
        `insert into admin.agent_chat_session(id, schema_name, user_id, context, status) values($1,$2,$3,$4,'active')`,
        [sessionId, input.schemaName, input.userId, JSON.stringify(context)]
      );
    }

    const progressEvents: AgentRunEvent[] = [];
    const onProgress: AgentProgressCallback = async (event) => {
      progressEvents.push(event);
      await input.onProgress?.(event);
    };

    let harnessResult;
    try {
      const chatHistory = buildChatHistory(context);
      const attachments = await loadAttachments(input.attachmentIds ?? [], input.schemaName);
      const messageWithAttachments = buildMessageWithAttachments(input.message, attachments);
      harnessResult = await harnessRun({
        userMessage: messageWithAttachments,
        schemaName: input.schemaName,
        sessionId: sessionId!,
        userId: input.userId,
        chatHistory,
        onProgress,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const existingMessages = (context.messages as Array<{ role: string; content: string; timestamp?: string }>) ?? [];
      existingMessages.push({ role: "user", content: input.message, timestamp: new Date().toISOString() });
      existingMessages.push({ role: "assistant", content: `AI 定制化执行失败：${errMsg}`, timestamp: new Date().toISOString() });
      await client.query(
        `update admin.agent_chat_session set context = $1, updated_at = now() where id = $2`,
        [JSON.stringify({ ...context, lastMessage: input.message, lastReply: `AI 定制化执行失败：${errMsg}`, messages: existingMessages }), sessionId]
      );
      return { sessionId, reply: `AI 定制化执行失败：${errMsg}`, draftInfo: undefined };
    }

    const diffs = harnessResult.validation.data ?? [];
    const executionResults = harnessResult.execution.data ?? [];

    let draftVersionId: string | undefined;
    let draftVersionNo: number | undefined;
    let draftSummary: string | undefined;

    if (executionResults.length > 0) {
      draftVersionId = executionResults[0].versionId;
      draftVersionNo = executionResults[0].versionNo;
      draftSummary = harnessResult.intent.data?.reason ?? harnessResult.requirement.data?.summary;
    }

    if (diffs.length > 0 && draftVersionId) {
      for (const diff of diffs) {
        await client.query(
          `insert into admin.tenant_dsl_change(id, schema_name, dsl_type, dsl_code, change_type, changed_at, source_version_id)
           values($1,$2,$3,$4,'modified',now(),$5)
           on conflict (schema_name, dsl_type, dsl_code) do update set change_type = 'modified', changed_at = now(), source_version_id = $5`,
          [randomUUID(), input.schemaName, diff.targetType, diff.targetCode, draftVersionId]
        );
      }
    }

    let reply: string;
    const hasError = harnessResult.execution.error || harnessResult.validation.error;
    if (hasError) {
      reply = `DSL 变更执行遇到问题：${harnessResult.execution.error || harnessResult.validation.error}`;
    } else if (!harnessResult.requirement.data?.canProceed && (harnessResult.requirement.data?.questions.length ?? 0) > 0) {
      reply = `我已初步理解需求：${harnessResult.requirement.data?.summary ?? "需要补充定制信息"}\n\n为了避免生成错误配置，请先确认：\n${(harnessResult.requirement.data?.questions ?? []).map((q, index) => `${index + 1}. ${q}`).join("\n")}`;
    } else if (diffs.length > 0) {
      const intentData = harnessResult.intent.data;
      reply = `已生成 DSL 变更草稿，涉及 ${diffs.length} 项变更。\n目标功能：${intentData?.featureCode ?? "待确认"}（${intentData?.action === "create" ? "新建" : "修改"}）\n变更内容：${diffs.map((d) => `- ${d.targetType}/${d.targetCode}: ${d.op}${d.field ? ` ${d.field}` : ""}`).join("\n")}`;
    } else if (!harnessResult.intent.data?.featureCode) {
      reply = `未检测到需要变更的 DSL 内容。请尝试更详细地描述需求，例如"在学员列表页面增加地址列和地址筛选"。`;
    } else {
      reply = `未检测到需要变更的 DSL 内容。请尝试更详细地描述需求。`;
    }

    const draftInfo = draftVersionId ? { versionId: draftVersionId, versionNo: draftVersionNo!, summary: draftSummary ?? "", previewed: false } : undefined;
    const tenantSummary = await summarizeTenantReply(input.schemaName, input.message, reply, diffs, draftInfo, {
      intent: harnessResult.intent.data,
      requirement: harnessResult.requirement.data,
      validationError: harnessResult.validation.error,
      executionError: harnessResult.execution.error,
      contextSummary: harnessResult.context.output_summary,
    });
    await input.onSummary?.(tenantSummary);
    reply = tenantSummary;

    const existingMessages = (context.messages as Array<{ role: string; content: string; draftInfo?: unknown; timestamp?: string }>) ?? [];
    existingMessages.push({ role: "user", content: input.message, timestamp: new Date().toISOString() });
    existingMessages.push({ role: "assistant", content: reply, draftInfo, timestamp: new Date().toISOString() });

    const harnessRunMemory = buildHarnessRunMemory(harnessResult, diffs, draftInfo);
    await client.query(
      `update admin.agent_chat_session set context = $1, updated_at = now() where id = $2`,
      [JSON.stringify({ ...context, lastMessage: input.message, lastReply: reply, messages: existingMessages, lastHarnessRun: harnessRunMemory }), sessionId]
    );

    await writeCustomizationRecord({
      schemaName: input.schemaName,
      sessionId: sessionId!,
      userId: input.userId,
      recordType: "customization",
      chatRound: { userInput: input.message, aiReply: reply, dslDiff: diffs, progressEvents, timestamp: new Date().toISOString() },
      changeSummary: draftSummary
        ? `${draftSummary}（${diffs.length}项变更：${diffs.map((d: DslDiff) => `${d.targetType}/${d.targetCode} ${d.op}${d.field ? ` ${d.field}` : ""}`).join("、")}）`
        : undefined,
    });

    return { sessionId, reply, draftInfo };
  });
}

export async function tenantAgentPreview(input: {
  schemaName: string;
  versionId: string;
  user: { kind: string; userId: string };
}) {
  await checkFeatureEnabled(input.schemaName);
  await checkTenantAdmin(input.user, input.schemaName);

  const { rows } = await pool.query(
    `select id, status, snapshot_json, target_type, target_code from admin.dsl_version where id = $1 and schema_scope = 'tenant' and schema_name = $2`,
    [input.versionId, input.schemaName]
  );
  const ver = rows[0];
  if (!ver) throw httpError(404, "版本不存在");
  if (ver.status !== "draft") throw httpError(400, "仅 draft 状态可预览");

  const testSchema = await ensureTestSchema(input.schemaName);

  const { rows: allDrafts } = ver.target_type === "bundle"
    ? { rows: [ver] }
    : await pool.query(
      `select id, target_type, target_code, snapshot_json, diff_json, change_summary from admin.dsl_version
       where schema_scope = 'tenant' and schema_name = $1 and status = 'draft' and deleted = false`,
      [input.schemaName]
    );

  const diffs: Array<{ targetType: string; targetCode: string; op: string; field?: string; fieldDef?: Record<string, unknown>; modifiedDslJson: unknown }> = [];
  for (const draft of allDrafts) {
    if (draft.target_type === "bundle") {
      const bundle = (draft.snapshot_json ?? {}) as { items?: Array<{ targetType: string; targetCode: string; snapshot: Record<string, unknown>; diff?: Record<string, unknown> }> };
      for (const item of bundle.items ?? []) {
        const typeMap: Record<string, string> = { page: "page_dsl", api: "api_dsl", action: "action_dsl", skill: "skill_registry", db_schema: "db_schema", import: "import_dsl", report: "report_dsl", approval_flow: "approval_flow", print_template: "print_template", business_rule: "business_rule", feature: "feature_registry" };
        const modifiedDsl = item.targetType === "skill"
          ? item.snapshot.skill_md_content
          : ["db_schema", "import", "report", "approval_flow", "print_template", "business_rule", "feature"].includes(item.targetType)
            ? item.snapshot.resource_json
            : item.snapshot.dsl_json;
        if (!modifiedDsl) continue;
        const diffMeta = item.diff ?? {};
        diffs.push({
          targetType: typeMap[item.targetType] ?? item.targetType,
          targetCode: item.targetCode,
          op: String(diffMeta.op ?? "modify"),
          field: diffMeta.field ? String(diffMeta.field) : undefined,
          fieldDef: diffMeta.fieldDef as Record<string, unknown> | undefined,
          modifiedDslJson: modifiedDsl,
        });
      }
      continue;
    }
    const snapshot = (draft.snapshot_json ?? {}) as Record<string, unknown>;
    let modifiedDsl = snapshot.dsl_json;
    if (modifiedDsl && typeof modifiedDsl === "object" && !Array.isArray(modifiedDsl)) {
      const keys = Object.keys(modifiedDsl as Record<string, unknown>);
      if (keys.length === 1 && keys[0] === draft.target_code) {
        modifiedDsl = (modifiedDsl as Record<string, unknown>)[keys[0]];
      }
    }
    const diffMeta = (draft.diff_json ?? {}) as Record<string, unknown>;
    if (modifiedDsl) {
        const typeMap: Record<string, string> = { page: "page_dsl", api: "api_dsl", action: "action_dsl", skill: "skill_registry", db_schema: "db_schema", import: "import_dsl", report: "report_dsl", approval_flow: "approval_flow", print_template: "print_template", business_rule: "business_rule", feature: "feature_registry" };
      diffs.push({
        targetType: typeMap[draft.target_type] ?? draft.target_type,
        targetCode: draft.target_code,
        op: String(diffMeta.op ?? "modify"),
        field: diffMeta.field ? String(diffMeta.field) : undefined,
        fieldDef: diffMeta.fieldDef as Record<string, unknown> | undefined,
        modifiedDslJson: modifiedDsl,
      });
    }
  }

  const supplementedDiffs = await supplementPreviewDiffs(input.schemaName, diffs);
  const pendingColumns = collectPendingColumns(supplementedDiffs);
  if (diffs.length > 0) {
    for (const diff of supplementedDiffs) await validatePreviewDsl(testSchema, diff, pendingColumns);
    await writePreviewDslToTestSchema(input.schemaName, supplementedDiffs);
  }
  const dryRun = await dryRunPreviewApis({ testSchema, diffs: supplementedDiffs, user: input.user });
  if (!dryRun.ok) {
    const failed = dryRun.checks.filter((check) => !check.ok).map((check) => `${check.apiCode}: ${check.message}`).join("；");
    throw httpError(400, `预览运行校验失败：${failed}`);
  }

  const previewId = randomUUID();
  await pool.query(
    `insert into admin.dsl_version_preview(id, version_id, schema_name, preview_data) values($1,$2,$3,$4)`,
    [previewId, input.versionId, input.schemaName, JSON.stringify({ testSchema, diffs: supplementedDiffs, dryRun })]
  );

  return {
    previewId,
    previewedAt: new Date().toISOString(),
    testSchema,
    previewUrl: `/${testSchema}/app`,
  };
}

export async function tenantAgentPublish(input: {
  schemaName: string;
  versionId: string;
  user: { kind: string; userId: string };
}) {
  await checkFeatureEnabled(input.schemaName);
  await checkTenantAdmin(input.user, input.schemaName);
  const policy = await loadTenantAgentPolicy(input.schemaName);

  const { rows: previewRows } = await pool.query(
    `select id, preview_data from admin.dsl_version_preview where version_id = $1 order by previewed_at desc limit 1`,
    [input.versionId]
  );
  if (policy.publishPolicy.requirePreview && previewRows.length === 0) throw httpError(400, "请先预览变更效果后再发布");
  const dryRun = previewRows[0]?.preview_data?.dryRun;
  if (dryRun && dryRun.ok === false) throw httpError(400, "预览运行校验未通过，不能发布");

  const result = await publishVersionAndSyncSkillMd(input.versionId, input.user.userId);
  return { published: true, versionId: input.versionId, ...result };
}

function collectPendingColumns(diffs: Array<{ targetType: string; targetCode: string; modifiedDslJson: unknown }>) {
  const result: Record<string, string[]> = {};
  for (const diff of diffs) {
    if (diff.targetType !== "db_schema" || !diff.modifiedDslJson || typeof diff.modifiedDslJson !== "object" || Array.isArray(diff.modifiedDslJson)) continue;
    const resource = diff.modifiedDslJson as Record<string, unknown>;
    const tableName = String(resource.tableName ?? diff.targetCode ?? "");
    const fields = Array.isArray(resource.fields) ? resource.fields as Array<Record<string, unknown>> : [];
    if (!tableName) continue;
    result[tableName] ??= [];
    for (const field of fields) {
      const key = String(field.key ?? "");
      if (key && !result[tableName].includes(key)) result[tableName].push(key);
    }
  }
  return result;
}

export async function tenantAgentReject(input: {
  schemaName: string;
  versionId: string;
  reason?: string;
  user: { kind: string; userId: string };
}) {
  await checkFeatureEnabled(input.schemaName);
  await checkTenantAdmin(input.user, input.schemaName);
  const { rows } = await pool.query(
    `select id from admin.dsl_version where id = $1 and schema_scope = 'tenant' and schema_name = $2 and status = 'draft' and deleted = false`,
    [input.versionId, input.schemaName]
  );
  if (!rows[0]) throw httpError(404, "草稿版本不存在或已处理");
  return rejectVersion(input.versionId, input.reason ?? "租户驳回", input.user.userId);
}

export async function listTenantDrafts(schemaName: string, user: { kind: string; userId: string; schemaName?: string }) {
  await checkTenantAdmin(user, schemaName);

  const { rows } = await pool.query(
    `select v.id, v.version_no, v.target_type, v.target_code, v.change_summary, v.created_at,
            exists(select 1 from admin.dsl_version_preview p where p.version_id = v.id) as previewed
     from admin.dsl_version v where v.schema_scope = 'tenant' and v.schema_name = $1 and v.status = 'draft' and v.deleted = false
     order by created_at desc`,
    [schemaName]
  );
  return {
    drafts: rows.map((row) => ({
      versionId: row.id,
      versionNo: Number(row.version_no),
      summary: row.change_summary ?? `${row.target_type}/${row.target_code}`,
      previewed: Boolean(row.previewed),
    })),
  };
}

async function summarizeTenantReply(
  schemaName: string,
  userMessage: string,
  fallbackReply: string,
  diffs: DslDiff[],
  draftInfo?: { versionId: string; versionNo: number; summary: string; previewed: boolean },
  runSummary?: Record<string, unknown>,
) {
  if (!draftInfo && diffs.length === 0) return fallbackReply;
  const diffSummary = diffs.map((diff) => ({
    targetType: diff.targetType,
    targetCode: diff.targetCode,
    op: diff.op,
    field: diff.field ?? diff.fieldDef?.key ?? diff.fieldDef?.field,
  }));

  try {
    const result = await callWithToolCalling({
      schemaName,
      messages: [
        {
          role: "system",
          content: [
            "你是教务系统 AI 定制助手，负责把本次自动定制结果回复给租户用户。",
            "回复必须是自然、具体的中文，不要出现 page_dsl、api_dsl、DSL、targetType、字段编码等技术词。",
            "如果已经生成草稿，说明创建或修改了什么、用户能看到什么，并提醒先预览确认再发布。",
            "如果需要用户补充，直接提出需要确认的问题，不要说系统内部校验或工具细节。",
            "如果失败，简洁说明卡在哪个业务口径或配置问题，并说明会根据错误继续修正或需要用户补充什么。",
            "最多 4 句话。",
          ].join("\n"),
        },
        {
          role: "user",
          content: JSON.stringify({ userMessage, fallbackReply, diffSummary, draftInfo, runSummary }, null, 2),
        },
      ],
    });
    const content = (result.content ?? "").trim();
    if (content) return content.substring(0, 500);
  } catch (err) {
    console.warn("[TenantAgent] summary llm failed:", err instanceof Error ? err.message : String(err));
  }

  const fieldLabels = diffSummary
    .map((item) => String(item.field ?? ""))
    .filter(Boolean);
  if (fieldLabels.length > 0) {
    return `已按你的需求生成定制草稿，涉及 ${[...new Set(fieldLabels)].join("、")} 等内容。请先点击预览确认页面展示、编辑保存和筛选效果，确认无误后再发布。`;
  }
  return "已按你的需求生成定制草稿。请先点击预览确认效果，确认无误后再发布。";
}

async function supplementPreviewDiffs(
  schemaName: string,
  diffs: Array<{ targetType: string; targetCode: string; op: string; field?: string; fieldDef?: Record<string, unknown>; modifiedDslJson: unknown }>
) {
  const result = [...diffs];
  const byTarget = new Map(result.map((diff) => [`${diff.targetType}:${diff.targetCode}`, diff]));
  const pageDiffs = result.filter((diff) => diff.targetType === "page_dsl" && diff.modifiedDslJson && typeof diff.modifiedDslJson === "object");

  for (const pageDiff of pageDiffs) {
    const pageDsl = pageDiff.modifiedDslJson as Record<string, unknown>;
    const pageCode = String(pageDsl.pageCode ?? pageDiff.targetCode);
    const modalFields = ((pageDsl.modal as Record<string, unknown> | undefined)?.fields as Array<Record<string, unknown>> | undefined) ?? [];
    const tableColumns = (((pageDsl.table as Record<string, unknown> | undefined)?.columns as Array<Record<string, unknown>> | undefined) ?? []);
    const filterFields = (pageDsl.filters as Array<Record<string, unknown>> | undefined) ?? [];
    const fields = new Set<string>();
    const queryFields = new Set<string>();
    const fieldDefs = new Map<string, Record<string, unknown>>();
    for (const field of tableColumns) {
      const key = field.key ? String(field.key) : "";
      if (key && key !== "id") queryFields.add(key);
    }
    for (const field of modalFields) {
      const key = field.key ? String(field.key) : "";
      if (key && key !== "id") {
        fields.add(key);
        fieldDefs.set(key, field);
      }
    }
    for (const field of filterFields) {
      const key = field.key ? String(field.key) : "";
      const physicalField = field.field ? String(field.field) : key.replace(/_range$/, "").replace(/_filter$/, "");
      if (physicalField && physicalField !== "id") {
        fields.add(physicalField);
        queryFields.add(physicalField);
        fieldDefs.set(key, field);
      }
    }

    for (const suffix of ["detail", "create", "update"]) {
      const key = `api_dsl:${pageCode}.${suffix}`;
      const apiDiff = byTarget.get(key);
      if (!apiDiff || !apiDiff.modifiedDslJson || typeof apiDiff.modifiedDslJson !== "object") continue;
      const apiDsl = { ...(apiDiff.modifiedDslJson as Record<string, unknown>) };
      const allowedFields = new Set((apiDsl.allowedFields as string[] | undefined) ?? []);
      for (const field of fields) allowedFields.add(field);
      apiDiff.modifiedDslJson = { ...apiDsl, allowedFields: [...allowedFields] };
    }

    const queryKey = `api_dsl:${pageCode}.query`;
    const queryDiff = byTarget.get(queryKey);
    if (queryDiff && queryDiff.modifiedDslJson && typeof queryDiff.modifiedDslJson === "object") {
      const queryDsl = { ...(queryDiff.modifiedDslJson as Record<string, unknown>) };
      const rawFilters = Array.isArray(queryDsl.filters) ? queryDsl.filters : [];
      const filterObjects: Array<Record<string, unknown>> = rawFilters
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
        .map((item) => ({ ...item }));
      const filters = new Set(rawFilters.filter((item): item is string => typeof item === "string"));
      const allowedFields = new Set((queryDsl.allowedFields as string[] | undefined) ?? []);
      for (const field of filterFields) {
        const key = field.key ? String(field.key) : "";
        const physicalField = field.field ? String(field.field) : key.replace(/_range$/, "").replace(/_filter$/, "");
        if (!physicalField) continue;
        const existingObject = filterObjects.some((item) => item.field === physicalField || item.key === key);
        if (existingObject) continue;
        if (field.field || key.endsWith("_range") || key.endsWith("_filter")) {
          filterObjects.push({ ...field, field: physicalField, key: key || physicalField });
        } else {
          filters.add(physicalField);
        }
      }
      for (const field of queryFields) allowedFields.add(field);
      queryDiff.modifiedDslJson = { ...queryDsl, filters: [...filterObjects, ...filters], allowedFields: [...allowedFields] };
    }

    const modalCodes = await loadPageModalCodes(pageCode, schemaName);
    for (const modalCode of modalCodes) {
      const key = `action_dsl:${modalCode}`;
      let modalDiff = byTarget.get(key);
      if (!modalDiff) {
        const modalDsl = await loadExistingActionDsl(modalCode, schemaName);
        if (!modalDsl) continue;
        modalDiff = {
          targetType: "action_dsl",
          targetCode: modalCode,
          op: "modify",
          modifiedDslJson: modalDsl,
        };
        result.push(modalDiff);
        byTarget.set(key, modalDiff);
      }
      if (!modalDiff.modifiedDslJson || typeof modalDiff.modifiedDslJson !== "object") continue;
      const modalDsl = { ...(modalDiff.modifiedDslJson as Record<string, unknown>) };
      const existingFields = Array.isArray(modalDsl.fields) ? [...modalDsl.fields as Array<Record<string, unknown>>] : [];
      const existingKeys = new Set(existingFields.map((field) => String(field.key ?? "")));
      for (const field of fields) {
        if (existingKeys.has(field)) continue;
        existingFields.push(normalizePreviewModalField(fieldDefs.get(field), field));
        existingKeys.add(field);
      }
      modalDiff.modifiedDslJson = { ...modalDsl, fields: existingFields };
    }
  }

  return result;
}

async function loadPageModalCodes(pageCode: string, schemaName: string) {
  const { rows } = await pool.query(
    `SELECT dsl_json FROM admin.action_dsl
     WHERE page_code = $1 AND action_type = 'open_modal' AND status = 'active' AND deleted = false
       AND ((schema_scope = 'tenant' AND schema_name = $2) OR (schema_scope = 'tenant' AND schema_name = 'demo_school'))
     ORDER BY CASE WHEN schema_scope = 'tenant' THEN 0 ELSE 1 END`,
    [pageCode, schemaName]
  );
  const modalCodes = new Set<string>();
  for (const row of rows) {
    const dsl = row.dsl_json as Record<string, unknown> | undefined;
    const actionCode = String(dsl?.actionCode ?? "");
    if (!/\.(create|edit|detail)$/.test(actionCode)) continue;
    const modalCode = String(dsl?.modalCode ?? "");
    if (modalCode) modalCodes.add(modalCode);
  }
  return [...modalCodes];
}

async function loadExistingActionDsl(actionCode: string, schemaName: string) {
  const { rows } = await pool.query(
    `SELECT dsl_json FROM admin.action_dsl
     WHERE action_code = $1 AND status = 'active' AND deleted = false
       AND ((schema_scope = 'tenant' AND schema_name = $2) OR (schema_scope = 'tenant' AND schema_name = 'demo_school'))
     ORDER BY CASE WHEN schema_scope = 'tenant' THEN 0 ELSE 1 END LIMIT 1`,
    [actionCode, schemaName]
  );
  return rows[0]?.dsl_json as Record<string, unknown> | undefined;
}

function normalizePreviewModalField(fieldDef: Record<string, unknown> | undefined, field: string) {
  return {
    ...(fieldDef ?? {}),
    key: field,
    label: fieldDef?.label ?? field,
    type: fieldDef?.type ?? "text",
  };
}

export async function getActiveChatSession(schemaName: string, userId: string, sessionId?: string) {
  const { rows } = await pool.query(
    `select id, context, created_at, updated_at from admin.agent_chat_session
     where schema_name = $1 and user_id = $2 and status = 'active' and deleted = false
       and ($3::text is null or id = $3)
     order by updated_at desc limit 1`,
    [schemaName, userId, sessionId || null]
  );
  const row = rows[0];
  if (!row) return { sessionId: "", messages: [] };
  const context = (row.context ?? {}) as Record<string, unknown>;
  const rawMessages = Array.isArray(context.messages) ? context.messages : [];
  return {
    sessionId: row.id,
    messages: rawMessages
      .filter((msg): msg is { role: string; content: string; draftInfo?: unknown; timestamp?: string } =>
        typeof msg === "object" && msg !== null && typeof (msg as Record<string, unknown>).role === "string" && typeof (msg as Record<string, unknown>).content === "string"
      )
      .map((msg) => ({
        role: msg.role,
        content: msg.content,
        draftInfo: msg.draftInfo,
        timestamp: msg.timestamp ?? row.updated_at ?? row.created_at,
      })),
  };
}

function buildChatHistory(context: Record<string, unknown>): Array<{ role: string; content: string }> {
  const history: Array<{ role: string; content: string }> = [];
  const lastHarnessRun = context.lastHarnessRun;
  if (lastHarnessRun && typeof lastHarnessRun === "object" && !Array.isArray(lastHarnessRun)) {
    history.push({
      role: "assistant",
      content: `上一次 AI 定制运行摘要：${JSON.stringify(lastHarnessRun).substring(0, 1200)}`,
    });
  }
  const messages = context.messages as Array<{ role: string; content: string }> | undefined;
  if (Array.isArray(messages)) {
    for (const msg of messages) {
      if (msg.role && msg.content) {
        history.push({ role: msg.role, content: msg.content });
      }
    }
  } else {
    if (context.lastMessage) {
      history.push({ role: "user", content: String(context.lastMessage) });
    }
    if (context.lastReply) {
      history.push({ role: "assistant", content: String(context.lastReply) });
    }
  }
  return history;
}

function buildHarnessRunMemory(
  harnessResult: HarnessResult,
  diffs: DslDiff[],
  draftInfo?: { versionId: string; versionNo: number; summary: string; previewed: boolean },
) {
  return {
    intent: harnessResult.intent.data
      ? {
          featureCode: harnessResult.intent.data.featureCode,
          action: harnessResult.intent.data.action,
          reason: harnessResult.intent.data.reason,
          moduleCode: harnessResult.intent.data.moduleCode,
        }
      : undefined,
    requirement: harnessResult.requirement.data
      ? {
          summary: harnessResult.requirement.data.summary,
          canProceed: harnessResult.requirement.data.canProceed,
          questions: harnessResult.requirement.data.questions,
          capabilities: harnessResult.requirement.data.capabilities.map((item) => ({
            type: item.type,
            label: item.label,
            risk: item.risk,
          })),
        }
      : undefined,
    context: {
      related: harnessResult.context.data?.relevantDslCodes ?? [],
      tokenEstimate: harnessResult.context.data?.tokenEstimate ?? 0,
      summary: harnessResult.context.output_summary,
    },
    diffs: diffs.slice(0, 20).map((diff) => ({
      targetType: diff.targetType,
      targetCode: diff.targetCode,
      op: diff.op,
      field: diff.field ?? diff.fieldDef?.key ?? diff.fieldDef?.field,
    })),
    validationError: harnessResult.validation.error,
    executionError: harnessResult.execution.error,
    draftInfo,
    totalDuration_ms: harnessResult.totalDuration_ms,
  };
}

function buildMessageWithAttachments(
  message: string,
  attachments: Array<{ id: string; file_name: string; mime_type: string; storage_url: string; content_summary: Record<string, unknown> }>,
) {
  if (attachments.length === 0) return message;
  const lines = attachments.map((item, index) => {
    const summary = item.content_summary ?? {};
    const headers = Array.isArray(summary.headers) ? summary.headers.join("、") : "";
    const sampleRows = Array.isArray(summary.sampleRows) ? JSON.stringify(summary.sampleRows).slice(0, 800) : "";
    if (item.mime_type.startsWith("image/")) {
      return `附件${index + 1}：图片 ${item.file_name}，临时URL=${item.storage_url}。请参考图片中的布局、字段分组、列表/表单结构来生成 DSL；如果当前模型不能直接识别图片，请根据用户文字补充说明继续。`;
    }
    if (summary.kind === "spreadsheet") {
      return `附件${index + 1}：Excel/CSV ${item.file_name}，表头=[${headers}]，行数=${summary.rowCount ?? 0}，样例=${sampleRows}。如果用户要求导入，请根据表头生成 import_dsl.fields；涉及 *_id 字段时，模板应使用名称列并在导入时解析为 id。`;
    }
    return `附件${index + 1}：${item.file_name}，类型=${item.mime_type}，URL=${item.storage_url}`;
  });
  return `${message}\n\n## 用户上传附件\n${lines.join("\n")}`;
}
