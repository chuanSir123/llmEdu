import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";
import type { LlmCallInput, LlmCallResult, LlmConfig, LlmMessage, LlmToolCall } from "./types.js";

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
    `select base_url, api_key, model, temperature, max_tokens, max_context_tokens, supports_tool_calling
     from admin.llm_config
     where status = 'ACTIVE' and deleted = false and (schema_name = $1 or schema_name is null)
     order by schema_name desc nulls last limit 1`,
    [schemaName]
  );
  const row = rows[0];
  if (!row) throw new Error("LLM 配置不存在，请在 llm_config 表中为该租户配置 LLM");

  const apiKey = row.api_key ?? "";
  if (!row.base_url || !apiKey) throw new Error("LLM 配置不完整，缺少 base_url 或 api_key");

  return {
    baseUrl: row.base_url,
    apiKey,
    model: row.model,
    temperature: Number(row.temperature ?? 0.2),
    maxTokens: Number(row.max_tokens ?? 0),
    maxContextTokens: Number(row.max_context_tokens ?? 256000),
    supportsToolCalling: row.supports_tool_calling !== false,
  };
}

export async function callWithToolCalling(input: LlmCallInput): Promise<LlmCallResult> {
  const config = await loadLlmConfig(input.schemaName);
  const useToolCalling = input.tools && input.tools.length > 0 && config.supportsToolCalling;

  if (useToolCalling) {
    try {
      const result = await rawCall(input.schemaName, config, input.messages, input.tools, input.onDelta);
      if (result.functionCall) {
        return { type: "tool_call", functionCall: result.functionCall, functionCalls: result.functionCalls, tokensUsed: result.tokensUsed };
      }
      if (result.content.trim()) {
        return { type: "text", content: result.content, tokensUsed: result.tokensUsed };
      }
    } catch (err) {
      console.log("[LLM] tool_calling failed, falling back to text mode: %s", err instanceof Error ? err.message : String(err));
    }
  }

  const messages: LlmMessage[] = [...input.messages];
  if (input.fallbackPrompt && messages.length > 0) {
    const last = messages[messages.length - 1];
    messages[messages.length - 1] = { ...last, content: (last.content ?? "") + "\n\n" + input.fallbackPrompt };
  }

  const result = await rawCall(input.schemaName, config, messages, undefined, input.onDelta);
  return { type: "text", content: result.content, tokensUsed: result.tokensUsed };
}

type RawCallResult = {
  content: string;
  functionCall?: { name: string; arguments: string };
  functionCalls?: LlmToolCall[];
  tokensUsed?: number;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
};

type RetrySignal = { __retry: true; delayMs?: number };

function isRetry(value: RawCallResult | RetrySignal): value is RetrySignal {
  return (value as RetrySignal).__retry === true;
}

async function rawCall(
  schemaName: string,
  config: LlmConfig,
  messages: LlmMessage[],
  tools?: Array<Record<string, unknown>>,
  onDelta?: (text: string) => void,
): Promise<RawCallResult> {
  const maxRetries = 3;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await rawCallOnce(schemaName, config, messages, tools, onDelta);
    if (!isRetry(result)) return result;
    if (attempt < maxRetries) {
      const backoff = 2000 * (attempt + 1);
      const delay = Math.max(backoff, result.delayMs ?? 0);
      console.log("[LLM] retrying in %dms (attempt %d/%d)", delay, attempt + 1, maxRetries);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error(`LLM API error: failed after ${maxRetries + 1} attempts`);
}

type LlmUsage = {
  total_tokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  cached_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
};

// 解析 OpenAI 兼容的 SSE 流：累积文本与全部并行工具调用（按 index 聚合分片），文本增量实时回调 onDelta
async function consumeSseStream(
  response: Response,
  onDelta: (text: string) => void,
): Promise<{ content: string; functionCalls: LlmToolCall[]; usage?: LlmUsage }> {
  const body = response.body;
  if (!body) return { content: "", functionCalls: [] };
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  const toolsByIndex = new Map<number, { id: string; name: string; arguments: string }>();
  let usage: LlmUsage | undefined;

  const handleData = (data: string) => {
    if (data === "[DONE]") return;
    let json: {
      choices?: Array<{ delta?: { content?: string; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> } }>;
      usage?: LlmUsage;
    };
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    const delta = json.choices?.[0]?.delta;
    if (delta?.content) {
      content += delta.content;
      onDelta(delta.content);
    }
    for (const tc of delta?.tool_calls ?? []) {
      const index = tc.index ?? 0;
      const entry = toolsByIndex.get(index) ?? { id: "", name: "", arguments: "" };
      if (tc.id) entry.id = tc.id;
      if (tc.function?.name) entry.name += tc.function.name;
      if (tc.function?.arguments) entry.arguments += tc.function.arguments;
      toolsByIndex.set(index, entry);
    }
    if (json.usage) usage = json.usage;
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      handleData(trimmed.slice(5).trim());
    }
  }
  const tail = buffer.trim();
  if (tail.startsWith("data:")) handleData(tail.slice(5).trim());

  const functionCalls: LlmToolCall[] = [...toolsByIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, entry]) => ({ id: entry.id || `call_${index}`, name: entry.name, arguments: entry.arguments }))
    .filter((tc) => tc.name);
  return { content, functionCalls, usage };
}

