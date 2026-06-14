import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import statik from "@fastify/static";
import Fastify from "fastify";
import { z } from "zod";
import { env } from "./config/env.js";
import { adminLogin, listTenants, tenantLogin } from "./auth/auth.service.js";
import { resolveTenantSchema } from "./db/schema-resolver.js";
import { pool } from "./db/pool.js";
import { seed } from "./seed/run.js";
import { loadAdminMenu, loadTenantMenu } from "./gateway/menu.service.js";
import { loadPageDsl } from "./gateway/page.service.js";
import { executeGatewayApi } from "./gateway/api-executor.js";
import { executeAction } from "./gateway/action-executor.js";
import { canAccessPage } from "./permission/permission.service.js";
import { submitAgentTask } from "./agent/agent.service.js";
import type { AuthedRequest, SessionUser } from "./types.js";

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

function currentUser(req: unknown) {
  return (req as AuthedRequest).user as SessionUser | undefined;
}

async function buildServer() {
  await seed();

  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });
  await app.register(jwt, { secret: env.jwtSecret });

  app.decorate("authenticate", async (request: AuthedRequest) => {
    try {
      request.user = await request.jwtVerify<SessionUser>();
    } catch {
      throw httpError(401, "请先登录");
    }
  });

  app.get("/api/health", async () => ({ ok: true, service: "llmEdu", time: new Date().toISOString() }));
  app.get("/api/public/tenants", async () => ({ tenants: await listTenants() }));

  app.post("/api/auth/admin/login", async (request) => {
    const body = z.object({ contact: z.string(), password: z.string() }).parse(request.body);
    return adminLogin(app, body.contact, body.password);
  });

  app.post("/api/auth/tenant/login", async (request) => {
    const body = z.object({ schemaName: z.string(), contact: z.string(), password: z.string() }).parse(request.body);
    return tenantLogin(app, body.schemaName, body.contact, body.password);
  });

  app.get("/api/gateway/menu", { preHandler: [app.authenticate as never] }, async (request) => {
    const user = currentUser(request);
    const query = z.object({ schemaName: z.string().optional(), scope: z.enum(["admin", "tenant"]).default("tenant") }).parse(request.query);
    if (query.scope === "admin") return { modules: await loadAdminMenu() };
    const schema = await resolveTenantSchema(query.schemaName ?? user?.schemaName ?? "");
    return { modules: await loadTenantMenu(schema, user) };
  });

  app.get("/api/gateway/page", { preHandler: [app.authenticate as never] }, async (request) => {
    const user = currentUser(request);
    const query = z.object({ schemaName: z.string().optional(), pageCode: z.string(), scope: z.enum(["admin", "tenant"]).default("tenant") }).parse(request.query);
    if (query.scope === "tenant") {
      const schema = await resolveTenantSchema(query.schemaName ?? user?.schemaName ?? "");
      if (!(await canAccessPage(user, schema, query.pageCode))) throw httpError(403, "无页面权限");
      const page = await loadPageDsl("tenant", query.pageCode, schema);
      return { page };
    }
    const page = await loadPageDsl("admin", query.pageCode);
    return { page };
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
      const schema = body.scope === "admin" ? "admin" : await resolveTenantSchema(body.schemaName ?? user?.schemaName ?? "");
      if (body.scope === "tenant" && body.pageCode && !(await canAccessPage(user, schema, body.pageCode))) {
        throw httpError(403, "无接口权限");
      }
      const data = await executeGatewayApi(body.scope, schema, body.apiCode, body.params);
      await audit({ schemaName: schema, userId: user?.userId, pageCode: body.pageCode, apiCode: body.apiCode, inputSummary: body.params, outputSummary: { ok: true }, costMs: Date.now() - started });
      return { data };
    } catch (error) {
      await audit({ schemaName: body.schemaName, userId: user?.userId, pageCode: body.pageCode, apiCode: body.apiCode, inputSummary: body.params, costMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  });

  app.post("/api/gateway/action/execute", { preHandler: [app.authenticate as never] }, async (request) => {
    const body = z.object({
      scope: z.enum(["admin", "tenant"]).default("tenant"),
      schemaName: z.string().optional(),
      actionCode: z.string(),
      params: z.record(z.unknown()).default({})
    }).parse(request.body);
    const user = currentUser(request);
    const schema = body.scope === "admin" ? "admin" : await resolveTenantSchema(body.schemaName ?? user?.schemaName ?? "");
    return { data: await executeAction(body.scope, schema, body.actionCode, body.params) };
  });

  app.post("/api/agent/task", { preHandler: [app.authenticate as never] }, async (request) => {
    const user = currentUser(request);
    const body = z.object({ schemaName: z.string().default("demo_school"), prompt: z.string(), mode: z.string().default("draft") }).parse(request.body);
    if (user?.kind !== "admin") throw httpError(403, "仅 admin 可提交 Agent 变更任务");
    return { task: await submitAgentTask(body.schemaName, body.prompt, body.mode) };
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
