export type LoginResult = {
  token: string;
  user: { kind: "admin" | "tenant"; userId: string; name: string; schemaName?: string };
  permissions?: { pages: string[]; buttons: string[]; dataPermission: string; fieldPermissions: Record<string, Record<string, string>> };
};

const TOKEN_KEY = "llmedu_token";
const USER_KEY = "llmedu_user";
const PERM_KEY = "llmedu_permissions";
const MANAGEMENT_ORG_KEY = "llmedu_management_organization_id";

export function saveAuth(result: LoginResult) {
  localStorage.setItem(TOKEN_KEY, result.token);
  localStorage.setItem(USER_KEY, JSON.stringify(result.user));
  if (result.permissions) localStorage.setItem(PERM_KEY, JSON.stringify(result.permissions));
}

export function clearAuth() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  localStorage.removeItem(PERM_KEY);
  localStorage.removeItem(MANAGEMENT_ORG_KEY);
}

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function getStoredUser(): LoginResult["user"] | null {
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    localStorage.removeItem(USER_KEY);
    return null;
  }
}

export function getStoredPermissions(): LoginResult["permissions"] | null {
  const raw = localStorage.getItem(PERM_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    localStorage.removeItem(PERM_KEY);
    return null;
  }
}

export function getStoredManagementOrganizationId() {
  return localStorage.getItem(MANAGEMENT_ORG_KEY);
}

export function setStoredManagementOrganizationId(id: string) {
  if (id) localStorage.setItem(MANAGEMENT_ORG_KEY, id);
  else localStorage.removeItem(MANAGEMENT_ORG_KEY);
}

async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("Content-Type", "application/json");
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const managementOrganizationId = getStoredManagementOrganizationId();
  if (managementOrganizationId) headers.set("X-Management-Organization-Id", managementOrganizationId);
  const response = await fetch(url, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message ?? data.error ?? "请求失败");
  return data as T;
}

type AgentProgressEvent = {
  stage: string;
  title: string;
  message: string;
  detail?: unknown;
  toolName?: string;
  status?: "running" | "success" | "failed" | "skipped";
  visibleToTenant: boolean;
  createdAt: string;
};

type TenantAgentChatResult = {
  reply: string;
  draftInfo?: { versionId: string; versionNo: number; summary: string };
  sessionId: string;
};

async function streamRequest(
  url: string,
  body: unknown,
  handlers: {
    onProgress?: (event: AgentProgressEvent) => void;
    onSummary?: (summary: string) => void;
    onDelta?: (text: string) => void;
    onDone?: (result: TenantAgentChatResult) => void;
  },
): Promise<TenantAgentChatResult> {
  const headers = new Headers();
  headers.set("Content-Type", "application/json");
  headers.set("Accept", "text/event-stream");
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  if (!response.ok || !response.body) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.message ?? data.error ?? "请求失败");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "message";
  let doneResult: TenantAgentChatResult | null = null;

  const processBlock = (block: string) => {
    const lines = block.split(/\r?\n/);
    let data = "";
    for (const line of lines) {
      if (line.startsWith("event:")) currentEvent = line.slice(6).trim();
      if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (!data) return;
    const parsed = JSON.parse(data);
    if (currentEvent === "progress") handlers.onProgress?.(parsed as AgentProgressEvent);
    if (currentEvent === "delta") handlers.onDelta?.(String((parsed as { text?: string }).text ?? ""));
    if (currentEvent === "summary") handlers.onSummary?.(String((parsed as { summary?: string }).summary ?? ""));
    if (currentEvent === "done") {
      doneResult = parsed as TenantAgentChatResult;
      handlers.onDone?.(doneResult);
    }
    if (currentEvent === "error") throw new Error(String((parsed as { message?: string }).message ?? "请求失败"));
    currentEvent = "message";
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    let idx = buffer.indexOf("\n\n");
    while (idx >= 0) {
      const block = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 2);
      if (block) processBlock(block);
      idx = buffer.indexOf("\n\n");
    }
    if (done) break;
  }
  if (buffer.trim()) processBlock(buffer.trim());
  if (!doneResult) throw new Error("流式响应未返回结果");
  return doneResult;
}

