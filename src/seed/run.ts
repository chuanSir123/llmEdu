import { pool, withClient } from "../db/pool.js";
import { migrate } from "../db/migrator.js";
import { adminPages, adminPasswordHash, apiDsl, businessRules, llmSeed, modules, pageDsl, pages, passwordHash } from "./data.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

function id(prefix: string, code: string) {
  return `${prefix}_${code}`.replace(/[^a-zA-Z0-9_]/g, "_");
}

async function upsert(table: string, key: string, row: Record<string, unknown>) {
  const keys = Object.keys(row);
  const values = Object.values(row).map((value) => {
    if (value && typeof value === "object" && !(value instanceof Date)) {
      return JSON.stringify(value);
    }
    return value;
  });
  const updates = keys.filter((k) => k !== key).map((k) => `${k}=excluded.${k}`).join(",");
  await pool.query(
    `insert into ${table} (${keys.join(",")}) values (${keys.map((_, i) => `$${i + 1}`).join(",")})
     on conflict (${key}) do update set ${updates}`,
    values
  );
}

async function seedAdmin() {
  await upsert("admin.admin_user", "id", {
    id: "admin_001",
    name: "平台管理员",
    contact: "admin",
    email: "admin@example.com",
    psw: adminPasswordHash,
    status: "ACTIVE"
  });
  await upsert("admin.llm_config", "id", llmSeed);
  await upsert("admin.tenant_manage", "id", {
    id: "tenant_demo",
    schema_name: "demo_school",
    name: "小墨斗教育",
    status: "ACTIVE",
    student_limit: 1000,
    organization_limit: 20,
    staff_limit: 200,
    pay_type: "TRIAL",
    pay_amount: 0,
    expire_time: "2099-12-31T23:59:59Z",
    contact_phone: "18800000000",
    owner_name: "张校长",
    enabled_modules: JSON.stringify(modules.map((m) => m[0])),
    enabled_features: JSON.stringify(pages.map((p) => p.feature))
  });
  await upsert("admin.tenant_manage", "id", {
    id: "tenant_trial",
    schema_name: "trial_school",
    name: "试用校区",
    status: "ACTIVE",
    expire_time: "2099-12-31T23:59:59Z",
    owner_name: "试用负责人",
    enabled_modules: JSON.stringify(["frontdesk", "recruit", "student", "education", "finance", "report", "system"]),
    enabled_features: JSON.stringify(["frontdesk_home", "student_list", "course_list", "contract_list", "funds_history", "product_list", "role_list", "user_list"])
  });

  for (const [module_code, module_name, module_group, description, sort_no, icon] of modules) {
    await upsert("admin.module_registry", "id", {
      id: id("mod", module_code),
      module_code,
      module_name,
      module_group,
      description,
      default_enabled: true,
      sort_no,
      icon,
      optional_dependency: JSON.stringify([]),
      skill_code: `skill_${module_code}`,
      status: "ACTIVE"
    });
  }

  for (const page of pages) {
    await upsert("admin.feature_registry", "id", {
      id: id("feature", page.feature),
      module_code: page.module,
      feature_code: page.feature,
      feature_name: page.name,
      description: `${page.name} DSL 功能`,
      page_code: page.page,
      default_enabled: true,
      sort_no: 10,
      skill_code: `skill_${page.feature}`,
      status: "ACTIVE"
    });
  }

  for (const tenant of ["demo_school", "trial_school"]) {
    const tenantId = tenant === "demo_school" ? "tenant_demo" : "tenant_trial";
    const tenantFeatures = tenant === "demo_school" ? pages : pages.filter((p) => ["frontdesk_home", "student_list", "course_list", "contract_list", "funds_history", "product_list", "role_list", "user_list"].includes(p.feature));
    for (const [module_code] of modules) {
      const enabled = tenant === "demo_school" || ["frontdesk", "recruit", "student", "education", "finance", "report", "system"].includes(module_code);
      await upsert("admin.tenant_module_subscription", "id", {
        id: id(`sub_${tenant}`, module_code),
        tenant_id: tenantId,
        schema_name: tenant,
        module_code,
        enabled
      });
    }
    for (const page of tenantFeatures) {
      await upsert("admin.tenant_feature_subscription", "id", {
        id: id(`feat_${tenant}`, page.feature),
        tenant_id: tenantId,
        schema_name: tenant,
        module_code: page.module,
        feature_code: page.feature,
        enabled: true
      });
    }
  }

  for (const page of pages) {
    await seedDsl("tenant_default", null, page);
  }
  for (const rule of businessRules) {
    await upsert("admin.business_rule", "id", {
      id: id("rule_tenant_default", rule.rule_code),
      schema_scope: "tenant_default",
      schema_name: null,
      rule_code: rule.rule_code,
      rule_name: rule.rule_name,
      rule_json: JSON.stringify(rule.rule_json),
      version_no: 1,
      status: "active"
    });
  }
  for (const page of adminPages) {
    await seedDsl("admin", null, page);
  }
}

