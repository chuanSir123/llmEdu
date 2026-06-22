import * as XLSX from "xlsx";
import fs from "node:fs/promises";
import { pool } from "../db/pool.js";
import { executeGatewayApi } from "../gateway/api-executor.js";
import { loadPageFullDsl } from "../gateway/page.service.js";
import { loadAttachment } from "../tenant/attachment.service.js";
import { buildImportTemplate, executeTenantImport, resolveTenantImportConfig } from "../tenant/import.service.js";
import { createTenantWithModules } from "../tenant/tenant-create.service.js";
import type { SessionUser } from "../types.js";
import { assert, cleanupTenant } from "./smoke-utils.js";

type Row = Record<string, unknown>;

function workbookBase64(row: Record<string, unknown>) {
  return workbookBase64Rows([row]);
}

function workbookBase64Rows(rows: Record<string, unknown>[]) {
  const sheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "导入数据");
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return buffer.toString("base64");
}

async function one(sql: string, values: unknown[] = []) {
  const { rows } = await pool.query(sql, values);
  return rows[0] as Row | undefined;
}

function assertTemplateGuide(buffer: Buffer, pageCode: string) {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  assert(workbook.SheetNames.includes("导入模板"), `${pageCode} 模板缺少导入模板工作表`);
  assert(workbook.SheetNames.includes("填写说明"), `${pageCode} 模板缺少填写说明工作表`);
  const guideSheet = workbook.Sheets["填写说明"];
  const guideRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(guideSheet, { defval: "", raw: false });
  assert(guideRows.length > 0, `${pageCode} 填写说明为空`);
  assert(guideRows.some((row) => row.是否必填 === "是"), `${pageCode} 填写说明未标记必填字段`);
  if (pageCode === "student_list") {
    const statusGuide = guideRows.find((row) => row.字段名 === "状态");
    assert(String(statusGuide?.填写说明 ?? "").includes("正式"), "学员导入模板缺少状态枚举说明");
  }
  if (pageCode === "contract_list") {
    const productGuide = guideRows.find((row) => row.字段名 === "报读课程");
    assert(String(productGuide?.填写说明 ?? "").includes("多个名称"), "合同导入模板缺少多选分隔说明");
  }
}

async function importOne(input: {
  schemaName: string;
  pageCode: string;
  apiCode: string;
  row: Record<string, unknown>;
  user: SessionUser;
}) {
  const config = await resolveTenantImportConfig({
    schemaName: input.schemaName,
    pageCode: input.pageCode,
    apiCode: input.apiCode,
  });
  assert(config.apiCode === input.apiCode, `${input.pageCode} 导入 API 解析异常`);
  const template = buildImportTemplate(config.fields);
  assert(template.length > 1000, `${input.pageCode} 导入模板生成异常`);
  assertTemplateGuide(template, input.pageCode);
  const result = await executeTenantImport({
    schemaName: input.schemaName,
    pageCode: input.pageCode,
    apiCode: config.apiCode,
    fileName: `${input.pageCode}.xlsx`,
    contentBase64: workbookBase64(input.row),
    fields: config.fields,
    idResolutionStrategy: "error",
    user: input.user,
  });
  assert(result.total === 1, `${input.pageCode} 导入总数异常`);
  assert(result.success === 1 && result.failed === 0, `${input.pageCode} 导入失败: ${JSON.stringify(result)}`);
  return config;
}

async function assertFailedImportResultFile(input: {
  schemaName: string;
  pageCode: string;
  apiCode: string;
  row: Record<string, unknown>;
  expectedMessage: string;
  user: SessionUser;
}) {
  const config = await resolveTenantImportConfig({
    schemaName: input.schemaName,
    pageCode: input.pageCode,
    apiCode: input.apiCode,
  });
  const result = await executeTenantImport({
    schemaName: input.schemaName,
    pageCode: input.pageCode,
    apiCode: config.apiCode,
    fileName: `${input.pageCode}_failed.xlsx`,
    contentBase64: workbookBase64(input.row),
    fields: config.fields,
    idResolutionStrategy: "error",
    user: input.user,
  });
  assert(result.total === 1, "失败导入总数异常");
  assert(result.success === 0 && result.failed === 1, `失败导入未按预期失败: ${JSON.stringify(result)}`);
  const attachment = await loadAttachment(result.resultFile.id, input.schemaName);
  assert(attachment?.local_path, "失败导入未生成可下载结果文件");
  const buffer = await fs.readFile(attachment.local_path);
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "", raw: false });
  assert(rows.length === 1, "失败导入结果文件行数异常");
  assert(String(rows[0].导入行号) === "2", "失败导入结果文件缺少正确导入行号");
  assert(String(rows[0].导入结果).includes(input.expectedMessage), `失败导入结果未写明原因: ${JSON.stringify(rows[0])}`);
}

