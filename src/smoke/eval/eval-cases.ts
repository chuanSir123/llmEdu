import { HarnessErrorCode } from "../../agent/harness-errors.js";

// 教务 Golden 评测用例（真实调用 LLM 跑 harnessRun）
//
// 与 harness-regression（纯函数）不同：这里验证真实模型输出的质量——
// op 覆盖、护栏通过、收敛轮数、token/缓存命中。每条用例可按规则注册表的
// ruleCodes 打标签，便于定位"哪个教务场景反复触发哪条护栏"。

export type EvalExpect = {
  /** 期望需求规划放行（canProceed）；省略则不校验 */
  canProceed?: boolean;
  /** 期望最终 diff 至少包含这些 op（子集匹配） */
  ops?: string[];
  /** 期望最终 diff 不包含这些 op */
  forbiddenOps?: string[];
  /** 期望某些 diff 涉及这些字段名 */
  mustIncludeFields?: string[];
  /** 期望校验最终通过（无 validation error） */
  guardrailPass?: boolean;
  /** 当 guardrailPass=false 时，期望命中的错误码（用于护栏正确触发的负向用例） */
  expectErrorCodes?: HarnessErrorCode[];
};

export type EvalCase = {
  id: string;
  prompt: string;
  /** 关联 edu-rules 注册表中的规则码 */
  ruleCodes?: string[];
  expect: EvalExpect;
};

export const EVAL_CASES: EvalCase[] = [
  {
    id: "add_display_field_extjson",
    prompt: "在学员列表增加一个“家庭住址”字段，可以在列表显示，也可以在新增和编辑时填写。",
    ruleCodes: ["extjson_first_storage"],
    expect: {
      canProceed: true,
      ops: ["add_column", "add_modal_field"],
      guardrailPass: true,
    },
  },
  {
    id: "add_filterable_physical_field",
    prompt: "给学员列表增加“家长手机号”字段，并且要能按家长手机号筛选搜索。",
    ruleCodes: ["filter_requires_physical_column", "field_type_constraints"],
    expect: {
      canProceed: true,
      ops: ["add_filter", "add_field"],
      guardrailPass: true,
    },
  },
  {
    id: "campus_funds_report",
    prompt: "做一张各校区收款金额汇总报表，按校区统计收款总额。",
    ruleCodes: ["report_real_source_fields", "report_tenant_scope"],
    expect: {
      canProceed: true,
      ops: ["create_report"],
      guardrailPass: true,
    },
  },
  {
    id: "scheduling_conflict_rule",
    prompt: "给排课增加业务规则：同一个老师、同一个学员在同一时间段不能重复排课。",
    ruleCodes: ["scheduling_time_conflict"],
    expect: {
      canProceed: true,
      ops: ["create_business_rule"],
      guardrailPass: true,
    },
  },
  {
    id: "contract_funds_row_action",
    prompt: "在合同列表增加“收款”按钮，点开后可以为该合同登记一笔收款。",
    ruleCodes: ["funds_via_row_action"],
    expect: {
      canProceed: true,
      ops: ["add_row_action"],
      mustIncludeFields: ["transaction_amount"],
      guardrailPass: true,
    },
  },
];
