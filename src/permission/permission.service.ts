import { pool } from "../db/pool.js";
import type { SessionUser } from "../types.js";

export async function canAccessPage(user: SessionUser | undefined, schemaName: string | undefined, pageCode: string) {
  if (user?.kind === "admin") return true;
  if (!user || !schemaName) return false;
  const { rows } = await pool.query(
    `select rr.page_permission
     from "${schemaName}".role_resource rr
     join "${schemaName}".user_role ur on ur.role_id = rr.role_id and ur.deleted = false
     where ur.user_id = $1 and rr.page_code = $2 and rr.deleted = false
     limit 1`,
    [user.userId, pageCode]
  );
  return rows.length > 0;
}

export async function visiblePageCodes(user: SessionUser | undefined, schemaName: string) {
  if (!user) return [];
  const { rows } = await pool.query(
    `select distinct rr.page_code
     from "${schemaName}".role_resource rr
     join "${schemaName}".user_role ur on ur.role_id = rr.role_id and ur.deleted = false
     where ur.user_id = $1 and rr.deleted = false`,
    [user.userId]
  );
  return rows.map((row) => row.page_code as string);
}
