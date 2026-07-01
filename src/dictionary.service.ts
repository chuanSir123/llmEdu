import { randomUUID } from "node:crypto";
import { pool } from "./db/pool.js";

type DictionaryItemInput = {
  id?: string;
  dictCode?: string;
  itemValue?: string;
  itemLabel?: string;
  sortNo?: number;
  status?: string;
  metadata?: Record<string, unknown>;
};

export const SYSTEM_DICTIONARIES: Record<string, Record<string, { label: string; metadata?: Record<string, unknown> }>> = {
  student_status: { FORMAL: { label: "正式" }, LEAD: { label: "意向" }, LOST: { label: "流失" } },
  paid_status: { PAID: { label: "已付清" }, PART_PAID: { label: "部分付款" }, UNPAID: { label: "未付款" }, REFUNDED: { label: "已退费" } },
  contract_status: {
    ACTIVE: { label: "生效中", metadata: { businessState: true, transitionPolicy: "command_controlled", systemSemantic: "effective" } },
    CLOSED: { label: "已结清", metadata: { businessState: true, transitionPolicy: "command_controlled", terminal: true } },
    CANCELLED: { label: "已取消", metadata: { businessState: true, transitionPolicy: "command_controlled", terminal: true } },
    REFUNDED: { label: "已退费", metadata: { businessState: true, transitionPolicy: "command_controlled", terminal: true } }
  },
  course_status: { SCHEDULED: { label: "待上课" }, FINISHED: { label: "已完成" }, CANCELLED: { label: "已取消" } },
  charge_status: { CONFIRMED: { label: "已确认" }, PENDING: { label: "待确认" }, REVERSED: { label: "已撤销" } },
  attendance_status: { PENDING: { label: "待签到" }, PRESENT: { label: "已签到" }, ABSENT: { label: "缺勤" }, LEAVE: { label: "请假" } },
  status: { ACTIVE: { label: "启用" }, INACTIVE: { label: "停用" }, ENABLED: { label: "启用" }, DISABLED: { label: "停用" }, PUBLISHED: { label: "已发布" }, DRAFT: { label: "草稿" }, draft: { label: "草稿" }, active: { label: "生效" }, archived: { label: "归档" }, rejected: { label: "已驳回" } },
  mode: { draft: { label: "草稿" }, publish_after_confirm: { label: "确认后发布" } },
  staff_type: { MANAGER: { label: "校长" }, TEACHER: { label: "老师" }, STUDY_MANAGER: { label: "学管师" }, SALES: { label: "顾问" } },
  organization_type: { HEAD: { label: "总部" }, BRANCH: { label: "校区" }, DEPARTMENT: { label: "部门" }, TENANT: { label: "机构" }, CAMPUS: { label: "校区" } },
  contract_type: { NEW_SIGN: { label: "新签" }, RENEWAL: { label: "续费" }, REFERRAL: { label: "引流" } },
  course_type: { ONE_ON_ONE_COURSE: { label: "一对一" }, SMALL_CLASS: { label: "小班" }, ONE_ON_N_GROUP: { label: "一对N" } },
  product_type: { ONE_ON_ONE_COURSE: { label: "一对一" }, SMALL_CLASS: { label: "小班" }, ONE_ON_N_GROUP: { label: "一对N" } },
  funds_type: { CONTRACT_PAY: { label: "合同收款" }, PRE_STORE: { label: "预存" } },
  charge_type: { NORMAL: { label: "实收扣费" }, PROMOTION: { label: "优惠扣费" }, PROMOTION_HOUR: { label: "赠课扣费" } },
  pay_way_type: { CASH: { label: "现金" }, WECHAT: { label: "微信" }, ALIPAY: { label: "支付宝" }, ELE_ACCOUNT: { label: "电子账户" } },
  promotion_type: { REDUCE: { label: "立减" }, DISCOUNT: { label: "折扣" } },
  follow_type: { PHONE: { label: "电话" }, VISIT: { label: "到访" }, WECHAT: { label: "微信" } },
  follow_result: { CONTACTED: { label: "已联系" }, NO_ANSWER: { label: "未接通" }, INTERESTED: { label: "有意向" }, NOT_INTERESTED: { label: "无意向" } },
  source_type: { REFERRAL: { label: "转介绍" }, WALK_IN: { label: "到访" }, ONLINE: { label: "线上" }, MANUAL_ADJUSTMENT: { label: "手工调整" } },
  channel_type: { ONLINE: { label: "线上" }, REFERRAL: { label: "转介绍" }, OFFLINE: { label: "线下" } },
  trial_status: { SCHEDULED: { label: "已预约" }, FINISHED: { label: "已试听" }, CANCELLED: { label: "已取消" } },
  conversion_status: { PENDING: { label: "待转化" }, CONVERTED: { label: "已转化" }, LOST: { label: "未转化" } },
  task_type: { FOLLOWUP: { label: "跟进" }, TRIAL_FOLLOWUP: { label: "试听跟进" } },
  task_status: { PENDING: { label: "待处理" }, COMPLETED: { label: "已完成" }, CANCELED: { label: "已取消" } },
  record_type: { customization: { label: "AI 定制" }, assistant: { label: "AI 助手" } },
  change_type: { PRESTORE_IN: { label: "预存入账" }, CONTRACT_PAY_OUT: { label: "合同扣款" }, REFUND_IN: { label: "退费入账" }, PRESTORE_DELETE: { label: "删除预存" }, CONTRACT_PAY_DELETE: { label: "删除合同扣款" }, REFUND_DELETE: { label: "删除退费" }, update: { label: "更新" }, rollback: { label: "回滚" }, init: { label: "初始化" } },
  refund_type: { CONTRACT_PRODUCT: { label: "合同产品退费" }, CONTRACT: { label: "合同退费" } },
  target_type: { bundle: { label: "整包配置" }, page: { label: "页面" }, action: { label: "按钮动作" }, api: { label: "接口" }, modal: { label: "弹窗" }, skill: { label: "技能" }, import: { label: "导入" }, report: { label: "报表" }, business_rule: { label: "业务规则" }, print_template: { label: "打印模板" }, mini_class: { label: "小班" }, one_on_n_group: { label: "1对N小组" } },
  schema_scope: { tenant: { label: "机构模板/租户自定义" }, admin: { label: "平台管理" } },
  source_label: { 租户自定义: { label: "租户自定义" }, 模板机构: { label: "模板机构" } },
  account_type: { DEFAULT: { label: "默认账户" } },
  leave_type: { PERSONAL: { label: "事假" }, SICK: { label: "病假" }, OTHER: { label: "其他" } },
  holiday_type: { CAMPUS_CLOSED: { label: "校区停课" }, PUBLIC_HOLIDAY: { label: "节假日" }, OTHER: { label: "其他" } },
  performance_type: { SALES: { label: "销售业绩" }, MANUAL_ADJUST: { label: "手工调整" }, SALES_REVERSE: { label: "销售业绩冲减" } },
  goods_status: { ON_SALE: { label: "上架中" }, OFF_SALE: { label: "已下架" } },
  activity_type: { SECKILL: { label: "秒杀" }, GROUP_BUY: { label: "拼团" }, NORMAL: { label: "普通活动" } },
  group_status: { OPEN: { label: "拼团中" }, SUCCESS: { label: "已成团" }, CLOSED: { label: "已关闭" } },
  member_status: { JOINED: { label: "已参团" }, LEFT: { label: "已退出" } },
  order_status: { CREATED: { label: "已创建" }, PAID: { label: "已支付" }, CLOSED: { label: "已关闭" }, REFUNDED: { label: "已退款" } },
  service_type: { SERVICE_ACCOUNT: { label: "服务号" }, SUBSCRIPTION_ACCOUNT: { label: "订阅号" } },
  binding_type: { PUBLIC: { label: "公有服务号" }, PRIVATE: { label: "自有公众号" } },
  authorized_status: { AUTHORIZED: { label: "已授权" }, UNAUTHORIZED: { label: "未授权" }, EXPIRED: { label: "已过期" } },
  publish_status: { DRAFT: { label: "草稿" }, PUBLISHED: { label: "已发布" }, FAILED: { label: "发布失败" } },
  subscribe_status: { SUBSCRIBED: { label: "已关注" }, UNSUBSCRIBED: { label: "已取关" } },
  send_status: { PENDING: { label: "待发送" }, SUCCESS: { label: "发送成功" }, FAILED: { label: "发送失败" } },
  reward_status: { PENDING: { label: "待处理" }, LOCKED: { label: "锁定中" }, ELIGIBLE: { label: "可发放" }, ISSUED: { label: "已发放" } },
  payment_status: { PENDING: { label: "待支付" }, PAID: { label: "已支付" }, FAILED: { label: "支付失败" }, CLOSED: { label: "已关闭" }, REFUNDED: { label: "已退款" } },
  fulfillment_status: { PENDING: { label: "待履约" }, PROCESSING: { label: "处理中" }, SUCCESS: { label: "已完成" }, FAILED: { label: "履约失败" } }
};

