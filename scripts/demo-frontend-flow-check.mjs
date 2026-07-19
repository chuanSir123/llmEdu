// 模拟前端 GenericPageRenderer 的真实调用形态,在 demo_school 走通 12 步教务财务闭环。
// 每步的 params 形态严格对齐前端代码:
//  - 弹窗提交(submitModal): params = { id, data: {...} }
//  - 行内 execute_api(onRowAction): params = { ...row, ...mapped, id: row.id, versionId: row.id }
//  - 均带 pageCode(页面权限 + 按钮权限同口径)
const BASE = "http://127.0.0.1:3000";
const SCHEMA = "demo_school";

let TOKEN = "";
const results = [];

async function api(pageCode, apiCode, params, label) {
  const res = await fetch(`${BASE}/api/gateway/api/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ scope: "tenant", schemaName: SCHEMA, pageCode, apiCode, params }),
  });
  const body = await res.json();
  if (!res.ok) {
    results.push({ step: label, ok: false, error: body.message ?? JSON.stringify(body) });
    throw new Error(`[${label}] ${body.message ?? JSON.stringify(body)}`);
  }
  results.push({ step: label, ok: true });
  return body.data;
}

async function main() {
  // 登录(张校长)
  const login = await fetch(`${BASE}/api/auth/tenant/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ schemaName: SCHEMA, contact: "18800000001", password: "123456" }),
  });
  const loginBody = await login.json();
  if (!login.ok) throw new Error(`登录失败: ${JSON.stringify(loginBody)}`);
  TOKEN = loginBody.token;
  console.log("登录成功:", loginBody.user.name);

  // 0. 准备:新建学员(前端 student_list 新增弹窗形态)
  const student = await api("student_list", "student_list.create", {
    data: { name: "闭环测试学员", contact: "13900001111", organization_id: "1", student_status: "FORMAL", school_name: "测试小学", grade: "五年级" },
  }, "0.新增学员");
  const studentId = String(student.id);
  console.log("学员:", studentId);

  // 1. 签合同(lead_list 新生报名弹窗:student_ids/product_ids/contract_products 形态,enrollment 布局产物)
  const contractResult = await api("lead_list", "contract_list.create", {
    data: {
      student_ids: [studentId],
      product_ids: ["1"],
      contract_products: [{ product_id: "1", plan_real_hour: 20, plan_real_amount: 4000, plan_promotion_amount: 0, unit_price: 200 }],
      total_amount: 4000,
      contract_type: "NEW_SIGN",
      organization_id: "1",
      sign_staff_id: "1",
      sign_time: "2026-07-16T09:00",
    },
  }, "1.签合同");
  const contract = Array.isArray(contractResult?.contracts) ? contractResult.contracts[0] : contractResult;
  const contractId = String(contract?.contract?.id ?? contract?.id ?? "");
  const contractProductId = String(contract?.contractProducts?.[0]?.id ?? "");
  if (!contractId || !contractProductId) throw new Error(`合同创建返回异常: ${JSON.stringify(contractResult).slice(0, 400)}`);
  console.log("合同:", contractId, "合同产品:", contractProductId);

  // 2. 修改合同(contract_list.edit → hydrate 后提交 { id, data })
  await api("contract_list", "contract_list.update", {
    id: contractId,
    data: { id: contractId, student_ids: [studentId], product_ids: ["1"], contract_type: "NEW_SIGN", organization_id: "1", sign_staff_id: "1", remark: "闭环测试修改备注" },
  }, "2.修改合同");

  // 3. 收款(contract_list.funds 行内弹窗:mapRowToValue 注入 contract_id/student_id/organization_id)
  const funds = await api("contract_list", "funds_history.create", {
    data: { contract_id: contractId, student_id: studentId, organization_id: "1", transaction_amount: 2000, pay_way_config_id: "1", transaction_time: "2026-07-16T10:00", funds_type: "CONTRACT_PAY" },
  }, "3.收款");
  const fundsId = String(funds.id);
  console.log("收款:", fundsId);

  // 4. 排课(course_list 新增排课弹窗:course_dates 多日期形态)
  const courseResult = await api("course_list", "course_list.create", {
    data: {
      course_title: "闭环测试课程",
      course_type: "ONE_ON_ONE_COURSE",
      course_dates: ["2026-07-17"],
      start_time: "14:00",
      end_time: "15:00",
      teacher_id: "2",
      study_manager_id: "3",
      student_ids: [studentId],
      contract_product_id: contractProductId,
      organization_id: "1",
      course_hour: 1,
      course_status: "SCHEDULED",
    },
  }, "4.排课");
  const course = Array.isArray(courseResult?.courses) ? courseResult.courses[0] : courseResult;
  const courseId = String(course?.course?.id ?? course?.id ?? "");
  if (!courseId) throw new Error(`排课返回异常: ${JSON.stringify(courseResult).slice(0, 400)}`);
  console.log("课程:", courseId);

  // 5. 考勤(考勤弹窗 __attendanceMode=attendance:students 数组)
  await api("course_list", "attendance.checkIn", {
    id: courseId,
    data: { course_id: courseId, students: [{ student_id: studentId, contract_product_id: contractProductId, attendance_status: "PRESENT" }] },
  }, "5.考勤签到(含扣费)");

  // 6. 查扣费记录(charge_record 页)
  const charges = await api("charge_record", "charge_record.query", { filters: { student_id: studentId }, page: 1, pageSize: 10 }, "6.查询扣费记录");
  const chargeRows = (charges.rows ?? []).filter((r) => String(r.charge_status).includes("CONFIRMED"));
  if (!chargeRows.length) throw new Error(`未找到确认扣费记录: ${JSON.stringify(charges).slice(0, 300)}`);
  const chargeId = String(chargeRows[0].id);
  console.log("扣费记录:", chargeId);

  // 7. 取消扣费(charge_record.reverse 弹窗:{ id, cancel_reason })
  await api("charge_record", "chargeRecord.reverse", {
    id: chargeId,
    data: { id: chargeId, cancel_reason: "闭环测试取消扣费" },
  }, "7.取消扣费");

  // 8. 重新考勤+扣费,再走取消考勤(考勤弹窗 cancel_attendance 模式)
  await api("course_list", "attendance.checkIn", {
    id: courseId,
    data: { course_id: courseId, students: [{ student_id: studentId, contract_product_id: contractProductId, attendance_status: "PRESENT" }] },
  }, "8a.重新考勤");
  await api("course_list", "attendance.checkIn", {
    id: courseId,
    data: { course_id: courseId, students: [{ student_id: studentId, contract_product_id: contractProductId, attendance_status: "PENDING", cancel_attendance: true, reverse_charge: true }] },
  }, "8b.取消扣费+取消考勤(弹窗模式)");

  // 9. 退费(refund_record 新增退费弹窗)
  const refund = await api("refund_record", "refund_record.create", {
    data: { refund_type: "CONTRACT_PRODUCT", student_id: studentId, contract_product_id: contractProductId, refund_real_hour: 1, refund_real_amount: 200, refund_way_config_id: "1", refund_time: "2026-07-16T11:00", remark: "闭环测试退费" },
  }, "9.退费");
  const refundId = String(refund.id ?? refund.refund?.id ?? "");
  console.log("退费:", refundId);

  // 10. 删除退费(refund_record.delete 行内 execute_api:{ ...row, id })
  await api("refund_record", "refund.delete", { id: refundId, versionId: refundId }, "10.删除退费");

  // 11. 删除收款/作废(funds_history.delete 弹窗:{ id, data: { id, void_reason } })
  await api("funds_history", "funds.delete", {
    id: fundsId,
    data: { id: fundsId, void_reason: "闭环测试作废收款" },
  }, "11.删除收款(作废)");

  // 12. 取消排课 + 删除排课(course_list 行内)
  await api("course_list", "course.cancel", { id: courseId, versionId: courseId }, "12a.取消排课");
  await api("course_list", "course_list.delete", { id: courseId, versionId: courseId }, "12b.删除排课");

  // 13. 删除合同(contract_list.delete 行内 execute_api,paid_status=UNPAID 才可见)
  const contractRow = await api("contract_list", "contract_list.query", { filters: { id: contractId }, page: 1, pageSize: 5 }, "13a.查合同状态");
  const row = (contractRow.rows ?? []).find((r) => String(r.id) === contractId);
  console.log("删除前合同状态:", row?.paid_status, row?.contract_status);
  await api("contract_list", "contract_list.delete", { ...row, id: contractId, versionId: contractId }, "13b.删除合同");

  // 14. 清理测试学员
  await api("student_list", "student_list.delete", { id: studentId }, "14.清理学员");

  console.log("\n===== 全部通过 =====");
  for (const r of results) console.log(r.ok ? "OK " : "FAIL", r.step, r.error ?? "");
}

main().catch((err) => {
  console.error("\n===== 失败 =====");
  for (const r of results) console.log(r.ok ? "OK " : "FAIL", r.step, r.error ?? "");
  console.error(err.message);
  process.exit(1);
});
