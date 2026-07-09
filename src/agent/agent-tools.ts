import { pool } from "../db/pool.js";
import { callWithToolCalling } from "./llm.service.js";
import { TEMPLATE_SCHEMA } from "../common/template-schema.js";
import type { LlmMessage, LlmToolCall } from "./types.js";

/**
 * AI 定制自检工具集（参考 Claude Code / Codex 的 agentic 工程模式）：
 * 让模型在修复/规划时可以主动查询真实状态（表结构、现有 DSL）、
 * 干跑校验器自查草稿，最后通过终结工具提交结果，而不是一次性盲生成。
 *
 * 工具执行器由调用方注入（如 validate 回调），避免与 validation-repair 循环依赖。
 */

export type AgentToolSpec = {
  definition: {
    type: "function";
    function: { name: string; description: string; parameters: Record<string, unknown> };
  };
  /** 返回值会作为 tool 消息内容回传给模型（建议 JSON 字符串，注意控制体积） */
  execute: (args: Record<string, unknown>) => Promise<string>;
};

const TOOL_RESULT_MAX_CHARS = 8000;

function clampToolResult(text: string): string {
  return text.length > TOOL_RESULT_MAX_CHARS ? `${text.slice(0, TOOL_RESULT_MAX_CHARS)}\n...(截断)` : text;
}

function safeParseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** 查询租户真实表结构（information_schema），支持一次查多张表。 */
export function makeGetTableColumnsTool(schemaName: string): AgentToolSpec {
  return {
    definition: {
      type: "function",
      function: {
        name: "get_table_columns",
        description: "查询租户数据库中真实存在的表结构（列名与类型）。生成或修正 DSL 前，用它确认字段真实存在，不要猜字段名。",
        parameters: {
          type: "object",
          properties: {
            tables: { type: "array", items: { type: "string" }, description: "要查询的物理表名列表（小写下划线）" },
          },
          required: ["tables"],
        },
      },
    },
    execute: async (args) => {
      const tables = Array.isArray(args.tables) ? args.tables.map(String).filter((t) => /^[a-z][a-z0-9_]{0,62}$/.test(t)).slice(0, 10) : [];
      if (tables.length === 0) return JSON.stringify({ error: "tables 参数为空或不合法" });
      const { rows } = await pool.query(
        `select table_name, column_name, data_type from information_schema.columns
         where table_schema = $1 and table_name = any($2)
         order by table_name, ordinal_position`,
        [schemaName, tables]
      );
      const byTable: Record<string, Array<{ column: string; type: string }>> = {};
      for (const row of rows) {
        (byTable[row.table_name] ??= []).push({ column: row.column_name, type: row.data_type });
      }
      const missing = tables.filter((t) => !byTable[t]);
      return clampToolResult(JSON.stringify({ tables: byTable, missingTables: missing }));
    },
  };
}

/** 读取当前生效的 DSL 内容（租户覆盖优先，模板机构兜底）。 */
export function makeGetDslContentTool(schemaName: string): AgentToolSpec {
  const tableMap: Record<string, { table: string; codeCol: string }> = {
    page_dsl: { table: "admin.page_dsl", codeCol: "page_code" },
    api_dsl: { table: "admin.api_dsl", codeCol: "api_code" },
    action_dsl: { table: "admin.action_dsl", codeCol: "action_code" },
    import_dsl: { table: "admin.import_dsl", codeCol: "import_code" },
    report_dsl: { table: "admin.report_dsl", codeCol: "report_code" },
  };
  return {
    definition: {
      type: "function",
      function: {
        name: "get_dsl_content",
        description: "读取某个页面/接口/动作/导入/报表 DSL 当前生效的完整 JSON（租户覆盖优先，模板机构兜底）。修改前先读当前内容，避免破坏已有配置。",
        parameters: {
          type: "object",
          properties: {
            targetType: { type: "string", enum: Object.keys(tableMap), description: "DSL 类型" },
            targetCode: { type: "string", description: "DSL 编码，如 student_list、contract_list.query" },
          },
          required: ["targetType", "targetCode"],
        },
      },
    },
    execute: async (args) => {
      const meta = tableMap[String(args.targetType ?? "")];
      const code = String(args.targetCode ?? "");
      if (!meta || !code) return JSON.stringify({ error: "targetType 或 targetCode 不合法" });
      const { rows } = await pool.query(
        `select dsl_json, schema_name from ${meta.table}
         where ${meta.codeCol} = $1 and status = 'active' and deleted = false
           and ((schema_scope = 'tenant' and schema_name = $2) or (schema_scope = 'tenant' and schema_name = '${TEMPLATE_SCHEMA}'))
         order by case when schema_name = $2 then 0 else 1 end
         limit 1`,
        [code, schemaName]
      );
      if (!rows[0]) return JSON.stringify({ error: `未找到 ${args.targetType}/${code}` });
      return clampToolResult(JSON.stringify({ source: rows[0].schema_name === schemaName ? "tenant" : "template", dsl: rows[0].dsl_json }));
    },
  };
}

