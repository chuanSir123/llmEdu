import { createDecipheriv, createHash, createSign, createVerify, randomUUID, timingSafeEqual } from "node:crypto";
import { pool, withClient } from "./db/pool.js";
import { qIdent } from "./db/schema-resolver.js";
import { withRedisLock } from "./redis-lock.service.js";
import { executeCommandDsl } from "./gateway/command-engine.js";

type Row = Record<string, unknown>;


function textSecret(value: unknown) {
  // Admin 微信配置按明文保存，便于直接改库调试；兼容历史 enc: 值但不再新增加密。
  const text = String(value ?? "");
  if (!text.startsWith("enc:")) return text;
  throw Object.assign(new Error("检测到历史加密密钥，请在 admin.wechat_third_platform_app 中改为明文后再使用"), { statusCode: 400 });
}

function table(schemaName: string, tableName: string) {
  return `${qIdent(schemaName)}.${qIdent(tableName)}`;
}

function str(value: unknown, fallback = "") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function num(value: unknown, fallback = 0) {
  const n = Number(value ?? fallback);
  return Number.isFinite(n) ? n : fallback;
}

function jsonObject(value: unknown): Row {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value as Row;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Row : {};
    } catch {
      return {};
    }
  }
  return {};
}


function parseXmlText(xml: string) {
  const result: Row = {};
  for (const match of xml.matchAll(/<([A-Za-z0-9_]+)>(?:<!\[CDATA\[(.*?)\]\]>|([^<]*))<\/\1>/g)) {
    result[match[1]] = match[2] ?? match[3] ?? "";
  }
  return result;
}

function verifyWechatSignature(token: string, timestamp: string, nonce: string, signature: string, encrypt?: string) {
  const raw = [token, timestamp, nonce, encrypt].filter((item): item is string => Boolean(item)).sort().join("");
  const digest = createHash("sha1").update(raw).digest("hex");
  if (!safeEqualText(digest, signature)) throw Object.assign(new Error("微信回调签名校验失败"), { statusCode: 400 });
}

function decryptWechatComponentMessage(encrypt: string, encodingAesKey: string) {
  const aesKey = Buffer.from(`${encodingAesKey}=`, "base64");
  const decipher = createDecipheriv("aes-256-cbc", aesKey, aesKey.subarray(0, 16));
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([decipher.update(Buffer.from(encrypt, "base64")), decipher.final()]);
  const pad = decrypted[decrypted.length - 1];
  const content = decrypted.subarray(0, decrypted.length - pad);
  const msgLen = content.subarray(16, 20).readUInt32BE(0);
  return content.subarray(20, 20 + msgLen).toString("utf8");
}

async function wechatPost<T extends Row>(url: string, body: Row): Promise<T> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({})) as T & { errcode?: number; errmsg?: string };
  if (!response.ok || (data.errcode && data.errcode !== 0)) {
    throw Object.assign(new Error(`微信接口调用失败: ${data.errmsg ?? response.statusText}`), { statusCode: 502, wechat: data });
  }
  return data;
}

async function getPlatformApp(componentAppid?: string) {
  const { rows } = await pool.query(
    `select * from admin.wechat_third_platform_app where deleted = false and status = 'ACTIVE' and ($1::text is null or component_appid = $1) order by updated_at desc limit 1`,
    [componentAppid || null]
  );
  const app = rows[0];
  if (!app) throw Object.assign(new Error("未配置可用的微信第三方平台应用"), { statusCode: 400 });
  const ext = jsonObject(app.ext_json);
  return { ...app, component_appsecret: textSecret(app.component_appsecret), token: textSecret(app.token), encoding_aes_key: textSecret(app.encoding_aes_key), ext_json: ext } as Row;
}

async function savePlatformExt(appId: string, ext: Row) {
  await pool.query(`update admin.wechat_third_platform_app set ext_json = $2::jsonb, updated_at = now() where id = $1`, [appId, JSON.stringify(ext)]);
}

async function getComponentAccessToken(componentAppid?: string) {
  const app = await getPlatformApp(componentAppid);
  const ext = jsonObject(app.ext_json);
  const cached = str(ext.component_access_token, "");
  const expiresAt = Number(ext.component_access_token_expires_at ?? 0);
  if (cached && expiresAt > Date.now() + 300_000) return { token: cached, app };
  const ticket = str(ext.component_verify_ticket ?? ext.ticket ?? "", "");
  if (!ticket) throw Object.assign(new Error("缺少 component_verify_ticket，请先完成微信第三方平台统一回调票据入库"), { statusCode: 400 });
  const data = await wechatPost<Row>("https://api.weixin.qq.com/cgi-bin/component/api_component_token", {
    component_appid: app.component_appid,
    component_appsecret: app.component_appsecret,
    component_verify_ticket: ticket,
  });
  ext.component_access_token = data.component_access_token;
  ext.component_access_token_expires_at = Date.now() + (Number(data.expires_in ?? 7200) - 120) * 1000;
  await savePlatformExt(String(app.id), ext);
  return { token: str(data.component_access_token), app: { ...app, ext_json: ext } };
}

async function getBinding(schemaName: string, bindingId = "wx_bind_public") {
  const { rows } = await pool.query(`select * from ${table(schemaName, "wechat_account_binding")} where id = $1 and deleted = false`, [bindingId]);
  if (!rows[0]) throw Object.assign(new Error("公众号绑定不存在"), { statusCode: 404 });
  return rows[0] as Row;
}

async function getAuthorizerAccessToken(schemaName: string, bindingId = "wx_bind_public") {
  const binding = await getBinding(schemaName, bindingId);
  const ext = jsonObject(binding.ext_json);
  const cached = str(ext.authorizer_access_token, "");
  const expiresAt = binding.access_token_expires_at ? new Date(String(binding.access_token_expires_at)).getTime() : 0;
  if (cached && expiresAt > Date.now() + 300_000) return { token: cached, binding };
  return refreshWechatToken(schemaName, { id: bindingId }).then((result) => ({ token: String((result as Row).authorizerAccessToken), binding }));
}

function wechatPaySign(method: string, urlPathWithQuery: string, timestamp: string, nonceStr: string, body: string, privateKeyPem: string) {
  const signer = createSign("RSA-SHA256");
  signer.update(`${method}\n${urlPathWithQuery}\n${timestamp}\n${nonceStr}\n${body}\n`);
  signer.end();
  return signer.sign(privateKeyPem, "base64");
}

async function wechatPayRequest(method: string, urlPath: string, body: Row | undefined, payConfig: Row) {
  const mchid = str(payConfig.mchid);
  const serialNo = str(payConfig.serial_no ?? payConfig.serialNo);
  const privateKeyPem = String(payConfig.private_key_pem ?? payConfig.privateKeyPem ?? "").replace(/\\n/g, "\n");
  if (!mchid || !serialNo || !privateKeyPem) throw Object.assign(new Error("缺少微信支付商户号、证书序列号或商户私钥"), { statusCode: 400 });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonceStr = randomUUID().replace(/-/g, "");
  const payload = body ? JSON.stringify(body) : "";
  const signature = wechatPaySign(method, urlPath, timestamp, nonceStr, payload, privateKeyPem);
  const authorization = `WECHATPAY2-SHA256-RSA2048 mchid="${mchid}",nonce_str="${nonceStr}",signature="${signature}",timestamp="${timestamp}",serial_no="${serialNo}"`;
  const response = await fetch(`https://api.mch.weixin.qq.com${urlPath}`, { method, headers: { authorization, "content-type": "application/json", accept: "application/json" }, body: payload || undefined });
  const data = await response.json().catch(() => ({})) as Row;
  if (!response.ok) throw Object.assign(new Error(`微信支付接口调用失败: ${data.message ?? response.statusText}`), { statusCode: 502, wechatPay: data });
  return data;
}


