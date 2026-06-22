import * as XLSX from "xlsx";
import { pool } from "../db/pool.js";
import { seed } from "../seed/run.js";
import { saveAgentAttachment } from "../tenant/attachment.service.js";
import { tenantAssistantChat } from "../tenant/tenant-assistant.service.js";
import type { SessionUser } from "../types.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function workbookBase64() {
  const workbook = XLSX.utils.book_new();
  const students = XLSX.utils.json_to_sheet([
    {
      孩子姓名: `AI导入测试学员${Date.now()}`,
      手机号: "13900009991",
      所在校区: "小墨斗校区",
      当前阶段: "正式",
      就读学校: "自动化小学",
      年级: "三年级",
      备注信息: "非模板 Excel 自动映射验证",
    },
  ]);
  XLSX.utils.book_append_sheet(workbook, students, "学员花名册");
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return buffer.toString("base64");
}

async function latestAssistantLogs(sessionId: string) {
  const { rows } = await pool.query(
    `select model, has_tools, tool_names, function_call, response_content, error, status, created_at
     from admin.llm_call_log
     where session_id = $1
     order by created_at desc
     limit 8`,
    [sessionId]
  );
  return rows;
}

async function main() {
  await seed();
  const schemaName = "demo_school";
  const user: SessionUser = { kind: "tenant", userId: "user_001", name: "张校长", schemaName, currentManagementOrganizationId: "org_001" };

  const attachment = await saveAgentAttachment({
    schemaName,
    userId: user.userId,
    fileName: "非模板学员台账.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    contentBase64: workbookBase64(),
  });

  assert(Array.isArray(attachment.contentSummary.sheets), "附件摘要没有包含所有 sheet");
  const events: Array<{ title: string; message: string; toolName?: string; status?: string }> = [];
  const result = await tenantAssistantChat({
    schemaName,
    user,
    attachmentIds: [attachment.id],
    message: "请识别这个非模板 Excel 的所有 sheet，自动确定导入模块和功能，并先执行校验导入，不要正式写入。",
    onProgress: (event) => {
      if (event.visibleToTenant) events.push({ title: event.title, message: event.message, toolName: event.toolName, status: event.status });
    },
  });

  const toolNames = events.map((event) => event.toolName).filter(Boolean);
  const logs = await latestAssistantLogs(result.sessionId);
  console.log(JSON.stringify({ sessionId: result.sessionId, reply: result.reply, toolNames, events, logs }, null, 2));

  assert(toolNames.includes("plan_excel_import"), "AI 助手没有调用 Excel 导入规划工具");
  assert(toolNames.includes("execute_excel_import"), "AI 助手没有调用 Excel 校验导入工具");
  const executeResult = result.toolResults.find((item) => item.name === "execute_excel_import");
  assert(executeResult, "没有找到 Excel 校验导入工具结果");
  assert((executeResult.args as { mode?: string }).mode === "validate", "Excel 校验导入工具没有使用 validate 模式");
  const rows = ((executeResult.result as { results?: Array<{ mode?: string }> }).results ?? []);
  assert(rows.every((item) => item.mode === "validate"), "Excel 导入结果不是 validate 模式");
  assert(/校验|导入|学员/.test(result.reply), "AI 助手回复没有说明校验/导入结果");

  await pool.end();
}

main().catch(async (error) => {
  console.error(error);
  await pool.end();
  process.exit(1);
});
