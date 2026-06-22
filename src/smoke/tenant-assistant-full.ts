import * as XLSX from "xlsx";
import { pool } from "../db/pool.js";
import { executeGatewayApi } from "../gateway/api-executor.js";
import { saveAgentAttachment } from "../tenant/attachment.service.js";
import { tenantAssistantChat } from "../tenant/tenant-assistant.service.js";
import { createTenantWithModules } from "../tenant/tenant-create.service.js";
import type { SessionUser } from "../types.js";
import { assert, cleanupTenant } from "./smoke-utils.js";

type Row = Record<string, unknown>;

function workbookBase64(sheetName: string, rows: Row[]) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), sheetName);
  return (XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer).toString("base64");
}

function multiSheetWorkbookBase64(sheets: Array<{ name: string; rows: Row[] }>) {
  const workbook = XLSX.utils.book_new();
  for (const s of sheets) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(s.rows), s.name);
  }
  return (XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer).toString("base64");
}

async function one(schemaName: string, sql: string, values: unknown[] = []) {
  const { rows } = await pool.query(sql.replaceAll("{schema}", `"${schemaName}"`), values);
  return rows[0] as Row | undefined;
}

async function chat(input: {
  schemaName: string;
  user: SessionUser;
  message: string;
  attachmentIds?: string[];
  sessionId?: string;
}) {
  const events: Array<{ title: string; message: string; toolName?: string; status?: string }> = [];
  const result = await tenantAssistantChat({
    ...input,
    onProgress: (event) => {
      if (event.visibleToTenant) events.push({ title: event.title, message: event.message, toolName: event.toolName, status: event.status });
    },
  });
  return { ...result, events, toolNames: events.map((e) => e.toolName).filter(Boolean) };
}

async function upload(schemaName: string, user: SessionUser, fileName: string, sheetName: string, rows: Row[]) {
  return saveAgentAttachment({
    schemaName,
    userId: user.userId,
    fileName,
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    contentBase64: workbookBase64(sheetName, rows),
  });
}

async function uploadMultiSheet(schemaName: string, user: SessionUser, fileName: string, sheets: Array<{ name: string; rows: Row[] }>) {
  return saveAgentAttachment({
    schemaName,
    userId: user.userId,
    fileName,
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    contentBase64: multiSheetWorkbookBase64(sheets),
  });
}

async function latestLlmLogs(sessionId: string) {
  const { rows } = await pool.query(
    `select model, has_tools, tool_names, function_call, response_content, error, status, duration_ms
     from admin.llm_call_log where session_id = $1 order by created_at desc limit 10`,
    [sessionId]
  );
  return rows;
}

const PRODUCT_NAME = "全量测试课程包";
const STUDENT_NAME_BUSINESS = "AI业务操作学员";
const STUDENT_NAME_IMPORT = "AI导入学员";