// 解析 Retry-After 头：整数秒或 HTTP-date
function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

async function rawCallOnce(
  schemaName: string,
  config: LlmConfig,
  messages: LlmMessage[],
  tools?: Array<Record<string, unknown>>,
  onDelta?: (text: string) => void,
): Promise<RawCallResult | RetrySignal> {
  const start = Date.now();
  const streaming = typeof onDelta === "function";
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    temperature: config.temperature,
  };
  if (config.maxTokens > 0) body.max_tokens = config.maxTokens;
  if (streaming) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }
  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);

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
      const retryable = (response.status >= 500 && response.status !== 501) || response.status === 429;
      if (retryable) return { __retry: true, delayMs: parseRetryAfterMs(response.headers.get("retry-after")) };
      throw new Error(error);
    }

    let content = "";
    let functionCalls: LlmToolCall[] = [];
    let usage: LlmUsage | undefined;

    if (streaming) {
      const streamed = await consumeSseStream(response, onDelta!);
      content = streamed.content;
      functionCalls = streamed.functionCalls;
      usage = streamed.usage;
    } else {
      const data = await response.json() as {
        choices?: Array<{
          message?: {
            content?: string;
            tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
          };
        }>;
        usage?: LlmUsage;
      };
      const choice = data.choices?.[0]?.message;
      content = choice?.content ?? "";
      functionCalls = (choice?.tool_calls ?? [])
        .map((tc, index) => ({ id: tc.id || `call_${index}`, name: tc.function?.name ?? "", arguments: tc.function?.arguments ?? "" }))
        .filter((tc) => tc.name);
      usage = data.usage;
    }

    const functionCall = functionCalls[0] ? { name: functionCalls[0].name, arguments: functionCalls[0].arguments } : undefined;
    const tokensUsed = usage?.total_tokens;
    const promptTokens = usage?.prompt_tokens;
    const completionTokens = usage?.completion_tokens;
    const cachedTokens = usage?.prompt_tokens_details?.cached_tokens ?? usage?.cached_tokens;

    console.log("[LLM] model=%s response_length=%d tool_calls=%d tokens=%d cached=%d stream=%s",
      config.model, content.length, functionCalls.length, tokensUsed ?? 0, cachedTokens ?? 0, streaming);

    const tokenLog = { tokensUsed, promptTokens, completionTokens, cachedTokens };

    await logLlmCall({
      schemaName,
      config,
      messages,
      tools,
      status: "success",
      responseContent: content,
      functionCall,
      durationMs: Date.now() - start,
      ...tokenLog,
    });
    return { content, functionCall, functionCalls, ...tokenLog };
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
  messages: LlmMessage[];
  tools?: Array<Record<string, unknown>>;
  status: "success" | "error";
  responseContent?: string;
  functionCall?: { name: string; arguments: string };
  error?: string;
  durationMs: number;
  tokensUsed?: number;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
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
        duration_ms, tokens_used, prompt_tokens, completion_tokens, cached_tokens
      ) values($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10::jsonb,$11,$12,$13,$14,$15,$16,$17)`,
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
        input.promptTokens ?? null,
        input.completionTokens ?? null,
        input.cachedTokens ?? null,
      ]
    );
  } catch (err) {
    console.warn("[LLM] call log write failed:", err instanceof Error ? err.message : err);
  }
}
