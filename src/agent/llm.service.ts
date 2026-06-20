import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";
import type { LlmCallInput, LlmCallResult, LlmConfig } from "./types.js";

type LlmTraceContext = {
  schemaName: string;
  sessionId?: string;
  userId?: string;
};

const llmTraceStorage = new AsyncLocalStorage<LlmTraceContext>();

export function runWithLlmTraceContext<T>(context: LlmTraceContext, fn: () => Promise<T>): Promise<T> {
  return llmTraceStorage.run(context, fn);
}

export async function loadLlmConfig(schemaName: string): Promise<LlmConfig> {
  const { rows } = await pool.query(
    `select base_url, api_key_cipher, model, temperature, max_context_tokens, supports_tool_calling
     from admin.llm_config
     where status = 'ACTIVE' and deleted = false and (schema_name = $1 or schema_name is null)
     order by schema_name desc nulls last limit 1`,
    [schemaName]
  );
  const row = rows[0];
  if (!row) throw new Error("LLM 配置不存在，请在 llm_config 表中为该租户配置 LLM");

  const apiKey = row.api_key_cipher ? Buffer.from(row.api_key_cipher, "base64").toString() : "";
  if (!row.base_url || !apiKey) throw new Error("LLM 配置不完整，缺少 base_url 或 api_key");

  return {
    baseUrl: row.base_url,
    apiKey,
    model: row.model,
    temperature: Number(row.temperature ?? 0.2),
    maxContextTokens: Number(row.max_context_tokens ?? 256000),
    supportsToolCalling: row.supports_tool_calling !== false,
  };
}

export async function callWithToolCalling(input: LlmCallInput): Promise<LlmCallResult> {
  const config = await loadLlmConfig(input.schemaName);
  const useToolCalling = input.tools && input.tools.length > 0 && config.supportsToolCalling;

  if (useToolCalling) {
    try {
      const result = await rawCall(input.schemaName, config, input.messages, input.tools);
      if (result.functionCall) {
        return { type: "tool_call", functionCall: result.functionCall, tokensUsed: result.tokensUsed };
      }
      if (result.content.trim()) {
        return { type: "text", content: result.content, tokensUsed: result.tokensUsed };
      }
    } catch (err) {
      console.log("[LLM] tool_calling failed, falling back to text mode: %s", err instanceof Error ? err.message : String(err));
    }
  }

  const messages = [...input.messages];
  if (input.fallbackPrompt && messages.length > 0) {
    const last = messages[messages.length - 1];
    messages[messages.length - 1] = { ...last, content: last.content + "\n\n" + input.fallbackPrompt };
  }

  const result = await rawCall(input.schemaName, config, messages);
  return { type: "text", content: result.content, tokensUsed: result.tokensUsed };
}

async function rawCall(
  schemaName: string,
  config: LlmConfig,
  messages: Array<{ role: string; content: string }>,
  tools?: Array<Record<string, unknown>>,
): Promise<{ content: string; functionCall?: { name: string; arguments: string }; tokensUsed?: number }> {
  const start = Date.now();
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    temperature: config.temperature,
  };
  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  console.log("[LLM] request: url=%s model=%s messages_count=%d has_tools=%s",
    `${config.baseUrl}/chat/completions`, config.model, messages.length, !!tools);

  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      console.log("[LLM] request failed: status=%d model=%s response=%s",
        response.status, config.model, errText.substring(0, 500));
      const error = `LLM API error ${response.status}: ${errText.substring(0, 200)}`;
      await logLlmCall({
        schemaName,
        config,
        messages,
        tools,
        status: "error",
        error,
        durationMs: Date.now() - start,
      });
      throw new Error(error);
    }

    const data = await response.json() as {
      choices?: Array<{
        message?: {
          content?: string;
          tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
        };
      }>;
      usage?: { total_tokens?: number };
    };

    const choice = data.choices?.[0]?.message;
    const toolCall = choice?.tool_calls?.[0]?.function;
    const content = choice?.content ?? "";
    const tokensUsed = data.usage?.total_tokens;

    console.log("[LLM] model=%s response_length=%d has_tool_call=%s tokens=%d",
      config.model, content.length, !!toolCall, tokensUsed ?? 0);

    if (toolCall?.name && toolCall?.arguments) {
      const functionCall = { name: toolCall.name, arguments: toolCall.arguments };
      await logLlmCall({
        schemaName,
        config,
        messages,
        tools,
        status: "success",
        responseContent: content,
        functionCall,
        durationMs: Date.now() - start,
        tokensUsed,
      });
      return { content, functionCall, tokensUsed };
    }

    await logLlmCall({
      schemaName,
      config,
      messages,
      tools,
      status: "success",
      responseContent: content,
      durationMs: Date.now() - start,
      tokensUsed,
    });
    return { content, tokensUsed };
  } catch (err) {
    if (!(err instanceof Error && err.message.startsWith("LLM API error"))) {
      await logLlmCall({
        schemaName,
        config,
        messages,
        tools,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      });
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function logLlmCall(input: {
  schemaName: string;
  config: LlmConfig;
  messages: Array<{ role: string; content: string }>;
  tools?: Array<Record<string, unknown>>;
  status: "success" | "error";
  responseContent?: string;
  functionCall?: { name: string; arguments: string };
  error?: string;
  durationMs: number;
  tokensUsed?: number;
}) {
  try {
    const trace = llmTraceStorage.getStore();
    const toolNames = (input.tools ?? [])
      .map((tool) => {
        const fn = tool.function as Record<string, unknown> | undefined;
        return typeof fn?.name === "string" ? fn.name : "";
      })
      .filter(Boolean);
    await pool.query(
      `insert into admin.llm_call_log(
        id, schema_name, session_id, user_id, model, has_tools, tool_names,
        messages_json, response_content, function_call, status, error,
        duration_ms, tokens_used
      ) values($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10::jsonb,$11,$12,$13,$14)`,
      [
        randomUUID(),
        trace?.schemaName ?? input.schemaName,
        trace?.sessionId ?? null,
        trace?.userId ?? null,
        input.config.model,
        Boolean(input.tools?.length),
        JSON.stringify(toolNames),
        JSON.stringify(input.messages),
        input.responseContent ?? null,
        input.functionCall ? JSON.stringify(input.functionCall) : null,
        input.status,
        input.error ?? null,
        input.durationMs,
        input.tokensUsed ?? null,
      ]
    );
  } catch (err) {
    console.warn("[LLM] call log write failed:", err instanceof Error ? err.message : err);
  }
}
