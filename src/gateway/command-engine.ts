import type pg from "pg";
import { withClient } from "../db/pool.js";
import { qIdent } from "../db/schema-resolver.js";
import { withRedisLock } from "../redis-lock.service.js";
import { TEMPLATE_SCHEMA } from "../common/template-schema.js";

type CommandDsl = {
  operation: "command";
  command: "contract.create" | "contract.update" | "funds.create" | "funds.delete" | "course.create" | "course.update" | "chargeRecord.create" | "refund.create"
    | "contract.refund" | "contract.delete" | "refund.delete" | "course.delete" | "ledger.denyMutation"
    | "attendance.checkIn" | "attendance.cancel" | "leave.create" | "makeup.create" | "classStudent.transfer" | "class.changeStatus"
    | "miniClass.addStudent" | "miniClass.removeStudent" | "oneOnNGroup.addStudent" | "oneOnNGroup.removeStudent"
    | "chargeRecord.reverse" | "chargeRecord.preview" | "course.cancel" | "course.student.save" | "holiday.apply"
    | "moneyArrange.save" | "promotionArrange.save" | "performanceArrange.save"
    | "student.assignManager" | "product.grant.save" | "product.promotion.save"
    | "approval.submit" | "approval.approve" | "approval.reject" | "approval.cancel"
    | "role.permission.save" | "user.create" | "user.update" | "user.softDelete" | "user.resetPassword"
    | "contract.transition_status" | "audit.list" | "report.student" | "report.finance" | "report.course";
  ruleCode: string;
};

type BusinessRule = Record<string, unknown>;

function table(schemaName: string, tableName: string) {
  return `${qIdent(schemaName)}.${tableName === "user" ? `"user"` : qIdent(tableName)}`;
}

async function nextTextId(client: pg.PoolClient, schemaName: string, tableName: string) {
  const sequence = `${tableName}_id_seq`;
  await client.query(`create sequence if not exists ${qIdent(schemaName)}.${qIdent(sequence)} start 100000`);
  const { rows } = await client.query(`select nextval('${qIdent(schemaName)}.${qIdent(sequence)}'::regclass)::text as id`);
  return rows[0].id as string;
}

function dataOf(params: Record<string, unknown>) {
  return (params.data ?? params) as Record<string, unknown>;
}

function num(value: unknown, fallback = 0) {
  const next = Number(value ?? fallback);
  return Number.isFinite(next) ? next : fallback;
}

function str(value: unknown, fallback = "") {
  return value === undefined || value === null || value === "" ? fallback : String(value);
}

// 字典值双格式兼容：导入/助手链路可能传字典项 ID 形态（如 charge_type.NORMAL），业务分支与落库统一使用裸值
function dictBare(value: unknown, fallback = "") {
  const text = str(value, fallback);
  const dotIndex = text.indexOf(".");
  return dotIndex > 0 ? text.slice(dotIndex + 1) : text;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === "object" && !Array.isArray(item)) as Record<string, unknown>[] : [];
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function floorMoney(value: number) {
  return Math.floor((value + 1e-9) * 100) / 100;
}

function allocateByWeightCents(total: number, weights: number[]) {
  if (!weights.length) return [] as number[];
  const totalCents = Math.round(num(total) * 100);
  const weightSum = weights.reduce((sum, weight) => sum + Math.max(num(weight), 0), 0);
  let remainingCents = totalCents;
  return weights.map((weight, index) => {
    const shareCents = index === weights.length - 1
      ? remainingCents
      : weightSum > 0 ? Math.floor(totalCents * (Math.max(num(weight), 0) / weightSum) + 1e-9) : 0;
    remainingCents -= shareCents;
    return shareCents / 100;
  });
}


async function assertUpdated(result: pg.QueryResult, message = "数据已被其他操作修改，请刷新后重试") {
  if (result.rowCount !== 1) throw Object.assign(new Error(message), { statusCode: 409 });
}


function commandLockKey(schemaName: string, command: string, params: Record<string, unknown>) {
  const input = dataOf(params);
  const ids = [
    input.contract_product_id,
    input.contract_id,
    input.course_id,
    input.student_id,
    input.mini_class_id,
    input.one_on_n_group_id,
    input.id,
    params.id,
  ].map((value) => str(value)).filter(Boolean).join(":") || "global";
  return `lock:${schemaName}:command:${command}:${ids}`;
}

function shouldRedisLockCommand(command: string) {
  return [
    "contract.create", "contract.update", "funds.create", "funds.delete", "refund.create", "contract.refund", "contract.delete", "refund.delete",
    "course.create", "course.update", "course.delete", "course.cancel", "course.student.save",
    "chargeRecord.create", "chargeRecord.reverse", "attendance.checkIn", "attendance.cancel",
    "miniClass.addStudent", "miniClass.removeStudent", "oneOnNGroup.addStudent", "oneOnNGroup.removeStudent",
    "classStudent.transfer", "class.changeStatus", "moneyArrange.save", "promotionArrange.save", "performanceArrange.save",
    "product.grant.save", "product.promotion.save", "contract.transition_status"
  ].includes(command);
}

async function withCommandRedisLock<T>(schemaName: string, command: string, params: Record<string, unknown>, fn: () => Promise<T>) {
  if (!shouldRedisLockCommand(command)) return fn();
  return withRedisLock(commandLockKey(schemaName, command, params), fn, 20_000);
}

async function loadRule(client: pg.PoolClient, schemaName: string, ruleCode: string): Promise<BusinessRule> {
  const { rows } = await client.query(
    `select rule_json
     from admin.business_rule
     where rule_code = $1 and status = 'active' and deleted = false
       and ((schema_scope = 'tenant' and schema_name = $2) or (schema_scope = 'tenant' and schema_name = '${TEMPLATE_SCHEMA}'))
     order by case when schema_scope = 'tenant' and schema_name = $2 then 0 when schema_scope = 'tenant' and schema_name = '${TEMPLATE_SCHEMA}' then 1 else 2 end
     limit 1`,
    [ruleCode, schemaName]
  );
  return rows[0]?.rule_json ?? {};
}

function commandApprovalHint(command: CommandDsl["command"]) {
  const map: Partial<Record<CommandDsl["command"], { flowCode: string; businessType: string; event: string; pageCode: string; actionCode: string; require?: boolean }>> = {
    "contract.create": { flowCode: "contract_create_approval", businessType: "contract_create", event: "contract_create_submit", pageCode: "contract_list", actionCode: "contract_list.create" },
    "contract.update": { flowCode: "contract_update_approval", businessType: "contract_update", event: "contract_update_submit", pageCode: "contract_list", actionCode: "contract_list.edit" },
    "funds.create": { flowCode: "funds_create_approval", businessType: "funds_create", event: "funds_create_submit", pageCode: "funds_history", actionCode: "funds_history.create" },
    "refund.create": { flowCode: "refund_create_approval", businessType: "refund_create", event: "refund_create_submit", pageCode: "refund_record", actionCode: "refund_record.create" },
    "course.create": { flowCode: "course_create_approval", businessType: "course_create", event: "course_create_submit", pageCode: "course_list", actionCode: "course_list.create" },
    "course.delete": { flowCode: "course_delete_approval", businessType: "course_delete", event: "course_delete_submit", pageCode: "course_list", actionCode: "course_list.delete", require: true },
    "chargeRecord.reverse": { flowCode: "charge_reverse_approval", businessType: "charge_reverse", event: "charge_reverse_submit", pageCode: "charge_record", actionCode: "charge_record.reverse" },
  };
  return map[command];
}

async function resolveApproverUserId(client: pg.PoolClient, schemaName: string, assigneeRole: string, organizationId?: string) {
  if (!assigneeRole) return null;
  const values: unknown[] = [assigneeRole];
  let orgWhere = "";
  if (organizationId) {
    values.push(organizationId);
    orgWhere = `and (u.organization_id = $2 or u.organization_id is null)`;
  }
  const { rows } = await client.query(
    `select u.id
     from ${table(schemaName, "user")} u
     left join ${table(schemaName, "user_role")} ur on ur.user_id = u.id and ur.deleted = false
     left join ${table(schemaName, "role")} r on r.id = ur.role_id and r.deleted = false
     where u.deleted = false and u.status = 'ACTIVE'
       and (upper(coalesce(u.staff_type,'')) = upper($1) or upper(coalesce(r.role_code,'')) = upper($1))
       ${orgWhere}
     order by case when u.organization_id = ${organizationId ? "$2" : "u.organization_id"} then 0 else 1 end, u.created_at asc
     limit 1`,
    values
  );
  return rows[0]?.id ? String(rows[0].id) : null;
}