async function seedDsl(schemaScope: string, schemaName: string | null, page: (typeof pages)[number] | (typeof adminPages)[number]) {
  await upsert("admin.page_dsl", "id", {
    id: id(`page_${schemaScope}`, page.page),
    schema_scope: schemaScope,
    schema_name: schemaName,
    module_code: page.module,
    feature_code: page.feature,
    page_code: page.page,
    page_name: page.name,
    page_kind: "business",
    route_path: `/${page.page}`,
    dsl_json: JSON.stringify(pageDsl(page)),
    version_no: 1,
    status: "active"
  });
  for (const apiType of ["query", "detail", "create", "update", "delete"] as const) {
    await upsert("admin.api_dsl", "id", {
      id: id(`api_${schemaScope}`, `${page.page}_${apiType}`),
      schema_scope: schemaScope,
      schema_name: schemaName,
      module_code: page.module,
      feature_code: page.feature,
      api_code: `${page.page}.${apiType}`,
      api_name: `${page.name}${apiType}`,
      api_type: apiType === "query" ? "query" : apiType === "detail" ? "detail" : "command",
      dsl_json: JSON.stringify(apiDsl(page, apiType)),
      version_no: 1,
      status: "active"
    });
  }
  await upsert("admin.skill_registry", "id", {
    id: id(`skill_${schemaScope}`, page.feature),
    schema_scope: schemaScope,
    schema_name: schemaName,
    module_code: page.module,
    feature_code: page.feature,
    skill_code: `skill_${page.feature}`,
    skill_name: `${page.name}维护说明`,
    skill_md_content: `# ${page.name}\n\n通过 page DSL、api DSL 和 action DSL 维护本功能。新增可查询、筛选、排序、统计、权限判断或报表聚合字段时，优先生成 schema_change_request；仅展示或低频扩展字段使用 ext_json。`,
    version_no: 1,
    status: "active"
  });
}