function safeEqualText(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function decryptWechatPayResource(resource: Row, apiV3Key: string) {
  const ciphertext = Buffer.from(str(resource.ciphertext), "base64");
  const authTag = ciphertext.subarray(ciphertext.length - 16);
  const data = ciphertext.subarray(0, ciphertext.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(apiV3Key), str(resource.nonce));
  decipher.setAuthTag(authTag);
  decipher.setAAD(Buffer.from(str(resource.associated_data)));
  return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8")) as Row;
}

function verifyWechatPayHeaders(params: Row, payConfig: Row) {
  const headers = jsonObject(params.headers);
  const timestamp = str(headers["wechatpay-timestamp"] ?? headers["Wechatpay-Timestamp"]);
  const nonce = str(headers["wechatpay-nonce"] ?? headers["Wechatpay-Nonce"]);
  const signature = str(headers["wechatpay-signature"] ?? headers["Wechatpay-Signature"]);
  const serial = str(headers["wechatpay-serial"] ?? headers["Wechatpay-Serial"]);
  const rawBody = str(params.rawBody ?? params.__rawBody, "");
  const certPem = String(payConfig.platform_certificate_pem ?? payConfig.platformCertificatePem ?? "").replace(/\\n/g, "\n");
  if (!timestamp || !nonce || !signature || !serial || !rawBody || !certPem) throw Object.assign(new Error("缺少微信支付回调验签所需 header、rawBody 或平台证书"), { statusCode: 400 });
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${timestamp}\n${nonce}\n${rawBody}\n`);
  verifier.end();
  if (!verifier.verify(certPem, signature, "base64")) throw Object.assign(new Error("微信支付回调签名校验失败"), { statusCode: 400 });
  if (payConfig.platform_certificate_serial_no && !safeEqualText(serial, String(payConfig.platform_certificate_serial_no))) throw Object.assign(new Error("微信支付平台证书序列号不匹配"), { statusCode: 400 });
}

async function parseWechatPayCallback(schemaName: string, params: Row) {
  if (params.resource) {
    const payConfig = await getPayConfig(schemaName, str(params.binding_id, "wx_bind_public"));
    verifyWechatPayHeaders(params, payConfig);
    const apiV3Key = str(payConfig.api_v3_key ?? payConfig.apiV3Key);
    if (!apiV3Key) throw Object.assign(new Error("缺少微信支付 api_v3_key"), { statusCode: 400 });
    const decoded = decryptWechatPayResource(jsonObject(params.resource), apiV3Key);
    if (decoded.trade_state && decoded.trade_state !== "SUCCESS") throw Object.assign(new Error(`微信支付状态不是 SUCCESS: ${decoded.trade_state}`), { statusCode: 400, wechatPay: decoded });
    return decoded;
  }
  throw Object.assign(new Error("生产支付回调必须提供微信支付 V3 resource 加密报文"), { statusCode: 400 });
}

async function getPayConfig(schemaName: string, bindingId = "wx_bind_public"): Promise<Row> {
  const binding = await getBinding(schemaName, bindingId);
  const bindingExt = jsonObject(binding.ext_json);
  if (bindingExt.pay) return { ...(bindingExt.pay as Row), appid: binding.authorizer_appid ?? binding.appid } as Row;
  if (binding.public_account_id) {
    const { rows } = await pool.query(`select * from admin.public_wechat_account where id = $1 and deleted = false`, [binding.public_account_id]);
    const ext = jsonObject(rows[0]?.ext_json);
    if (ext.pay) return { ...(ext.pay as Row), appid: binding.authorizer_appid ?? binding.appid } as Row;
  }
  throw Object.assign(new Error("缺少微信支付配置，请在公众号 ext_json.pay 中配置 mchid、serial_no、private_key_pem、api_v3_key、notify_url"), { statusCode: 400 });
}

async function getWechatSession(schemaName: string, sessionToken?: unknown) {
  const token = str(sessionToken, "");
  if (!token) throw Object.assign(new Error("缺少微信登录会话"), { statusCode: 401 });
  const { rows } = await pool.query(
    `select * from ${table(schemaName, "wechat_oauth_session")} where session_token = $1 and expires_at > now() and deleted = false limit 1`,
    [token]
  );
  if (!rows[0]) throw Object.assign(new Error("微信登录已过期，请重新授权"), { statusCode: 401 });
  return rows[0] as Row;
}

function appendQuery(url: string, params: Record<string, string>) {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${new URLSearchParams(params).toString()}`;
}

async function savePayOrderIndex(schemaName: string, bindingId: string, orderId: string, status = "CREATED") {
  await pool.query(
    `insert into admin.wechat_pay_order_index(out_trade_no, schema_name, binding_id, mall_order_id, order_status, deleted)
     values($1,$2,$3,$4,$5,false)
     on conflict(out_trade_no) do update set schema_name = excluded.schema_name, binding_id = excluded.binding_id, mall_order_id = excluded.mall_order_id, order_status = excluded.order_status, updated_at = now(), deleted = false`,
    [orderId, schemaName, bindingId, orderId, status]
  );
}

async function findPayOrderIndex(outTradeNo: string) {
  const { rows } = await pool.query(`select * from admin.wechat_pay_order_index where out_trade_no = $1 and deleted = false limit 1`, [outTradeNo]);
  return rows[0] as Row | undefined;
}

async function fulfillMallOrder(schemaName: string, client: { query: typeof pool.query }, order: Row, payData: Row) {
  const orderId = str(order.id);
  // Re-read the order with FOR UPDATE to get the latest committed state.
  // This prevents stale-data issues when callers (e.g. reconcileMallOrder) pass a snapshot read outside the transaction.
  const { rows: freshRows } = await client.query(`select * from ${table(schemaName, "mall_order")} where id = $1 and deleted = false for update`, [orderId]);
  const freshOrder = freshRows[0] ?? order;
  if (String(freshOrder.fulfillment_status) === "SUCCESS" && freshOrder.contract_id && freshOrder.funds_change_history_id) {
    return { orderId, idempotent: true, contractId: freshOrder.contract_id, fundsId: freshOrder.funds_change_history_id };
  }
  try {
    await client.query(`update ${table(schemaName, "mall_order")} set fulfillment_status = 'PROCESSING', fulfillment_error = null, updated_at = now() where id = $1`, [orderId]);
    const { rows: goodsRows } = await client.query(`select * from ${table(schemaName, "mall_goods")} where id = $1`, [freshOrder.goods_id]);
    const goods = goodsRows[0] ?? {};
    const productId = str(goods.product_id, "");
    if (!productId) throw new Error("商城商品未绑定产品，无法生成合同");
    let contractId = str(freshOrder.contract_id, "");
    if (!contractId) {
      // NOTE: executeCommandDsl runs in its own transaction, so if the caller's transaction
      // rolls back after this point, the contract persists as an orphan. On retry, the
      // fresh re-read above will have contract_id = null (rolled back), so a duplicate may be
      // created. Mitigation: the fulfillment_status guard + redis lock on callers serializes retries.
      const contractResult = await executeCommandDsl(schemaName, { operation: "command", command: "contract.create", ruleCode: "contract_create_rule" } as never, {
        __approvalApproved: true,
        data: {
          student_id: freshOrder.student_id,
          product_id: productId,
          total_amount: freshOrder.pay_amount,
          paid_amount: 0,
          contract_type: "MALL",
          sign_time: new Date().toISOString(),
          contract_products: [{ product_id: productId, plan_real_amount: freshOrder.pay_amount, total_amount: freshOrder.pay_amount }],
        },
      }) as Row;
      const contract = jsonObject(contractResult.contract);
      contractId = str(contract.id, `contract_mall_${Date.now()}`);
      await client.query(`update ${table(schemaName, "mall_order")} set contract_id = $2, callback_payload = callback_payload || $3::jsonb, updated_at = now() where id = $1`, [orderId, contractId, JSON.stringify({ fulfillmentContractId: contractId })]);
    }
    let fundsId = str(freshOrder.funds_change_history_id, "");
    if (!fundsId) {
      const fundsResult = await executeCommandDsl(schemaName, { operation: "command", command: "funds.create", ruleCode: "funds_create_rule" } as never, {
        __approvalApproved: true,
        data: {
          contract_id: contractId,
          student_id: freshOrder.student_id,
          transaction_amount: freshOrder.pay_amount,
          transaction_time: new Date().toISOString(),
          pay_way_config_id: "pay_wechat",
          funds_type: "CONTRACT_PAY",
          remark: `商城订单 ${orderId}`,
        },
      }) as Row;
      fundsId = str((jsonObject(fundsResult.funds ?? fundsResult)).id, `fund_mall_${Date.now()}`);
      await client.query(`update ${table(schemaName, "mall_order")} set funds_change_history_id = $2, callback_payload = callback_payload || $3::jsonb, updated_at = now() where id = $1`, [orderId, fundsId, JSON.stringify({ fulfillmentFundsId: fundsId })]);
    }
    await client.query(
      `update ${table(schemaName, "mall_order")} set order_status = 'PAID', payment_status = 'PAID', payment_trade_no = $2, paid_at = coalesce(paid_at, now()), contract_id = $3, funds_change_history_id = $4, fulfillment_status = 'SUCCESS', fulfillment_error = null, callback_payload = callback_payload || $5::jsonb, updated_at = now() where id = $1`,
      [orderId, str(payData.transaction_id ?? payData.out_trade_no, ""), contractId, fundsId, JSON.stringify({ fulfillmentPayData: payData })]
    );
    if (order.coupon_claim_id) {
      await client.query(`update ${table(schemaName, "coupon_claim")} set use_status = 'USED', used_at = now(), updated_at = now() where id = $1 and used_order_id = $2`, [order.coupon_claim_id, orderId]);
    }
    await savePayOrderIndex(schemaName, str(jsonObject(order.ext_json).bindingId, "wx_bind_public"), orderId, "PAID");
    return { orderId, contractId, fundsId, paymentStatus: "PAID" };
  } catch (error) {
    await client.query(`update ${table(schemaName, "mall_order")} set fulfillment_status = 'FAILED', fulfillment_error = $2, fulfillment_retry_count = coalesce(fulfillment_retry_count,0) + 1, updated_at = now() where id = $1`, [orderId, error instanceof Error ? error.message : String(error)]);
    throw error;
  }
}


export async function saveWechatThirdPlatformApp(params: Row) {
  const input = jsonObject(params.data ?? params);
  const id = str(input.id, `wx_component_${Date.now()}`);
  const secret = input.component_appsecret ? String(input.component_appsecret) : undefined;
  const token = input.token ? String(input.token) : undefined;
  const aesKey = input.encoding_aes_key ? String(input.encoding_aes_key) : undefined;
  await pool.query(
    `insert into admin.wechat_third_platform_app(id, app_name, component_appid, component_appsecret, token, encoding_aes_key, auth_redirect_domain, callback_domain, status, ext_json, deleted)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,false)
     on conflict (id) do update set app_name = excluded.app_name, component_appid = excluded.component_appid,
       component_appsecret = coalesce(excluded.component_appsecret, admin.wechat_third_platform_app.component_appsecret),
       token = coalesce(excluded.token, admin.wechat_third_platform_app.token),
       encoding_aes_key = coalesce(excluded.encoding_aes_key, admin.wechat_third_platform_app.encoding_aes_key),
       auth_redirect_domain = excluded.auth_redirect_domain, callback_domain = excluded.callback_domain, status = excluded.status,
       ext_json = excluded.ext_json, deleted = false, updated_at = now()`,
    [id, str(input.app_name, "微信第三方平台"), str(input.component_appid, "wx_component_demo"), secret ?? null, token ?? null, aesKey ?? null, input.auth_redirect_domain ?? null, input.callback_domain ?? null, str(input.status, "ACTIVE"), JSON.stringify(input.ext_json ?? {})]
  );
  return { id, saved: true };
}

export async function queryWechatThirdPlatformApps(params: Row) {
  const page = Math.max(Number(params.page ?? 1), 1);
  const pageSize = Math.min(Math.max(Number(params.pageSize ?? 20), 1), 100);
  const { rows } = await pool.query(
    `select id, app_name, component_appid, component_appsecret, token, encoding_aes_key, auth_redirect_domain, callback_domain, status, ext_json, updated_at, count(*) over() as __total
     from admin.wechat_third_platform_app where deleted = false order by updated_at desc limit $1 offset $2`,
    [pageSize, (page - 1) * pageSize]
  );
  return { rows: rows.map(({ __total, ...row }) => row), total: Number(rows[0]?.__total ?? 0), page, pageSize };
}


export async function processWechatComponentCallback(params: Row) {
  const componentAppid = str(params.component_appid ?? params.appid ?? params.appId, "");
  const app = await getPlatformApp(componentAppid);
  const rawXml = str(params.raw_xml ?? params.rawXml ?? params.xml, "");
  if (!rawXml) throw Object.assign(new Error("缺少微信第三方平台回调 XML"), { statusCode: 400 });
  const outer = parseXmlText(rawXml);
  const timestamp = str(params.timestamp);
  const nonce = str(params.nonce);
  const signature = str(params.msg_signature ?? params.signature);
  const encrypt = str(outer.Encrypt, "");
  if (signature) verifyWechatSignature(str(app.token), timestamp, nonce, signature, encrypt || undefined);
  const decryptedXml = encrypt ? decryptWechatComponentMessage(encrypt, str(app.encoding_aes_key)) : rawXml;
  const message = parseXmlText(decryptedXml);
  const infoType = str(message.InfoType);
  const ext = jsonObject(app.ext_json);
  if (infoType === "component_verify_ticket") {
    ext.component_verify_ticket = message.ComponentVerifyTicket;
    ext.component_verify_ticket_updated_at = new Date().toISOString();
    await savePlatformExt(String(app.id), ext);
  }
  if (["authorized", "updateauthorized", "unauthorized"].includes(infoType)) {
    ext.last_authorization_event = { infoType, authorizerAppid: message.AuthorizerAppid, authorizationCode: message.AuthorizationCode, createTime: message.CreateTime, receivedAt: new Date().toISOString() };
    await savePlatformExt(String(app.id), ext);
  }
  return { success: true, infoType, authorizerAppid: message.AuthorizerAppid ?? null };
}

export async function deleteWechatThirdPlatformApp(params: Row) {
  await pool.query(`update admin.wechat_third_platform_app set deleted = true, updated_at = now() where id = $1`, [params.id]);
  return { deleted: true, id: params.id };
}

export const defaultWechatMenu = {
  button: [
    { type: "view", name: "主页", url: "https://edu.example.com/wx/home" },
    { type: "view", name: "商城", url: "https://edu.example.com/wx/mall" },
  ],
};

export async function seedDefaultWechatBinding(client: { query: typeof pool.query }, schemaName: string) {
  const { rows } = await client.query(
    `select id, account_name, appid, component_appid, authorizer_appid, oauth_domain from admin.public_wechat_account
     where is_default = true and status = 'ACTIVE' and deleted = false order by updated_at desc limit 1`
  );
  const account = rows[0] ?? { id: "wx_public_default", account_name: "公有服务号", appid: "wx_public_demo", component_appid: "wx_component_demo", authorizer_appid: "wx_public_demo", oauth_domain: "edu.example.com" };
  await client.query(
    `insert into ${table(schemaName, "wechat_account_binding")}
       (id, account_name, appid, authorizer_appid, service_type, binding_type, authorized_status, public_account_id, component_appid, oauth_domain, is_default, menu_json, deleted)
     values($1,$2,$3,$4,'SERVICE_ACCOUNT','PUBLIC','AUTHORIZED',$5,$6,$7,true,$8::jsonb,false)
     on conflict (id) do update set account_name = excluded.account_name, appid = excluded.appid, authorizer_appid = excluded.authorizer_appid,
       public_account_id = excluded.public_account_id, component_appid = excluded.component_appid, oauth_domain = excluded.oauth_domain,
       is_default = true, menu_json = excluded.menu_json, deleted = false, updated_at = now()`,
    ["wx_bind_public", account.account_name, account.appid, account.authorizer_appid ?? account.appid, account.id, account.component_appid, account.oauth_domain, JSON.stringify(defaultWechatMenu)]
  );
  await client.query(
    `insert into ${table(schemaName, "wechat_menu_config")}(id, binding_id, menu_name, menu_json, publish_status, deleted)
     values($1,'wx_bind_public','默认双入口菜单',$2::jsonb,'DRAFT',false)
     on conflict (id) do update set menu_json = excluded.menu_json, deleted = false, updated_at = now()`,
    ["wx_menu_default", JSON.stringify(defaultWechatMenu)]
  );
}

export async function createWechatAuthorizeUrl(schemaName: string, params: Row) {
  const bindingId = str(params.id ?? params.binding_id, `wx_bind_${Date.now()}`);
  const componentAppid = str(params.component_appid, "");
  const authType = str(params.auth_type, "3");
  const { token, app } = await getComponentAccessToken(componentAppid);
  const preAuth = await wechatPost<Row>(`https://api.weixin.qq.com/cgi-bin/component/api_create_preauthcode?component_access_token=${encodeURIComponent(token)}`, {
    component_appid: app.component_appid,
  });
  const redirect = encodeURIComponent(str(params.redirect_uri, `https://${str(app.callback_domain, "edu.example.com")}/api/wechat/authorizer/callback?schemaName=${schemaName}&bindingId=${bindingId}`));
  const state = encodeURIComponent(Buffer.from(JSON.stringify({ schemaName, bindingId, t: Date.now() })).toString("base64url"));
  const qrAuthUrl = `https://mp.weixin.qq.com/cgi-bin/componentloginpage?component_appid=${encodeURIComponent(String(app.component_appid))}&pre_auth_code=${encodeURIComponent(str(preAuth.pre_auth_code))}&redirect_uri=${redirect}&auth_type=${encodeURIComponent(authType)}&state=${state}`;
  await pool.query(
    `insert into ${table(schemaName, "wechat_account_binding")}(id, account_name, component_appid, binding_type, authorized_status, qr_auth_url, is_default, menu_json, deleted)
     values($1,$2,$3,'TENANT_AUTHORIZED','PENDING_AUTH',$4,false,$5::jsonb,false)
     on conflict (id) do update set component_appid = excluded.component_appid, binding_type = 'TENANT_AUTHORIZED', authorized_status = 'PENDING_AUTH',
       qr_auth_url = excluded.qr_auth_url, deleted = false, updated_at = now()`,
    [bindingId, str(params.account_name, "待授权服务号"), app.component_appid, qrAuthUrl, JSON.stringify(defaultWechatMenu)]
  );
  return { bindingId, qrAuthUrl, preAuthCodeExpiresIn: Number(preAuth.expires_in ?? 600) };
}

export async function completeWechatAuthorization(schemaName: string, params: Row) {
  const bindingId = str(params.bindingId ?? params.binding_id ?? params.id, "");
  const authCode = str(params.auth_code ?? params.authorization_code ?? params.authCode, "");
  if (!bindingId) throw Object.assign(new Error("缺少绑定ID"), { statusCode: 400 });
  if (!authCode) throw Object.assign(new Error("缺少微信授权码 auth_code"), { statusCode: 400 });
  const current = await getBinding(schemaName, bindingId);
  const { token, app } = await getComponentAccessToken(str(current.component_appid ?? params.component_appid, ""));
  const data = await wechatPost<Row>(`https://api.weixin.qq.com/cgi-bin/component/api_query_auth?component_access_token=${encodeURIComponent(token)}`, {
    component_appid: app.component_appid,
    authorization_code: authCode,
  });
  const info = jsonObject(data.authorization_info);
  const ext = { ...jsonObject(current.ext_json), authorization_info: info, authorizer_refresh_token: info.authorizer_refresh_token, authorizer_access_token: info.authorizer_access_token };
  await pool.query(
    `update ${table(schemaName, "wechat_account_binding")}
     set account_name = coalesce($2, account_name), appid = coalesce($3, appid), authorizer_appid = coalesce($3, authorizer_appid),
       authorized_status = 'AUTHORIZED', access_token_expires_at = now() + ($4::int * interval '1 second'), ext_json = $5::jsonb, updated_at = now()
     where id = $1`,
    [bindingId, params.account_name ?? null, info.authorizer_appid ?? null, Number(info.expires_in ?? 7200), JSON.stringify(ext)]
  );
  return { bindingId, authorized: true, authorizerAppid: info.authorizer_appid, funcInfo: info.func_info ?? [] };
}


export async function setDefaultWechatBinding(schemaName: string, params: Row) {
  const bindingId = str(params.id ?? params.binding_id, "");
  if (!bindingId) throw Object.assign(new Error("缺少绑定ID"), { statusCode: 400 });
  await pool.query(`update ${table(schemaName, "wechat_account_binding")} set is_default = false where deleted = false`);
  await pool.query(`update ${table(schemaName, "wechat_account_binding")} set is_default = true, updated_at = now() where id = $1 and deleted = false`, [bindingId]);
  return { bindingId, isDefault: true };
}

export async function unbindWechatAccount(schemaName: string, params: Row) {
  const bindingId = str(params.id ?? params.binding_id, "");
  if (!bindingId) throw Object.assign(new Error("缺少绑定ID"), { statusCode: 400 });
  await pool.query(`update ${table(schemaName, "wechat_account_binding")} set authorized_status = 'UNBOUND', is_default = false, deleted = true, updated_at = now() where id = $1`, [bindingId]);
  return { bindingId, unbound: true };
}

export async function refreshWechatToken(schemaName: string, params: Row) {
  const bindingId = str(params.id ?? params.binding_id, "wx_bind_public");
  const binding = await getBinding(schemaName, bindingId);
  const ext = jsonObject(binding.ext_json);
  const refreshToken = str(ext.authorizer_refresh_token, "");
  if (!refreshToken) throw Object.assign(new Error("缺少 authorizer_refresh_token，请重新扫码授权"), { statusCode: 400 });
  const { token, app } = await getComponentAccessToken(str(binding.component_appid, ""));
  const data = await wechatPost<Row>(`https://api.weixin.qq.com/cgi-bin/component/api_authorizer_token?component_access_token=${encodeURIComponent(token)}`, {
    component_appid: app.component_appid,
    authorizer_appid: binding.authorizer_appid ?? binding.appid,
    authorizer_refresh_token: refreshToken,
  });
  ext.authorizer_access_token = data.authorizer_access_token;
  ext.authorizer_refresh_token = data.authorizer_refresh_token ?? refreshToken;
  await pool.query(`update ${table(schemaName, "wechat_account_binding")} set authorized_status = 'AUTHORIZED', access_token_expires_at = now() + ($2::int * interval '1 second'), ext_json = $3::jsonb, updated_at = now() where id = $1 and deleted = false`, [bindingId, Number(data.expires_in ?? 7200), JSON.stringify(ext)]);
  return { bindingId, authorizedStatus: "AUTHORIZED", accessTokenExpiresIn: Number(data.expires_in ?? 7200), authorizerAccessToken: data.authorizer_access_token };
}

export async function syncWechatAuthorizationStatus(schemaName: string, params: Row) {
  const bindingId = str(params.id ?? params.binding_id, "wx_bind_public");
  const binding = await getBinding(schemaName, bindingId);
  const expired = binding.access_token_expires_at ? new Date(String(binding.access_token_expires_at)).getTime() < Date.now() + 300_000 : true;
  if (expired) return refreshWechatToken(schemaName, { id: bindingId });
  return { bindingId, authorizedStatus: binding.authorized_status, tokenValid: true };
}

export async function createWechatOauthLoginUrl(schemaName: string, params: Row) {
  const bindingId = str(params.binding_id ?? params.bindingId, "wx_bind_public");
  const binding = await getBinding(schemaName, bindingId);
  const appid = str(binding.authorizer_appid ?? binding.appid, "");
  const redirectUri = encodeURIComponent(str(params.redirect_uri ?? params.redirect, `https://${str(binding.oauth_domain, "edu.example.com")}/api/wechat/oauth/callback`));
  const stateRaw = Buffer.from(JSON.stringify({ schemaName, bindingId, redirect: params.final_redirect ?? params.finalRedirect ?? `/${schemaName}/wx/home`, t: Date.now(), nonce: randomUUID() })).toString("base64url");
  await pool.query(`insert into ${table(schemaName, "wechat_oauth_session")}(id, binding_id, openid, state, session_token, expires_at, deleted) values($1,$2,'PENDING',$3,$4,now() + interval '10 minutes',false)`, [randomUUID(), bindingId, stateRaw, `pending_${randomUUID()}`]);
  return { url: `https://open.weixin.qq.com/connect/oauth2/authorize?appid=${encodeURIComponent(appid)}&redirect_uri=${redirectUri}&response_type=code&scope=${encodeURIComponent(str(params.scope, "snsapi_userinfo"))}&state=${encodeURIComponent(stateRaw)}#wechat_redirect` };
}

export async function completeWechatOauth(schemaName: string, params: Row) {
  const code = str(params.code, "");
  const bindingId = str(params.binding_id ?? params.bindingId, "wx_bind_public");
  if (!code) throw Object.assign(new Error("缺少微信 OAuth code"), { statusCode: 400 });
  const binding = await getBinding(schemaName, bindingId);
  const componentAppid = str(binding.component_appid, "");
  const { token } = await getComponentAccessToken(componentAppid);
  const url = `https://api.weixin.qq.com/sns/oauth2/component/access_token?appid=${encodeURIComponent(str(binding.authorizer_appid ?? binding.appid))}&code=${encodeURIComponent(code)}&grant_type=authorization_code&component_appid=${encodeURIComponent(componentAppid)}&component_access_token=${encodeURIComponent(token)}`;
  const response = await fetch(url);
  const oauth = await response.json() as Row & { errcode?: number; errmsg?: string };
  if (!response.ok || oauth.errcode) throw Object.assign(new Error(`微信 OAuth 失败: ${oauth.errmsg ?? response.statusText}`), { statusCode: 502, wechat: oauth });
  let profile: Row = {};
  if (oauth.access_token && oauth.openid) {
    const profileResponse = await fetch(`https://api.weixin.qq.com/sns/userinfo?access_token=${encodeURIComponent(String(oauth.access_token))}&openid=${encodeURIComponent(String(oauth.openid))}&lang=zh_CN`);
    profile = await profileResponse.json().catch(() => ({})) as Row;
  }
  const state = str(params.state, "");
  if (!state) throw Object.assign(new Error("缺少 OAuth state"), { statusCode: 400 });
  const { rows: stateRows } = await pool.query(
    `select * from ${table(schemaName, "wechat_oauth_session")} where state = $1 and binding_id = $2 and openid = 'PENDING' and expires_at > now() and deleted = false limit 1`,
    [state, bindingId]
  );
  if (!stateRows[0]) throw Object.assign(new Error("OAuth state 无效或已过期"), { statusCode: 401 });
  const sessionToken = randomUUID();
  await pool.query(
    `update ${table(schemaName, "wechat_oauth_session")}
     set openid = $2, unionid = $3, nickname = $4, avatar_url = $5, session_token = $6, expires_at = now() + interval '7 days', updated_at = now()
     where id = $1`,
    [stateRows[0].id, oauth.openid, oauth.unionid ?? profile.unionid ?? null, profile.nickname ?? null, profile.headimgurl ?? null, sessionToken]
  );
  return { openid: oauth.openid, unionid: oauth.unionid ?? profile.unionid, nickname: profile.nickname, avatarUrl: profile.headimgurl, bindingId, sessionToken };
}

export async function bindWechatOpenid(schemaName: string, params: Row) {
  const studentId = str(params.student_id ?? params.studentId, "");
  if (!studentId) throw Object.assign(new Error("缺少学员"), { statusCode: 400 });
  const directOpenid = str(params.openid, "");
  const session = directOpenid ? undefined : await getWechatSession(schemaName, params.session_token ?? params.sessionToken);
  const bindingId = str(params.binding_id ?? session?.binding_id, "wx_bind_public");
  const { rows: studentRows } = await pool.query(`select id, name, contact from ${table(schemaName, "student")} where id = $1 and deleted = false limit 1`, [studentId]);
  const student = studentRows[0];
  if (!student) throw Object.assign(new Error("学员不存在"), { statusCode: 404 });
  const verifyName = str(params.student_name ?? params.studentName, "");
  const verifyPhone = str(params.phone_last4 ?? params.phoneLast4 ?? params.verify_code ?? params.verifyCode, "");
  const contact = str(student.contact, "");
  if (verifyName && verifyName !== str(student.name)) throw Object.assign(new Error("学员姓名校验失败"), { statusCode: 400 });
  if (!verifyPhone || !contact.endsWith(verifyPhone)) throw Object.assign(new Error("手机号后四位校验失败"), { statusCode: 400 });
  const id = str(params.id, `fan_${Date.now()}`);
  await pool.query(
    `insert into ${table(schemaName, "wechat_student_fan")}(id, binding_id, student_id, openid, unionid, nickname, avatar_url, subscribe_status, bound_at, deleted)
     values($1,$2,$3,$4,$5,$6,$7,'SUBSCRIBED',now(),false)
     on conflict (binding_id, openid) do update set student_id = excluded.student_id, unionid = excluded.unionid, nickname = excluded.nickname, avatar_url = excluded.avatar_url, subscribe_status = 'SUBSCRIBED', bound_at = now(), deleted = false, updated_at = now()`,
    [id, bindingId, studentId, directOpenid || session?.openid, session?.unionid ?? null, session?.nickname ?? null, session?.avatar_url ?? null]
  );
  if (session?.id) {
    await pool.query(`update ${table(schemaName, "wechat_oauth_session")} set updated_at = now(), ext_json = coalesce(ext_json,'{}'::jsonb) || $2::jsonb where id = $1`, [session.id, JSON.stringify({ boundStudentId: studentId })]);
  }
  return { id, studentId, bound: true };
}

export async function createMallPaymentPayload(schemaName: string, order: Row, bindingId = "wx_bind_public") {
  const orderId = str(order.id ?? order.orderId, "");
  const amount = Math.round(num(order.pay_amount ?? order.payAmount, 0) * 100);
  const payConfig = await getPayConfig(schemaName, bindingId);
  const appid = str(payConfig.appid);
  const openid = str(order.openid, "");
  if (!openid) throw Object.assign(new Error("微信 JSAPI 支付需要订单 openid"), { statusCode: 400 });
  const body = {
    appid,
    mchid: str(payConfig.mchid),
    description: str(order.description, "课程商城订单"),
    out_trade_no: orderId,
    notify_url: appendQuery(str(payConfig.notify_url ?? payConfig.notifyUrl), { schemaName, bindingId }),
    amount: { total: amount, currency: "CNY" },
    payer: { openid },
  };
  const prepay = await wechatPayRequest("POST", "/v3/pay/transactions/jsapi", body, payConfig);
  const timeStamp = Math.floor(Date.now() / 1000).toString();
  const nonceStr = randomUUID().replace(/-/g, "");
  const packageValue = `prepay_id=${prepay.prepay_id}`;
  const privateKeyPem = String(payConfig.private_key_pem ?? payConfig.privateKeyPem).replace(/\\n/g, "\n");
  const signer = createSign("RSA-SHA256");
  signer.update(`${appid}\n${timeStamp}\n${nonceStr}\n${packageValue}\n`);
  signer.end();
  return { provider: "WECHAT_PAY", appId: appid, timeStamp, nonceStr, package: packageValue, signType: "RSA", paySign: signer.sign(privateKeyPem, "base64"), prepayId: prepay.prepay_id };
}

export async function publishWechatMenu(schemaName: string, params: Row) {
  const menuId = str(params.id ?? params.menu_id, "wx_menu_default");
  const { rows } = await pool.query(`select * from ${table(schemaName, "wechat_menu_config")} where id = $1 and deleted = false`, [menuId]);
  if (!rows[0]) throw Object.assign(new Error("菜单不存在"), { statusCode: 404 });
  const menuJson = jsonObject(rows[0].menu_json);
  const { token } = await getAuthorizerAccessToken(schemaName, str(rows[0].binding_id));
  const result = await wechatPost<Row>(`https://api.weixin.qq.com/cgi-bin/menu/create?access_token=${encodeURIComponent(token)}`, menuJson);
  await pool.query(
    `update ${table(schemaName, "wechat_menu_config")} set publish_status = 'PUBLISHED', last_published_at = now(), ext_json = jsonb_set(coalesce(ext_json,'{}'::jsonb), '{lastWechatResult}', $2::jsonb), updated_at = now() where id = $1`,
    [menuId, JSON.stringify(result)]
  );
  await pool.query(
    `update ${table(schemaName, "wechat_account_binding")} set menu_json = $2::jsonb, updated_at = now() where id = $1`,
    [rows[0].binding_id, JSON.stringify(menuJson)]
  );
  return { menuId, publishStatus: "PUBLISHED", menuJson, wechatResult: result };
}

export async function sendWechatTemplate(schemaName: string, params: Row) {
  const ruleId = str(params.rule_id ?? params.id, "");
  const event = str(params.business_event, "manual.test");
  const studentId = str(params.student_id, "");
  const ruleRows = ruleId ? (await pool.query(`select * from ${table(schemaName, "wechat_push_rule")} where id = $1 and deleted = false`, [ruleId])).rows : [];
  const fanRows = studentId ? (await pool.query(`select binding_id, openid from ${table(schemaName, "wechat_student_fan")} where student_id = $1 and deleted = false order by bound_at desc limit 1`, [studentId])).rows : [];
  const templateId = str(params.template_id ?? ruleRows[0]?.template_id, "");
  const openid = str(params.openid ?? fanRows[0]?.openid, "");
  if (!templateId || !openid) throw Object.assign(new Error("缺少模板ID或接收人 openid"), { statusCode: 400 });
  const ruleJson = jsonObject(ruleRows[0]?.rule_json);
  const payload = jsonObject(params.payload_json ?? params.payload ?? {});
  const fieldMap = jsonObject(ruleJson.fields);
  const mappedPayload = Object.keys(fieldMap).length
    ? Object.fromEntries(Object.entries(fieldMap).map(([key, source]) => [key, { value: payload[String(source)] ?? params[String(source)] ?? "" }]))
    : Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, typeof value === "object" ? value : { value }]));
  const logId = randomUUID();
  await pool.query(
    `insert into ${table(schemaName, "wechat_push_log")}(id, rule_id, business_event, business_id, student_id, openid, template_id, payload_json, send_status, retry_count)
     values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'PENDING',0)`,
    [logId, ruleId || null, event, params.business_id ?? null, studentId || null, openid, templateId, JSON.stringify(mappedPayload)]
  );
  try {
    const bindingId = str(params.binding_id ?? fanRows[0]?.binding_id, "wx_bind_public");
    const { token } = await getAuthorizerAccessToken(schemaName, bindingId);
    const result = await wechatPost<Row>(`https://api.weixin.qq.com/cgi-bin/message/template/send?access_token=${encodeURIComponent(token)}`, {
      touser: openid,
      template_id: templateId,
      url: params.url ?? ruleJson.url,
      miniprogram: params.miniprogram ?? ruleJson.miniprogram,
      data: mappedPayload,
    });
    await pool.query(`update ${table(schemaName, "wechat_push_log")} set send_status = 'SUCCESS', error_message = null, payload_json = payload_json || jsonb_build_object('wechatResult',$2::jsonb), updated_at = now() where id = $1`, [logId, JSON.stringify(result)]);
    return { logId, sendStatus: "SUCCESS", mappedPayload, wechatResult: result };
  } catch (error) {
    await pool.query(`update ${table(schemaName, "wechat_push_log")} set send_status = 'FAILED', error_message = $2, next_retry_at = now() + interval '5 minutes', updated_at = now() where id = $1`, [logId, error instanceof Error ? error.message : String(error)]);
    throw error;
  }
}

