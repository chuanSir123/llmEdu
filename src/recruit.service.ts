import { randomUUID } from "node:crypto";
import { pool, withClient } from "./db/pool.js";
import { qIdent } from "./db/schema-resolver.js";
import type { SessionUser } from "./types.js";

type Row = Record<string, unknown>;

function table(schemaName: string, tableName: string) {
  return `${qIdent(schemaName)}.${qIdent(tableName)}`;
}

function str(value: unknown, fallback = "") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function stageFromFollowResult(result: string) {
  if (["INVITE_TRIAL", "TRIAL_SCHEDULED"].includes(result)) return "TRIAL_SCHEDULED";
  if (["VISIT_SCHEDULED", "INVITE_VISIT"].includes(result)) return "VISIT_SCHEDULED";
  if (["CONTACTED", "PHONE_CONNECTED", "WECHAT_CONNECTED"].includes(result)) return "CONTACTED";
  if (["LOST", "NO_INTENTION", "INVALID"].includes(result)) return "LOST";
  if (["CONVERTED", "ENROLLED"].includes(result)) return "CONVERTED";
  return "FOLLOWING";
}

async function latestLeadStage(client: { query: typeof pool.query }, schemaName: string, studentId: string) {
  const { rows } = await client.query(
    `select * from ${table(schemaName, "lead_stage_record")} where student_id = $1 and deleted = false order by updated_at desc nulls last, created_at desc nulls last limit 1`,
    [studentId]
  );
  return rows[0] as Row | undefined;
}

async function writeAssignmentHistory(client: { query: typeof pool.query }, schemaName: string, input: { studentId: string; fromUserId?: string; toUserId?: string; action: string; reason?: string; operatorId?: string }) {
  await client.query(
    `insert into ${table(schemaName, "lead_assignment_history")}(id, student_id, from_user_id, to_user_id, action_type, reason, operator_id)
     values($1,$2,$3,$4,$5,$6,$7)`,
    [randomUUID(), input.studentId, input.fromUserId || null, input.toUserId || null, input.action, input.reason || null, input.operatorId || null]
  );
}