async function seedTenantData() {
  const schema = "demo_school";
  const rows: Array<[string, Record<string, unknown>[]]> = [
    ["organization", [
      { id: "org_001", name: "小墨斗校区", organization_type: "HEAD", status: "ACTIVE" },
      { id: "org_002", name: "城东校区", parent_id: "org_001", organization_type: "BRANCH", status: "ACTIVE" },
      { id: "org_003", name: "城西校区", parent_id: "org_001", organization_type: "BRANCH", status: "ACTIVE" }
    ]],
    ["user", [
      { id: "user_001", name: "张校长", contact: "18800000001", organization_id: "org_001", staff_type: "MANAGER", status: "ACTIVE", psw: passwordHash },
      { id: "user_002", name: "李老师", contact: "18800000002", organization_id: "org_001", staff_type: "TEACHER", status: "ACTIVE", psw: passwordHash },
      { id: "user_003", name: "王学管", contact: "18800000003", organization_id: "org_001", staff_type: "STUDY_MANAGER", status: "ACTIVE", psw: passwordHash },
      { id: "user_004", name: "赵顾问", contact: "18800000004", organization_id: "org_002", staff_type: "SALES", status: "ACTIVE", psw: passwordHash }
    ]],
    ["role", [
      { id: "role_001", name: "校长", role_code: "PRINCIPAL", organization_id: "org_001" },
      { id: "role_002", name: "老师", role_code: "TEACHER", organization_id: "org_001" },
      { id: "role_003", name: "学管师", role_code: "STUDY_MANAGER", organization_id: "org_001" },
      { id: "role_004", name: "课程顾问", role_code: "SALES", organization_id: "org_001" }
    ]],
    ["user_role", [
      { id: "ur_001", user_id: "user_001", role_id: "role_001" },
      { id: "ur_002", user_id: "user_002", role_id: "role_002" },
      { id: "ur_003", user_id: "user_003", role_id: "role_003" },
      { id: "ur_004", user_id: "user_004", role_id: "role_004" }
    ]],
    ["student", [
      { id: "stu_001", name: "姚锦鹏", contact: "13600000001", organization_id: "org_001", student_status: "FORMAL", source_type: "REFERRAL", study_manager_id: "user_003", school_name: "第一小学", grade: "三年级" },
      { id: "stu_002", name: "1019", contact: "13600000002", organization_id: "org_001", student_status: "FORMAL", source_type: "WALK_IN", study_manager_id: "user_003", school_name: "第二小学", grade: "四年级" },
      { id: "stu_003", name: "测试测试测试测试测试测试测试测试测试", contact: "13600000003", organization_id: "org_001", student_status: "FORMAL", source_type: "ONLINE", study_manager_id: "user_003", school_name: "测试小学", grade: "五年级" },
      { id: "stu_004", name: "李小明", contact: "13600000004", organization_id: "org_002", student_status: "LEAD", source_type: "ONLINE", owner_user_id: "user_004", school_name: "城东小学", grade: "二年级" }
    ]],
    ["student_followup", [
      { id: "follow_001", student_id: "stu_004", follow_user_id: "user_004", follow_type: "PHONE", follow_content: "首次电话沟通，家长关注数学提升", next_follow_time: "2026-06-12T10:00:00+08:00" },
      { id: "follow_002", student_id: "stu_001", follow_user_id: "user_003", follow_type: "VISIT", follow_content: "课后回访，反馈良好" }
    ]],
    ["product", [
      { id: "prod_001", name: "一对一数学 20 课时", unit_price: 200, default_course_hour: 20, total_amount: 4000, product_type: "ONE_ON_ONE_COURSE", status: "ACTIVE" },
      { id: "prod_002", name: "小班语文 30 课时", unit_price: 100, default_course_hour: 30, total_amount: 3000, product_type: "SMALL_CLASS", status: "ACTIVE" },
      { id: "prod_003", name: "一对N英语 24 课时", unit_price: 120, default_course_hour: 24, total_amount: 2880, product_type: "ONE_ON_N_GROUP", status: "ACTIVE" }
    ]],
    ["promotion", [
      { id: "promo_reduce_300", name: "报名立减 300", type: "REDUCE", value: 300, status: "ACTIVE" },
      { id: "promo_discount_9", name: "新生 9 折", type: "DISCOUNT", value: 9, status: "ACTIVE" }
    ]],
    ["contract", [
      { id: "contract_001", student_id: "stu_001", paid_status: "PART_PAID", contract_type: "ONE_ON_ONE_COURSE", organization_id: "org_001", sign_staff_id: "user_004", sign_time: "2026-01-05T10:00:00+08:00", total_amount: 4000, paid_amount: 2000, promotion_amount: 300, contract_status: "ACTIVE" },
      { id: "contract_002", student_id: "stu_002", paid_status: "PAID", contract_type: "SMALL_CLASS", organization_id: "org_001", sign_staff_id: "user_004", sign_time: "2026-01-06T11:00:00+08:00", total_amount: 3000, paid_amount: 3000, promotion_amount: 0, contract_status: "ACTIVE" }
    ]],
    ["contract_product", [
      { id: "cp_001", contract_id: "contract_001", product_id: "prod_001", plan_real_hour: 20, plan_promotion_hour: 2, plan_real_amount: 4000, plan_promotion_amount: 300, paid_real_hour: 10, paid_promotion_hour: 2, paid_real_amount: 2000, paid_promotion_amount: 300, consumed_real_hour: 2, remaining_real_hour: 8, remaining_promotion_hour: 2, remaining_real_amount: 1600, remaining_promotion_amount: 300 },
      { id: "cp_002", contract_id: "contract_002", product_id: "prod_002", plan_real_hour: 30, paid_real_hour: 30, paid_real_amount: 3000, consumed_real_hour: 3, remaining_real_hour: 27, remaining_real_amount: 2700 }
    ]],
    ["mini_class", [{ id: "mc_001", name: "三年级语文小班", organization_id: "org_001", teacher_id: "user_002", study_manager_id: "user_003", capacity: 12, status: "ACTIVE" }]],
    ["one_on_n_group", [{ id: "ong_001", name: "英语一对三 A 组", organization_id: "org_001", teacher_id: "user_002", study_manager_id: "user_003", capacity: 3, status: "ACTIVE" }]],
    ["generic_course", [
      { id: "course_001", course_type: "ONE_ON_ONE_COURSE", course_date: "2026-06-11", start_time: "09:00", end_time: "10:00", teacher_id: "user_002", study_manager_id: "user_003", course_status: "FINISHED", organization_id: "org_001", course_title: "姚锦鹏一对一数学", course_hour: 1 },
      { id: "course_002", course_type: "SMALL_CLASS", course_date: "2026-06-11", start_time: "14:00", end_time: "15:30", teacher_id: "user_002", study_manager_id: "user_003", course_status: "SCHEDULED", organization_id: "org_001", mini_class_id: "mc_001", course_title: "三年级语文小班", course_hour: 1.5 }
    ]],
    ["generic_course_student", [
      { id: "cs_001", course_id: "course_001", student_id: "stu_001", attendance_status: "PRESENT", contract_product_id: "cp_001" },
      { id: "cs_002", course_id: "course_002", student_id: "stu_002", attendance_status: "PENDING", contract_product_id: "cp_002" }
    ]],
    ["account_charge_records", [{ id: "charge_001", course_id: "course_001", charge_type: "NORMAL", charge_hour: 1, charge_amount: 200, contract_product_id: "cp_001", organization_id: "org_001", student_id: "stu_001", charge_status: "CONFIRMED" }]],
    ["funds_change_history", [
      { id: "fund_001", contract_id: "contract_001", student_id: "stu_001", transaction_amount: 2000, transaction_time: "2026-01-05T10:30:00+08:00", pay_way_config_id: "pay_cash", funds_type: "CONTRACT_PAY", organization_id: "org_001" },
      { id: "fund_002", contract_id: "contract_002", student_id: "stu_002", transaction_amount: 3000, transaction_time: "2026-01-06T11:30:00+08:00", pay_way_config_id: "pay_wechat", funds_type: "CONTRACT_PAY", organization_id: "org_001" },
      { id: "fund_003", student_id: "stu_001", transaction_amount: 500, transaction_time: "2026-01-10T09:00:00+08:00", pay_way_config_id: "pay_wechat", funds_type: "PRE_STORE", organization_id: "org_001" }
    ]],
    ["pay_way_config", [
      { id: "pay_cash", name: "现金", pay_way_type: "CASH", status: "ACTIVE" },
      { id: "pay_wechat", name: "微信", pay_way_type: "WECHAT", status: "ACTIVE" },
      { id: "pay_alipay", name: "支付宝", pay_way_type: "ALIPAY", status: "ACTIVE" },
      { id: "pay_ele_account", name: "电子账户", pay_way_type: "ELE_ACCOUNT", status: "ACTIVE" }
    ]],
    ["student_ele_account", [
      { id: "sea_001", student_id: "stu_001", balance_amount: 500, frozen_amount: 0, status: "ACTIVE" }
    ]],
    ["student_ele_account_record", [
      { id: "sear_001", student_id: "stu_001", account_id: "sea_001", change_type: "PRESTORE_IN", change_amount: 500, balance_after: 500, source_funds_id: "fund_003", remark: "初始化预存" }
    ]],
    ["ele_account", [{ id: "ele_001", name: "默认电子账户", account_type: "DEFAULT", status: "ACTIVE" }]],
    ["refund_record", [{ id: "refund_001", student_id: "stu_001", contract_product_id: "cp_001", refund_real_hour: 0, refund_real_amount: 0, refund_promotion_amount: 0, refund_promotion_hour: 0, refund_way_config_id: "pay_wechat", refund_time: "2026-01-20T10:00:00+08:00", remark: "测试空退费记录" }]],
    ["notice", [{ id: "notice_001", title: "六月教务安排", content: "请各校区完成课消核对。", status: "PUBLISHED" }]]
  ];

  for (const [table, tableRows] of rows) {
    for (const row of tableRows) {
      await upsert(`"${schema}".${table === "user" ? "\"user\"" : table}`, "id", row);
    }
  }

  for (const page of pages) {
    await upsert(`"${schema}".role_resource`, "id", {
      id: id("rr_principal", page.page),
      role_id: "role_001",
      page_code: page.page,
      action_code: null,
      page_permission: "all",
      button_permission: JSON.stringify(["create", "edit", "delete", "detail"]),
      data_permission: "all"
    });
  }
}

export async function seed() {
  await migrate();
  await seedAdmin();
  await seedTenantData();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  seed()
    .then(async () => {
      console.log("Seed complete");
      await pool.end();
    })
    .catch(async (error) => {
      console.error(error);
      await pool.end();
      process.exit(1);
    });
}
