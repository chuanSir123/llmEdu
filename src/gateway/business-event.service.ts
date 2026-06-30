import { executeCommandDsl } from "./command-engine.js";
import { pool } from "../db/pool.js";

type Row = Record<string, unknown>;

const MAX_EVENT_RULE_DEPTH = 5;

export const BUSINESS_COMMAND_EVENT_MAP: Record<string, string> = {
  "contract.create": "contract.created",
  "funds.create": "funds.created",
  "funds.delete": "funds.deleted",
  "chargeRecord.create": "charge.created",
  "chargeRecord.reverse": "charge.deleted",
  "refund.create": "refund.created",
  "refund.delete": "refund.deleted",
  "course.create": "course.created",
  "course.cancel": "course.canceled",
  "attendance.checkIn": "attendance.checked_in",
  "attendance.cancel": "attendance.canceled",
  "holiday.apply": "holiday.applied",
  "approval.approve": "approval.approved",
  "approval.reject": "approval.rejected",
  "approval.cancel": "approval.canceled",
};

export const KNOWN_BUSINESS_COMMANDS = new Set([
  ...Object.keys(BUSINESS_COMMAND_EVENT_MAP),
  "ledger.denyMutation",
  "contract.refund",
  "contract.delete",
  "course.delete",
  "leave.create",
  "makeup.create",
  "classStudent.transfer",
  "class.changeStatus",
  "miniClass.addStudent",
  "miniClass.removeStudent",
  "oneOnNGroup.addStudent",
  "oneOnNGroup.removeStudent",
  "chargeRecord.preview",
  "course.student.save",
  "moneyArrange.save",
  "promotionArrange.save",
  "performanceArrange.save",
  "student.assignManager",
  "product.grant.save",
  "product.promotion.save",
  "approval.submit",
  "role.permission.save",
  "user.create",
  "user.update",
  "user.softDelete",
  "user.resetPassword",
  "audit.list",
  "report.student",
  "report.finance",
  "report.course",
]);

export const BUSINESS_API_EVENT_MAP: Record<string, string> = {
  "contract_list.create": "contract.created",
  "funds_history.create": "funds.created",
  "funds_history.delete": "funds.deleted",
  "funds.delete": "funds.deleted",
  "charge_record.create": "charge.created",
  "chargeRecord.reverse": "charge.deleted",
  "refund_record.create": "refund.created",
  "refund_record.delete": "refund.deleted",
  "refund.delete": "refund.deleted",
  "course_list.create": "course.created",
  "course_list.cancel": "course.canceled",
  "attendance.checkIn": "attendance.checked_in",
  "attendance.cancel": "attendance.canceled",
  "holiday.apply": "holiday.applied",
  "approvalTask.approve": "approval.approved",
  "approvalTask.reject": "approval.rejected",
  "approvalTask.cancel": "approval.canceled",
};

type EventRuleContext = {
  event: string;
  businessId?: unknown;
  payload: Row;
  depth: number;
  visitedRuleCodes: Set<string>;
  visitedEvents: Set<string>;
  userId?: string;
};

function asObject(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}

function asArray(value: unknown): Row[] {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === "object" && !Array.isArray(item)) as Row[] : [];
}

function str(value: unknown, fallback = "") {
  return value === undefined || value === null || value === "" ? fallback : String(value);
}

function readPath(source: Row, path: string): unknown {
  return path.split(".").reduce<unknown>((current, part) => {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    return (current as Row)[part];
  }, source);
}

function resolveTemplate(value: unknown, context: EventRuleContext): unknown {
  if (typeof value !== "string") return value;
  const source = {
    event: {
      type: context.event,
      businessId: context.businessId,
      ...context.payload,
    },
    payload: context.payload,
  };
  if (value.startsWith("payload.")) return readPath(source, value);
  if (value.startsWith("event.")) return readPath(source, value);
  return value;
}

function resolveParams(action: Row, context: EventRuleContext) {
  const params = { ...asObject(action.params) };
  const mapping = asObject(action.paramsMapping ?? action.map ?? action.mapping);
  for (const [key, value] of Object.entries(mapping)) {
    params[key] = resolveTemplate(value, context);
  }
  if (!params.id && context.businessId) params.id = context.businessId;
  return params;
}