async function insertApprovalLog(client: pg.PoolClient, schemaName: string, taskId: string, action: string, userId: string, comment: string, step?: Record<string, unknown>, snapshot: Record<string, unknown> = {}) {
  await client.query(
    `insert into ${table(schemaName, "approval_task_log")} (id, task_id, step_code, step_name, action, operator_user_id, comment, snapshot_json)
     values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [await nextTextId(client, schemaName, "approval_task_log"), taskId, step?.stepCode ?? null, step?.stepName ?? null, action, userId || null, comment || null, JSON.stringify(snapshot)]
  );
}

async function submitApprovalTask(client: pg.PoolClient, schemaName: string, params: Record<string, unknown>) {
  const input = dataOf(params);
  const userId = str(input.applicant_user_id ?? params.__userId);
  const flowCode = str(input.flow_code ?? input.flowCode);
  const businessType = str(input.business_type ?? input.businessType);
  const event = str(input.event);
  const values: unknown[] = [];
  const where = ["deleted = false", "status = 'ACTIVE'"];
  if (flowCode) { values.push(flowCode); where.push(`flow_code = $${values.length}`); }
  if (!flowCode && businessType) { values.push(businessType); where.push(`coalesce(config_json->>'businessType', config_json->>'business_type') = $${values.length}`); }
  if (!flowCode && !businessType && event) { values.push(event); where.push(`config_json->'trigger'->>'event' = $${values.length}`); }
  const { rows } = await client.query(`select * from ${table(schemaName, "approval_flow")} where ${where.join(" and ")} order by updated_at desc limit 1`, values);
  const flow = rows[0] as Record<string, unknown> | undefined;
  if (!flow) throw new Error("未找到启用的审批流");
  const config = asObject(flow.config_json);
  const steps = asArray(config.steps);
  const firstStep = steps[0] ?? {};
  const organizationId = str(input.organization_id ?? input.organizationId);
  const approverId = await resolveApproverUserId(client, schemaName, str(firstStep.assigneeRole), organizationId);
  const taskId = str(input.id, await nextTextId(client, schemaName, "approval_task"));
  const formJson = {
    ...asObject(input.form_json),
    flowCode: flow.flow_code,
    flowName: flow.name,
    trigger: asObject(config.trigger),
    steps,
    afterApproved: Array.isArray(config.afterApproved) ? config.afterApproved : [],
    originalCommand: input.originalCommand,
    originalRuleCode: input.originalRuleCode,
    originalParams: input.originalParams,
    submittedAt: new Date().toISOString(),
  };
  await client.query(
    `insert into ${table(schemaName, "approval_task")}
       (id, flow_id, business_type, business_id, applicant_user_id, current_approver_user_id, status, current_step_index, form_json, organization_id)
     values ($1,$2,$3,$4,$5,$6,'PENDING',0,$7,$8)`,
    [taskId, flow.id, str(input.business_type ?? input.businessType ?? config.businessType), str(input.business_id ?? input.businessId), userId || null, approverId, JSON.stringify(formJson), organizationId || null]
  );
  await insertApprovalLog(client, schemaName, taskId, "SUBMIT", userId, str(input.comment, "发起审批"), firstStep, { status: "PENDING" });
  return { approvalRequired: true, taskId, status: "PENDING", flowCode: flow.flow_code, currentApproverUserId: approverId };
}


async function transitionContractStatus(client: pg.PoolClient, schemaName: string, params: Record<string, unknown>) {
  const input = dataOf(params);
  const contractId = str(input.contract_id ?? input.contractId ?? input.id ?? params.id);
  const targetStatus = str(input.target_status ?? input.targetStatus ?? input.status);
  if (!contractId) throw new Error("缺少合同 ID");
  if (!/^[A-Za-z][A-Za-z0-9_]{0,80}$/.test(targetStatus)) throw Object.assign(new Error(`目标合同状态不合法: ${targetStatus}`), { statusCode: 400 });
  const allowedFrom = Array.isArray(input.allowedFrom ?? input.allowed_from) ? (input.allowedFrom ?? input.allowed_from) as unknown[] : [];
  const fromPolicy = str(input.fromPolicy ?? input.from_policy, allowedFrom.length ? "any_of" : "any");
  const values: unknown[] = [targetStatus, JSON.stringify({
    reason: str(input.reason, "业务事件状态流转"),
    operatorId: params.__userId ?? null,
    eventRule: params.__eventRule ?? null,
    changedAt: new Date().toISOString()
  }), contractId];
  let guard = "";
  if (fromPolicy === "any_of" && allowedFrom.length) {
    values.push(allowedFrom.map(String));
    guard = ` and contract_status = any($${values.length}::text[])`;
  }
  const { rows } = await client.query(
    `update ${table(schemaName, "contract")}
       set contract_status = $1,
           ext_json = coalesce(ext_json, '{}'::jsonb) || jsonb_build_object('lastStatusTransition', $2::jsonb),
           updated_at = now()
     where id = $3 and deleted = false${guard}
     returning id, contract_status`,
    values
  );
  if (!rows[0]) throw Object.assign(new Error("合同状态已变化或合同不存在，请刷新后重试"), { statusCode: 409 });
  return { id: rows[0].id, contractStatus: rows[0].contract_status };
}

async function runCommandInTransaction(client: pg.PoolClient, schemaName: string, dsl: CommandDsl, params: Record<string, unknown>, simpleFn?: (c: pg.PoolClient, s: string, p: Record<string, unknown>) => Promise<unknown>) {
  if (simpleFn) {
    return ["miniClass.addStudent", "oneOnNGroup.addStudent", "miniClass.removeStudent", "oneOnNGroup.removeStudent"].includes(dsl.command)
      ? await (simpleFn as unknown as (c: pg.PoolClient, s: string, p: Record<string, unknown>, r: BusinessRule) => Promise<unknown>)(client, schemaName, params, await loadRule(client, schemaName, dsl.ruleCode || "course_create_rule"))
      : dsl.command === "chargeRecord.reverse"
          ? await (simpleFn as unknown as (c: pg.PoolClient, s: string, p: Record<string, unknown>, r: BusinessRule) => Promise<unknown>)(client, schemaName, params, await loadRule(client, schemaName, dsl.ruleCode || "charge_create_rule"))
        : ["leave.create", "makeup.create", "classStudent.transfer", "holiday.apply", "course.delete", "course.update"].includes(dsl.command)
          ? await (simpleFn as unknown as (c: pg.PoolClient, s: string, p: Record<string, unknown>, r: BusinessRule) => Promise<unknown>)(client, schemaName, params, await loadRule(client, schemaName, dsl.ruleCode || (dsl.command === "leave.create" ? "leave_create_rule" : dsl.command === "holiday.apply" ? "holiday_course_impact_rule" : dsl.command === "course.delete" ? "course_delete_rule" : dsl.command === "course.update" ? "course_create_rule" : "makeup_create_rule")))
          : await simpleFn(client, schemaName, params);
  }
  const rule = await loadRule(client, schemaName, dsl.ruleCode);
  return dsl.command === "contract.create"
    ? await createContract(client, schemaName, params, rule)
    : dsl.command === "contract.update"
      ? await updateContract(client, schemaName, params, rule)
    : dsl.command === "funds.create"
      ? await createFunds(client, schemaName, params, rule)
      : dsl.command === "course.create"
        ? await createCourse(client, schemaName, params, rule)
        : dsl.command === "chargeRecord.create"
          ? await createCharge(client, schemaName, params, rule)
          : dsl.command === "contract.refund"
            ? await contract_refund(client, schemaName, params, rule)
            : dsl.command === "attendance.checkIn"
              ? await attendance_check_in(client, schemaName, params, rule)
              : await createRefund(client, schemaName, params, rule);
}

async function maybeSubmitApprovalTask(client: pg.PoolClient, schemaName: string, dsl: CommandDsl, params: Record<string, unknown>) {
  if (params.__approvalApproved || dsl.command.startsWith("approval.")) return undefined;
  const hint = commandApprovalHint(dsl.command);
  if (!hint) return undefined;
  const input = dataOf(params);
  if (dsl.command === "contract.create" && num(input.promotion_amount) > 0) hint.flowCode = "contract_discount_approval";
  const existingTaskId = str(input.approval_task_id ?? input.approvalTaskId);
  if (existingTaskId) {
    const task = await one(client, `select status from ${table(schemaName, "approval_task")} where id = $1 and deleted = false`, [existingTaskId]);
    if (task?.status === "APPROVED") return undefined;
    throw new Error("审批未通过，不能执行业务动作");
  }
  const { rows } = await client.query(`select id from ${table(schemaName, "approval_flow")} where flow_code = $1 and status = 'ACTIVE' and deleted = false limit 1`, [hint.flowCode]);
  if (!rows[0]) return undefined;
  return submitApprovalTask(client, schemaName, {
    ...params,
    data: {
      flow_code: hint.flowCode,
      business_type: hint.businessType,
      business_id: str(input.id),
      organization_id: input.organization_id,
      event: hint.event,
      originalCommand: dsl.command,
      originalRuleCode: dsl.ruleCode,
      originalParams: { ...params, __userId: undefined },
      form_json: { actionCode: hint.actionCode, payload: input },
      comment: str(input.approval_comment, "系统按规则发起审批"),
    },
  });
}

async function one<T extends Record<string, unknown>>(client: pg.PoolClient, sql: string, values: unknown[]) {
  const { rows } = await client.query(sql, values);
  return rows[0] as T | undefined;
}


async function markRecruitConversion(client: pg.PoolClient, schemaName: string, input: { studentId: string; contractId: string; amount: number }) {
  const { rows } = await client.query(
    `select id, channel_id from ${table(schemaName, "lead_stage_record")}
     where student_id = $1 and deleted = false
     order by updated_at desc nulls last, created_at desc nulls last
     limit 1`,
    [input.studentId]
  );
  const leadStage = rows[0] as { id?: string; channel_id?: string } | undefined;
  if (leadStage?.id) {
    await client.query(
      `update ${table(schemaName, "lead_stage_record")}
       set stage = 'CONVERTED', status = 'CONVERTED', next_action = null, updated_at = now(), ext_json = coalesce(ext_json,'{}'::jsonb) || $2::jsonb
       where id = $1`,
      [leadStage.id, JSON.stringify({ convertedContractId: input.contractId, convertedAmount: input.amount })]
    );
  }
  if (leadStage?.channel_id) {
    await client.query(
      `update ${table(schemaName, "recruit_channel")}
       set conversion_count = coalesce(conversion_count,0) + 1,
           roi_amount = coalesce(roi_amount,0) + $2,
           updated_at = now()
       where id = $1 and deleted = false`,
      [leadStage.channel_id, input.amount]
    );
  }
  await client.query(
    `update ${table(schemaName, "referral_reward")}
     set reward_status = case when reward_status in ('PENDING','LOCKED') then 'ELIGIBLE' else reward_status end,
         issued_at = case when reward_status = 'ISSUED' then issued_at else issued_at end,
         updated_at = now(),
         ext_json = coalesce(ext_json,'{}'::jsonb) || $2::jsonb
     where referred_student_id = $1 and deleted = false`,
    [input.studentId, JSON.stringify({ convertedContractId: input.contractId, convertedAmount: input.amount })]
  );
}

async function createContract(client: pg.PoolClient, schemaName: string, params: Record<string, unknown>, rule: BusinessRule): Promise<Record<string, unknown>> {
  const input = dataOf(params);
  const studentIds = Array.isArray(input.student_ids) ? input.student_ids.map((value) => String(value)).filter(Boolean) : [];
  if (studentIds.length > 1) {
    const contracts = [];
    for (const studentId of studentIds) {
      contracts.push(await createContract(client, schemaName, { ...params, id: undefined, data: { ...input, student_id: studentId, student_ids: undefined } }, rule));
    }
    return { batch: true, count: contracts.length, contracts };
  }
  const singleStudentId = str(input.student_id, studentIds[0]);
  const contractId = str(params.id, await nextTextId(client, schemaName, "contract"));
  const products = Array.isArray(input.contract_products) ? (input.contract_products as Record<string, unknown>[]) : [];
  const productIds = Array.isArray(input.product_ids) ? input.product_ids.map((value) => String(value)).filter(Boolean) : [];
  const defaultProductId = str(input.product_id);
  const contractProductInputs = products.length
    ? products
    : productIds.length
      ? productIds.map((product_id) => ({ product_id }))
      : defaultProductId
        ? [input]
        : [];
  if (!singleStudentId) throw new Error("缺少 student_id");
  if (!contractProductInputs.length) throw new Error("创建合同至少需要一个产品");

  const productInputs: Array<{ item: Record<string, unknown>; product: Record<string, unknown>; productId: string }> = [];
  for (const item of contractProductInputs) {
    const nextItem = item as Record<string, unknown>;
    const productId = str(nextItem.product_id);
    if (!productId) throw new Error("合同产品缺少 product_id");
    const product = await one(client, `select * from ${table(schemaName, "product")} where id = $1 and deleted = false`, [productId]);
    if (!product) throw new Error(`产品不存在: ${productId}`);
    productInputs.push({ item: nextItem, product, productId });
  }

  let totalAmount = num(input.total_amount);
  if (!totalAmount) totalAmount = productInputs.reduce((sum, { item, product }) => sum + num(item.plan_real_amount ?? item.total_amount ?? product.total_amount), 0);

  const promotionId = str(input.promotion_id);
  const promotion = promotionId ? await one(client, `select * from ${table(schemaName, "promotion")} where id = $1 and deleted = false and status = 'ACTIVE'`, [promotionId]) : undefined;
  let promotionAmount = num(input.promotion_amount);
  if (!promotionAmount && promotion) {
    const promotionType = str(promotion.type);
    const promotionValue = num(promotion.value);
    promotionAmount = promotionType === "DISCOUNT" ? roundMoney(totalAmount * Math.max(10 - promotionValue, 0) / 10) : promotionValue;
  }
  promotionAmount = Math.min(Math.max(promotionAmount, 0), totalAmount);
  const signTime = str(input.sign_time, new Date().toISOString());
  const contractType = str(input.contract_type, str(productInputs[0]?.product.product_type, "ONE_ON_ONE_COURSE"));
  // 首付金额不直接写死在合同上，产品创建完成后走 createFunds 生成真实收款流水并排款，保证账实一致
  const initialPaidAmount = num(input.paid_amount);

  const contract = await one(client,
    `insert into ${table(schemaName, "contract")}
      (id, student_id, paid_status, contract_type, organization_id, sign_staff_id, sign_time, total_amount, paid_amount, promotion_amount, contract_status, ext_json)
     values ($1,$2,'UNPAID',$3,$4,$5,$6,$7,0,$8,'ACTIVE',$9)
     returning *`,
    [
      contractId,
      singleStudentId,
      contractType,
      input.organization_id,
      input.sign_staff_id,
      signTime,
      totalAmount,
      promotionAmount,
      JSON.stringify({ ruleCode: "contract_create_rule", rule, promotionId })
    ]
  );

  const convertedStudent = await client.query(
    `update ${table(schemaName, "student")} set student_status = 'FORMAL', updated_at = now() where id = $1 and coalesce(student_status,'') = 'LEAD' returning id`,
    [singleStudentId]
  );
  if (convertedStudent.rows[0]) {
    await markRecruitConversion(client, schemaName, { studentId: singleStudentId, contractId, amount: totalAmount });
  }

  if (promotionAmount > 0 || promotion) {
    await client.query(
      `insert into ${table(schemaName, "contract_promotion_history")}
        (id, contract_id, promotion_id, promotion_snapshot_json, reduce_amount, discount_value)
       values ($1,$2,$3,$4,$5,$6)`,
      [await nextTextId(client, schemaName, "contract_promotion_history"), contractId, promotionId || null, JSON.stringify(promotion ?? { manualPromotionAmount: promotionAmount }), promotionAmount, num(promotion?.value)]
    );
  }

  const rawPlanAmounts = productInputs.map(({ item, product }) => num(item.plan_real_amount ?? item.total_amount ?? product?.total_amount));
  const planRealAmountShares = rawPlanAmounts.reduce((sum, value) => sum + value, 0) > 0
    ? allocateByWeightCents(totalAmount, rawPlanAmounts)
    : rawPlanAmounts.map(roundMoney);
  const allocationMode = str(rule.promotionAllocation, "proportional");
  const promotionShares = allocationMode === "first_product"
    ? productInputs.map((_, index) => index === 0 ? roundMoney(promotionAmount) : 0)
    : allocateByWeightCents(promotionAmount, planRealAmountShares);
  const productRows = [];
  for (let index = 0; index < productInputs.length; index += 1) {
    const { item, product, productId } = productInputs[index];
    const planRealHour = num(item.plan_real_hour ?? item.default_course_hour ?? product?.default_course_hour);
    const planRealAmount = planRealAmountShares[index];
    const planPromotionAmount = num(item.plan_promotion_amount) > 0 ? roundMoney(num(item.plan_promotion_amount)) : promotionShares[index];
    const cpId = str(item.id, await nextTextId(client, schemaName, "contract_product"));
    const cp = await one(client,
      `insert into ${table(schemaName, "contract_product")}
        (id, contract_id, product_id, plan_real_hour, plan_promotion_hour, plan_real_amount, plan_promotion_amount,
         remaining_real_hour, remaining_promotion_hour, remaining_real_amount, remaining_promotion_amount, ext_json)
       values ($1,$2,$3,$4,$5,$6,$7,$4,$5,$6,$7,$8)
       returning *`,
      [cpId, contractId, productId, planRealHour, num(item.plan_promotion_hour), planRealAmount, planPromotionAmount, JSON.stringify({ ruleCode: "contract_create_rule" })]
    );
    productRows.push(cp);
    if (planPromotionAmount > 0) {
      await client.query(
        `insert into ${table(schemaName, "contract_product_promotion_history")}
          (id, contract_product_id, promotion_id, promotion_snapshot_json, reduce_amount)
         values ($1,$2,$3,$4,$5)`,
        [await nextTextId(client, schemaName, "contract_product_promotion_history"), cpId, promotionId || null, JSON.stringify(promotion ?? { allocationMode }), planPromotionAmount]
      );
    }
  }

  let contractRow = contract;
  if (initialPaidAmount > 0) {
    const fundsRule = await loadRule(client, schemaName, "funds_create_rule");
    await createFunds(client, schemaName, {
      data: {
        contract_id: contractId,
        student_id: singleStudentId,
        transaction_amount: initialPaidAmount,
        transaction_time: signTime,
        pay_way_config_id: input.pay_way_config_id,
        funds_type: "CONTRACT_PAY",
        organization_id: input.organization_id,
        remark: str(input.remark, "签约收款"),
      },
    }, fundsRule);
    contractRow = await one(client, `select * from ${table(schemaName, "contract")} where id = $1`, [contractId]) ?? contract;
  }
  return { contract: contractRow, contractProducts: productRows };
}

async function reallocateContractFunds(client: pg.PoolClient, schemaName: string, contractId: string, rule: BusinessRule) {
  const { rows: fundsRows } = await client.query(
    `select * from ${table(schemaName, "funds_change_history")} where contract_id = $1 and deleted = false order by transaction_time asc, created_at asc`,
    [contractId]
  );
  if (!fundsRows.length) return;
  const fundsRule = await loadRule(client, schemaName, "funds_create_rule").catch(() => rule);
  const fundIds = fundsRows.map((row) => row.id);
  await client.query(`update ${table(schemaName, "money_arrange_log")} set deleted = true, updated_at = now() where funds_change_history_id = any($1::text[]) and deleted = false`, [fundIds]);
  await client.query(`update ${table(schemaName, "promotion_arrange_log")} set deleted = true, updated_at = now() where funds_change_history_id = any($1::text[]) and deleted = false`, [fundIds]);
  await client.query(`update ${table(schemaName, "performance_arrange_log")} set deleted = true, updated_at = now() where funds_change_history_id = any($1::text[]) and deleted = false and coalesce((ext_json->>'reversalOf'),'') = ''`, [fundIds]);
  await client.query(
    `update ${table(schemaName, "contract_product")}
     set paid_real_amount = 0, paid_real_hour = 0, paid_promotion_amount = 0, paid_promotion_hour = 0, updated_at = now()
     where contract_id = $1 and deleted = false`,
    [contractId]
  );
  for (const funds of fundsRows) {
    await arrangePayment(client, schemaName, funds.id, contractId, num(funds.transaction_amount), fundsRule);
    await arrangePromotion(client, schemaName, funds.id, contractId, num(funds.transaction_amount));
    await arrangePerformance(client, schemaName, funds.id, contractId, num(funds.transaction_amount));
  }
}

async function updateContract(client: pg.PoolClient, schemaName: string, params: Record<string, unknown>, rule: BusinessRule): Promise<Record<string, unknown>> {
  const input = dataOf(params);
  const contractId = str(params.id, str(input.id));
  if (!contractId) throw new Error("缺少合同 ID");
  const contract = await one(client, `select * from ${table(schemaName, "contract")} where id = $1 and deleted = false for update`, [contractId]);
  if (!contract) throw new Error("合同不存在或已删除");
  const { rows: currentProducts } = await client.query(`select * from ${table(schemaName, "contract_product")} where contract_id = $1 and deleted = false order by created_at asc`, [contractId]);
  const currentProductIds = currentProducts.map((row) => String(row.product_id));
  const productInputs = Array.isArray(input.contract_products) ? (input.contract_products as Record<string, unknown>[]) : [];
  const requestedProductIds = productInputs.length
    ? productInputs.map((item) => str(item.product_id)).filter(Boolean)
    : Array.isArray(input.product_ids)
      ? input.product_ids.map((value) => String(value)).filter(Boolean)
      : currentProductIds;
  if (!requestedProductIds.length) throw new Error("合同至少需要一个报读课程");
  const productsChanged = currentProductIds.length !== requestedProductIds.length || currentProductIds.some((id) => !requestedProductIds.includes(id)) || requestedProductIds.some((id) => !currentProductIds.includes(id));

  const productsById = new Map<string, Record<string, unknown>>();
  for (const productId of requestedProductIds) {
    const product = await one(client, `select * from ${table(schemaName, "product")} where id = $1 and deleted = false`, [productId]);
    if (!product) throw new Error(`产品不存在: ${productId}`);
    productsById.set(productId, product);
  }

  const rawPlanRows = requestedProductIds.map((productId, index) => {
    const product = productsById.get(productId)!;
    const item = productInputs.find((value) => str(value.product_id) === productId) ?? {};
    return {
      productId,
      product,
      planRealHour: num(item.plan_real_hour ?? product.default_course_hour),
      planRealAmount: num(item.plan_real_amount ?? item.total_amount ?? product.total_amount),
      planPromotionHour: num(item.plan_promotion_hour),
      index
    };
  });
  const rawTotalAmount = rawPlanRows.reduce((sum, item) => sum + item.planRealAmount, 0);
  const inputTotalAmount = num(input.total_amount);
  const totalAmount = inputTotalAmount > 0 ? inputTotalAmount : rawTotalAmount;
  const amountScale = rawTotalAmount > 0 && inputTotalAmount > 0 ? inputTotalAmount / rawTotalAmount : 1;

  const hasPromotionIdInput = Object.prototype.hasOwnProperty.call(input, "promotion_id");
  const promotionId = str(input.promotion_id);
  const promotion = promotionId ? await one(client, `select * from ${table(schemaName, "promotion")} where id = $1 and deleted = false and status = 'ACTIVE'`, [promotionId]) : undefined;
  let promotionAmount = Object.prototype.hasOwnProperty.call(input, "promotion_amount") ? num(input.promotion_amount) : num(contract.promotion_amount);
  if (!Object.prototype.hasOwnProperty.call(input, "promotion_amount") && hasPromotionIdInput) {
    const promotionType = str(promotion?.type);
    const promotionValue = num(promotion?.value);
    promotionAmount = promotionType === "DISCOUNT" ? roundMoney(totalAmount * Math.max(10 - promotionValue, 0) / 10) : promotionValue;
  }
  promotionAmount = Math.min(Math.max(promotionAmount, 0), totalAmount);
  const allocationMode = str(rule.promotionAllocation, "proportional");
  const scaledPlanAmounts = rawTotalAmount > 0 && inputTotalAmount > 0
    ? allocateByWeightCents(totalAmount, rawPlanRows.map((item) => item.planRealAmount))
    : rawPlanRows.map((item) => roundMoney(item.planRealAmount * amountScale));
  const promotionShares = allocationMode === "first_product"
    ? rawPlanRows.map((_, index) => index === 0 ? roundMoney(promotionAmount) : 0)
    : allocateByWeightCents(promotionAmount, scaledPlanAmounts);
  const nextPlanRows = rawPlanRows.map((item, index) => {
    const planRealAmount = scaledPlanAmounts[index];
    const planRealHour = item.planRealHour;
    const planPromotionAmount = promotionShares[index];
    return { ...item, planRealHour, planRealAmount, planPromotionAmount };
  });

  const currentPlanKey = currentProducts.map((row) => [row.product_id, roundMoney(num(row.plan_real_hour)), roundMoney(num(row.plan_real_amount)), roundMoney(num(row.plan_promotion_amount))].join(":"));
  const nextPlanKey = nextPlanRows.map((row) => [row.productId, roundMoney(row.planRealHour), roundMoney(row.planRealAmount), roundMoney(row.planPromotionAmount)].join(":"));
  const planChanged = productsChanged || currentPlanKey.length !== nextPlanKey.length || currentPlanKey.some((value, index) => value !== nextPlanKey[index]);
  const promotionChanged = roundMoney(num(contract.promotion_amount)) !== roundMoney(promotionAmount) || hasPromotionIdInput;
  const reallocationRequired = planChanged || promotionChanged;

  if (reallocationRequired) {
    const currentCpIds = currentProducts.map((row) => String(row.id));
    // 已撤销（REVERSED）的扣费不再阻塞合同修改：其课时/金额已全额冲回
    const { rows: lockedRows } = await client.query(
      `select 'charge' as source, id from ${table(schemaName, "account_charge_records")} where contract_product_id = any($1::text[]) and deleted = false and charge_status = 'CONFIRMED'
       union all
       select 'refund' as source, id from ${table(schemaName, "refund_record")} where contract_product_id = any($1::text[]) and deleted = false`,
      [currentCpIds]
    );
    if (lockedRows.length) throw new Error("合同产品、单价或优惠已发生扣费/退费引用，不允许修改");
  }

  const payable = Math.max(totalAmount - promotionAmount, 0);
  const paidAmount = num(contract.paid_amount);
  const paidStatus = paidAmount <= 0 ? "UNPAID" : paidAmount >= payable ? "PAID" : "PART_PAID";
  const updated = await one(client,
    `update ${table(schemaName, "contract")}
     set student_id = $2, contract_type = $3, organization_id = $4, sign_staff_id = $5, sign_time = $6, total_amount = $7, promotion_amount = $8, paid_status = $9, ext_json = coalesce(ext_json,'{}'::jsonb) || $10::jsonb, updated_at = now()
     where id = $1 returning *`,
    [contractId, str(input.student_id, Array.isArray(input.student_ids) && input.student_ids.length ? String(input.student_ids[0]) : str(contract.student_id)), str(input.contract_type, str(contract.contract_type)), str(input.organization_id, str(contract.organization_id)), str(input.sign_staff_id, str(contract.sign_staff_id)), str(input.sign_time, str(contract.sign_time)), totalAmount || num(contract.total_amount), promotionAmount, paidStatus, JSON.stringify({ ruleCode: "contract_update_rule", promotionId: promotionId || null })]
  );

  if (reallocationRequired) {
    await client.query(`update ${table(schemaName, "contract_product")} set deleted = true, updated_at = now() where contract_id = $1 and deleted = false`, [contractId]);
    await client.query(`update ${table(schemaName, "contract_product_promotion_history")} set deleted = true, updated_at = now() where contract_product_id = any($1::text[]) and deleted = false`, [currentProducts.map((row) => String(row.id))]);
    await client.query(`update ${table(schemaName, "contract_promotion_history")} set deleted = true, updated_at = now() where contract_id = $1 and deleted = false`, [contractId]);
    if (promotionAmount > 0 || promotion) {
      await client.query(
        `insert into ${table(schemaName, "contract_promotion_history")}
          (id, contract_id, promotion_id, promotion_snapshot_json, reduce_amount, discount_value)
         values ($1,$2,$3,$4,$5,$6)`,
        [await nextTextId(client, schemaName, "contract_promotion_history"), contractId, promotionId || null, JSON.stringify(promotion ?? { manualPromotionAmount: promotionAmount }), promotionAmount, num(promotion?.value)]
      );
    }
    const newCpIdByProduct = new Map<string, string>();
    for (const plan of nextPlanRows) {
      const cpId = await nextTextId(client, schemaName, "contract_product");
      newCpIdByProduct.set(plan.productId, cpId);
      await client.query(
        `insert into ${table(schemaName, "contract_product")}
          (id, contract_id, product_id, plan_real_hour, plan_promotion_hour, plan_real_amount, plan_promotion_amount, remaining_real_hour, remaining_promotion_hour, remaining_real_amount, remaining_promotion_amount, ext_json)
         values ($1,$2,$3,$4,$5,$6,$7,$4,$5,$6,$7,$8)`,
        [cpId, contractId, plan.productId, plan.planRealHour, plan.planPromotionHour, plan.planRealAmount, plan.planPromotionAmount, JSON.stringify({ ruleCode: "contract_update_rule", replacedByContractUpdate: true })]
      );
      if (plan.planPromotionAmount > 0) {
        await client.query(
          `insert into ${table(schemaName, "contract_product_promotion_history")}
            (id, contract_product_id, promotion_id, promotion_snapshot_json, reduce_amount)
           values ($1,$2,$3,$4,$5)`,
          [await nextTextId(client, schemaName, "contract_product_promotion_history"), cpId, promotionId || null, JSON.stringify(promotion ?? { allocationMode }), plan.planPromotionAmount]
        );
      }
    }
    // 已排课程的学员仍引用旧合同产品，按产品映射重链到新合同产品，避免后续考勤扣费找不到 CP
    for (const oldCp of currentProducts) {
      const nextCpId = newCpIdByProduct.get(String(oldCp.product_id)) ?? null;
      await client.query(
        `update ${table(schemaName, "generic_course_student")} set contract_product_id = $2, updated_at = now() where contract_product_id = $1 and deleted = false`,
        [oldCp.id, nextCpId]
      );
    }
    await reallocateContractFunds(client, schemaName, contractId, rule);
  }
  return { contract: updated, productsChanged, planChanged, promotionChanged, reallocated: reallocationRequired };
}

async function arrangePayment(client: pg.PoolClient, schemaName: string, fundsId: string, contractId: string, amount: number, rule: BusinessRule) {
  if (!contractId || amount <= 0) return;
  const mode = str(rule.fundsAllocation, "oldest_first");
  const isProportionalMode = ["proportional", "byCpPaidRatio", "byCpRemainingAmount"].includes(mode);
  const orderBy = "created_at asc";
  const { rows } = await client.query(
    `select * from ${table(schemaName, "contract_product")} where contract_id = $1 and deleted = false order by ${orderBy}`,
    [contractId]
  );
  // 排款上限 = 该产品应收现金（计划金额 - 计划优惠）- 已排款，而不是"剩余可消耗金额"，避免多笔收款把 paid_real_amount 排超计划
  const unpaidOf = (row: Record<string, unknown>) => Math.max(roundMoney(num(row.plan_real_amount) - num(row.plan_promotion_amount) - num(row.paid_real_amount)), 0);
  let remaining = roundMoney(amount);
  const totalUnpaid = rows.reduce((sum, row) => sum + unpaidOf(row), 0);
  const proportionalShares = isProportionalMode && totalUnpaid > 0
    ? allocateByWeightCents(Math.min(amount, totalUnpaid), rows.map((row) => unpaidOf(row)))
    : [];
  for (let index = 0; index < rows.length && remaining > 0; index += 1) {
    const cp = rows[index];
    const cpRemaining = unpaidOf(cp);
    const arrangeAmount = isProportionalMode && totalUnpaid > 0
      ? Math.min(cpRemaining, proportionalShares[index] ?? 0)
      : Math.min(cpRemaining, remaining);
    if (arrangeAmount <= 0) continue;
    const hourRatio = num(cp.plan_real_amount) > 0 ? num(cp.plan_real_hour) / num(cp.plan_real_amount) : 0;
    const arrangeHour = Math.round(arrangeAmount * hourRatio * 100) / 100;
    await client.query(
      `insert into ${table(schemaName, "money_arrange_log")}
        (id, contract_product_id, arrange_real_hour, arrange_real_amount, funds_change_history_id, organization_id)
       values ($1,$2,$3,$4,$5,$6)`,
      [await nextTextId(client, schemaName, "money_arrange_log"), cp.id, arrangeHour, arrangeAmount, fundsId, cp.organization_id]
    );
    await client.query(
      `update ${table(schemaName, "contract_product")}
       set paid_real_amount = coalesce(paid_real_amount,0) + $1,
           paid_real_hour = coalesce(paid_real_hour,0) + $2,
           updated_at = now()
       where id = $3`,
      [arrangeAmount, arrangeHour, cp.id]
    );
    remaining = roundMoney(remaining - arrangeAmount);
  }
}

async function arrangePromotion(client: pg.PoolClient, schemaName: string, fundsId: string, contractId: string, amount: number) {
  if (!contractId || amount <= 0) return;
  const { rows: cpRows } = await client.query(
    `select * from ${table(schemaName, "contract_product")} where contract_id = $1 and deleted = false order by created_at asc`,
    [contractId]
  );
  const contract = await one(client, `select promotion_amount, total_amount from ${table(schemaName, "contract")} where id = $1 and deleted = false`, [contractId]);
  const totalPromotion = num(contract?.promotion_amount);
  if (totalPromotion <= 0) return;
  // 优惠按本笔收款占应收现金的比例分摊，上限为各产品尚未分配的优惠额；应收已收齐时把剩余优惠一次分完，
  // 避免每笔收款都按合同总优惠全额重复分配
  const amountCaps = cpRows.map((cp) => Math.max(roundMoney(num(cp.plan_promotion_amount) - num(cp.paid_promotion_amount)), 0));
  const capTotal = roundMoney(amountCaps.reduce((sum, value) => sum + value, 0));
  if (capTotal <= 0) return;
  const payable = Math.max(num(contract?.total_amount) - totalPromotion, 0);
  const unpaidAfter = cpRows.reduce((sum, cp) => sum + Math.max(num(cp.plan_real_amount) - num(cp.plan_promotion_amount) - num(cp.paid_real_amount), 0), 0);
  const fullyPaid = unpaidAfter <= 0.005;
  const paymentRatio = payable > 0 ? Math.min(amount / payable, 1) : 1;
  const target = fullyPaid ? capTotal : Math.min(roundMoney(totalPromotion * paymentRatio), capTotal);
  if (target <= 0) return;
  const promotionShares = allocateByWeightCents(target, amountCaps);
  for (let index = 0; index < cpRows.length; index += 1) {
    const cp = cpRows[index];
    const arrangePromotionAmount = Math.min(promotionShares[index] ?? 0, amountCaps[index]);
    const hourCap = Math.max(roundMoney(num(cp.plan_promotion_hour) - num(cp.paid_promotion_hour)), 0);
    const planPromotionAmount = num(cp.plan_promotion_amount);
    const arrangePromotionHour = fullyPaid
      ? hourCap
      : planPromotionAmount > 0
        ? Math.min(roundMoney(num(cp.plan_promotion_hour) * (arrangePromotionAmount / planPromotionAmount)), hourCap)
        : Math.min(roundMoney(num(cp.plan_promotion_hour) * paymentRatio), hourCap);
    if (arrangePromotionAmount <= 0 && arrangePromotionHour <= 0) continue;
    await client.query(
      `insert into ${table(schemaName, "promotion_arrange_log")}
        (id, contract_product_id, arrange_promotion_hour, arrange_promotion_amount, funds_change_history_id, organization_id)
       values ($1,$2,$3,$4,$5,$6)`,
      [await nextTextId(client, schemaName, "promotion_arrange_log"), cp.id, arrangePromotionHour, arrangePromotionAmount, fundsId, cp.organization_id]
    );
    await client.query(
      `update ${table(schemaName, "contract_product")}
       set paid_promotion_hour = coalesce(paid_promotion_hour,0) + $1,
           paid_promotion_amount = coalesce(paid_promotion_amount,0) + $2,
           updated_at = now()
       where id = $3`,
      [arrangePromotionHour, arrangePromotionAmount, cp.id]
    );
  }
}

async function arrangePerformance(client: pg.PoolClient, schemaName: string, fundsId: string, contractId: string, amount: number) {
  if (!contractId || amount <= 0) return;
  const contract = await one(client, `select * from ${table(schemaName, "contract")} where id = $1 and deleted = false`, [contractId]);
  if (!contract) return;
  const { rows: cpRows } = await client.query(
    `select * from ${table(schemaName, "contract_product")} where contract_id = $1 and deleted = false order by created_at asc`,
    [contractId]
  );
  const performanceShares = allocateByWeightCents(amount, cpRows.map((row) => num(row.plan_real_amount)));
  for (let index = 0; index < cpRows.length; index += 1) {
    const cp = cpRows[index];
    const orgId = str(cp.organization_id, str(contract.organization_id));
    const signStaffId = str(contract.sign_staff_id);
    const perfAmount = performanceShares[index];
    if (perfAmount <= 0) continue;
    await client.query(
      `insert into ${table(schemaName, "performance_arrange_log")}
        (id, contract_product_id, funds_change_history_id, performance_type, organization_performance_organization_id, organization_performance_amount, personal_performance_user_id, personal_performance_amount, organization_id)
       values ($1,$2,$3,'SALES',$4,$5,$6,$7,$8)`,
      [await nextTextId(client, schemaName, "performance_arrange_log"), cp.id, fundsId, orgId, perfAmount, signStaffId || null, signStaffId ? roundMoney(perfAmount * 0.5) : 0, orgId]
    );
  }
}

async function reversePerformanceForSource(client: pg.PoolClient, schemaName: string, sourceType: string, sourceId: string, reason: string) {
  const where = sourceType === "refund" ? "coalesce((ext_json->>'sourceRefundId'), '') = $1" : "funds_change_history_id = $1";
  const { rows } = await client.query(`select * from ${table(schemaName, "performance_arrange_log")} where ${where} and deleted = false and coalesce((ext_json->>'reversalOf'),'') = ''`, [sourceId]);
  for (const row of rows) {
    const orgAmount = num(row.organization_performance_amount);
    const personalAmount = num(row.personal_performance_amount);
    if (orgAmount === 0 && personalAmount === 0) continue;
    await client.query(
      `insert into ${table(schemaName, "performance_arrange_log")}
        (id, contract_product_id, funds_change_history_id, performance_type, organization_performance_organization_id, organization_performance_amount, personal_performance_user_id, personal_performance_amount, organization_id, source_type, source_id, adjustment_reason, ext_json)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [await nextTextId(client, schemaName, "performance_arrange_log"), row.contract_product_id, sourceType === "funds_void" ? sourceId : row.funds_change_history_id, `${str(row.performance_type, "SALES")}_REVERSE`, row.organization_performance_organization_id, -orgAmount, row.personal_performance_user_id, -personalAmount, row.organization_id, sourceType, sourceId, reason, JSON.stringify({ reversalOf: row.id, sourceType, sourceId })]
    );
  }
  return rows.length;
}