export async function createLeadStudent(schemaName: string, params: Row, user?: SessionUser) {
  const data = (params.data ?? params) as Row;
  const name = str(data.name, "");
  const contact = str(data.contact, "");
  if (!name || !contact) throw Object.assign(new Error("新增意向学员必须填写姓名和电话"), { statusCode: 400 });
  return withClient(async (client) => {
    await client.query("begin");
    try {
      const studentId = str(params.id, randomUUID());
      const ownerUserId = data.owner_user_id ?? data.ownerUserId ?? user?.userId ?? null;
      const channelId = data.channel_id ?? data.channelId ?? null;
      await client.query(
        `insert into ${table(schemaName, "student")}(id, name, contact, organization_id, student_status, source_type, owner_user_id, school_name, grade, remark, ext_json, created_by, updated_by)
         values($1,$2,$3,$4,'LEAD',$5,$6,$7,$8,$9,$10::jsonb,$11,$11)`,
        [
          studentId,
          name,
          contact,
          data.organization_id ?? data.organizationId ?? null,
          data.source_type ?? data.sourceType ?? "MANUAL",
          ownerUserId,
          data.school_name ?? data.schoolName ?? null,
          data.grade ?? null,
          data.remark ?? null,
          JSON.stringify({ source: "recruit_manual", channelId }),
          user?.userId ?? null
        ]
      );
      const stageId = randomUUID();
      await client.query(
        `insert into ${table(schemaName, "lead_stage_record")}(id, student_id, stage, owner_user_id, channel_id, status, next_action, next_follow_time, remark, created_by, updated_by)
         values($1,$2,'NEW',$3,$4,$5,'首次跟进',$6,$7,$8,$8)`,
        [stageId, studentId, ownerUserId, channelId, ownerUserId ? "PRIVATE" : "PUBLIC", data.next_follow_time ?? data.nextFollowTime ?? null, data.remark ?? null, user?.userId ?? null]
      );
      if (channelId) {
        await client.query(`update ${table(schemaName, "recruit_channel")} set lead_count = coalesce(lead_count,0) + 1, updated_at = now() where id = $1`, [channelId]);
      }
      await client.query("commit");
      return { id: studentId, studentId, leadStageId: stageId };
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

export async function assignLead(schemaName: string, params: Row, user?: SessionUser) {
  const studentId = str(params.student_id ?? params.studentId, "");
  const ownerUserId = str(params.owner_user_id ?? params.ownerUserId, "");
  if (!studentId || !ownerUserId) throw Object.assign(new Error("分配意向学员必须提供学员和负责人"), { statusCode: 400 });
  return withClient(async (client) => {
    await client.query("begin");
    try {
      const current = await latestLeadStage(client, schemaName, studentId);
      const stageId = str(current?.id, randomUUID());
      if (current?.id) {
        await client.query(
          `update ${table(schemaName, "lead_stage_record")} set owner_user_id = $2, status = 'PRIVATE', updated_at = now() where id = $1`,
          [stageId, ownerUserId]
        );
      } else {
        await client.query(
          `insert into ${table(schemaName, "lead_stage_record")}(id, student_id, stage, owner_user_id, status, next_action) values($1,$2,'NEW',$3,'PRIVATE','首次跟进')`,
          [stageId, studentId, ownerUserId]
        );
      }
      await writeAssignmentHistory(client, schemaName, { studentId, fromUserId: str(current?.owner_user_id), toUserId: ownerUserId, action: "ASSIGN", reason: str(params.reason), operatorId: user?.userId });
      await client.query("commit");
      return { studentId, ownerUserId, assigned: true };
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

export async function claimLead(schemaName: string, params: Row, user?: SessionUser) {
  const ownerUserId = str(params.owner_user_id ?? params.ownerUserId ?? user?.userId, "");
  return assignLead(schemaName, { ...params, owner_user_id: ownerUserId, reason: params.reason ?? "领取意向学员" }, user);
}

export async function recycleLead(schemaName: string, params: Row, user?: SessionUser) {
  const studentId = str(params.student_id ?? params.studentId, "");
  if (!studentId) throw Object.assign(new Error("回收意向学员必须提供学员"), { statusCode: 400 });
  return withClient(async (client) => {
    await client.query("begin");
    try {
      const current = await latestLeadStage(client, schemaName, studentId);
      if (!current?.id) throw Object.assign(new Error("招生阶段不存在"), { statusCode: 404 });
      await client.query(`update ${table(schemaName, "lead_stage_record")} set owner_user_id = null, status = 'PUBLIC', updated_at = now() where id = $1`, [current.id]);
      await writeAssignmentHistory(client, schemaName, { studentId, fromUserId: str(current.owner_user_id), action: "RECYCLE", reason: str(params.reason, "手动回收"), operatorId: user?.userId });
      await client.query("commit");
      return { studentId, recycled: true };
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

export async function createStudentFollowup(schemaName: string, params: Row, user?: SessionUser) {
  const data = (params.data ?? params) as Row;
  const studentId = str(data.student_id ?? data.studentId, "");
  if (!studentId) throw Object.assign(new Error("跟进记录必须选择学员"), { statusCode: 400 });
  const followResult = str(data.follow_result ?? data.followResult, "CONTACTED");
  const nextFollowTime = data.next_follow_time ?? data.nextFollowTime ?? null;
  return withClient(async (client) => {
    await client.query("begin");
    try {
      const followId = str(params.id, randomUUID());
      const stage = stageFromFollowResult(followResult);
      let current = await latestLeadStage(client, schemaName, studentId);
      if (!current?.id) {
        const leadStageId = randomUUID();
        await client.query(
          `insert into ${table(schemaName, "lead_stage_record")}(id, student_id, stage, owner_user_id, status, next_follow_time, next_action) values($1,$2,$3,$4,'PRIVATE',$5,'跟进后更新')`,
          [leadStageId, studentId, stage, data.follow_user_id ?? user?.userId ?? null, nextFollowTime]
        );
        current = { id: leadStageId, owner_user_id: data.follow_user_id ?? user?.userId ?? null };
      }
      await client.query(
        `insert into ${table(schemaName, "student_followup")}(id, student_id, lead_stage_id, follow_user_id, follow_type, follow_content, follow_result, next_follow_time, ext_json)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
        [
          followId,
          studentId,
          current?.id ?? null,
          data.follow_user_id ?? user?.userId ?? null,
          data.follow_type ?? null,
          data.follow_content ?? null,
          followResult,
          nextFollowTime,
          JSON.stringify({ source: "recruit_followup", leadStageId: current?.id ?? null })
        ]
      );
      if (current?.id) {
        await client.query(
          `update ${table(schemaName, "lead_stage_record")} set stage = $2, status = case when $2 = 'LOST' then 'LOST' else status end, next_follow_time = $3, lost_reason = case when $2 = 'LOST' then $4 else lost_reason end, updated_at = now() where id = $1`,
          [current.id, stage, nextFollowTime, data.lost_reason ?? data.lostReason ?? data.follow_content ?? null]
        );
      }
      if (nextFollowTime) {
        await client.query(
          `insert into ${table(schemaName, "sales_task")}(id, task_title, student_id, owner_user_id, task_type, due_time, task_status, remark)
           values($1,'下次跟进',$2,$3,'FOLLOW_UP',$4,'PENDING',$5)`,
          [randomUUID(), studentId, data.follow_user_id ?? user?.userId ?? current?.owner_user_id ?? null, nextFollowTime, data.follow_content ?? null]
        );
      }
      await client.query("commit");
      return { id: followId, studentId, stage, taskCreated: Boolean(nextFollowTime) };
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

export async function createTrialLesson(schemaName: string, params: Row, user?: SessionUser) {
  const data = (params.data ?? params) as Row;
  const studentId = str(data.student_id ?? data.studentId, "");
  const courseTitle = str(data.course_title ?? data.courseTitle, "试听课");
  if (!studentId) throw Object.assign(new Error("试听邀约必须选择学员"), { statusCode: 400 });
  return withClient(async (client) => {
    await client.query("begin");
    try {
      const trialId = str(params.id, randomUUID());
      const courseId = randomUUID();
      await client.query(
        `insert into ${table(schemaName, "generic_course")}(id, course_type, course_date, start_time, end_time, teacher_id, organization_id, course_title, course_hour, course_status, ext_json)
         values($1,'TRIAL',$2,$3,$4,$5,$6,$7,$8,'SCHEDULED',$9::jsonb)`,
        [courseId, data.course_date ?? data.courseDate ?? null, data.start_time ?? data.startTime ?? null, data.end_time ?? data.endTime ?? null, data.teacher_id ?? data.teacherId ?? null, data.organization_id ?? data.organizationId ?? null, courseTitle, data.course_hour ?? data.courseHour ?? 1, JSON.stringify({ source: "trial_lesson", trialId })]
      );
      await client.query(`insert into ${table(schemaName, "generic_course_student")}(id, course_id, student_id, attendance_status) values($1,$2,$3,'PENDING')`, [randomUUID(), courseId, studentId]);
      await client.query(
        `insert into ${table(schemaName, "trial_lesson")}(id, student_id, course_id, course_title, trial_time, teacher_id, sales_user_id, trial_status, feedback, conversion_status, remark)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [trialId, studentId, courseId, courseTitle, data.trial_time ?? data.trialTime ?? null, data.teacher_id ?? data.teacherId ?? null, data.sales_user_id ?? data.salesUserId ?? user?.userId ?? null, data.trial_status ?? data.trialStatus ?? "SCHEDULED", data.feedback ?? null, data.conversion_status ?? data.conversionStatus ?? "PENDING", data.remark ?? null]
      );
      const current = await latestLeadStage(client, schemaName, studentId);
      if (current?.id) await client.query(`update ${table(schemaName, "lead_stage_record")} set stage = 'TRIAL_SCHEDULED', status = 'PRIVATE', updated_at = now() where id = $1`, [current.id]);
      await client.query(
        `insert into ${table(schemaName, "sales_task")}(id, task_title, student_id, owner_user_id, task_type, due_time, task_status, remark)
         values($1,'试听后回访',$2,$3,'TRIAL_FOLLOW_UP',$4,'PENDING','试听结束后跟进转化')`,
        [randomUUID(), studentId, data.sales_user_id ?? data.salesUserId ?? user?.userId ?? current?.owner_user_id ?? null, data.trial_time ?? data.trialTime ?? null]
      );
      await client.query("commit");
      return { id: trialId, courseId, studentId };
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}