function safeDictCode(value: unknown) {
  const text = String(value ?? "").trim();
  if (!/^[a-z][a-z0-9_]{1,80}$/.test(text)) throw Object.assign(new Error(`数据字典编码不合法: ${text}`), { statusCode: 400 });
  return text;
}

function safeItemValue(value: unknown) {
  const text = String(value ?? "").trim();
  if (!/^[A-Za-z][A-Za-z0-9_]{0,80}$/.test(text)) throw Object.assign(new Error(`字典项值不合法: ${text}`), { statusCode: 400 });
  return text;
}

export async function seedSystemDictionaries() {
  let sort = 10;
  for (const [dictCode, items] of Object.entries(SYSTEM_DICTIONARIES)) {
    sort = 10;
    for (const [itemValue, item] of Object.entries(items)) {
      await pool.query(
        `insert into admin.dictionary_item(id, dict_code, item_value, item_label, schema_scope, schema_name, is_system, locked, sort_no, status, metadata_json, deleted)
         values($1,$2,$3,$4,'admin','',true,true,$5,'ACTIVE',$6,false)
         on conflict (dict_code, schema_name, item_value) do update
           set item_label = excluded.item_label,
               is_system = true,
               locked = true,
               status = 'ACTIVE',
               metadata_json = admin.dictionary_item.metadata_json || excluded.metadata_json,
               deleted = false,
               updated_at = now()`,
        [randomUUID(), dictCode, itemValue, item.label, sort, JSON.stringify(item.metadata ?? {})]
      );
      sort += 10;
    }
  }
}

