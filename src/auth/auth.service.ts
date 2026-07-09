import { createHash, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { pool } from "../db/pool.js";
import { resolveTenantSchema } from "../db/schema-resolver.js";
import { dictionaryCompatValues } from "../dictionary.service.js";
import { visiblePageCodes, visibleActionCodes, getDataPermissionScope, fieldPermissions } from "../permission/permission.service.js";
import type { SessionUser } from "../types.js";

export async function adminLogin(app: FastifyInstance, contact: string, password: string) {
  const { rows } = await pool.query(
    `select id, name, psw from admin.admin_user where (contact = $1 or email = $1) and status = 'ACTIVE' and deleted = false`,
    [contact]
  );
  const user = rows[0];
  if (!user || !(await bcrypt.compare(password, user.psw))) {
    throw new Error("账号或密码错误");
  }
  const payload: SessionUser = { kind: "admin", userId: user.id, name: user.name };
  return { token: app.jwt.sign(payload), user: payload };
}

export async function tenantLogin(app: FastifyInstance, schemaName: string, contact: string, password: string) {
  const schema = await resolveTenantSchema(schemaName);
  const activeValues = dictionaryCompatValues("status", "ACTIVE") ?? ["ACTIVE"];
  const { rows } = await pool.query(
    `select id, name, psw from "${schema}"."user" where contact = $1 and status = any($2) and deleted = false`,
    [contact, activeValues]
  );
  const user = rows[0];
  if (!user || !(await bcrypt.compare(password, user.psw))) {
    throw new Error("账号或密码错误");
  }
  const payload: SessionUser = { kind: "tenant", userId: user.id, name: user.name, schemaName: schema };
  const token = app.jwt.sign(payload);

  const tokenHash = createHash("sha256").update(token).digest("hex");
  try {
    await pool.query(
      `insert into "${schema}".login_session(id, user_id, token_hash, login_time, ip, device_info) values($1,$2,$3,now(),$4,$5)`,
      [randomUUID(), user.id, tokenHash, null, null]
    );
  } catch (e) {
    console.warn("login_session write failed:", e);
  }

  try {
    await pool.query(
      `update "${schema}"."user" set last_login_time = now() where id = $1`,
      [user.id]
    );
  } catch (e) {
    console.warn("last_login_time update failed:", e);
  }

  const permissions = await getUserPermissions(payload, schema);
  return { token, user: payload, permissions };
}

export async function logout(token: string, user: SessionUser, schemaName?: string) {
  if (!schemaName) return { success: true };
  const tokenHash = createHash("sha256").update(token).digest("hex");
  try {
    await pool.query(
      `update "${schemaName}".login_session set logout_time = now() where token_hash = $1 and user_id = $2`,
      [tokenHash, user.userId]
    );
  } catch { /* idempotent */ }
  return { success: true };
}

export async function isTokenRevoked(schemaName: string, token: string): Promise<boolean> {
  const tokenHash = createHash("sha256").update(token).digest("hex");
  try {
    const { rows } = await pool.query(
      `select id from "${schemaName}".login_session where token_hash = $1 and logout_time is null limit 1`,
      [tokenHash]
    );
    return rows.length === 0;
  } catch {
    return false;
  }
}

export async function getUserPermissions(user: SessionUser | undefined, schemaName: string) {
  if (!user) return { pages: [], buttons: [], dataPermission: "self_only", fieldPermissions: {} };
  if (user.kind === "admin") return { pages: ["*"], buttons: ["*"], dataPermission: "all", fieldPermissions: {} };

  const pages = await visiblePageCodes(user, schemaName);
  const buttons: string[] = [];
  const fp: Record<string, Record<string, string>> = {};

  for (const pageCode of pages) {
    const actionCodes = await visibleActionCodes(user, schemaName, pageCode);
    for (const ac of actionCodes) buttons.push(`${pageCode}:${ac}`);
    fp[pageCode] = await fieldPermissions(user, schemaName, pageCode);
  }

  const { dataPermission } = await getDataPermissionScope(user, schemaName);
  return { pages, buttons, dataPermission, fieldPermissions: fp };
}

export async function listTenants() {
  const { rows } = await pool.query(
    `select schema_name, name, owner_name, contact_phone
     from admin.tenant_manage
     where status = 'ACTIVE' and deleted = false
     order by created_at asc`
  );
  return rows;
}
