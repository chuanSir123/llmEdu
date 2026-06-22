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

async function one(schemaName: string, sql: string, values: unknown[] = []) {
  const { rows } = await pool.query(sql.replaceAll("{schema}", `"${schemaName}"`), values);
  return rows[0] as Row | undefined;
}

async function chat(input: { schemaName: string; user: SessionUser; message: string; attachmentIds?: string[] }) {
  const events: Array<{ title: string; message: string; toolName?: string; status?: string }> = [];
  const result = await tenantAssistantChat({
    ...input,
    onProgress: (event) => {
      if (event.visibleToTenant) events.push({ title: event.title, message: event.message, toolName: event.toolName, status: event.status });
    },
  });
  return { ...result, events, toolNames: events.map((event) => event.toolName).filter(Boolean) };
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

async function main() {
  let schemaName = "";
  try {
    const created = await createTenantWithModules({
      name: "AI助手全工具冒烟机构",
      contactPhone: "19900006666",
      ownerName: "AI校长",
      selectedModules: ["frontdesk", "student", "finance", "education", "system"],
      selectedFeatures: [
        "frontdesk_home",
        "student_list",
        "product_list",
        "contract_list",
        "contract_product_list",
        "funds_history",
        "course_list",
        "charge_record",
        "refund_record",
        "organization_list",
        "user_list",
        "role_list",
        "pay_way_list",
      ],
      operatorId: "smoke_admin",
    });
    schemaName = created.schemaName;
    const user: SessionUser = { kind: "tenant", userId: "user_owner", name: "AI校长", schemaName, currentManagementOrganizationId: "org_head" };

    await executeGatewayApi("tenant", schemaName, "product_list.create", {
      data: {
        name: "AI导入课程包",
        product_type: "ONE_ON_ONE_COURSE",
        unit_price: 200,
        default_course_hour: 10,
        total_amount: 2000,
        status: "ACTIVE",
      },
    }, user);

    const business = await chat({
      schemaName,
      user,
      message: "新增一个学员，姓名 AI助手业务学员，手机号 13900006660，校区 AI校长校区，状态正式，学校 AI小学，年级五年级。",
    });
    assert(business.toolNames.includes("execute_business_api"), `AI 助手没有执行业务工具: ${JSON.stringify(business, null, 2)}`);
    const businessStudent = await one(schemaName, `select id from {schema}.student where name = $1 and deleted = false`, ["AI助手业务学员"]);
    assert(businessStudent?.id, "AI 助手业务新增学员未入库");

    const attachments = await Promise.all([
      upload(schemaName, user, "01-学生名单.xlsx", "学生名单", [{
        姓名: "AI多文件学员",
        电话: "13900006661",
        校区名称: "AI校长校区",
        阶段: "正式",
        学校: "AI实验小学",
        年级: "四年级",
        备注: "AI 多文件自动导入",
      }]),
      upload(schemaName, user, "02-报名合同.xlsx", "报名合同", [{
        学生姓名: "AI多文件学员",
        课程包: "AI导入课程包",
        类型: "一对一",
        签约校区: "AI校长校区",
        签约老师: "AI校长",
        签约日期: "2026/9/1 09:00",
      }]),
      upload(schemaName, user, "03-缴费流水.xlsx", "缴费流水", [{
        学员姓名: "AI多文件学员",
        校区: "AI校长校区",
        金额: "￥1000",
        支付渠道: "现金",
        缴费时间: "2026/9/1 10:00",
        类型: "合同收款",
      }]),
      upload(schemaName, user, "04-课程安排.xlsx", "课程安排", [{
        标题: "AI多文件课次",
        课程类别: "一对一",
        日期: "2026/9/2",
        开始: "09:00",
        结束: "10:00",
        授课老师: "AI校长",
        管理老师: "AI校长",
        学生: "AI多文件学员",
        合同课程: "AI导入课程包",
        校区: "AI校长校区",
        课时数: "1",
      }]),
      upload(schemaName, user, "05-课消扣费.xlsx", "课消扣费", [{
        课次: "AI多文件课次",
        学生: "AI多文件学员",
        合同课程: "AI导入课程包",
        校区: "AI校长校区",
        类型: "实收扣费",
        课时: "1",
        金额: "200",
      }]),
      upload(schemaName, user, "06-退费记录.xlsx", "退费记录", [{
        学生: "AI多文件学员",
        合同课程: "AI导入课程包",
        退课时数: "1",
        退款金额: "200",
        退款方式: "现金",
        退款时间: "2026/9/3 09:00",
        说明: "AI 多文件退费",
      }]),
    ]);

    const importResult = await chat({
      schemaName,
      user,
      attachmentIds: attachments.map((item) => item.id),
      message: "请识别这些非模板 Excel，按依赖顺序自动导入学员、合同、收款、排课、扣费、退费。校验没异常就直接自动导入。",
    });
    const executeResults = importResult.toolResults.filter((item) => item.name === "execute_excel_import");
    assert(importResult.toolNames.includes("plan_excel_import"), `AI 助手没有规划多文件导入: ${JSON.stringify(importResult, null, 2)}`);
    assert(executeResults.length >= 1, `AI 助手没有执行 Excel 导入: ${JSON.stringify(importResult, null, 2)}`);
    assert((executeResults[0].args as { mode?: string }).mode === "validate_import", "多文件导入没有使用逐项校验后导入模式");
    const importRows = ((executeResults[0].result as { results?: Array<{ mode?: string; failed?: number }> }).results ?? []);
    assert(importRows.filter((item) => item.mode === "validate").length >= 6, `多文件导入没有逐项校验: ${JSON.stringify(importRows, null, 2)}`);
    assert(importRows.filter((item) => item.mode === "import").length >= 6, `多文件导入没有逐项正式导入: ${JSON.stringify(importRows, null, 2)}`);
    assert(importRows.every((item) => Number(item.failed ?? 0) === 0), `多文件导入存在失败: ${JSON.stringify(importRows, null, 2)}`);

    const student = await one(schemaName, `select id from {schema}.student where name = $1 and deleted = false`, ["AI多文件学员"]);
    assert(student?.id, "多文件导入后学员不存在");
    const contract = await one(schemaName, `select id, paid_amount from {schema}.contract where student_id = $1 and deleted = false`, [student.id]);
    const fundsDebug = await one(schemaName, `select count(*)::int as count, max(contract_id) as contract_id, sum(transaction_amount)::numeric as amount from {schema}.funds_change_history where student_id = $1 and deleted = false`, [student.id]);
    assert(contract?.id && Number(contract.paid_amount) === 1000, `多文件导入后合同或收款异常: ${JSON.stringify({ contract, fundsDebug, importRows }, null, 2)}`);
    const course = await one(schemaName, `select id from {schema}.generic_course where course_title = $1 and deleted = false`, ["AI多文件课次"]);
    assert(course?.id, "多文件导入后排课不存在");
    const charge = await one(schemaName, `select id from {schema}.account_charge_records where course_id = $1 and deleted = false`, [course.id]);
    assert(charge?.id, "多文件导入后扣费不存在");
    const refund = await one(schemaName, `select id from {schema}.refund_record where remark = $1 and deleted = false`, ["AI 多文件退费"]);
    assert(refund?.id, "多文件导入后退费不存在");

    const query = await chat({
      schemaName,
      user,
      message: "跨模块查询并整理 AI多文件学员 的学员档案、合同、收款、排课、扣费和退费数据，给我一个汇总。",
    });
    const queryCount = query.toolResults.filter((item) => item.name === "query_data").length;
    assert(queryCount >= 4, `AI 助手跨模块查询次数不足: ${JSON.stringify(query, null, 2)}`);
    assert(/AI多文件学员|合同|收款|排课|扣费|退费/.test(query.reply), `AI 助手跨模块汇总回复异常: ${query.reply}`);

    console.log(JSON.stringify({
      ok: true,
      schemaName,
      businessToolNames: business.toolNames,
      importToolNames: importResult.toolNames,
      queryToolNames: query.toolNames,
      studentId: student.id,
      contractId: contract.id,
      courseId: course.id,
      chargeId: charge.id,
      refundId: refund.id,
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
