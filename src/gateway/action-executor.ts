import { pool } from "../db/pool.js";
import { executeGatewayApi } from "./api-executor.js";
import { visibleActionCodes } from "../permission/permission.service.js";
import type { SessionUser } from "../types.js";

type ActionDslRow = {
  actionCode: string;
  actionName: string;
  actionType: "open_page" | "execute_api" | "open_modal" | "dropdown" | "input" | "display" | "tab" | "export" | "import";
  modalCode?: string;
  apiCode?: string;
  afterSuccess?: Array<{ type: "toast" | "redirect" | "refreshPage"; message?: string; to?: string }>;
  visibleWhen?: { always?: boolean; permission?: string };
  enabledWhen?: { always?: boolean; permission?: string };
  renderAs?: string;
  styleToken?: string;
  defaultParams?: Record<string, unknown>;
  subActions?: Array<{ actionCode: string; label: string }>;
  targetPageCode?: string;
  targetTab?: string;
  importConfig?: Record<string, unknown>;
  confirm?: boolean;
};

type ActionResult = {
  actionType: string;
  targetPageCode?: string;
  targetTab?: string;
  modalDsl?: unknown;
  disabled?: boolean;
  subActions?: Array<{ actionCode: string; label: string }>;
  data?: unknown;
  afterSuccess?: ActionDslRow["afterSuccess"];
  importConfig?: Record<string, unknown>;
};

async function loadActionDsl(scope: "admin" | "tenant", actionCode: string, schemaName?: string): Promise<ActionDslRow> {
  const { rows } = await pool.query(
    `select dsl_json from admin.action_dsl
     where action_code = $1 and status = 'active' and deleted = false
       and ((schema_scope = $2 and coalesce(schema_name,'') = coalesce($3,''))
         or (schema_scope = 'tenant_default' and $2 = 'tenant'))
     order by case when schema_scope = $2 then 0 else 1 end
     limit 1`,
    [actionCode, scope, schemaName ?? null]
  );
  if (!rows[0]) throw Object.assign(new Error("Action DSL 不存在: " + actionCode), { statusCode: 404 });
  return rows[0].dsl_json as ActionDslRow;
}

async function loadModalDsl(scope: "admin" | "tenant", modalCode: string, schemaName?: string) {
  const { rows } = await pool.query(
    `select dsl_json from admin.action_dsl
     where action_code = $1 and action_type = 'modal' and status = 'active' and deleted = false
       and ((schema_scope = $2 and coalesce(schema_name,'') = coalesce($3,''))
         or (schema_scope = 'tenant_default' and $2 = 'tenant'))
     order by case when schema_scope = $2 then 0 else 1 end
     limit 1`,
    [modalCode, scope, schemaName ?? null]
  );
  if (!rows[0]) throw Object.assign(new Error("Modal DSL 不存在: " + modalCode), { statusCode: 500 });
  return rows[0].dsl_json;
}

async function checkVisibleWhen(visibleWhen: ActionDslRow["visibleWhen"], user: SessionUser | undefined, schemaName: string): Promise<boolean> {
  if (!visibleWhen || visibleWhen.always === true) return true;
  if (visibleWhen.permission && user && user.kind !== "admin") {
    const codes = await visibleActionCodes(user, schemaName, "");
    if (!codes.has(visibleWhen.permission) && !codes.has("*")) return false;
  }
  return true;
}

async function checkEnabledWhen(enabledWhen: ActionDslRow["enabledWhen"], user: SessionUser | undefined, schemaName: string): Promise<boolean> {
  if (!enabledWhen || enabledWhen.always === true) return true;
  if (enabledWhen.permission && user && user.kind !== "admin") {
    const codes = await visibleActionCodes(user, schemaName, "");
    if (!codes.has(enabledWhen.permission) && !codes.has("*")) return false;
  }
  return true;
}

export async function executeAction(scope: "admin" | "tenant", schemaName: string, actionCode: string, params: Record<string, unknown>, user?: SessionUser) {
  const dsl = await loadActionDsl(scope, actionCode, scope === "tenant" ? schemaName : undefined);

  const visible = await checkVisibleWhen(dsl.visibleWhen, user, schemaName);
  if (!visible) throw Object.assign(new Error("无操作权限: " + actionCode), { statusCode: 403 });

  const enabled = await checkEnabledWhen(dsl.enabledWhen, user, schemaName);

  const result: ActionResult = { actionType: dsl.actionType, disabled: !enabled };

  switch (dsl.actionType) {
    case "open_page":
      result.targetPageCode = dsl.targetPageCode;
      result.afterSuccess = dsl.afterSuccess;
      break;
    case "open_modal": {
      if (dsl.modalCode) {
        result.modalDsl = await loadModalDsl(scope, dsl.modalCode, scope === "tenant" ? schemaName : undefined);
      }
      result.afterSuccess = dsl.afterSuccess;
      break;
    }
    case "dropdown":
      result.subActions = dsl.subActions;
      break;
    case "execute_api":
    case "input": {
      const apiCode = dsl.apiCode ?? actionCode;
      const mergedParams = { ...dsl.defaultParams, ...params };
      result.data = await executeGatewayApi(scope, schemaName, apiCode, mergedParams, user);
      result.afterSuccess = dsl.afterSuccess;
      break;
    }
    case "display":
      break;
    case "tab":
      result.targetTab = dsl.targetTab;
      break;
    case "export": {
      const apiCode = dsl.apiCode ?? actionCode;
      result.data = await executeGatewayApi(scope, schemaName, apiCode, params, user);
      result.afterSuccess = dsl.afterSuccess;
      break;
    }
    case "import":
      result.importConfig = dsl.importConfig;
      break;
  }

  return result;
}
