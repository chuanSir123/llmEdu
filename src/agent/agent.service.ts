import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";

const SCHOOL_NAME = "\u5b66\u6821\u540d\u79f0";
const PARENT_WECHAT = "\u5bb6\u957f\u5fae\u4fe1";
const FILTER = "\u7b5b\u9009";
const STAT = "\u7edf\u8ba1";
const REPORT = "\u62a5\u8868";

function hasAny(text: string, words: string[]) {
  return words.some((word) => text.includes(word));
}

export async function submitAgentTask(schemaName: string, prompt: string, mode = "draft") {
  const normalized = prompt.toLowerCase();
  let result: Record<string, unknown>;

  const hasSchoolName = hasAny(prompt, [SCHOOL_NAME, "\u702b\ufe21\u6f92\u935a\u5d88\u7d04"]) || normalized.includes("school_name");
  const hasParentWechat = hasAny(prompt, [PARENT_WECHAT, "\u7039\u5815\u66b1\u5bf0\ue1c6\u4fca"]) || normalized.includes("parent_wechat");
  const needsRealField =
    hasAny(prompt, [FILTER, STAT, REPORT, "\u7ecc\u6d98\u20ac", "\u7f01\u7edf\u8ba1", "\u93b6\u30e8\u303d"]) ||
    ["filter", "stat", "report"].some((word) => normalized.includes(word));

  if (hasSchoolName) {
    result = {
      type: "dsl_diff",
      schemaChangeRequest: false,
      reason: "school_name is already a base field on student, so this only needs page DSL and api DSL draft diffs.",
      diffs: [
        { targetType: "page_dsl", targetCode: "student_list", op: "add_filter_and_column", field: "school_name" },
        { targetType: "api_dsl", targetCode: "student_list.query", op: "add_filter", field: "school_name" }
      ]
    };
  } else if (hasParentWechat && needsRealField) {
    const requestId = randomUUID();
    await pool.query(
      `insert into admin.schema_change_request(id, schema_name, table_name, field_name, reason, request_json)
       values($1,$2,'student','parent_wechat',$3,$4)`,
      [
        requestId,
        schemaName,
        "parent_wechat participates in filtering/statistics/reporting, so a real field is suggested and awaits confirmation.",
        JSON.stringify({ prompt })
      ]
    );
    result = {
      type: "schema_change_request",
      schemaChangeRequest: true,
      requestId,
      reason: "Fields used for query, filtering, statistics, permission checks, or reports produce schema_change_request instead of direct DDL."
    };
  } else if (hasParentWechat) {
    result = {
      type: "ext_json_plan",
      schemaChangeRequest: false,
      reason: "Display-only parent_wechat should use student.ext_json.parent_wechat without adding a physical column.",
      diffs: [{ targetType: "page_dsl", targetCode: "student_detail", op: "add_display_field", field: "ext_json.parent_wechat" }]
    };
  } else {
    result = {
      type: "draft_diff",
      schemaChangeRequest: false,
      reason: "Draft task generated and requires confirmation before publishing.",
      diffs: []
    };
  }

  const id = randomUUID();
  await pool.query(
    `insert into admin.agent_task(id, schema_name, user_prompt, mode, status, result_json)
     values($1,$2,$3,$4,'draft',$5)`,
    [id, schemaName, prompt, mode, JSON.stringify(result)]
  );
  return { id, ...result };
}
