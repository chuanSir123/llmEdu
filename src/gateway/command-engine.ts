import type pg from "pg";
import { withClient } from "../db/pool.js";
import { qIdent } from "../db/schema-resolver.js";

type CommandDsl = {
  operation: "command";
  command: "contract.create" | "funds.create" | "course.create" | "chargeRecord.create" | "refund.create";
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

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

async function loadRule(client: pg.PoolClient, schemaName: string, ruleCode: string): Promise<BusinessRule> {
  const { rows } = await client.query(
    `select rule_json
     from admin.business_rule
     where rule_code = $1 and status = 'active' and deleted = false
       and ((schema_scope = 'tenant' and schema_name = $2) or schema_scope = 'tenant_default')
     order by case when schema_scope = 'tenant' then 0 else 1 end
     limit 1`,
    [ruleCode, schemaName]
  );
  return rows[0]?.rule_json ?? {};
}

async function one<T extends Record<string, unknown>>(client: pg.PoolClient, sql: string, values: unknown[]) {
  const { rows } = await client.query(sql, values);
  return rows[0] as T | undefined;
}

async function createContract(client: pg.PoolClient, schemaName: string, params: Record<string, unknown>, rule: BusinessRule) {
  const input = dataOf(params);
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
  if (!str(input.student_id)) throw new Error("缺少 student_id");
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
  const paidAmount = num(input.paid_amount);
  const paidStatus = paidAmount <= 0 ? "UNPAID" : paidAmount >= Math.max(totalAmount - promotionAmount, 0) ? "PAID" : "PART_PAID";

  const contract = await one(client,
    `insert into ${table(schemaName, "contract")}
      (id, student_id, paid_status, contract_type, organization_id, sign_staff_id, sign_time, total_amount, paid_amount, promotion_amount, contract_status, ext_json)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'ACTIVE',$11)
     returning *`,
    [
      contractId,
      input.student_id,
      paidStatus,
      contractType,
      input.organization_id,
      input.sign_staff_id,
      signTime,
      totalAmount,
      paidAmount,
      promotionAmount,
      JSON.stringify({ ruleCode: "contract_create_rule", rule, promotionId })
    ]
  );

  if (promotionAmount > 0 || promotion) {
    await client.query(
      `insert into ${table(schemaName, "contract_promotion_history")}
        (id, contract_id, promotion_id, promotion_snapshot_json, reduce_amount, discount_value)
       values ($1,$2,$3,$4,$5,$6)`,
      [await nextTextId(client, schemaName, "contract_promotion_history"), contractId, promotionId || null, JSON.stringify(promotion ?? { manualPromotionAmount: promotionAmount }), promotionAmount, num(promotion?.value)]
    );
  }

  const allocationMode = str(rule.promotionAllocation, "proportional");
  let remainingPromotion = promotionAmount;
  const productRows = [];
  for (let index = 0; index < productInputs.length; index += 1) {
    const { item, product, productId } = productInputs[index];
    const planRealHour = num(item.plan_real_hour ?? item.default_course_hour ?? product?.default_course_hour);
    const planRealAmount = num(item.plan_real_amount ?? item.total_amount ?? product?.total_amount);
    const planPromotionAmount =
      allocationMode === "first_product"
        ? index === 0 ? promotionAmount : 0
        : index === productInputs.length - 1
          ? roundMoney(remainingPromotion)
          : totalAmount > 0 ? roundMoney(promotionAmount * (planRealAmount / totalAmount)) : 0;
    remainingPromotion -= planPromotionAmount;
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
  return { contract, contractProducts: productRows };
}

async function arrangePayment(client: pg.PoolClient, schemaName: string, fundsId: string, contractId: string, amount: number, rule: BusinessRule) {
  if (!contractId || amount <= 0) return;
  const mode = str(rule.fundsAllocation, "oldest_first");
  const orderBy = mode === "proportional" ? "created_at asc" : "created_at asc";
  const { rows } = await client.query(
    `select * from ${table(schemaName, "contract_product")} where contract_id = $1 and deleted = false order by ${orderBy}`,
    [contractId]
  );
  let remaining = amount;
  const totalRemaining = rows.reduce((sum, row) => sum + num(row.remaining_real_amount), 0);
  for (let index = 0; index < rows.length && remaining > 0; index += 1) {
    const cp = rows[index];
    const cpRemaining = num(cp.remaining_real_amount);
    const arrangeAmount =
      mode === "proportional" && totalRemaining > 0 && index < rows.length - 1
        ? Math.min(cpRemaining, Math.round((amount * (cpRemaining / totalRemaining)) * 100) / 100)
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
    remaining -= arrangeAmount;
  }
}

async function createFunds(client: pg.PoolClient, schemaName: string, params: Record<string, unknown>, rule: BusinessRule) {
  const input = dataOf(params);
  const fundsId = str(params.id, await nextTextId(client, schemaName, "funds_change_history"));
  const amount = num(input.transaction_amount);
  if (amount <= 0) throw new Error("收款金额必须大于 0");
  const fundsType = str(input.funds_type, input.contract_id ? "CONTRACT_PAY" : "PRE_STORE");
  const contract = input.contract_id
    ? await one(client, `select student_id, total_amount, promotion_amount, paid_amount from ${table(schemaName, "contract")} where id = $1 and deleted = false`, [input.contract_id])
    : undefined;
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

async function changeStudentEleAccount(
  client: pg.PoolClient,
  schemaName: string,
  input: { studentId: string; amount: number; changeType: string; sourceFundsId?: string; contractId?: string; remark?: string }
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
  await client.query(
    `update ${table(schemaName, "student_ele_account")} set balance_amount = $1, updated_at = now() where id = $2`,
    [nextBalance, account?.id]
  );
  await client.query(
    `insert into ${table(schemaName, "student_ele_account_record")}
      (id, student_id, account_id, change_type, change_amount, balance_after, source_funds_id, contract_id, remark)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [await nextTextId(client, schemaName, "student_ele_account_record"), input.studentId, account?.id, input.changeType, input.amount, nextBalance, input.sourceFundsId, input.contractId, input.remark]
  );
  return nextBalance;
}

function timeToMinutes(value: unknown) {
  const [hour, minute] = str(value).split(":").map(Number);
  return hour * 60 + minute;
}

async function createCourse(client: pg.PoolClient, schemaName: string, params: Record<string, unknown>, rule: BusinessRule) {
  const input = dataOf(params);
  const courseId = str(params.id, await nextTextId(client, schemaName, "generic_course"));
  if (!input.course_date || !input.start_time || !input.end_time) throw new Error("排课必须填写日期和时间");
  if (timeToMinutes(input.end_time) <= timeToMinutes(input.start_time)) throw new Error("结束时间必须晚于开始时间");
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
  for (const studentId of studentIds) {
    await client.query(
      `insert into ${table(schemaName, "generic_course_student")}
        (id, course_id, student_id, attendance_status, contract_product_id)
       values ($1,$2,$3,'PENDING',$4)`,
      [await nextTextId(client, schemaName, "generic_course_student"), courseId, studentId, input.contract_product_id]
    );
  }
  return { course, studentCount: studentIds.length };
}

async function createCharge(client: pg.PoolClient, schemaName: string, params: Record<string, unknown>, rule: BusinessRule) {
  const input = dataOf(params);
  const cpId = str(input.contract_product_id);
  if (!cpId) throw new Error("扣费必须选择合同产品");
  const cp = await one(client, `select * from ${table(schemaName, "contract_product")} where id = $1 and deleted = false for update`, [cpId]);
  if (!cp) throw new Error("合同产品不存在");
  const chargeType = str(input.charge_type, str(rule.defaultChargeType, "NORMAL"));
  const chargeHour = num(input.charge_hour);
  const chargeAmount = num(input.charge_amount);
  if (chargeType === "NORMAL") {
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
    await client.query(
      `update ${table(schemaName, "contract_product")}
       set consumed_real_hour = coalesce(consumed_real_hour,0) + $1,
           consumed_real_amount = coalesce(consumed_real_amount,0) + $2,
           remaining_real_hour = coalesce(remaining_real_hour,0) - $1,
           remaining_real_amount = coalesce(remaining_real_amount,0) - $2,
           updated_at = now()
       where id = $3`,
      [chargeHour, chargeAmount, cpId]
    );
  } else if (chargeType === "PROMOTION_HOUR") {
    if (rule.allowNegativeBalance !== true && chargeHour > num(cp.remaining_promotion_hour)) throw new Error("赠送课时余额不足");
    await client.query(
      `update ${table(schemaName, "contract_product")}
       set consumed_promotion_hour = coalesce(consumed_promotion_hour,0) + $1,
           remaining_promotion_hour = coalesce(remaining_promotion_hour,0) - $1,
           updated_at = now()
       where id = $2`,
      [chargeHour, cpId]
    );
  } else if (chargeType === "PROMOTION") {
    if (rule.allowNegativeBalance !== true && chargeAmount > num(cp.remaining_promotion_amount)) throw new Error("优惠金额余额不足");
    await client.query(
      `update ${table(schemaName, "contract_product")}
       set consumed_promotion_amount = coalesce(consumed_promotion_amount,0) + $1,
           remaining_promotion_amount = coalesce(remaining_promotion_amount,0) - $1,
           updated_at = now()
       where id = $2`,
      [chargeAmount, cpId]
    );
  }
  return charge;
}

async function createRefund(client: pg.PoolClient, schemaName: string, params: Record<string, unknown>, rule: BusinessRule) {
  const input = dataOf(params);
  const cpId = str(input.contract_product_id);
  if (!cpId) throw new Error("退费必须选择合同产品");
  const cp = await one(client, `select * from ${table(schemaName, "contract_product")} where id = $1 and deleted = false for update`, [cpId]);
  if (!cp) throw new Error("合同产品不存在");
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
      (id, student_id, contract_product_id, refund_real_hour, refund_real_amount, refund_promotion_amount, refund_promotion_hour, refund_way_config_id, refund_time, remark, ext_json)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     returning *`,
    [
      str(params.id, await nextTextId(client, schemaName, "refund_record")),
      input.student_id,
      cpId,
      refundHour,
      refundAmount,
      refundPromotionAmount,
      refundPromotionHour,
      input.refund_way_config_id,
      str(input.refund_time, new Date().toISOString()),
      input.remark,
      JSON.stringify({ ruleCode: "refund_create_rule", rule })
    ]
  );
  await client.query(
    `update ${table(schemaName, "contract_product")}
     set remaining_real_hour = coalesce(remaining_real_hour,0) - $1,
         remaining_real_amount = coalesce(remaining_real_amount,0) - $2,
         remaining_promotion_amount = coalesce(remaining_promotion_amount,0) - $3,
         remaining_promotion_hour = coalesce(remaining_promotion_hour,0) - $4,
         updated_at = now()
     where id = $5`,
    [refundHour, refundAmount, refundPromotionAmount, refundPromotionHour, cpId]
  );
  const contractId = str(cp.contract_id);
  if (contractId && refundAmount > 0) {
    const contract = await one(client, `select paid_amount, total_amount, promotion_amount from ${table(schemaName, "contract")} where id = $1`, [contractId]);
    const nextPaid = Math.max(num(contract?.paid_amount) - refundAmount, 0);
    const payable = Math.max(num(contract?.total_amount) - num(contract?.promotion_amount), 0);
    const status = nextPaid <= 0 ? "UNPAID" : nextPaid >= payable ? "PAID" : "PART_PAID";
    await client.query(`update ${table(schemaName, "contract")} set paid_amount = $1, paid_status = $2, updated_at = now() where id = $3`, [nextPaid, status, contractId]);
  }
  return refund;
}

export async function executeCommandDsl(schemaName: string, dsl: CommandDsl, params: Record<string, unknown>) {
  return withClient(async (client) => {
    await client.query("begin");
    try {
      const rule = await loadRule(client, schemaName, dsl.ruleCode);
      const result =
        dsl.command === "contract.create"
          ? await createContract(client, schemaName, params, rule)
          : dsl.command === "funds.create"
            ? await createFunds(client, schemaName, params, rule)
            : dsl.command === "course.create"
              ? await createCourse(client, schemaName, params, rule)
              : dsl.command === "chargeRecord.create"
                ? await createCharge(client, schemaName, params, rule)
                : await createRefund(client, schemaName, params, rule);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}
