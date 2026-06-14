export type LoginResult = { token: string; user: { kind: "admin" | "tenant"; userId: string; name: string; schemaName?: string } };

const TOKEN_KEY = "llmedu_token";
const USER_KEY = "llmedu_user";

export function saveAuth(result: LoginResult) {
  localStorage.setItem(TOKEN_KEY, result.token);
  localStorage.setItem(USER_KEY, JSON.stringify(result.user));
}

export function clearAuth() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function getStoredUser(): LoginResult["user"] | null {
  const raw = localStorage.getItem(USER_KEY);
  return raw ? JSON.parse(raw) : null;
}

async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("Content-Type", "application/json");
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(url, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message ?? data.error ?? "请求失败");
  return data as T;
}

export const GatewayClient = {
  tenants: () => request<{ tenants: Array<{ schema_name: string; name: string; owner_name: string }> }>("/api/public/tenants"),
  adminLogin: (contact: string, password: string) =>
    request<LoginResult>("/api/auth/admin/login", { method: "POST", body: JSON.stringify({ contact, password }) }),
  tenantLogin: (schemaName: string, contact: string, password: string) =>
    request<LoginResult>("/api/auth/tenant/login", { method: "POST", body: JSON.stringify({ schemaName, contact, password }) }),
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
  agentTask: (schemaName: string, prompt: string) =>
    request<{ task: unknown }>("/api/agent/task", { method: "POST", body: JSON.stringify({ schemaName, prompt }) })
};