async function dispatchMarketingEventNow(schemaName: string, event: string, businessId: unknown, payload: Row = {}) {
  const { rows } = await pool.query(
    `select * from ${table(schemaName, "wechat_push_rule")} where status = 'ACTIVE' and deleted = false and (business_event = $1 or rule_json->'eventTypes' ? $1 or rule_json->'triggerTables' ? $2)`,
    [event, String(payload.table ?? "")]
  );
  const logs: unknown[] = [];
  for (const rule of rows) {
    logs.push(await sendWechatTemplate(schemaName, {
      rule_id: rule.id,
      business_event: event,
      business_id: businessId,
      student_id: payload.student_id,
      payload,
    }));
  }
  return { event, matchedRules: rows.length, logs };
}

export async function processMarketingEvent(schemaName: string, event: string, businessId: unknown, payload: Row = {}) {
  const id = randomUUID();
  await pool.query(
    `insert into ${table(schemaName, "marketing_event_outbox")}(id, event_type, business_id, student_id, payload_json, event_status, retry_count, next_retry_at, deleted)
     values($1,$2,$3,$4,$5::jsonb,'PENDING',0,now(),false)`,
    [id, event, businessId ? String(businessId) : null, payload.student_id ? String(payload.student_id) : null, JSON.stringify(payload)]
  );
  return { event, outboxId: id, queued: true };
}

