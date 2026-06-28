import { pool, withClient } from "./pool.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tenantSchemas = ["demo_school", "trial_school"];

async function exec(sql: string) {
  await pool.query(sql);
}

export async function migrate() {
  await exec(`create schema if not exists admin`);
  await exec(`
    create table if not exists admin.tenant_manage (
      id text primary key,
      schema_name text not null unique,
      name text not null,
      status text not null default 'ACTIVE',
      student_limit int default 0,
      organization_limit int default 0,
      staff_limit int default 0,
      pay_type text,
      pay_amount numeric default 0,
      pay_start_time timestamptz,
      expire_time timestamptz,
      contact_phone text,
      contact_email text,
      owner_name text,
      enabled_modules jsonb not null default '[]',
      enabled_features jsonb not null default '[]',
      remark text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      created_by text,
      updated_by text,
      deleted boolean not null default false
    );
    create table if not exists admin.admin_user (
      id text primary key,
      name text not null,
      contact text,
      email text,
      psw text not null,
      status text not null default 'ACTIVE',
      last_login_time timestamptz,
      ext_json jsonb not null default '{}',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      deleted boolean not null default false
    );
    create table if not exists admin.admin_role (
      id text primary key,
      name text not null,
      role_code text not null unique,
      remark text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      deleted boolean not null default false
    );
    create table if not exists admin.admin_user_role (
      id text primary key,
      admin_user_id text not null,
      admin_role_id text not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      deleted boolean not null default false
    );
    create table if not exists admin.llm_config (
      id text primary key,
      config_code text not null unique,
      base_url text,
      api_key text,
      model text,
      provider text,
      temperature numeric default 0.2,
      max_tokens int default 4096,
      max_context_tokens int not null default 256000,
      status text not null default 'ACTIVE',
      source_env_keys jsonb not null default '[]',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      deleted boolean not null default false
    );
    create table if not exists admin.module_registry (
      id text primary key,
      module_code text not null unique,
      module_name text not null,
      module_group text,
      description text,
      default_enabled boolean not null default true,
      sort_no int not null default 0,
      icon text,
      optional_dependency jsonb not null default '[]',
      skill_code text,
      status text not null default 'ACTIVE',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      deleted boolean not null default false
    );
    create table if not exists admin.feature_registry (
      id text primary key,
      module_code text not null,
      feature_code text not null unique,
      feature_name text not null,
      description text,
      page_code text not null,
      default_enabled boolean not null default true,
      sort_no int not null default 0,
      skill_code text,
      status text not null default 'ACTIVE',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      deleted boolean not null default false
    );
    create table if not exists admin.tenant_module_subscription (
      id text primary key,
      tenant_id text not null,
      schema_name text not null,
      module_code text not null,
      enabled boolean not null default true,
      version_no int not null default 1,
      opened_at timestamptz default now(),
      closed_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      deleted boolean not null default false,
      unique(schema_name, module_code)
    );
    create table if not exists admin.tenant_feature_subscription (
      id text primary key,
      tenant_id text not null,
      schema_name text not null,
      module_code text not null,
      feature_code text not null,
      enabled boolean not null default true,
      version_no int not null default 1,
      opened_at timestamptz default now(),
      closed_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      deleted boolean not null default false,
      unique(schema_name, feature_code)
    );
  `);

  await exec(`
    create table if not exists admin.page_dsl (
      id text primary key,
      schema_scope text not null,
      schema_name text,
      module_code text,
      feature_code text,
      page_code text not null,
      page_name text not null,
      page_kind text not null default 'business',
      route_path text,
      dsl_json jsonb not null,
      version_no int not null default 1,
      status text not null default 'active',
      source_version_id text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      created_by text,
      updated_by text,
      deleted boolean not null default false
    );
    create unique index if not exists page_dsl_active_key on admin.page_dsl(schema_scope, coalesce(schema_name,''), page_code) where status = 'active' and deleted = false;
    create table if not exists admin.api_dsl (
      id text primary key,
      schema_scope text not null,
      schema_name text,
      module_code text,
      feature_code text,
      api_code text not null,
      api_name text not null,
      api_type text not null,
      dsl_json jsonb not null,
      version_no int not null default 1,
      status text not null default 'active',
      source_version_id text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      created_by text,
      updated_by text,
      deleted boolean not null default false
    );
    create unique index if not exists api_dsl_active_key on admin.api_dsl(schema_scope, coalesce(schema_name,''), api_code) where status = 'active' and deleted = false;
    create table if not exists admin.action_dsl (
      id text primary key,
      schema_scope text not null,
      schema_name text,
      module_code text,
      feature_code text,
      page_code text not null,
      action_code text not null,
      action_name text not null,
      action_type text not null,
      dsl_json jsonb not null,
      version_no int not null default 1,
      status text not null default 'active',
      source_version_id text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      created_by text,
      updated_by text,
      deleted boolean not null default false
    );
    create table if not exists admin.skill_registry (
      id text primary key,
      schema_scope text not null,
      schema_name text,
      module_code text,
      feature_code text,
      skill_code text not null,
      skill_name text not null,
      skill_md_content text not null,
      version_no int not null default 1,
      status text not null default 'active',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      deleted boolean not null default false
    );
    create table if not exists admin.import_dsl (
      id text primary key,
      schema_scope text not null,
      schema_name text,
      import_code text not null,
      import_name text not null,
      dsl_json jsonb not null,
      version_no int not null default 1,
      status text not null default 'active',
      source_version_id text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      created_by text,
      updated_by text,
      deleted boolean not null default false
    );
    create unique index if not exists import_dsl_active_key on admin.import_dsl(schema_scope, coalesce(schema_name,''), import_code) where status = 'active' and deleted = false;
    create table if not exists admin.report_dsl (
      id text primary key,
      schema_scope text not null,
      schema_name text,
      report_code text not null,
      report_name text not null,
      dsl_json jsonb not null,
      version_no int not null default 1,
      status text not null default 'active',
      source_version_id text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      created_by text,
      updated_by text,
      deleted boolean not null default false
    );
    create unique index if not exists report_dsl_active_key on admin.report_dsl(schema_scope, coalesce(schema_name,''), report_code) where status = 'active' and deleted = false;
    create table if not exists admin.print_template (
      id text primary key,
      schema_scope text not null,
      schema_name text,
      template_code text not null,
      template_name text not null,
      dsl_json jsonb not null,
      version_no int not null default 1,
      status text not null default 'active',
      source_version_id text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      created_by text,
      updated_by text,
      deleted boolean not null default false
    );
    create unique index if not exists print_template_active_key on admin.print_template(schema_scope, coalesce(schema_name,''), template_code) where status = 'active' and deleted = false;
    create table if not exists admin.dsl_version (
      id text primary key,
      schema_scope text not null,
      schema_name text,
      target_type text not null,
      target_code text not null,
      module_code text,
      feature_code text,
      version_no int not null,
      status text not null,
      change_type text,
      change_summary text,
      diff_json jsonb not null default '{}',
      snapshot_json jsonb not null default '{}',
      created_by_agent boolean not null default false,
      created_by_user_id text,
      created_at timestamptz not null default now(),
      published_at timestamptz,
      rollback_from_version_id text,
      deleted boolean not null default false
    );
    alter table admin.dsl_version add column if not exists batch_id text;
    create table if not exists admin.business_rule (
      id text primary key,
      schema_scope text not null,
      schema_name text,
      rule_code text not null,
      rule_name text not null,
      rule_json jsonb not null default '{}',
      version_no int not null default 1,
      status text not null default 'active',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      deleted boolean not null default false
    );
    create unique index if not exists business_rule_active_key on admin.business_rule(schema_scope, coalesce(schema_name,''), rule_code) where status = 'active' and deleted = false;

    create table if not exists admin.wechat_third_platform_app (
      id text primary key, app_name text not null, component_appid text not null unique, component_appsecret text, token text, encoding_aes_key text,
      auth_redirect_domain text, callback_domain text, status text not null default 'ACTIVE', ext_json jsonb not null default '{}',
      created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted boolean not null default false
    );
    create table if not exists admin.public_wechat_account (
      id text primary key, account_name text not null, appid text not null unique, component_appid text, authorizer_appid text, oauth_domain text,
      menu_json jsonb not null default '{}', is_default boolean not null default false, status text not null default 'ACTIVE', ext_json jsonb not null default '{}',
      created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted boolean not null default false
    );
    create table if not exists admin.wechat_pay_order_index (
      out_trade_no text primary key, schema_name text not null, binding_id text not null, mall_order_id text not null,
      order_status text not null default 'CREATED', ext_json jsonb not null default '{}', created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted boolean not null default false
    );
    create index if not exists idx_wechat_pay_order_index_schema on admin.wechat_pay_order_index(schema_name, mall_order_id) where deleted = false;
    create table if not exists admin.audit_log (
      id text primary key,
      schema_name text,
      user_id text,
      page_code text,
      api_code text,
      action_code text,
      input_summary jsonb not null default '{}',
      output_summary jsonb not null default '{}',
      cost_ms int not null default 0,
      error text,
      created_at timestamptz not null default now()
    );
  `);

  for (const schema of tenantSchemas) {

    await exec(`create schema if not exists "${schema}"`);
    await exec(`
      create table if not exists "${schema}".organization (
        id text primary key, name text not null, parent_id text, organization_type text, status text not null default 'ACTIVE',
        ext_json jsonb not null default '{}', created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
        created_by text, updated_by text, deleted boolean not null default false
      );
      create table if not exists "${schema}"."user" (
        id text primary key, name text not null, contact text unique, email text, psw text not null, organization_id text,
        management_organization_ids jsonb not null default '[]', staff_type text, status text not null default 'ACTIVE', last_login_time timestamptz, ext_json jsonb not null default '{}',
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(), created_by text, updated_by text,
        deleted boolean not null default false
      );
      create table if not exists "${schema}".role (
        id text primary key, name text not null, role_code text not null, organization_id text, remark text,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted boolean not null default false
      );
      create table if not exists "${schema}".user_role (
        id text primary key, user_id text not null, role_id text not null,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted boolean not null default false
      );
      create table if not exists "${schema}".role_resource (
        id text primary key, role_id text not null, resource_code text, resource_type text not null default 'page',
        page_code text, action_code text, page_permission text not null default 'read',
        button_permission jsonb not null default '[]', data_permission text not null default 'all',
        field_permission jsonb not null default '{}', organization_scope text,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
        created_by text, updated_by text, deleted boolean not null default false
      );
      create table if not exists "${schema}".login_session (
        id text primary key, user_id text not null, token_hash text, ip text, device_info text,
        login_time timestamptz not null default now(), logout_time timestamptz, expired_at timestamptz,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted boolean not null default false
      );
    `);
    await exec(`
      create table if not exists "${schema}".student (
        id text primary key, name text not null, contact text, organization_id text, student_status text, source_type text,
        study_manager_id text, owner_user_id text, school_name text, grade text, remark text, ext_json jsonb not null default '{}',
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(), created_by text, updated_by text,
        deleted boolean not null default false
      );
      create table if not exists "${schema}".student_followup (
        id text primary key, student_id text not null, lead_stage_id text, follow_user_id text, follow_type text, follow_content text, follow_result text, next_follow_time timestamptz,
        ext_json jsonb not null default '{}', created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
        created_by text, updated_by text, deleted boolean not null default false
      );
      create table if not exists "${schema}".recruit_channel (
        id text primary key, channel_name text not null, channel_type text, owner_user_id text, cost_amount numeric default 0, lead_count int default 0, conversion_count int default 0, roi_amount numeric default 0, status text default 'ACTIVE', remark text,
        ext_json jsonb not null default '{}', created_at timestamptz not null default now(), updated_at timestamptz not null default now(), created_by text, updated_by text, deleted boolean not null default false
      );
      create table if not exists "${schema}".lead_stage_record (
        id text primary key, student_id text not null, stage text default 'NEW', owner_user_id text, channel_id text, next_action text, next_follow_time timestamptz, lost_reason text, status text default 'OPEN', remark text,
        ext_json jsonb not null default '{}', created_at timestamptz not null default now(), updated_at timestamptz not null default now(), created_by text, updated_by text, deleted boolean not null default false
      );
      create table if not exists "${schema}".trial_lesson (
        id text primary key, student_id text not null, course_id text, course_title text not null, trial_time timestamptz, teacher_id text, sales_user_id text, trial_status text default 'SCHEDULED', feedback text, conversion_status text default 'PENDING', remark text,
        ext_json jsonb not null default '{}', created_at timestamptz not null default now(), updated_at timestamptz not null default now(), created_by text, updated_by text, deleted boolean not null default false
      );
      create table if not exists "${schema}".sales_task (
        id text primary key, task_title text not null, student_id text, owner_user_id text, task_type text, due_time timestamptz, complete_time timestamptz, task_status text default 'PENDING', remark text,
        ext_json jsonb not null default '{}', created_at timestamptz not null default now(), updated_at timestamptz not null default now(), created_by text, updated_by text, deleted boolean not null default false
      );
      create table if not exists "${schema}".lead_assignment_history (
        id text primary key, student_id text not null, from_user_id text, to_user_id text, action_type text not null, reason text, operator_id text,
        ext_json jsonb not null default '{}', created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted boolean not null default false
      );
      create table if not exists "${schema}".recruit_channel_cost (
        id text primary key, channel_id text not null, cost_date date not null, cost_amount numeric default 0, cost_type text, remark text,
        ext_json jsonb not null default '{}', created_at timestamptz not null default now(), updated_at timestamptz not null default now(), created_by text, updated_by text, deleted boolean not null default false
      );
      create table if not exists "${schema}".sales_target (
        id text primary key, owner_user_id text not null, target_month text not null, target_leads int default 0, target_trials int default 0, target_contracts int default 0, target_amount numeric default 0, status text default 'ACTIVE', remark text,
        ext_json jsonb not null default '{}', created_at timestamptz not null default now(), updated_at timestamptz not null default now(), created_by text, updated_by text, deleted boolean not null default false
      );
      create table if not exists "${schema}".product (
        id text primary key, name text not null, unit_price numeric default 0, default_course_hour numeric default 0,
        total_amount numeric default 0, product_type text, subject_ids jsonb not null default '[]', grade_ids jsonb not null default '[]', status text default 'ACTIVE', ext_json jsonb not null default '{}',
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(), created_by text, updated_by text,
        deleted boolean not null default false
      );
      create table if not exists "${schema}".product_grant (
        id text primary key, product_id text not null, organization_id text not null,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted boolean not null default false
      );
      create table if not exists "${schema}".promotion (
        id text primary key, name text not null, type text, value numeric default 0, status text default 'ACTIVE', ext_json jsonb default '{}',
        created_at timestamptz default now(), updated_at timestamptz default now(), deleted boolean default false
      );
      create table if not exists "${schema}".product_ref_promotion (
        id text primary key, product_id text not null, promotion_id text not null,
        created_at timestamptz default now(), updated_at timestamptz default now(), deleted boolean default false
      );
      create table if not exists "${schema}".contract (
        id text primary key, student_id text not null, paid_status text, contract_type text, organization_id text, sign_staff_id text,
        sign_time timestamptz, total_amount numeric default 0, paid_amount numeric default 0, promotion_amount numeric default 0,
        contract_status text default 'ACTIVE', ext_json jsonb default '{}', created_at timestamptz default now(), updated_at timestamptz default now(),
        created_by text, updated_by text, deleted boolean default false
      );
      create table if not exists "${schema}".contract_product (
        id text primary key, contract_id text not null, product_id text not null, plan_real_hour numeric default 0, plan_promotion_hour numeric default 0,
        plan_real_amount numeric default 0, plan_promotion_amount numeric default 0, paid_real_hour numeric default 0, paid_promotion_hour numeric default 0,
        paid_real_amount numeric default 0, paid_promotion_amount numeric default 0, consumed_real_hour numeric default 0, consumed_promotion_hour numeric default 0,
        consumed_real_amount numeric default 0, consumed_promotion_amount numeric default 0, remaining_real_hour numeric default 0, remaining_promotion_hour numeric default 0,
        remaining_real_amount numeric default 0, remaining_promotion_amount numeric default 0, ext_json jsonb default '{}', created_at timestamptz default now(),
        updated_at timestamptz default now(), created_by text, updated_by text, deleted boolean default false
      );
      create table if not exists "${schema}".contract_promotion_history (
        id text primary key, contract_id text not null, promotion_id text, promotion_snapshot_json jsonb default '{}',
        reduce_amount numeric default 0, discount_value numeric default 0,
        created_at timestamptz default now(), updated_at timestamptz default now(), deleted boolean default false
      );
      create table if not exists "${schema}".contract_product_promotion_history (
        id text primary key, contract_product_id text not null, promotion_id text, promotion_snapshot_json jsonb default '{}',
        reduce_amount numeric default 0, discount_value numeric default 0,
        created_at timestamptz default now(), updated_at timestamptz default now(), deleted boolean default false
      );
      create table if not exists "${schema}".generic_course (
        id text primary key, course_type text, course_date date, start_time text, end_time text, teacher_id text, study_manager_id text,
        course_status text, organization_id text, mini_class_id text, one_on_n_group_id text, course_title text, course_hour numeric default 0,
        ext_json jsonb default '{}', created_at timestamptz default now(), updated_at timestamptz default now(), deleted boolean default false
      );
      create table if not exists "${schema}".generic_course_student (
        id text primary key, course_id text not null, student_id text not null, attendance_status text, contract_product_id text,
        created_at timestamptz default now(), updated_at timestamptz default now(), deleted boolean default false
      );
      create table if not exists "${schema}".account_charge_records (
        id text primary key, course_id text, charge_type text, charge_hour numeric default 0, charge_amount numeric default 0,
        contract_product_id text, organization_id text, student_id text, charge_status text, reversed_record_id text, ext_json jsonb default '{}',
        created_at timestamptz default now(), updated_at timestamptz default now(), deleted boolean default false
      );
      create table if not exists "${schema}".funds_change_history (
        id text primary key, contract_id text, student_id text, transaction_amount numeric default 0, transaction_time timestamptz,
        pay_way_config_id text, funds_type text, organization_id text, ext_json jsonb default '{}',
        created_at timestamptz default now(), updated_at timestamptz default now(), deleted boolean default false
      );
      create table if not exists "${schema}".student_ele_account (
        id text primary key, student_id text not null unique, balance_amount numeric default 0, frozen_amount numeric default 0,
        status text default 'ACTIVE', ext_json jsonb default '{}',
        created_at timestamptz default now(), updated_at timestamptz default now(), deleted boolean default false
      );
      create table if not exists "${schema}".student_ele_account_record (
        id text primary key, student_id text not null, account_id text not null, change_type text not null,
        change_amount numeric default 0, balance_after numeric default 0, source_funds_id text, source_refund_id text, contract_id text, source_type text, source_id text, operator_id text,
        remark text, ext_json jsonb default '{}',
        created_at timestamptz default now(), updated_at timestamptz default now(), deleted boolean default false
      );
      create table if not exists "${schema}".money_arrange_log (
        id text primary key, contract_product_id text not null, arrange_real_hour numeric default 0, arrange_real_amount numeric default 0,
        funds_change_history_id text, organization_id text, ext_json jsonb default '{}',
        created_at timestamptz default now(), updated_at timestamptz default now(), deleted boolean default false
      );
      create table if not exists "${schema}".promotion_arrange_log (
        id text primary key, contract_product_id text not null, arrange_promotion_hour numeric default 0, arrange_promotion_amount numeric default 0,
        funds_change_history_id text, organization_id text, ext_json jsonb default '{}',
        created_at timestamptz default now(), updated_at timestamptz default now(), deleted boolean default false
      );
      create table if not exists "${schema}".performance_arrange_log (
        id text primary key, contract_product_id text, funds_change_history_id text, performance_type text,
        organization_performance_organization_id text, organization_performance_amount numeric default 0,
        personal_performance_user_id text, personal_performance_amount numeric default 0,
        organization_id text, source_type text, source_id text, adjustment_reason text, ext_json jsonb default '{}',
        created_at timestamptz default now(), updated_at timestamptz default now(), deleted boolean default false
      );
      create table if not exists "${schema}".refund_record (
        id text primary key, student_id text, contract_product_id text, refund_real_hour numeric default 0, refund_real_amount numeric default 0,
        refund_promotion_amount numeric default 0, refund_promotion_hour numeric default 0, refund_way_config_id text, refund_time timestamptz,
        remark text, ext_json jsonb default '{}', created_at timestamptz default now(), updated_at timestamptz default now(), deleted boolean default false
      );
      create table if not exists "${schema}".mini_class (
        id text primary key, name text not null, organization_id text, teacher_id text, study_manager_id text, product_id text, capacity int, status text,
        created_at timestamptz default now(), updated_at timestamptz default now(), deleted boolean default false
      );
      create table if not exists "${schema}".mini_class_student (
        id text primary key, mini_class_id text not null, student_id text not null, join_date date, status text not null default 'ACTIVE',
        ext_json jsonb not null default '{}', created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
        created_by text, updated_by text, deleted boolean not null default false
      );
      create table if not exists "${schema}".one_on_n_group (
        id text primary key, name text not null, organization_id text, teacher_id text, study_manager_id text, product_id text, capacity int, status text,
        created_at timestamptz default now(), updated_at timestamptz default now(), deleted boolean default false
      );
      create table if not exists "${schema}".one_on_n_group_student (
        id text primary key, one_on_n_group_id text not null, student_id text not null, join_date date, status text not null default 'ACTIVE',
        ext_json jsonb not null default '{}', created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
        created_by text, updated_by text, deleted boolean not null default false
      );
      create table if not exists "${schema}".class_student_change_history (
        id text primary key, target_type text not null, target_id text not null, student_id text not null, change_type text not null,
        reason text, ext_json jsonb not null default '{}', created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
        created_by text, updated_by text, deleted boolean not null default false
      );
      create table if not exists "${schema}".course_leave_record (
        id text primary key, course_id text, student_id text not null, leave_type text default 'PERSONAL',
        leave_time timestamptz default now(), leave_reason text, status text default 'APPROVED', organization_id text,
        created_by text, updated_by text, ext_json jsonb not null default '{}',
        created_at timestamptz default now(), updated_at timestamptz default now(), deleted boolean default false
      );
      create table if not exists "${schema}".makeup_course_record (
        id text primary key, original_course_id text, makeup_course_id text, student_id text not null,
        makeup_reason text, status text default 'SCHEDULED', organization_id text,
        created_by text, updated_by text, ext_json jsonb not null default '{}',
        created_at timestamptz default now(), updated_at timestamptz default now(), deleted boolean default false
      );
      create table if not exists "${schema}".course_holiday_calendar (
        id text primary key, name text not null, holiday_date date not null, end_date date, organization_id text,
        holiday_type text default 'CAMPUS_CLOSED', block_course boolean default true, remark text,
        created_by text, updated_by text, ext_json jsonb not null default '{}',
        created_at timestamptz default now(), updated_at timestamptz default now(), deleted boolean default false
      );
      create table if not exists "${schema}".pay_way_config (
        id text primary key, name text not null, pay_way_type text, status text default 'ACTIVE',
        created_at timestamptz default now(), updated_at timestamptz default now(), deleted boolean default false
      );
      create table if not exists "${schema}".ele_account (
        id text primary key, name text not null, account_type text, status text default 'ACTIVE',
        created_at timestamptz default now(), updated_at timestamptz default now(), deleted boolean default false
      );

      create table if not exists "${schema}".wechat_account_binding (
        id text primary key, account_name text not null, appid text, authorizer_appid text, service_type text default 'SERVICE_ACCOUNT', binding_type text not null default 'PUBLIC',
        authorized_status text not null default 'AUTHORIZED', public_account_id text, component_appid text, oauth_domain text, qr_auth_url text, access_token_expires_at timestamptz,
        is_default boolean not null default false, menu_json jsonb not null default '{}', ext_json jsonb not null default '{}',
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted boolean not null default false
      );
      create table if not exists "${schema}".wechat_menu_config (
        id text primary key, binding_id text not null, menu_name text not null, menu_json jsonb not null default '{}', publish_status text not null default 'DRAFT',
        last_published_at timestamptz, ext_json jsonb not null default '{}', created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted boolean not null default false
      );
      create table if not exists "${schema}".wechat_student_fan (
        id text primary key, binding_id text, student_id text not null, openid text not null, unionid text, nickname text, avatar_url text, subscribe_status text default 'SUBSCRIBED',
        bound_at timestamptz default now(), last_login_at timestamptz, ext_json jsonb not null default '{}', created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted boolean not null default false,
        unique(binding_id, openid)
      );
      create table if not exists "${schema}".wechat_oauth_session (
        id text primary key, binding_id text not null, openid text not null, unionid text, nickname text, avatar_url text, state text,
        session_token text not null unique, expires_at timestamptz not null, ext_json jsonb not null default '{}',
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted boolean not null default false
      );
      create table if not exists "${schema}".mall_goods (
        id text primary key, goods_name text not null, product_id text, cover_url text, sale_price numeric default 0, stock_qty int default 0, goods_status text default 'DRAFT', activity_type text default 'NORMAL',
        detail_json jsonb not null default '{}', ext_json jsonb not null default '{}', created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted boolean not null default false
      );
      create table if not exists "${schema}".mall_activity (
        id text primary key, activity_name text not null, activity_type text not null, goods_id text not null, start_time timestamptz, end_time timestamptz, activity_price numeric default 0,
        group_size int default 0, quota_qty int default 0, sold_qty int default 0, status text default 'DRAFT', rule_json jsonb not null default '{}',
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted boolean not null default false
      );
      create table if not exists "${schema}".mall_order (
        id text primary key, order_no text not null unique, student_id text not null, goods_id text not null, activity_id text, openid text, quantity int default 1, original_amount numeric default 0,
        coupon_claim_id text, coupon_discount_amount numeric default 0, pay_amount numeric default 0,
        order_status text default 'CREATED', payment_status text default 'UNPAID', payment_trade_no text, paid_at timestamptz, contract_id text, funds_change_history_id text, callback_payload jsonb not null default '{}',
        ext_json jsonb not null default '{}', created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted boolean not null default false
      );
      create table if not exists "${schema}".mall_group_buy (
        id text primary key, activity_id text not null, goods_id text not null, leader_student_id text not null, group_status text default 'OPEN', group_size int default 2,
        joined_count int default 1, expires_at timestamptz, success_at timestamptz, ext_json jsonb not null default '{}',
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted boolean not null default false
      );
      create table if not exists "${schema}".mall_group_member (
        id text primary key, group_id text not null, order_id text not null, student_id text not null, member_status text default 'JOINED',
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted boolean not null default false
      );
      create table if not exists "${schema}".wechat_push_rule (
        id text primary key, rule_name text not null, business_event text not null, template_id text, receiver_scope text default 'student', rule_json jsonb not null default '{}', status text default 'ACTIVE',
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted boolean not null default false
      );
      create table if not exists "${schema}".wechat_push_log (
        id text primary key, rule_id text, business_event text not null, business_id text, student_id text, openid text, template_id text, payload_json jsonb not null default '{}',
        send_status text default 'PENDING', error_message text, retry_count int default 0, next_retry_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted boolean not null default false
      );
      create table if not exists "${schema}".marketing_event_outbox (
        id text primary key, event_type text not null, business_id text, student_id text, payload_json jsonb not null default '{}',
        event_status text not null default 'PENDING', retry_count int not null default 0, next_retry_at timestamptz default now(), locked_at timestamptz, error_message text,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted boolean not null default false
      );
      create table if not exists "${schema}".coupon_template (
        id text primary key, coupon_name text not null, coupon_type text, discount_amount numeric default 0, discount_rate numeric default 0, valid_from timestamptz, valid_to timestamptz, total_qty int default 0, claimed_qty int default 0, status text default 'ACTIVE', rule_json jsonb not null default '{}',
        ext_json jsonb not null default '{}', created_at timestamptz not null default now(), updated_at timestamptz not null default now(), created_by text, updated_by text, deleted boolean not null default false
      );
      create table if not exists "${schema}".coupon_claim (
        id text primary key, coupon_template_id text not null, student_id text, coupon_code text not null, claim_time timestamptz default now(), use_status text default 'UNUSED', used_order_id text, used_at timestamptz,
        ext_json jsonb not null default '{}', created_at timestamptz not null default now(), updated_at timestamptz not null default now(), created_by text, updated_by text, deleted boolean not null default false
      );
      create table if not exists "${schema}".marketing_landing_page (
        id text primary key, page_title text not null, campaign_id text, channel_id text, form_schema_json jsonb not null default '{}', content_json jsonb not null default '{}', pv_count int default 0, lead_count int default 0, publish_status text default 'DRAFT', published_at timestamptz,
        ext_json jsonb not null default '{}', created_at timestamptz not null default now(), updated_at timestamptz not null default now(), created_by text, updated_by text, deleted boolean not null default false
      );
      create table if not exists "${schema}".referral_reward (
        id text primary key, referrer_student_id text not null, referred_student_id text, reward_type text, reward_amount numeric default 0, reward_status text default 'PENDING', issued_at timestamptz, remark text,
        ext_json jsonb not null default '{}', created_at timestamptz not null default now(), updated_at timestamptz not null default now(), created_by text, updated_by text, deleted boolean not null default false
      );
      create index if not exists idx_wechat_binding_appid on "${schema}".wechat_account_binding(appid) where deleted = false;
      create index if not exists idx_wechat_fan_student on "${schema}".wechat_student_fan(student_id) where deleted = false;
      create index if not exists idx_wechat_oauth_session_token on "${schema}".wechat_oauth_session(session_token) where deleted = false;
      create index if not exists idx_mall_goods_product on "${schema}".mall_goods(product_id) where deleted = false;
      create index if not exists idx_mall_activity_goods_status on "${schema}".mall_activity(goods_id, status, start_time, end_time) where deleted = false;
      create index if not exists idx_mall_order_student_status on "${schema}".mall_order(student_id, order_status, payment_status) where deleted = false;
      create index if not exists idx_mall_order_coupon on "${schema}".mall_order(coupon_claim_id) where deleted = false;
      create index if not exists idx_mall_group_activity_status on "${schema}".mall_group_buy(activity_id, group_status) where deleted = false;
      create index if not exists idx_mall_group_member_group on "${schema}".mall_group_member(group_id, student_id) where deleted = false;
      create index if not exists idx_wechat_push_log_event on "${schema}".wechat_push_log(business_event, business_id) where deleted = false;
      create index if not exists idx_marketing_event_outbox_pending on "${schema}".marketing_event_outbox(event_status, next_retry_at) where deleted = false;
      create index if not exists idx_lead_stage_student on "${schema}".lead_stage_record(student_id, stage) where deleted = false;
      create index if not exists idx_trial_lesson_time on "${schema}".trial_lesson(trial_time, trial_status) where deleted = false;
      create index if not exists idx_sales_task_owner_due on "${schema}".sales_task(owner_user_id, due_time, task_status) where deleted = false;
      create index if not exists idx_lead_assignment_student on "${schema}".lead_assignment_history(student_id, created_at) where deleted = false;
      create index if not exists idx_recruit_channel_cost_channel_date on "${schema}".recruit_channel_cost(channel_id, cost_date) where deleted = false;
      create index if not exists idx_sales_target_owner_month on "${schema}".sales_target(owner_user_id, target_month) where deleted = false;
      create index if not exists idx_coupon_claim_code on "${schema}".coupon_claim(coupon_code) where deleted = false;
      create table if not exists "${schema}".notice (
        id text primary key, title text not null, content text, status text default 'PUBLISHED',
        created_at timestamptz default now(), updated_at timestamptz default now(), deleted boolean default false
      );
      create table if not exists "${schema}".report_snapshot (
        id text primary key, report_name text not null, report_type text, snapshot_json jsonb default '{}',
        created_at timestamptz default now(), updated_at timestamptz default now(), deleted boolean default false
      );
      create table if not exists "${schema}".promotion_history (
        id text primary key, promotion_id text not null, name text not null, type text, value numeric default 0,
        snapshot_json jsonb default '{}', created_at timestamptz default now(), updated_at timestamptz default now(), deleted boolean default false
      );
      create table if not exists "${schema}".approval_flow (
        id text primary key, name text not null, flow_code text not null, module_code text, status text default 'ACTIVE',
        config_json jsonb default '{}', organization_id text,
        created_at timestamptz default now(), updated_at timestamptz default now(), deleted boolean default false
      );
      create table if not exists "${schema}".approval_task (
        id text primary key, flow_id text not null, business_type text, business_id text,
        applicant_user_id text, current_approver_user_id text, status text default 'PENDING',
        form_json jsonb default '{}', organization_id text,
        created_at timestamptz default now(), updated_at timestamptz default now(), deleted boolean default false
      );
      create table if not exists "${schema}".approval_task_log (
        id text primary key, task_id text not null, step_code text, step_name text, action text not null,
        operator_user_id text, comment text, snapshot_json jsonb default '{}',
        created_at timestamptz default now(), updated_at timestamptz default now(), deleted boolean default false
      );
      create table if not exists "${schema}".report_config (
        id text primary key, report_code text not null, report_name text not null, module_code text,
        api_code text, page_code text, config_json jsonb default '{}', status text default 'ACTIVE',
        created_at timestamptz default now(), updated_at timestamptz default now(), deleted boolean default false
      );
    `);

    await exec(`ALTER TABLE IF EXISTS "${schema}".role_resource ADD COLUMN IF NOT EXISTS resource_code text`);
    await exec(`ALTER TABLE IF EXISTS "${schema}".role_resource ADD COLUMN IF NOT EXISTS resource_type text NOT NULL DEFAULT 'page'`);
    await exec(`ALTER TABLE IF EXISTS "${schema}".role_resource ADD COLUMN IF NOT EXISTS field_permission jsonb NOT NULL DEFAULT '{}'`);
    await exec(`ALTER TABLE IF EXISTS "${schema}".role_resource ADD COLUMN IF NOT EXISTS organization_scope text`);
    await exec(`ALTER TABLE IF EXISTS "${schema}".student ADD COLUMN IF NOT EXISTS birthday date`);
    await exec(`ALTER TABLE IF EXISTS "${schema}".student ADD COLUMN IF NOT EXISTS gender text`);
    await exec(`ALTER TABLE IF EXISTS "${schema}".student ADD COLUMN IF NOT EXISTS student_no text`);
    await exec(`ALTER TABLE IF EXISTS "${schema}".organization ADD COLUMN IF NOT EXISTS contact_phone text`);
    await exec(`ALTER TABLE IF EXISTS "${schema}".organization ADD COLUMN IF NOT EXISTS address text`);
    await exec(`ALTER TABLE IF EXISTS "${schema}".organization ADD COLUMN IF NOT EXISTS parent_id text`);
    await exec(`ALTER TABLE IF EXISTS "${schema}"."user" ADD COLUMN IF NOT EXISTS management_organization_ids jsonb NOT NULL DEFAULT '[]'`);
    await exec(`ALTER TABLE IF EXISTS "${schema}"."user" ADD COLUMN IF NOT EXISTS last_login_time timestamptz`);
    await exec(`ALTER TABLE IF EXISTS "${schema}".approval_task ADD COLUMN IF NOT EXISTS current_step_index int NOT NULL DEFAULT 0`);
    await exec(`ALTER TABLE IF EXISTS "${schema}".approval_task ADD COLUMN IF NOT EXISTS approved_at timestamptz`);
    await exec(`ALTER TABLE IF EXISTS "${schema}".approval_task ADD COLUMN IF NOT EXISTS rejected_at timestamptz`);
    await exec(`ALTER TABLE IF EXISTS "${schema}".approval_task ADD COLUMN IF NOT EXISTS canceled_at timestamptz`);
    await exec(`ALTER TABLE IF EXISTS "${schema}".approval_task ADD COLUMN IF NOT EXISTS completed_at timestamptz`);
    await exec(`CREATE INDEX IF NOT EXISTS approval_task_pending_approver_idx ON "${schema}".approval_task(current_approver_user_id, status)`);
    await exec(`CREATE INDEX IF NOT EXISTS approval_task_applicant_idx ON "${schema}".approval_task(applicant_user_id, status)`);
    await exec(`ALTER TABLE IF EXISTS "${schema}".login_session ADD COLUMN IF NOT EXISTS ip text`);
    await exec(`ALTER TABLE IF EXISTS "${schema}".login_session ADD COLUMN IF NOT EXISTS device_info text`);
    await exec(`ALTER TABLE IF EXISTS "${schema}".login_session ADD COLUMN IF NOT EXISTS logout_time timestamptz`);
    await exec(`ALTER TABLE IF EXISTS "${schema}".login_session ADD COLUMN IF NOT EXISTS login_time timestamptz NOT NULL DEFAULT now()`);

    await exec(`ALTER TABLE IF EXISTS "${schema}".product ADD COLUMN IF NOT EXISTS subject_ids jsonb NOT NULL DEFAULT '[]'`);
    await exec(`ALTER TABLE IF EXISTS "${schema}".product ADD COLUMN IF NOT EXISTS grade_ids jsonb NOT NULL DEFAULT '[]'`);
    await exec(`ALTER TABLE IF EXISTS "${schema}".mini_class ADD COLUMN IF NOT EXISTS product_id text`);
    await exec(`ALTER TABLE IF EXISTS "${schema}".mini_class ADD COLUMN IF NOT EXISTS grade text`);
    await exec(`ALTER TABLE IF EXISTS "${schema}".mini_class ADD COLUMN IF NOT EXISTS subject text`);
    await exec(`ALTER TABLE IF EXISTS "${schema}".one_on_n_group ADD COLUMN IF NOT EXISTS product_id text`);
    await exec(`ALTER TABLE IF EXISTS "${schema}".one_on_n_group ADD COLUMN IF NOT EXISTS grade text`);
    await exec(`ALTER TABLE IF EXISTS "${schema}".one_on_n_group ADD COLUMN IF NOT EXISTS subject text`);

    await exec(`CREATE TABLE IF NOT EXISTS "${schema}".class_student_change_history (id text primary key, target_type text not null, target_id text not null, student_id text not null, change_type text not null, reason text, ext_json jsonb not null default '{}', created_at timestamptz not null default now(), updated_at timestamptz not null default now(), created_by text, updated_by text, deleted boolean not null default false)`);
    await exec(`CREATE TABLE IF NOT EXISTS "${schema}".course_leave_record (id text primary key, course_id text, student_id text not null, leave_type text default 'PERSONAL', leave_time timestamptz default now(), leave_reason text, status text default 'APPROVED', organization_id text, created_by text, updated_by text, ext_json jsonb not null default '{}', created_at timestamptz default now(), updated_at timestamptz default now(), deleted boolean default false)`);
    await exec(`CREATE TABLE IF NOT EXISTS "${schema}".makeup_course_record (id text primary key, original_course_id text, makeup_course_id text, student_id text not null, makeup_reason text, status text default 'SCHEDULED', organization_id text, created_by text, updated_by text, ext_json jsonb not null default '{}', created_at timestamptz default now(), updated_at timestamptz default now(), deleted boolean default false)`);
    await exec(`CREATE TABLE IF NOT EXISTS "${schema}".course_holiday_calendar (id text primary key, name text not null, holiday_date date not null, end_date date, organization_id text, holiday_type text default 'CAMPUS_CLOSED', block_course boolean default true, remark text, created_by text, updated_by text, ext_json jsonb not null default '{}', created_at timestamptz default now(), updated_at timestamptz default now(), deleted boolean default false)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_course_leave_course_student ON "${schema}".course_leave_record(course_id, student_id) WHERE deleted = false`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_makeup_course_student ON "${schema}".makeup_course_record(student_id, original_course_id) WHERE deleted = false`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_course_holiday_date_org ON "${schema}".course_holiday_calendar(holiday_date, organization_id) WHERE deleted = false`);

    await exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mini_class_student_unique ON "${schema}".mini_class_student(mini_class_id, student_id) WHERE deleted = false`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_mini_class_student_class ON "${schema}".mini_class_student(mini_class_id) WHERE deleted = false`);
    await exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_one_on_n_group_student_unique ON "${schema}".one_on_n_group_student(one_on_n_group_id, student_id) WHERE deleted = false`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_one_on_n_group_student_group ON "${schema}".one_on_n_group_student(one_on_n_group_id) WHERE deleted = false`);

    await exec(`ALTER TABLE IF EXISTS "${schema}".refund_record ADD COLUMN IF NOT EXISTS contract_id text`);
    await exec(`ALTER TABLE IF EXISTS "${schema}".refund_record ADD COLUMN IF NOT EXISTS refund_type text NOT NULL DEFAULT 'CONTRACT_PRODUCT'`);
    await exec(`ALTER TABLE IF EXISTS "${schema}".refund_record ADD COLUMN IF NOT EXISTS proportion numeric`);

    await exec(`ALTER TABLE IF EXISTS "${schema}".generic_course_student ADD COLUMN IF NOT EXISTS attendance_time timestamptz`);
    await exec(`ALTER TABLE IF EXISTS "${schema}".generic_course_student ADD COLUMN IF NOT EXISTS mini_class_id text`);
    await exec(`ALTER TABLE IF EXISTS "${schema}".generic_course_student ADD COLUMN IF NOT EXISTS one_on_n_group_id text`);

    await exec(`ALTER TABLE IF EXISTS "${schema}".student_ele_account_record ADD COLUMN IF NOT EXISTS source_refund_id text`);
    await exec(`ALTER TABLE IF EXISTS "${schema}".account_charge_records ADD COLUMN IF NOT EXISTS cancel_reason text`);
    await exec(`ALTER TABLE IF EXISTS "${schema}".account_charge_records ADD COLUMN IF NOT EXISTS cancel_user_id text`);
    await exec(`ALTER TABLE IF EXISTS "${schema}".account_charge_records ADD COLUMN IF NOT EXISTS cancel_time timestamptz`);
    await exec(`ALTER TABLE IF EXISTS "${schema}".student_ele_account_record ADD COLUMN IF NOT EXISTS source_type text`);
    await exec(`ALTER TABLE IF EXISTS "${schema}".student_ele_account_record ADD COLUMN IF NOT EXISTS source_id text`);
    await exec(`ALTER TABLE IF EXISTS "${schema}".student_ele_account_record ADD COLUMN IF NOT EXISTS operator_id text`);
    await exec(`ALTER TABLE IF EXISTS "${schema}".contract ADD COLUMN IF NOT EXISTS lock_version int NOT NULL DEFAULT 0`);
    await exec(`ALTER TABLE IF EXISTS "${schema}".contract_product ADD COLUMN IF NOT EXISTS lock_version int NOT NULL DEFAULT 0`);
    await exec(`ALTER TABLE IF EXISTS "${schema}".generic_course ADD COLUMN IF NOT EXISTS lock_version int NOT NULL DEFAULT 0`);
    await exec(`ALTER TABLE IF EXISTS "${schema}".generic_course_student ADD COLUMN IF NOT EXISTS lock_version int NOT NULL DEFAULT 0`);
    await exec(`ALTER TABLE IF EXISTS "${schema}".account_charge_records ADD COLUMN IF NOT EXISTS lock_version int NOT NULL DEFAULT 0`);
    await exec(`ALTER TABLE IF EXISTS "${schema}".refund_record ADD COLUMN IF NOT EXISTS lock_version int NOT NULL DEFAULT 0`);
    await exec(`ALTER TABLE IF EXISTS "${schema}".student_ele_account ADD COLUMN IF NOT EXISTS lock_version int NOT NULL DEFAULT 0`);
    await exec(`CREATE TABLE IF NOT EXISTS "${schema}".wechat_oauth_session (id text primary key, binding_id text not null, openid text not null, unionid text, nickname text, avatar_url text, state text, session_token text not null unique, expires_at timestamptz not null, ext_json jsonb not null default '{}', created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted boolean not null default false)`);
    await exec(`CREATE TABLE IF NOT EXISTS "${schema}".marketing_event_outbox (id text primary key, event_type text not null, business_id text, student_id text, payload_json jsonb not null default '{}', event_status text not null default 'PENDING', retry_count int not null default 0, next_retry_at timestamptz default now(), locked_at timestamptz, error_message text, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted boolean not null default false)`);
    await exec(`ALTER TABLE IF EXISTS "${schema}".mall_order ADD COLUMN IF NOT EXISTS fulfillment_status text NOT NULL DEFAULT 'PENDING'`);
    await exec(`ALTER TABLE IF EXISTS "${schema}".mall_order ADD COLUMN IF NOT EXISTS fulfillment_error text`);
    await exec(`ALTER TABLE IF EXISTS "${schema}".mall_order ADD COLUMN IF NOT EXISTS fulfillment_retry_count int NOT NULL DEFAULT 0`);
    await exec(`ALTER TABLE IF EXISTS "${schema}".mall_order ADD COLUMN IF NOT EXISTS original_amount numeric default 0`);
    await exec(`ALTER TABLE IF EXISTS "${schema}".mall_order ADD COLUMN IF NOT EXISTS coupon_claim_id text`);
    await exec(`ALTER TABLE IF EXISTS "${schema}".mall_order ADD COLUMN IF NOT EXISTS coupon_discount_amount numeric default 0`);
    await exec(`ALTER TABLE IF EXISTS "${schema}".student_followup ADD COLUMN IF NOT EXISTS follow_result text`);
    await exec(`ALTER TABLE IF EXISTS "${schema}".student_followup ADD COLUMN IF NOT EXISTS lead_stage_id text`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_student_followup_lead_stage ON "${schema}".student_followup(lead_stage_id, created_at) WHERE deleted = false`);
    await exec(`ALTER TABLE IF EXISTS "${schema}".trial_lesson ADD COLUMN IF NOT EXISTS course_id text`);
    await exec(`CREATE TABLE IF NOT EXISTS "${schema}".lead_assignment_history (id text primary key, student_id text not null, from_user_id text, to_user_id text, action_type text not null, reason text, operator_id text, ext_json jsonb not null default '{}', created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted boolean not null default false)`);
    await exec(`CREATE TABLE IF NOT EXISTS "${schema}".recruit_channel_cost (id text primary key, channel_id text not null, cost_date date not null, cost_amount numeric default 0, cost_type text, remark text, ext_json jsonb not null default '{}', created_at timestamptz not null default now(), updated_at timestamptz not null default now(), created_by text, updated_by text, deleted boolean not null default false)`);
    await exec(`CREATE TABLE IF NOT EXISTS "${schema}".sales_target (id text primary key, owner_user_id text not null, target_month text not null, target_leads int default 0, target_trials int default 0, target_contracts int default 0, target_amount numeric default 0, status text default 'ACTIVE', remark text, ext_json jsonb not null default '{}', created_at timestamptz not null default now(), updated_at timestamptz not null default now(), created_by text, updated_by text, deleted boolean not null default false)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_marketing_event_outbox_pending ON "${schema}".marketing_event_outbox(event_status, next_retry_at) WHERE deleted = false`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_mall_order_coupon ON "${schema}".mall_order(coupon_claim_id) WHERE deleted = false`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_lead_assignment_student ON "${schema}".lead_assignment_history(student_id, created_at) WHERE deleted = false`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_recruit_channel_cost_channel_date ON "${schema}".recruit_channel_cost(channel_id, cost_date) WHERE deleted = false`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_sales_target_owner_month ON "${schema}".sales_target(owner_user_id, target_month) WHERE deleted = false`);

    await exec(`ALTER TABLE IF EXISTS "${schema}".performance_arrange_log ADD COLUMN IF NOT EXISTS source_type text`);
    await exec(`ALTER TABLE IF EXISTS "${schema}".performance_arrange_log ADD COLUMN IF NOT EXISTS source_id text`);
    await exec(`ALTER TABLE IF EXISTS "${schema}".performance_arrange_log ADD COLUMN IF NOT EXISTS adjustment_reason text`);

  }

  await exec(`
    create table if not exists admin.tenant_agent_config (
      id text primary key,
      schema_name text not null unique,
      agent_customization_enabled boolean not null default false,
      preview_db_config jsonb not null default '{}',
      max_chat_rounds int not null default 20,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      deleted boolean not null default false
    );
    create table if not exists admin.agent_chat_session (
      id text primary key,
      schema_name text not null,
      user_id text not null,
      context jsonb not null default '{}',
      status text not null default 'active',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      deleted boolean not null default false
    );
    create index if not exists idx_chat_session_schema_user on admin.agent_chat_session(schema_name, user_id);
    create table if not exists admin.dsl_version_preview (
      id text primary key,
      version_id text not null,
      schema_name text not null,
      previewed_at timestamptz not null default now(),
      preview_data jsonb not null default '{}',
      created_at timestamptz not null default now()
    );
    create index if not exists idx_version_preview_version on admin.dsl_version_preview(version_id);
    create table if not exists admin.tenant_recharge_record (
      id text primary key,
      schema_name text not null,
      amount numeric not null check (amount > 0),
      expire_time timestamptz not null,
      operator_id text,
      remark text,
      created_at timestamptz not null default now()
    );
    create index if not exists idx_recharge_schema on admin.tenant_recharge_record(schema_name);
    create table if not exists admin.agent_customization_record (
      id text primary key,
      schema_name text not null,
      session_id text not null,
      user_id text not null,
      record_type text not null default 'customization',
      user_prompt text not null default '',
      chat_rounds jsonb not null default '[]',
      skill_md_snapshot text,
      change_summary jsonb not null default '{}',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create index if not exists idx_customization_schema on admin.agent_customization_record(schema_name);
    create index if not exists idx_customization_schema_type on admin.agent_customization_record(schema_name, record_type);
    create unique index if not exists idx_customization_session on admin.agent_customization_record(session_id);
    create table if not exists admin.tenant_dsl_change (
      id text primary key,
      schema_name text not null,
      dsl_type text not null,
      dsl_code text not null,
      change_type text not null default 'modified',
      changed_at timestamptz not null default now(),
      source_version_id text
    );
    create unique index if not exists idx_dsl_change_unique on admin.tenant_dsl_change(schema_name, dsl_type, dsl_code);
  `);

  await exec(`ALTER TABLE IF EXISTS admin.tenant_manage ADD COLUMN IF NOT EXISTS agent_customization_enabled boolean NOT NULL DEFAULT false`);
  await exec(`ALTER TABLE IF EXISTS admin.agent_customization_record ADD COLUMN IF NOT EXISTS record_type text NOT NULL DEFAULT 'customization'`);
  await exec(`ALTER TABLE IF EXISTS admin.agent_customization_record ADD COLUMN IF NOT EXISTS user_prompt text NOT NULL DEFAULT ''`);
  await exec(`CREATE INDEX IF NOT EXISTS idx_customization_schema_type ON admin.agent_customization_record(schema_name, record_type)`);
  await exec(`UPDATE admin.agent_customization_record SET record_type = 'assistant' WHERE change_summary->>'type' = 'assistant'`);
  await exec(`UPDATE admin.agent_customization_record SET user_prompt = coalesce(chat_rounds->0->>'userInput', '') WHERE coalesce(user_prompt, '') = ''`);
  await exec(`DROP TABLE IF EXISTS admin.agent_task`);
  await exec(`DROP TABLE IF EXISTS admin.schema_change_request`);

  await exec(`ALTER TABLE IF EXISTS admin.llm_config ADD COLUMN IF NOT EXISTS schema_name text`);
  await exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_llm_config_schema_code ON admin.llm_config(schema_name, config_code) WHERE schema_name IS NOT NULL`);

  // 去掉 api_key 加密：迁移到明文列，方便直接改库调试
  await exec(`ALTER TABLE IF EXISTS admin.llm_config ADD COLUMN IF NOT EXISTS api_key text`);
  await exec(`
    UPDATE admin.llm_config
    SET api_key = convert_from(decode(api_key_cipher, 'base64'), 'UTF8')
    WHERE (api_key IS NULL OR api_key = '')
      AND coalesce(api_key_cipher, '') <> ''
  `).catch(() => undefined);
  await exec(`ALTER TABLE IF EXISTS admin.llm_config DROP COLUMN IF EXISTS api_key_cipher`);
  await exec(`ALTER TABLE IF EXISTS admin.llm_config DROP COLUMN IF EXISTS api_key_masked`);

  await exec(`
    create table if not exists admin.agent_harness_step_log (
      id text primary key,
      session_id text not null,
      step_name text not null,
      input_summary text,
      output_summary text,
      duration_ms int,
      llm_tokens_used int,
      created_at timestamptz not null default now()
    )
  `);
  await exec(`create index if not exists idx_harness_step_log_session on admin.agent_harness_step_log(session_id)`);
  await exec(`
    create table if not exists admin.llm_call_log (
      id text primary key,
      schema_name text not null,
      session_id text,
      user_id text,
      model text,
      has_tools boolean not null default false,
      tool_names jsonb not null default '[]'::jsonb,
      messages_json jsonb not null default '[]'::jsonb,
      response_content text,
      function_call jsonb,
      status text not null,
      error text,
      duration_ms int,
      tokens_used int,
      created_at timestamptz not null default now()
    )
  `);
  await exec(`create index if not exists idx_llm_call_log_session on admin.llm_call_log(session_id, created_at)`);
  await exec(`create index if not exists idx_llm_call_log_schema_time on admin.llm_call_log(schema_name, created_at)`);
  // token 拆分日志（观测前缀缓存命中率）
  await exec(`ALTER TABLE IF EXISTS admin.llm_call_log ADD COLUMN IF NOT EXISTS prompt_tokens int`);
  await exec(`ALTER TABLE IF EXISTS admin.llm_call_log ADD COLUMN IF NOT EXISTS completion_tokens int`);
  await exec(`ALTER TABLE IF EXISTS admin.llm_call_log ADD COLUMN IF NOT EXISTS cached_tokens int`);
  // 每步错误码（收敛度量）
  await exec(`ALTER TABLE IF EXISTS admin.agent_harness_step_log ADD COLUMN IF NOT EXISTS error_codes jsonb`);
  await exec(`
    create table if not exists admin.agent_attachment (
      id text primary key,
      schema_name text not null,
      user_id text,
      session_id text,
      file_name text not null,
      mime_type text not null,
      file_size int not null default 0,
      storage_provider text not null default 'local',
      storage_url text not null,
      local_path text,
      content_summary jsonb not null default '{}',
      created_at timestamptz not null default now(),
      deleted boolean not null default false
    )
  `);
  await exec(`create index if not exists idx_agent_attachment_schema_session on admin.agent_attachment(schema_name, session_id)`);
  await exec(`ALTER TABLE IF EXISTS admin.llm_config ADD COLUMN IF NOT EXISTS supports_tool_calling boolean NOT NULL DEFAULT true`);
  await exec(`ALTER TABLE IF EXISTS admin.llm_config ADD COLUMN IF NOT EXISTS max_context_tokens int NOT NULL DEFAULT 256000`);
  await exec(`ALTER TABLE IF EXISTS admin.agent_customization_record DROP COLUMN IF EXISTS harness_step_log`);
  await exec(`ALTER TABLE IF EXISTS admin.tenant_agent_config ADD COLUMN IF NOT EXISTS allowed_tools jsonb NOT NULL DEFAULT '[]'::jsonb`);
  await exec(`ALTER TABLE IF EXISTS admin.tenant_agent_config ADD COLUMN IF NOT EXISTS allowed_target_types jsonb NOT NULL DEFAULT '[]'::jsonb`);
  await exec(`ALTER TABLE IF EXISTS admin.tenant_agent_config ADD COLUMN IF NOT EXISTS risk_policy text NOT NULL DEFAULT 'auto'`);
  await exec(`ALTER TABLE IF EXISTS admin.tenant_agent_config ALTER COLUMN risk_policy SET DEFAULT 'auto'`);
  await exec(`ALTER TABLE IF EXISTS admin.tenant_agent_config ADD COLUMN IF NOT EXISTS module_scope jsonb NOT NULL DEFAULT '[]'::jsonb`);
  await exec(`ALTER TABLE IF EXISTS admin.tenant_agent_config ADD COLUMN IF NOT EXISTS field_policy jsonb NOT NULL DEFAULT '{}'::jsonb`);
  await exec(`ALTER TABLE IF EXISTS admin.tenant_agent_config ADD COLUMN IF NOT EXISTS publish_policy jsonb NOT NULL DEFAULT '{}'::jsonb`);
  await exec(`ALTER TABLE IF EXISTS admin.tenant_agent_config ADD COLUMN IF NOT EXISTS data_policy jsonb NOT NULL DEFAULT '{}'::jsonb`);
  await exec(`UPDATE admin.tenant_agent_config SET agent_customization_enabled = false WHERE schema_name LIKE '%\\_test' ESCAPE '\\'`);
  await backfillSubscribedFeatureAccess();
  await syncReportCompanionDsl();
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

function uniqueStrings(values: unknown[]) {
  return [...new Set(values.map((value) => String(value ?? "")).filter(Boolean))];
}

function reportDisplayKey(field: string) {
  if (field === "organization_id") return "organization_name";
  if (field === "student_id") return "student_name";
  if (field === "teacher_id" || field === "study_manager_id" || field === "sign_staff_id" || field === "user_id") return `${field.replace(/_id$/, "")}_name`;
  if (field.endsWith("_id")) return `${field.replace(/_id$/, "")}_name`;
  return undefined;
}

function reportFieldLabel(sourceTable: string, field: string) {
  const labels: Record<string, string> = {
    organization_id: "校区",
    organization_name: "校区",
    student_id: "学员",
    student_name: "学员",
    teacher_id: "老师",
    study_manager_id: "学管师",
    sign_staff_id: "签约人",
    user_id: "用户",
    transaction_amount: sourceTable === "funds_change_history" ? "收款金额" : "交易金额",
    transaction_time: sourceTable === "funds_change_history" ? "收款时间" : "交易时间",
    personal_performance_user_id: "员工",
    personal_performance_user_name: "员工",
    personal_performance_amount: "业绩金额",
    organization_performance_amount: "校区业绩金额",
    organization_performance_organization_id: "校区",
    total_amount: "总金额",
    total_performance_amount: "业绩金额",
    paid_amount: "已收金额",
    remaining_amount: "剩余金额",
    sign_time: "签约时间",
    refund_time: "退费时间",
    course_date: "上课日期",
    attendance_time: "出勤时间",
    created_at: "创建时间",
    course_hour: "课时",
    remaining_hours: "剩余课时",
    id: "数量",
  };
  return labels[field] ?? field;
}

function reportMetricLabel(sourceTable: string, field: string, metric: Record<string, unknown>) {
  if (metric.label) return String(metric.label);
  const type = String(metric.type ?? metric.aggregate ?? "").toLowerCase();
  const base = reportFieldLabel(sourceTable, field);
  if (type === "count") return `${base}数量`;
  if (type === "avg") return `平均${base}`;
  if (type === "min") return `最小${base}`;
  if (type === "max") return `最大${base}`;
  return base;
}

function defaultReportTimeField(sourceTable: string) {
  const fields: Record<string, string> = {
    funds_change_history: "transaction_time",
    refund_record: "refund_time",
    contract: "sign_time",
    generic_course: "course_date",
    generic_course_student: "attendance_time",
    performance_arrange_log: "created_at",
    student_followup: "next_follow_time",
    student: "created_at",
  };
  return fields[sourceTable] ?? "created_at";
}

function normalizeReportFilter(sourceTable: string, value: unknown) {
  if (typeof value === "string") {
    const isTime = value.includes("time") || value.includes("date") || value.endsWith("_at");
    return {
      field: value,
      key: isTime ? `${value}_range` : value,
      label: isTime ? "时间范围" : reportFieldLabel(sourceTable, value),
      type: isTime ? "date_range" : "text",
      op: isTime ? "between" : "ilike",
      placeholder: isTime ? "请选择时间范围" : undefined,
    };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const rawKey = obj.key ?? obj.param;
  const field = String(obj.field ?? obj.sourceField ?? obj.column ?? rawKey ?? "").replace(/_range$/, "").replace(/_filter$/, "");
  if (!field) return null;
  const type = String(obj.type ?? (field.includes("time") || field.includes("date") || field.endsWith("_at") ? "date_range" : "text"));
  const key = rawKey ? String(rawKey) : type === "date_range" ? `${field}_range` : field;
  return {
    field,
    key: key === "time_range" || key === "date_range" ? `${field}_range` : key,
    label: String(obj.label ?? (type === "date_range" ? "时间范围" : reportFieldLabel(sourceTable, field))),
    type,
    op: String(obj.op ?? (type === "date_range" ? "between" : "ilike")),
    placeholder: obj.placeholder ? String(obj.placeholder) : type === "date_range" ? "请选择时间范围" : undefined,
  };
}

function reportFilters(sourceTable: string, rawFilters: unknown) {
  const explicit = asArray(rawFilters).map((item) => normalizeReportFilter(sourceTable, item)).filter((item): item is NonNullable<typeof item> => Boolean(item));
  if (explicit.length > 0) return explicit;
  const field = defaultReportTimeField(sourceTable);
  return [{
    field,
    key: `${field}_range`,
    label: "时间范围",
    type: "date_range",
    op: "between",
    placeholder: "请选择时间范围",
  }];
}

async function syncReportCompanionDsl() {
  const { rows } = await pool.query(
    `select report_code, schema_name, dsl_json
     from admin.report_dsl
     where schema_scope = 'tenant' and status = 'active' and deleted = false`
  );
  for (const row of rows) {
    const report = asObject(row.dsl_json);
    const schemaName = String(row.schema_name ?? "");
    const pageCode = String(report.pageCode ?? row.report_code ?? "");
    const sourceTable = String(report.sourceTable ?? "");
    if (!schemaName || !pageCode || !sourceTable) continue;
    const dimensions = uniqueStrings(asArray(report.dimensions));
    const metrics = asArray<Record<string, unknown>>(report.metrics)
      .map((metric) => ({
        field: String(metric.field ?? ""),
        type: String(metric.type ?? metric.aggregate ?? "count"),
        as: String(metric.as ?? metric.field ?? metric.type ?? "metric"),
        label: metric.label ? String(metric.label) : undefined,
      }))
      .filter((metric) => metric.as && (metric.type === "count" || metric.field));
    const filters = reportFilters(sourceTable, report.filters);
    const rankEnabled = report.rank === true || report.ranking === true || String(report.title ?? "").includes("排行") || String(report.title ?? "").includes("排名");
    const primaryMetricAlias = String(metrics[0]?.as ?? "");
    const desiredColumns = [
      ...(rankEnabled ? [{ key: "rank", title: "排名", label: "排名", type: "number", width: 80 }] : []),
      ...dimensions.map((field) => ({
        key: field,
        title: reportFieldLabel(sourceTable, field),
        label: reportFieldLabel(sourceTable, field),
        type: "text",
        width: 140,
        displayKey: reportDisplayKey(field),
      })),
      ...metrics.map((metric) => {
        const label = reportMetricLabel(sourceTable, metric.field, metric);
        return { key: metric.as, title: label, label, type: "number", width: 140 };
      }),
    ];
    const allowedFields = uniqueStrings([
      ...dimensions,
      ...metrics.map((metric) => metric.field),
      ...metrics.map((metric) => metric.as),
      ...filters.map((filter) => filter.field),
    ]);

    const apiCode = `${pageCode}.query`;
    const { rows: apis } = await pool.query(
      `select dsl_json from admin.api_dsl
       where api_code = $1 and schema_scope = 'tenant' and schema_name = $2 and status = 'active' and deleted = false
       limit 1`,
      [apiCode, schemaName]
    );
    if (apis[0]) {
      const current = asObject(apis[0].dsl_json);
      const next = {
        ...current,
        apiCode,
        apiType: current.apiType ?? "query",
        table: sourceTable,
        operation: "query",
        allowedFields: allowedFields,
        groupBy: dimensions,
        metrics,
        rank: rankEnabled,
        sort: report.sort ?? (primaryMetricAlias ? { field: primaryMetricAlias, direction: "desc" } : current.sort),
        filters: filters.map((filter) => ({
          field: filter.field,
          key: filter.key,
          param: filter.key,
          type: filter.type,
          op: filter.op,
        })),
      };
      await pool.query(
        `update admin.api_dsl set dsl_json = $3::jsonb, updated_at = now()
         where api_code = $1 and schema_scope = 'tenant' and schema_name = $2 and status = 'active' and deleted = false`,
        [apiCode, schemaName, JSON.stringify(next)]
      );
    }

    const { rows: pages } = await pool.query(
      `select dsl_json from admin.page_dsl
       where page_code = $1 and schema_scope = 'tenant' and schema_name = $2 and status = 'active' and deleted = false
       limit 1`,
      [pageCode, schemaName]
    );
    if (!pages[0]) continue;
    const current = asObject(pages[0].dsl_json);
    const table = asObject(current.table);
    const modal = asObject(current.modal);
    const presentation = asObject(current.presentation);
    const header = asObject(presentation.header);
    const next = {
      ...current,
      layout: current.layout === "business" || !current.layout ? "list" : current.layout,
      dataApi: current.dataApi ?? apiCode,
      filters: filters.map((filter) => ({
        key: filter.key,
        field: filter.field,
        label: filter.label,
        type: filter.type,
        placeholder: filter.placeholder,
      })),
      toolbar: asArray(current.toolbar),
      table: {
        ...table,
        columns: desiredColumns,
        rowActions: asArray(table.rowActions),
      },
      modal: {
        ...modal,
        fields: asArray(modal.fields),
      },
      presentation: {
        ...presentation,
        header: {
          ...header,
          metrics: asArray<Record<string, unknown>>(header.metrics).map((metric) => {
            const field = String(metric.field ?? "");
            const metricDef = metrics.find((item) => item.field === field || item.as === field);
            if (!metricDef) return metric;
            return { ...metric, field: metricDef.as, label: reportMetricLabel(sourceTable, metricDef.field, metricDef) };
          }),
        },
      },
    };
    await pool.query(
      `update admin.page_dsl set dsl_json = $3::jsonb, updated_at = now()
       where page_code = $1 and schema_scope = 'tenant' and schema_name = $2 and status = 'active' and deleted = false`,
      [pageCode, schemaName, JSON.stringify(next)]
    );
  }
}

async function backfillSubscribedFeatureAccess() {
  const { rows: tenants } = await pool.query(
    `select schema_name from admin.tenant_manage where status = 'ACTIVE' and deleted = false and schema_name not like '%\\_test' escape '\\'`
  );
  for (const tenant of tenants) {
    const schemaName = String(tenant.schema_name ?? "");
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(schemaName)) continue;
    const { rows: readyRows } = await pool.query(
      `select to_regclass($1) is not null as has_role,
              to_regclass($2) is not null as has_role_resource`,
      [`"${schemaName.replace(/"/g, '""')}".role`, `"${schemaName.replace(/"/g, '""')}".role_resource`]
    );
    if (!readyRows[0]?.has_role || !readyRows[0]?.has_role_resource) continue;
    const schema = `"${schemaName.replace(/"/g, '""')}"`;
    const { rows } = await pool.query(
      `select distinct f.page_code
       from admin.tenant_feature_subscription tfs
       join admin.feature_registry f on f.feature_code = tfs.feature_code and f.deleted = false and f.status = 'ACTIVE'
       where tfs.schema_name = $1 and tfs.enabled = true and tfs.deleted = false`,
      [schemaName]
    );
    const pageCodes = rows.map((row) => String(row.page_code ?? "")).filter((pageCode) => /^[a-z][a-z0-9_]{0,62}$/.test(pageCode));
    const { rows: roles } = await pool.query(`select id, role_code from ${schema}.role where deleted = false`);
    for (const role of roles) {
      const roleId = String(role.id);
      const roleCode = String(role.role_code ?? roleId).toLowerCase();
      for (const pageCode of pageCodes) {
        const resourceId = `rr_ai_${roleCode}_${pageCode}`.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 120);
        await pool.query(
          `insert into ${schema}.role_resource
             (id, role_id, resource_code, resource_type, page_code, action_code, page_permission, button_permission, data_permission, field_permission)
           select $1,$2,$3,'page',$3,null,'read','[]'::jsonb,'self_only','{}'::jsonb
           where not exists (
             select 1 from ${schema}.role_resource
             where role_id = $2 and page_code = $3 and resource_type = 'page' and deleted = false
           )
           on conflict (id) do nothing`,
          [resourceId, roleId, pageCode]
        );
      }
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  migrate()
    .then(() => withClient(async () => undefined))
    .then(() => {
      console.log("Migration complete");
      return pool.end();
    })
    .catch(async (error) => {
      console.error(error);
      await pool.end();
      process.exit(1);
    });
}