async function arrangeNegativePerformanceForRefund(client: pg.PoolClient, schemaName: string, refundId: string, refund: Record<string, unknown>, rule: BusinessRule) {
  if (rule.generateNegativePerformance === false) return 0;
  const amount = num(refund.refund_real_amount);
  if (amount <= 0) return 0;
  const cpId = str(refund.contract_product_id);
  const cp = cpId ? await one(client, `select * from ${table(schemaName, "contract_product")} where id = $1`, [cpId]) : undefined;
  const contractId = str(refund.contract_id, str(cp?.contract_id));
  const contract = contractId ? await one(client, `select * from ${table(schemaName, "contract")} where id = $1`, [contractId]) : undefined;
  const orgId = str(cp?.organization_id, str(contract?.organization_id));
  const userId = str(contract?.sign_staff_id);
  await client.query(
    `insert into ${table(schemaName, "performance_arrange_log")}
      (id, contract_product_id, performance_type, organization_performance_organization_id, organization_performance_amount, personal_performance_user_id, personal_performance_amount, organization_id, source_type, source_id, adjustment_reason, ext_json)
     values ($1,$2,'REFUND_REVERSE',$3,$4,$5,$6,$7,'refund',$8,$9,$10)`,
    [await nextTextId(client, schemaName, "performance_arrange_log"), cpId || null, orgId || null, -amount, userId || null, userId ? -roundMoney(amount * 0.5) : 0, orgId || null, refundId, str(refund.remark, "退费自动冲减业绩"), JSON.stringify({ sourceRefundId: refundId, contractId })]
  );
  return 1;
}

async function denyLedgerMutation() {
  throw new Error("电子账户流水为不可变流水，禁止新增/修改/删除；如需调整请通过来源单据或冲正流水处理");
}

async function createFunds(client: pg.PoolClient, schemaName: string, params: Record<string, unknown>, rule: BusinessRule) {
  const input = dataOf(params);
  const fundsId = str(params.id, await nextTextId(client, schemaName, "funds_change_history"));
  const amount = num(input.transaction_amount);
  if (amount <= 0) throw new Error("收款金额必须大于 0");
  const fundsType = dictBare(input.funds_type, input.contract_id ? "CONTRACT_PAY" : "PRE_STORE");
  const contract = input.contract_id
    ? await one(client, `select student_id, total_amount, promotion_amount, paid_amount, contract_status from ${table(schemaName, "contract")} where id = $1 and deleted = false`, [input.contract_id])
    : undefined;
  if (input.contract_id && !contract) throw new Error("合同不存在或已删除");
  if (contract && ["REFUNDED", "CLOSED", "CANCELLED"].includes(str(contract.contract_status))) {
    throw new Error("合同已退费/关闭/作废，不可继续收款");
  }
  const studentId = str(input.student_id, str(contract?.student_id));
  if (!studentId) throw new Error("收款必须选择学员");
  const payWay = input.pay_way_config_id
    ? await one(client, `select pay_way_type from ${table(schemaName, "pay_way_config")} where id = $1 and deleted = false`, [input.pay_way_config_id])
    : undefined;
  const isEleAccountPay = str(payWay?.pay_way_type) === "ELE_ACCOUNT";
  const row = await one(client,
    `insert into ${table(schemaName, "funds_change_history")}
      (id, contract_id, student_id, transaction_amount, transaction_time, pay_way_config_id, funds_type, organization_id, ext_json)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     returning *`,
    [
      fundsId,
      input.contract_id,
      studentId,
      amount,
      str(input.transaction_time, new Date().toISOString()),
      input.pay_way_config_id,
      fundsType,
      input.organization_id,
      JSON.stringify({ ruleCode: "funds_create_rule", rule })
    ]
  );

  if (fundsType === "PRE_STORE") {
    await changeStudentEleAccount(client, schemaName, {
      studentId,
      amount,
      changeType: "PRESTORE_IN",
      sourceFundsId: fundsId,
      remark: str(input.remark, "预存入电子账户")
    });
  }

  if (isEleAccountPay && fundsType !== "PRE_STORE") {
    await changeStudentEleAccount(client, schemaName, {
      studentId,
      amount: -amount,
      changeType: "CONTRACT_PAY_OUT",
      sourceFundsId: fundsId,
      contractId: str(input.contract_id),
      remark: str(input.remark, "电子账户支付合同款")
    });
  }

  if (input.contract_id) {
    await arrangePayment(client, schemaName, fundsId, String(input.contract_id), amount, rule);
    await arrangePromotion(client, schemaName, fundsId, String(input.contract_id), amount);
    await arrangePerformance(client, schemaName, fundsId, String(input.contract_id), amount);
    const nextPaid = num(contract?.paid_amount) + amount;
    const payable = Math.max(num(contract?.total_amount) - num(contract?.promotion_amount), 0);
    const status = nextPaid <= 0 ? "UNPAID" : nextPaid >= payable ? "PAID" : "PART_PAID";
    await client.query(
      `update ${table(schemaName, "contract")} set paid_amount = $1, paid_status = $2, updated_at = now() where id = $3`,
      [nextPaid, status, input.contract_id]
    );
  }
  return row;
}

async function deleteFunds(client: pg.PoolClient, schemaName: string, params: Record<string, unknown>) {
  const fundsId = str(params.id ?? dataOf(params).id);
  if (!fundsId) throw new Error("缺少收款记录 ID");
  const funds = await one(client, `select * from ${table(schemaName, "funds_change_history")} where id = $1 and deleted = false for update`, [fundsId]);
  if (!funds) throw new Error("收款记录不存在或已删除");

  if (str(funds.contract_id)) {
    const refund = await one(client,
      `select id from ${table(schemaName, "refund_record")}
       where deleted = false and (contract_id = $1 or contract_product_id in (select id from ${table(schemaName, "contract_product")} where contract_id = $1))
       limit 1`,
      [funds.contract_id]
    );
    if (refund) throw new Error("合同已发生退费，不能直接删除收款；请先删除相关退费记录");
  }

  const { rows: moneyRows } = await client.query(
    `select * from ${table(schemaName, "money_arrange_log")} where funds_change_history_id = $1 and deleted = false`,
    [fundsId]
  );
  for (const row of moneyRows) {
    await client.query(
      `update ${table(schemaName, "contract_product")}
       set paid_real_amount = greatest(coalesce(paid_real_amount,0) - $1, 0),
           paid_real_hour = greatest(coalesce(paid_real_hour,0) - $2, 0),
           updated_at = now()
       where id = $3`,
      [num(row.arrange_real_amount), num(row.arrange_real_hour), row.contract_product_id]
    );
  }

  const { rows: promotionRows } = await client.query(
    `select * from ${table(schemaName, "promotion_arrange_log")} where funds_change_history_id = $1 and deleted = false`,
    [fundsId]
  );
  for (const row of promotionRows) {
    await client.query(
      `update ${table(schemaName, "contract_product")}
       set paid_promotion_amount = greatest(coalesce(paid_promotion_amount,0) - $1, 0),
           paid_promotion_hour = greatest(coalesce(paid_promotion_hour,0) - $2, 0),
           updated_at = now()
       where id = $3`,
      [num(row.arrange_promotion_amount), num(row.arrange_promotion_hour), row.contract_product_id]
    );
  }

  await client.query(`update ${table(schemaName, "money_arrange_log")} set deleted = true, updated_at = now() where funds_change_history_id = $1 and deleted = false`, [fundsId]);
  await client.query(`update ${table(schemaName, "promotion_arrange_log")} set deleted = true, updated_at = now() where funds_change_history_id = $1 and deleted = false`, [fundsId]);
  // 收款作废=整笔取消：与资金/优惠排布日志同口径软删业绩分配（冲回行模式留给退费场景保留审计轨迹）
  const { rowCount: reversedPerformance } = await client.query(
    `update ${table(schemaName, "performance_arrange_log")} set deleted = true, updated_at = now() where funds_change_history_id = $1 and deleted = false`,
    [fundsId]
  );

  const contractId = str(funds.contract_id);
  const amount = num(funds.transaction_amount);
  if (contractId) {
    const contract = await one(client, `select * from ${table(schemaName, "contract")} where id = $1 and deleted = false for update`, [contractId]);
    const nextPaid = Math.max(num(contract?.paid_amount) - amount, 0);
    const payable = Math.max(num(contract?.total_amount) - num(contract?.promotion_amount), 0);
    const status = nextPaid <= 0 ? "UNPAID" : nextPaid >= payable ? "PAID" : "PART_PAID";
    await client.query(
      `update ${table(schemaName, "contract")} set paid_amount = $1, paid_status = $2, updated_at = now() where id = $3`,
      [nextPaid, status, contractId]
    );
  }

  const payWay = funds.pay_way_config_id
    ? await one(client, `select pay_way_type from ${table(schemaName, "pay_way_config")} where id = $1 and deleted = false`, [funds.pay_way_config_id])
    : undefined;
  if (str(funds.funds_type) === "PRE_STORE") {
    await changeStudentEleAccount(client, schemaName, {
      studentId: str(funds.student_id),
      amount: -amount,
      changeType: "PRESTORE_DELETE",
      sourceFundsId: fundsId,
      remark: "删除预存收款回滚电子账户"
    });
  } else if (str(payWay?.pay_way_type) === "ELE_ACCOUNT") {
    await changeStudentEleAccount(client, schemaName, {
      studentId: str(funds.student_id),
      amount,
      changeType: "CONTRACT_PAY_DELETE",
      sourceFundsId: fundsId,
      contractId,
      remark: "删除电子账户合同收款回滚余额"
    });
  }

  await client.query(
    `update ${table(schemaName, "funds_change_history")} set deleted = true, updated_at = now(), ext_json = coalesce(ext_json,'{}'::jsonb) || $2::jsonb where id = $1`,
    [fundsId, JSON.stringify({ voidReason: str(dataOf(params).void_reason ?? dataOf(params).remark) || null, voidedBy: str(params.__userId) || null, voidedAt: new Date().toISOString() })]
  );
  return { deleted: true, fundsId, rolledBackMoney: moneyRows.length, rolledBackPromotion: promotionRows.length, reversedPerformance };
}

async function deleteContract(client: pg.PoolClient, schemaName: string, params: Record<string, unknown>) {
  const contractId = str(params.id ?? dataOf(params).id ?? dataOf(params).contract_id);
  if (!contractId) throw new Error("缺少合同 ID");
  const contract = await one(client, `select * from ${table(schemaName, "contract")} where id = $1 and deleted = false for update`, [contractId]);
  if (!contract) throw new Error("合同不存在或已删除");
  const funds = await one(client, `select id from ${table(schemaName, "funds_change_history")} where contract_id = $1 and deleted = false limit 1`, [contractId]);
  if (funds || num(contract.paid_amount) > 0) throw new Error("合同已有收款，不可删除，请走合同退费或作废流程");
  const charge = await one(client,
    `select acr.id from ${table(schemaName, "account_charge_records")} acr
     join ${table(schemaName, "contract_product")} cp on acr.contract_product_id = cp.id
     where cp.contract_id = $1 and acr.deleted = false and acr.charge_status = 'CONFIRMED' limit 1`,
    [contractId]
  );
  if (charge) throw new Error("合同已有扣费记录，不可删除");
  const refund = await one(client, `select id from ${table(schemaName, "refund_record")} where contract_id = $1 and deleted = false limit 1`, [contractId]);
  if (refund) throw new Error("合同已有退费记录，不可删除");
  await client.query(`update ${table(schemaName, "contract_product")} set deleted = true, updated_at = now() where contract_id = $1 and deleted = false`, [contractId]);
  await client.query(`update ${table(schemaName, "contract")} set deleted = true, contract_status = 'CANCELLED', updated_at = now() where id = $1`, [contractId]);
  return { deleted: true, contractId };
}

