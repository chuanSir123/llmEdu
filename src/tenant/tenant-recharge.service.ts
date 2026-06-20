import { randomUUID } from "node:crypto";
import { pool, withClient } from "../db/pool.js";

function httpError(statusCode: number, message: string) {
  return Object.assign(new Error(message), { statusCode });
}

export async function rechargeTenant(input: {
  schemaName: string;
  amount: number;
  expireTime: string;
  operatorId: string;
  remark?: string;
}) {
  if (input.amount <= 0) throw httpError(400, "充值金额必须大于0");

  const expire = new Date(input.expireTime);
  if (expire <= new Date()) throw httpError(400, "到期时间必须晚于当前时间");

  return withClient(async (client) => {
    const { rows } = await client.query(
      `select id from admin.tenant_manage where schema_name = $1 and status = 'ACTIVE' and deleted = false`,
      [input.schemaName]
    );
    if (rows.length === 0) throw httpError(404, "租户不存在");

    const recordId = randomUUID();
    await client.query(
      `insert into admin.tenant_recharge_record(id, schema_name, amount, expire_time, operator_id, remark)
       values($1,$2,$3,$4,$5,$6)`,
      [recordId, input.schemaName, input.amount, input.expireTime, input.operatorId, input.remark ?? null]
    );

    await client.query(
      `update admin.tenant_manage set expire_time = $1, updated_at = now() where schema_name = $2`,
      [input.expireTime, input.schemaName]
    );

    return { recordId, newExpireTime: input.expireTime };
  });
}

export async function listRechargeRecords(filters?: { schemaName?: string; page?: number; pageSize?: number }) {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (filters?.schemaName) {
    conditions.push(`schema_name = $${idx}`);
    params.push(filters.schemaName);
    idx++;
  }

  const where = conditions.length > 0 ? `where ${conditions.join(" and ")}` : "";
  const page = filters?.page ?? 1;
  const pageSize = filters?.pageSize ?? 20;
  const offset = (page - 1) * pageSize;

  const { rows: countRows } = await pool.query(`select count(*) as total from admin.tenant_recharge_record ${where}`, params);
  const { rows } = await pool.query(
    `select id, schema_name, amount, expire_time, operator_id, remark, created_at from admin.tenant_recharge_record ${where} order by created_at desc limit $${idx} offset $${idx + 1}`,
    [...params, pageSize, offset]
  );

  return { total: Number(countRows[0].total), records: rows };
}