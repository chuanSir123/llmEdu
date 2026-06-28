import path from "node:path";
import { createReadStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import statik from "@fastify/static";
import Fastify from "fastify";
import { z } from "zod";
import { env } from "./config/env.js";
import { adminLogin, listTenants, tenantLogin, logout, isTokenRevoked, getUserPermissions } from "./auth/auth.service.js";
import { resolveTenantSchema } from "./db/schema-resolver.js";
import { pool } from "./db/pool.js";
import { seed } from "./seed/run.js";
import { loadAdminMenu, loadTenantMenu } from "./gateway/menu.service.js";
import { loadPageFullDsl } from "./gateway/page.service.js";
import { executeGatewayApi } from "./gateway/api-executor.js";
import { executeAction } from "./gateway/action-executor.js";
import { canAccessPage, listManagementOrganizations } from "./permission/permission.service.js";
import { publishVersion, publishVersionAndSyncSkillMd, rollbackVersion, rejectVersion, initializeTenantVersion, listTenantVersions, tenantRollbackVersion } from "./version/version.service.js";
import { tenantAgentChat, tenantAgentPreview, tenantAgentPublish, tenantAgentReject, listTenantDrafts, getActiveChatSession } from "./tenant/tenant-agent.service.js";
import { tenantAssistantChat } from "./tenant/tenant-assistant.service.js";
import { saveAgentAttachment, loadAttachment } from "./tenant/attachment.service.js";
import { buildImportTemplate, executeTenantImport, resolveTenantImportConfig } from "./tenant/import.service.js";
import { rollbackTestSchemaDsl } from "./tenant/test-schema.service.js";
import { syncSkillMd, fillEmptySkillMd } from "./agent/skill-md.service.js";
import { loadModuleSelectionTree, createTenantWithModules } from "./tenant/tenant-create.service.js";
import { rechargeTenant, listRechargeRecords } from "./tenant/tenant-recharge.service.js";
import { listCustomizationRecords, getCustomizationRecordDetail } from "./tenant/tenant-customization-record.service.js";
import { listTenantDslChanges, previewCopyToTemplate, executeCopyToTemplate } from "./tenant/tenant-copy-template.service.js";
import type { AuthedRequest, SessionUser } from "./types.js";
import { bindWechatOpenid, completeWechatAuthorization, completeWechatOauth, claimCoupon, createMallOrder, createWechatOauthLoginUrl, handleMallPayCallback, listAvailableCoupons, loadWechatPortal, processWechatComponentCallback, queryMallOrderStatus, reconcileMallOrder, submitLandingLead } from "./marketing.service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

async function audit(input: {
  schemaName?: string;
  userId?: string;
  pageCode?: string;
  apiCode?: string;
  actionCode?: string;
  inputSummary?: unknown;
  outputSummary?: unknown;
  costMs: number;
  error?: string;
}) {
  await pool.query(
    `insert into admin.audit_log(id, schema_name, user_id, page_code, api_code, action_code, input_summary, output_summary, cost_ms, error)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      randomUUID(),
      input.schemaName ?? null,
      input.userId ?? null,
      input.pageCode ?? null,
      input.apiCode ?? null,
      input.actionCode ?? null,
      JSON.stringify(input.inputSummary ?? {}),
      JSON.stringify(input.outputSummary ?? {}),
      input.costMs,
      input.error ?? null
    ]
  );
}

function httpError(statusCode: number, message: string) {
  return Object.assign(new Error(message), { statusCode });
}

function isTestSchema(schemaName?: string) {
  return Boolean(schemaName && schemaName.endsWith("_test"));
}

function assertNotTestCustomizationSchema(schemaName: string) {
  if (isTestSchema(schemaName)) {
    throw httpError(403, "预览环境不允许发起 AI 定制，请回到正式租户环境操作");
  }
}

function harnessStepDisplayName(stepName: string) {
  const map: Record<string, string> = {
    intent_classification: "识别需求范围",
    context_injection: "读取当前配置",
    requirement_planning: "整理定制计划",
    change_planning: "生成变更方案",
    validation_repair: "校验并修正方案",
    execute_preview: "生成预览草稿",
  };
  return map[stepName] ?? stepName;
}

function harnessStepTenantSummary(stepName: string, outputSummary?: string | null) {
  const output = outputSummary ?? "";
  if (output.startsWith("error:") || output.startsWith("failed")) return `执行失败：${output.replace(/^error:\s*/, "")}`;
  if (stepName === "intent_classification") {
    const feature = output.match(/featureCode=([^\s]+)/)?.[1];
    return feature ? `已定位到功能：${feature}` : "已尝试定位要修改的功能";
  }
  if (stepName === "context_injection") return "已读取页面、接口、字段和租户配置";
  if (stepName === "requirement_planning") return output.includes("canProceed=false") ? "已整理需求，但需要补充确认信息" : "已整理出可执行的定制计划";
  if (stepName === "change_planning") {
    const count = output.match(/diffs_count=(\d+)/)?.[1];
    return count ? `已生成 ${count} 项配置变更` : "已生成配置变更方案";
  }
  if (stepName === "validation_repair") return output.includes("校验通过") ? output : "已完成配置校验";
  if (stepName === "execute_preview") return output.includes("created") ? "已生成可预览的草稿版本" : "已准备预览草稿";
  return output || "已完成";
}

function currentUser(req: unknown) {
  return (req as AuthedRequest).user as SessionUser | undefined;
}

async function resolveAuthorizedTenantSchema(user: SessionUser | undefined, requestedSchemaName?: string) {
  if (!user) throw httpError(401, "请先登录");
  const schemaName = requestedSchemaName || user.schemaName || "";
  const schema = await resolveTenantSchema(schemaName);
  if (user.kind === "tenant" && user.schemaName !== schema) {
    const ownPreviewSchema = user.schemaName ? `${user.schemaName}_test` : "";
    if (schema !== ownPreviewSchema) {
      throw httpError(403, "不能访问其他租户数据");
    }
  }
  return schema;
}

export async function buildServer() {
  if (env.autoSeed) await seed();

  const app = Fastify({ logger: true, bodyLimit: 50 * 1024 * 1024 });
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    const rawBody = typeof body === "string" ? body : body.toString("utf8");
    (request as typeof request & { rawBody?: string }).rawBody = rawBody;
    try { done(null, rawBody ? JSON.parse(rawBody) : {}); } catch (error) { done(error as Error); }
  });
  app.addContentTypeParser(["text/xml", "application/xml"], { parseAs: "string" }, (request, body, done) => {
    const rawBody = typeof body === "string" ? body : body.toString("utf8");
    (request as typeof request & { rawBody?: string }).rawBody = rawBody;
    done(null, rawBody);
  });
  await app.register(cors, { origin: true });
  await app.register(jwt, { secret: env.jwtSecret });

  app.decorate("authenticate", async (request: AuthedRequest) => {
    try {
      request.user = await request.jwtVerify<SessionUser>();
      if (request.user?.kind === "tenant" && request.user.schemaName) {
        const currentManagementOrganizationId = request.headers["x-management-organization-id"];
        if (typeof currentManagementOrganizationId === "string" && currentManagementOrganizationId.trim()) {
          request.user.currentManagementOrganizationId = currentManagementOrganizationId.trim();
        }
        const token = request.headers.authorization?.replace("Bearer ", "") ?? "";
        const revoked = await isTokenRevoked(request.user.schemaName, token);
        if (revoked) throw httpError(401, "登录已过期");
      }
    } catch {
      throw httpError(401, "请先登录");
    }
  });

  app.get("/api/health", async () => ({ ok: true, service: "llmEdu", time: new Date().toISOString() }));
  app.get("/api/public/tenants", async () => ({ tenants: await listTenants() }));


  app.get("/api/wechat/oauth/login-url", async (request) => {
    const query = z.object({ schemaName: z.string(), redirect: z.string().optional(), bindingId: z.string().optional(), scope: z.string().optional() }).parse(request.query);
    const schema = await resolveTenantSchema(query.schemaName);
    return createWechatOauthLoginUrl(schema, { binding_id: query.bindingId, final_redirect: query.redirect ?? `/${query.schemaName}/wx/home`, scope: query.scope });
  });

  app.get("/api/wechat/oauth/callback", async (request, reply) => {
    const query = z.object({ code: z.string(), state: z.string() }).parse(request.query);
    const state = JSON.parse(Buffer.from(query.state, "base64url").toString("utf8"));
    const schema = await resolveTenantSchema(String(state.schemaName));
    const oauth = await completeWechatOauth(schema, { code: query.code, binding_id: state.bindingId, state: query.state });
    const target = String(state.redirect ?? `/${state.schemaName}/wx/home`);
    const tokenParam = `sessionToken=${encodeURIComponent(String(oauth.sessionToken))}`;
    return reply.redirect(target.includes("?") ? `${target}&${tokenParam}` : `${target}?${tokenParam}`);
  });

  app.post("/api/wechat/openid/bind", async (request) => {
    const body = z.object({ schemaName: z.string(), sessionToken: z.string(), studentId: z.string(), studentName: z.string().optional(), phoneLast4: z.string().optional(), verifyCode: z.string().optional() }).parse(request.body);
    const schema = await resolveTenantSchema(body.schemaName);
    return bindWechatOpenid(schema, { session_token: body.sessionToken, student_id: body.studentId, student_name: body.studentName, phone_last4: body.phoneLast4, verify_code: body.verifyCode });
  });

  app.get("/api/wechat/portal", async (request) => {
    const query = z.object({ schemaName: z.string(), sessionToken: z.string().optional() }).parse(request.query);
    const schema = await resolveTenantSchema(query.schemaName);
    return loadWechatPortal(schema, query.sessionToken);
  });


  app.post("/api/wechat/component/callback", async (request) => {
    const query = z.object({ component_appid: z.string().optional(), appid: z.string().optional(), timestamp: z.string(), nonce: z.string(), msg_signature: z.string().optional(), signature: z.string().optional() }).parse(request.query);
    return processWechatComponentCallback({ ...query, raw_xml: (request as typeof request & { rawBody?: string }).rawBody ?? String(request.body ?? "") });
  });

  app.get("/api/wechat/authorizer/callback", async (request) => {
    const query = z.object({ schemaName: z.string(), bindingId: z.string(), auth_code: z.string().optional(), authorization_code: z.string().optional(), expires_in: z.string().optional() }).parse(request.query);
    const schema = await resolveTenantSchema(query.schemaName);
    return completeWechatAuthorization(schema, { bindingId: query.bindingId, auth_code: query.auth_code ?? query.authorization_code, expires_in: query.expires_in });
  });

  app.post("/api/wechat/landing/lead", async (request) => {
    const body = z.object({ schemaName: z.string(), pageId: z.string(), name: z.string(), contact: z.string(), schoolName: z.string().optional(), grade: z.string().optional(), channelId: z.string().optional(), referrerStudentId: z.string().optional(), formData: z.record(z.string(), z.unknown()).optional() }).parse(request.body);
    const schema = await resolveTenantSchema(body.schemaName);
    return submitLandingLead(schema, { page_id: body.pageId, name: body.name, contact: body.contact, school_name: body.schoolName, grade: body.grade, channel_id: body.channelId, referrer_student_id: body.referrerStudentId, form_data: body.formData ?? {} });
  });

  app.get("/api/wechat/coupons", async (request) => {
    const query = z.object({ schemaName: z.string(), sessionToken: z.string(), goodsId: z.string().optional(), activityId: z.string().optional(), amount: z.coerce.number().optional() }).parse(request.query);
    const schema = await resolveTenantSchema(query.schemaName);
    return listAvailableCoupons(schema, { session_token: query.sessionToken, goods_id: query.goodsId, activity_id: query.activityId, amount: query.amount });
  });

  app.post("/api/wechat/coupon/claim", async (request) => {
    const body = z.object({ schemaName: z.string(), sessionToken: z.string(), couponTemplateId: z.string() }).parse(request.body);
    const schema = await resolveTenantSchema(body.schemaName);
    return claimCoupon(schema, { session_token: body.sessionToken, coupon_template_id: body.couponTemplateId, source: "wechat_portal" });
  });

  app.post("/api/wechat/mall/order", async (request) => {
    const body = z.object({ schemaName: z.string(), sessionToken: z.string(), goodsId: z.string(), quantity: z.number().optional(), activityId: z.string().optional(), groupId: z.string().optional(), couponClaimId: z.string().optional(), couponCode: z.string().optional() }).parse(request.body);
    const schema = await resolveTenantSchema(body.schemaName);
    return createMallOrder(schema, { session_token: body.sessionToken, goods_id: body.goodsId, quantity: body.quantity ?? 1, activity_id: body.activityId, group_id: body.groupId, coupon_claim_id: body.couponClaimId, coupon_code: body.couponCode });
  });

  app.get("/api/wechat/mall/order/status", async (request) => {
    const query = z.object({ schemaName: z.string(), orderId: z.string().optional(), orderNo: z.string().optional() }).parse(request.query);
    const schema = await resolveTenantSchema(query.schemaName);
    return queryMallOrderStatus(schema, { order_id: query.orderId, order_no: query.orderNo });
  });

  app.post("/api/wechat/mall/order/reconcile", async (request) => {
    const body = z.object({ schemaName: z.string(), orderId: z.string(), bindingId: z.string().optional() }).parse(request.body);
    const schema = await resolveTenantSchema(body.schemaName);
    return reconcileMallOrder(schema, { order_id: body.orderId, binding_id: body.bindingId });
  });

  app.post("/api/wechat/pay/callback", async (request) => {
    const query = z.object({ schemaName: z.string().optional(), bindingId: z.string().optional() }).parse(request.query);
    const body = z.object({ schemaName: z.string().optional(), bindingId: z.string().optional() }).passthrough().parse(request.body ?? {});
    const schemaName = query.schemaName ?? body.schemaName;
    if (!schemaName) throw httpError(400, "微信支付回调缺少租户标识，请确认 notify_url 携带 schemaName");
    const schema = await resolveTenantSchema(schemaName);
    const result = await handleMallPayCallback(schema, { ...body, binding_id: query.bindingId ?? body.bindingId, headers: request.headers, rawBody: (request as typeof request & { rawBody?: string }).rawBody ?? JSON.stringify(request.body ?? {}) });
    return { code: "SUCCESS", message: "成功", result };
  });


  app.post("/api/auth/admin/login", async (request) => {
    const body = z.object({ contact: z.string(), password: z.string() }).parse(request.body);
    return adminLogin(app, body.contact, body.password);
  });

  app.post("/api/auth/tenant/login", async (request) => {
    const body = z.object({ schemaName: z.string(), contact: z.string(), password: z.string() }).parse(request.body);
    return tenantLogin(app, body.schemaName, body.contact, body.password);
  });

  app.post("/api/auth/logout", { preHandler: [app.authenticate as never] }, async (request) => {
    const user = currentUser(request);
    const token = request.headers.authorization?.replace("Bearer ", "") ?? "";
    return logout(token, user!, user?.schemaName);
  });

  app.get("/api/auth/permissions", { preHandler: [app.authenticate as never] }, async (request) => {
    const user = currentUser(request);
    if (!user) throw httpError(401, "请先登录");
    return getUserPermissions(user, user.schemaName ?? "admin");
  });

  app.get("/api/auth/management-organizations", { preHandler: [app.authenticate as never] }, async (request) => {
    const user = currentUser(request);
    if (!user) throw httpError(401, "请先登录");
    const query = z.object({ schemaName: z.string().optional() }).parse(request.query);
    const schema = await resolveAuthorizedTenantSchema(user, query.schemaName);
    return listManagementOrganizations(user, schema);
  });

  app.get("/api/gateway/menu", { preHandler: [app.authenticate as never] }, async (request) => {
    const user = currentUser(request);
    const query = z.object({ schemaName: z.string().optional(), scope: z.enum(["admin", "tenant"]).default("tenant") }).parse(request.query);
    if (query.scope === "admin") return { modules: await loadAdminMenu() };
    const schema = await resolveAuthorizedTenantSchema(user, query.schemaName);
    return { modules: await loadTenantMenu(schema, user) };
  });

  app.get("/api/gateway/page", async (request) => {
    const query = z.object({ schemaName: z.string().optional(), pageCode: z.string(), scope: z.enum(["admin", "tenant"]).default("tenant") }).parse(request.query);
    let user: SessionUser | undefined;
    try { user = await (request as AuthedRequest).jwtVerify<SessionUser>(); } catch { /* not logged in */ }

    if (query.scope === "tenant") {
      const schema = await resolveTenantSchema(query.schemaName ?? user?.schemaName ?? "");
      const result = await loadPageFullDsl("tenant", query.pageCode, schema, user);
      if (result.pageKind === "public") return result;
      if (!user) throw httpError(401, "请先登录");
      if (!(await canAccessPage(user, schema, query.pageCode))) throw httpError(403, "无页面权限");
      return result;
    }
    const result = await loadPageFullDsl("admin", query.pageCode, undefined, user);
    if (result.pageKind === "public") return result;
    if (!user) throw httpError(401, "请先登录");
    return result;
  });

  app.post("/api/gateway/api/execute", { preHandler: [app.authenticate as never] }, async (request) => {
    const started = Date.now();
    const user = currentUser(request);
    const body = z.object({
      scope: z.enum(["admin", "tenant"]).default("tenant"),
      schemaName: z.string().optional(),
      pageCode: z.string().optional(),
      apiCode: z.string(),
      params: z.record(z.unknown()).default({})
    }).parse(request.body);
    try {
      const schema = body.scope === "admin" ? "admin" : await resolveAuthorizedTenantSchema(user, body.schemaName);
      if (body.scope === "tenant" && body.pageCode && !(await canAccessPage(user, schema, body.pageCode))) {
        throw httpError(403, "无接口权限");
      }
      const data = await executeGatewayApi(body.scope, schema, body.apiCode, body.params, user);
      await audit({ schemaName: schema, userId: user?.userId, pageCode: body.pageCode, apiCode: body.apiCode, inputSummary: body.params, outputSummary: { ok: true }, costMs: Date.now() - started });
      return { data };
    } catch (error) {
      await audit({ schemaName: body.schemaName, userId: user?.userId, pageCode: body.pageCode, apiCode: body.apiCode, inputSummary: body.params, costMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  });

  app.post("/api/gateway/action/execute", { preHandler: [app.authenticate as never] }, async (request) => {
    const started = Date.now();
    const body = z.object({
      scope: z.enum(["admin", "tenant"]).default("tenant"),
      schemaName: z.string().optional(),
      actionCode: z.string(),
      params: z.record(z.unknown()).default({})
    }).parse(request.body);
    const user = currentUser(request);
    const schema = body.scope === "admin" ? "admin" : await resolveAuthorizedTenantSchema(user, body.schemaName);
    try {
      const data = await executeAction(body.scope, schema, body.actionCode, body.params, user);
      await audit({ schemaName: schema, userId: user?.userId, actionCode: body.actionCode, inputSummary: body.params, outputSummary: { ok: true }, costMs: Date.now() - started });
      return { data };
    } catch (error) {
      await audit({ schemaName: schema, userId: user?.userId, actionCode: body.actionCode, inputSummary: body.params, costMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  });

  app.post("/api/admin/version/publish", { preHandler: [app.authenticate as never] }, async (request) => {
    const started = Date.now();
    const user = currentUser(request);
    const body = z.object({ versionId: z.string() }).parse(request.body);
    try {
      const result = await publishVersionAndSyncSkillMd(body.versionId, user?.userId ?? "");
      await audit({ userId: user?.userId, actionCode: "version.publish", inputSummary: body, outputSummary: result, costMs: Date.now() - started });
      return result;
    } catch (error) {
      await audit({ userId: user?.userId, actionCode: "version.publish", inputSummary: body, costMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  });

  app.post("/api/admin/version/rollback", { preHandler: [app.authenticate as never] }, async (request) => {
    const started = Date.now();
    const user = currentUser(request);
    const body = z.object({ versionId: z.string() }).parse(request.body);
    try {
      const result = await rollbackVersion(body.versionId, user?.userId ?? "");
      await audit({ userId: user?.userId, actionCode: "version.rollback", inputSummary: body, outputSummary: result, costMs: Date.now() - started });
      return result;
    } catch (error) {
      await audit({ userId: user?.userId, actionCode: "version.rollback", inputSummary: body, costMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  });

  app.post("/api/admin/version/reject", { preHandler: [app.authenticate as never] }, async (request) => {
    const started = Date.now();
    const user = currentUser(request);
    const body = z.object({ versionId: z.string(), reason: z.string().optional() }).parse(request.body);
    try {
      const result = await rejectVersion(body.versionId, body.reason ?? "驳回", user?.userId ?? "");
      await audit({ userId: user?.userId, actionCode: "version.reject", inputSummary: body, outputSummary: result, costMs: Date.now() - started });
      return result;
    } catch (error) {
      await audit({ userId: user?.userId, actionCode: "version.reject", inputSummary: body, costMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  });

  app.post("/api/tenant/agent/chat", { preHandler: [app.authenticate as never] }, async (request) => {
    const started = Date.now();
    const user = currentUser(request);
    const body = z.object({ schemaName: z.string(), message: z.string(), sessionId: z.string().optional(), attachmentIds: z.array(z.string()).optional() }).parse(request.body);
    const schema = await resolveAuthorizedTenantSchema(user, body.schemaName);
    assertNotTestCustomizationSchema(schema);
    try {
      const result = await tenantAgentChat({ schemaName: schema, userId: user?.userId ?? "", message: body.message, sessionId: body.sessionId, attachmentIds: body.attachmentIds, user: user! });
      await audit({ schemaName: schema, userId: user?.userId, actionCode: "tenant.agent.chat", inputSummary: { schemaName: schema, sessionId: body.sessionId }, outputSummary: { sessionId: result.sessionId }, costMs: Date.now() - started });
      return result;
    } catch (error) {
      await audit({ schemaName: schema, userId: user?.userId, actionCode: "tenant.agent.chat", inputSummary: { ...body, schemaName: schema }, costMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  });

  app.post("/api/tenant/agent/chat/stream", { preHandler: [app.authenticate as never] }, async (request, reply) => {
    const started = Date.now();
    const user = currentUser(request);
    const body = z.object({ schemaName: z.string(), message: z.string(), sessionId: z.string().optional(), attachmentIds: z.array(z.string()).optional() }).parse(request.body);
    const schema = await resolveAuthorizedTenantSchema(user, body.schemaName);
    assertNotTestCustomizationSchema(schema);
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const sendEvent = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const result = await tenantAgentChat({
        schemaName: schema,
        userId: user?.userId ?? "",
        message: body.message,
        sessionId: body.sessionId,
        attachmentIds: body.attachmentIds,
        user: user!,
        onProgress: (event) => sendEvent("progress", event),
        onSummary: (summary) => sendEvent("summary", { summary }),
      });
      await audit({ schemaName: schema, userId: user?.userId, actionCode: "tenant.agent.chat.stream", inputSummary: { schemaName: schema, sessionId: body.sessionId }, outputSummary: { sessionId: result.sessionId }, costMs: Date.now() - started });
      sendEvent("done", result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await audit({ schemaName: schema, userId: user?.userId, actionCode: "tenant.agent.chat.stream", inputSummary: { ...body, schemaName: schema }, costMs: Date.now() - started, error: message });
      sendEvent("error", { message });
    } finally {
      reply.raw.end();
    }
    return reply;
  });

  app.post("/api/tenant/assistant/chat/stream", { preHandler: [app.authenticate as never] }, async (request, reply) => {
    const started = Date.now();
    const user = currentUser(request);
    const body = z.object({ schemaName: z.string(), message: z.string(), sessionId: z.string().optional(), attachmentIds: z.array(z.string()).optional() }).parse(request.body);
    const schema = await resolveAuthorizedTenantSchema(user, body.schemaName);
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const sendEvent = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    try {
      const result = await tenantAssistantChat({
        schemaName: schema,
        user: user!,
        message: body.message,
        sessionId: body.sessionId,
        attachmentIds: body.attachmentIds,
        onProgress: (event) => sendEvent("progress", event),
        onSummary: (summary) => sendEvent("summary", { summary }),
        onDelta: (text) => sendEvent("delta", { text }),
      });
      await audit({ schemaName: schema, userId: user?.userId, actionCode: "tenant.assistant.chat.stream", inputSummary: { sessionId: body.sessionId, attachmentIds: body.attachmentIds }, outputSummary: { sessionId: result.sessionId }, costMs: Date.now() - started });
      sendEvent("done", result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await audit({ schemaName: schema, userId: user?.userId, actionCode: "tenant.assistant.chat.stream", inputSummary: body, costMs: Date.now() - started, error: message });
      sendEvent("error", { message });
    } finally {
      reply.raw.end();
    }
    return reply;
  });

  app.post("/api/tenant/agent/preview", { preHandler: [app.authenticate as never] }, async (request) => {
    const started = Date.now();
    const user = currentUser(request);
    const body = z.object({ schemaName: z.string(), versionId: z.string() }).parse(request.body);
    const schema = await resolveAuthorizedTenantSchema(user, body.schemaName);
    assertNotTestCustomizationSchema(schema);
    try {
      const result = await tenantAgentPreview({ schemaName: schema, versionId: body.versionId, user: user! });
      await audit({ schemaName: schema, userId: user?.userId, actionCode: "tenant.agent.preview", inputSummary: { ...body, schemaName: schema }, outputSummary: result, costMs: Date.now() - started });
      return result;
    } catch (error) {
      await audit({ schemaName: schema, userId: user?.userId, actionCode: "tenant.agent.preview", costMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  });

  app.post("/api/tenant/agent/publish", { preHandler: [app.authenticate as never] }, async (request) => {
    const started = Date.now();
    const user = currentUser(request);
    const body = z.object({ schemaName: z.string(), versionId: z.string() }).parse(request.body);
    const schema = await resolveAuthorizedTenantSchema(user, body.schemaName);
    assertNotTestCustomizationSchema(schema);
    try {
      const result = await tenantAgentPublish({ schemaName: schema, versionId: body.versionId, user: user! });
      await audit({ schemaName: schema, userId: user?.userId, actionCode: "tenant.agent.publish", inputSummary: { ...body, schemaName: schema }, outputSummary: result, costMs: Date.now() - started });
      return result;
    } catch (error) {
      await audit({ schemaName: schema, userId: user?.userId, actionCode: "tenant.agent.publish", costMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  });

  app.post("/api/tenant/agent/reject", { preHandler: [app.authenticate as never] }, async (request) => {
    const started = Date.now();
    const user = currentUser(request);
    const body = z.object({ schemaName: z.string(), versionId: z.string(), reason: z.string().optional() }).parse(request.body);
    const schema = await resolveAuthorizedTenantSchema(user, body.schemaName);
    assertNotTestCustomizationSchema(schema);
    try {
      const result = await tenantAgentReject({ schemaName: schema, versionId: body.versionId, reason: body.reason, user: user! });
      await audit({ schemaName: schema, userId: user?.userId, actionCode: "tenant.agent.reject", inputSummary: { ...body, schemaName: schema }, outputSummary: result, costMs: Date.now() - started });
      return result;
    } catch (error) {
      await audit({ schemaName: schema, userId: user?.userId, actionCode: "tenant.agent.reject", costMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  });

  app.get("/api/tenant/agent/drafts", { preHandler: [app.authenticate as never] }, async (request) => {
    const user = currentUser(request);
    const query = z.object({ schemaName: z.string() }).parse(request.query);
    const schema = await resolveAuthorizedTenantSchema(user, query.schemaName);
    assertNotTestCustomizationSchema(schema);
    return listTenantDrafts(schema, user!);
  });

  app.get("/api/tenant/agent/chat/session", { preHandler: [app.authenticate as never] }, async (request) => {
    const user = currentUser(request);
    const query = z.object({ schemaName: z.string(), sessionId: z.string().optional() }).parse(request.query);
    const schema = await resolveAuthorizedTenantSchema(user, query.schemaName);
    assertNotTestCustomizationSchema(schema);
    return getActiveChatSession(schema, user?.userId ?? "", query.sessionId);
  });

  app.get("/api/tenant/agent/harness-log", { preHandler: [app.authenticate as never] }, async (request) => {
    const user = currentUser(request);
    const query = z.object({ sessionId: z.string() }).parse(request.query);
    const { rows } = await pool.query(
      `select step_name, input_summary, output_summary, duration_ms, llm_tokens_used, created_at from admin.agent_harness_step_log where session_id = $1 order by created_at`,
      [query.sessionId]
    );
    const { rows: llmRows } = await pool.query(
      `select schema_name, model, has_tools, tool_names, messages_json, response_content, function_call,
              status, error, duration_ms, tokens_used, prompt_tokens, completion_tokens, cached_tokens, created_at
       from admin.llm_call_log
       where session_id = $1
       order by created_at`,
      [query.sessionId]
    );
    await audit({ schemaName: user?.schemaName, userId: user?.userId, actionCode: "tenant.agent.harness-log", inputSummary: query, costMs: 0 });
    return {
      steps: rows.map((row) => ({
        ...row,
        display_name: harnessStepDisplayName(row.step_name),
        tenant_summary: harnessStepTenantSummary(row.step_name, row.output_summary),
      })),
      llmCalls: llmRows,
    };
  });

  app.post("/api/tenant/agent/attachments", { preHandler: [app.authenticate as never] }, async (request) => {
    const user = currentUser(request);
    const body = z.object({
      schemaName: z.string(),
      sessionId: z.string().optional(),
      fileName: z.string(),
      mimeType: z.string(),
      contentBase64: z.string(),
    }).parse(request.body);
    const schema = await resolveAuthorizedTenantSchema(user, body.schemaName);
    assertNotTestCustomizationSchema(schema);
    const attachment = await saveAgentAttachment({
      schemaName: schema,
      userId: user?.userId,
      sessionId: body.sessionId,
      fileName: body.fileName,
      mimeType: body.mimeType,
      contentBase64: body.contentBase64,
    });
    await audit({ schemaName: schema, userId: user?.userId, actionCode: "tenant.agent.attachment.upload", inputSummary: { fileName: body.fileName, mimeType: body.mimeType }, outputSummary: { id: attachment.id }, costMs: 0 });
    return { attachment };
  });

  app.get("/api/tenant/agent/attachments/:id/content", { preHandler: [app.authenticate as never] }, async (request, reply) => {
    const user = currentUser(request);
    const params = z.object({ id: z.string() }).parse(request.params);
    const query = z.object({ schemaName: z.string().optional() }).parse(request.query);
    const schemaName = await resolveAuthorizedTenantSchema(user, query.schemaName);
    const attachment = await loadAttachment(params.id, schemaName);
    if (!attachment?.local_path) throw httpError(404, "附件不存在");
    reply.header("Content-Type", attachment.mime_type);
    reply.header("Content-Disposition", `attachment; filename="${encodeURIComponent(attachment.file_name)}"`);
    return reply.send(createReadStream(attachment.local_path));
  });

  app.post("/api/tenant/import/template", { preHandler: [app.authenticate as never] }, async (request, reply) => {
    const user = currentUser(request);
    const body = z.object({
      schemaName: z.string(),
      title: z.string().optional(),
      pageCode: z.string().optional(),
      apiCode: z.string().optional(),
      fields: z.array(z.record(z.unknown())).default([]),
    }).parse(request.body);
    const schema = await resolveAuthorizedTenantSchema(user, body.schemaName);
    if (body.pageCode && !(await canAccessPage(user, schema, body.pageCode))) throw httpError(403, "无页面权限");
    const config = body.pageCode
      ? await resolveTenantImportConfig({
          schemaName: schema,
          pageCode: body.pageCode,
          apiCode: body.apiCode,
          providedFields: body.fields as Array<{ key: string; label?: string; title?: string; required?: boolean }>,
        })
      : { fields: body.fields as Array<{ key: string; label?: string; title?: string; required?: boolean }>, templateTitle: body.title ?? "导入模板" };
    const buffer = buildImportTemplate(config.fields);
    reply.header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    reply.header("Content-Disposition", `attachment; filename="${encodeURIComponent(body.title ?? config.templateTitle)}.xlsx"`);
    return reply.send(buffer);
  });

  app.post("/api/tenant/import/execute", { preHandler: [app.authenticate as never] }, async (request) => {
    const user = currentUser(request);
    const body = z.object({
      schemaName: z.string(),
      pageCode: z.string(),
      apiCode: z.string(),
      fileName: z.string(),
      contentBase64: z.string(),
      fields: z.array(z.record(z.unknown())).default([]),
      idResolutionStrategy: z.enum(["first", "error"]).default("error"),
      mode: z.enum(["import", "validate"]).default("import"),
    }).parse(request.body);
    const started = Date.now();
    const schema = await resolveAuthorizedTenantSchema(user, body.schemaName);
    if (!(await canAccessPage(user, schema, body.pageCode))) throw httpError(403, "无页面权限");
    const importConfig = await resolveTenantImportConfig({
      schemaName: schema,
      pageCode: body.pageCode,
      apiCode: body.apiCode,
      providedFields: body.fields as Array<{ key: string; label?: string; title?: string; required?: boolean; optionSource?: { apiCode: string; pageCode?: string; valueField?: string; labelField?: string; filters?: Record<string, unknown>; pageSize?: number } }>,
    });
    const result = await executeTenantImport({
      schemaName: schema,
      pageCode: body.pageCode,
      apiCode: importConfig.apiCode,
      fileName: body.fileName,
      contentBase64: body.contentBase64,
      fields: importConfig.fields,
      idResolutionStrategy: body.idResolutionStrategy,
      validateOnly: body.mode === "validate",
      user,
    });
    await audit({ schemaName: schema, userId: user?.userId, pageCode: body.pageCode, actionCode: "tenant.import.execute", inputSummary: { fileName: body.fileName, mode: body.mode }, outputSummary: { success: result.success, failed: result.failed }, costMs: Date.now() - started });
    return result;
  });

  app.post("/api/tenant/agent/skill-md", { preHandler: [app.authenticate as never] }, async (request) => {
    const started = Date.now();
    const user = currentUser(request);
    const body = z.object({ schemaName: z.string(), featureCode: z.string().optional() }).parse(request.body);
    assertNotTestCustomizationSchema(body.schemaName);
    try {
      let refreshedCount = 0;
      if (body.featureCode) {
        await syncSkillMd(body.schemaName, body.featureCode);
        refreshedCount = 1;
      } else {
        refreshedCount = await fillEmptySkillMd(body.schemaName);
      }
      await audit({ schemaName: body.schemaName, userId: user?.userId, actionCode: "tenant.agent.skill-md", inputSummary: body, outputSummary: { refreshedCount }, costMs: Date.now() - started });
      return { refreshedCount };
    } catch (error) {
      await audit({ schemaName: body.schemaName, userId: user?.userId, actionCode: "tenant.agent.skill-md", costMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  });

  app.get("/api/tenant/config", { preHandler: [app.authenticate as never] }, async (request) => {
    const user = currentUser(request);
    if (!user || user.kind !== "tenant" || !user.schemaName) throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
    if (isTestSchema(user.schemaName)) return { agentCustomizationEnabled: false };
    const { rows } = await pool.query(
      "SELECT agent_customization_enabled FROM admin.tenant_agent_config WHERE schema_name = $1 AND deleted = false",
      [user.schemaName]
    );
    return { agentCustomizationEnabled: !!rows[0]?.agent_customization_enabled };
  });

  app.get("/api/tenant/version/list", { preHandler: [app.authenticate as never] }, async (request) => {
    const user = currentUser(request);
    const query = z.object({ schemaName: z.string(), targetType: z.string().optional(), targetCode: z.string().optional(), status: z.string().optional() }).parse(request.query);
    return listTenantVersions(query.schemaName, { targetType: query.targetType, targetCode: query.targetCode, status: query.status });
  });

  app.post("/api/tenant/version/rollback", { preHandler: [app.authenticate as never] }, async (request) => {
    const started = Date.now();
    const user = currentUser(request);
    const body = z.object({ schemaName: z.string(), versionId: z.string() }).parse(request.body);
    try {
      const result = await tenantRollbackVersion({ schemaName: body.schemaName, versionId: body.versionId, userId: user?.userId ?? "" });
      try {
        await rollbackTestSchemaDsl(body.schemaName, body.versionId);
      } catch (err) {
        console.warn("[Version] test schema rollback skipped:", err instanceof Error ? err.message : String(err));
      }
      await audit({ schemaName: body.schemaName, userId: user?.userId, actionCode: "tenant.version.rollback", inputSummary: body, outputSummary: result, costMs: Date.now() - started });
      return result;
    } catch (error) {
      await audit({ schemaName: body.schemaName, userId: user?.userId, actionCode: "tenant.version.rollback", costMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  });

  app.post("/api/tenant/version/rollback-preview", { preHandler: [app.authenticate as never] }, async (request) => {
    const started = Date.now();
    const user = currentUser(request);
    const body = z.object({ schemaName: z.string(), versionId: z.string() }).parse(request.body);
    try {
      const result = await rollbackTestSchemaDsl(body.schemaName, body.versionId);
      const previewUrl = `/${body.schemaName}_test/app/`;
      await audit({ schemaName: body.schemaName, userId: user?.userId, actionCode: "tenant.version.rollback_preview", inputSummary: body, outputSummary: { ...result, previewUrl }, costMs: Date.now() - started });
      return { ...result, previewUrl };
    } catch (error) {
      await audit({ schemaName: body.schemaName, userId: user?.userId, actionCode: "tenant.version.rollback_preview", costMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  });

  app.get("/api/admin/tenant/module-tree", { preHandler: [app.authenticate as never] }, async () => {
    return loadModuleSelectionTree();
  });

  app.post("/api/admin/tenant/create", { preHandler: [app.authenticate as never] }, async (request) => {
    const started = Date.now();
    const user = currentUser(request);
    const body = z.object({ name: z.string(), contactPhone: z.string().optional(), ownerName: z.string().optional(), selectedModules: z.array(z.string()), selectedFeatures: z.array(z.string()) }).parse(request.body);
    try {
      const result = await createTenantWithModules({ ...body, operatorId: user?.userId ?? "" });
      await audit({ userId: user?.userId, actionCode: "admin.tenant.create", inputSummary: { name: body.name }, outputSummary: result, costMs: Date.now() - started });
      return result;
    } catch (error) {
      await audit({ userId: user?.userId, actionCode: "admin.tenant.create", costMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  });

  app.post("/api/admin/tenant/recharge", { preHandler: [app.authenticate as never] }, async (request) => {
    const started = Date.now();
    const user = currentUser(request);
    const body = z.object({ schemaName: z.string(), amount: z.number(), expireTime: z.string(), remark: z.string().optional() }).parse(request.body);
    try {
      const result = await rechargeTenant({ ...body, operatorId: user?.userId ?? "" });
      await audit({ schemaName: body.schemaName, userId: user?.userId, actionCode: "admin.tenant.recharge", inputSummary: body, outputSummary: result, costMs: Date.now() - started });
      return result;
    } catch (error) {
      await audit({ schemaName: body.schemaName, userId: user?.userId, actionCode: "admin.tenant.recharge", costMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  });

  app.get("/api/admin/tenant/recharge-records", { preHandler: [app.authenticate as never] }, async (request) => {
    const query = z.object({ schemaName: z.string().optional(), page: z.coerce.number().optional(), pageSize: z.coerce.number().optional() }).parse(request.query);
    return listRechargeRecords(query);
  });

  app.get("/api/admin/tenant/customization-records", { preHandler: [app.authenticate as never] }, async (request) => {
    const query = z.object({ schemaName: z.string().optional(), recordType: z.enum(["assistant", "customization"]).optional(), page: z.coerce.number().optional(), pageSize: z.coerce.number().optional() }).parse(request.query);
    return listCustomizationRecords(query);
  });

  app.get("/api/admin/tenant/customization-records/:id", { preHandler: [app.authenticate as never] }, async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    return getCustomizationRecordDetail(params.id);
  });

  app.get("/api/admin/tenant/dsl-changes", { preHandler: [app.authenticate as never] }, async (request) => {
    const query = z.object({ schemaName: z.string() }).parse(request.query);
    return listTenantDslChanges(query.schemaName);
  });

  app.post("/api/admin/tenant/copy-to-template", { preHandler: [app.authenticate as never] }, async (request) => {
    const started = Date.now();
    const user = currentUser(request);
    const body = z.object({ schemaName: z.string(), confirmed: z.boolean() }).parse(request.body);
    try {
      const result = await executeCopyToTemplate({ schemaName: body.schemaName, operatorId: user?.userId ?? "", confirmed: body.confirmed });
      await audit({ schemaName: body.schemaName, userId: user?.userId, actionCode: "admin.tenant.copyToTemplate", inputSummary: body, outputSummary: result, costMs: Date.now() - started });
      return result;
    } catch (error) {
      await audit({ schemaName: body.schemaName, userId: user?.userId, actionCode: "admin.tenant.copyToTemplate", costMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  });

  const staticRoot = path.join(rootDir, "client", "dist");
  await app.register(statik, { root: staticRoot, prefix: "/" });
  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith("/api/")) return reply.code(404).send({ message: "Not found" });
    return reply.sendFile("index.html");
  });

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (request: AuthedRequest) => Promise<void>;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildServer()
    .then((app) => app.listen({ host: env.host, port: env.port }))
    .catch(async (error) => {
      console.error(error);
      await pool.end();
      process.exit(1);
    });
}