async function changeStudentEleAccount(
  client: pg.PoolClient,
  schemaName: string,
  input: { studentId: string; amount: number; changeType: string; sourceFundsId?: string; sourceRefundId?: string; contractId?: string; remark?: string; operatorId?: string }
) {
  let account = await one(client, `select * from ${table(schemaName, "student_ele_account")} where student_id = $1 and deleted = false for update`, [input.studentId]);
  if (!account) {
    account = await one(
      client,
      `insert into ${table(schemaName, "student_ele_account")} (id, student_id, balance_amount, status) values ($1,$2,0,'ACTIVE') returning *`,
      [await nextTextId(client, schemaName, "student_ele_account"), input.studentId]
    );
  }
  const nextBalance = roundMoney(num(account?.balance_amount) + input.amount);
  if (nextBalance < 0) throw new Error("电子账户余额不足");
  await assertUpdated(await client.query(
    `update ${table(schemaName, "student_ele_account")} set balance_amount = $1, lock_version = coalesce(lock_version,0) + 1, updated_at = now() where id = $2 and coalesce(lock_version,0) = $3`,
    [nextBalance, account?.id, num(account?.lock_version)]
  ));
  await client.query(
    `insert into ${table(schemaName, "student_ele_account_record")}
      (id, student_id, account_id, change_type, change_amount, balance_after, source_funds_id, source_refund_id, contract_id, remark, source_type, source_id, operator_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [await nextTextId(client, schemaName, "student_ele_account_record"), input.studentId, account?.id, input.changeType, input.amount, nextBalance, input.sourceFundsId, input.sourceRefundId, input.contractId, input.remark, input.sourceRefundId ? "REFUND" : input.sourceFundsId ? "FUNDS" : input.contractId ? "CONTRACT" : input.changeType, input.sourceRefundId ?? input.sourceFundsId ?? input.contractId ?? null, input.operatorId ?? null]
  );
  return nextBalance;
}

function timeToMinutes(value: unknown) {
  const [hour, minute] = str(value).split(":").map(Number);
  return hour * 60 + minute;
}

function dateOnly(value: unknown) {
  if (value instanceof Date) {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  return str(value).slice(0, 10);
}

async function assertStudentsNoTimeConflict(
  client: pg.PoolClient,
  schemaName: string,
  input: Record<string, unknown>,
  studentIds: string[],
  excludeCourseId?: string
) {
  if (!studentIds.length) return;
  const { rows } = await client.query(
    `select gcs.student_id, gc.id as course_id, gc.course_title, gc.course_date, gc.start_time, gc.end_time
     from ${table(schemaName, "generic_course_student")} gcs
     join ${table(schemaName, "generic_course")} gc on gcs.course_id = gc.id
     where gcs.deleted = false and gc.deleted = false and gc.course_status <> 'CANCELLED'
       and gc.course_date = $1 and gc.start_time < $2 and gc.end_time > $3
       and gcs.student_id = any($4::text[])
       and ($5 = '' or gc.id <> $5)
     limit 1`,
    [input.course_date, input.end_time, input.start_time, studentIds, excludeCourseId ?? ""]
  );
  if (rows[0]) throw new Error(`学员该时间段已有课程: ${rows[0].student_id}`);
}

async function writeClassStudentHistory(
  client: pg.PoolClient,
  schemaName: string,
  input: { targetType: "mini_class" | "one_on_n_group"; targetId: string; studentId: string; changeType: "JOIN" | "LEAVE"; reason?: unknown; ext?: Record<string, unknown> }
) {
  await client.query(
    `insert into ${table(schemaName, "class_student_change_history")}
      (id, target_type, target_id, student_id, change_type, reason, ext_json)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [await nextTextId(client, schemaName, "class_student_change_history"), input.targetType, input.targetId, input.studentId, input.changeType, str(input.reason), JSON.stringify(input.ext ?? {})]
  );
}

async function cleanupRemovedStudentCourses(
  client: pg.PoolClient,
  schemaName: string,
  input: { studentId: string; miniClassId?: string; oneOnNGroupId?: string; policy: string }
) {
  const byMiniClass = Boolean(input.miniClassId);
  const { rows } = await client.query(
    `select gcs.*, gc.course_date
     from ${table(schemaName, "generic_course_student")} gcs
     join ${table(schemaName, "generic_course")} gc on gcs.course_id = gc.id
     where gcs.deleted = false and gc.deleted = false and gcs.student_id = $1
       and ${byMiniClass ? "gc.mini_class_id = $2" : "gc.one_on_n_group_id = $2"}`,
    [input.studentId, byMiniClass ? input.miniClassId : input.oneOnNGroupId]
  );
  let deletedCourseStudents = 0;
  let reversedCharges = 0;
  for (const row of rows) {
    const { rows: charges } = await client.query(
      `select id from ${table(schemaName, "account_charge_records")} where course_id = $1 and student_id = $2 and charge_status = 'CONFIRMED' and deleted = false for update`,
      [row.course_id, input.studentId]
    );
    const isAttended = str(row.attendance_status) === "PRESENT";
    if ((isAttended || charges.length > 0) && ["block_attended", "delete_uncharged_course_students"].includes(input.policy)) throw new Error("该学员存在已考勤或已扣费课程，不可移除");
    if ((isAttended || charges.length > 0) && input.policy === "cancel_attendance_and_charges") {
      for (const charge of charges) {
        await reverseCharge(client, schemaName, { id: charge.id, cancel_reason: "移除学员同步取消扣费" }, { requireCancelReason: false, cancelAttendanceOnChargeReverse: false });
        reversedCharges += 1;
      }
      await client.query(`update ${table(schemaName, "generic_course_student")} set attendance_status = 'PENDING', attendance_time = null, updated_at = now() where id = $1`, [row.id]);
    }
    if (input.policy === "delete_uncharged_course_students" || input.policy === "cancel_attendance_and_charges") {
      const { rows: remainingCharges } = await client.query(
        `select id from ${table(schemaName, "account_charge_records")} where course_id = $1 and student_id = $2 and charge_status = 'CONFIRMED' and deleted = false limit 1`,
        [row.course_id, input.studentId]
      );
      if (remainingCharges.length === 0) {
        await client.query(`update ${table(schemaName, "generic_course_student")} set deleted = true, updated_at = now() where id = $1`, [row.id]);
        deletedCourseStudents += 1;
      }
    }
  }
  return { deletedCourseStudents, reversedCharges };
}

async function assertNoCourseHoliday(client: pg.PoolClient, schemaName: string, input: Record<string, unknown>, rule: BusinessRule) {
  if (rule.preventHolidayScheduling === false) return;
  const courseDate = str(input.course_date);
  if (!courseDate) return;
  const holiday = await one(client,
    `select id, name from ${table(schemaName, "course_holiday_calendar")}
     where deleted = false and coalesce(block_course,true) = true
       and holiday_date <= $1::date and coalesce(end_date, holiday_date) >= $1::date
       and (organization_id is null or organization_id = '' or organization_id = $2)
     limit 1`,
    [courseDate, str(input.organization_id)]
  );
  if (holiday) throw new Error(`停课日历已设置停课：${str(holiday.name, String(holiday.id ?? ""))}`);
}

async function createCourse(client: pg.PoolClient, schemaName: string, params: Record<string, unknown>, rule: BusinessRule): Promise<Record<string, unknown>> {
  const input = dataOf(params);
  const courseDates = Array.isArray(input.course_dates) ? input.course_dates.map((value) => str(value)).filter(Boolean) : [];
  if (courseDates.length > 1) {
    const courses = [];
    for (const courseDate of courseDates) {
      courses.push(await createCourse(client, schemaName, { ...params, id: undefined, data: { ...input, course_date: courseDate, course_dates: undefined } }, rule));
    }
    return { batch: true, count: courses.length, courses };
  }
  if (!input.course_date && courseDates.length === 1) input.course_date = courseDates[0];
  const courseId = str(params.id, await nextTextId(client, schemaName, "generic_course"));
  if (!input.course_date || !input.start_time || !input.end_time) throw new Error("排课必须填写日期和时间");
  if (timeToMinutes(input.end_time) <= timeToMinutes(input.start_time)) throw new Error("结束时间必须晚于开始时间");
  await assertNoCourseHoliday(client, schemaName, input, rule);
  if (rule.preventTeacherTimeConflict !== false && input.teacher_id) {
    const conflict = await one(client,
      `select id from ${table(schemaName, "generic_course")}
       where deleted = false and course_status <> 'CANCELLED' and teacher_id = $1 and course_date = $2
         and start_time < $3 and end_time > $4
       limit 1`,
      [input.teacher_id, input.course_date, input.end_time, input.start_time]
    );
    if (conflict) throw new Error("老师该时间段已有课程");
  }
  const course = await one(client,
    `insert into ${table(schemaName, "generic_course")}
      (id, course_type, course_date, start_time, end_time, teacher_id, study_manager_id, course_status, organization_id, mini_class_id, one_on_n_group_id, course_title, course_hour, ext_json)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     returning *`,
    [
      courseId,
      input.course_type,
      input.course_date,
      input.start_time,
      input.end_time,
      input.teacher_id,
      input.study_manager_id,
      str(input.course_status, "SCHEDULED"),
      input.organization_id,
      input.mini_class_id,
      input.one_on_n_group_id,
      input.course_title,
      num(input.course_hour, 1),
      JSON.stringify({ ruleCode: "course_create_rule", rule })
    ]
  );
  const studentIds = Array.isArray(input.student_ids) ? input.student_ids : input.student_id ? [input.student_id] : [];
  const studentsWithCp = Array.isArray(input.students) ? input.students as Record<string, unknown>[] : [];

  const miniClassId = str(input.mini_class_id);
  const oneOnNGroupId = str(input.one_on_n_group_id);

  if (miniClassId) {
    const miniClass = await one(client, `select product_id, grade, subject from ${table(schemaName, "mini_class")} where id = $1 and deleted = false`, [miniClassId]);
    const matchContext = { productId: input.product_id ?? miniClass?.product_id, grade: input.grade ?? miniClass?.grade, subject: input.subject ?? miniClass?.subject };
    const { rows: classStudents } = await client.query(
      `select mcs.student_id, mcs.mini_class_id from ${table(schemaName, "mini_class_student")} mcs where mcs.mini_class_id = $1 and mcs.deleted = false`,
      [miniClassId]
    );
    if (rule.preventStudentTimeConflict !== false) await assertStudentsNoTimeConflict(client, schemaName, input, classStudents.map((row) => str(row.student_id)), courseId);
    for (const cs of classStudents) {
      const matched = studentsWithCp.find((s) => str(s.student_id) === str(cs.student_id));
      const cpId = matched ? str(matched.contract_product_id) : await autoSelectCp(client, schemaName, str(cs.student_id), matchContext, rule);
      await client.query(
        `insert into ${table(schemaName, "generic_course_student")}
          (id, course_id, student_id, attendance_status, contract_product_id, mini_class_id)
         values ($1,$2,$3,'PENDING',$4,$5)`,
        [await nextTextId(client, schemaName, "generic_course_student"), courseId, cs.student_id, cpId, miniClassId]
      );
    }
    return { course, studentCount: classStudents.length, autoLinked: true, source: "mini_class" };
  }

  if (oneOnNGroupId) {
    const group = await one(client, `select product_id, grade, subject from ${table(schemaName, "one_on_n_group")} where id = $1 and deleted = false`, [oneOnNGroupId]);
    const matchContext = { productId: input.product_id ?? group?.product_id, grade: input.grade ?? group?.grade, subject: input.subject ?? group?.subject };
    const { rows: groupStudents } = await client.query(
      `select ogs.student_id, ogs.one_on_n_group_id from ${table(schemaName, "one_on_n_group_student")} ogs where ogs.one_on_n_group_id = $1 and ogs.deleted = false`,
      [oneOnNGroupId]
    );
    if (rule.preventStudentTimeConflict !== false) await assertStudentsNoTimeConflict(client, schemaName, input, groupStudents.map((row) => str(row.student_id)), courseId);
    for (const gs of groupStudents) {
      const matched = studentsWithCp.find((s) => str(s.student_id) === str(gs.student_id));
      const cpId = matched ? str(matched.contract_product_id) : await autoSelectCp(client, schemaName, str(gs.student_id), matchContext, rule);
      await client.query(
        `insert into ${table(schemaName, "generic_course_student")}
          (id, course_id, student_id, attendance_status, contract_product_id, one_on_n_group_id)
         values ($1,$2,$3,'PENDING',$4,$5)`,
        [await nextTextId(client, schemaName, "generic_course_student"), courseId, gs.student_id, cpId, oneOnNGroupId]
      );
    }
    return { course, studentCount: groupStudents.length, autoLinked: true, source: "one_on_n_group" };
  }

  const directCourseStudents = studentsWithCp.length ? studentsWithCp : studentIds.map((sid) => ({ student_id: sid }));
  if (rule.preventStudentTimeConflict !== false) await assertStudentsNoTimeConflict(client, schemaName, input, directCourseStudents.map((row) => str(row.student_id)), courseId);
  for (const stu of directCourseStudents) {
    const sid = str(stu.student_id);
    const cpId = str((stu as Record<string, unknown>).contract_product_id) || str(input.contract_product_id) || await autoSelectCp(client, schemaName, sid, { productId: input.product_id, grade: input.grade, subject: input.subject }, rule);
    await client.query(
      `insert into ${table(schemaName, "generic_course_student")}
        (id, course_id, student_id, attendance_status, contract_product_id)
       values ($1,$2,$3,'PENDING',$4)`,
      [await nextTextId(client, schemaName, "generic_course_student"), courseId, sid, cpId]
    );
  }
  return { course, studentCount: studentsWithCp.length || studentIds.length };
}

async function autoSelectCp(
  client: pg.PoolClient,
  schemaName: string,
  studentId: string,
  context: { productId?: unknown; grade?: unknown; subject?: unknown } = {},
  rule: BusinessRule = {}
): Promise<string | null> {
  const productId = str(context.productId);
  const grade = str(context.grade);
  const subject = str(context.subject);
  const matchRule = (rule.contractProductMatch && typeof rule.contractProductMatch === "object" ? rule.contractProductMatch : {}) as Record<string, unknown>;
  const requireRemaining = matchRule.requireRemainingRealHour !== false;
  const matchBy = Array.isArray(matchRule.matchBy) ? matchRule.matchBy.map(String) : ["product_id", "grade", "subject"];
  const useProductMatch = matchBy.includes("product_id");
  const useGradeMatch = matchBy.includes("grade");
  const useSubjectMatch = matchBy.includes("subject");
  const sortMode = str(matchRule.sortBy, "recent_charge_desc_then_sign_time_desc");
  const orderBy = sortMode === "sign_time_desc"
    ? "c.sign_time desc nulls last, cp.created_at asc"
    : sortMode === "sign_time_asc"
      ? "c.sign_time asc nulls last, cp.created_at asc"
      : "last_charge_at desc nulls last, c.sign_time desc nulls last, cp.created_at asc";
  const cp = await one(client,
    `select cp.id, max(acr.created_at) as last_charge_at, c.sign_time
     from ${table(schemaName, "contract_product")} cp
     join ${table(schemaName, "contract")} c on cp.contract_id = c.id
     join ${table(schemaName, "product")} p on cp.product_id = p.id and p.deleted = false
     left join ${table(schemaName, "account_charge_records")} acr on acr.contract_product_id = cp.id and acr.charge_status = 'CONFIRMED' and acr.deleted = false
     where c.student_id = $1 and cp.deleted = false and c.deleted = false and c.contract_status = 'ACTIVE'
       ${requireRemaining ? "and coalesce(cp.remaining_real_hour,0) > 0" : ""}
       and ($2 = '' or $5 = false or cp.product_id = $2)
       and ($3 = '' or $6 = false or coalesce(p.grade_ids, '[]'::jsonb) ? $3)
       and ($4 = '' or $7 = false or coalesce(p.subject_ids, '[]'::jsonb) ? $4)
     group by cp.id, c.sign_time, cp.created_at
     order by ${orderBy} limit 1`,
    [studentId, productId, grade, subject, useProductMatch, useGradeMatch, useSubjectMatch]
  );
  return cp ? str(cp.id) : null;
}

async function updateCourse(client: pg.PoolClient, schemaName: string, params: Record<string, unknown>, rule: BusinessRule = {}): Promise<Record<string, unknown>> {
  const input = dataOf(params);
  const courseId = str(params.id ?? input.id ?? input.course_id);
  if (!courseId) throw new Error("缺少课程 ID");
  const course = await one(client, `select * from ${table(schemaName, "generic_course")} where id = $1 and deleted = false for update`, [courseId]);
  if (!course) throw new Error("课程不存在");
  if (str(course.course_status) === "CANCELLED") throw new Error("课程已取消，不能修改");

  const courseDate = input.course_date !== undefined && str(input.course_date) ? dateOnly(input.course_date) : dateOnly(course.course_date);
  const startTime = str(input.start_time, str(course.start_time));
  const endTime = str(input.end_time, str(course.end_time));
  if (timeToMinutes(endTime) <= timeToMinutes(startTime)) throw new Error("结束时间必须晚于开始时间");
  const teacherId = str(input.teacher_id, str(course.teacher_id));
  const timeChanged = courseDate !== dateOnly(course.course_date)
    || timeToMinutes(startTime) !== timeToMinutes(str(course.start_time))
    || timeToMinutes(endTime) !== timeToMinutes(str(course.end_time));
  const teacherChanged = teacherId !== str(course.teacher_id);
  const organizationId = str(input.organization_id, str(course.organization_id));

  if (timeChanged) await assertNoCourseHoliday(client, schemaName, { course_date: courseDate, organization_id: organizationId }, rule);
  if ((timeChanged || teacherChanged) && teacherId && rule.preventTeacherTimeConflict !== false) {
    const conflict = await one(client,
      `select id from ${table(schemaName, "generic_course")}
       where deleted = false and course_status <> 'CANCELLED' and teacher_id = $1 and course_date = $2
         and start_time < $3 and end_time > $4 and id <> $5
       limit 1`,
      [teacherId, courseDate, endTime, startTime, courseId]
    );
    if (conflict) throw new Error("老师该时间段已有课程");
  }

  const { rows: courseStudents } = await client.query(
    `select * from ${table(schemaName, "generic_course_student")} where course_id = $1 and deleted = false`,
    [courseId]
  );
  if (timeChanged && rule.preventStudentTimeConflict !== false) {
    await assertStudentsNoTimeConflict(
      client, schemaName,
      { course_date: courseDate, start_time: startTime, end_time: endTime },
      courseStudents.map((row) => str(row.student_id)),
      courseId
    );
  }

  const updated = await one(client,
    `update ${table(schemaName, "generic_course")}
     set course_date = $2, start_time = $3, end_time = $4, teacher_id = $5, study_manager_id = $6,
         course_title = $7, course_hour = $8, course_type = $9, organization_id = $10, updated_at = now()
     where id = $1 returning *`,
    [
      courseId,
      courseDate,
      startTime,
      endTime,
      teacherId || null,
      str(input.study_manager_id, str(course.study_manager_id)) || null,
      str(input.course_title, str(course.course_title)) || null,
      num(input.course_hour, num(course.course_hour, 1)),
      str(input.course_type, str(course.course_type)) || null,
      organizationId || null
    ]
  );

  let addedStudents = 0;
  let removedStudents = 0;
  if (Array.isArray(input.student_ids)) {
    const nextIds = input.student_ids.map(String).filter(Boolean);
    const existingByStudent = new Map(courseStudents.map((row) => [str(row.student_id), row]));
    const toAdd = nextIds.filter((id) => !existingByStudent.has(id));
    const toRemove = courseStudents.filter((row) => !nextIds.includes(str(row.student_id)));
    for (const row of toRemove) {
      const charge = await one(client,
        `select id from ${table(schemaName, "account_charge_records")} where course_id = $1 and student_id = $2 and charge_status = 'CONFIRMED' and deleted = false limit 1`,
        [courseId, row.student_id]
      );
      if (charge || ["PRESENT", "ABSENT", "LEAVE"].includes(str(row.attendance_status))) {
        throw new Error(`学员已考勤或已扣费，不能移出该课程: ${str(row.student_id)}`);
      }
      await client.query(`update ${table(schemaName, "generic_course_student")} set deleted = true, updated_at = now() where id = $1`, [row.id]);
      removedStudents += 1;
    }
    if (toAdd.length && rule.preventStudentTimeConflict !== false) {
      await assertStudentsNoTimeConflict(client, schemaName, { course_date: courseDate, start_time: startTime, end_time: endTime }, toAdd, courseId);
    }
    for (const studentId of toAdd) {
      const cpId = str(input.contract_product_id) || await autoSelectCp(client, schemaName, studentId, { productId: input.product_id, grade: input.grade, subject: input.subject }, rule);
      await client.query(
        `insert into ${table(schemaName, "generic_course_student")}
          (id, course_id, student_id, attendance_status, contract_product_id, mini_class_id, one_on_n_group_id)
         values ($1,$2,$3,'PENDING',$4,$5,$6)`,
        [await nextTextId(client, schemaName, "generic_course_student"), courseId, studentId, cpId, course.mini_class_id ?? null, course.one_on_n_group_id ?? null]
      );
      addedStudents += 1;
    }
  }
  return { updated: true, course: updated, addedStudents, removedStudents };
}