export async function processMarketingOutbox(schemaName: string, params: Row = {}) {
  const limit = Math.min(Math.max(num(params.limit, 20), 1), 100);
  const { rows } = await pool.query(
    `select * from ${table(schemaName, "marketing_event_outbox")}
     where deleted = false and event_status in ('PENDING','FAILED') and coalesce(retry_count,0) < 5 and (next_retry_at is null or next_retry_at <= now())
     order by created_at limit $1`,
    [limit]
  );
  const results: unknown[] = [];
  for (const row of rows) {
    await withRedisLock(`lock:${schemaName}:marketing:outbox:${row.id}`, async () => {
      try {
        await pool.query(`update ${table(schemaName, "marketing_event_outbox")} set event_status = 'PROCESSING', locked_at = now(), updated_at = now() where id = $1`, [row.id]);
        const result = await dispatchMarketingEventNow(schemaName, str(row.event_type), row.business_id, jsonObject(row.payload_json));
        await pool.query(`update ${table(schemaName, "marketing_event_outbox")} set event_status = 'SUCCESS', error_message = null, updated_at = now() where id = $1`, [row.id]);
        results.push({ id: row.id, status: "SUCCESS", result });
      } catch (error) {
        const retryCount = Number(row.retry_count ?? 0) + 1;
        const dead = retryCount >= 5;
        await pool.query(
          `update ${table(schemaName, "marketing_event_outbox")} set event_status = $2, retry_count = $3, error_message = $4, next_retry_at = case when $2 = 'DEAD' then null else now() + ($3 * interval '5 minutes') end, updated_at = now() where id = $1`,
          [row.id, dead ? "DEAD" : "FAILED", retryCount, error instanceof Error ? error.message : String(error)]
        );
        results.push({ id: row.id, status: dead ? "DEAD" : "FAILED" });
      }
    });
  }
  return { processed: results.length, results };
}