async function assertValidateOnlyDoesNotWrite(schemaName: string, user: SessionUser) {
  const config = await resolveTenantImportConfig({
    schemaName,
    pageCode: "student_list",
    apiCode: "student_list.create",
  });
  const result = await executeTenantImport({
    schemaName,
    pageCode: "student_list",
    apiCode: config.apiCode,
    fileName: "student_validate_only.xlsx",
    contentBase64: workbookBase64({
      "学员姓名": "只校验不入库学员",
      "联系电话": "13800008888",
      "校区": "导入校长校区",
      "状态": "正式",
    }),
    fields: config.fields,
    idResolutionStrategy: "error",
    validateOnly: true,
    user,
  });
  assert(result.mode === "validate", `校验模式返回值异常: ${JSON.stringify(result)}`);
  assert(result.total === 1 && result.success === 1 && result.failed === 0, `校验模式结果异常: ${JSON.stringify(result)}`);
  const student = await one(`select id from "${schemaName}".student where name = $1 and deleted = false`, ["只校验不入库学员"]);
  assert(!student?.id, "只校验模式不应写入学员数据");
  const attachment = await loadAttachment(result.resultFile.id, schemaName);
  assert(attachment?.local_path, "校验模式未生成结果文件");
  const buffer = await fs.readFile(attachment.local_path);
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "", raw: false });
  assert(String(rows[0].导入结果).includes("校验通过"), `校验结果文件未标记通过: ${JSON.stringify(rows[0])}`);
}

async function assertBlankRowsAreSkipped(schemaName: string, user: SessionUser) {
  const config = await resolveTenantImportConfig({
    schemaName,
    pageCode: "student_list",
    apiCode: "student_list.create",
  });
  const result = await executeTenantImport({
    schemaName,
    pageCode: "student_list",
    apiCode: config.apiCode,
    fileName: "student_blank_rows.xlsx",
    contentBase64: workbookBase64Rows([
      {
        "学员姓名": "空行过滤学员",
        "联系电话": "   ",
        "校区": "导入校长校区",
        "状态": "正式",
        "学校": "   ",
        "年级": " ",
      },
      {
        "学员姓名": "",
        "联系电话": "",
        "校区": "",
        "状态": "",
      },
      {
        "学员姓名": "   ",
        "联系电话": "  ",
        "校区": " ",
        "状态": " ",
      },
    ]),
    fields: config.fields,
    idResolutionStrategy: "error",
    user,
  });
  assert(result.total === 1, `空行不应计入导入总数: ${JSON.stringify(result)}`);
  assert(result.success === 1 && result.failed === 0, `空行过滤导入结果异常: ${JSON.stringify(result)}`);
  const student = await one(`select count(*)::int as count, max(contact) as contact, max(school_name) as school_name, max(grade) as grade from "${schemaName}".student where name = $1 and deleted = false`, ["空行过滤学员"]);
  assert(Number(student?.count) === 1, "空行过滤导入后学员记录异常");
  assert(!String(student?.contact ?? "").trim(), "可选空白联系电话不应写入有效值");
  assert(!String(student?.school_name ?? "").trim(), "可选空白学校不应写入有效值");
  assert(!String(student?.grade ?? "").trim(), "可选空白年级不应写入有效值");
}

