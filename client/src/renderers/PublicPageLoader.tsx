import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { GatewayClient } from "../api/GatewayClient";
import { useAuth } from "../context/AuthContext";
import { token } from "../styles/designTokens";

export function TenantSelectPage() {
  const navigate = useNavigate();
  const [tenants, setTenants] = useState<Array<{ schema_name: string; name: string; owner_name: string }>>([]);

  useEffect(() => {
    GatewayClient.tenants().then((res) => setTenants(res.tenants));
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#eef3f6] p-6">
      <div className="w-full max-w-3xl rounded-md border border-[#d8e0e7] bg-white p-6 shadow-sm">
        <h1 className="text-xl font-semibold">选择机构</h1>
        <div className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-2">
          {tenants.map((tenant) => (
            <button
              key={tenant.schema_name}
              className="rounded-md border border-[#d8e0e7] p-4 text-left transition hover:border-[#1f7a8c] hover:bg-[#f6fbfa]"
              onClick={() => navigate(`/${tenant.schema_name}`)}
            >
              <div className="font-semibold">{tenant.name}</div>
              <div className="mt-1 text-sm text-slate-500">负责人：{tenant.owner_name || "未设置"}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function LoginPage({ kind }: { kind: "admin" | "tenant" }) {
  const params = useParams();
  const navigate = useNavigate();
  const { setLogin } = useAuth();
  const [contact, setContact] = useState(kind === "admin" ? "admin" : "18800000001");
  const [password, setPassword] = useState(kind === "admin" ? "admin123" : "123456");
  const [error, setError] = useState("");

  async function submit() {
    setError("");
    try {
      const result =
        kind === "admin"
          ? await GatewayClient.adminLogin(contact, password)
          : await GatewayClient.tenantLogin(params.schemaName ?? "demo_school", contact, password);
      setLogin(result);
      navigate(kind === "admin" ? "/admin/app" : `/${params.schemaName}/app`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#eef3f6] p-6">
      <div className="w-full max-w-sm rounded-md border border-[#d8e0e7] bg-white p-6 shadow-sm">
        <h1 className="text-xl font-semibold">{kind === "admin" ? "Admin 登录" : "机构登录"}</h1>
        <p className="mt-1 text-sm text-slate-500">{kind === "admin" ? "平台管理入口" : "机构工作台"}</p>
        <div className="mt-5 space-y-3">
          <input className={`${token.input} w-full`} value={contact} onChange={(e) => setContact(e.target.value)} placeholder="账号/手机号" />
          <input className={`${token.input} w-full`} type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="密码" />
          {error && <div className="border border-red-200 bg-red-50 p-2 text-sm text-red-700">{error}</div>}
          <button className={`${token.button} ${token.primaryButton} w-full`} onClick={submit}>
            登录
          </button>
        </div>
      </div>
    </div>
  );
}