async function createCharge(client: pg.PoolClient, schemaName: string, params: Record<string, unknown>, rule: BusinessRule) {
  const input = dataOf(params);
  const cpId = str(input.contract_product_id);
  if (!cpId) throw new Error("扣费必须选择合同产品");
  const cp = await one(client, `select * from ${table(schemaName, "contract_product")} where id = $1 and deleted = false for update`, [cpId]);
  if (!cp) throw new Error("合同产品不存在");
  if (str(input.student_id)) {
    const cpOwner = await one(client, `select student_id from ${table(schemaName, "contract")} where id = $1 and deleted = false`, [cp.contract_id]);
    if (cpOwner && str(cpOwner.student_id) !== str(input.student_id)) throw new Error("合同产品不属于该学员");
  }
  const chargeType = dictBare(input.charge_type, str(rule.defaultChargeType, "NORMAL"));
  const chargeHour = num(input.charge_hour);
  let chargeAmount = num(input.charge_amount);
  if (chargeType === "NORMAL") {
    // 仅在真正扣课时且课时被扣完时才把剩余金额清零收尾；0 课时的纯金额扣费不应吞掉全部余额
    if (chargeHour > 0 && chargeHour >= num(cp.remaining_real_hour) && num(cp.remaining_real_amount) > 0) chargeAmount = num(cp.remaining_real_amount);
    if (rule.allowNegativeBalance !== true && (chargeHour > num(cp.remaining_real_hour) || chargeAmount > num(cp.remaining_real_amount))) {
      throw new Error("实收课时或金额余额不足");
    }
  }
  const charge = await one(client,
    `insert into ${table(schemaName, "account_charge_records")}
      (id, course_id, charge_type, charge_hour, charge_amount, contract_product_id, organization_id, student_id, charge_status, ext_json)
     values ($1,$2,$3,$4,$5,$6,$7,$8,'CONFIRMED',$9)
     returning *`,
    [str(params.id, await nextTextId(client, schemaName, "account_charge_records")), input.course_id, chargeType, chargeHour, chargeAmount, cpId, input.organization_id, input.student_id, JSON.stringify({ ruleCode: "charge_create_rule", rule })]
  );
  if (chargeType === "NORMAL") {
    await assertUpdated(await client.query(
      `update ${table(schemaName, "contract_product")}
       set consumed_real_hour = coalesce(consumed_real_hour,0) + $1,
           consumed_real_amount = coalesce(consumed_real_amount,0) + $2,
           remaining_real_hour = coalesce(remaining_real_hour,0) - $1,
           remaining_real_amount = coalesce(remaining_real_amount,0) - $2,
           lock_version = coalesce(lock_version,0) + 1,
           updated_at = now()
       where id = $3 and coalesce(lock_version,0) = $4`,
      [chargeHour, chargeAmount, cpId, num(cp.lock_version)]
    ));
  } else if (chargeType === "PROMOTION_HOUR") {
    if (rule.allowNegativeBalance !== true && chargeHour > num(cp.remaining_promotion_hour)) throw new Error("赠送课时余额不足");
    await assertUpdated(await client.query(
      `update ${table(schemaName, "contract_product")}
       set consumed_promotion_hour = coalesce(consumed_promotion_hour,0) + $1,
           remaining_promotion_hour = coalesce(remaining_promotion_hour,0) - $1,
           lock_version = coalesce(lock_version,0) + 1,
           updated_at = now()
       where id = $2 and coalesce(lock_version,0) = $3`,
      [chargeHour, cpId, num(cp.lock_version)]
    ));
  } else if (chargeType === "PROMOTION") {
    if (rule.allowNegativeBalance !== true && chargeAmount > num(cp.remaining_promotion_amount)) throw new Error("优惠金额余额不足");
    await assertUpdated(await client.query(
      `update ${table(schemaName, "contract_product")}
       set consumed_promotion_amount = coalesce(consumed_promotion_amount,0) + $1,
           remaining_promotion_amount = coalesce(remaining_promotion_amount,0) - $1,
           lock_version = coalesce(lock_version,0) + 1,
           updated_at = now()
       where id = $2 and coalesce(lock_version,0) = $3`,
      [chargeAmount, cpId, num(cp.lock_version)]
    ));
  }
  return charge;
}

async function createRefund(client: pg.PoolClient, schemaName: string, params: Record<string, unknown>, rule: BusinessRule) {
  const input = dataOf(params);
  const cpId = str(input.contract_product_id);
  if (!cpId) throw new Error("退费必须选择合同产品");
  const cp = await one(client, `select * from ${table(schemaName, "contract_product")} where id = $1 and deleted = false for update`, [cpId]);
  if (!cp) throw new Error("合同产品不存在");
  const cpContract = await one(client, `select student_id, organization_id from ${table(schemaName, "contract")} where id = $1 and deleted = false`, [cp.contract_id]);
  if (str(input.student_id) && cpContract && str(cpContract.student_id) !== str(input.student_id)) throw new Error("合同产品不属于该学员");
  const refundHour = num(input.refund_real_hour);
  const refundAmount = num(input.refund_real_amount);
  const refundPromotionAmount = num(input.refund_promotion_amount);
  const refundPromotionHour = num(input.refund_promotion_hour);
  if (rule.allowRefundOverBalance !== true) {
    if (refundHour > num(cp.remaining_real_hour) || refundAmount > num(cp.remaining_real_amount)) throw new Error("退费超过实收剩余");
    if (refundPromotionAmount > num(cp.remaining_promotion_amount) || refundPromotionHour > num(cp.remaining_promotion_hour)) throw new Error("退费超过优惠剩余");
  }
  const refund = await one(client,
    `insert into ${table(schemaName, "refund_record")}
      (id, student_id, contract_product_id, contract_id, refund_type, refund_real_hour, refund_real_amount, refund_promotion_amount, refund_promotion_hour, refund_way_config_id, refund_time, remark, organization_id, ext_json)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     returning *`,
    [
      str(params.id, await nextTextId(client, schemaName, "refund_record")),
      str(input.student_id, str(cpContract?.student_id)) || null,
      cpId,
      str(cp.contract_id) || null,
      dictBare(input.refund_type, "CONTRACT_PRODUCT"),
      refundHour,
      refundAmount,
      refundPromotionAmount,
      refundPromotionHour,
      input.refund_way_config_id,
      str(input.refund_time, new Date().toISOString()),
      input.remark,
      str(input.organization_id, str(cp.organization_id, str(cpContract?.organization_id))) || null,
      JSON.stringify({ ruleCode: "refund_create_rule", rule })
    ]
  );
  await assertUpdated(await client.query(
    `update ${table(schemaName, "contract_product")}
     set remaining_real_hour = coalesce(remaining_real_hour,0) - $1,
         remaining_real_amount = coalesce(remaining_real_amount,0) - $2,
         remaining_promotion_hour = coalesce(remaining_promotion_hour,0) - $3,
         remaining_promotion_amount = coalesce(remaining_promotion_amount,0) - $4,
         lock_version = coalesce(lock_version,0) + 1,
         updated_at = now()
     where id = $5 and coalesce(lock_version,0) = $6`,
    [refundHour, refundAmount, refundPromotionHour, refundPromotionAmount, cpId, num(cp.lock_version)]
  ));
  const contractId = str(cp.contract_id);
  if (contractId && refundAmount > 0) {
    const contract = await one(client, `select paid_amount, total_amount, promotion_amount from ${table(schemaName, "contract")} where id = $1`, [contractId]);
    const nextPaid = Math.max(num(contract?.paid_amount) - refundAmount, 0);
    const payable = Math.max(num(contract?.total_amount) - num(contract?.promotion_amount), 0);
    const status = nextPaid <= 0 ? "UNPAID" : nextPaid >= payable ? "PAID" : "PART_PAID";
    await client.query(`update ${table(schemaName, "contract")} set paid_amount = $1, paid_status = $2, updated_at = now() where id = $3`, [nextPaid, status, contractId]);
  }
  if (contractId) {
    const { rows: allCps } = await client.query(`select coalesce(remaining_real_hour,0) as rh, coalesce(remaining_real_amount,0) as ra, coalesce(remaining_promotion_hour,0) as ph, coalesce(remaining_promotion_amount,0) as pa from ${table(schemaName, "contract_product")} where contract_id = $1 and deleted = false`, [contractId]);
    const allZero = allCps.every((r) => num(r.rh) <= 0 && num(r.ra) <= 0 && num(r.ph) <= 0 && num(r.pa) <= 0);
    if (allZero) await client.query(`update ${table(schemaName, "contract")} set contract_status = 'REFUNDED', updated_at = now() where id = $1`, [contractId]);
  }
  if (refund && refundAmount > 0 && str(input.refund_way_config_id)) {
    const payWay = await one(client, `select pay_way_type from ${table(schemaName, "pay_way_config")} where id = $1 and deleted = false`, [input.refund_way_config_id]);
    if (str(payWay?.pay_way_type) === "ELE_ACCOUNT") {
      await changeStudentEleAccount(client, schemaName, {
        studentId: str(refund.student_id),
        amount: refundAmount,
        changeType: "REFUND_IN",
        sourceRefundId: str(refund.id),
        contractId: contractId || undefined,
        remark: str(input.remark, "退费入电子账户")
      });
    }
  }
  if (refund) await arrangeNegativePerformanceForRefund(client, schemaName, str(refund.id), refund, rule);
  return refund;
}

async function reverseCharge(client: pg.PoolClient, schemaName: string, params: Record<string, unknown>, rule: BusinessRule = {}) {
  const input = dataOf(params);
  const chargeId = str(params.id ?? input.charge_id);
  if (!chargeId) throw new Error("缺少扣费记录 ID");
  const cancelReason = str(input.cancel_reason ?? input.reason ?? input.remark);
  if (rule.requireCancelReason !== false && !cancelReason) throw new Error("取消扣费必须填写取消原因");
  const operatorId = str(params.__userId ?? input.operator_id);
  const charge = await one(client, `select * from ${table(schemaName, "account_charge_records")} where id = $1 and deleted = false for update`, [chargeId]);
  if (!charge) throw new Error("扣费记录不存在");
  if (str(charge.charge_status) === "REVERSED") throw new Error("该扣费记录已撤销");
  const cpId = str(charge.contract_product_id);
  const reverseId = await nextTextId(client, schemaName, "account_charge_records");
  const cancelMeta = { reversedFrom: chargeId, cancelReason, operatorId, cancelledAt: new Date().toISOString(), syncAttendance: rule.cancelAttendanceOnChargeReverse !== false };
  await client.query(
    `insert into ${table(schemaName, "account_charge_records")}
      (id, course_id, charge_type, charge_hour, charge_amount, contract_product_id, organization_id, student_id, charge_status, reversed_record_id, cancel_reason, cancel_user_id, cancel_time, ext_json)
     values ($1,$2,$3,$4,$5,$6,$7,$8,'REVERSED',$9,$10,$11,now(),$12)`,
    [reverseId, charge.course_id, charge.charge_type, -num(charge.charge_hour), -num(charge.charge_amount), cpId, charge.organization_id, charge.student_id, chargeId, cancelReason || null, operatorId || null, JSON.stringify(cancelMeta)]
  );
  await client.query(`update ${table(schemaName, "account_charge_records")} set charge_status = 'REVERSED', cancel_reason = $2, cancel_user_id = $3, cancel_time = now(), ext_json = coalesce(ext_json,'{}'::jsonb) || $4::jsonb, updated_at = now() where id = $1`, [chargeId, cancelReason || null, operatorId || null, JSON.stringify(cancelMeta)]);
  if (cpId) {
    const cp = await one(client, `select lock_version from ${table(schemaName, "contract_product")} where id = $1 and deleted = false for update`, [cpId]);
    if (!cp) throw new Error("合同产品不存在");
    const chargeType = str(charge.charge_type);
    const hour = num(charge.charge_hour);
    const amount = num(charge.charge_amount);
    if (chargeType === "NORMAL") {
      await assertUpdated(await client.query(`update ${table(schemaName, "contract_product")} set consumed_real_hour = coalesce(consumed_real_hour,0) - $1, consumed_real_amount = coalesce(consumed_real_amount,0) - $2, remaining_real_hour = coalesce(remaining_real_hour,0) + $1, remaining_real_amount = coalesce(remaining_real_amount,0) + $2, lock_version = coalesce(lock_version,0) + 1, updated_at = now() where id = $3 and coalesce(lock_version,0) = $4`, [hour, amount, cpId, num(cp.lock_version)]));
    } else if (chargeType === "PROMOTION") {
      await assertUpdated(await client.query(`update ${table(schemaName, "contract_product")} set consumed_promotion_amount = coalesce(consumed_promotion_amount,0) - $1, remaining_promotion_amount = coalesce(remaining_promotion_amount,0) + $1, lock_version = coalesce(lock_version,0) + 1, updated_at = now() where id = $2 and coalesce(lock_version,0) = $3`, [amount, cpId, num(cp.lock_version)]));
    } else if (chargeType === "PROMOTION_HOUR") {
      await assertUpdated(await client.query(`update ${table(schemaName, "contract_product")} set consumed_promotion_hour = coalesce(consumed_promotion_hour,0) - $1, remaining_promotion_hour = coalesce(remaining_promotion_hour,0) + $1, lock_version = coalesce(lock_version,0) + 1, updated_at = now() where id = $2 and coalesce(lock_version,0) = $3`, [hour, cpId, num(cp.lock_version)]));
    }
  }
  let attendanceReset = false;
  if (str(charge.course_id) && str(charge.student_id) && rule.cancelAttendanceOnChargeReverse !== false) {
    await client.query(`update ${table(schemaName, "generic_course_student")} set attendance_status = 'PENDING', attendance_time = null, updated_at = now() where course_id = $1 and student_id = $2 and deleted = false`, [charge.course_id, charge.student_id]);
    attendanceReset = true;
  }
  return { reversed: true, originalChargeId: chargeId, reverseRecordId: reverseId, cancelReason, operatorId, attendanceReset };
}


async function previewCharge(client: pg.PoolClient, schemaName: string, params: Record<string, unknown>) {
  const input = dataOf(params);
  const cpId = str(input.contract_product_id);
  if (!cpId) throw new Error("缺少 contract_product_id");
  const cp = await one(client, `select * from ${table(schemaName, "contract_product")} where id = $1 and deleted = false`, [cpId]);
  if (!cp) throw new Error("合同产品不存在");
  return {
    contractProductId: cpId,
    chargeType: str(input.charge_type, "NORMAL"),
    availableRealHour: num(cp.remaining_real_hour),
    availableRealAmount: num(cp.remaining_real_amount),
    availablePromotionHour: num(cp.remaining_promotion_hour),
    availablePromotionAmount: num(cp.remaining_promotion_amount),
    suggestedChargeHour: Math.min(num(input.charge_hour, 1), num(cp.remaining_real_hour)),
    suggestedChargeAmount: Math.min(num(input.charge_amount), num(cp.remaining_real_amount))
  };
}

async function contract_refund(client: pg.PoolClient, schemaName: string, params: Record<string, unknown>, rule: BusinessRule) {
  const input = dataOf(params);
  const contractId = str(input.contract_id);
  if (!contractId) throw new Error("合同退费必须选择合同");
  const contract = await one(client, `select * from ${table(schemaName, "contract")} where id = $1 and deleted = false for update`, [contractId]);
  if (!contract) throw new Error("合同不存在");
  if (str(contract.contract_status) === "REFUNDED") throw new Error("合同已退费");
  if (str(contract.contract_status) === "CLOSED") throw new Error("合同已关闭，不可退费");

  const { rows: cpRows } = await client.query(
    `select * from ${table(schemaName, "contract_product")} where contract_id = $1 and deleted = false for update`,
    [contractId]
  );
  if (!cpRows.length) throw new Error("合同下无有效合同产品");

  const totalRefundAmount = num(input.refund_real_amount);
  const totalRefundPromotionAmount = num(input.refund_promotion_amount);
  const totalRefundHour = num(input.refund_real_hour);
  const totalRefundPromotionHour = num(input.refund_promotion_hour);

  const totalRemainingReal = cpRows.reduce((s, r) => s + num(r.remaining_real_amount), 0);
  const totalRemainingPromotion = cpRows.reduce((s, r) => s + num(r.remaining_promotion_amount), 0);
  const totalRemainingRealHour = cpRows.reduce((s, r) => s + num(r.remaining_real_hour), 0);
  const totalRemainingPromotionHour = cpRows.reduce((s, r) => s + num(r.remaining_promotion_hour), 0);

  const targetRefundAmount = totalRefundAmount > 0 ? totalRefundAmount : totalRemainingReal;
  const targetRefundPromotionAmount = totalRefundPromotionAmount > 0 ? totalRefundPromotionAmount : totalRemainingPromotion;
  const targetRefundHour = totalRefundHour > 0 ? totalRefundHour : totalRemainingRealHour;
  const targetRefundPromotionHour = totalRefundPromotionHour > 0 ? totalRefundPromotionHour : totalRemainingPromotionHour;

  if (rule.allowRefundOverBalance !== true) {
    if (targetRefundAmount > totalRemainingReal) throw new Error("退费金额超过合同实收剩余");
    if (targetRefundPromotionAmount > totalRemainingPromotion) throw new Error("退费优惠金额超过合同优惠剩余");
    if (targetRefundHour > totalRemainingRealHour) throw new Error("退费课时超过合同实收剩余课时");
    if (targetRefundPromotionHour > totalRemainingPromotionHour) throw new Error("退费赠送课时超过合同优惠剩余课时");
  }

  const refundPayWay = str(input.refund_way_config_id)
    ? await one(client, `select pay_way_type from ${table(schemaName, "pay_way_config")} where id = $1 and deleted = false`, [input.refund_way_config_id])
    : undefined;
  const refundToEleAccount = str(refundPayWay?.pay_way_type) === "ELE_ACCOUNT";

  const refundRecords = [];
  let remainRefundAmount = targetRefundAmount;
  let remainRefundPromotionAmount = targetRefundPromotionAmount;
  let remainRefundHour = targetRefundHour;
  let remainRefundPromotionHour = targetRefundPromotionHour;

  for (let index = 0; index < cpRows.length; index += 1) {
    const cp = cpRows[index];
    const isLast = index === cpRows.length - 1;
    const cpRemainingReal = num(cp.remaining_real_amount);
    const cpRemainingPromotion = num(cp.remaining_promotion_amount);
    const cpRemainingRealHour = num(cp.remaining_real_hour);
    const cpRemainingPromotionHour = num(cp.remaining_promotion_hour);

    const realProportion = totalRemainingReal > 0 ? cpRemainingReal / totalRemainingReal : (1 / cpRows.length);
    const realHourProportion = totalRemainingRealHour > 0 ? cpRemainingRealHour / totalRemainingRealHour : realProportion;
    const promotionProportion = totalRemainingPromotion > 0 ? cpRemainingPromotion / totalRemainingPromotion : realProportion;
    const promotionHourProportion = totalRemainingPromotionHour > 0 ? cpRemainingPromotionHour / totalRemainingPromotionHour : promotionProportion;
    const cpRefundHour = isLast ? roundMoney(remainRefundHour) : floorMoney(targetRefundHour * realHourProportion);
    const cpRefundAmount = isLast ? roundMoney(remainRefundAmount) : floorMoney(targetRefundAmount * realProportion);
    const cpRefundPromotionHour = isLast ? roundMoney(remainRefundPromotionHour) : floorMoney(targetRefundPromotionHour * promotionHourProportion);
    const cpRefundPromotionAmount = isLast ? roundMoney(remainRefundPromotionAmount) : floorMoney(targetRefundPromotionAmount * promotionProportion);

    remainRefundHour = roundMoney(remainRefundHour - cpRefundHour);
    remainRefundAmount = roundMoney(remainRefundAmount - cpRefundAmount);
    remainRefundPromotionHour = roundMoney(remainRefundPromotionHour - cpRefundPromotionHour);
    remainRefundPromotionAmount = roundMoney(remainRefundPromotionAmount - cpRefundPromotionAmount);

    if (cpRefundHour <= 0 && cpRefundAmount <= 0 && cpRefundPromotionHour <= 0 && cpRefundPromotionAmount <= 0) continue;

    const refund = await one(client,
      `insert into ${table(schemaName, "refund_record")}
        (id, student_id, contract_product_id, contract_id, refund_type, proportion, refund_real_hour, refund_real_amount, refund_promotion_amount, refund_promotion_hour, refund_way_config_id, refund_time, remark, ext_json)
       values ($1,$2,$3,$4,'CONTRACT',$5,$6,$7,$8,$9,$10,$11,$12,$13)
       returning *`,
      [
        await nextTextId(client, schemaName, "refund_record"),
        contract.student_id,
        cp.id,
        contractId,
        roundMoney(realProportion),
        cpRefundHour,
        cpRefundAmount,
        cpRefundPromotionAmount,
        cpRefundPromotionHour,
        input.refund_way_config_id,
        str(input.refund_time, new Date().toISOString()),
        input.remark,
        JSON.stringify({ ruleCode: "contract_refund_rule", rule })
      ]
    );
    refundRecords.push(refund);
    if (refund) await arrangeNegativePerformanceForRefund(client, schemaName, str(refund.id), refund, rule);
    // 电子账户退款逐条入账：每条退费记录挂自己的 REFUND_IN，删除单条退费时回滚金额才能对得上
    if (refund && refundToEleAccount && cpRefundAmount > 0) {
      await changeStudentEleAccount(client, schemaName, {
        studentId: str(contract.student_id),
        amount: cpRefundAmount,
        changeType: "REFUND_IN",
        sourceRefundId: str(refund.id),
        contractId,
        remark: str(input.remark, "合同退费入电子账户")
      });
    }

    await assertUpdated(await client.query(
      `update ${table(schemaName, "contract_product")}
       set remaining_real_hour = coalesce(remaining_real_hour,0) - $1,
           remaining_real_amount = coalesce(remaining_real_amount,0) - $2,
           remaining_promotion_hour = coalesce(remaining_promotion_hour,0) - $3,
           remaining_promotion_amount = coalesce(remaining_promotion_amount,0) - $4,
           lock_version = coalesce(lock_version,0) + 1,
           updated_at = now()
       where id = $5 and coalesce(lock_version,0) = $6`,
      [cpRefundHour, cpRefundAmount, cpRefundPromotionHour, cpRefundPromotionAmount, cp.id, num(cp.lock_version)]
    ));
  }

  const nextPaid = Math.max(num(contract.paid_amount) - targetRefundAmount, 0);
  const payable = Math.max(num(contract.total_amount) - num(contract.promotion_amount), 0);
  const paidStatus = nextPaid <= 0 ? "UNPAID" : nextPaid >= payable ? "PAID" : "PART_PAID";

  const { rows: updatedCps } = await client.query(`select coalesce(remaining_real_hour,0) as rh, coalesce(remaining_real_amount,0) as ra, coalesce(remaining_promotion_hour,0) as ph, coalesce(remaining_promotion_amount,0) as pa from ${table(schemaName, "contract_product")} where contract_id = $1 and deleted = false`, [contractId]);
  const allZero = updatedCps.every((r) => num(r.rh) <= 0 && num(r.ra) <= 0 && num(r.ph) <= 0 && num(r.pa) <= 0);
  const contractStatus = allZero ? "REFUNDED" : str(contract.contract_status);

  await client.query(
    `update ${table(schemaName, "contract")} set paid_amount = $1, paid_status = $2, contract_status = $3, updated_at = now() where id = $4`,
    [nextPaid, paidStatus, contractStatus, contractId]
  );

  return { contractId, refundRecords, totalRefundAmount: targetRefundAmount, contractStatus };
}