async function assertMixedBatchKeepsSuccessfulRows(schemaName: string, user: SessionUser) {
  const config = await resolveTenantImportConfig({
    schemaName,
    pageCode: "course_list",
    apiCode: "course_list.create",
  });
  const beforeCourses = await one(`select count(*)::int as count from "${schemaName}".generic_course where course_title in ($1,$2) and deleted = false`, ["批量成功课次", "批量失败课次"]);
  const result = await executeTenantImport({
    schemaName,
    pageCode: "course_list",
    apiCode: config.apiCode,
    fileName: "course_mixed_batch.xlsx",
    contentBase64: workbookBase64Rows([
      {
        "课程名称": "批量成功课次",
        "课程类型": "一对一",
        "上课日期": "2026/8/4",
        "开始时间": "11:00",
        "结束时间": "12:00",
        "老师": "导入校长",
        "学管师": "导入校长",
        "上课学员": "核心导入学员",
        "合同产品": "核心导入课程包",
        "校区": "导入校长校区",
        "课时": "1",
      },
      {
        "课程名称": "批量失败课次",
        "课程类型": "一对一",
        "上课日期": "2026/8/4",
        "开始时间": "13:00",
        "结束时间": "12:00",
        "老师": "导入校长",
        "学管师": "导入校长",
        "上课学员": "核心导入学员",
        "合同产品": "核心导入课程包",
        "校区": "导入校长校区",
        "课时": "1",
      },
    ]),
    fields: config.fields,
    idResolutionStrategy: "error",
    user,
  });
  assert(Number(beforeCourses?.count) === 0, "混合批量导入前测试课次已存在");
  assert(result.total === 2, `混合批量导入总数异常: ${JSON.stringify(result)}`);
  assert(result.success === 1 && result.failed === 1, `混合批量导入成功失败计数异常: ${JSON.stringify(result)}`);
  const successCourse = await one(`select id from "${schemaName}".generic_course where course_title = $1 and deleted = false`, ["批量成功课次"]);
  const failedCourse = await one(`select id from "${schemaName}".generic_course where course_title = $1 and deleted = false`, ["批量失败课次"]);
  assert(successCourse?.id, "混合批量导入成功行未保留");
  assert(!failedCourse?.id, "混合批量导入失败行不应留下课程记录");
  const attachment = await loadAttachment(result.resultFile.id, schemaName);
  assert(attachment?.local_path, "混合批量导入未生成结果文件");
  const workbook = XLSX.read(await fs.readFile(attachment.local_path), { type: "buffer" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "", raw: false });
  assert(rows.some((row) => row.课程名称 === "批量成功课次" && String(row.导入结果).includes("成功")), "混合批量结果缺少成功行");
  assert(rows.some((row) => row.课程名称 === "批量失败课次" && String(row.导入结果).includes("结束时间必须晚于开始时间")), "混合批量结果缺少失败原因");
}

async function assertPageImportEntries(schemaName: string, user: SessionUser) {
  const expected = [
    ["student_list", "student_list.create"],
    ["contract_list", "contract_list.create"],
    ["funds_history", "funds_history.create"],
    ["course_list", "course_list.create"],
    ["charge_record", "charge_record.create"],
    ["refund_record", "refund_record.create"],
  ] as const;
  for (const [pageCode, apiCode] of expected) {
    const fullDsl = await loadPageFullDsl("tenant", pageCode, schemaName, user);
    const dsl = fullDsl.page.dsl_json as { toolbar?: Array<Record<string, unknown>> };
    const importAction = (dsl.toolbar ?? []).find((action) => action.actionCode === `${pageCode}.import`);
    assert(importAction, `${pageCode} 页面缺少导入按钮`);
    assert(importAction.type === "import" || importAction.actionType === "import", `${pageCode} 导入按钮类型异常`);
    const importConfig = importAction.importConfig as Record<string, unknown> | undefined;
    assert(importConfig?.importCode === `${pageCode}.import`, `${pageCode} 导入按钮 importCode 异常`);
    assert(importConfig?.apiCode === apiCode, `${pageCode} 导入按钮 apiCode 异常`);
    assert(Array.isArray(importConfig?.fields) && importConfig.fields.length > 0, `${pageCode} 导入按钮未合并模板字段`);
  }
}