/** 干跑校验器：模型先自查草稿再提交，减少无效轮次。validate 回调由调用方注入。 */
export function makeValidateDraftTool(
  validateFn: (diffs: unknown[]) => Promise<{ valid: boolean; errors: string[] }>,
): AgentToolSpec {
  return {
    definition: {
      type: "function",
      function: {
        name: "validate_draft_diffs",
        description: "对一组草稿 diffs 运行完整校验器（不落库），返回校验错误列表。提交前先用它自查，直到没有错误再调用 submit_diffs。",
        parameters: {
          type: "object",
          properties: {
            diffs: { type: "array", items: { type: "object" }, description: "草稿 DSL diffs 数组" },
          },
          required: ["diffs"],
        },
      },
    },
    execute: async (args) => {
      const diffs = Array.isArray(args.diffs) ? args.diffs : [];
      if (diffs.length === 0) return JSON.stringify({ valid: false, errors: ["diffs 为空"] });
      try {
        const result = await validateFn(diffs);
        return clampToolResult(JSON.stringify(result));
      } catch (err) {
        return JSON.stringify({ valid: false, errors: [err instanceof Error ? err.message : String(err)] });
      }
    },
  };
}

export type ToolLoopResult = {
  /** 终结工具的原始 arguments（未终结时为 undefined） */
  finalArguments?: string;
  toolCallsUsed: number;
  tokensUsed: number;
};

/**
 * 多轮工具循环：模型可反复调用自检工具，直到调用终结工具（finalToolName）或耗尽预算。
 * 每轮把 assistant 的 tool_calls 与工具结果按 OpenAI 协议追加回消息序列。
 */
export async function runToolLoop(options: {
  schemaName: string;
  messages: LlmMessage[];
  tools: AgentToolSpec[];
  finalTool: { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } };
  maxToolCalls: number;
  deadlineAt?: number;
}): Promise<ToolLoopResult> {
  const { schemaName, tools, finalTool, maxToolCalls } = options;
  const messages: LlmMessage[] = [...options.messages];
  const executorByName = new Map(tools.map((tool) => [tool.definition.function.name, tool.execute]));
  const toolDefinitions = [...tools.map((tool) => tool.definition), finalTool];
  let toolCallsUsed = 0;
  let tokensUsed = 0;

  while (toolCallsUsed < maxToolCalls) {
    if (options.deadlineAt && Date.now() > options.deadlineAt) break;
    const result = await callWithToolCalling({ schemaName, messages, tools: toolDefinitions });
    tokensUsed += result.tokensUsed ?? 0;
    const calls: LlmToolCall[] = result.functionCalls ?? (result.functionCall ? [{ id: "call_0", ...result.functionCall }] : []);
    if (result.type !== "tool_call" || calls.length === 0) break;

    const finalCall = calls.find((call) => call.name === finalTool.function.name);
    if (finalCall) {
      return { finalArguments: finalCall.arguments, toolCallsUsed, tokensUsed };
    }

    messages.push({
      role: "assistant",
      content: null,
      tool_calls: calls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })),
    });
    for (const call of calls) {
      toolCallsUsed += 1;
      const execute = executorByName.get(call.name);
      const output = execute
        ? await execute(safeParseArgs(call.arguments)).catch((err: unknown) => JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
        : JSON.stringify({ error: `未知工具: ${call.name}` });
      messages.push({ role: "tool", content: output, tool_call_id: call.id });
    }
    messages.push({
      role: "user",
      content: `剩余工具调用预算 ${Math.max(maxToolCalls - toolCallsUsed, 0)} 次。信息足够时请直接调用 ${finalTool.function.name} 提交最终结果。`,
    });
  }
  return { toolCallsUsed, tokensUsed };
}