export async function listDictionaryOptions(schemaName: string | undefined, dictCodeInput: unknown) {
  const dictCode = safeDictCode(dictCodeInput);
  const { rows } = await pool.query(
    `select distinct on (item_value)
        id, dict_code, item_value, item_label, schema_scope, schema_name, is_system, locked, sort_no, status, metadata_json
       from admin.dictionary_item
       where dict_code = $1 and status = 'ACTIVE' and deleted = false
         and ((schema_scope = 'admin' and schema_name = '') or (schema_scope = 'tenant' and schema_name = $2))
       order by item_value, case when schema_scope = 'tenant' then 0 else 1 end, sort_no, created_at`,
    [dictCode, schemaName ?? null]
  );
  return { rows: rows.sort((a, b) => Number(a.sort_no ?? 0) - Number(b.sort_no ?? 0)).map((row) => ({
    ...row,
    value: row.item_value,
    label: row.item_label,
    metadata: row.metadata_json ?? {}
  })) };
}

export async function queryDictionaryItems(schemaName: string, params: Record<string, unknown>) {
  const filters = (params.filters && typeof params.filters === "object" && !Array.isArray(params.filters) ? params.filters : {}) as Record<string, unknown>;
  const values: unknown[] = [schemaName];
  const where = [`deleted = false`, `((schema_scope = 'admin' and schema_name = '') or (schema_scope = 'tenant' and schema_name = $1))`];
  if (filters.dict_code || filters.dictCode) { values.push(safeDictCode(filters.dict_code ?? filters.dictCode)); where.push(`dict_code = $${values.length}`); }
  if (filters.keyword) { values.push(`%${String(filters.keyword)}%`); where.push(`(item_value ilike $${values.length} or item_label ilike $${values.length})`); }
  const page = Math.max(Number(params.page ?? 1), 1);
  const pageSize = Math.min(Math.max(Number(params.pageSize ?? 20), 1), 100);
  values.push(pageSize, (page - 1) * pageSize);
  const { rows } = await pool.query(
    `select id, dict_code, item_value, item_label, schema_scope, schema_name, is_system, locked, sort_no, status, metadata_json, count(*) over() as __total
     from admin.dictionary_item where ${where.join(" and ")}
     order by dict_code, sort_no, item_value limit $${values.length - 1} offset $${values.length}`,
    values
  );
  return { rows, total: Number(rows[0]?.__total ?? 0) };
}

