import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";

type StoredChatRound = {
  userInput?: string;
  aiReply?: string;
  dslDiff?: unknown;
  timestamp?: string;
};

export async function writeCustomizationRecord(input: {
  schemaName: string;
  sessionId: string;
  userId: string;
  recordType?: "assistant" | "customization";
  chatRound: { userInput: string; aiReply: string; dslDiff: unknown; timestamp: string };
  skillMdSnapshot?: string;
  changeSummary?: Record<string, unknown> | string;
}) {
  const recordType = input.recordType ?? "customization";
  const userPrompt = input.chatRound.userInput;
  const { rows: existing } = await pool.query(
    `select id, chat_rounds from admin.agent_customization_record where session_id = $1`,
    [input.sessionId]
  );

  if (existing[0]) {
    const rounds = existing[0].chat_rounds ?? [];
    rounds.push(input.chatRound);
    await pool.query(
      `update admin.agent_customization_record
       set chat_rounds = $1, skill_md_snapshot = coalesce($2, skill_md_snapshot), change_summary = coalesce($3, change_summary),
           record_type = $4, user_prompt = coalesce(nullif(user_prompt, ''), $5), updated_at = now()
       where session_id = $6`,
      [JSON.stringify(rounds), input.skillMdSnapshot ?? null, input.changeSummary ? JSON.stringify(input.changeSummary) : null, recordType, userPrompt, input.sessionId]
    );
    return existing[0].id;
  }

  const id = randomUUID();
  await pool.query(
    `insert into admin.agent_customization_record(id, schema_name, session_id, user_id, record_type, user_prompt, chat_rounds, skill_md_snapshot, change_summary)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
     [id, input.schemaName, input.sessionId, input.userId, recordType, userPrompt, JSON.stringify([input.chatRound]), input.skillMdSnapshot ?? null, input.changeSummary ? JSON.stringify(input.changeSummary) : "{}"]
  );
  return id;
}

export async function listCustomizationRecords(filters?: { schemaName?: string; recordType?: "assistant" | "customization"; page?: number; pageSize?: number }) {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (filters?.schemaName) {
    conditions.push(`schema_name = $${idx}`);
    params.push(filters.schemaName);
    idx++;
  }
  if (filters?.recordType) {
    conditions.push(`record_type = $${idx}`);
    params.push(filters.recordType);
    idx++;
  }

  const where = conditions.length > 0 ? `where ${conditions.join(" and ")}` : "";
  const page = filters?.page ?? 1;
  const pageSize = filters?.pageSize ?? 20;
  const offset = (page - 1) * pageSize;

  const { rows: countRows } = await pool.query(`select count(*) as total from admin.agent_customization_record ${where}`, params);
  const { rows } = await pool.query(
    `select id, schema_name, session_id, user_id, record_type, user_prompt, change_summary, created_at, updated_at from admin.agent_customization_record ${where} order by created_at desc limit $${idx} offset $${idx + 1}`,
    [...params, pageSize, offset]
  );

  return { total: Number(countRows[0].total), records: rows };
}

export async function getCustomizationRecordDetail(recordId: string) {
  const { rows } = await pool.query(
    `select * from admin.agent_customization_record where id = $1`,
    [recordId]
  );
  const row = rows[0];
  if (!row) return { record: null };

  const rounds = Array.isArray(row.chat_rounds) ? (row.chat_rounds as StoredChatRound[]) : [];
  const chatTimeline = rounds.flatMap((round) => [
    {
      role: "user",
      content: round.userInput ?? "",
      timestamp: round.timestamp ?? row.created_at
    },
    {
      role: "assistant",
      content: round.aiReply ?? "",
      dslDiff: round.dslDiff,
      timestamp: round.timestamp ?? row.updated_at ?? row.created_at
    }
  ]);

  const changeSummary = typeof row.change_summary === "string"
    ? row.change_summary
    : JSON.stringify(row.change_summary ?? {}, null, 2);

  return {
    record: {
      id: row.id,
      schemaName: row.schema_name,
      sessionId: row.session_id,
      recordType: row.record_type ?? "customization",
      userPrompt: row.user_prompt ?? "",
      changeSummary,
      skillMd: row.skill_md_snapshot ?? "",
      chatTimeline
    }
  };
}
