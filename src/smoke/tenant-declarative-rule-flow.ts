import { pool } from "../db/pool.js";
import { createTenantWithModules } from "../tenant/tenant-create.service.js";
import { executeGatewayApi } from "../gateway/api-executor.js";
import type { SessionUser } from "../types.js";
import { assert, cleanupTenant } from "./smoke-utils.js";

// 声明式校验规则（category=validation + validations）端到端冒烟：
// 租户通过 business_rule_list.create 配置规则（等价于 AI 定制 create_business_rule 落库），
// 解释器在业务命令前真实拦截；覆盖 when 前置、context 实体、count_limit、each、删除规则后放行、坏结构被拒。

type Row = Record<string, unknown>;

function idOf(value: unknown) {
  return String((value as Row | undefined)?.id ?? "");
}

async function expectBlocked(run: () => Promise<unknown>, keyword: string, label: string) {
  try {
    await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert(message.includes(keyword), `${label}: 拦截消息不含 "${keyword}"，实际: ${message}`);
    return;
  }
  assert(false, `${label}: 期望被规则拦截，实际放行`);
}

async function saveRule(schemaName: string, user: SessionUser, ruleCode: string, ruleName: string, ruleJson: Row) {
  return executeGatewayApi("tenant", schemaName, "business_rule_list.create", {
    data: { rule_code: ruleCode, rule_name: ruleName, rule_json: JSON.stringify({ ...ruleJson, ruleCode, ruleName }) },
  }, user) as Promise<Row>;
}

