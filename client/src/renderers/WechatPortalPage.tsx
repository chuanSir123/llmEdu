import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { enumDisplayFor } from "../dsl/enumLabels";

type PortalData = {
  fan?: Record<string, unknown> | null;
  student?: Record<string, unknown> | null;
  session?: Record<string, unknown> | null;
  courses?: Array<Record<string, unknown>>;
  leaves?: Array<Record<string, unknown>>;
  contracts?: Array<Record<string, unknown>>;
  classes?: Array<Record<string, unknown>>;
  goods?: Array<Record<string, unknown>>;
  groups?: Array<Record<string, unknown>>;
  teachers?: Array<Record<string, unknown>>;
};

type PaymentParams = { appId: string; timeStamp: string; nonceStr: string; package: string; signType: string; paySign: string };

type OrderStatus = { order?: Record<string, unknown> };

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { headers: { "Content-Type": "application/json" }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message ?? data.error ?? "请求失败");
  return data as T;
}

function card(title: string, children: React.ReactNode) {
  return <section className="rounded-3xl bg-white p-4 shadow-sm border border-slate-100"><h2 className="mb-3 text-base font-semibold text-slate-900">{title}</h2>{children}</section>;
}

function Empty({ text = "暂无数据" }: { text?: string }) {
  return <div className="rounded-2xl bg-slate-50 p-4 text-center text-sm text-slate-400">{text}</div>;
}

function List({ rows, render }: { rows?: Array<Record<string, unknown>>; render: (row: Record<string, unknown>) => React.ReactNode }) {
  if (!rows?.length) return <Empty />;
  return <div className="space-y-2">{rows.map((row, index) => <div key={String(row.id ?? index)} className="rounded-2xl bg-slate-50 p-3 text-sm text-slate-700">{render(row)}</div>)}</div>;
}

function invokeWechatJsapiPay(payment: PaymentParams) {
  return new Promise<void>((resolve, reject) => {
    const bridge = (window as unknown as { WeixinJSBridge?: { invoke: (name: string, params: PaymentParams, cb: (res: { err_msg?: string }) => void) => void } }).WeixinJSBridge;
    if (!bridge) {
      reject(new Error("请在微信内打开并完成 JSAPI 支付；支付后可点击补单查询状态"));
      return;
    }
    bridge.invoke("getBrandWCPayRequest", payment, (res) => {
      if (res.err_msg === "get_brand_wcpay_request:ok") resolve();
      else reject(new Error(res.err_msg || "微信支付未完成"));
    });
  });
}