function compare(left: unknown, operator: string, right: unknown) {
  if (operator === "!=" || operator === "neq") return left !== right;
  if (operator === "in") return Array.isArray(right) && right.includes(left);
  if (operator === "not_in") return Array.isArray(right) && !right.includes(left);
  if (operator === "exists") return left !== undefined && left !== null && left !== "";
  if ([">", ">=", "<", "<="].includes(operator)) {
    const l = Number(left);
    const r = Number(right);
    if (!Number.isFinite(l) || !Number.isFinite(r)) return false;
    if (operator === ">") return l > r;
    if (operator === ">=") return l >= r;
    if (operator === "<") return l < r;
    return l <= r;
  }
  return left === right;
}

function conditionsMatch(rule: Row, context: EventRuleContext) {
  const conditions = asArray(asObject(rule.trigger).conditions ?? rule.conditions);
  for (const condition of conditions) {
    const field = str(condition.field);
    if (!field) continue;
    const left = readPath(context.payload, field);
    const operator = str(condition.operator ?? condition.op, "=");
    const right = condition.valueFrom ? resolveTemplate(condition.valueFrom, context) : condition.value;
    if (!compare(left, operator, right)) return false;
  }
  return true;
}

async function loadWorkflowRules(schemaName: string, event: string) {
  const { rows } = await pool.query(
    `select rule_code, rule_json
     from admin.business_rule
     where status = 'active' and deleted = false
       and ((schema_scope = 'tenant' and schema_name = $1) or schema_scope = 'tenant_default')
       and coalesce(rule_json->>'category', '') = 'workflow'
       and rule_json->'trigger'->>'event' = $2
     order by case when schema_scope = 'tenant' then 0 else 1 end, created_at`,
    [schemaName, event]
  );
  return rows.map((row) => ({ ruleCode: str(row.rule_code), rule: asObject(row.rule_json) }));
}

export async function processBusinessEventRules(
  schemaName: string,
  event: string,
  businessId: unknown,
  payload: Row = {},
  options: { userId?: string; depth?: number; visitedRuleCodes?: string[]; visitedEvents?: string[] } = {},
) {
  const context: EventRuleContext = {
    event,
    businessId,
    payload,
    depth: options.depth ?? 0,
    visitedRuleCodes: new Set(options.visitedRuleCodes ?? []),
    visitedEvents: new Set(options.visitedEvents ?? []),
    userId: options.userId,
  };
  if (context.depth >= MAX_EVENT_RULE_DEPTH || context.visitedEvents.has(event)) {
    return { event, skipped: true, reason: "event_rule_cycle_guard", executedActions: [] };
  }
  context.visitedEvents.add(event);

  const executedActions: Array<{ ruleCode: string; command: string; status: string; nextEvent?: string }> = [];
  const rules = await loadWorkflowRules(schemaName, event);
  for (const { ruleCode, rule } of rules) {
    if (context.visitedRuleCodes.has(ruleCode) || !conditionsMatch(rule, context)) continue;
    context.visitedRuleCodes.add(ruleCode);

    for (const action of asArray(rule.actions)) {
      const type = str(action.type, "execute_command");
      const command = str(action.command);
      if (type !== "execute_command" || !command) continue;
      const params: Row = {
        ...resolveParams(action, context),
        __userId: context.userId,
        __eventRule: {
          ruleCode,
          sourceEvent: event,
          depth: context.depth,
        },
      };
      const ruleCodeForCommand = str(action.ruleCode ?? action.businessRuleCode, ruleCode);
      await executeCommandDsl(schemaName, { operation: "command", command, ruleCode: ruleCodeForCommand } as never, params);
      const nextEvent = BUSINESS_COMMAND_EVENT_MAP[command];
      executedActions.push({ ruleCode, command, status: "executed", nextEvent });
      if (nextEvent) {
        if (context.visitedEvents.has(nextEvent)) {
          executedActions.push({ ruleCode, command, status: "cycle_guard_skipped", nextEvent });
          continue;
        }
        await processBusinessEventRules(schemaName, nextEvent, params.id ?? businessId, params, {
          userId: context.userId,
          depth: context.depth + 1,
          visitedRuleCodes: [...context.visitedRuleCodes],
          visitedEvents: [...context.visitedEvents],
        });
      }
    }
  }

  return { event, executedActions };
}
