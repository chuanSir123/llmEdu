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
      api_key_cipher text,
      api_key_masked text,
      model text,
      provider text,
      temperature numeric default 0.2,
      max_tokens int default 4096,
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
    create table if not exists admin.agent_task (
      id text primary key,
      schema_name text,
      user_prompt text not null,
      mode text not null default 'draft',
      status text not null default 'draft',
      result_json jsonb not null default '{}',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      deleted boolean not null default false
    );
    create table if not exists admin.schema_change_request (
      id text primary key,
      schema_name text not null,
      table_name text not null,
      field_name text not null,
      reason text not null,
      status text not null default 'pending',
      request_json jsonb not null default '{}',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      deleted boolean not null default false
    );
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
        staff_type text, status text not null default 'ACTIVE', last_login_time timestamptz, ext_json jsonb not null default '{}',
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
        id text primary key, role_id text not null, page_code text, action_code text, page_permission text not null default 'read',
        button_permission jsonb not null default '[]', data_permission text not null default 'all',
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted boolean not null default false
      );
      create table if not exists "${schema}".login_session (
        id text primary key, user_id text not null, token_hash text, expired_at timestamptz,
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
        id text primary key, student_id text not null, follow_user_id text, follow_type text, follow_content text, next_follow_time timestamptz,
        ext_json jsonb not null default '{}', created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
        created_by text, updated_by text, deleted boolean not null default false
      );
      create table if not exists "${schema}".product (
        id text primary key, name text not null, unit_price numeric default 0, default_course_hour numeric default 0,
        total_amount numeric default 0, product_type text, status text default 'ACTIVE', ext_json jsonb not null default '{}',
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
        change_amount numeric default 0, balance_after numeric default 0, source_funds_id text, contract_id text,
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
        organization_id text, ext_json jsonb default '{}',
        created_at timestamptz default now(), updated_at timestamptz default now(), deleted boolean default false
      );
      create table if not exists "${schema}".refund_record (
        id text primary key, student_id text, contract_product_id text, refund_real_hour numeric default 0, refund_real_amount numeric default 0,
        refund_promotion_amount numeric default 0, refund_promotion_hour numeric default 0, refund_way_config_id text, refund_time timestamptz,
        remark text, ext_json jsonb default '{}', created_at timestamptz default now(), updated_at timestamptz default now(), deleted boolean default false
      );
      create table if not exists "${schema}".mini_class (
        id text primary key, name text not null, organization_id text, teacher_id text, study_manager_id text, capacity int, status text,
        created_at timestamptz default now(), updated_at timestamptz default now(), deleted boolean default false
      );
      create table if not exists "${schema}".one_on_n_group (
        id text primary key, name text not null, organization_id text, teacher_id text, study_manager_id text, capacity int, status text,
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
      create table if not exists "${schema}".notice (
        id text primary key, title text not null, content text, status text default 'PUBLISHED',
        created_at timestamptz default now(), updated_at timestamptz default now(), deleted boolean default false
      );
      create table if not exists "${schema}".report_snapshot (
        id text primary key, report_name text not null, report_type text, snapshot_json jsonb default '{}',
        created_at timestamptz default now(), updated_at timestamptz default now(), deleted boolean default false
      );
    `);
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