async function main() {
  let schemaName = "";
  try {
    const created = await createTenantWithModules({
      name: "声明式规则冒烟机构",
      contactPhone: "19900008888",
      ownerName: "规则校长",
      selectedModules: ["frontdesk", "student", "finance", "education", "system"],
      selectedFeatures: [
        "frontdesk_home", "student_list", "product_list", "contract_list", "contract_product_list",
        "funds_history", "charge_record", "course_list", "business_rule_list", "organization_list", "user_list", "role_list",
      ],
      operatorId: "smoke_admin",
    });
    schemaName = created.schemaName;
    const user: SessionUser = { kind: "tenant", userId: "user_owner", name: "规则校长", schemaName };

    // 基础数据：正式学员 + 意向学员 + 产品 + 已付合同
    const formal = await executeGatewayApi("tenant", schemaName, "student_list.create", {
      data: { name: "规则正式学员", contact: "13800009991", organization_id: "org_head", student_status: "FORMAL" },
    }, user) as Row;
    const lead = await executeGatewayApi("tenant", schemaName, "student_list.create", {
      data: { name: "规则意向学员", contact: "13800009992", organization_id: "org_head", student_status: "LEAD" },
    }, user) as Row;
    const product = await executeGatewayApi("tenant", schemaName, "product_list.create", {
      data: { name: "规则课程包", product_type: "ONE_ON_ONE_COURSE", unit_price: 200, default_course_hour: 10, total_amount: 2000, status: "ACTIVE" },
    }, user) as Row;
    const contractResult = await executeGatewayApi("tenant", schemaName, "contract_list.create", {
      data: { student_id: idOf(formal), product_ids: [idOf(product)], contract_type: "ONE_ON_ONE_COURSE", organization_id: "org_head", sign_staff_id: "user_owner" },
    }, user) as { contract?: Row; contractProducts?: Row[] };
    const contractId = String(contractResult.contract?.id ?? "");
    const cpId = String(contractResult.contractProducts?.[0]?.id ?? "");
    assert(contractId && cpId, "合同创建失败");
    await executeGatewayApi("tenant", schemaName, "funds_history.create", {
      data: { contract_id: contractId, student_id: idOf(formal), organization_id: "org_head", transaction_amount: 2000, pay_way_config_id: "pay_cash", funds_type: "CONTRACT_PAY" },
    }, user);

    // 用例 1：坏结构规则被保存接口拒绝
    let badRejected = false;
    try {
      await saveRule(schemaName, user, "bad_structure_rule", "坏结构规则", {
        category: "validation", businessType: "charge_create",
        validations: [{ field: "context.payroll.salary", operator: "magic", value: 1 }],
      });
    } catch (error) {
      badRejected = true;
      const message = error instanceof Error ? error.message : String(error);
      assert(message.includes("规则结构不合法"), `坏结构拒绝消息异常: ${message}`);
    }
    assert(badRejected, "坏结构规则应被保存接口拒绝");

    // 用例 2：单次扣课时上限（when 前置：仅 NORMAL 扣费受限）
    await saveRule(schemaName, user, "charge_hour_cap_rule", "单次扣课时上限", {
      category: "validation", businessType: "charge_create",
      validations: [{ field: "charge_hour", operator: "<=", value: 2, message: "单次扣课时不能超过2", when: [{ field: "charge_type", operator: "=", value: "NORMAL" }] }],
    });
    await expectBlocked(
      () => executeGatewayApi("tenant", schemaName, "charge_record.create", {
        data: { student_id: idOf(formal), contract_product_id: cpId, charge_type: "NORMAL", charge_hour: 3, charge_amount: 600, organization_id: "org_head" },
      }, user),
      "单次扣课时不能超过2", "超限扣费"
    );
    const okCharge = await executeGatewayApi("tenant", schemaName, "charge_record.create", {
      data: { student_id: idOf(formal), contract_product_id: cpId, charge_type: "NORMAL", charge_hour: 2, charge_amount: 400, organization_id: "org_head" },
    }, user) as Row;
    assert(idOf(okCharge), "2 课时扣费应放行");

    // 用例 3：context 实体引用——仅正式学员可排课
    await saveRule(schemaName, user, "formal_student_course_rule", "仅正式学员可排课", {
      category: "validation", businessType: "course_create",
      validations: [{ field: "context.student.student_status", operator: "=", value: "FORMAL", message: "仅正式学员可排课" }],
    });
    await expectBlocked(
      () => executeGatewayApi("tenant", schemaName, "course_list.create", {
        data: { course_title: "意向学员课", course_type: "ONE_ON_ONE_COURSE", course_date: "2026-08-10", start_time: "09:00", end_time: "10:00", organization_id: "org_head", course_hour: 1, student_id: idOf(lead), contract_product_id: cpId },
      }, user),
      "仅正式学员可排课", "意向学员排课"
    );
    const okCourse = await executeGatewayApi("tenant", schemaName, "course_list.create", {
      data: { course_title: "正式学员课", course_type: "ONE_ON_ONE_COURSE", course_date: "2026-08-10", start_time: "09:00", end_time: "10:00", organization_id: "org_head", course_hour: 1, student_id: idOf(formal), contract_product_id: cpId },
    }, user) as { course?: Row };
    assert(String(okCourse.course?.id ?? ""), "正式学员排课应放行");

    // 用例 4：count_limit——每个学员排课总数上限（当前已 1 节，上限 2：再排 1 节成功，第 3 节被拦）
    await saveRule(schemaName, user, "course_count_cap_rule", "学员排课总数上限", {
      category: "validation", businessType: "course_create",
      validations: [{ type: "count_limit", table: "generic_course_student", where: [{ field: "student_id", valueFrom: "student_id" }], operator: "<", value: 2, message: "学员排课数已达上限" }],
    });
    await executeGatewayApi("tenant", schemaName, "course_list.create", {
      data: { course_title: "第2节课", course_type: "ONE_ON_ONE_COURSE", course_date: "2026-08-11", start_time: "09:00", end_time: "10:00", organization_id: "org_head", course_hour: 1, student_id: idOf(formal), contract_product_id: cpId },
    }, user);
    await expectBlocked(
      () => executeGatewayApi("tenant", schemaName, "course_list.create", {
        data: { course_title: "第3节课", course_type: "ONE_ON_ONE_COURSE", course_date: "2026-08-12", start_time: "09:00", end_time: "10:00", organization_id: "org_head", course_hour: 1, student_id: idOf(formal), contract_product_id: cpId },
      }, user),
      "学员排课数已达上限", "超量排课"
    );

    // 用例 5：each——考勤逐学员校验单次课时
    await saveRule(schemaName, user, "attendance_hour_cap_rule", "考勤单次课时上限", {
      category: "validation", businessType: "attendance_check_in",
      validations: [{ each: "students", field: "charge_hour", operator: "<=", value: 1.5, message: "考勤单次扣课时不能超过1.5" }],
    });
    await expectBlocked(
      () => executeGatewayApi("tenant", schemaName, "attendance.checkIn", {
        data: { course_id: String(okCourse.course?.id ?? ""), students: [{ student_id: idOf(formal), contract_product_id: cpId, charge_hour: 2 }] },
      }, user),
      "考勤单次扣课时不能超过1.5", "超时考勤"
    );

    // 用例 6：删除规则后放行（规则可回收，无代码残留）
    const ruleRow = await pool.query(
      `select id from admin.business_rule where schema_scope = 'tenant' and schema_name = $1 and rule_code = 'course_count_cap_rule' and deleted = false limit 1`,
      [schemaName]
    );
    assert(ruleRow.rows[0]?.id, "规则应已落库");
    await executeGatewayApi("tenant", schemaName, "business_rule_list.delete", { id: ruleRow.rows[0].id }, user);
    const afterDelete = await executeGatewayApi("tenant", schemaName, "course_list.create", {
      data: { course_title: "删规则后第3节课", course_type: "ONE_ON_ONE_COURSE", course_date: "2026-08-13", start_time: "09:00", end_time: "10:00", organization_id: "org_head", course_hour: 1, student_id: idOf(formal), contract_product_id: cpId },
    }, user) as { course?: Row };
    assert(String(afterDelete.course?.id ?? ""), "删除规则后排课应放行");

    // 用例 7：声明式规则不能放宽引擎内置防护——课时满足规则（2<=2）但金额超余额，仍被内置校验拦截
    await expectBlocked(
      () => executeGatewayApi("tenant", schemaName, "charge_record.create", {
        data: { student_id: idOf(formal), contract_product_id: cpId, charge_type: "NORMAL", charge_hour: 2, charge_amount: 99999, organization_id: "org_head" },
      }, user),
      "余额不足", "内置余额防护"
    );

    console.log(JSON.stringify({ ok: true, schemaName, cases: 7 }, null, 2));
  } finally {
    if (schemaName) await cleanupTenant(schemaName);
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