export async function retryWechatPushFailures(schemaName: string) {
  const { rows } = await pool.query(`select * from ${table(schemaName, "wechat_push_log")} where send_status = 'FAILED' and coalesce(retry_count,0) < 3 and (next_retry_at is null or next_retry_at <= now()) and deleted = false order by created_at limit 20`);
  const retried: unknown[] = [];
  for (const row of rows) {
    try {
      const result = await sendWechatTemplate(schemaName, { rule_id: row.rule_id, business_event: row.business_event, business_id: row.business_id, student_id: row.student_id, openid: row.openid, template_id: row.template_id, payload: row.payload_json });
      await pool.query(`update ${table(schemaName, "wechat_push_log")} set retry_count = coalesce(retry_count,0) + 1, updated_at = now() where id = $1`, [row.id]);
      retried.push({ logId: row.id, result });
    } catch (error) {
      await pool.query(`update ${table(schemaName, "wechat_push_log")} set retry_count = coalesce(retry_count,0) + 1, error_message = $2, next_retry_at = now() + (least(coalesce(retry_count,0) + 1, 6) * interval '5 minutes'), updated_at = now() where id = $1`, [row.id, error instanceof Error ? error.message : String(error)]);
      retried.push({ logId: row.id, sendStatus: "FAILED" });
    }
  }
  return { retried };
}


function couponDiscount(template: Row, amount: number) {
  const rule = jsonObject(template.rule_json);
  const minAmount = num(rule.minAmount ?? rule.min_amount, 0);
  if (minAmount > 0 && amount < minAmount) throw Object.assign(new Error(`订单金额未达到优惠券使用门槛 ${minAmount}`), { statusCode: 400 });
  const couponType = str(template.coupon_type, "AMOUNT");
  const discountAmount = num(template.discount_amount, 0);
  const discountRate = num(template.discount_rate, 0);
  if (couponType === "DISCOUNT" && discountRate > 0) return Math.min(amount, Math.max(amount - amount * discountRate / 10, 0));
  return Math.min(amount, Math.max(discountAmount, 0));
}

function assertCouponApplies(template: Row, context: { goodsId: string; activityId?: string; productId?: string }) {
  const rule = jsonObject(template.rule_json);
  const goodsIds = Array.isArray(rule.goodsIds) ? rule.goodsIds.map(String) : Array.isArray(rule.goods_ids) ? rule.goods_ids.map(String) : [];
  const activityIds = Array.isArray(rule.activityIds) ? rule.activityIds.map(String) : Array.isArray(rule.activity_ids) ? rule.activity_ids.map(String) : [];
  const productIds = Array.isArray(rule.productIds) ? rule.productIds.map(String) : Array.isArray(rule.product_ids) ? rule.product_ids.map(String) : [];
  if (goodsIds.length && !goodsIds.includes(context.goodsId)) throw Object.assign(new Error("优惠券不适用于该商品"), { statusCode: 400 });
  if (activityIds.length && (!context.activityId || !activityIds.includes(context.activityId))) throw Object.assign(new Error("优惠券不适用于该活动"), { statusCode: 400 });
  if (productIds.length && (!context.productId || !productIds.includes(context.productId))) throw Object.assign(new Error("优惠券不适用于该产品"), { statusCode: 400 });
}

async function resolveStudentByWechatSession(schemaName: string, sessionToken: unknown) {
  const session = await getWechatSession(schemaName, sessionToken);
  const bindingId = str(session.binding_id, "wx_bind_public");
  const { rows } = await pool.query(
    `select * from ${table(schemaName, "wechat_student_fan")} where binding_id = $1 and openid = $2 and deleted = false limit 1`,
    [bindingId, session.openid]
  );
  const fan = rows[0];
  if (!fan?.student_id) throw Object.assign(new Error("请先完成微信 openid 与学员绑定"), { statusCode: 401 });
  return { session, bindingId, studentId: str(fan.student_id) };
}