export function WechatPortalPage() {
  const { schemaName = "demo_school" } = useParams();
  const [searchParams] = useSearchParams();
  const initialTab = searchParams.get("tab") || (location.pathname.includes("mall") ? "mall" : location.pathname.includes("me") ? "me" : "home");
  const [tab, setTab] = useState(initialTab);
  const [data, setData] = useState<PortalData>({});
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [selectedGoods, setSelectedGoods] = useState<Record<string, unknown> | null>(null);
  const [bindStudentId, setBindStudentId] = useState("stu_001");
  const [bindStudentName, setBindStudentName] = useState("");
  const [phoneLast4, setPhoneLast4] = useState("");
  const [lastOrderId, setLastOrderId] = useState("");
  const sessionToken = searchParams.get("sessionToken") || localStorage.getItem(`wx_session_${schemaName}`) || "";

  useEffect(() => {
    if (!sessionToken) return;
    localStorage.setItem(`wx_session_${schemaName}`, sessionToken);
    request<PortalData>(`/api/wechat/portal?schemaName=${encodeURIComponent(schemaName)}&sessionToken=${encodeURIComponent(sessionToken)}`)
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [schemaName, sessionToken]);

  const studentName = useMemo(() => String(data.student?.student_name ?? data.student?.name ?? "未绑定学员"), [data.student]);

  async function login() {
    const result = await request<{ url: string }>(`/api/wechat/oauth/login-url?schemaName=${encodeURIComponent(schemaName)}&redirect=${encodeURIComponent(location.pathname)}`);
    location.href = result.url;
  }

  async function refreshOrderStatus(orderId = lastOrderId) {
    if (!orderId) return;
    const status = await request<OrderStatus>(`/api/wechat/mall/order/status?schemaName=${encodeURIComponent(schemaName)}&orderId=${encodeURIComponent(orderId)}`);
    setMessage(`订单状态：${enumDisplayFor("payment_status", status.order?.payment_status) || "-"} / 履约：${enumDisplayFor("fulfillment_status", status.order?.fulfillment_status) || "-"}${status.order?.fulfillment_error ? `，错误：${String(status.order.fulfillment_error)}` : ""}`);
  }

  async function reconcileOrder(orderId = lastOrderId) {
    if (!orderId) return;
    await request("/api/wechat/mall/order/reconcile", { method: "POST", body: JSON.stringify({ schemaName, orderId }) });
    await refreshOrderStatus(orderId);
  }

  async function buy(goods: Record<string, unknown>) {
    if (!sessionToken) { await login(); return; }
    setMessage("正在创建订单...");
    try {
      const order = await request<{ orderId: string; orderNo: string; payAmount: number; payment: PaymentParams }>("/api/wechat/mall/order", {
        method: "POST",
        body: JSON.stringify({ schemaName, goodsId: goods.id, quantity: 1, activityId: goods.activity_id, sessionToken }),
      });
      setLastOrderId(order.orderId);
      setMessage(`订单 ${order.orderNo} 已创建，正在拉起微信支付...`);
      await invokeWechatJsapiPay(order.payment);
      setMessage("支付已提交，等待微信回调确认；若状态未更新请点击补单。");
      await refreshOrderStatus(order.orderId);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }

  async function bindOpenid() {
    if (!sessionToken) { await login(); return; }
    setMessage("正在绑定学员...");
    try {
      await request("/api/wechat/openid/bind", {
        method: "POST",
        body: JSON.stringify({ schemaName, sessionToken, studentId: bindStudentId, studentName: bindStudentName || undefined, phoneLast4: phoneLast4 || undefined }),
      });
      const refreshed = await request<PortalData>(`/api/wechat/portal?schemaName=${encodeURIComponent(schemaName)}&sessionToken=${encodeURIComponent(sessionToken)}`);
      setData(refreshed);
      setMessage("绑定成功");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }

  if (!sessionToken) {
    return <div className="min-h-screen bg-slate-100 p-6 text-slate-900"><div className="rounded-3xl bg-white p-6 shadow-sm"><h1 className="text-xl font-bold">微信公众号学员端</h1><p className="mt-2 text-sm text-slate-500">请先完成微信 OAuth 授权登录，系统不会信任前端传入 openid。</p><button className="mt-5 w-full rounded-2xl bg-blue-600 px-4 py-3 text-white" onClick={login}>微信授权登录</button></div></div>;
  }

  return (
    <div className="min-h-screen bg-slate-100 pb-20 text-slate-900">
      <header className="bg-gradient-to-br from-blue-600 to-cyan-500 px-5 pb-8 pt-8 text-white">
        <div className="text-sm opacity-80">微信公众号学员端</div>
        <div className="mt-2 text-2xl font-bold">你好，{studentName}</div>
        <div className="mt-1 text-sm opacity-90">{String(data.student?.school_name ?? "")} {String(data.student?.grade ?? "")}</div>
      </header>
      <main className="-mt-5 space-y-4 px-4">
        {error && <div className="rounded-2xl bg-red-50 p-3 text-sm text-red-600">{error}</div>}
        {message && <div className="rounded-2xl bg-emerald-50 p-3 text-sm text-emerald-700">{message}</div>}
        {lastOrderId && <div className="flex gap-2 rounded-2xl bg-white p-3 shadow-sm"><button className="flex-1 rounded-xl bg-slate-100 px-3 py-2 text-sm" onClick={() => refreshOrderStatus()}>查询订单</button><button className="flex-1 rounded-xl bg-blue-600 px-3 py-2 text-sm text-white" onClick={() => reconcileOrder()}>补单</button></div>}
        {tab === "home" && <>
          {card("我的课表", <List rows={data.courses} render={(row) => <div><b>{String(row.course_title ?? "课程")}</b><div>{String(row.course_date ?? "")} {String(row.start_time ?? "")}-{String(row.end_time ?? "")}</div></div>} />)}
          {card("请假记录", <List rows={data.leaves} render={(row) => <div>{String(row.leave_type ?? "请假")} · {String(row.leave_time ?? "")}</div>} />)}
          {card("我的合同", <List rows={data.contracts} render={(row) => <div>{String(row.id)} · ￥{String(row.total_amount ?? 0)} · {String(row.contract_status ?? "")}</div>} />)}
          {card("就读班级", <List rows={data.classes} render={(row) => <div>{String(row.name)} · {String(row.class_type)}</div>} />)}
        </>}
        {tab === "mall" && <>
          {card("课程商城", <List rows={data.goods} render={(row) => <div className="flex items-center justify-between gap-3"><button className="flex-1 text-left" onClick={() => setSelectedGoods(row)}><b>{String(row.goods_name)}</b><div className="text-xs text-slate-500">{String(row.active_activity_type ?? row.activity_type ?? "NORMAL")} · 库存 {String(row.stock_qty ?? 0)}</div><div className="mt-1 text-lg font-bold text-blue-600">￥{String(row.activity_price ?? row.sale_price ?? 0)}</div></button><button className="rounded-full bg-blue-600 px-4 py-2 text-white" onClick={() => buy(row)}>购买</button></div>} />)}
          {selectedGoods && card("商品详情", <div className="space-y-2 text-sm"><div className="font-semibold">{String(selectedGoods.goods_name)}</div><div>绑定产品：{String(selectedGoods.product_id ?? "-")}</div><div>活动：{String(selectedGoods.active_activity_type ?? selectedGoods.activity_type ?? "NORMAL")}</div><div>详情：{JSON.stringify(selectedGoods.detail_json ?? {})}</div><button className="rounded-full bg-blue-600 px-4 py-2 text-white" onClick={() => buy(selectedGoods)}>立即购买</button></div>)}
          {card("进行中的团购", <List rows={data.groups} render={(row) => <div>{String(row.id)} · {String(row.group_status)} · {String(row.joined_count ?? 0)}/{String(row.group_size ?? 0)} 人</div>} />)}
        </>}
        {tab === "me" && <>
          {card("我的信息", <div className="space-y-2 text-sm"><div>学员：{studentName}</div><div>OpenID：{String(data.fan?.openid ?? "已由服务端会话保护")}</div><div>微信名：{String(data.fan?.nickname ?? data.session?.nickname ?? "-")}</div><div>头像：{String(data.fan?.avatar_url ?? data.session?.avatarUrl ?? "-")}</div><div className="grid gap-2"><input className="rounded-xl border px-3 py-2" value={bindStudentId} onChange={(event) => setBindStudentId(event.target.value)} placeholder="学员ID" /><input className="rounded-xl border px-3 py-2" value={bindStudentName} onChange={(event) => setBindStudentName(event.target.value)} placeholder="学员姓名（可选）" /><input className="rounded-xl border px-3 py-2" value={phoneLast4} onChange={(event) => setPhoneLast4(event.target.value)} placeholder="手机号后四位" /><button className="rounded-xl bg-blue-600 px-3 py-2 text-white" onClick={bindOpenid}>绑定学员</button></div></div>)}
          {card("我的老师", <List rows={data.teachers} render={(row) => <div>{String(row.name)} · {String(row.staff_type ?? "老师")}</div>} />)}
          <button className="w-full rounded-2xl bg-white p-4 text-center text-red-500 shadow-sm" onClick={() => { localStorage.removeItem(`wx_session_${schemaName}`); setMessage("已退出微信学员端登录"); }}>退出登录</button>
        </>}
      </main>
      <nav className="fixed bottom-0 left-0 right-0 grid grid-cols-3 border-t border-slate-200 bg-white py-2 text-center text-sm">
        {[["home","首页"], ["mall","商城"], ["me","我的"]].map(([key, label]) => <button key={key} className={tab === key ? "font-bold text-blue-600" : "text-slate-500"} onClick={() => setTab(key)}>{label}</button>)}
      </nav>
    </div>
  );
}
