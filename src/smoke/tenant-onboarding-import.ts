import * as XLSX from "xlsx";
import bcrypt from "bcryptjs";
import { pool } from "../db/pool.js";
import { createTenantWithModules } from "../tenant/tenant-create.service.js";
import { loadTenantMenu } from "../gateway/menu.service.js";
import { buildImportTemplate, executeTenantImport, resolveTenantImportConfig } from "../tenant/import.service.js";
import type { SessionUser } from "../types.js";
import { assert, cleanupTenant } from "./smoke-utils.js";

function workbookBase64(row: Record<string, unknown>) {
  const sheet = XLSX.utils.json_to_sheet([row]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "导入数据");
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return buffer.toString("base64");
}

async function main() {
  let schemaName = "";
  try {
    const created = await createTenantWithModules({
      name: "冒烟测试机构",
      contactPhone: "19900009999",
      ownerName: "冒烟校长",
      selectedModules: ["frontdesk", "student", "system"],
      selectedFeatures: ["frontdesk_home", "student_list", "organization_list", "user_list", "role_list"],
      operatorId: "smoke_admin",
    });
    schemaName = created.schemaName;
    assert(created.login.ownerContact === "19900009999", "租户负责人登录账号未按手机号生成");
    assert(created.login.ownerPassword, "租户负责人初始密码未返回");

    const { rows: users } = await pool.query(`select id, name, psw from "${schemaName}"."user" where id = 'user_owner' and deleted = false`);
    assert(users[0], "未生成租户负责人账号");
    assert(await bcrypt.compare(created.login.ownerPassword, users[0].psw), "租户负责人初始密码不可用");

    const user: SessionUser = { kind: "tenant", userId: "user_owner", name: String(users[0].name), schemaName };
    const menu = await loadTenantMenu(schemaName, user);
    const menuJson = JSON.stringify(menu);
    assert(menuJson.includes("student_list"), "租户菜单缺少学员列表");

    const importConfig = await resolveTenantImportConfig({
      schemaName,
      pageCode: "student_list",
      apiCode: "student_list.create",
    });
    assert(importConfig.apiCode === "student_list.create", "导入 API 未解析到学员新增接口");
    assert(importConfig.fields.some((field) => field.key === "organization_id"), "导入字段缺少校区名称解析字段");

    const template = buildImportTemplate(importConfig.fields);
    assert(template.length > 1000, "导入模板文件生成异常");

    const importResult = await executeTenantImport({
      schemaName,
      pageCode: "student_list",
      apiCode: importConfig.apiCode,
      fileName: "student_smoke.xlsx",
      contentBase64: workbookBase64({
        name: "冒烟学员",
        contact: "13800009999",
        organization_id: "冒烟校长校区",
        student_status: "FORMAL",
        school_name: "冒烟小学",
        grade: "三年级",
      }),
      fields: importConfig.fields,
      idResolutionStrategy: "error",
      user,
    });
    assert(importResult.total === 1, "导入总数异常");
    assert(importResult.success === 1 && importResult.failed === 0, `导入失败: ${JSON.stringify(importResult)}`);

    const { rows: students } = await pool.query(
      `select id from "${schemaName}".student where name = $1 and contact = $2 and deleted = false`,
      ["冒烟学员", "13800009999"]
    );
    assert(students.length === 1, "导入成功后未查到学员记录");

    console.log(JSON.stringify({
      ok: true,
      schemaName,
      ownerContact: created.login.ownerContact,
      menuModules: menu.length,
      importApiCode: importConfig.apiCode,
      importFieldCount: importConfig.fields.length,
      importedStudents: students.length,
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
