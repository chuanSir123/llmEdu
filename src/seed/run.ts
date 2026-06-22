import { pool, withClient } from "../db/pool.js";
import { migrate } from "../db/migrator.js";
import { adminModules, adminPages, adminPasswordHash, apiDsl, actionDslSeeds, approvalFlows, businessRules, extraPages, llmSeed, modalDslSeeds, modules, optionApiDslSeeds, pageDsl, pages, passwordHash, printTemplates, skillContentMap, standardImportConfigs } from "./data.js";
import { env } from "../config/env.js";
import { fillEmptySkillMd } from "../agent/skill-md.service.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

function id(prefix: string, code: string) {
  return `${prefix}_${code}`.replace(/[^a-zA-Z0-9_]/g, "_");
}

function collectPageActionCodes(page: (typeof pages)[number]) {
  const dsl = pageDsl(page) as {
    toolbar?: Array<{ actionCode?: string }>;
    table?: { rowActions?: Array<{ actionCode?: string }> };
  };
  return [
    ...new Set([
      ...(dsl.toolbar ?? []).map((action) => action.actionCode).filter((code): code is string => Boolean(code)),
      ...(dsl.table?.rowActions ?? []).map((action) => action.actionCode).filter((code): code is string => Boolean(code)),
      ...actionDslSeeds.filter((action) => action.pageCode === page.page).map((action) => action.actionCode),
    ]),
  ];
}

