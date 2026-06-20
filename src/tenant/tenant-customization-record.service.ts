import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";

export async function writeCustomizationRecord(input: {
  schemaName: string;
  sessionId: string;
  userId: string;
  chatRound: { userInput: string; aiReply: string; dslDiff: unknown; timestamp: string };
  skillMdSnapshot?: string;
  changeSummary?: Record<string, unknown> | string;
}) {
  const { rows: existing } = await pool.query(
    `select id, chat_rounds from admin.agent_customization_record where session_id = $1`,
    [input.sessionId]
  );

  if (existing[0]) {
    const rounds = existing[0].chat_rounds ?? [];
    rounds.push(input.chatRound);
    await pool.query(
      `update admin.agent_customization_record set chat_rounds = $1, skill_md_snapshot = coalesce($2, skill_md_snapshot), change_summary = coalesce($3, change_summary), updated_at = now() where session_id = $4`,
      [JSON.stringify(rounds), input.skillMdSnapshot ?? null, input.changeSummary ? JSON.stringify(input.changeSummary) : null, input.sessionId]
    );
    return existing[0].id;
  }

  const id = randomUUID();
  await pool.query(
    `insert into admin.agent_customization_record(id, schema_name, session_id, user_id, chat_rounds, skill_md_snapshot, change_summary)
      values($1,$2,$3,$4,$5,$6,$7)`,
     [id, input.schemaName, input.sessionId, input.userId, JSON.stringify([input.chatRound]), input.skillMdSnapshot ?? null, input.changeSummary ? JSON.stringify(input.changeSummary) : "{}"]
  );
  return id;
}

export async function listCustomizationRecords(filters?: { schemaName?: string; page?: number; pageSize?: number }) {
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

  const { rows: countRows } = await pool.query(`select count(*) as total from admin.agent_customization_record ${where}`, params);
  const { rows } = await pool.query(
    `select id, schema_name, session_id, user_id, change_summary, created_at, updated_at from admin.agent_customization_record ${where} order by created_at desc limit $${idx} offset $${idx + 1}`,
    [...params, pageSize, offset]
  );

  return { total: Number(countRows[0].total), records: rows };
}

export async function getCustomizationRecordDetail(recordId: string) {
  const { rows } = await pool.query(
    `select * from admin.agent_customization_record where id = $1`,
    [recordId]
  );
  return rows[0] ?? null;
}
