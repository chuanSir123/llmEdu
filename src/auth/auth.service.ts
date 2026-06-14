import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { pool } from "../db/pool.js";
import { resolveTenantSchema } from "../db/schema-resolver.js";
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
  const { rows } = await pool.query(
    `select id, name, psw from "${schema}"."user" where contact = $1 and status = 'ACTIVE' and deleted = false`,
    [contact]
  );
  const user = rows[0];
  if (!user || !(await bcrypt.compare(password, user.psw))) {
    throw new Error("账号或密码错误");
  }
  const payload: SessionUser = { kind: "tenant", userId: user.id, name: user.name, schemaName: schema };
  return { token: app.jwt.sign(payload), user: payload };
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