async function refund_delete(client: pg.PoolClient, schemaName: string, params: Record<string, unknown>) {
  const refundId = str(params.id ?? dataOf(params).id);
  if (!refundId) throw new Error("缺少退费记录 ID");
  const refund = await one(client, `select * from ${table(schemaName, "refund_record")} where id = $1 and deleted = false for update`, [refundId]);
  if (!refund) throw new Error("退费记录不存在或已删除");

  const cpId = str(refund.contract_product_id);
  if (cpId) {
    const cp = await one(client, `select lock_version from ${table(schemaName, "contract_product")} where id = $1 and deleted = false for update`, [cpId]);
    if (!cp) throw new Error("合同产品不存在或已删除");
    const refundHour = num(refund.refund_real_hour);
    const refundAmount = num(refund.refund_real_amount);
    const refundPromotionHour = num(refund.refund_promotion_hour);
    const refundPromotionAmount = num(refund.refund_promotion_amount);

    await assertUpdated(await client.query(
      `update ${table(schemaName, "contract_product")}
       set remaining_real_hour = coalesce(remaining_real_hour,0) + $1,
           remaining_real_amount = coalesce(remaining_real_amount,0) + $2,
           remaining_promotion_hour = coalesce(remaining_promotion_hour,0) + $3,
           remaining_promotion_amount = coalesce(remaining_promotion_amount,0) + $4,
           lock_version = coalesce(lock_version,0) + 1,
           updated_at = now()
       where id = $5 and coalesce(lock_version,0) = $6`,
      [refundHour, refundAmount, refundPromotionHour, refundPromotionAmount, cpId, num(cp.lock_version)]
    ));
  }

  const contractId = str(refund.contract_id);
  if (contractId) {
    const contract = await one(client, `select * from ${table(schemaName, "contract")} where id = $1 and deleted = false for update`, [contractId]);
    const refundAmount = num(refund.refund_real_amount);
    const nextPaid = num(contract?.paid_amount) + refundAmount;
    const payable = Math.max(num(contract?.total_amount) - num(contract?.promotion_amount), 0);
    const paidStatus = nextPaid <= 0 ? "UNPAID" : nextPaid >= payable ? "PAID" : "PART_PAID";
    const contractStatus = str(contract?.contract_status) === "REFUNDED" ? "ACTIVE" : str(contract?.contract_status);
    await client.query(
      `update ${table(schemaName, "contract")} set paid_amount = $1, paid_status = $2, contract_status = $3, updated_at = now() where id = $4`,
      [nextPaid, paidStatus, contractStatus, contractId]
    );
  } else if (cpId) {
    const cp = await one(client, `select contract_id from ${table(schemaName, "contract_product")} where id = $1 and deleted = false`, [cpId]);
    const cpContractId = str(cp?.contract_id);
    if (cpContractId && num(refund.refund_real_amount) > 0) {
      const contract = await one(client, `select * from ${table(schemaName, "contract")} where id = $1 and deleted = false for update`, [cpContractId]);
      const nextPaid = num(contract?.paid_amount) + num(refund.refund_real_amount);
      const payable = Math.max(num(contract?.total_amount) - num(contract?.promotion_amount), 0);
      const paidStatus = nextPaid <= 0 ? "UNPAID" : nextPaid >= payable ? "PAID" : "PART_PAID";
      const contractStatus = str(contract?.contract_status) === "REFUNDED" ? "ACTIVE" : str(contract?.contract_status);
      await client.query(
        `update ${table(schemaName, "contract")} set paid_amount = $1, paid_status = $2, contract_status = $3, updated_at = now() where id = $4`,
        [nextPaid, paidStatus, contractStatus, cpContractId]
      );
    }
  }

  const eleAccountRecord = await one(client,
    `select id from ${table(schemaName, "student_ele_account_record")} where source_refund_id = $1 and change_type = 'REFUND_IN' and deleted = false`,
    [refundId]
  );
  if (eleAccountRecord) {
    await changeStudentEleAccount(client, schemaName, {
      studentId: str(refund.student_id),
      amount: -num(refund.refund_real_amount),
      changeType: "REFUND_DELETE",
      sourceRefundId: refundId,
      remark: "删除退费记录回滚电子账户"
    });
  }

  // 冲回该退费产生的负业绩（REFUND_REVERSE），否则删除退费后业绩永久少计
  await client.query(
    `update ${table(schemaName, "performance_arrange_log")} set deleted = true, updated_at = now()
     where coalesce(ext_json->>'sourceRefundId','') = $1 and deleted = false`,
    [refundId]
  );

  await client.query(`update ${table(schemaName, "refund_record")} set deleted = true, updated_at = now() where id = $1`, [refundId]);
  return { deleted: true, refundId };
}

async function course_delete(client: pg.PoolClient, schemaName: string, params: Record<string, unknown>, rule: BusinessRule = {}) {
  const courseId = str(params.id ?? (dataOf(params)).course_id);
  if (!courseId) throw new Error("缺少课程 ID");
  const course = await one(client, `select * from ${table(schemaName, "generic_course")} where id = $1 and deleted = false for update`, [courseId]);
  if (!course) throw new Error("课程不存在");
  if (str(course.course_status) === "CANCELLED") return { deleted: true, courseId, note: "already_cancelled" };

  const { rows: charges } = await client.query(
    `select * from ${table(schemaName, "account_charge_records")} where course_id = $1 and charge_status = 'CONFIRMED' and deleted = false for update`,
    [courseId]
  );
  if (charges.length && rule.allowDeleteWithCharges === false) throw new Error("该排课已有确认扣费，不允许删除");
  const deleteReason = str(dataOf(params).cancel_reason ?? dataOf(params).reason ?? dataOf(params).delete_reason);
  if (rule.requireDeleteReason === true && !deleteReason) throw new Error("删除排课必须填写原因");
  if (rule.reverseChargesOnDelete !== false) {
    for (const charge of charges) {
      await reverseCharge(client, schemaName, { id: charge.id, cancel_reason: str(deleteReason, "删除排课同步取消扣费"), __userId: params.__userId }, { requireCancelReason: false, cancelAttendanceOnChargeReverse: false });
    }
  }

  const { rows: students } = await client.query(
    `select * from ${table(schemaName, "generic_course_student")} where course_id = $1 and deleted = false`,
    [courseId]
  );
  const attendedStudents = students.filter((student) => str(student.attendance_status) === "PRESENT");
  if (attendedStudents.length && rule.allowDeleteWithAttendance === false) throw new Error("该排课已有考勤记录，不允许删除");
  if (rule.resetAttendanceOnDelete !== false) {
    for (const student of attendedStudents) {
      await client.query(
        `update ${table(schemaName, "generic_course_student")} set attendance_status = 'PENDING', attendance_time = null, updated_at = now() where id = $1`,
        [student.id]
      );
    }
  }

  await client.query(`update ${table(schemaName, "generic_course_student")} set deleted = true, updated_at = now() where course_id = $1 and deleted = false`, [courseId]);
  await client.query(`update ${table(schemaName, "generic_course")} set course_status = 'CANCELLED', deleted = true, updated_at = now() where id = $1`, [courseId]);

  return { deleted: true, courseId, reversedCharges: rule.reverseChargesOnDelete === false ? 0 : charges.length, resetAttendance: rule.resetAttendanceOnDelete === false ? 0 : attendedStudents.length };
}

async function attendance_check_in(client: pg.PoolClient, schemaName: string, params: Record<string, unknown>, rule: BusinessRule) {
  const input = dataOf(params);
  const courseId = str(input.course_id);
  if (!courseId) throw new Error("考勤必须选择课程");
  const course = await one(client, `select * from ${table(schemaName, "generic_course")} where id = $1 and deleted = false for update`, [courseId]);
  if (!course) throw new Error("课程不存在");
  if (str(course.course_status) === "CANCELLED") throw new Error("课程已取消");

  const courseHour = num(course.course_hour, 1);
  const students = Array.isArray(input.students) ? input.students as Record<string, unknown>[] : [];
  const attendanceMode = str(input.__attendanceMode, "charge");

  const succeeded: Record<string, unknown>[] = [];
  const failed: Record<string, unknown>[] = [];

  for (const stu of students) {
    const studentId = str(stu.student_id);
    const cpId = str(stu.contract_product_id);
    if (!studentId) continue;

    const courseStudent = await one(client,
      `select * from ${table(schemaName, "generic_course_student")} where course_id = $1 and student_id = $2 and deleted = false for update`,
      [courseId, studentId]
    );
    if (!courseStudent) { failed.push({ studentId, reason: "学员不在课程中" }); continue; }
    if (stu.reverse_charge === true) {
      const { rows: charges } = await client.query(`select id from ${table(schemaName, "account_charge_records")} where course_id = $1 and student_id = $2 and deleted = false and coalesce(charge_status,'CONFIRMED') <> 'REVERSED'`, [courseId, studentId]);
      for (const charge of charges) await reverseCharge(client, schemaName, { id: charge.id, cancel_reason: "考勤页取消扣费", __userId: params.__userId }, { requireCancelReason: false, cancelAttendanceOnChargeReverse: false });
      await client.query(`update ${table(schemaName, "generic_course_student")} set attendance_status = 'PENDING', attendance_time = null, updated_at = now() where id = $1`, [courseStudent.id]);
      if (stu.cancel_attendance !== true && str(stu.attendance_status) !== "PENDING") {
        succeeded.push({ studentId, reversedChargeCount: charges.length, attendanceStatus: "PENDING" });
        continue;
      }
    }
    if (stu.cancel_attendance === true || str(stu.attendance_status) === "PENDING") {
      await client.query(`update ${table(schemaName, "generic_course_student")} set attendance_status = 'PENDING', attendance_time = null, updated_at = now() where id = $1`, [courseStudent.id]);
      succeeded.push({ studentId, attendanceStatus: "PENDING", canceled: true });
      continue;
    }
    if (str(courseStudent.attendance_status) === "PRESENT" && stu.reverse_charge !== true) { succeeded.push({ studentId, skipped: true, reason: "已签到，如需改判请先取消考勤/扣费" }); continue; }
    const targetStatus = dictBare(stu.attendance_status ?? stu.status, "PRESENT");
    const shouldCharge = targetStatus === "PRESENT" || (targetStatus === "ABSENT" && rule.absentCharge !== false) || (targetStatus === "LEAVE" && rule.leaveCharge === true);
    if (!["PRESENT", "ABSENT", "LEAVE"].includes(targetStatus)) { failed.push({ studentId, reason: "不支持的考勤状态" }); continue; }
    // 幂等防护：该学员本课次已有确认扣费（如已按缺勤扣费后改判/重复提交），只更新考勤状态，绝不重复扣费
    const existingCharge = await one(client,
      `select id from ${table(schemaName, "account_charge_records")} where course_id = $1 and student_id = $2 and charge_status = 'CONFIRMED' and deleted = false limit 1`,
      [courseId, studentId]
    );
    if (existingCharge) {
      await client.query(
        `update ${table(schemaName, "generic_course_student")} set attendance_status = $1, attendance_time = now(), updated_at = now() where id = $2`,
        [targetStatus, courseStudent.id]
      );
      succeeded.push({ studentId, attendanceStatus: targetStatus, chargeHour: 0, chargeAmount: 0, alreadyCharged: true });
      continue;
    }
    if (attendanceMode === "attendance" && rule.deductCourseHourOnAttendance !== true) {
      await client.query(
        `update ${table(schemaName, "generic_course_student")} set attendance_status = $1, attendance_time = now(), updated_at = now() where id = $2`,
        [targetStatus, courseStudent.id]
      );
      succeeded.push({ studentId, attendanceStatus: targetStatus, chargeHour: 0, chargeAmount: 0, attendanceOnly: true });
      continue;
    }
    if (!shouldCharge) {
      await client.query(
        `update ${table(schemaName, "generic_course_student")} set attendance_status = $1, attendance_time = now(), updated_at = now() where id = $2`,
        [targetStatus, courseStudent.id]
      );
      succeeded.push({ studentId, attendanceStatus: targetStatus, chargeHour: 0, chargeAmount: 0 });
      continue;
    }
    if (!cpId) { failed.push({ studentId, reason: "未选择合同产品" }); continue; }

    const rowCourseHour = num(stu.charge_hour, courseHour);
    const cp = await one(client, `select * from ${table(schemaName, "contract_product")} where id = $1 and deleted = false for update`, [cpId]);
    if (!cp) { failed.push({ studentId, reason: "合同产品不存在" }); continue; }

    const cpContract = await one(client, `select student_id from ${table(schemaName, "contract")} where id = $1 and deleted = false`, [cp.contract_id]);
    if (str(cpContract?.student_id) !== studentId) { failed.push({ studentId, reason: "合同产品不属于该学员" }); continue; }

    const rawChargeAmount = num(cp.plan_real_amount) > 0 && num(cp.plan_real_hour) > 0
      ? rowCourseHour * (num(cp.plan_real_amount) / num(cp.plan_real_hour))
      : rowCourseHour * num(cp.unit_price ?? 0);
    const isFinalRealHourCharge = num(cp.remaining_real_hour) <= rowCourseHour;
    const chargeAmount = isFinalRealHourCharge ? num(cp.remaining_real_amount) : floorMoney(rawChargeAmount);

    if (rule.allowNegativeBalance !== true && (num(cp.remaining_real_hour) < rowCourseHour || num(cp.remaining_real_amount) < chargeAmount)) {
      failed.push({ studentId, reason: "合同产品余额不足" }); continue;
    }

    await client.query(
      `update ${table(schemaName, "generic_course_student")} set attendance_status = $1, attendance_time = now(), contract_product_id = $2, updated_at = now() where id = $3`,
      [targetStatus, cpId, courseStudent.id]
    );

    await createCharge(client, schemaName, {
      course_id: courseId,
      charge_type: "NORMAL",
      charge_hour: rowCourseHour,
      charge_amount: chargeAmount,
      contract_product_id: cpId,
      student_id: studentId,
      organization_id: course.organization_id
    }, rule);

    succeeded.push({ studentId, attendanceStatus: targetStatus, contractProductId: cpId, chargeHour: rowCourseHour, chargeAmount });
  }

  const pending = await one(client, `select count(*)::int as cnt from ${table(schemaName, "generic_course_student")} where course_id = $1 and deleted = false and coalesce(attendance_status,'PENDING') = 'PENDING'`, [courseId]);
  await client.query(
    `update ${table(schemaName, "generic_course")} set course_status = $2, updated_at = now() where id = $1 and course_status <> 'CANCELLED'`,
    [courseId, num(pending?.cnt) === 0 ? "FINISHED" : "SCHEDULED"]
  );
  return { courseId, succeeded, failed };
}

async function attendance_cancel(client: pg.PoolClient, schemaName: string, params: Record<string, unknown>) {
  const input = dataOf(params);
  const courseId = str(input.course_id);
  const studentId = str(input.student_id);
  if (!courseId || !studentId) throw new Error("取消考勤必须提供课程ID和学员ID");

  const courseStudent = await one(client,
    `select * from ${table(schemaName, "generic_course_student")} where course_id = $1 and student_id = $2 and deleted = false for update`,
    [courseId, studentId]
  );
  if (!courseStudent) throw new Error("学员不在课程中");
  if (str(courseStudent.attendance_status) !== "PRESENT") throw new Error("学员未签到，无法取消考勤");

  const { rows: charges } = await client.query(
    `select * from ${table(schemaName, "account_charge_records")} where course_id = $1 and student_id = $2 and charge_status = 'CONFIRMED' and deleted = false for update`,
    [courseId, studentId]
  );
  for (const charge of charges) {
    await reverseCharge(client, schemaName, { id: charge.id, cancel_reason: str(dataOf(params).cancel_reason ?? dataOf(params).reason, "取消考勤同步取消扣费"), __userId: params.__userId }, { requireCancelReason: false, cancelAttendanceOnChargeReverse: false });
  }

  await client.query(
    `update ${table(schemaName, "generic_course_student")} set attendance_status = 'PENDING', attendance_time = null, updated_at = now() where id = $1`,
    [courseStudent.id]
  );

  return { cancelled: true, courseId, studentId, reversedCharges: charges.length };
}