async function main() {
  let schemaName = "";
  const testResults: Array<{ test: string; passed: boolean; detail?: string }> = [];

  function record(test: string, passed: boolean, detail?: string) {
    testResults.push({ test, passed, detail });
    const icon = passed ? "✓" : "✗";
    console.log(`${icon} ${test}${detail ? ` — ${detail}` : ""}`);
  }

  try {
    console.log("\n=== 创建测试租户 ===");
    const created = await createTenantWithModules({
      name: "AI助手全量测试机构",
      contactPhone: "19900009999",
      ownerName: "全量校长",
      selectedModules: ["frontdesk", "student", "finance", "education", "system"],
      selectedFeatures: [
        "frontdesk_home", "student_list", "product_list", "contract_list", "contract_product_list",
        "funds_history", "course_list", "charge_record", "refund_record",
        "organization_list", "user_list", "role_list", "pay_way_list",
      ],
      operatorId: "smoke_admin",
    });
    schemaName = created.schemaName;
    const user: SessionUser = {
      kind: "tenant", userId: "user_owner", name: "全量校长", schemaName, currentManagementOrganizationId: "org_head",
    };

    console.log("\n=== 前置：创建产品 ===");
    await executeGatewayApi("tenant", schemaName, "product_list.create", {
      data: { name: PRODUCT_NAME, product_type: "ONE_ON_ONE_COURSE", unit_price: 200, default_course_hour: 10, total_amount: 2000, status: "ACTIVE" },
    }, user);

    // ================================================================
    // 阶段 1：对话功能测试
    // ================================================================
    console.log("\n=== 阶段 1：对话功能测试 ===");

    const chat1 = await chat({ schemaName, user, message: "我有哪些业务模块？" });
    record("1.1 列出模块", chat1.toolNames.includes("list_modules"), `tools: ${chat1.toolNames.join(",")}`);
    record("1.1 回复含模块信息", /前台|学员|财务|教务|系统/.test(chat1.reply), chat1.reply.slice(0, 120));

    const chat2 = await chat({ schemaName, user, message: "学员模块有哪些功能页面？" });
    record("1.2 列出功能", chat2.toolNames.includes("list_features"), `tools: ${chat2.toolNames.join(",")}`);

    const chat3 = await chat({ schemaName, user, message: "你好，你能帮我做什么？" });
    record("1.3 普通问答有回复", chat3.reply.length > 5, chat3.reply.slice(0, 80));

    // ================================================================
    // 阶段 2：数据查询测试（含跨模块）
    // ================================================================
    console.log("\n=== 阶段 2：数据查询测试 ===");

    // 前置：创建业务数据
    await executeGatewayApi("tenant", schemaName, "student_list.create", {
      data: { name: STUDENT_NAME_BUSINESS, contact: "13900001001", organization_id: "org_head", student_status: "FORMAL", school_name: "全量小学", grade: "五年级" },
    }, user);
    const businessStudent = await one(schemaName, `select id from {schema}.student where name = $1 and deleted = false`, [STUDENT_NAME_BUSINESS]);
    const productId = (await one(schemaName, `select id from {schema}.product where name = $1 and deleted = false`, [PRODUCT_NAME]))?.id;

    const contractResult = await executeGatewayApi("tenant", schemaName, "contract_list.create", {
      data: { student_id: businessStudent?.id, product_ids: [productId], contract_type: "ONE_ON_ONE_COURSE", organization_id: "org_head", sign_staff_id: "user_owner", sign_time: "2026-09-01T09:00:00+08:00" },
    }, user) as { contract?: Row; contractProducts?: Row[] };
    const contractId = String(contractResult.contract?.id ?? "");

    await executeGatewayApi("tenant", schemaName, "funds_history.create", {
      data: { contract_id: contractId, student_id: businessStudent?.id, organization_id: "org_head", transaction_amount: 1000, transaction_time: "2026-09-01T10:00:00+08:00", pay_way_config_id: "pay_cash", funds_type: "CONTRACT_PAY" },
    }, user);

    // 2.1 单模块查询
    const query1 = await chat({ schemaName, user, message: "查询学员列表(student_list)的数据。" });
    record("2.1 单模块查询", query1.toolNames.includes("query_data"), `tools: ${query1.toolNames.join(",")}`);

    // 2.2 跨模块查询汇总
    const query3 = await chat({
      schemaName, user,
      message: `跨模块查询并整理 ${STUDENT_NAME_BUSINESS} 的学员档案、合同、收款数据，给我一个汇总。`,
    });
    const query3Count = query3.toolResults.filter((item) => item.name === "query_data").length;
    record("2.2 跨模块查询 ≥3次", query3Count >= 3, `query_data 次数: ${query3Count}`);

    // ================================================================
    // 阶段 3：执行业务操作测试
    // ================================================================
    console.log("\n=== 阶段 3：执行业务操作测试 ===");

    // 3.1 AI 新增学员
    const biz1 = await chat({
      schemaName, user,
      message: "新增一个学员，姓名 AI业务新增学员，手机号 13900002001，校区 全量校长校区，状态正式，学校 全量小学，年级 三年级。",
    });
    record("3.1 AI 新增学员", biz1.toolNames.includes("execute_business_api"), `tools: ${biz1.toolNames.join(",")}`);
    const biz1Student = await one(schemaName, `select id from {schema}.student where name = $1 and deleted = false`, ["AI业务新增学员"]);
    record("3.1 学员入库", Boolean(biz1Student?.id), `studentId: ${biz1Student?.id}`);

    // 3.2 AI 新增产品
    const biz2 = await chat({
      schemaName, user,
      message: "请调用 product_list.create 新增一个产品，名称 AI业务测试产品，类型一对一，单价 150，默认课时 20，总价 3000。",
    });
    record("3.2 AI 新增产品", biz2.toolNames.includes("execute_business_api"), `tools: ${biz2.toolNames.join(",")}`);
    const biz2Product = await one(schemaName, `select id from {schema}.product where name = $1 and deleted = false`, ["AI业务测试产品"]);
    record("3.2 产品入库", Boolean(biz2Product?.id), `productId: ${biz2Product?.id}`);

    // ================================================================
    // 阶段 4：Excel 多文件导入测试（学员/合同/收款/排课/扣费/退费）
    // ================================================================
    console.log("\n=== 阶段 4：Excel 多文件导入测试 ===");

    const attachments = await Promise.all([
      upload(schemaName, user, "01-学生名单.xlsx", "学生名单", [{
        姓名: STUDENT_NAME_IMPORT, 电话: "13900003001", 校区名称: "全量校长校区", 阶段: "正式", 学校: "导入小学", 年级: "四年级", 备注: "AI 全量导入测试",
      }]),
      upload(schemaName, user, "02-报名合同.xlsx", "报名合同", [{
        学生姓名: STUDENT_NAME_IMPORT, 课程包: PRODUCT_NAME, 类型: "一对一", 签约校区: "全量校长校区", 签约老师: "全量校长", 签约日期: "2026/9/10 09:00",
      }]),
      upload(schemaName, user, "03-缴费流水.xlsx", "缴费流水", [{
        学员姓名: STUDENT_NAME_IMPORT, 校区: "全量校长校区", 金额: "￥1,000", 支付渠道: "现金", 缴费时间: "2026/9/10 10:00", 类型: "合同收款",
      }]),
      upload(schemaName, user, "04-课程安排.xlsx", "课程安排", [{
        标题: "AI导入课次", 课程类别: "一对一", 日期: "2026/9/11", 开始: "09:00", 结束: "10:00", 授课老师: "全量校长", 管理老师: "全量校长", 学生: STUDENT_NAME_IMPORT, 合同课程: PRODUCT_NAME, 校区: "全量校长校区", 课时数: "1",
      }]),
      upload(schemaName, user, "05-课消扣费.xlsx", "课消扣费", [{
        课次: "AI导入课次", 学生: STUDENT_NAME_IMPORT, 合同课程: PRODUCT_NAME, 校区: "全量校长校区", 类型: "实收扣费", 课时: "1", 金额: "200",
      }]),
      upload(schemaName, user, "06-退费记录.xlsx", "退费记录", [{
        学生: STUDENT_NAME_IMPORT, 合同课程: PRODUCT_NAME, 退课时数: "1", 退款金额: "200", 退款方式: "现金", 退款时间: "2026/9/12 09:00", 说明: "AI 全量导入退费",
      }]),
    ]);

    const importResult = await chat({
      schemaName, user,
      attachmentIds: attachments.map((a) => a.id),
      message: "请识别这些非模板 Excel，按依赖顺序自动导入学员、合同、收款、排课、扣费、退费。校验没异常就直接自动导入。",
    });

    record("4.1 调用 plan_excel_import", importResult.toolNames.includes("plan_excel_import"), `tools: ${importResult.toolNames.join(",")}`);
    record("4.1 调用 execute_excel_import", importResult.toolNames.includes("execute_excel_import"), `tools: ${importResult.toolNames.join(",")}`);

    const executeResults = importResult.toolResults.filter((item) => item.name === "execute_excel_import");
    if (executeResults.length > 0) {
      const execArgs = executeResults[0].args as { mode?: string };
      record("4.1 使用 validate_import 模式", execArgs.mode === "validate_import", `mode: ${execArgs.mode}`);
      const importRows = ((executeResults[0].result as { results?: Array<{ mode?: string; failed?: number }> }).results ?? []);
      record("4.1 逐项校验 ≥6", importRows.filter((r) => r.mode === "validate").length >= 6, `validate: ${importRows.filter((r) => r.mode === "validate").length}`);
      record("4.1 逐项导入 ≥6", importRows.filter((r) => r.mode === "import").length >= 6, `import: ${importRows.filter((r) => r.mode === "import").length}`);
      record("4.1 无失败", importRows.every((r) => Number(r.failed ?? 0) === 0), JSON.stringify(importRows.filter((r) => Number(r.failed ?? 0) > 0)));
    }

    // 验证导入数据
    const importStudent = await one(schemaName, `select id from {schema}.student where name = $1 and deleted = false`, [STUDENT_NAME_IMPORT]);
    record("4.2 导入学员存在", Boolean(importStudent?.id), `studentId: ${importStudent?.id}`);

    const importContract = await one(schemaName, `select id, paid_amount from {schema}.contract where student_id = $1 and deleted = false`, [importStudent?.id]);
    record("4.2 导入合同存在", Boolean(importContract?.id), `contractId: ${importContract?.id}`);
    record("4.2 合同已收>0", Number(importContract?.paid_amount) > 0, `paid: ${importContract?.paid_amount}`);

    const importCourse = await one(schemaName, `select id from {schema}.generic_course where course_title = $1 and deleted = false`, ["AI导入课次"]);
    record("4.2 导入排课存在", Boolean(importCourse?.id), `courseId: ${importCourse?.id}`);

    const importCharge = importCourse ? await one(schemaName, `select id from {schema}.account_charge_records where course_id = $1 and deleted = false`, [importCourse.id]) : undefined;
    record("4.2 导入扣费存在", Boolean(importCharge?.id), `chargeId: ${importCharge?.id}`);

    const importRefund = await one(schemaName, `select id from {schema}.refund_record where remark = $1 and deleted = false`, ["AI 全量导入退费"]);
    record("4.2 导入退费存在", Boolean(importRefund?.id), `refundId: ${importRefund?.id}`);

    // ================================================================
    // 阶段 5：单文件多 sheet 导入测试
    // ================================================================
    console.log("\n=== 阶段 5：单文件多 sheet 导入测试 ===");

    const multiSheetAttachment = await uploadMultiSheet(schemaName, user, "学员和合同.xlsx", [
      { name: "学员", rows: [{ 姓名: "AI多Sheet学员", 电话: "13900004001", 校区名称: "全量校长校区", 阶段: "正式", 学校: "多Sheet小学", 年级: "二年级" }] },
      { name: "合同", rows: [{ 学生姓名: "AI多Sheet学员", 课程包: PRODUCT_NAME, 类型: "一对一", 签约校区: "全量校长校区", 签约老师: "全量校长", 签约日期: "2026/9/15 09:00" }] },
    ]);

    const multiSheetResult = await chat({
      schemaName, user,
      attachmentIds: [multiSheetAttachment.id],
      message: "请识别这个 Excel 的多个 sheet，按依赖顺序自动导入，先校验再正式导入。",
    });

    record("5.1 多 sheet 导入", multiSheetResult.toolNames.includes("execute_excel_import"), `tools: ${multiSheetResult.toolNames.join(",")}`);

    const multiSheetExecResults = multiSheetResult.toolResults.filter((item) => item.name === "execute_excel_import");
    if (multiSheetExecResults.length > 0) {
      const execResult = multiSheetExecResults[0].result as { results?: Array<{ mode?: string; pageCode?: string; failed?: number; total?: number; success?: number }> };
      console.log("  多 sheet 导入结果:", JSON.stringify(execResult.results?.map((r) => ({ mode: r.mode, pageCode: r.pageCode, total: r.total, success: r.success, failed: r.failed }))));
    }
    const multiSheetStudent = await one(schemaName, `select id from {schema}.student where name = $1 and deleted = false`, ["AI多Sheet学员"]);
    record("5.1 多 sheet 学员入库", Boolean(multiSheetStudent?.id), `studentId: ${multiSheetStudent?.id}`);

    const multiSheetContract = multiSheetStudent ? await one(schemaName, `select id from {schema}.contract where student_id = $1 and deleted = false`, [multiSheetStudent.id]) : undefined;
    record("5.1 多 sheet 合同入库", Boolean(multiSheetContract?.id), `contractId: ${multiSheetContract?.id}`);

    // ================================================================
    // 阶段 6：仅校验模式测试
    // ================================================================
    console.log("\n=== 阶段 6：仅校验模式测试 ===");

    const validateOnlyAttachment = await upload(schemaName, user, "仅校验学员.xlsx", "学员", [{
      姓名: "仅校验不入库学员", 电话: "13900005001", 校区名称: "全量校长校区", 阶段: "正式",
    }]);

    const validateResult = await chat({
      schemaName, user,
      attachmentIds: [validateOnlyAttachment.id],
      message: "请识别这个 Excel，只做校验，不要正式写入。",
    });

    record("6.1 仅校验模式", validateResult.toolNames.includes("execute_excel_import"), `tools: ${validateResult.toolNames.join(",")}`);
    const validateExecResult = validateResult.toolResults.find((item) => item.name === "execute_excel_import");
    if (validateExecResult) {
      const args = validateExecResult.args as { mode?: string };
      record("6.1 使用 validate 模式", args.mode === "validate", `mode: ${args.mode}`);
    }
    const validateOnlyStudent = await one(schemaName, `select id from {schema}.student where name = $1 and deleted = false`, ["仅校验不入库学员"]);
    record("6.1 校验模式不写入", !validateOnlyStudent?.id, `studentId: ${validateOnlyStudent?.id}`);

    // ================================================================
    // 阶段 7：导入后跨模块查询汇总
    // ================================================================
    console.log("\n=== 阶段 7：导入后跨模块查询汇总 ===");

    const summaryQuery = await chat({
      schemaName, user,
      message: `跨模块查询并整理 ${STUDENT_NAME_IMPORT} 的学员档案、合同、收款、排课、扣费和退费数据，给我一个完整汇总。`,
    });

    const summaryQueryCount = summaryQuery.toolResults.filter((item) => item.name === "query_data").length;
    record("7.1 跨模块查询 ≥4次", summaryQueryCount >= 4, `query_data: ${summaryQueryCount}`);
    record("7.1 回复含学员名", new RegExp(STUDENT_NAME_IMPORT).test(summaryQuery.reply), summaryQuery.reply.slice(0, 200));

    // ================================================================
    // 汇总
    // ================================================================
    console.log("\n=== 测试汇总 ===");
    const passed = testResults.filter((r) => r.passed).length;
    const failed = testResults.filter((r) => !r.passed).length;
    console.log(`通过: ${passed}/${testResults.length}`);

    if (failed > 0) {
      console.log("\n失败项:");
      for (const r of testResults.filter((r) => !r.passed)) {
        console.log(`  ✗ ${r.test}${r.detail ? ` — ${r.detail}` : ""}`);
      }
      const lastSessionId = importResult.sessionId || summaryQuery.sessionId;
      if (lastSessionId) {
        console.log("\n=== LLM 日志 ===");
        const logs = await latestLlmLogs(lastSessionId);
        for (const log of logs.slice(0, 5)) {
          const fc = log.function_call ? (typeof log.function_call === "string" ? JSON.parse(log.function_call) : log.function_call) : null;
          console.log(JSON.stringify({ model: log.model, has_tools: log.has_tools, tool_names: log.tool_names, function_call: fc?.name ?? null, status: log.status, error: log.error?.toString().slice(0, 200), duration_ms: log.duration_ms }, null, 2));
        }
      }
    }

    console.log("\n" + JSON.stringify({ ok: failed === 0, schemaName, total: testResults.length, passed, failed, results: testResults }, null, 2));
    if (failed > 0) process.exitCode = 1;
  } finally {
    if (schemaName) await cleanupTenant(schemaName);
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