async function main() {
  let schemaName = "";
  try {
    const created = await createTenantWithModules({
      name: "核心导入冒烟机构",
      contactPhone: "19900007777",
      ownerName: "导入校长",
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
    const user: SessionUser = { kind: "tenant", userId: "user_owner", name: "导入校长", schemaName };
    await assertPageImportEntries(schemaName, user);

    await executeGatewayApi("tenant", schemaName, "product_list.create", {
      data: {
        name: "核心导入课程包",
        product_type: "ONE_ON_ONE_COURSE",
        unit_price: 200,
        default_course_hour: 10,
        total_amount: 2000,
        status: "ACTIVE",
      },
    }, user);

    await assertValidateOnlyDoesNotWrite(schemaName, user);

    await importOne({
      schemaName,
      pageCode: "student_list",
      apiCode: "student_list.create",
      user,
      row: {
        "学员姓名": "核心导入学员",
        "联系电话": "13800007777",
        "校区": "导入校长校区",
        "状态": "正式",
        "学校": "导入小学",
        "年级": "四年级",
      },
    });
    const student = await one(`select id from "${schemaName}".student where name = $1 and deleted = false`, ["核心导入学员"]);
    assert(student?.id, "学员导入后未查到记录");

    await importOne({
      schemaName,
      pageCode: "contract_list",
      apiCode: "contract_list.create",
      user,
      row: {
        "学员": "核心导入学员",
        "报读课程": "核心导入课程包",
        "合同类型": "一对一",
        "校区": "导入校长校区",
        "签约人": "导入校长",
        "签约时间": "2026/8/1 9:00",
      },
    });
    const contract = await one(`select id, paid_amount, paid_status from "${schemaName}".contract where student_id = $1 and deleted = false`, [student.id]);
    assert(contract?.id, "合同导入后未查到记录");
    const contractProduct = await one(
      `select id, remaining_real_hour, remaining_real_amount from "${schemaName}".contract_product where contract_id = $1 and deleted = false`,
      [contract.id]
    );
    assert(contractProduct?.id, "合同导入后未生成合同产品");

    await importOne({
      schemaName,
      pageCode: "student_list",
      apiCode: "student_list.create",
      user,
      row: {
        "学员姓名": "核心导入学员B",
        "联系电话": "13800007778",
        "校区": "导入校长校区",
        "状态": "正式",
      },
    });
    const secondStudent = await one(`select id from "${schemaName}".student where name = $1 and deleted = false`, ["核心导入学员B"]);
    assert(secondStudent?.id, "第二个同产品学员导入后未查到记录");
    await importOne({
      schemaName,
      pageCode: "contract_list",
      apiCode: "contract_list.create",
      user,
      row: {
        "学员": "核心导入学员B",
        "报读课程": "核心导入课程包",
        "合同类型": "一对一",
        "校区": "导入校长校区",
        "签约人": "导入校长",
        "签约时间": "2026/8/1 9:30",
      },
    });
    const secondContractProduct = await one(
      `select cp.id, cp.remaining_real_hour, cp.remaining_real_amount
       from "${schemaName}".contract_product cp
       join "${schemaName}".contract c on c.id = cp.contract_id and c.deleted = false
       where c.student_id = $1 and cp.deleted = false`,
      [secondStudent.id]
    );
    assert(secondContractProduct?.id, "第二个同产品合同产品未生成");

    await importOne({
      schemaName,
      pageCode: "funds_history",
      apiCode: "funds_history.create",
      user,
      row: {
        "合同": contract.id,
        "学员": "核心导入学员",
        "校区": "导入校长校区",
        "收款金额": "￥1,000.00",
        "支付方式": "现金",
        "收款时间": "2026/8/1 10:00",
        "流水类型": "合同收款",
      },
    });
    const funds = await one(`select id from "${schemaName}".funds_change_history where contract_id = $1 and deleted = false`, [contract.id]);
    assert(funds?.id, "收款导入后未查到流水");
    const paidAfterFunds = await one(`select paid_amount, paid_status from "${schemaName}".contract where id = $1`, [contract.id]);
    assert(Number(paidAfterFunds?.paid_amount) === 1000, "收款导入后合同已收异常");

    await importOne({
      schemaName,
      pageCode: "course_list",
      apiCode: "course_list.create",
      user,
      row: {
        "课程名称": "核心导入课次",
        "课程类型": "一对一",
        "上课日期": "2026/8/2",
        "开始时间": "9:00",
        "结束时间": "10:00:00",
        "老师": "导入校长",
        "学管师": "导入校长",
        "上课学员": "核心导入学员",
        "合同产品": "核心导入课程包",
        "校区": "导入校长校区",
        "课时": "1.0",
      },
    });
    const course = await one(`select id from "${schemaName}".generic_course where course_title = $1 and deleted = false`, ["核心导入课次"]);
    assert(course?.id, "排课导入后未查到课程");
    const courseTime = await one(`select course_date::text as course_date, start_time, end_time from "${schemaName}".generic_course where id = $1`, [course.id]);
    assert(courseTime?.course_date === "2026-08-02", "排课导入日期未规范化");
    assert(courseTime?.start_time === "09:00", "排课导入开始时间未规范化");
    assert(courseTime?.end_time === "10:00", "排课导入结束时间未规范化");

    await importOne({
      schemaName,
      pageCode: "charge_record",
      apiCode: "charge_record.create",
      user,
      row: {
        "课程": "核心导入课次",
        "学员": "核心导入学员",
        "合同产品": "核心导入课程包",
        "校区": "导入校长校区",
        "扣费类型": "实收扣费",
        "扣课时": "1.0",
        "扣费金额": "￥200.00",
      },
    });
    const charge = await one(`select id from "${schemaName}".account_charge_records where course_id = $1 and deleted = false`, [course.id]);
    assert(charge?.id, "扣费导入后未查到扣费记录");
    const cpAfterCharge = await one(
      `select consumed_real_hour, consumed_real_amount, remaining_real_hour, remaining_real_amount from "${schemaName}".contract_product where id = $1`,
      [contractProduct.id]
    );
    assert(Number(cpAfterCharge?.consumed_real_hour) === 1, "扣费导入后已消耗课时异常");
    assert(Number(cpAfterCharge?.remaining_real_hour) === 9, "扣费导入后剩余课时异常");

    await importOne({
      schemaName,
      pageCode: "refund_record",
      apiCode: "refund_record.create",
      user,
      row: {
        "学员": "核心导入学员",
        "合同产品": "核心导入课程包",
        "退课时": "1.0",
        "退金额": "￥200.00",
        "退费方式": "现金",
        "退费时间": "2026/8/3 9:00",
        "备注": "核心导入退费",
      },
    });
    const refund = await one(`select id from "${schemaName}".refund_record where remark = $1 and deleted = false`, ["核心导入退费"]);
    assert(refund?.id, "退费导入后未查到退费记录");
    const cpAfterRefund = await one(
      `select consumed_real_hour, remaining_real_hour, remaining_real_amount from "${schemaName}".contract_product where id = $1`,
      [contractProduct.id]
    );
    assert(Number(cpAfterRefund?.consumed_real_hour) === 1, "退费导入不应改动已消耗课时");
    assert(Number(cpAfterRefund?.remaining_real_hour) === 8, "退费导入后剩余课时异常");
    assert(Number(cpAfterRefund?.remaining_real_amount) === 1600, "退费导入后剩余金额异常");
    const secondCpAfterAll = await one(
      `select consumed_real_hour, remaining_real_hour, remaining_real_amount from "${schemaName}".contract_product where id = $1`,
      [secondContractProduct.id]
    );
    assert(Number(secondCpAfterAll?.consumed_real_hour) === 0, "重名合同产品解析错误：第二个学员被误扣课时");
    assert(Number(secondCpAfterAll?.remaining_real_hour) === 10, "重名合同产品解析错误：第二个学员剩余课时被误改");
    assert(Number(secondCpAfterAll?.remaining_real_amount) === 2000, "重名合同产品解析错误：第二个学员剩余金额被误改");

    await assertFailedImportResultFile({
      schemaName,
      pageCode: "student_list",
      apiCode: "student_list.create",
      user,
      row: {
        "学员姓名": "缺校区学员",
        "联系电话": "13800007779",
        "状态": "正式",
      },
      expectedMessage: "字段[校区]不能为空",
    });
    await assertBlankRowsAreSkipped(schemaName, user);
    await assertMixedBatchKeepsSuccessfulRows(schemaName, user);

    console.log(JSON.stringify({
      ok: true,
      schemaName,
      studentId: student.id,
      secondStudentId: secondStudent.id,
      contractId: contract.id,
      contractProductId: contractProduct.id,
      secondContractProductId: secondContractProduct.id,
      fundsId: funds.id,
      courseId: course.id,
      chargeId: charge.id,
      refundId: refund.id,
      remainingHour: Number(cpAfterRefund?.remaining_real_hour),
      remainingAmount: Number(cpAfterRefund?.remaining_real_amount),
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
