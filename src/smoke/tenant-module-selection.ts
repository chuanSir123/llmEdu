import { pool } from "../db/pool.js";
import { createTenantWithModules } from "../tenant/tenant-create.service.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function scalar<T = unknown>(sql: string, params: unknown[] = []): Promise<T> {
  const { rows } = await pool.query(sql, params);
  return rows[0]?.value as T;
}

async function main() {
  const result = await createTenantWithModules({
    name: `模块选择冒烟 ${Date.now()}`,
    contactPhone: `139${String(Date.now()).slice(-8)}`,
    ownerName: "模块选择校长",
    selectedModules: ["student"],
    selectedFeatures: ["student_list"],
    operatorId: "smoke_module_selection",
  });

  const enabledFeatureCount = await scalar<number>(
    `select count(*)::int as value from admin.tenant_feature_subscription where schema_name = $1 and enabled = true and deleted = false`,
    [result.schemaName],
  );
  assert(enabledFeatureCount === 1, `expected only one selected feature, got ${enabledFeatureCount}`);

  const selectedStudent = await scalar<number>(
    `select count(*)::int as value from admin.tenant_feature_subscription where schema_name = $1 and feature_code = 'student_list' and enabled = true and deleted = false`,
    [result.schemaName],
  );
  assert(selectedStudent === 1, "student_list subscription missing");

  const copiedStudentPage = await scalar<number>(
    `select count(*)::int as value from admin.page_dsl where schema_scope = 'tenant' and schema_name = $1 and page_code = 'student_list' and status = 'active' and deleted = false`,
    [result.schemaName],
  );
  assert(copiedStudentPage === 1, "student_list DSL was not copied into tenant scope");

  const copiedCoursePage = await scalar<number>(
    `select count(*)::int as value from admin.page_dsl where schema_scope = 'tenant' and schema_name = $1 and page_code = 'course_list' and status = 'active' and deleted = false`,
    [result.schemaName],
  );
  assert(copiedCoursePage === 0, "unselected course_list DSL should not be copied into tenant scope");

  const copiedCourseRule = await scalar<number>(
    `select count(*)::int as value from admin.business_rule where schema_scope = 'tenant' and schema_name = $1 and rule_code = 'course_create_rule' and status = 'active' and deleted = false`,
    [result.schemaName],
  );
  assert(copiedCourseRule === 0, "unselected course business rule should not be copied into tenant scope");

  console.log(JSON.stringify({ ok: true, schemaName: result.schemaName, initialVersionCount: result.initialVersionCount }));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