export const GatewayClient = {
  tenants: () => request<{ tenants: Array<{ schema_name: string; name: string; owner_name: string }> }>("/api/public/tenants"),
  adminLogin: (contact: string, password: string) =>
    request<LoginResult>("/api/auth/admin/login", { method: "POST", body: JSON.stringify({ contact, password }) }),
  tenantLogin: (schemaName: string, contact: string, password: string) =>
    request<LoginResult>("/api/auth/tenant/login", { method: "POST", body: JSON.stringify({ schemaName, contact, password }) }),
  logout: () => request<{ success: boolean }>("/api/auth/logout", { method: "POST" }),
  getPermissions: () => request<LoginResult["permissions"]>("/api/auth/permissions"),
  managementOrganizations: (schemaName?: string) =>
    request<{ currentOrganizationId: string | null; organizations: Array<{ id: string; name: string; parent_id?: string | null; organization_type?: string; organization_type_label?: string; status?: string }> }>(
      `/api/auth/management-organizations${schemaName ? `?schemaName=${encodeURIComponent(schemaName)}` : ""}`
    ),
  menu: (scope: "admin" | "tenant", schemaName?: string) =>
    request<{ modules: unknown[] }>(`/api/gateway/menu?scope=${scope}${schemaName ? `&schemaName=${schemaName}` : ""}`),
  page: (scope: "admin" | "tenant", pageCode: string, schemaName?: string) =>
    request<{ page: { page_code: string; page_name: string; dsl_json: unknown; version_no: number } }>(
      `/api/gateway/page?scope=${scope}&pageCode=${pageCode}${schemaName ? `&schemaName=${schemaName}` : ""}`
    ),
  executeApi: (payload: { scope: "admin" | "tenant"; schemaName?: string; pageCode?: string; apiCode: string; params?: Record<string, unknown> }) =>
    request<{ data: unknown }>("/api/gateway/api/execute", { method: "POST", body: JSON.stringify(payload) }),
  executeAction: (payload: { scope: "admin" | "tenant"; schemaName?: string; actionCode: string; params?: Record<string, unknown> }) =>
    request<{ data: unknown }>("/api/gateway/action/execute", { method: "POST", body: JSON.stringify(payload) }),
  versionPublish: (versionId: string) =>
    request<{ id: string; versionNo: number; status: string }>("/api/admin/version/publish", { method: "POST", body: JSON.stringify({ versionId }) }),
  versionRollback: (versionId: string) =>
    request<{ id: string; versionNo: number; status: string }>("/api/admin/version/rollback", { method: "POST", body: JSON.stringify({ versionId }) }),
  versionReject: (versionId: string, reason?: string) =>
    request<{ id: string; status: string }>("/api/admin/version/reject", { method: "POST", body: JSON.stringify({ versionId, reason }) }),
  tenantAgentChat: (schemaName: string, message: string, sessionId?: string, attachmentIds?: string[]) =>
    request<TenantAgentChatResult>("/api/tenant/agent/chat", { method: "POST", body: JSON.stringify({ schemaName, message, sessionId, attachmentIds }) }),
  tenantAgentChatStream: (schemaName: string, message: string, sessionId: string | undefined, attachmentIds: string[] | undefined, handlers: { onProgress?: (event: AgentProgressEvent) => void; onSummary?: (summary: string) => void; onDone?: (result: TenantAgentChatResult) => void }) =>
    streamRequest("/api/tenant/agent/chat/stream", { schemaName, message, sessionId, attachmentIds }, handlers),
  tenantAssistantChatStream: (schemaName: string, message: string, sessionId: string | undefined, attachmentIds: string[] | undefined, handlers: { onProgress?: (event: AgentProgressEvent) => void; onSummary?: (summary: string) => void; onDelta?: (text: string) => void; onDone?: (result: TenantAgentChatResult) => void }) =>
    streamRequest("/api/tenant/assistant/chat/stream", { schemaName, message, sessionId, attachmentIds }, handlers),
  tenantAgentPreview: (schemaName: string, versionId: string) =>
    request<{ previewId: string; previewedAt: string; testSchema: string; previewUrl: string }>("/api/tenant/agent/preview", { method: "POST", body: JSON.stringify({ schemaName, versionId }) }),
  tenantAgentPublish: (schemaName: string, versionId: string) =>
    request<{ published: boolean; versionId: string }>("/api/tenant/agent/publish", { method: "POST", body: JSON.stringify({ schemaName, versionId }) }),
  tenantAgentReject: (schemaName: string, versionId: string, reason?: string) =>
    request<{ id: string; status: string }>("/api/tenant/agent/reject", { method: "POST", body: JSON.stringify({ schemaName, versionId, reason }) }),
  listTenantDrafts: (schemaName: string) =>
    request<{ drafts: Array<{ versionId: string; versionNo: number; summary: string; previewed: boolean }> }>(`/api/tenant/agent/drafts?schemaName=${encodeURIComponent(schemaName)}`),
  getActiveChatSession: (schemaName: string, sessionId?: string) =>
    request<{ sessionId: string; messages: Array<{ role: string; content: string; draftInfo?: { versionId: string; versionNo: number; summary: string; previewed: boolean }; timestamp: string }> }>(
      `/api/tenant/agent/chat/session?schemaName=${encodeURIComponent(schemaName)}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""}`
    ),
  getCustomizationRecordDetail: (id: string) =>
    request<{ record: { id: string; schemaName: string; sessionId: string; recordType?: string; userPrompt?: string; changeSummary: string; skillMd: string; chatTimeline: Array<{ role: string; content: string; dslDiff?: unknown; progressEvents?: unknown; timestamp: string }> } | null }>(`/api/tenant/customization-records/${id}`),
  tenantConfig: () =>
    request<{ agentCustomizationEnabled: boolean }>("/api/tenant/config"),
  getHarnessLog: (sessionId: string) =>
    request<{
      steps: Array<{ step_name: string; display_name?: string; tenant_summary?: string; input_summary: string; output_summary: string; duration_ms: number; llm_tokens_used: number | null; created_at: string }>;
      llmCalls: Array<{
        schema_name: string;
        model: string;
        has_tools: boolean;
        tool_names: string[];
        messages_json: Array<{ role: string; content: string }>;
        response_content: string | null;
        function_call: { name?: string; arguments?: string } | null;
        status: string;
        error: string | null;
        duration_ms: number;
        tokens_used: number | null;
        created_at: string;
      }>;
    }>(`/api/tenant/agent/harness-log?sessionId=${encodeURIComponent(sessionId)}`),
  refreshSkillMd: (schemaName: string, featureCode?: string) =>
    request<{ refreshedCount: number }>("/api/tenant/agent/skill-md", { method: "POST", body: JSON.stringify({ schemaName, featureCode }) }),
  tenantVersionList: (schemaName: string, filters?: { targetType?: string; targetCode?: string; status?: string }) =>
    request<Array<{ id: string; version_no: number; target_type: string; target_code: string; status: string; change_type: string; change_summary: string; created_at: string }>>(`/api/tenant/version/list?schemaName=${encodeURIComponent(schemaName)}${filters?.targetType ? `&targetType=${encodeURIComponent(filters.targetType)}` : ""}${filters?.targetCode ? `&targetCode=${encodeURIComponent(filters.targetCode)}` : ""}${filters?.status ? `&status=${encodeURIComponent(filters.status)}` : ""}`),
  tenantVersionRollbackPreview: (schemaName: string, versionId: string) =>
    request<{ success: boolean; targetType: string; targetCode: string; versionNo: number; previewUrl: string }>("/api/tenant/version/rollback-preview", { method: "POST", body: JSON.stringify({ schemaName, versionId }) }),
  uploadAgentAttachment: (payload: { schemaName: string; sessionId?: string; fileName: string; mimeType: string; contentBase64: string }) =>
    request<{ attachment: { id: string; fileName: string; mimeType: string; fileSize: number; storageUrl: string; contentSummary: Record<string, unknown> } }>("/api/tenant/agent/attachments", { method: "POST", body: JSON.stringify(payload) }),
  executeImport: (payload: { schemaName: string; pageCode: string; apiCode: string; fileName: string; contentBase64: string; fields: Array<Record<string, unknown>>; idResolutionStrategy: "first" | "error"; mode?: "import" | "validate" }) =>
    request<{ mode: "import" | "validate"; total: number; success: number; failed: number; resultFile: { id: string; storageUrl: string; fileName: string } }>("/api/tenant/import/execute", { method: "POST", body: JSON.stringify(payload) }),
  downloadImportTemplate: async (payload: { schemaName: string; title?: string; pageCode?: string; apiCode?: string; fields: Array<Record<string, unknown>> }) => {
    const headers = new Headers();
    headers.set("Content-Type", "application/json");
    const token = getToken();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    const response = await fetch("/api/tenant/import/template", { method: "POST", headers, body: JSON.stringify(payload) });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.message ?? data.error ?? "下载模板失败");
    }
    return response.blob();
  },
  downloadAttachment: async (url: string) => {
    const headers = new Headers();
    const token = getToken();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    const response = await fetch(url, { headers });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.message ?? data.error ?? "下载文件失败");
    }
    return response.blob();
  }
};
