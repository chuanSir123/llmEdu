import { pool } from "../db/pool.js";
import { createTenantWithModules } from "../tenant/tenant-create.service.js";
import { executeGatewayApi } from "../gateway/api-executor.js";
import type { SessionUser } from "../types.js";
import { assert, cleanupTenant } from "./smoke-utils.js";

type Row = Record<string, unknown>;

function idOf(value: unknown) {
  const row = value as Row | undefined;
  return String(row?.id ?? "");
}

async function one(sql: string, values: unknown[]) {
  const { rows } = await pool.query(sql, values);
  return rows[0] as Row | undefined;
}

async function main() {
  let schemaName = "";
  try {
    const created = await createTenantWithModules({
      name: "回滚冒烟机构",
      contactPhone: "19900007777",
      ownerName: "回滚校长",
      selectedModules: ["frontdesk", "student", "finance", "education", "system"],
      selectedFeatures: [
        "frontdesk_home",
        "student_list",
        "product_list",
        "contract_list",
        "contract_product_list",
        "funds_history",
        "money_arrange_list",
        "promotion_arrange_list",
        "performance_arrange_list",
        "course_list",
        "charge_record",
        "organization_list",
        "user_list",
        "role_list",
      ],
      operatorId: "smoke_admin",
    });
    schemaName = created.schemaName;
    const user: SessionUser = { kind: "tenant", userId: "user_owner", name: "回滚校长", schemaName };

    const student = await executeGatewayApi("tenant", schemaName, "student_list.create", {
      data: {
        name: "回滚冒烟学员",
        contact: "13800007777",
        organization_id: "org_head",
        student_status: "FORMAL",
      },
    }, user) as Row;
    const studentId = idOf(student);
    assert(studentId, "学员创建失败");

    const product = await executeGatewayApi("tenant", schemaName, "product_list.create", {
      data: {
        name: "回滚冒烟课程包",
        product_type: "ONE_ON_ONE_COURSE",
        unit_price: 200,
        default_course_hour: 10,
        total_amount: 2000,
        status: "ACTIVE",
      },
    }, user) as Row;
    const productId = idOf(product);
    assert(productId, "产品创建失败");

    const contractResult = await executeGatewayApi("tenant", schemaName, "contract_list.create", {
      data: {
        student_id: studentId,
        product_ids: [productId],
        contract_type: "ONE_ON_ONE_COURSE",
        organization_id: "org_head",
        sign_staff_id: "user_owner",
      },
    }, user) as { contract?: Row; contractProducts?: Row[] };
    const contractId = String(contractResult.contract?.id ?? "");
    const contractProductId = String(contractResult.contractProducts?.[0]?.id ?? "");
    assert(contractId && contractProductId, "合同创建失败");

    const funds = await executeGatewayApi("tenant", schemaName, "funds_history.create", {
      data: {
        contract_id: contractId,
        student_id: studentId,
        organization_id: "org_head",
        transaction_amount: 1000,
        pay_way_config_id: "pay_cash",
        funds_type: "CONTRACT_PAY",
      },
    }, user) as Row;
    const fundsId = idOf(funds);
    assert(fundsId, "收款创建失败");

    const courseResult = await executeGatewayApi("tenant", schemaName, "course_list.create", {
      data: {
        course_title: "回滚冒烟课程",
        course_type: "ONE_ON_ONE_COURSE",
        course_date: "2026-07-03",
        start_time: "09:00",
        end_time: "10:00",
        teacher_id: "user_owner",
        study_manager_id: "user_owner",
        organization_id: "org_head",
        course_hour: 1,
        student_id: studentId,
        contract_product_id: contractProductId,
      },
    }, user) as { course?: Row; studentCount?: number };
    const courseId = String(courseResult.course?.id ?? "");
    assert(courseId, "排课失败");

    await executeGatewayApi("tenant", schemaName, "attendance.checkIn", {
      data: {
        course_id: courseId,
        students: [{ student_id: studentId, contract_product_id: contractProductId }],
      },
    }, user);

    const afterCheckIn = await one(
      `select consumed_real_hour, consumed_real_amount, remaining_real_hour, remaining_real_amount from "${schemaName}".contract_product where id = $1`,
      [contractProductId]
    );
    assert(Number(afterCheckIn?.consumed_real_hour) === 1, "签到后未扣课时");
    assert(Number(afterCheckIn?.remaining_real_hour) === 9, "签到后剩余课时异常");

    const cancelResult = await executeGatewayApi("tenant", schemaName, "attendance.cancel", {
      data: { course_id: courseId, student_id: studentId },
    }, user) as { reversedCharges?: number };
    assert(cancelResult.reversedCharges === 1, "取消考勤未撤销扣费");

    const afterCancel = await one(
      `select consumed_real_hour, consumed_real_amount, remaining_real_hour, remaining_real_amount from "${schemaName}".contract_product where id = $1`,
      [contractProductId]
    );
    assert(Number(afterCancel?.consumed_real_hour) === 0, "取消考勤后消耗课时未恢复");
    assert(Number(afterCancel?.consumed_real_amount) === 0, "取消考勤后消耗金额未恢复");
    assert(Number(afterCancel?.remaining_real_hour) === 10, "取消考勤后剩余课时未恢复");
    assert(Number(afterCancel?.remaining_real_amount) === 2000, "取消考勤后剩余金额未恢复");

    const attendance = await one(
      `select attendance_status from "${schemaName}".generic_course_student where course_id = $1 and student_id = $2 and deleted = false`,
      [courseId, studentId]
    );
    assert(attendance?.attendance_status === "PENDING", "取消考勤后学员状态未恢复待签到");

    const chargeStats = await one(
      `select
         count(*) filter (where charge_status = 'CONFIRMED' and deleted = false)::int as confirmed_count,
         count(*) filter (where charge_status = 'REVERSED' and deleted = false)::int as reversed_count
       from "${schemaName}".account_charge_records`,
      []
    );
    assert(Number(chargeStats?.confirmed_count) === 0, "取消考勤后仍存在确认扣费记录");
    assert(Number(chargeStats?.reversed_count) === 2, "取消考勤未生成完整撤销记录");

    const deleteFundsResult = await executeGatewayApi("tenant", schemaName, "funds.delete", { id: fundsId }, user) as { rolledBackMoney?: number };
    assert(deleteFundsResult.rolledBackMoney === 1, "删除收款未回滚资金分配");

    const contractAfterDelete = await one(`select paid_amount, paid_status from "${schemaName}".contract where id = $1`, [contractId]);
    assert(Number(contractAfterDelete?.paid_amount) === 0, "删除收款后合同已收金额未恢复");
    assert(contractAfterDelete?.paid_status === "UNPAID", "删除收款后合同状态未恢复未付款");

    const cpAfterDeleteFunds = await one(
      `select paid_real_amount, paid_real_hour from "${schemaName}".contract_product where id = $1`,
      [contractProductId]
    );
    assert(Number(cpAfterDeleteFunds?.paid_real_amount) === 0, "删除收款后合同产品已分配金额未恢复");
    assert(Number(cpAfterDeleteFunds?.paid_real_hour) === 0, "删除收款后合同产品已分配课时未恢复");

    const arrangeStats = await one(
      `select
         count(*) filter (where deleted = false)::int as active_money,
         (select count(*) from "${schemaName}".performance_arrange_log where deleted = false)::int as active_performance
       from "${schemaName}".money_arrange_log`,
      []
    );
    assert(Number(arrangeStats?.active_money) === 0, "删除收款后仍存在有效资金分配");
    assert(Number(arrangeStats?.active_performance) === 0, "删除收款后仍存在有效业绩分配");

    console.log(JSON.stringify({
      ok: true,
      schemaName,
      contractId,
      contractProductId,
      courseId,
      fundsId,
      reversedCharges: cancelResult.reversedCharges,
      paidAmountAfterDelete: Number(contractAfterDelete?.paid_amount),
      activeMoneyArrange: Number(arrangeStats?.active_money),
      activePerformanceArrange: Number(arrangeStats?.active_performance),
    }, null, 2));
  } finally {
    if (schemaName) await cleanupTenant(schemaName);
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