export async function claimCoupon(schemaName: string, params: Row) {
  const templateId = str(params.coupon_template_id ?? params.couponTemplateId ?? params.template_id ?? params.templateId, "");
  if (!templateId) throw Object.assign(new Error("缺少优惠券模板"), { statusCode: 400 });
  const studentId = str(params.student_id ?? params.studentId, "") || (await resolveStudentByWechatSession(schemaName, params.session_token ?? params.sessionToken)).studentId;
  return withRedisLock(`lock:${schemaName}:coupon:claim:${templateId}:${studentId}`, () => withClient(async (client) => {
    await client.query("begin");
    try {
      const { rows } = await client.query(`select * from ${table(schemaName, "coupon_template")} where id = $1 and deleted = false and status = 'ACTIVE' for update`, [templateId]);
      const template = rows[0];
      if (!template) throw Object.assign(new Error("优惠券不存在或未启用"), { statusCode: 404 });
      const now = Date.now();
      if (template.valid_from && new Date(String(template.valid_from)).getTime() > now) throw Object.assign(new Error("优惠券尚未开始领取"), { statusCode: 400 });
      if (template.valid_to && new Date(String(template.valid_to)).getTime() < now) throw Object.assign(new Error("优惠券已过期"), { statusCode: 400 });
      const rule = jsonObject(template.rule_json);
      const perStudentLimit = num(rule.perStudentLimit ?? rule.per_student_limit, 1);
      if (perStudentLimit > 0) {
        const claimed = await client.query(`select count(*)::int as count from ${table(schemaName, "coupon_claim")} where coupon_template_id = $1 and student_id = $2 and deleted = false`, [templateId, studentId]);
        if (Number(claimed.rows[0]?.count ?? 0) >= perStudentLimit) throw Object.assign(new Error("已达到该优惠券领取上限"), { statusCode: 400 });
      }
      if (Number(template.total_qty ?? 0) > 0 && Number(template.claimed_qty ?? 0) >= Number(template.total_qty ?? 0)) throw Object.assign(new Error("优惠券已领完"), { statusCode: 400 });
      const claimId = str(params.id, randomUUID());
      const couponCode = str(params.coupon_code ?? params.couponCode, `CP${Date.now()}${Math.floor(Math.random() * 1000).toString().padStart(3, "0")}`);
      const inserted = await client.query(
        `insert into ${table(schemaName, "coupon_claim")}(id, coupon_template_id, student_id, coupon_code, claim_time, use_status, ext_json)
         values($1,$2,$3,$4,now(),'UNUSED',$5::jsonb) returning *`,
        [claimId, templateId, studentId, couponCode, JSON.stringify({ source: params.source ?? "manual" })]
      );
      await client.query(`update ${table(schemaName, "coupon_template")} set claimed_qty = coalesce(claimed_qty,0) + 1, updated_at = now() where id = $1`, [templateId]);
      await client.query("commit");
      return { coupon: inserted.rows[0] };
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  }));
}

export async function listAvailableCoupons(schemaName: string, params: Row) {
  const studentId = str(params.student_id ?? params.studentId, "") || (await resolveStudentByWechatSession(schemaName, params.session_token ?? params.sessionToken)).studentId;
  const goodsId = str(params.goods_id ?? params.goodsId, "");
  const activityId = str(params.activity_id ?? params.activityId, "");
  const orderAmount = num(params.amount ?? params.orderAmount, 0);
  const productId = goodsId ? str((await pool.query(`select product_id from ${table(schemaName, "mall_goods")} where id = $1 and deleted = false limit 1`, [goodsId])).rows[0]?.product_id, "") : "";
  const { rows } = await pool.query(
    `select cc.*, ct.coupon_name, ct.coupon_type, ct.discount_amount, ct.discount_rate, ct.valid_from, ct.valid_to, ct.rule_json
     from ${table(schemaName, "coupon_claim")} cc
     join ${table(schemaName, "coupon_template")} ct on ct.id = cc.coupon_template_id and ct.deleted = false
     where cc.student_id = $1 and cc.deleted = false and cc.use_status = 'UNUSED' and ct.status = 'ACTIVE'
       and (ct.valid_from is null or ct.valid_from <= now()) and (ct.valid_to is null or ct.valid_to >= now())
     order by ct.valid_to nulls last, cc.claim_time desc`,
    [studentId]
  );
  const coupons = rows.map((row) => {
    try {
      if (goodsId) assertCouponApplies(row, { goodsId, activityId, productId });
      const discountAmount = orderAmount > 0 ? couponDiscount(row, orderAmount) : num(row.discount_amount, 0);
      return { ...row, available: true, discountAmount };
    } catch (error) {
      return { ...row, available: false, unavailableReason: error instanceof Error ? error.message : String(error) };
    }
  });
  return { coupons };
}

async function reserveCouponForOrder(client: { query: typeof pool.query }, schemaName: string, input: { couponClaimId?: string; couponCode?: string; studentId: string; goodsId: string; activityId?: string; productId?: string; amount: number; orderId: string }) {
  if (!input.couponClaimId && !input.couponCode) return { payAmount: input.amount, discountAmount: 0 };
  const { rows } = await client.query(
    `select cc.*, ct.coupon_name, ct.coupon_type, ct.discount_amount, ct.discount_rate, ct.valid_from, ct.valid_to, ct.rule_json, ct.status as template_status
     from ${table(schemaName, "coupon_claim")} cc
     join ${table(schemaName, "coupon_template")} ct on ct.id = cc.coupon_template_id and ct.deleted = false
     where cc.deleted = false and cc.student_id = $1 and (($2::text <> '' and cc.id = $2) or ($3::text <> '' and cc.coupon_code = $3))
     for update of cc`,
    [input.studentId, input.couponClaimId ?? "", input.couponCode ?? ""]
  );
  const coupon = rows[0];
  if (!coupon) throw Object.assign(new Error("优惠券不存在"), { statusCode: 404 });
  if (String(coupon.use_status) !== "UNUSED") throw Object.assign(new Error("优惠券已使用或已锁定"), { statusCode: 400 });
  if (String(coupon.template_status) !== "ACTIVE") throw Object.assign(new Error("优惠券未启用"), { statusCode: 400 });
  const now = Date.now();
  if (coupon.valid_from && new Date(String(coupon.valid_from)).getTime() > now) throw Object.assign(new Error("优惠券尚未生效"), { statusCode: 400 });
  if (coupon.valid_to && new Date(String(coupon.valid_to)).getTime() < now) throw Object.assign(new Error("优惠券已过期"), { statusCode: 400 });
  assertCouponApplies(coupon, input);
  const discountAmount = couponDiscount(coupon, input.amount);
  const payAmount = Math.max(input.amount - discountAmount, 0);
  await client.query(`update ${table(schemaName, "coupon_claim")} set use_status = 'RESERVED', used_order_id = $2, updated_at = now() where id = $1`, [coupon.id, input.orderId]);
  return { couponClaimId: str(coupon.id), couponCode: str(coupon.coupon_code), couponName: str(coupon.coupon_name), discountAmount, payAmount };
}


export async function submitLandingLead(schemaName: string, params: Row) {
  const pageId = str(params.page_id ?? params.pageId ?? params.landing_page_id ?? params.landingPageId, "");
  const name = str(params.name ?? params.student_name ?? params.studentName, "");
  const contact = str(params.contact ?? params.phone ?? params.mobile, "");
  if (!pageId) throw Object.assign(new Error("缺少活动落地页"), { statusCode: 400 });
  if (!name || !contact) throw Object.assign(new Error("提交意向学员必须填写姓名和电话"), { statusCode: 400 });
  return withRedisLock(`lock:${schemaName}:landing:lead:${pageId}:${contact}`, () => withClient(async (client) => {
    await client.query("begin");
    try {
      const { rows: pageRows } = await client.query(`select * from ${table(schemaName, "marketing_landing_page")} where id = $1 and deleted = false for update`, [pageId]);
      const landing = pageRows[0];
      if (!landing) throw Object.assign(new Error("活动落地页不存在"), { statusCode: 404 });
      if (!["PUBLISHED", "ACTIVE"].includes(str(landing.publish_status, "DRAFT"))) throw Object.assign(new Error("活动落地页未发布"), { statusCode: 400 });
      const channelId = str(params.channel_id ?? params.channelId ?? landing.channel_id, "");
      const { rows: existingRows } = await client.query(
        `select id from ${table(schemaName, "student")} where contact = $1 and deleted = false order by created_at desc limit 1`,
        [contact]
      );
      const studentId = str(existingRows[0]?.id, `lead_${Date.now()}`);
      if (existingRows[0]) {
        await client.query(
          `update ${table(schemaName, "student")}
           set name = coalesce(nullif($2,''), name), student_status = case when student_status = 'FORMAL' then student_status else 'LEAD' end,
               source_type = coalesce(nullif(source_type,''), 'LANDING_PAGE'), school_name = coalesce($3, school_name), grade = coalesce($4, grade), updated_at = now(),
               ext_json = coalesce(ext_json,'{}'::jsonb) || $5::jsonb
           where id = $1`,
          [studentId, name, params.school_name ?? params.schoolName ?? null, params.grade ?? null, JSON.stringify({ landingPageId: pageId, channelId, formData: params.form_data ?? params.formData ?? {} })]
        );
      } else {
        await client.query(
          `insert into ${table(schemaName, "student")}(id, name, contact, student_status, source_type, school_name, grade, ext_json)
           values($1,$2,$3,'LEAD','LANDING_PAGE',$4,$5,$6::jsonb)`,
          [studentId, name, contact, params.school_name ?? params.schoolName ?? null, params.grade ?? null, JSON.stringify({ landingPageId: pageId, channelId, formData: params.form_data ?? params.formData ?? {} })]
        );
      }
      await client.query(
        `insert into ${table(schemaName, "lead_stage_record")}(id, student_id, stage, channel_id, next_action, status, ext_json)
         values($1,$2,'NEW',$3,'首次跟进','OPEN',$4::jsonb)`,
        [randomUUID(), studentId, channelId || null, JSON.stringify({ source: "landing_page", landingPageId: pageId })]
      );
      await client.query(`update ${table(schemaName, "marketing_landing_page")} set lead_count = coalesce(lead_count,0) + 1, updated_at = now() where id = $1`, [pageId]);
      if (channelId) await client.query(`update ${table(schemaName, "recruit_channel")} set lead_count = coalesce(lead_count,0) + 1, updated_at = now() where id = $1 and deleted = false`, [channelId]);
      const referrerStudentId = str(params.referrer_student_id ?? params.referrerStudentId, "");
      if (referrerStudentId && referrerStudentId !== studentId) {
        await client.query(
          `insert into ${table(schemaName, "referral_reward")}(id, referrer_student_id, referred_student_id, reward_type, reward_status, ext_json)
           values($1,$2,$3,$4,'PENDING',$5::jsonb)`,
          [randomUUID(), referrerStudentId, studentId, str(params.reward_type ?? params.rewardType, "COUPON"), JSON.stringify({ source: "landing_page", landingPageId: pageId })]
        );
      }
      await client.query("commit");
      return { studentId, leadCreated: !existingRows[0], landingPageId: pageId, channelId: channelId || null };
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  }));
}

export async function createMallOrder(schemaName: string, params: Row) {
  const goodsIdForLock = str(params.goods_id ?? params.goodsId, "");
  const activityIdForLock = str(params.activity_id ?? params.activityId, "none");
  const resolved = await resolveStudentByWechatSession(schemaName, params.session_token ?? params.sessionToken);
  const session = resolved.session;
  const bindingId = str(params.binding_id ?? resolved.bindingId, "wx_bind_public");
  const studentIdForLock = resolved.studentId;
  return withRedisLock(`lock:${schemaName}:mall:order:${goodsIdForLock}:${activityIdForLock}:${studentIdForLock}`, () => withClient(async (client) => {
    await client.query("begin");
    try {
      const goodsId = str(params.goods_id ?? params.goodsId, "");
      const studentId = studentIdForLock;
      if (!goodsId || !studentId) throw Object.assign(new Error("缺少商品或学员"), { statusCode: 400 });
      const { rows: goodsRows } = await client.query(`select * from ${table(schemaName, "mall_goods")} where id = $1 and deleted = false for update`, [goodsId]);
      const goods = goodsRows[0];
      if (!goods) throw Object.assign(new Error("商品不存在"), { statusCode: 404 });
      if (String(goods.goods_status) !== "ON_SALE") throw Object.assign(new Error("商品未上架"), { statusCode: 400 });
      const quantity = Math.max(1, Math.floor(num(params.quantity, 1)));
      if (Number(goods.stock_qty ?? 0) < quantity) throw Object.assign(new Error("库存不足"), { statusCode: 400 });
      const activityId = str(params.activity_id ?? params.activityId, "");
      const activityRows = activityId ? (await client.query(`select * from ${table(schemaName, "mall_activity")} where id = $1 and status = 'ACTIVE' and deleted = false for update`, [activityId])).rows : [];
      const activity = activityRows[0];
      if (activity) {
        const now = Date.now();
        if (activity.start_time && new Date(String(activity.start_time)).getTime() > now) throw Object.assign(new Error("活动未开始"), { statusCode: 400 });
        if (activity.end_time && new Date(String(activity.end_time)).getTime() < now) throw Object.assign(new Error("活动已结束"), { statusCode: 400 });
        const quota = Number(activity.quota_qty ?? 0);
        if (quota > 0 && Number(activity.sold_qty ?? 0) + quantity > quota) throw Object.assign(new Error("活动库存不足"), { statusCode: 400 });
        const perStudentLimit = Number(jsonObject(activity.rule_json).perStudentLimit ?? 0);
        if (perStudentLimit > 0) {
          const { rows: boughtRows } = await client.query(`select coalesce(sum(quantity),0)::int as qty from ${table(schemaName, "mall_order")} where student_id = $1 and activity_id = $2 and deleted = false and order_status <> 'CLOSED'`, [studentId, activityId]);
          if (Number(boughtRows[0]?.qty ?? 0) + quantity > perStudentLimit) throw Object.assign(new Error("超过每人限购数量"), { statusCode: 400 });
        }
      }
      const orderId = randomUUID();
      const orderNo = `MO${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}${Math.floor(Math.random() * 1000).toString().padStart(3, "0")}`;
      const originalAmount = Math.round(Number(activity?.activity_price ?? goods.sale_price ?? 0) * quantity * 100) / 100;
      const coupon = await reserveCouponForOrder(client, schemaName, {
        couponClaimId: str(params.coupon_claim_id ?? params.couponClaimId, ""),
        couponCode: str(params.coupon_code ?? params.couponCode, ""),
        studentId,
        goodsId,
        activityId,
        productId: str(goods.product_id, ""),
        amount: originalAmount,
        orderId
      });
      const payAmount = coupon.payAmount;
      if (payAmount <= 0) throw Object.assign(new Error("优惠后订单金额必须大于 0"), { statusCode: 400 });
      await client.query(`update ${table(schemaName, "mall_goods")} set stock_qty = stock_qty - $2, updated_at = now() where id = $1`, [goodsId, quantity]);
      if (activity) await client.query(`update ${table(schemaName, "mall_activity")} set sold_qty = sold_qty + $2, updated_at = now() where id = $1`, [activity.id, quantity]);
      await client.query(
        `insert into ${table(schemaName, "mall_order")}(id, order_no, student_id, goods_id, activity_id, openid, quantity, original_amount, coupon_claim_id, coupon_discount_amount, pay_amount, order_status, payment_status, ext_json)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'CREATED','UNPAID',$12::jsonb)`,
        [orderId, orderNo, studentId, goodsId, activityId || null, session.openid, quantity, originalAmount, coupon.couponClaimId ?? null, coupon.discountAmount, payAmount, JSON.stringify({ bindingId, oauthSessionId: session.id, coupon })]
      );
      let groupId: string | undefined;
      if (activity && String(activity.activity_type) === "GROUP_BUY") {
        groupId = str(params.group_id ?? params.groupId, "");
        if (groupId) {
          const dup = await client.query(`select 1 from ${table(schemaName, "mall_group_member")} where group_id = $1 and student_id = $2 and deleted = false limit 1`, [groupId, studentId]);
          if (dup.rows[0]) throw Object.assign(new Error("该学员已参团"), { statusCode: 400 });
          const updatedGroup = await client.query(`update ${table(schemaName, "mall_group_buy")} set joined_count = joined_count + 1, group_status = case when joined_count + 1 >= group_size then 'SUCCESS' else group_status end, success_at = case when joined_count + 1 >= group_size then now() else success_at end, updated_at = now() where id = $1 and deleted = false and group_status = 'OPEN' and (expires_at is null or expires_at > now()) returning *`, [groupId]);
          if (!updatedGroup.rows[0]) throw Object.assign(new Error("团不存在或已结束"), { statusCode: 400 });
        } else {
          groupId = randomUUID();
          await client.query(`insert into ${table(schemaName, "mall_group_buy")}(id, activity_id, goods_id, leader_student_id, group_status, group_size, joined_count, expires_at) values($1,$2,$3,$4,'OPEN',$5,1,now() + interval '24 hours')`, [groupId, activity.id, goodsId, studentId, Number(activity.group_size ?? 2)]);
        }
        await client.query(`insert into ${table(schemaName, "mall_group_member")}(id, group_id, order_id, student_id, member_status) values($1,$2,$3,$4,'JOINED')`, [randomUUID(), groupId, orderId, studentId]);
      }
      const payment = await createMallPaymentPayload(schemaName, { id: orderId, pay_amount: payAmount, openid: session.openid, description: goods.goods_name }, bindingId);
      await savePayOrderIndex(schemaName, bindingId, orderId, "CREATED");
      await client.query("commit");
      return { orderId, orderNo, payAmount, originalAmount: payAmount + Number(coupon.discountAmount ?? 0), coupon, paymentStatus: "UNPAID", groupId, payment };
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  }));
}

export async function handleMallPayCallback(schemaName: string, params: Row) {
  const callbackKey = str(params.order_id ?? params.id ?? params.out_trade_no ?? createHash("sha256").update(str(params.rawBody ?? params.__rawBody, randomUUID())).digest("hex"), "unknown");
  return withRedisLock(`lock:${schemaName}:mall:pay:${callbackKey}`, () => withClient(async (client) => {
    await client.query("begin");
    try {
      const payData = await parseWechatPayCallback(schemaName, params);
      const orderId = str(payData.out_trade_no ?? params.order_id ?? params.id, "");
      const { rows: orderRows } = await client.query(`select * from ${table(schemaName, "mall_order")} where id = $1 and deleted = false for update`, [orderId]);
      const order = orderRows[0];
      if (!order) throw Object.assign(new Error("订单不存在"), { statusCode: 404 });
      const paidFen = Number(jsonObject(payData.amount).total ?? 0);
      if (paidFen > 0 && paidFen !== Math.round(Number(order.pay_amount ?? 0) * 100)) throw Object.assign(new Error("微信支付金额与订单金额不一致"), { statusCode: 400 });
      const result = await fulfillMallOrder(schemaName, client, order, { ...payData, headers: params.headers });
      await client.query("commit");
      await processMarketingEvent(schemaName, "mall.order.paid", orderId, { student_id: order.student_id, amount: order.pay_amount });
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  }));
}

export async function queryMallOrderStatus(schemaName: string, params: Row) {
  const orderId = str(params.order_id ?? params.orderId ?? params.id, "");
  const orderNo = str(params.order_no ?? params.orderNo, "");
  if (!orderId && !orderNo) throw Object.assign(new Error("缺少订单ID或订单号"), { statusCode: 400 });
  const { rows } = await pool.query(
    `select id, order_no, order_status, payment_status, fulfillment_status, fulfillment_error, fulfillment_retry_count, contract_id, funds_change_history_id, original_amount, coupon_claim_id, coupon_discount_amount, pay_amount, paid_at, updated_at
     from ${table(schemaName, "mall_order")} where deleted = false and (($1::text <> '' and id = $1) or ($2::text <> '' and order_no = $2)) limit 1`,
    [orderId, orderNo]
  );
  if (!rows[0]) throw Object.assign(new Error("订单不存在"), { statusCode: 404 });
  return { order: rows[0] };
}

export async function retryMallOrderFulfillment(schemaName: string, params: Row) {
  const orderId = str(params.order_id ?? params.orderId ?? params.id, "");
  if (!orderId) throw Object.assign(new Error("缺少订单ID"), { statusCode: 400 });
  return withRedisLock(`lock:${schemaName}:mall:fulfill:${orderId}`, () => withClient(async (client) => {
    await client.query("begin");
    try {
      const { rows } = await client.query(`select * from ${table(schemaName, "mall_order")} where id = $1 and deleted = false for update`, [orderId]);
      const order = rows[0];
      if (!order || String(order.payment_status) !== "PAID") throw Object.assign(new Error("仅已支付订单可重试履约"), { statusCode: 400 });
      const result = await fulfillMallOrder(schemaName, client, order, jsonObject(order.callback_payload));
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  }));
}

export async function reconcileMallOrder(schemaName: string, params: Row) {
  const orderId = str(params.order_id ?? params.orderId ?? params.id, "");
  if (!orderId) throw Object.assign(new Error("缺少订单ID"), { statusCode: 400 });
  const ext_bindingId = str(params.binding_id ?? params.bindingId, "");
  const payConfig = await getPayConfig(schemaName, ext_bindingId || "wx_bind_public");
  const query = await wechatPayRequest("GET", `/v3/pay/transactions/out-trade-no/${encodeURIComponent(orderId)}?mchid=${encodeURIComponent(str(payConfig.mchid))}`, undefined, payConfig);
  if (String(query.trade_state) === "SUCCESS") {
    return withClient(async (client) => {
      await client.query("begin");
      try {
        const { rows: orderRows } = await client.query(`select * from ${table(schemaName, "mall_order")} where id = $1 and deleted = false for update`, [orderId]);
        const freshOrder = orderRows[0];
        if (!freshOrder) throw Object.assign(new Error("订单不存在"), { statusCode: 404 });
        const result = await fulfillMallOrder(schemaName, client, freshOrder, query);
        await client.query("commit");
        return { reconciled: true, result, wechatPay: query };
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    });
  }
  return { reconciled: false, orderId, tradeState: query.trade_state, wechatPay: query };
}



export async function closeMallOrder(schemaName: string, params: Row) {
  const orderId = str(params.order_id ?? params.orderId ?? params.id, "");
  if (!orderId) throw Object.assign(new Error("缺少订单ID"), { statusCode: 400 });
  return withRedisLock(`lock:${schemaName}:mall:close:${orderId}`, () => withClient(async (client) => {
    await client.query("begin");
    try {
      const { rows: orderRows } = await client.query(`select * from ${table(schemaName, "mall_order")} where id = $1 and deleted = false for update`, [orderId]);
      const order = orderRows[0];
      if (!order) throw Object.assign(new Error("订单不存在"), { statusCode: 404 });
      if (String(order.payment_status) === "PAID") throw Object.assign(new Error("已支付订单不可关闭"), { statusCode: 400 });
      if (String(order.payment_status) === "CLOSED" || String(order.order_status) === "CLOSED") {
        await client.query("commit");
        return { orderId, orderStatus: "CLOSED", idempotent: true };
      }
      const ext = jsonObject(order.ext_json);
      const payConfig = await getPayConfig(schemaName, str(params.binding_id ?? params.bindingId ?? ext.bindingId, "wx_bind_public"));
      await wechatPayRequest("POST", `/v3/pay/transactions/out-trade-no/${encodeURIComponent(orderId)}/close`, { mchid: str(payConfig.mchid) }, payConfig);
      const { rows } = await client.query(`update ${table(schemaName, "mall_order")} set order_status = 'CLOSED', payment_status = 'CLOSED', updated_at = now() where id = $1 and deleted = false and payment_status <> 'PAID' returning *`, [orderId]);
      if (!rows[0]) throw Object.assign(new Error("订单关闭失败，请刷新后重试"), { statusCode: 409 });
      await client.query(`update ${table(schemaName, "mall_goods")} set stock_qty = stock_qty + $2, updated_at = now() where id = $1`, [rows[0].goods_id, Number(rows[0].quantity ?? 1)]);
      if (rows[0].activity_id) await client.query(`update ${table(schemaName, "mall_activity")} set sold_qty = greatest(sold_qty - $2, 0), updated_at = now() where id = $1`, [rows[0].activity_id, Number(rows[0].quantity ?? 1)]);
      if (rows[0].coupon_claim_id) await client.query(`update ${table(schemaName, "coupon_claim")} set use_status = 'UNUSED', used_order_id = null, updated_at = now() where id = $1 and use_status = 'RESERVED'`, [rows[0].coupon_claim_id]);
      await savePayOrderIndex(schemaName, str(ext.bindingId, "wx_bind_public"), orderId, "CLOSED");
      await client.query("commit");
      return { orderId, orderStatus: "CLOSED" };
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  }));
}

export async function refundMallOrder(schemaName: string, params: Row) {
  const orderId = str(params.order_id ?? params.id, "");
  if (!orderId) throw Object.assign(new Error("缺少订单ID"), { statusCode: 400 });
  return withRedisLock(`lock:${schemaName}:mall:refund:${orderId}`, () => withClient(async (client) => {
    await client.query("begin");
    try {
      const { rows } = await client.query(`select * from ${table(schemaName, "mall_order")} where id = $1 and deleted = false for update`, [orderId]);
      const order = rows[0];
      if (!order || String(order.payment_status) !== "PAID") throw Object.assign(new Error("仅已支付订单可退款"), { statusCode: 400 });
      const refundId = `refund_mall_${Date.now()}`;
      const payConfig = await getPayConfig(schemaName, str(params.binding_id, "wx_bind_public"));
      await wechatPayRequest("POST", "/v3/refund/domestic/refunds", {
        out_trade_no: orderId,
        out_refund_no: refundId,
        reason: str(params.reason, "商城订单退款"),
        notify_url: str(payConfig.refund_notify_url ?? payConfig.refundNotifyUrl ?? payConfig.notify_url ?? payConfig.notifyUrl),
        amount: { refund: Math.round(Number(order.pay_amount ?? 0) * 100), total: Math.round(Number(order.pay_amount ?? 0) * 100), currency: "CNY" },
      }, payConfig);
      await client.query(`insert into ${table(schemaName, "refund_record")}(id, student_id, refund_real_amount, refund_way_config_id, refund_time, remark, ext_json) values($1,$2,$3,'pay_wechat',now(),'商城订单退款',$4::jsonb) on conflict (id) do nothing`, [refundId, order.student_id, order.pay_amount, JSON.stringify({ source: "mall_order", orderId })]);
      await client.query(`update ${table(schemaName, "mall_order")} set order_status = 'REFUNDED', payment_status = 'REFUNDED', updated_at = now() where id = $1`, [orderId]);
      if (order.coupon_claim_id) await client.query(`update ${table(schemaName, "coupon_claim")} set use_status = 'REFUNDED', updated_at = now() where id = $1 and used_order_id = $2`, [order.coupon_claim_id, orderId]);
      await client.query("commit");
      await processMarketingEvent(schemaName, "mall.order.refunded", orderId, { student_id: order.student_id, amount: order.pay_amount });
      return { orderId, refundId, orderStatus: "REFUNDED" };
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  }));
}

export async function completeMallGroupBuy(schemaName: string, params: Row = {}) {
  const groupId = str(params.group_id ?? params.groupId ?? params.id, "");
  if (!groupId) throw Object.assign(new Error("缺少团单"), { statusCode: 400 });
  return withRedisLock(`lock:${schemaName}:mall:group:${groupId}`, () => withClient(async (client) => {
    await client.query("begin");
    try {
      const { rows } = await client.query(`select * from ${table(schemaName, "mall_group_buy")} where id = $1 and deleted = false for update`, [groupId]);
      const group = rows[0];
      if (!group) throw Object.assign(new Error("团单不存在"), { statusCode: 404 });
      if (String(group.group_status) === "SUCCESS") {
        await client.query("commit");
        return { groupId, status: "SUCCESS", changed: false };
      }
      if (String(group.group_status) !== "OPEN" && params.force !== true) throw Object.assign(new Error("只有进行中的团单可以成团"), { statusCode: 400 });
      if (Number(group.joined_count ?? 0) < Number(group.group_size ?? 0) && params.force !== true) throw Object.assign(new Error("参团人数未达到成团人数"), { statusCode: 400 });
      await client.query(`update ${table(schemaName, "mall_group_buy")} set group_status = 'SUCCESS', success_at = coalesce(success_at, now()), updated_at = now() where id = $1`, [groupId]);
      await client.query("commit");
      await processMarketingEvent(schemaName, "mall.group.success", groupId, { goods_id: group.goods_id, activity_id: group.activity_id, student_id: group.leader_student_id });
      return { groupId, status: "SUCCESS", changed: true };
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  }));
}

export async function closeMallGroupBuy(schemaName: string, params: Row = {}) {
  const groupId = str(params.group_id ?? params.groupId ?? params.id, "");
  if (!groupId) throw Object.assign(new Error("缺少团单"), { statusCode: 400 });
  return withRedisLock(`lock:${schemaName}:mall:group:${groupId}`, () => withClient(async (client) => {
    await client.query("begin");
    try {
      const { rows } = await client.query(`select * from ${table(schemaName, "mall_group_buy")} where id = $1 and deleted = false for update`, [groupId]);
      const group = rows[0];
      if (!group) throw Object.assign(new Error("团单不存在"), { statusCode: 404 });
      if (String(group.group_status) === "SUCCESS" && params.force !== true) throw Object.assign(new Error("已成团团单不能关闭"), { statusCode: 400 });
      await client.query(`update ${table(schemaName, "mall_group_buy")} set group_status = 'CLOSED', updated_at = now(), ext_json = coalesce(ext_json,'{}'::jsonb) || $2::jsonb where id = $1`, [groupId, JSON.stringify({ closeReason: params.reason ?? params.close_reason ?? "manual_close" })]);
      await client.query("commit");
      await processMarketingEvent(schemaName, "mall.group.closed", groupId, { goods_id: group.goods_id, activity_id: group.activity_id, student_id: group.leader_student_id });
      return { groupId, status: "CLOSED" };
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  }));
}

export async function leaveMallGroupBuy(schemaName: string, params: Row = {}) {
  const memberId = str(params.member_id ?? params.memberId ?? params.id, "");
  const groupId = str(params.group_id ?? params.groupId, "");
  const studentId = str(params.student_id ?? params.studentId, "");
  if (!memberId && (!groupId || !studentId)) throw Object.assign(new Error("缺少团购成员或团单学员"), { statusCode: 400 });
  return withClient(async (client) => {
    await client.query("begin");
    try {
      const { rows } = await client.query(
        `select * from ${table(schemaName, "mall_group_member")}
         where deleted = false and (($1::text <> '' and id = $1) or ($2::text <> '' and group_id = $2 and student_id = $3))
         limit 1 for update`,
        [memberId, groupId, studentId]
      );
      const member = rows[0];
      if (!member) throw Object.assign(new Error("团购成员不存在"), { statusCode: 404 });
      const group = (await client.query(`select * from ${table(schemaName, "mall_group_buy")} where id = $1 and deleted = false for update`, [member.group_id])).rows[0];
      if (!group) throw Object.assign(new Error("团单不存在"), { statusCode: 404 });
      if (String(group.group_status) === "SUCCESS" && params.force !== true) throw Object.assign(new Error("已成团团单不能退出"), { statusCode: 400 });
      await client.query(`update ${table(schemaName, "mall_group_member")} set member_status = 'LEFT', deleted = true, updated_at = now() where id = $1`, [member.id]);
      await client.query(`update ${table(schemaName, "mall_group_buy")} set joined_count = greatest(coalesce(joined_count,0) - 1, 0), updated_at = now() where id = $1`, [member.group_id]);
      if (member.order_id) {
        await client.query(`update ${table(schemaName, "mall_order")} set order_status = 'CLOSED', updated_at = now() where id = $1 and payment_status = 'UNPAID' and order_status <> 'CLOSED'`, [member.order_id]);
      }
      await client.query("commit");
      return { memberId: member.id, groupId: member.group_id, left: true };
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

export async function loadWechatPortal(schemaName: string, sessionToken?: string) {
  let session: Row | undefined;
  if (sessionToken) session = await getWechatSession(schemaName, sessionToken);
  const fanRows = session ? (await pool.query(`select f.*, s.name as student_name, s.contact, s.school_name, s.grade, s.study_manager_id from ${table(schemaName, "wechat_student_fan")} f left join ${table(schemaName, "student")} s on s.id = f.student_id where f.openid = $1 and f.deleted = false limit 1`, [session.openid])).rows : [];
  const fan = fanRows[0] ?? null;
  const studentId = fan?.student_id ?? null;
  const [courses, leaves, contracts, classes, goods, groups, teachers] = await Promise.all([
    studentId ? pool.query(`select c.* from ${table(schemaName, "generic_course")} c join ${table(schemaName, "generic_course_student")} cs on cs.course_id = c.id where cs.student_id = $1 and c.deleted = false order by c.course_date desc limit 10`, [studentId]) : { rows: [] },
    studentId ? pool.query(`select * from ${table(schemaName, "course_leave_record")} where student_id = $1 and deleted = false order by leave_time desc limit 10`, [studentId]) : { rows: [] },
    studentId ? pool.query(`select * from ${table(schemaName, "contract")} where student_id = $1 and deleted = false order by sign_time desc limit 10`, [studentId]) : { rows: [] },
    studentId ? pool.query(`select mc.name, 'mini_class' as class_type from ${table(schemaName, "mini_class_student")} mcs join ${table(schemaName, "mini_class")} mc on mc.id = mcs.mini_class_id where mcs.student_id = $1 and mcs.deleted = false union all select og.name, 'one_on_n_group' from ${table(schemaName, "one_on_n_group_student")} ogs join ${table(schemaName, "one_on_n_group")} og on og.id = ogs.one_on_n_group_id where ogs.student_id = $1 and ogs.deleted = false`, [studentId]) : { rows: [] },
    pool.query(`select g.*, a.id as activity_id, a.activity_name, a.activity_type as active_activity_type, a.activity_price from ${table(schemaName, "mall_goods")} g left join ${table(schemaName, "mall_activity")} a on a.goods_id = g.id and a.status = 'ACTIVE' and now() between coalesce(a.start_time, now() - interval '1 day') and coalesce(a.end_time, now() + interval '1 day') where g.deleted = false and g.goods_status = 'ON_SALE' order by g.updated_at desc limit 20`),
    pool.query(`select * from ${table(schemaName, "mall_group_buy")} where deleted = false and group_status = 'OPEN' order by created_at desc limit 10`),
    studentId ? pool.query(`select u.id, u.name, u.staff_type from ${qIdent(schemaName)}."user" u where u.id in (select study_manager_id from ${table(schemaName, "student")} where id = $1 union select teacher_id from ${table(schemaName, "generic_course")} c join ${table(schemaName, "generic_course_student")} cs on cs.course_id = c.id where cs.student_id = $1)`, [studentId]) : { rows: [] },
  ]);
  return { fan, student: fan, session: session ? { bindingId: session.binding_id, nickname: session.nickname, avatarUrl: session.avatar_url } : null, courses: courses.rows, leaves: leaves.rows, contracts: contracts.rows, classes: classes.rows, goods: goods.rows, groups: groups.rows, teachers: teachers.rows };
}
