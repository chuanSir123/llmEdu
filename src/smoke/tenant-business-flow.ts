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
      name: "业务冒烟机构",
      contactPhone: "19900008888",
      ownerName: "业务校长",
      selectedModules: ["frontdesk", "student", "finance", "education", "system"],
      selectedFeatures: [
        "frontdesk_home",
        "student_list",
        "product_list",
        "contract_list",
        "contract_product_list",
        "funds_history",
        "money_arrange_list",
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
    const user: SessionUser = { kind: "tenant", userId: "user_owner", name: "业务校长", schemaName };

    const student = await executeGatewayApi("tenant", schemaName, "student_list.create", {
      data: {
        name: "业务冒烟学员",
        contact: "13800008888",
        organization_id: "org_head",
        student_status: "FORMAL",
        school_name: "业务小学",
        grade: "四年级",
      },
    }, user) as Row;
    const studentId = idOf(student);
    assert(studentId, "学员创建失败");

    const product = await executeGatewayApi("tenant", schemaName, "product_list.create", {
      data: {
        name: "业务冒烟一对一",
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
        sign_time: "2026-07-01T09:00:00+08:00",
      },
    }, user) as { contract?: Row; contractProducts?: Row[] };
    const contractId = String(contractResult.contract?.id ?? "");
    const contractProductId = String(contractResult.contractProducts?.[0]?.id ?? "");
    assert(contractId && contractProductId, "合同或合同产品创建失败");

    await executeGatewayApi("tenant", schemaName, "funds_history.create", {
      data: {
        contract_id: contractId,
        student_id: studentId,
        organization_id: "org_head",
        transaction_amount: 1000,
        transaction_time: "2026-07-01T10:00:00+08:00",
        pay_way_config_id: "pay_cash",
        funds_type: "CONTRACT_PAY",
      },
    }, user);

    const contractAfterFunds = await one(`select paid_amount, paid_status from "${schemaName}".contract where id = $1`, [contractId]);
    assert(Number(contractAfterFunds?.paid_amount) === 1000, "收款后合同已收金额未更新");
    assert(contractAfterFunds?.paid_status === "PART_PAID", "收款后合同付款状态异常");
    const moneyArrange = await one(`select count(*)::int as count from "${schemaName}".money_arrange_log where deleted = false`, []);
    const performanceArrange = await one(`select count(*)::int as count from "${schemaName}".performance_arrange_log where deleted = false`, []);
    assert(Number(moneyArrange?.count) > 0, "收款后未生成资金分配记录");
    assert(Number(performanceArrange?.count) > 0, "收款后未生成业绩分配记录");

    const courseResult = await executeGatewayApi("tenant", schemaName, "course_list.create", {
      data: {
        course_title: "业务冒烟课程",
        course_type: "ONE_ON_ONE_COURSE",
        course_date: "2026-07-02",
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
    assert(courseId && courseResult.studentCount === 1, "排课未自动关联上课学员");

    let conflictBlocked = false;
    try {
      await executeGatewayApi("tenant", schemaName, "course_list.create", {
        data: {
          course_title: "业务冒烟冲突课程",
          course_type: "ONE_ON_ONE_COURSE",
          course_date: "2026-07-02",
          start_time: "09:30",
          end_time: "10:30",
          teacher_id: "user_owner",
          organization_id: "org_head",
          course_hour: 1,
          student_id: studentId,
          contract_product_id: contractProductId,
        },
      }, user);
    } catch (error) {
      conflictBlocked = error instanceof Error && error.message.includes("老师该时间段已有课程");
    }
    assert(conflictBlocked, "排课时间冲突未被默认规则拦截");

    const checkInResult = await executeGatewayApi("tenant", schemaName, "attendance.checkIn", {
      data: {
        course_id: courseId,
        students: [{ student_id: studentId, contract_product_id: contractProductId }],
      },
    }, user) as { succeeded?: Row[]; failed?: Row[] };
    assert((checkInResult.succeeded ?? []).length === 1, `考勤签到失败: ${JSON.stringify(checkInResult)}`);
    assert((checkInResult.failed ?? []).length === 0, "考勤签到出现失败记录");

    const courseStudent = await one(
      `select attendance_status from "${schemaName}".generic_course_student where course_id = $1 and student_id = $2 and deleted = false`,
      [courseId, studentId]
    );
    assert(courseStudent?.attendance_status === "PRESENT", "考勤状态未更新为已签到");
    const contractProduct = await one(
      `select consumed_real_hour, remaining_real_hour, remaining_real_amount from "${schemaName}".contract_product where id = $1`,
      [contractProductId]
    );
    assert(Number(contractProduct?.consumed_real_hour) === 1, "签到后未累计消耗课时");
    assert(Number(contractProduct?.remaining_real_hour) === 9, "签到后剩余课时异常");
    assert(Number(contractProduct?.remaining_real_amount) === 1800, "签到后剩余金额异常");
    const charges = await one(`select count(*)::int as count from "${schemaName}".account_charge_records where deleted = false and charge_status = 'CONFIRMED'`, []);
    assert(Number(charges?.count) === 1, "签到后未生成确认扣费记录");

    console.log(JSON.stringify({
      ok: true,
      schemaName,
      studentId,
      productId,
      contractId,
      contractProductId,
      courseId,
      moneyArrangeCount: Number(moneyArrange?.count),
      performanceArrangeCount: Number(performanceArrange?.count),
      remainingHour: Number(contractProduct?.remaining_real_hour),
      remainingAmount: Number(contractProduct?.remaining_real_amount),
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