async function createLeaveRecord(client: pg.PoolClient, schemaName: string, params: Record<string, unknown>, rule: BusinessRule = {}) {
  const input = dataOf(params);
  const studentId = str(input.student_id);
  if (!studentId) throw new Error("请假必须选择学员");
  const courseId = str(input.course_id);
  const leaveId = str(params.id, await nextTextId(client, schemaName, "course_leave_record"));
  const row = await one(client,
    `insert into ${table(schemaName, "course_leave_record")}
      (id, course_id, student_id, leave_type, leave_time, leave_reason, status, organization_id, created_by, ext_json)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
    [leaveId, courseId || null, studentId, str(input.leave_type, "PERSONAL"), str(input.leave_time, new Date().toISOString()), input.leave_reason, str(input.status, "APPROVED"), input.organization_id, str(params.__userId) || null, JSON.stringify({ ruleCode: "leave_create_rule", rule })]
  );
  if (courseId && str(row?.status) === "APPROVED" && rule.approvedLeaveUpdatesAttendance !== false) {
    await client.query(`update ${table(schemaName, "generic_course_student")} set attendance_status = 'LEAVE', attendance_time = now(), updated_at = now() where course_id = $1 and student_id = $2 and deleted = false`, [courseId, studentId]);
  }
  return row;
}

async function createMakeupRecord(client: pg.PoolClient, schemaName: string, params: Record<string, unknown>, rule: BusinessRule = {}) {
  const input = dataOf(params);
  const studentId = str(input.student_id ?? (Array.isArray(input.student_ids) ? input.student_ids[0] : undefined));
  if (!studentId) throw new Error("补课必须选择学员");
  const originalCourseId = str(input.original_course_id);
  const courseResult = await createCourse(client, schemaName, { ...params, id: undefined, data: { ...input, student_ids: [studentId], course_type: str(input.course_type, "MAKEUP"), course_status: str(input.course_status, "SCHEDULED"), course_title: str(input.course_title, "补课") } }, rule);
  const makeupCourse = courseResult.course as Record<string, unknown> | undefined;
  const row = await one(client,
    `insert into ${table(schemaName, "makeup_course_record")}
      (id, original_course_id, makeup_course_id, student_id, makeup_reason, status, organization_id, created_by, ext_json)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
    [await nextTextId(client, schemaName, "makeup_course_record"), originalCourseId || null, str(makeupCourse?.id), studentId, input.makeup_reason, str(input.status, "SCHEDULED"), input.organization_id, str(params.__userId) || null, JSON.stringify({ ruleCode: "makeup_create_rule", rule })]
  );
  return { makeup: row, course: makeupCourse };
}

async function linkStudentToFutureCourses(
  client: pg.PoolClient,
  schemaName: string,
  studentId: string,
  scope: { miniClassId?: string; oneOnNGroupId?: string; productId?: unknown; grade?: unknown; subject?: unknown },
  rule: BusinessRule = {}
) {
  const byMiniClass = Boolean(scope.miniClassId);
  const { rows: courses } = await client.query(
    `select id from ${table(schemaName, "generic_course")}
     where deleted = false and course_status <> 'CANCELLED' and course_date >= current_date
       and ${byMiniClass ? "mini_class_id = $1" : "one_on_n_group_id = $1"}`,
    [byMiniClass ? scope.miniClassId : scope.oneOnNGroupId]
  );
  let linked = 0;
  for (const course of courses) {
    const exists = await one(client, `select id from ${table(schemaName, "generic_course_student")} where course_id = $1 and student_id = $2 and deleted = false`, [course.id, studentId]);
    if (exists) continue;
    const cpId = await autoSelectCp(client, schemaName, studentId, { productId: scope.productId, grade: scope.grade, subject: scope.subject }, rule);
    await client.query(
      `insert into ${table(schemaName, "generic_course_student")}
        (id, course_id, student_id, attendance_status, contract_product_id, mini_class_id, one_on_n_group_id)
       values ($1,$2,$3,'PENDING',$4,$5,$6)`,
      [await nextTextId(client, schemaName, "generic_course_student"), course.id, studentId, cpId, scope.miniClassId ?? null, scope.oneOnNGroupId ?? null]
    );
    linked += 1;
  }
  return linked;
}

async function transferClassStudents(client: pg.PoolClient, schemaName: string, params: Record<string, unknown>, rule: BusinessRule = {}) {
  const input = dataOf(params);
  const targetType = str(input.target_type, "mini_class");
  const studentIds = (Array.isArray(input.student_ids) ? input.student_ids : [input.student_id]).map(String).filter(Boolean);
  if (!studentIds.length) throw new Error("批量调班必须选择学员");
  const fromId = str(input.from_target_id ?? input.from_class_id ?? input.from_group_id);
  const toId = str(input.to_target_id ?? input.to_class_id ?? input.to_group_id);
  if (!fromId || !toId) throw new Error("批量调班必须选择原班级/小组和目标班级/小组");
  if (fromId === toId) throw new Error("原班级/小组和目标班级/小组不能相同");
  const isMini = targetType !== "one_on_n_group";
  const memberTable = isMini ? "mini_class_student" : "one_on_n_group_student";
  const targetColumn = isMini ? "mini_class_id" : "one_on_n_group_id";
  const target = await one(client, `select * from ${table(schemaName, isMini ? "mini_class" : "one_on_n_group")} where id = $1 and deleted = false for update`, [toId]);
  if (!target) throw new Error("目标班级/小组不存在");
  if (["CLOSED", "FULL"].includes(str(target.status))) throw new Error("目标班级/小组已满班或已结班");
  const count = await one(client, `select count(*)::int as cnt from ${table(schemaName, memberTable)} where ${targetColumn} = $1 and deleted = false`, [toId]);
  if (num(count?.cnt) + studentIds.length > num(target.capacity, 999)) throw new Error("目标班级/小组容量不足");
  let transferred = 0;
  for (const studentId of studentIds) {
    const record = await one(client, `select * from ${table(schemaName, memberTable)} where ${targetColumn} = $1 and student_id = $2 and deleted = false`, [fromId, studentId]);
    if (!record) continue;
    await cleanupRemovedStudentCourses(client, schemaName, { studentId, miniClassId: isMini ? fromId : undefined, oneOnNGroupId: isMini ? undefined : fromId, policy: str(rule.transferFutureCoursePolicy, "delete_uncharged_course_students") });
    await client.query(`update ${table(schemaName, memberTable)} set deleted = true, updated_at = now() where id = $1`, [record.id]);
    await client.query(`insert into ${table(schemaName, memberTable)} (id, ${targetColumn}, student_id, join_date, status) values ($1,$2,$3,current_date,'ACTIVE')`, [await nextTextId(client, schemaName, memberTable), toId, studentId]);
    const historyType = isMini ? "mini_class" : "one_on_n_group";
    await writeClassStudentHistory(client, schemaName, { targetType: historyType, targetId: fromId, studentId, changeType: "LEAVE", reason: input.reason, ext: { transferTo: toId, linkedBy: "classStudent.transfer" } });
    await writeClassStudentHistory(client, schemaName, { targetType: historyType, targetId: toId, studentId, changeType: "JOIN", reason: input.reason, ext: { transferFrom: fromId, linkedBy: "classStudent.transfer" } });
    await linkStudentToFutureCourses(client, schemaName, studentId, { miniClassId: isMini ? toId : undefined, oneOnNGroupId: isMini ? undefined : toId, productId: target.product_id, grade: target.grade, subject: target.subject }, rule);
    transferred += 1;
  }
  return { transferred, targetType, fromId, toId };
}

async function changeClassStatus(client: pg.PoolClient, schemaName: string, params: Record<string, unknown>) {
  const input = dataOf(params);
  const targetType = str(input.target_type, String(params.target_type ?? "mini_class"));
  const id = str(input.id ?? params.id ?? input.target_id);
  const status = str(input.target_status ?? input.status);
  if (!id || !status) throw new Error("缺少班级/小组 ID 或状态");
  const targetTable = targetType === "one_on_n_group" ? "one_on_n_group" : "mini_class";
  await client.query(`update ${table(schemaName, targetTable)} set status = $1, updated_at = now() where id = $2 and deleted = false`, [status, id]);
  return { updated: true, targetType, id, status };
}

async function mini_class_add_student(client: pg.PoolClient, schemaName: string, params: Record<string, unknown>, rule: BusinessRule = {}) {
  const input = dataOf(params);
  const miniClassId = str(input.mini_class_id);
  if (!miniClassId) throw new Error("缺少班级 ID");
  const miniClass = await one(client, `select * from ${table(schemaName, "mini_class")} where id = $1 and deleted = false for update`, [miniClassId]);
  if (!miniClass) throw new Error("班级不存在");
  if (["CLOSED", "FULL"].includes(str(miniClass.status))) throw new Error("班级已满班或已结班，不能继续添加学员");

  const studentIds = (Array.isArray(input.student_ids) ? input.student_ids : []).map(String).filter(Boolean);
  if (!studentIds.length) throw new Error("至少选择一个学员");

  const { rows: existing } = await client.query(`select student_id from ${table(schemaName, "mini_class_student")} where mini_class_id = $1 and deleted = false`, [miniClassId]);
  const existingSet = new Set(existing.map((r) => String(r.student_id)));
  if (existingSet.size + studentIds.length > num(miniClass.capacity, 999)) throw new Error("超出班级容量");

  const added: string[] = [];
  let linkedCourses = 0;
  for (const studentId of studentIds) {
    if (existingSet.has(studentId)) continue;
    await client.query(
      `insert into ${table(schemaName, "mini_class_student")} (id, mini_class_id, student_id, join_date, status) values ($1,$2,$3,current_date,'ACTIVE')`,
      [await nextTextId(client, schemaName, "mini_class_student"), miniClassId, studentId]
    );
    await writeClassStudentHistory(client, schemaName, { targetType: "mini_class", targetId: miniClassId, studentId, changeType: "JOIN", reason: input.reason, ext: { linkedBy: "miniClass.addStudent" } });
    linkedCourses += await linkStudentToFutureCourses(client, schemaName, studentId, { miniClassId, productId: miniClass.product_id, grade: miniClass.grade, subject: miniClass.subject }, rule);
    added.push(studentId);
  }
  return { miniClassId, added: added.length, linkedCourses };
}

async function mini_class_remove_student(client: pg.PoolClient, schemaName: string, params: Record<string, unknown>, rule: BusinessRule = {}) {
  const input = dataOf(params);
  const miniClassId = str(input.mini_class_id);
  const studentId = str(input.student_id);
  if (!miniClassId || !studentId) throw new Error("缺少班级ID或学员ID");

  const record = await one(client, `select * from ${table(schemaName, "mini_class_student")} where mini_class_id = $1 and student_id = $2 and deleted = false`, [miniClassId, studentId]);
  if (!record) throw new Error("学员不在该班级中");

  const policy = str(rule.removeAttendedStudentPolicy, "block_attended");
  const cleanup = await cleanupRemovedStudentCourses(client, schemaName, { studentId, miniClassId, policy });
  await client.query(`update ${table(schemaName, "mini_class_student")} set deleted = true, updated_at = now() where id = $1`, [record.id]);
  await writeClassStudentHistory(client, schemaName, { targetType: "mini_class", targetId: miniClassId, studentId, changeType: "LEAVE", reason: input.reason, ext: { policy, ...cleanup } });
  return { removed: true, miniClassId, studentId, ...cleanup };
}

async function one_on_n_group_add_student(client: pg.PoolClient, schemaName: string, params: Record<string, unknown>, rule: BusinessRule = {}) {
  const input = dataOf(params);
  const groupId = str(input.one_on_n_group_id);
  if (!groupId) throw new Error("缺少1对N小组 ID");
  const group = await one(client, `select * from ${table(schemaName, "one_on_n_group")} where id = $1 and deleted = false for update`, [groupId]);
  if (!group) throw new Error("1对N小组不存在");
  if (["CLOSED", "FULL"].includes(str(group.status))) throw new Error("1对N小组已满组或已结组，不能继续添加学员");

  const studentIds = (Array.isArray(input.student_ids) ? input.student_ids : []).map(String).filter(Boolean);
  if (!studentIds.length) throw new Error("至少选择一个学员");

  const { rows: existing } = await client.query(`select student_id from ${table(schemaName, "one_on_n_group_student")} where one_on_n_group_id = $1 and deleted = false`, [groupId]);
  const existingSet = new Set(existing.map((r) => String(r.student_id)));
  if (existingSet.size + studentIds.length > num(group.capacity, 999)) throw new Error("超出小组容量");

  const added: string[] = [];
  let linkedCourses = 0;
  for (const studentId of studentIds) {
    if (existingSet.has(studentId)) continue;
    await client.query(
      `insert into ${table(schemaName, "one_on_n_group_student")} (id, one_on_n_group_id, student_id, join_date, status) values ($1,$2,$3,current_date,'ACTIVE')`,
      [await nextTextId(client, schemaName, "one_on_n_group_student"), groupId, studentId]
    );
    await writeClassStudentHistory(client, schemaName, { targetType: "one_on_n_group", targetId: groupId, studentId, changeType: "JOIN", reason: input.reason, ext: { linkedBy: "oneOnNGroup.addStudent" } });
    linkedCourses += await linkStudentToFutureCourses(client, schemaName, studentId, { oneOnNGroupId: groupId, grade: group.grade, subject: group.subject }, rule);
    added.push(studentId);
  }
  return { oneOnNGroupId: groupId, added: added.length, linkedCourses };
}

async function one_on_n_group_remove_student(client: pg.PoolClient, schemaName: string, params: Record<string, unknown>, rule: BusinessRule = {}) {
  const input = dataOf(params);
  const groupId = str(input.one_on_n_group_id);
  const studentId = str(input.student_id);
  if (!groupId || !studentId) throw new Error("缺少1对N小组ID或学员ID");

  const record = await one(client, `select * from ${table(schemaName, "one_on_n_group_student")} where one_on_n_group_id = $1 and student_id = $2 and deleted = false`, [groupId, studentId]);
  if (!record) throw new Error("学员不在该小组中");

  const policy = str(rule.removeAttendedStudentPolicy, "block_attended");
  const cleanup = await cleanupRemovedStudentCourses(client, schemaName, { studentId, oneOnNGroupId: groupId, policy });
  await client.query(`update ${table(schemaName, "one_on_n_group_student")} set deleted = true, updated_at = now() where id = $1`, [record.id]);
  await writeClassStudentHistory(client, schemaName, { targetType: "one_on_n_group", targetId: groupId, studentId, changeType: "LEAVE", reason: input.reason, ext: { policy, ...cleanup } });
  return { removed: true, oneOnNGroupId: groupId, studentId, ...cleanup };
}

async function cancelCourse(client: pg.PoolClient, schemaName: string, params: Record<string, unknown>) {
  const courseId = str(params.id ?? (dataOf(params)).course_id);
  if (!courseId) throw new Error("缺少课程 ID");
  const course = await one(client, `select * from ${table(schemaName, "generic_course")} where id = $1 and deleted = false for update`, [courseId]);
  if (!course) throw new Error("课程不存在");
  if (str(course.course_status) === "CANCELLED") return { cancelled: true, courseId, note: "already_cancelled" };
  const charge = await one(client,
    `select id from ${table(schemaName, "account_charge_records")} where course_id = $1 and charge_status = 'CONFIRMED' and deleted = false limit 1`,
    [courseId]
  );
  if (charge) throw new Error("该排课已有确认扣费，请先取消扣费，或使用删除排课（会同步冲销扣费）");
  const attended = await one(client,
    `select id from ${table(schemaName, "generic_course_student")} where course_id = $1 and deleted = false and attendance_status in ('PRESENT','ABSENT','LEAVE') limit 1`,
    [courseId]
  );
  if (attended) throw new Error("该排课已有考勤记录，请先取消考勤");
  await client.query(`update ${table(schemaName, "generic_course")} set course_status = 'CANCELLED', updated_at = now() where id = $1 and deleted = false`, [courseId]);
  return { cancelled: true, courseId };
}

async function applyHolidayToCourses(client: pg.PoolClient, schemaName: string, params: Record<string, unknown>, rule: BusinessRule = {}) {
  const input = dataOf(params);
  const holidayId = str(input.holiday_id ?? input.id);
  const mode = str(input.mode, str(rule.defaultAction, "cancel"));
  if (!holidayId) throw new Error("缺少停课日历 ID");
  if (!["cancel", "postpone"].includes(mode)) throw new Error("停课影响课程处理方式必须是 cancel 或 postpone");
  const holiday = await one(client, `select * from ${table(schemaName, "course_holiday_calendar")} where id = $1 and deleted = false for update`, [holidayId]);
  if (!holiday) throw new Error("停课日历不存在");
  const includeFinished = input.include_finished === true || rule.includeFinished === true;
  const blockAttendedOrCharged = rule.blockAttendedOrCharged !== false;
  const values: unknown[] = [holiday.holiday_date, holiday.end_date ?? holiday.holiday_date, holiday.organization_id ?? ""];
  const where = [
    "c.deleted = false",
    "c.course_date between $1::date and $2::date",
    "($3::text = '' or c.organization_id = $3)",
  ];
  if (!includeFinished) where.push("c.course_status = 'SCHEDULED'");
  if (blockAttendedOrCharged) {
    where.push(`not exists (
      select 1 from ${table(schemaName, "generic_course_student")} cs
      where cs.course_id = c.id and cs.deleted = false and cs.attendance_status in ('PRESENT','ABSENT','LEAVE')
    )`);
    where.push(`not exists (
      select 1 from ${table(schemaName, "account_charge_records")} acr
      where acr.course_id = c.id and acr.deleted = false and acr.charge_status = 'CONFIRMED'
    )`);
  }
  const candidateSql = `select c.id from ${table(schemaName, "generic_course")} c where ${where.join(" and ")}`;
  const candidates = await client.query(candidateSql, values);
  if (mode === "cancel") {
    const { rows } = await client.query(
      `update ${table(schemaName, "generic_course")} c
       set course_status = 'CANCELLED', updated_at = now(), ext_json = coalesce(ext_json,'{}'::jsonb) || $${values.length + 1}::jsonb
       where c.id in (${candidateSql}) returning id`,
      [...values, JSON.stringify({ holidayId, holidayAction: "cancel" })]
    );
    return { holidayId, mode, matched: candidates.rowCount, affected: rows.length, courseIds: rows.map((row) => row.id) };
  }
  const postponeDays = Math.max(1, num(input.postpone_days ?? input.postponeDays ?? rule.postponeDays, 7));
  const { rows } = await client.query(
    `update ${table(schemaName, "generic_course")} c
     set course_date = c.course_date + $${values.length + 1}::int,
         updated_at = now(),
         ext_json = coalesce(ext_json,'{}'::jsonb) || $${values.length + 2}::jsonb
     where c.id in (${candidateSql}) returning id, course_date`,
    [...values, postponeDays, JSON.stringify({ holidayId, holidayAction: "postpone", postponeDays })]
  );
  return { holidayId, mode, postponeDays, matched: candidates.rowCount, affected: rows.length, courses: rows };
}

async function saveCourseStudents(client: pg.PoolClient, schemaName: string, params: Record<string, unknown>) {
  const input = dataOf(params);
  const courseId = str(input.course_id ?? input.generic_course_id);
  if (!courseId) throw new Error("缺少课程 ID");
  const newStudentIds = (Array.isArray(input.student_ids) ? input.student_ids : []).map(String);
  const { rows: existing } = await client.query(`select student_id from ${table(schemaName, "generic_course_student")} where course_id = $1 and deleted = false`, [courseId]);
  const existingSet = new Set(existing.map((r) => String(r.student_id)));
  const toAdd = newStudentIds.filter((id: string) => !existingSet.has(id));
  const toRemove = [...existingSet].filter((id) => !newStudentIds.includes(id));
  for (const studentId of toAdd) {
    await client.query(`insert into ${table(schemaName, "generic_course_student")} (id, course_id, student_id, attendance_status, contract_product_id) values ($1,$2,$3,'PENDING',$4)`, [await nextTextId(client, schemaName, "generic_course_student"), courseId, studentId, input.contract_product_id]);
  }
  for (const studentId of toRemove) {
    await client.query(`update ${table(schemaName, "generic_course_student")} set deleted = true, updated_at = now() where course_id = $1 and student_id = $2`, [courseId, studentId]);
  }
  return { added: toAdd.length, removed: toRemove.length };
}