export async function saveTenantDictionaryItem(schemaName: string, params: Record<string, unknown>) {
  const data = ((params.data && typeof params.data === "object" && !Array.isArray(params.data)) ? params.data : params) as DictionaryItemInput;
  const dictCode = safeDictCode(data.dictCode ?? (data as Record<string, unknown>).dict_code);
  const itemValue = safeItemValue(data.itemValue ?? (data as Record<string, unknown>).item_value);
  const itemLabel = String(data.itemLabel ?? (data as Record<string, unknown>).item_label ?? "").trim();
  if (!itemLabel) throw Object.assign(new Error("字典项中文名不能为空"), { statusCode: 400 });
  const system = await pool.query(`select id from admin.dictionary_item where dict_code = $1 and item_value = $2 and is_system = true and deleted = false limit 1`, [dictCode, itemValue]);
  if (system.rows[0]) throw Object.assign(new Error(`系统字典项不可覆盖: ${dictCode}.${itemValue}`), { statusCode: 409 });
  const id = String(data.id ?? randomUUID());
  const metadata = data.metadata ?? ((data as Record<string, unknown>).metadata_json as Record<string, unknown> | undefined) ?? {};
  const { rows } = await pool.query(
    `insert into admin.dictionary_item(id, dict_code, item_value, item_label, schema_scope, schema_name, is_system, locked, sort_no, status, metadata_json, deleted)
     values($1,$2,$3,$4,'tenant',$5,false,false,$6,$7,$8,false)
     on conflict (dict_code, schema_name, item_value) do update
       set item_label = excluded.item_label,
           sort_no = excluded.sort_no,
           status = excluded.status,
           metadata_json = excluded.metadata_json,
           deleted = false,
           updated_at = now()
       where admin.dictionary_item.locked = false
     returning *`,
    [id, dictCode, itemValue, itemLabel, schemaName, Number(data.sortNo ?? (data as Record<string, unknown>).sort_no ?? 100), String(data.status ?? "ACTIVE"), JSON.stringify(metadata)]
  );
  if (!rows[0]) throw Object.assign(new Error("锁定字典项不可修改"), { statusCode: 403 });
  return rows[0];
}

export async function deleteTenantDictionaryItem(schemaName: string, id: unknown) {
  const { rows } = await pool.query(
    `update admin.dictionary_item set deleted = true, updated_at = now()
     where id = $1 and schema_scope = 'tenant' and schema_name = $2 and locked = false returning id`,
    [String(id ?? ""), schemaName]
  );
  if (!rows[0]) throw Object.assign(new Error("字典项不存在或不可删除"), { statusCode: 404 });
  return { deleted: true, id: rows[0].id };
}
