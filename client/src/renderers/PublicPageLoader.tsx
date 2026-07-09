import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { GatewayClient } from "../api/GatewayClient";
import { useAuth } from "../context/AuthContext";

const inputClass =
  "h-11 w-full rounded-lg border border-slate-200 bg-white px-3.5 text-sm text-[#172033] outline-none transition-all duration-200 placeholder:text-slate-300 hover:border-slate-300 focus:border-[#2f80ed] focus:shadow-[0_0_0_3px_rgba(47,128,237,0.15)]";

const BRAND_POINTS = [
  { icon: "🧩", title: "全流程一体化", desc: "营销、招生、教务、财务四大模块无缝协同" },
  { icon: "🤖", title: "AI 深度定制", desc: "自然语言描述需求，系统按需生长" },
  { icon: "🛡️", title: "企业级安全", desc: "多租户隔离与四层权限体系保驾护航" }
];

export function LoginPage({ kind }: { kind: "admin" | "tenant" }) {
  const params = useParams();
  const navigate = useNavigate();
  const { setLogin } = useAuth();
  const routeSchema = params.schemaName ?? "";
  const [schemaName, setSchemaName] = useState(routeSchema || "demo_school");
  const [contact, setContact] = useState(kind === "admin" ? "admin" : "18800000001");
  const [password, setPassword] = useState(kind === "admin" ? "admin123" : "123456");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit() {
    if (loading) return;
    const schema = (routeSchema || schemaName).trim();
    if (kind === "tenant" && !schema) {
      setError("请输入机构代码");
      return;
    }
    setError("");
    setLoading(true);
    try {
      const result =
        kind === "admin"
          ? await GatewayClient.adminLogin(contact, password)
          : await GatewayClient.tenantLogin(schema, contact, password);
      setLogin(result);
      navigate(kind === "admin" ? "/admin/app" : `/${schema}/app`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen bg-[#f4f7fb]">
      {/* 左侧品牌区 */}
      <div className="relative hidden flex-1 items-center justify-center overflow-hidden bg-gradient-to-br from-[#0b4bb3] via-[#1261d8] to-[#2f80ed] lg:flex">
        <div className="animate-blob absolute -left-24 -top-24 h-96 w-96 rounded-full bg-white/10 blur-3xl" />
        <div className="animate-blob absolute -bottom-28 -right-20 h-96 w-96 rounded-full bg-cyan-300/15 blur-3xl" style={{ animationDelay: "-6s" }} />
        <div
          className="absolute inset-0 opacity-[0.35]"
          style={{ backgroundImage: "radial-gradient(rgba(255,255,255,0.14) 1px, transparent 1px)", backgroundSize: "28px 28px" }}
        />
        <div className="relative max-w-md px-10">
          <Link to="/" className="flex items-center gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-white text-lg font-bold text-[#1261d8] shadow-[0_8px_24px_rgba(9,50,120,0.35)]">
              教
            </span>
            <span className="text-2xl font-bold text-white">AI 教务云</span>
          </Link>
          <h2 className="mt-10 text-3xl font-bold leading-snug text-white">
            AI 驱动的
            <br />
            教育机构管理平台
          </h2>
          <p className="mt-4 text-sm leading-6 text-blue-100">一句话定制系统，让机构经营更简单。</p>
          <div className="mt-10 space-y-5">
            {BRAND_POINTS.map((p, i) => (
              <div key={p.title} className="animate-float-slow flex items-start gap-4 rounded-xl border border-white/15 bg-white/10 p-4 backdrop-blur" style={{ animationDelay: `${i * 1.4}s` }}>
                <span className="text-xl">{p.icon}</span>
                <span>
                  <span className="block text-sm font-semibold text-white">{p.title}</span>
                  <span className="mt-0.5 block text-xs text-blue-100">{p.desc}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 右侧表单区 */}
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="w-full max-w-md">
          <Link to="/" className="mb-8 flex items-center justify-center gap-2.5 lg:hidden">
            <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br from-[#2f80ed] to-[#1261d8] text-base font-bold text-white">
              教
            </span>
            <span className="text-xl font-bold text-[#172033]">AI 教务云</span>
          </Link>
          <div className="rounded-2xl border border-slate-100 bg-white p-8 shadow-[0_12px_40px_rgba(18,97,216,0.1)] md:p-10">
            <h1 className="text-2xl font-bold text-[#172033]">{kind === "admin" ? "平台管理登录" : "欢迎回来"}</h1>
            <p className="mt-2 text-sm text-slate-400">{kind === "admin" ? "仅限平台运营人员使用" : "登录您的机构工作台，开始今天的工作"}</p>
            <div className="mt-8 space-y-5">
              {kind === "tenant" && !routeSchema && (
                <label className="block">
                  <span className="mb-1.5 block text-sm font-medium text-slate-600">机构代码</span>
                  <input className={inputClass} value={schemaName} onChange={(e) => setSchemaName(e.target.value)} placeholder="请输入您的机构代码" />
                </label>
              )}
              <label className="block">
                <span className="mb-1.5 block text-sm font-medium text-slate-600">账号</span>
                <input
                  className={inputClass}
                  value={contact}
                  onChange={(e) => setContact(e.target.value)}
                  placeholder="账号 / 手机号"
                  onKeyDown={(e) => e.key === "Enter" && submit()}
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-sm font-medium text-slate-600">密码</span>
                <input
                  className={inputClass}
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="请输入密码"
                  onKeyDown={(e) => e.key === "Enter" && submit()}
                />
              </label>
              {error && <div className="rounded-lg border border-red-100 bg-red-50 px-3.5 py-2.5 text-sm text-red-600">{error}</div>}
              <button
                className="h-11 w-full rounded-lg bg-gradient-to-r from-[#2f80ed] to-[#1261d8] text-sm font-semibold text-white shadow-[0_6px_18px_rgba(47,128,237,0.35)] transition-all duration-300 hover:-translate-y-0.5 hover:shadow-[0_10px_26px_rgba(47,128,237,0.45)] disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0"
                disabled={loading}
                onClick={submit}
              >
                {loading ? "登录中…" : "登 录"}
              </button>
            </div>
            {kind === "tenant" && (
              <p className="mt-6 text-center text-xs text-slate-400">
                还没有机构账号？咨询热线 <span className="font-semibold text-[#2f80ed]">13059199454</span>（黄老师）
              </p>
            )}
          </div>
          <p className="mt-6 text-center text-xs text-slate-400">
            <Link to="/" className="transition hover:text-[#2f80ed]">
              ← 返回首页
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