async function saveMoneyArrange(client: pg.PoolClient, schemaName: string, params: Record<string, unknown>) {
  const input = dataOf(params);
  const items = Array.isArray(input.items) ? input.items as Record<string, unknown>[] : [];
  for (const rawItem of items) {
    const item = { ...input, ...rawItem };
    await client.query(`insert into ${table(schemaName, "money_arrange_log")} (id, contract_product_id, arrange_real_hour, arrange_real_amount, funds_change_history_id, organization_id) values ($1,$2,$3,$4,$5,$6)`, [await nextTextId(client, schemaName, "money_arrange_log"), item.contract_product_id, num(item.arrange_real_hour), num(item.arrange_real_amount), item.funds_change_history_id, item.organization_id]);
    // 手工排款与自动排款同口径：同步累加合同产品已排实收，删除收款回滚时才对得上
    await client.query(
      `update ${table(schemaName, "contract_product")}
       set paid_real_amount = coalesce(paid_real_amount,0) + $1, paid_real_hour = coalesce(paid_real_hour,0) + $2, updated_at = now()
       where id = $3 and deleted = false`,
      [num(item.arrange_real_amount), num(item.arrange_real_hour), item.contract_product_id]
    );
  }
  return { saved: items.length };
}

async function savePromotionArrange(client: pg.PoolClient, schemaName: string, params: Record<string, unknown>) {
  const input = dataOf(params);
  const items = Array.isArray(input.items) ? input.items as Record<string, unknown>[] : [];
  for (const rawItem of items) {
    const item = { ...input, ...rawItem };
    await client.query(`insert into ${table(schemaName, "promotion_arrange_log")} (id, contract_product_id, arrange_promotion_hour, arrange_promotion_amount, funds_change_history_id, organization_id) values ($1,$2,$3,$4,$5,$6)`, [await nextTextId(client, schemaName, "promotion_arrange_log"), item.contract_product_id, num(item.arrange_promotion_hour), num(item.arrange_promotion_amount), item.funds_change_history_id, item.organization_id]);
    await client.query(
      `update ${table(schemaName, "contract_product")}
       set paid_promotion_amount = coalesce(paid_promotion_amount,0) + $1, paid_promotion_hour = coalesce(paid_promotion_hour,0) + $2, updated_at = now()
       where id = $3 and deleted = false`,
      [num(item.arrange_promotion_amount), num(item.arrange_promotion_hour), item.contract_product_id]
    );
  }
  return { saved: items.length };
}

async function savePerformanceArrange(client: pg.PoolClient, schemaName: string, params: Record<string, unknown>) {
  const input = dataOf(params);
  const items = Array.isArray(input.items) && input.items.length ? input.items as Record<string, unknown>[] : [input];
  for (const rawItem of items) {
    const item = { ...input, ...rawItem };
    await client.query(
      `insert into ${table(schemaName, "performance_arrange_log")}
        (id, contract_product_id, funds_change_history_id, performance_type, organization_performance_organization_id, organization_performance_amount, personal_performance_user_id, personal_performance_amount, organization_id, source_type, source_id, adjustment_reason, ext_json)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [await nextTextId(client, schemaName, "performance_arrange_log"), item.contract_product_id, item.funds_change_history_id, str(item.performance_type, "MANUAL_ADJUST"), item.organization_performance_organization_id, num(item.organization_performance_amount), item.personal_performance_user_id, num(item.personal_performance_amount), item.organization_id, str(item.source_type, "MANUAL_ADJUSTMENT"), item.source_id, item.adjustment_reason, JSON.stringify({ operatorId: params.__userId ?? null, manual: true })]
    );
  }
  return { saved: items.length };
}

async function assignManager(client: pg.PoolClient, schemaName: string, params: Record<string, unknown>) {
  const input = dataOf(params);
  const studentIds = (Array.isArray(input.student_ids) ? input.student_ids : [input.student_id]).map(String).filter(Boolean);
  const managerId = str(input.manager_id ?? input.study_manager_id);
  if (!studentIds.length || !managerId) throw new Error("缺少学员或学管师 ID");
  await client.query(`update ${table(schemaName, "student")} set study_manager_id = $1, updated_at = now() where id = any($2::text[]) and deleted = false`, [managerId, studentIds]);
  return { updated: studentIds.length, managerId };
}

async function saveProductGrant(client: pg.PoolClient, schemaName: string, params: Record<string, unknown>) {
  const input = dataOf(params);
  const productId = str(input.product_id);
  const items = Array.isArray(input.items) ? input.items as Record<string, unknown>[] : [];
  await client.query(`update ${table(schemaName, "product_grant")} set deleted = true, updated_at = now() where product_id = $1 and deleted = false`, [productId]);
  for (const rawItem of items) {
    const item = { ...input, ...rawItem };
    await client.query(`insert into ${table(schemaName, "product_grant")} (id, product_id, organization_id) values ($1,$2,$3) on conflict (id) do update set deleted = false, updated_at = now()`, [await nextTextId(client, schemaName, "product_grant"), productId, item.organization_id]);
  }
  return { saved: items.length };
}

async function saveProductPromotion(client: pg.PoolClient, schemaName: string, params: Record<string, unknown>) {
  const input = dataOf(params);
  const productId = str(input.product_id);
  const promoIds = (Array.isArray(input.promotion_ids) ? input.promotion_ids : []).map(String);
  await client.query(`update ${table(schemaName, "product_ref_promotion")} set deleted = true where product_id = $1 and deleted = false`, [productId]);
  for (const promotionId of promoIds) {
    await client.query(`insert into ${table(schemaName, "product_ref_promotion")} (id, product_id, promotion_id) values ($1,$2,$3)`, [await nextTextId(client, schemaName, "product_ref_promotion"), productId, promotionId]);
  }
  return { saved: promoIds.length };
}

async function saveRolePermission(client: pg.PoolClient, schemaName: string, params: Record<string, unknown>) {
  const input = dataOf(params);
  const roleId = str(input.role_id ?? input.id, params.id ? String(params.id) : await nextTextId(client, schemaName, "role"));
  if (!roleId) throw new Error("缺少角色 ID");
  const name = str(input.name);
  const roleCode = str(input.role_code, `CUSTOM_ROLE_${Date.now()}`);
  if (!name) throw new Error("缺少角色名称");
  const existing = await one(client, `select id from ${table(schemaName, "role")} where id = $1 and deleted = false`, [roleId]);
  if (existing) {
    await client.query(
      `update ${table(schemaName, "role")} set name = $1, role_code = $2, organization_id = $3, updated_at = now() where id = $4 and deleted = false`,
      [name, roleCode, input.organization_id ?? null, roleId]
    );
  } else {
    await client.query(
      `insert into ${table(schemaName, "role")} (id, name, role_code, organization_id) values ($1,$2,$3,$4)`,
      [roleId, name, roleCode, input.organization_id ?? null]
    );
  }
  const items = Array.isArray(input.items) ? input.items as Record<string, unknown>[] : [];
  await client.query(`update ${table(schemaName, "role_resource")} set deleted = true, updated_at = now() where role_id = $1 and deleted = false`, [roleId]);
  for (const rawItem of items) {
    const item = { ...input, ...rawItem };
    await client.query(`insert into ${table(schemaName, "role_resource")} (id, role_id, resource_code, resource_type, page_code, action_code, page_permission, button_permission, data_permission, field_permission) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [await nextTextId(client, schemaName, "role_resource"), roleId, item.resource_code ?? null, item.resource_type ?? "page", item.page_code, item.action_code ?? null, item.page_permission ?? "read", JSON.stringify(item.button_permission ?? []), item.data_permission ?? "all", JSON.stringify(item.field_permission ?? {})]);
  }
  return { saved: items.length, roleId };
}

async function createUser(client: pg.PoolClient, schemaName: string, params: Record<string, unknown>) {
  const input = dataOf(params);
  const bcrypt = (await import("bcryptjs")).default;
  const userId = str(params.id, await nextTextId(client, schemaName, "user"));
  const psw = await bcrypt.hash(str(input.psw, "123456"), 10);
  const row = await one(client, `insert into ${table(schemaName, "user")} (id, name, contact, email, psw, organization_id, staff_type, status) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`, [userId, input.name, input.contact, input.email, psw, input.organization_id, input.staff_type, str(input.status, "ACTIVE")]);
  return row;
}

async function updateUser(client: pg.PoolClient, schemaName: string, params: Record<string, unknown>) {
  const input = dataOf(params);
  const userId = str(params.id ?? input.id);
  if (!userId) throw new Error("缺少用户 ID");
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, val] of Object.entries(input)) {
    if (["id", "psw"].includes(key)) continue;
    sets.push(`${qIdent(key)} = $${sets.length + 1}`);
    values.push(val);
  }
  if (!sets.length) return { updated: false };
  sets.push("updated_at = now()");
  values.push(userId);
  await client.query(`update ${table(schemaName, "user")} set ${sets.join(", ")} where id = $${values.length} and deleted = false`, values);
  return { updated: true, userId };
}

async function softDeleteUser(client: pg.PoolClient, schemaName: string, params: Record<string, unknown>) {
  const userId = str(params.id ?? (dataOf(params)).id);
  if (!userId) throw new Error("缺少用户 ID");
  await client.query(`update ${table(schemaName, "user")} set deleted = true, updated_at = now() where id = $1`, [userId]);
  return { deleted: true, userId };
}

async function resetPassword(client: pg.PoolClient, schemaName: string, params: Record<string, unknown>) {
  const input = dataOf(params);
  const userId = str(params.id ?? input.id);
  if (!userId) throw new Error("缺少用户 ID");
  const bcrypt = (await import("bcryptjs")).default;
  const newPsw = await bcrypt.hash(str(input.new_psw, "123456"), 10);
  await client.query(`update ${table(schemaName, "user")} set psw = $1, updated_at = now() where id = $2`, [newPsw, userId]);
  return { reset: true, userId };
}

async function listAudit(client: pg.PoolClient, _schemaName: string, params: Record<string, unknown>) {
  const input = dataOf(params);
  const conditions = ["1=1"];
  const values: unknown[] = [];
  let idx = 1;
  if (input.schema_name) { conditions.push(`schema_name = $${idx++}`); values.push(input.schema_name); }
  if (input.user_id) { conditions.push(`user_id = $${idx++}`); values.push(input.user_id); }
  if (input.operation_type) { conditions.push(`operation_type = $${idx++}`); values.push(input.operation_type); }
  const page = Math.max(Number(input.page ?? 1), 1);
  const pageSize = Math.min(Number(input.pageSize ?? 20), 100);
  values.push(pageSize, (page - 1) * pageSize);
  const { rows } = await client.query(`select * from admin.audit_log where ${conditions.join(" and ")} order by created_at desc limit $${idx++} offset $${idx}`, values);
  return rows;
}

async function reportStudent(client: pg.PoolClient, schemaName: string, params: Record<string, unknown>) {
  const { rows } = await client.query(`select organization_id, student_status, count(*) as cnt from ${table(schemaName, "student")} where deleted = false group by organization_id, student_status order by organization_id`, []);
  return { data: rows };
}

async function reportFinance(client: pg.PoolClient, schemaName: string, params: Record<string, unknown>) {
  const { rows } = await client.query(`select organization_id, funds_type, sum(transaction_amount) as total_amount from ${table(schemaName, "funds_change_history")} where deleted = false group by organization_id, funds_type order by organization_id`, []);
  return { data: rows };
}

async function reportCourse(client: pg.PoolClient, schemaName: string, params: Record<string, unknown>) {
  const { rows } = await client.query(`select organization_id, course_status, count(*) as cnt from ${table(schemaName, "generic_course")} where deleted = false group by organization_id, course_status order by organization_id`, []);
  return { data: rows };
}

async function approveApprovalTask(client: pg.PoolClient, schemaName: string, params: Record<string, unknown>) {
  const input = dataOf(params);
  const taskId = str(input.id ?? input.task_id ?? input.taskId ?? params.id);
  const userId = str(params.__userId ?? input.operator_user_id);
  if (!taskId) throw new Error("缺少审批任务 ID");
  const task = await one(client, `select * from ${table(schemaName, "approval_task")} where id = $1 and deleted = false for update`, [taskId]);
  if (!task) throw new Error("审批任务不存在");
  if (task.status !== "PENDING") throw new Error("审批任务不是待审批状态");
  if (task.current_approver_user_id && userId && String(task.current_approver_user_id) !== userId) throw new Error("当前用户不是此节点审批人");
  const form = asObject(task.form_json);
  const steps = asArray(form.steps);
  const stepIndex = num(task.current_step_index);
  const currentStep = steps[stepIndex] ?? {};
  const nextStep = steps[stepIndex + 1];
  await insertApprovalLog(client, schemaName, taskId, "APPROVE", userId, str(input.comment, "同意"), currentStep, { stepIndex });
  if (nextStep) {
    const nextApprover = await resolveApproverUserId(client, schemaName, str(nextStep.assigneeRole), str(task.organization_id));
    await client.query(`update ${table(schemaName, "approval_task")} set current_step_index = $1, current_approver_user_id = $2, updated_at = now() where id = $3`, [stepIndex + 1, nextApprover, taskId]);
    return { taskId, status: "PENDING", currentStepIndex: stepIndex + 1, currentApproverUserId: nextApprover };
  }
  await client.query(`update ${table(schemaName, "approval_task")} set status = 'APPROVED', current_approver_user_id = null, approved_at = now(), completed_at = now(), updated_at = now() where id = $1`, [taskId]);
  let businessResult: unknown;
  const originalCommand = str(form.originalCommand) as CommandDsl["command"];
  if (originalCommand) {
    businessResult = await runCommandInTransaction(client, schemaName, {
      operation: "command",
      command: originalCommand,
      ruleCode: str(form.originalRuleCode),
    }, { ...asObject(form.originalParams), __approvalApproved: true, approval_task_id: taskId, __userId: userId });
  }
  return { taskId, status: "APPROVED", businessResult, afterApproved: form.afterApproved ?? [] };
}

async function rejectApprovalTask(client: pg.PoolClient, schemaName: string, params: Record<string, unknown>) {
  const input = dataOf(params);
  const taskId = str(input.id ?? input.task_id ?? input.taskId ?? params.id);
  const userId = str(params.__userId ?? input.operator_user_id);
  if (!taskId) throw new Error("缺少审批任务 ID");
  const task = await one(client, `select * from ${table(schemaName, "approval_task")} where id = $1 and deleted = false for update`, [taskId]);
  if (!task) throw new Error("审批任务不存在");
  if (task.status !== "PENDING") throw new Error("审批任务不是待审批状态");
  const form = asObject(task.form_json);
  await insertApprovalLog(client, schemaName, taskId, "REJECT", userId, str(input.comment ?? input.reason, "驳回"), asArray(form.steps)[num(task.current_step_index)], {});
  await client.query(`update ${table(schemaName, "approval_task")} set status = 'REJECTED', current_approver_user_id = null, rejected_at = now(), completed_at = now(), updated_at = now() where id = $1`, [taskId]);
  return { taskId, status: "REJECTED" };
}

async function cancelApprovalTask(client: pg.PoolClient, schemaName: string, params: Record<string, unknown>) {
  const input = dataOf(params);
  const taskId = str(input.id ?? input.task_id ?? input.taskId ?? params.id);
  const userId = str(params.__userId ?? input.operator_user_id);
  if (!taskId) throw new Error("缺少审批任务 ID");
  const task = await one(client, `select * from ${table(schemaName, "approval_task")} where id = $1 and deleted = false for update`, [taskId]);
  if (!task) throw new Error("审批任务不存在");
  if (task.status !== "PENDING") throw new Error("只有待审批任务可撤回");
  if (task.applicant_user_id && userId && String(task.applicant_user_id) !== userId) throw new Error("只有申请人可以撤回审批");
  await insertApprovalLog(client, schemaName, taskId, "CANCEL", userId, str(input.comment ?? input.reason, "撤回"), undefined, {});
  await client.query(`update ${table(schemaName, "approval_task")} set status = 'CANCELED', current_approver_user_id = null, canceled_at = now(), completed_at = now(), updated_at = now() where id = $1`, [taskId]);
  return { taskId, status: "CANCELED" };
}

export async function executeCommandDsl(schemaName: string, dsl: CommandDsl, params: Record<string, unknown>) {
  const simpleCommands: Partial<Record<CommandDsl["command"], (c: pg.PoolClient, s: string, p: Record<string, unknown>) => Promise<unknown>>> = {
    "chargeRecord.reverse": reverseCharge,
    "ledger.denyMutation": denyLedgerMutation,
    "funds.delete": deleteFunds,
    "contract.delete": deleteContract,
    "refund.delete": refund_delete,
    "course.delete": course_delete,

    "attendance.cancel": attendance_cancel,
    "classStudent.transfer": transferClassStudents,
    "class.changeStatus": changeClassStatus,
    "leave.create": createLeaveRecord,
    "makeup.create": createMakeupRecord,
    "miniClass.addStudent": mini_class_add_student,
    "miniClass.removeStudent": mini_class_remove_student,
    "oneOnNGroup.addStudent": one_on_n_group_add_student,
    "oneOnNGroup.removeStudent": one_on_n_group_remove_student,
    "chargeRecord.preview": previewCharge,
    "course.update": updateCourse,
    "course.cancel": cancelCourse,
    "course.student.save": saveCourseStudents,
    "holiday.apply": applyHolidayToCourses,
    "moneyArrange.save": saveMoneyArrange,
    "promotionArrange.save": savePromotionArrange,
    "performanceArrange.save": savePerformanceArrange,
    "student.assignManager": assignManager,
    "product.grant.save": saveProductGrant,
    "product.promotion.save": saveProductPromotion,
    "approval.submit": submitApprovalTask,
    "approval.approve": approveApprovalTask,
    "approval.reject": rejectApprovalTask,
    "approval.cancel": cancelApprovalTask,
    "role.permission.save": saveRolePermission,
    "user.create": createUser,
    "user.update": updateUser,
    "user.softDelete": softDeleteUser,
    "user.resetPassword": resetPassword,
    "contract.transition_status": transitionContractStatus,
    "audit.list": listAudit,
    "report.student": reportStudent,
    "report.finance": reportFinance,
    "report.course": reportCourse,
  };

  const simpleFn = simpleCommands[dsl.command];
  if (simpleFn) {
    if (["approval.submit", "approval.approve", "approval.reject", "approval.cancel", "chargeRecord.reverse", "ledger.denyMutation", "leave.create", "makeup.create", "classStudent.transfer", "class.changeStatus", "holiday.apply", "funds.delete", "contract.delete", "refund.delete", "course.delete", "course.update", "attendance.cancel", "miniClass.addStudent", "miniClass.removeStudent", "oneOnNGroup.addStudent", "oneOnNGroup.removeStudent", "course.cancel", "course.student.save", "moneyArrange.save", "promotionArrange.save", "performanceArrange.save", "student.assignManager", "product.grant.save", "product.promotion.save", "contract.transition_status", "role.permission.save", "user.create", "user.update", "user.softDelete", "user.resetPassword"].includes(dsl.command)) {
      return withCommandRedisLock(schemaName, dsl.command, params, () => withClient(async (client) => {
        await client.query("begin");
        try {
          const approval = await maybeSubmitApprovalTask(client, schemaName, dsl, params);
          const result = approval ?? await runCommandInTransaction(client, schemaName, dsl, params, simpleFn);
          await client.query("commit");
          return result;
        } catch (error) {
          await client.query("rollback");
          throw error;
        }
      }));
    }
    return withClient(async (client) => simpleFn(client, schemaName, params));
  }

  return withCommandRedisLock(schemaName, dsl.command, params, () => withClient(async (client) => {
    await client.query("begin");
    try {
      const approval = await maybeSubmitApprovalTask(client, schemaName, dsl, params);
      const result = approval ?? await runCommandInTransaction(client, schemaName, dsl, params);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  }));
}
