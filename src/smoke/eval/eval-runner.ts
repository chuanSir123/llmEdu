import { randomUUID } from "node:crypto";
import { pool } from "../../db/pool.js";
import { harnessRun } from "../../agent/harness-runner.js";
import { classifyFeedback } from "../../agent/harness-errors.js";
import type { DslDiff } from "../../agent/types.js";
import { EVAL_CASES, type EvalCase } from "./eval-cases.js";

// 真实调用 LLM 的教务 Golden 评测。运行前置：
//   1) llm_config 配置真实可用的 base_url + api_key + model
//   2) 已 seed demo 租户（默认 schema=demo_school）
// 运行：npx tsx src/smoke/eval/eval-runner.ts [schemaName]

const SCHEMA = process.argv[2] || process.env.EVAL_SCHEMA || "demo_school";

type CheckResult = { name: string; passed: boolean; detail?: string };

function collectDiffs(result: Awaited<ReturnType<typeof harnessRun>>): DslDiff[] {
  const validation = result.validation.data;
  if (Array.isArray(validation) && validation.length > 0) return validation;
  return Array.isArray(result.planning.data) ? result.planning.data : [];
}

function collectFields(diffs: DslDiff[]): Set<string> {
  const fields = new Set<string>();
  for (const diff of diffs) {
    if (diff.field) fields.add(diff.field);
    const fd = diff.fieldDef ?? {};
    for (const key of ["key", "field"]) {
      const v = (fd as Record<string, unknown>)[key];
      if (typeof v === "string") fields.add(v);
    }
    const rd = diff.resourceDef ?? {};
    const rdFields = (rd as Record<string, unknown>).fields;
    if (Array.isArray(rdFields)) {
      for (const f of rdFields) {
        const k = f && typeof f === "object" ? (f as Record<string, unknown>).key : undefined;
        if (typeof k === "string") fields.add(k);
      }
    }
  }
  return fields;
}

function scoreCase(testCase: EvalCase, result: Awaited<ReturnType<typeof harnessRun>>): CheckResult[] {
  const checks: CheckResult[] = [];
  const diffs = collectDiffs(result);
  const ops = new Set<string>(diffs.map((d) => String(d.op)));
  const fields = collectFields(diffs);
  const validationError = result.validation.error ?? "";
  const expect = testCase.expect;

  if (expect.canProceed !== undefined) {
    checks.push({
      name: `canProceed=${expect.canProceed}`,
      passed: result.requirement.data.canProceed === expect.canProceed,
      detail: `actual=${result.requirement.data.canProceed}`,
    });
  }
  if (expect.ops) {
    for (const op of expect.ops) {
      checks.push({ name: `op:${op}`, passed: ops.has(op), detail: `ops=[${[...ops].join(",")}]` });
    }
  }
  if (expect.forbiddenOps) {
    for (const op of expect.forbiddenOps) {
      checks.push({ name: `!op:${op}`, passed: !ops.has(op) });
    }
  }
  if (expect.mustIncludeFields) {
    for (const field of expect.mustIncludeFields) {
      checks.push({ name: `field:${field}`, passed: fields.has(field), detail: `fields=[${[...fields].join(",")}]` });
    }
  }
  if (expect.guardrailPass !== undefined) {
    const passed = (validationError === "") === expect.guardrailPass;
    checks.push({ name: `guardrailPass=${expect.guardrailPass}`, passed, detail: validationError.slice(0, 200) });
  }
  if (expect.expectErrorCodes && expect.expectErrorCodes.length > 0) {
    const codes = classifyFeedback(validationError);
    for (const code of expect.expectErrorCodes) {
      checks.push({ name: `code:${code}`, passed: codes.includes(code), detail: `codes=[${codes.join(",")}]` });
    }
  }
  return checks;
}

async function llmStats(sessionId: string) {
  const { rows } = await pool.query(
    `select count(*)::int as calls,
            coalesce(sum(tokens_used),0)::int as tokens,
            coalesce(sum(prompt_tokens),0)::int as prompt_tokens,
            coalesce(sum(completion_tokens),0)::int as completion_tokens,
            coalesce(sum(cached_tokens),0)::int as cached_tokens
     from admin.llm_call_log where session_id = $1`,
    [sessionId]
  );
  const { rows: repairRows } = await pool.query(
    `select count(*)::int as planning_steps from admin.agent_harness_step_log
     where session_id = $1 and step_name = 'change_planning'`,
    [sessionId]
  );
  return {
    ...(rows[0] as { calls: number; tokens: number; prompt_tokens: number; completion_tokens: number; cached_tokens: number }),
    repairRounds: Math.max(0, ((repairRows[0]?.planning_steps as number) ?? 0) - 1),
  };
}

async function cleanupDrafts(versionIds: string[]) {
  if (versionIds.length === 0) return;
  await pool.query(`delete from admin.dsl_version where id = any($1) and status = 'draft'`, [versionIds]).catch(() => undefined);
}

async function main() {
  console.log(`\n=== 教务 Golden 评测 (schema=${SCHEMA}, ${EVAL_CASES.length} 用例) ===\n`);
  const report: Array<Record<string, unknown>> = [];
  const draftVersionIds: string[] = [];
  let passedCases = 0;

  for (const testCase of EVAL_CASES) {
    const sessionId = randomUUID();
    const startedAt = Date.now();
    let checks: CheckResult[] = [];
    let error: string | undefined;
    let stats: Awaited<ReturnType<typeof llmStats>> | undefined;
    try {
      const result = await harnessRun({ userMessage: testCase.prompt, schemaName: SCHEMA, sessionId, userId: "eval" });
      for (const item of result.execution.data ?? []) {
        if (item.versionId) draftVersionIds.push(item.versionId);
      }
      checks = scoreCase(testCase, result);
      stats = await llmStats(sessionId);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    const passedChecks = checks.filter((c) => c.passed).length;
    const casePassed = !error && checks.length > 0 && passedChecks === checks.length;
    if (casePassed) passedCases += 1;
    const durationMs = Date.now() - startedAt;

    console.log(`${casePassed ? "PASS" : "FAIL"} [${testCase.id}] ${passedChecks}/${checks.length} checks` +
      (stats ? ` | repairs=${stats.repairRounds} tokens=${stats.tokens} cached=${stats.cached_tokens}` : "") +
      ` | ${durationMs}ms`);
    if (error) console.log(`     error: ${error}`);
    for (const check of checks.filter((c) => !c.passed)) {
      console.log(`     ✗ ${check.name}${check.detail ? ` (${check.detail})` : ""}`);
    }

    report.push({
      id: testCase.id,
      ruleCodes: testCase.ruleCodes ?? [],
      passed: casePassed,
      checks: checks.map((c) => ({ name: c.name, passed: c.passed, detail: c.detail })),
      stats,
      error,
      durationMs,
    });
  }

  await cleanupDrafts(draftVersionIds);

  console.log(`\n=== 结果: ${passedCases}/${EVAL_CASES.length} 用例通过 ===`);
  console.log("\nJSON 报告:\n" + JSON.stringify(report, null, 2));

  await pool.end().catch(() => undefined);
  process.exit(passedCases === EVAL_CASES.length ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
