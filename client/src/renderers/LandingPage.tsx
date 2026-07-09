import { ReactNode, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

const CONTACT_PHONE = "13059199454";
const CONTACT_NAME = "黄老师";

function Reveal({ children, delay = 0, className = "" }: { children: ReactNode; delay?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("reveal-visible");
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.15 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={ref} className={`reveal ${className}`} style={{ "--reveal-delay": `${delay}ms` } as React.CSSProperties}>
      {children}
    </div>
  );
}

function SpotCard({ children, className = "" }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  function handleMove(e: React.MouseEvent<HTMLDivElement>) {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    el.style.setProperty("--x", `${e.clientX - rect.left}px`);
    el.style.setProperty("--y", `${e.clientY - rect.top}px`);
  }

  return (
    <div ref={ref} onMouseMove={handleMove} className={`spot-card ${className}`}>
      {children}
    </div>
  );
}

const MODULES = [
  {
    icon: "📣",
    title: "营销获客",
    desc: "活动招募、渠道线索、优惠券与商城一体化管理，AI 自动跟进线索并生成营销文案。",
    points: ["线索池与跟进记录", "活动 / 优惠券 / 微信商城", "转化漏斗分析"]
  },
  {
    icon: "🎯",
    title: "招生转化",
    desc: "从试听预约到签约合同全流程在线化，审批流可视化配置，成单效率一目了然。",
    points: ["试听排期与到访登记", "合同签约与审批流", "顾问业绩看板"]
  },
  {
    icon: "📚",
    title: "教务排课",
    desc: "班级、教师、教室多维排课，自动检测冲突；上课扣费、考勤补课全自动流转。",
    points: ["智能排课与冲突检测", "考勤点名与课消扣费", "教师课时统计"]
  },
  {
    icon: "💰",
    title: "财务结算",
    desc: "收款、退费、课消对账严格由业务规则驱动，每一分钱的流向都可追溯、可审计。",
    points: ["收款 / 退费 / 结转", "课消对账与应收管理", "多维度财务报表"]
  }
];

const AI_STEPS = [
  { step: "01", title: "自然语言提需求", desc: "「给学员表加一个来源渠道字段，并在列表页支持筛选」——像聊天一样描述需求。" },
  { step: "02", title: "AI 生成变更方案", desc: "AI 理解业务上下文，自动产出页面、接口、字段的结构化变更方案（DSL Diff）。" },
  { step: "03", title: "多层安全校验", desc: "租户策略、教务领域护栏、真实表结构三层校验，财务字段与数据隔离绝不越界。" },
  { step: "04", title: "预览库先行验证", desc: "变更先落到独立预览环境，真实数据演练无风险，看到效果再决定。" },
  { step: "05", title: "一键发布可回滚", desc: "确认无误后一键发布到正式环境，版本化管理，随时回滚到任意历史版本。" }
];

const ADVANTAGES = [
  { icon: "🏫", title: "多租户独立隔离", desc: "每个机构独立数据空间，互不可见，安全合规。" },
  { icon: "🛡️", title: "四层权限体系", desc: "页面、按钮、字段、数据行四层权限精细管控。" },
  { icon: "🤖", title: "AI 业务助手", desc: "对话式查数据、办业务、批量导入 Excel，动动嘴就能完成。" },
  { icon: "🧩", title: "全 DSL 驱动", desc: "页面、菜单、接口、按钮全部由配置驱动，定制不改代码。" },
  { icon: "🔄", title: "审批流引擎", desc: "合同、退费、调课等关键动作可视化配置审批链路。" },
  { icon: "📈", title: "实时经营看板", desc: "招生、课消、营收核心指标实时呈现，经营心中有数。" }
];

function HeroMock() {
  return (
    <div className="animate-float-slow relative w-full max-w-[540px] select-none">
      {/* 浏览器窗口 */}
      <div className="overflow-hidden rounded-xl border border-white/20 bg-white shadow-[0_24px_70px_rgba(9,50,120,0.45)]">
        <div className="flex items-center gap-1.5 border-b border-slate-100 bg-slate-50 px-4 py-2.5">
          <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
          <div className="ml-3 h-5 flex-1 rounded bg-slate-100" />
        </div>
        <div className="flex">
          <div className="flex w-14 flex-col items-center gap-3 bg-[#1261d8] py-4">
            {[0.9, 0.55, 0.55, 0.55, 0.55].map((op, i) => (
              <span key={i} className="h-6 w-6 rounded-md bg-white" style={{ opacity: op * 0.35 + (i === 0 ? 0.4 : 0) }} />
            ))}
          </div>
          <div className="flex-1 space-y-3 bg-[#f4f7fb] p-4">
            <div className="flex gap-3">
              {[
                { label: "本月新签", value: "128", color: "#2f80ed" },
                { label: "在读学员", value: "1,562", color: "#1261d8" },
                { label: "本月课消", value: "¥42.6万", color: "#0ea5e9" }
              ].map((s) => (
                <div key={s.label} className="flex-1 rounded-lg bg-white p-3 shadow-sm">
                  <div className="text-[10px] text-slate-400">{s.label}</div>
                  <div className="mt-1 text-base font-bold" style={{ color: s.color }}>
                    {s.value}
                  </div>
                </div>
              ))}
            </div>
            <div className="rounded-lg bg-white p-3 shadow-sm">
              <div className="mb-2 flex items-center justify-between">
                <div className="text-[10px] font-medium text-slate-500">招生趋势</div>
                <div className="h-2 w-10 rounded bg-slate-100" />
              </div>
              <div className="flex h-20 items-end gap-2">
                {[38, 58, 44, 72, 60, 86, 68, 95, 78, 100, 88, 96].map((h, i) => (
                  <div
                    key={i}
                    className="flex-1 origin-bottom rounded-t bg-gradient-to-t from-[#2f80ed] to-[#7db4f7]"
                    style={{ height: `${h}%`, animation: `bar-grow 0.9s ${0.08 * i}s cubic-bezier(0.22,1,0.36,1) both` }}
                  />
                ))}
              </div>
            </div>
            <div className="space-y-2 rounded-lg bg-white p-3 shadow-sm">
              {[0.95, 0.8, 0.65].map((w, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="h-4 w-4 rounded bg-[#e3efff]" />
                  <div className="h-2.5 rounded bg-slate-100" style={{ width: `${w * 100}%` }} />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      {/* 悬浮 AI 气泡 */}
      <div className="animate-float-slower absolute -left-8 -bottom-7 hidden w-56 rounded-xl border border-white/40 bg-white/95 p-3 shadow-[0_16px_40px_rgba(9,50,120,0.35)] backdrop-blur md:block">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[#2f80ed] text-sm text-white">AI</span>
          <span className="text-xs font-semibold text-[#172033]">AI 定制助手</span>
          <span className="animate-pulse-soft ml-auto h-2 w-2 rounded-full bg-emerald-400" />
        </div>
        <p className="mt-2 text-[11px] leading-4 text-slate-500">已为学员列表新增「来源渠道」筛选，预览通过，可一键发布 ✓</p>
      </div>
    </div>
  );
}

export function LandingPage() {
  const navigate = useNavigate();
  const heroRef = useRef<HTMLElement>(null);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  function handleHeroMove(e: React.MouseEvent<HTMLElement>) {
    const el = heroRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    el.style.setProperty("--mx", `${((e.clientX - rect.left) / rect.width) * 100}%`);
    el.style.setProperty("--my", `${((e.clientY - rect.top) / rect.height) * 100}%`);
  }

  return (
    <div className="min-h-screen bg-white text-[#172033]">
      {/* 顶部导航 */}
      <header
        className={`fixed inset-x-0 top-0 z-50 transition-all duration-300 ${
          scrolled ? "bg-white/90 shadow-[0_2px_16px_rgba(18,97,216,0.1)] backdrop-blur" : "bg-transparent"
        }`}
      >
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-8 px-5">
          <a href="#top" className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-[#2f80ed] to-[#1261d8] text-base font-bold text-white shadow-[0_4px_12px_rgba(47,128,237,0.4)]">
              教
            </span>
            <span className={`text-lg font-bold transition-colors ${scrolled ? "text-[#172033]" : "text-white"}`}>AI 教务云</span>
          </a>
          <nav className={`ml-auto hidden items-center gap-7 text-sm md:flex ${scrolled ? "text-slate-600" : "text-white/85"}`}>
            <a href="#modules" className="transition hover:opacity-70">
              产品模块
            </a>
            <a href="#ai" className="transition hover:opacity-70">
              AI 定制
            </a>
            <a href="#advantages" className="transition hover:opacity-70">
              平台优势
            </a>
            <a href="#contact" className="transition hover:opacity-70">
              联系我们
            </a>
          </nav>
          <button
            className={`ml-auto rounded-lg px-5 py-2 text-sm font-medium transition-all duration-300 hover:-translate-y-0.5 md:ml-0 ${
              scrolled
                ? "bg-[#2f80ed] text-white shadow-[0_4px_14px_rgba(47,128,237,0.4)] hover:bg-[#1c6fd8]"
                : "bg-white text-[#1261d8] shadow-[0_4px_14px_rgba(9,50,120,0.3)] hover:bg-blue-50"
            }`}
            onClick={() => navigate("/login")}
          >
            机构登录
          </button>
        </div>
      </header>

      {/* Hero */}
      <section
        id="top"
        ref={heroRef}
        onMouseMove={handleHeroMove}
        className="relative overflow-hidden bg-gradient-to-br from-[#0b4bb3] via-[#1261d8] to-[#2f80ed]"
      >
        {/* 装饰光斑 */}
        <div className="animate-blob absolute -left-24 -top-24 h-96 w-96 rounded-full bg-white/10 blur-3xl" />
        <div className="animate-blob absolute -right-16 top-1/3 h-80 w-80 rounded-full bg-cyan-300/15 blur-3xl" style={{ animationDelay: "-5s" }} />
        <div className="absolute inset-0 opacity-[0.35]" style={{ backgroundImage: "radial-gradient(rgba(255,255,255,0.14) 1px, transparent 1px)", backgroundSize: "28px 28px" }} />
        {/* 鼠标跟随光晕 */}
        <div className="hero-glow pointer-events-none absolute inset-0" />

        <div className="relative mx-auto flex max-w-6xl flex-col items-center gap-12 px-5 pb-24 pt-32 lg:flex-row lg:gap-8 lg:pb-32 lg:pt-40">
          <div className="max-w-xl text-center lg:text-left">
            <Reveal>
              <span className="inline-flex items-center gap-2 rounded-full border border-white/30 bg-white/10 px-4 py-1.5 text-xs text-white/90 backdrop-blur">
                <span className="animate-pulse-soft h-1.5 w-1.5 rounded-full bg-cyan-300" />
                AI 原生 · 可定制的教育机构管理系统
              </span>
            </Reveal>
            <Reveal delay={120}>
              <h1 className="mt-6 text-4xl font-bold leading-tight text-white md:text-5xl">
                用 AI 重新定义
                <br />
                <span className="bg-gradient-to-r from-cyan-200 to-white bg-clip-text text-transparent">教务管理系统</span>
              </h1>
            </Reveal>
            <Reveal delay={240}>
              <p className="mt-5 text-base leading-7 text-blue-100 md:text-lg">
                营销、招生、教务、财务四大模块开箱即用；一句话描述需求，AI 自动为您的机构定制页面、字段与流程——无需开发，即刻生效。
              </p>
            </Reveal>
            <Reveal delay={360}>
              <div className="mt-8 flex flex-wrap items-center justify-center gap-4 lg:justify-start">
                <button
                  className="group rounded-xl bg-white px-8 py-3.5 text-base font-semibold text-[#1261d8] shadow-[0_10px_30px_rgba(9,50,120,0.35)] transition-all duration-300 hover:-translate-y-1 hover:shadow-[0_16px_40px_rgba(9,50,120,0.45)]"
                  onClick={() => navigate("/login")}
                >
                  进入工作台
                  <span className="ml-2 inline-block transition-transform duration-300 group-hover:translate-x-1">→</span>
                </button>
                <a
                  href="#contact"
                  className="rounded-xl border border-white/40 px-8 py-3.5 text-base font-medium text-white backdrop-blur transition-all duration-300 hover:-translate-y-1 hover:bg-white/10"
                >
                  预约演示
                </a>
              </div>
            </Reveal>
            <Reveal delay={480}>
              <div className="mt-12 grid grid-cols-3 gap-6 border-t border-white/15 pt-8">
                {[
                  { value: "4 大", label: "核心业务模块" },
                  { value: "5 分钟", label: "AI 定制上线" },
                  { value: "100%", label: "数据独立隔离" }
                ].map((s) => (
                  <div key={s.label} className="text-center lg:text-left">
                    <div className="text-2xl font-bold text-white md:text-3xl">{s.value}</div>
                    <div className="mt-1 text-xs text-blue-200">{s.label}</div>
                  </div>
                ))}
              </div>
            </Reveal>
          </div>
          <Reveal delay={300} className="flex-1">
            <HeroMock />
          </Reveal>
        </div>

        {/* 底部弧形过渡 */}
        <svg className="block w-full text-white" viewBox="0 0 1440 80" fill="currentColor" preserveAspectRatio="none">
          <path d="M0,80 C360,20 1080,20 1440,80 L1440,80 L0,80 Z" />
        </svg>
      </section>

      {/* 四大模块 */}
      <section id="modules" className="mx-auto max-w-6xl scroll-mt-24 px-5 py-20">
        <Reveal>
          <div className="text-center">
            <span className="text-sm font-semibold tracking-wider text-[#2f80ed]">PRODUCT</span>
            <h2 className="mt-2 text-3xl font-bold md:text-4xl">四大模块，覆盖机构经营全流程</h2>
            <p className="mx-auto mt-3 max-w-2xl text-slate-500">从获客到收款，从排课到结算，一套系统串起教育机构的每一个经营环节。</p>
          </div>
        </Reveal>
        <div className="mt-12 grid grid-cols-1 gap-6 md:grid-cols-2">
          {MODULES.map((m, i) => (
            <Reveal key={m.title} delay={i * 100}>
              <SpotCard className="group h-full rounded-2xl border border-slate-100 bg-white p-7 shadow-[0_2px_12px_rgba(18,97,216,0.06)] transition-all duration-300 hover:-translate-y-1.5 hover:border-[#bcd8fb] hover:shadow-[0_18px_44px_rgba(18,97,216,0.14)]">
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-[#e8f1fe] to-[#d4e6fd] text-2xl transition-transform duration-300 group-hover:scale-110">
                  {m.icon}
                </div>
                <h3 className="mt-5 text-xl font-bold">{m.title}</h3>
                <p className="mt-2 text-sm leading-6 text-slate-500">{m.desc}</p>
                <ul className="mt-4 space-y-2">
                  {m.points.map((p) => (
                    <li key={p} className="flex items-center gap-2 text-sm text-slate-600">
                      <span className="flex h-4 w-4 items-center justify-center rounded-full bg-[#e8f1fe] text-[10px] text-[#2f80ed]">✓</span>
                      {p}
                    </li>
                  ))}
                </ul>
              </SpotCard>
            </Reveal>
          ))}
        </div>
      </section>

      {/* AI 定制流程 */}
      <section id="ai" className="scroll-mt-24 bg-[#f4f7fb] py-20">
        <div className="mx-auto max-w-6xl px-5">
          <Reveal>
            <div className="text-center">
              <span className="text-sm font-semibold tracking-wider text-[#2f80ed]">AI CUSTOMIZATION</span>
              <h2 className="mt-2 text-3xl font-bold md:text-4xl">一句话，定制属于您机构的系统</h2>
              <p className="mx-auto mt-3 max-w-2xl text-slate-500">
                不写一行代码。用自然语言描述需求，AI 自动生成、校验、预览、发布，全程安全可控、版本可回滚。
              </p>
            </div>
          </Reveal>
          <div className="mt-12 grid grid-cols-1 gap-5 md:grid-cols-5">
            {AI_STEPS.map((s, i) => (
              <Reveal key={s.step} delay={i * 110} className="h-full">
                <div className="relative h-full rounded-2xl border border-slate-100 bg-white p-5 transition-all duration-300 hover:-translate-y-1.5 hover:shadow-[0_14px_34px_rgba(18,97,216,0.12)]">
                  <div className="text-3xl font-black text-[#e3efff]">{s.step}</div>
                  <h3 className="mt-2 text-base font-bold">{s.title}</h3>
                  <p className="mt-2 text-xs leading-5 text-slate-500">{s.desc}</p>
                  {i < AI_STEPS.length - 1 && (
                    <span className="absolute -right-4 top-1/2 hidden -translate-y-1/2 text-lg text-[#bcd8fb] md:block">→</span>
                  )}
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* 平台优势 */}
      <section id="advantages" className="mx-auto max-w-6xl scroll-mt-24 px-5 py-20">
        <Reveal>
          <div className="text-center">
            <span className="text-sm font-semibold tracking-wider text-[#2f80ed]">WHY US</span>
            <h2 className="mt-2 text-3xl font-bold md:text-4xl">为教育机构而生的企业级底座</h2>
          </div>
        </Reveal>
        <div className="mt-12 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {ADVANTAGES.map((a, i) => (
            <Reveal key={a.title} delay={(i % 3) * 100}>
              <SpotCard className="h-full rounded-2xl border border-slate-100 bg-white p-6 transition-all duration-300 hover:-translate-y-1 hover:border-[#bcd8fb] hover:shadow-[0_14px_34px_rgba(18,97,216,0.12)]">
                <div className="text-2xl">{a.icon}</div>
                <h3 className="mt-3 text-base font-bold">{a.title}</h3>
                <p className="mt-1.5 text-sm leading-6 text-slate-500">{a.desc}</p>
              </SpotCard>
            </Reveal>
          ))}
        </div>
      </section>

      {/* 联系我们 */}
      <section id="contact" className="scroll-mt-24 px-5 pb-20">
        <Reveal>
          <div className="relative mx-auto max-w-6xl overflow-hidden rounded-3xl bg-gradient-to-br from-[#0b4bb3] via-[#1261d8] to-[#2f80ed] px-6 py-16 text-center shadow-[0_24px_60px_rgba(18,97,216,0.35)]">
            <div className="animate-blob absolute -left-20 -top-24 h-72 w-72 rounded-full bg-white/10 blur-3xl" />
            <div className="animate-blob absolute -bottom-24 -right-16 h-72 w-72 rounded-full bg-cyan-300/15 blur-3xl" style={{ animationDelay: "-7s" }} />
            <div className="relative">
              <h2 className="text-3xl font-bold text-white md:text-4xl">准备好升级您的机构管理了吗？</h2>
              <p className="mx-auto mt-4 max-w-xl text-blue-100">欢迎联系我们预约产品演示，为您的机构量身定制专属方案。</p>
              <div className="mt-8 flex flex-col items-center justify-center gap-4 sm:flex-row">
                <a
                  href={`tel:${CONTACT_PHONE}`}
                  className="group flex items-center gap-3 rounded-xl bg-white px-8 py-4 shadow-[0_10px_30px_rgba(9,50,120,0.35)] transition-all duration-300 hover:-translate-y-1"
                >
                  <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[#e8f1fe] text-lg transition-transform duration-300 group-hover:rotate-12">
                    📞
                  </span>
                  <span className="text-left">
                    <span className="block text-xs text-slate-400">咨询热线（{CONTACT_NAME}）</span>
                    <span className="block text-xl font-bold tracking-wide text-[#1261d8]">{CONTACT_PHONE}</span>
                  </span>
                </a>
                <button
                  className="rounded-xl border border-white/40 px-8 py-4 text-base font-medium text-white backdrop-blur transition-all duration-300 hover:-translate-y-1 hover:bg-white/10"
                  onClick={() => navigate("/login")}
                >
                  已有账号，直接登录
                </button>
              </div>
            </div>
          </div>
        </Reveal>
      </section>

      {/* 页脚 */}
      <footer className="border-t border-slate-100 bg-white">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-5 py-8 text-sm text-slate-400 md:flex-row">
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-gradient-to-br from-[#2f80ed] to-[#1261d8] text-xs font-bold text-white">
              教
            </span>
            <span className="font-semibold text-slate-600">AI 教务云</span>
            <span className="ml-2">AI 可定制的教育机构管理 SaaS</span>
          </div>
          <div className="flex items-center gap-6">
            <span>
              联系电话：{CONTACT_PHONE}（{CONTACT_NAME}）
            </span>
            <button className="transition hover:text-[#2f80ed]" onClick={() => navigate("/admin")}>
              平台管理
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
}