function collectPermissionPageSeeds() {
  return [
    ...pages.map((page) => ({ pageCode: page.page, actionCodes: collectPageActionCodes(page) })),
    ...extraPages.map((page) => ({
      pageCode: page.pageCode,
      actionCodes: actionDslSeeds.filter((action) => action.pageCode === page.pageCode).map((action) => action.actionCode),
    })),
  ];
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
  await upsert("admin.llm_config", "id", {
    id: "llm_demo_school",
    config_code: "demo_school_llm",
    schema_name: "demo_school",
    base_url: env.llm.baseUrl,
    api_key: env.llm.apiKey ?? "",
    model: env.llm.model,
    provider: "openai-compatible",
    max_context_tokens: 256000,
    source_env_keys: ["LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL"],
    status: "ACTIVE"
  });
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
    enabled_features: JSON.stringify(pages.map((p) => p.feature)),
    agent_customization_enabled: true
  });
  await upsert("admin.tenant_manage", "id", {
    id: "tenant_trial",
    schema_name: "trial_school",
    name: "试用校区",
    status: "ACTIVE",
    expire_time: "2099-12-31T23:59:59Z",
    owner_name: "试用负责人",
    enabled_modules: JSON.stringify(["frontdesk", "recruit", "student", "education", "finance", "report", "system"]),
    enabled_features: JSON.stringify(["frontdesk_home", "student_list", "course_list", "contract_list", "funds_history", "product_list", "role_list", "user_list", "approval_flow_list", "business_rule_list", "money_arrange_list", "promotion_arrange_list", "performance_arrange_list", "finance_report", "course_report"])
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

  for (const [module_code, module_name, module_group, description, sort_no, icon] of adminModules) {
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

  for (const page of adminPages) {
    await upsert("admin.feature_registry", "id", {
      id: id("feature", page.feature),
      module_code: page.module,
      feature_code: page.feature,
      feature_name: page.name,
      description: `${page.name} 管理功能`,
      page_code: page.page,
      default_enabled: true,
      sort_no: 10,
      skill_code: `skill_${page.feature}`,
      status: "ACTIVE"
    });
  }

  for (const tenant of ["demo_school", "trial_school"]) {
    const tenantId = tenant === "demo_school" ? "tenant_demo" : "tenant_trial";
    const tenantFeatures = tenant === "demo_school" ? pages : pages.filter((p) => ["frontdesk_home", "student_list", "course_list", "contract_list", "funds_history", "product_list", "role_list", "user_list", "approval_flow_list", "business_rule_list", "money_arrange_list", "promotion_arrange_list", "performance_arrange_list", "finance_report", "course_report"].includes(p.feature));
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

  await upsert("admin.tenant_agent_config", "id", {
    id: "tac_demo",
    schema_name: "demo_school",
    agent_customization_enabled: true,
    preview_db_config: JSON.stringify({}),
    max_chat_rounds: 20
  });

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
  await pool.query(
    `update admin.business_rule
     set deleted = true, updated_at = now()
     where schema_scope = 'tenant_default'
       and deleted = false
       and not (rule_code = any($1::text[]))`,
    [businessRules.map((rule) => rule.rule_code)]
  );
  await pool.query(
    `update admin.business_rule
     set rule_json = $1::jsonb, updated_at = now()
     where deleted = false
       and rule_json->>'category' is null
       and (rule_name = '排课时间冲突校验' or rule_json->>'ruleCode' = 'course_time_conflict')`,
    [JSON.stringify({
      category: "validation",
      businessType: "course",
      targetApi: "course_list.create",
      preventTeacherTimeConflict: true,
      preventStudentTimeConflict: true,
      preventInvalidTimeRange: true,
      validations: [
        { field: "end_time", operator: ">", valueField: "start_time", message: "结束时间必须晚于开始时间" },
        { field: "teacher_id", operator: "no_time_overlap", valueField: "teacher_course_date,start_time,end_time", message: "同一老师同一天同一时间段不能重复排课" },
        { field: "student_id", operator: "no_time_overlap", valueField: "student_course_date,start_time,end_time", message: "同一学员同一天同一时间段不能重复排课" }
      ]
    })]
  );
  for (const template of printTemplates) {
    await upsert("admin.print_template", "id", {
      id: id("print_tenant_default", template.template_code),
      schema_scope: "tenant_default",
      schema_name: null,
      template_code: template.template_code,
      template_name: template.template_name,
      dsl_json: JSON.stringify(template.dsl_json),
      version_no: 1,
      status: "active"
    });
  }
  for (const config of standardImportConfigs) {
    await upsert("admin.import_dsl", "id", {
      id: id("import_tenant_default", config.importCode),
      schema_scope: "tenant_default",
      schema_name: null,
      import_code: config.importCode,
      import_name: config.importName,
      dsl_json: JSON.stringify(config.dsl),
      version_no: 1,
      status: "active"
    });
  }
  for (const page of adminPages) {
    await seedDsl("admin", null, page);
  }

  for (const extra of extraPages) {
    await upsert("admin.page_dsl", "id", {
      id: id("page_tenant_default", extra.pageCode),
      schema_scope: "tenant_default",
      schema_name: null,
      module_code: extra.module,
      feature_code: extra.feature,
      page_code: extra.pageCode,
      page_name: extra.name,
      page_kind: extra.pageKind,
      route_path: `/${extra.pageCode}`,
      dsl_json: JSON.stringify(extra.dsl),
      version_no: 1,
      status: "active"
    });
  }

  for (const action of actionDslSeeds) {
    await upsert("admin.action_dsl", "id", {
      id: id("action_tenant_default", action.actionCode),
      schema_scope: "tenant_default",
      schema_name: null,
      module_code: action.module,
      feature_code: action.feature,
      page_code: action.pageCode,
      action_code: action.actionCode,
      action_name: action.actionName,
      action_type: action.actionType,
      dsl_json: JSON.stringify(action.dsl),
      version_no: 1,
      status: "active"
    });
  }

  for (const modal of modalDslSeeds) {
    await upsert("admin.action_dsl", "id", {
      id: id("modal_tenant_default", modal.actionCode),
      schema_scope: "tenant_default",
      schema_name: null,
      module_code: modal.module,
      feature_code: modal.feature,
      page_code: modal.pageCode,
      action_code: modal.actionCode,
      action_name: modal.actionName,
      action_type: "modal",
      dsl_json: JSON.stringify(modal.dsl),
      version_no: 1,
      status: "active"
    });
  }

  for (const option of optionApiDslSeeds) {
    await upsert("admin.api_dsl", "id", {
      id: id("api_tenant_default", option.apiCode),
      schema_scope: "tenant_default",
      schema_name: null,
      module_code: option.module,
      feature_code: option.feature,
      api_code: option.apiCode,
      api_name: option.apiName,
      api_type: "option",
      dsl_json: JSON.stringify(option.dsl),
      version_no: 1,
      status: "active"
    });
  }
  await ensureDefaultDslVersions();
}

async function ensureDefaultDslVersions() {
  const sources = [
    { table: "admin.page_dsl", targetType: "page", codeCol: "page_code", contentCol: "dsl_json" },
    { table: "admin.api_dsl", targetType: "api", codeCol: "api_code", contentCol: "dsl_json" },
    { table: "admin.action_dsl", targetType: "action", codeCol: "action_code", contentCol: "dsl_json" },
    { table: "admin.skill_registry", targetType: "skill", codeCol: "skill_code", contentCol: "skill_md_content" },
    { table: "admin.import_dsl", targetType: "import", codeCol: "import_code", contentCol: "dsl_json" },
    { table: "admin.business_rule", targetType: "business_rule", codeCol: "rule_code", contentCol: "rule_json" },
    { table: "admin.print_template", targetType: "print_template", codeCol: "template_code", contentCol: "dsl_json" },
  ];
  const items: Array<{ targetType: string; targetCode: string; snapshot: Record<string, unknown> }> = [];
  for (const source of sources) {
    const { rows } = await pool.query(
      `select * from ${source.table} where schema_scope = 'tenant_default' and status = 'active' and deleted = false`
    );
    for (const row of rows) {
      const snapshot = source.targetType === "skill"
        ? { skill_md_content: row[source.contentCol] }
        : source.targetType === "import" || source.targetType === "business_rule" || source.targetType === "print_template"
          ? { resource_json: row[source.contentCol] }
          : { dsl_json: row[source.contentCol] };
      items.push({ targetType: source.targetType, targetCode: row[source.codeCol], snapshot });
    }
  }
  await pool.query(
    `update admin.dsl_version set deleted = true, status = 'archived'
     where schema_scope = 'tenant_default' and target_type <> 'bundle' and deleted = false`
  );
  await upsert("admin.dsl_version", "id", {
    id: id("ver_tenant_default", "bundle_baseline"),
    schema_scope: "tenant_default",
    schema_name: null,
    target_type: "bundle",
    target_code: "baseline_tenant_default",
    module_code: null,
    feature_code: null,
    version_no: 1,
    status: "active",
    change_type: "init",
    change_summary: "模板初始化版本",
    diff_json: JSON.stringify({}),
    snapshot_json: JSON.stringify({ items }),
    created_by_agent: false,
    batch_id: id("ver_tenant_default", "bundle_baseline"),
  });
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
    skill_md_content: skillContentMap[page.feature] ?? `# ${page.name}\n\n通过 page DSL、api DSL 和 action DSL 维护本功能。新增可查询、筛选、排序、统计或报表聚合字段时，必须基于真实表结构生成变更；仅展示或低频扩展字段使用 ext_json。`,
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
      { id: "user_001", name: "张校长", contact: "18800000001", organization_id: "org_001", management_organization_ids: ["org_001"], staff_type: "MANAGER", status: "ACTIVE", psw: passwordHash },
      { id: "user_002", name: "李老师", contact: "18800000002", organization_id: "org_001", management_organization_ids: ["org_001"], staff_type: "TEACHER", status: "ACTIVE", psw: passwordHash },
      { id: "user_003", name: "王学管", contact: "18800000003", organization_id: "org_001", management_organization_ids: ["org_001"], staff_type: "STUDY_MANAGER", status: "ACTIVE", psw: passwordHash },
      { id: "user_004", name: "赵顾问", contact: "18800000004", organization_id: "org_002", management_organization_ids: ["org_002"], staff_type: "SALES", status: "ACTIVE", psw: passwordHash }
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
    ["notice", [{ id: "notice_001", title: "六月教务安排", content: "请各校区完成课消核对。", status: "PUBLISHED" }]],
    ["product_grant", [
      { id: "pg_001", product_id: "prod_001", organization_id: "org_001" },
      { id: "pg_002", product_id: "prod_001", organization_id: "org_002" },
      { id: "pg_003", product_id: "prod_002", organization_id: "org_001" },
      { id: "pg_004", product_id: "prod_003", organization_id: "org_001" },
      { id: "pg_005", product_id: "prod_003", organization_id: "org_003" }
    ]],
    ["product_ref_promotion", [
      { id: "prp_001", product_id: "prod_001", promotion_id: "promo_reduce_300" },
      { id: "prp_002", product_id: "prod_002", promotion_id: "promo_discount_9" }
    ]],
    ["contract_promotion_history", [
      { id: "cph_001", contract_id: "contract_001", promotion_id: "promo_reduce_300", promotion_snapshot_json: JSON.stringify({ name: "报名立减 300", type: "REDUCE", value: 300 }), reduce_amount: 300 }
    ]],
    ["contract_product_promotion_history", [
      { id: "cpph_001", contract_product_id: "cp_001", promotion_id: "promo_reduce_300", promotion_snapshot_json: JSON.stringify({ name: "报名立减 300", type: "REDUCE", value: 300 }), reduce_amount: 300 }
    ]],
    ["money_arrange_log", [
      { id: "arr_001", contract_product_id: "cp_001", arrange_real_hour: 10, arrange_real_amount: 2000, funds_change_history_id: "fund_001", organization_id: "org_001" },
      { id: "arr_002", contract_product_id: "cp_002", arrange_real_hour: 30, arrange_real_amount: 3000, funds_change_history_id: "fund_002", organization_id: "org_001" }
    ]],
    ["promotion_arrange_log", [
      { id: "promo_arr_001", contract_product_id: "cp_001", arrange_promotion_hour: 2, arrange_promotion_amount: 300, funds_change_history_id: "fund_001", organization_id: "org_001" }
    ]],
    ["performance_arrange_log", [
      { id: "perf_001", contract_product_id: "cp_001", funds_change_history_id: "fund_001", performance_type: "SALES", organization_performance_organization_id: "org_001", organization_performance_amount: 2000, personal_performance_user_id: "user_004", personal_performance_amount: 2000, organization_id: "org_001" },
      { id: "perf_002", contract_product_id: "cp_002", funds_change_history_id: "fund_002", performance_type: "SALES", organization_performance_organization_id: "org_001", organization_performance_amount: 3000, personal_performance_user_id: "user_004", personal_performance_amount: 3000, organization_id: "org_001" }
    ]]
  ];

  for (const [table, tableRows] of rows) {
    for (const row of tableRows) {
      await upsert(`"${schema}".${table === "user" ? "\"user\"" : table}`, "id", row);
    }
  }

  const roleDefaults = [
    { prefix: "rr_principal", roleId: "role_001", dataPermission: "all", fieldPermission: {} },
    { prefix: "rr_teacher", roleId: "role_002", dataPermission: "own_courses", fieldPermission: { contact: "hidden" } },
    { prefix: "rr_manager", roleId: "role_003", dataPermission: "own_students", fieldPermission: {} },
    { prefix: "rr_sales", roleId: "role_004", dataPermission: "own_organization", fieldPermission: {} },
  ];
  await pool.query(
    `update "${schema}".role_resource set deleted = true, updated_at = now() where role_id = any($1::text[])`,
    [roleDefaults.map((role) => role.roleId)]
  );
  for (const role of roleDefaults) {
    for (const page of collectPermissionPageSeeds()) {
      await upsert(`"${schema}".role_resource`, "id", {
        id: id(role.prefix, page.pageCode),
        role_id: role.roleId,
        resource_code: page.pageCode,
        resource_type: "page",
        page_code: page.pageCode,
        action_code: null,
        page_permission: "all",
        button_permission: JSON.stringify(page.actionCodes),
        data_permission: role.dataPermission,
        field_permission: JSON.stringify(role.fieldPermission),
        organization_scope: role.dataPermission === "all" ? null : "role_organization",
        deleted: false
      });
    }
  }

  for (const flow of approvalFlows) {
    await upsert(`"${schema}".approval_flow`, "id", {
      id: id("approval", flow.flow_code),
      name: flow.flow_name,
      flow_code: flow.flow_code,
      module_code: flow.module_code,
      status: flow.status,
      config_json: JSON.stringify(flow.config_json),
      organization_id: null
    });
  }
}

export async function seed() {
  await migrate();
  await seedAdmin();
  await seedTenantData();
  try {
    const count = await fillEmptySkillMd("tenant_default");
    console.log(`SKILL.md auto-generated: ${count} records filled`);
  } catch (err) {
    console.warn("SKILL.md auto-generation failed (non-blocking):", err instanceof Error ? err.message : err);
  }
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
