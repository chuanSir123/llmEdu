import { randomUUID } from "node:crypto";
import path from "node:path";
import * as XLSX from "xlsx";
import { executeGatewayApi } from "../gateway/api-executor.js";
import { saveAgentAttachment } from "./attachment.service.js";
import type { SessionUser } from "../types.js";
import { inferForeignKeyMeta } from "../common/foreign-key-meta.js";
import { pool } from "../db/pool.js";
import { qIdent } from "../db/schema-resolver.js";

type ImportField = {
  key: string;
  type?: string;
  label?: string;
  title?: string;
  required?: boolean;
  options?: Array<{ label: string; value: string }>;
  valueLabels?: Record<string, string>;
  optionSource?: {
    pageCode?: string;
    apiCode: string;
    valueField?: string;
    labelField?: string;
    filters?: Record<string, unknown>;
    pageSize?: number;
  };
};

type ImportResolveResult = {
  value: unknown;
  error?: string;
  warning?: string;
};

function decodeBase64(contentBase64: string) {
  const commaIdx = contentBase64.indexOf(",");
  const raw = commaIdx >= 0 ? contentBase64.slice(commaIdx + 1) : contentBase64;
  return Buffer.from(raw, "base64");
}

function parseWorkbook(fileName: string, buffer: Buffer) {
  const lower = fileName.toLowerCase();
  const workbook = lower.endsWith(".csv")
    ? XLSX.read(buffer.toString("utf8").replace(/^\uFEFF/, ""), { type: "string" })
    : XLSX.read(buffer, { type: "buffer" });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return [];
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[sheetName], { defval: "", raw: false });
}

function workbookRowNumber(row: Record<string, unknown>, fallbackIndex: number) {
  const maybeRowNumber = Number((row as Record<string, unknown>).__rowNum__);
  return Number.isFinite(maybeRowNumber) ? maybeRowNumber + 1 : fallbackIndex + 2;
}

function fieldHeader(field: ImportField) {
  if (field.key === "id") return "";
  if (field.key.endsWith("_id")) return field.label ?? field.title ?? field.key.replace(/_id$/, "_name");
  return field.label ?? field.title ?? field.key;
}

function normalizeImportField(field: ImportField): ImportField {
  const meta = inferForeignKeyMeta(field.key);
  if (!meta || field.optionSource) return field;
  return {
    ...field,
    optionSource: {
      pageCode: meta.pageCode,
      apiCode: meta.apiCode,
      valueField: meta.valueField,
      labelField: meta.labelField,
      pageSize: 500,
    },
  };
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asFieldArray(value: unknown): ImportField[] {
  return Array.isArray(value)
    ? value
        .map((item) => asObject(item))
        .filter((item): item is ImportField => typeof item.key === "string" && item.key.length > 0)
    : [];
}

function dedupeFields(fields: ImportField[]) {
  const result: ImportField[] = [];
  const seen = new Set<string>();
  for (const field of fields) {
    if (!field.key || field.key === "id" || seen.has(field.key)) continue;
    seen.add(field.key);
    result.push(field);
  }
  return result;
}

function isSafeImportApi(apiCode: string, pageCode: string, allowedApiCodes: Set<string>, apiDsl: Record<string, unknown>) {
  if (!allowedApiCodes.has(apiCode)) return false;
  const operation = String(apiDsl.operation ?? "");
  if (operation === "query" || operation === "detail" || operation === "delete") return false;
  if (apiCode.endsWith(".query") || apiCode.endsWith(".detail") || apiCode.endsWith(".delete")) return false;
  return operation === "create" || operation === "command" || apiCode === `${pageCode}.create`;
}

async function loadPageDslForImport(schemaName: string, pageCode: string) {
  const { rows } = await pool.query(
    `select dsl_json
     from admin.page_dsl
     where page_code = $1 and status = 'active' and deleted = false
       and ((schema_scope = 'tenant' and schema_name = $2) or (schema_scope = 'tenant' and schema_name = 'demo_school'))
     order by case when schema_scope = 'tenant' and schema_name = $2 then 0 when schema_scope = 'tenant' and schema_name = 'demo_school' then 1 else 2 end
     limit 1`,
    [pageCode, schemaName]
  );
  return asObject(rows[0]?.dsl_json);
}

async function loadApiDslForImport(schemaName: string, apiCode: string) {
  const { rows } = await pool.query(
    `select dsl_json
     from admin.api_dsl
     where api_code = $1 and status = 'active' and deleted = false
       and ((schema_scope = 'tenant' and schema_name = $2) or (schema_scope = 'tenant' and schema_name = 'demo_school'))
     order by case when schema_scope = 'tenant' and schema_name = $2 then 0 when schema_scope = 'tenant' and schema_name = 'demo_school' then 1 else 2 end
     limit 1`,
    [apiCode, schemaName]
  );
  if (!rows[0]) throw Object.assign(new Error("导入目标 API 不存在"), { statusCode: 400 });
  return asObject(rows[0].dsl_json);
}

async function loadImportDslConfigs(schemaName: string, pageCode: string) {
  const { rows } = await pool.query(
    `select dsl_json
     from admin.import_dsl
     where status = 'active' and deleted = false
       and ((schema_scope = 'tenant' and schema_name = $1) or (schema_scope = 'tenant' and schema_name = 'demo_school'))
       and (dsl_json->>'pageCode' = $2 or import_code = $3)
     order by case when schema_scope = 'tenant' and schema_name = $1 then 0 when schema_scope = 'tenant' and schema_name = 'demo_school' then 1 else 2 end`,
    [schemaName, pageCode, `${pageCode}.import`]
  );
  return rows.map((row) => asObject(row.dsl_json));
}

export async function resolveTenantImportConfig(input: {
  schemaName: string;
  pageCode: string;
  apiCode?: string;
  providedFields?: ImportField[];
}) {
  const pageDsl = await loadPageDslForImport(input.schemaName, input.pageCode);
  if (!Object.keys(pageDsl).length) throw Object.assign(new Error("导入页面不存在"), { statusCode: 400 });

  const importConfigs = await loadImportDslConfigs(input.schemaName, input.pageCode);
  const pageCreateApi = String(pageDsl.createApi ?? `${input.pageCode}.create`);
  const allowedApiCodes = new Set<string>([pageCreateApi, `${input.pageCode}.create`]);
  for (const config of importConfigs) {
    const apiCode = String(config.apiCode ?? "");
    if (apiCode) allowedApiCodes.add(apiCode);
  }

  const apiCode = input.apiCode || String(importConfigs[0]?.apiCode ?? pageCreateApi);
  const apiDsl = await loadApiDslForImport(input.schemaName, apiCode);
  if (!isSafeImportApi(apiCode, input.pageCode, allowedApiCodes, apiDsl)) {
    throw Object.assign(new Error("导入只能指向本页面的新增类接口"), { statusCode: 400 });
  }

  const matchedImportConfig = importConfigs.find((config) => !config.apiCode || String(config.apiCode) === apiCode);
  const modalFields = asFieldArray(asObject(pageDsl.modal).fields);
  const tableFields = asFieldArray(asObject(pageDsl.table).columns);
  const fields = dedupeFields(
    asFieldArray(matchedImportConfig?.fields).length
      ? asFieldArray(matchedImportConfig?.fields)
      : modalFields.length
        ? modalFields
        : tableFields.length
          ? tableFields
          : input.providedFields ?? []
  ).map(normalizeImportField);
  if (fields.length === 0) throw Object.assign(new Error("导入字段配置为空"), { statusCode: 400 });

  return {
    apiCode,
    fields,
    templateTitle: String(matchedImportConfig?.title ?? pageDsl.title ?? "导入模板"),
  };
}

function valueFromRow(row: Record<string, unknown>, field: ImportField) {
  if (field.key in row) return row[field.key];
  const headers = [fieldHeader(field), field.label, field.title, field.key].filter(Boolean).map(String);
  for (const header of headers) {
    if (header in row) return row[header];
  }
  return "";
}

function isEmpty(value: unknown) {
  return value === undefined || value === null || String(value).trim() === "";
}

function isBlankImportRow(row: Record<string, unknown>) {
  return Object.values(row).every(isEmpty);
}

function enumOptions(field: ImportField) {
  const result: Array<{ value: string; label: string }> = [];
  for (const option of field.options ?? []) {
    if (option.value == null) continue;
    result.push({ value: String(option.value), label: String(option.label ?? option.value) });
  }
  for (const [value, label] of Object.entries(field.valueLabels ?? {})) {
    if (!result.some((item) => item.value === value)) result.push({ value, label: String(label) });
  }
  return result;
}

function importFieldGuide(field: ImportField) {
  const options = enumOptions(field);
  const notes: string[] = [];
  if (field.required) notes.push("必填");
  if (field.type === "number") notes.push("填写数字，可带千分位逗号或货币符号");
  if (field.type === "date") notes.push("填写日期，如 2026-08-02 或 2026/8/2");
  if (field.type === "time") notes.push("填写时间，如 09:00 或 9:00");
  if (field.type === "datetime") notes.push("填写日期时间，如 2026-08-01 10:00 或 2026/8/1 10:00");
  if (field.type === "multiSelect") notes.push("多个名称可用逗号、分号分隔");
  if (field.optionSource || field.key.endsWith("_id")) notes.push("填写业务名称，系统导入时自动解析为ID");
  if (options.length > 0) notes.push(`可选值：${options.map((option) => option.label === option.value ? option.label : `${option.label}(${option.value})`).join("、")}`);
  return {
    字段名: fieldHeader(field),
    是否必填: field.required ? "是" : "否",
    填写说明: notes.join("；") || "按实际业务内容填写",
  };
}

function resolveNumberValue(field: ImportField, rawValue: unknown): ImportResolveResult {
  if (typeof rawValue === "number") return { value: rawValue };
  const normalized = String(rawValue ?? "")
    .trim()
    .replace(/[,，\s￥¥$]/g, "");
  const value = Number(normalized);
  if (!Number.isFinite(value)) {
    return { value: undefined, error: `字段[${fieldHeader(field)}]数字格式不正确：${rawValue}` };
  }
  return { value };
}

function pad2(value: number) {
  return String(Math.trunc(value)).padStart(2, "0");
}

function parseExcelSerialDate(value: number) {
  const parsed = XLSX.SSF.parse_date_code(value);
  if (!parsed) return undefined;
  return {
    date: `${parsed.y}-${pad2(parsed.m)}-${pad2(parsed.d)}`,
    time: `${pad2(parsed.H)}:${pad2(parsed.M)}`,
  };
}

function resolveDateValue(field: ImportField, rawValue: unknown): ImportResolveResult {
  if (typeof rawValue === "number") {
    const parsed = parseExcelSerialDate(rawValue);
    if (parsed) return { value: parsed.date };
  }
  const input = String(rawValue ?? "").trim();
  const serial = Number(input);
  if (Number.isFinite(serial) && serial > 59) {
    const parsed = parseExcelSerialDate(serial);
    if (parsed) return { value: parsed.date };
  }
  const match = input.match(/^(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})日?$/);
  if (!match) return { value: undefined, error: `字段[${fieldHeader(field)}]日期格式不正确：${rawValue}` };
  return { value: `${match[1]}-${pad2(Number(match[2]))}-${pad2(Number(match[3]))}` };
}

function resolveTimeValue(field: ImportField, rawValue: unknown): ImportResolveResult {
  if (typeof rawValue === "number") {
    const fraction = rawValue % 1;
    const minutes = Math.round(fraction * 24 * 60);
    return { value: `${pad2(Math.floor(minutes / 60) % 24)}:${pad2(minutes % 60)}` };
  }
  const input = String(rawValue ?? "").trim();
  const serial = Number(input);
  if (Number.isFinite(serial) && serial >= 0 && serial < 1) {
    const minutes = Math.round(serial * 24 * 60);
    return { value: `${pad2(Math.floor(minutes / 60) % 24)}:${pad2(minutes % 60)}` };
  }
  const match = input.match(/^(\d{1,2}):(\d{1,2})(?::\d{1,2})?$/);
  if (!match) return { value: undefined, error: `字段[${fieldHeader(field)}]时间格式不正确：${rawValue}` };
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return { value: undefined, error: `字段[${fieldHeader(field)}]时间格式不正确：${rawValue}` };
  return { value: `${pad2(hour)}:${pad2(minute)}` };
}

function resolveDateTimeValue(field: ImportField, rawValue: unknown): ImportResolveResult {
  if (typeof rawValue === "number") {
    const parsed = parseExcelSerialDate(rawValue);
    if (parsed) return { value: `${parsed.date}T${parsed.time}:00+08:00` };
  }
  const input = String(rawValue ?? "").trim();
  const serial = Number(input);
  if (Number.isFinite(serial) && serial > 59) {
    const parsed = parseExcelSerialDate(serial);
    if (parsed) return { value: `${parsed.date}T${parsed.time}:00+08:00` };
  }
  const match = input.match(/^(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})日?(?:[ T]+(\d{1,2}):(\d{1,2})(?::\d{1,2})?)?(?:\s*(Z|[+-]\d{2}:?\d{2}))?$/);
  if (!match) return { value: undefined, error: `字段[${fieldHeader(field)}]日期时间格式不正确：${rawValue}` };
  const date = `${match[1]}-${pad2(Number(match[2]))}-${pad2(Number(match[3]))}`;
  const time = `${pad2(Number(match[4] ?? 0))}:${pad2(Number(match[5] ?? 0))}:00`;
  const zone = match[6] ? (match[6] === "Z" ? "Z" : match[6].replace(/^([+-]\d{2})(\d{2})$/, "$1:$2")) : "+08:00";
  return { value: `${date}T${time}${zone}` };
}

function resolveEnumValue(field: ImportField, rawValue: unknown) {
  const options = enumOptions(field);
  if (options.length === 0 || isEmpty(rawValue)) return { value: rawValue };
  const input = String(rawValue).trim();
  const matches = options.filter((option) => option.value === input || option.label === input);
  if (matches.length === 0) {
    return { value: undefined, error: `字段[${fieldHeader(field)}]枚举值不存在：${input}` };
  }
  return { value: matches[0].value };
}

function importResultRow(sourceRow: Record<string, unknown>, rowNumber: number, result: string) {
  return { 导入行号: rowNumber, ...sourceRow, 导入结果: result };
}

async function resolveNameToId(input: {
  schemaName: string;
  field: ImportField;
  rawValue: unknown;
  strategy: "first" | "error";
  context?: Record<string, unknown>;
  user?: SessionUser;
}): Promise<ImportResolveResult> {
  const source = input.field.optionSource;
  if (!source || isEmpty(input.rawValue)) return { value: input.rawValue };
  if (input.field.key === "contract_product_id") {
    const resolved = await resolveContractProductByContext(input);
    if (resolved) return resolved;
  }
  const labelField = source.labelField ?? "name";
  const valueField = source.valueField ?? "id";
  const result = await executeGatewayApi(
    "tenant",
    input.schemaName,
    source.apiCode,
    { filters: source.filters ?? {}, page: 1, pageSize: source.pageSize ?? 500 },
    input.user,
  ) as { rows?: Record<string, unknown>[] };
  const rows = (result.rows ?? []).filter((row) => String(row[labelField] ?? "").trim() === String(input.rawValue).trim());
  if (rows.length === 0) return { value: undefined, error: `字段[${fieldHeader(input.field)}]未找到名称：${input.rawValue}` };
  if (rows.length > 1 && input.strategy === "error") return { value: undefined, error: `字段[${fieldHeader(input.field)}]不唯一：${input.rawValue}` };
  return {
    value: rows[0][valueField],
    warning: rows.length > 1 ? `字段[${fieldHeader(input.field)}]不唯一，已取第一个：${input.rawValue}` : undefined,
  };
}

async function resolveContractProductByContext(input: {
  schemaName: string;
  field: ImportField;
  rawValue: unknown;
  strategy: "first" | "error";
  context?: Record<string, unknown>;
}): Promise<ImportResolveResult | undefined> {
  const studentId = String(input.context?.student_id ?? "").trim();
  const contractId = String(input.context?.contract_id ?? "").trim();
  if (!studentId && !contractId) return undefined;
  const label = String(input.rawValue ?? "").trim();
  if (!label) return undefined;
  const schema = qIdent(input.schemaName);
  const values: unknown[] = [label];
  const conditions = [
    "coalesce(cp.deleted,false) = false",
    "coalesce(c.deleted,false) = false",
    "coalesce(p.deleted,false) = false",
    "(cp.id = $1 or p.name = $1)",
  ];
  if (studentId) {
    values.push(studentId);
    conditions.push(`c.student_id = $${values.length}`);
  }
  if (contractId) {
    values.push(contractId);
    conditions.push(`c.id = $${values.length}`);
  }
  const { rows } = await pool.query(
    `select cp.id
     from ${schema}.contract_product cp
     join ${schema}.contract c on c.id = cp.contract_id
     join ${schema}.product p on p.id = cp.product_id
     where ${conditions.join(" and ")}
     order by cp.created_at desc, cp.id desc
     limit 2`,
    values
  );
  if (rows.length === 0) return { value: undefined, error: `字段[${fieldHeader(input.field)}]未找到名称：${input.rawValue}` };
  if (rows.length > 1 && input.strategy === "error") {
    return { value: undefined, error: `字段[${fieldHeader(input.field)}]不唯一：${input.rawValue}` };
  }
  return {
    value: rows[0].id,
    warning: rows.length > 1 ? `字段[${fieldHeader(input.field)}]不唯一，已取第一个：${input.rawValue}` : undefined,
  };
}

function splitMultiValue(rawValue: unknown) {
  if (Array.isArray(rawValue)) return rawValue;
  return String(rawValue ?? "")
    .split(/[，,;；]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function resolveMultiNameToIds(input: {
  schemaName: string;
  field: ImportField;
  rawValue: unknown;
  strategy: "first" | "error";
  context?: Record<string, unknown>;
  user?: SessionUser;
}): Promise<ImportResolveResult> {
  const values = splitMultiValue(input.rawValue);
  const result: unknown[] = [];
  const messages: string[] = [];
  for (const value of values) {
    const resolved = await resolveNameToId({
      schemaName: input.schemaName,
      field: input.field,
      rawValue: value,
      strategy: input.strategy,
      context: input.context,
      user: input.user,
    });
    if (resolved.error) messages.push(resolved.error);
    if (resolved.warning) messages.push(resolved.warning);
    if (resolved.value !== undefined) result.push(resolved.value);
  }
  return {
    value: result,
    error: messages.find((message) => message.includes("未找到") || message.includes("不唯一")),
    warning: messages.filter((message) => !message.includes("未找到") && !message.includes("不唯一")).join("；") || undefined,
  };
}

async function enrichImportContext(input: {
  schemaName: string;
  pageCode: string;
  data: Record<string, unknown>;
}) {
  if (input.pageCode !== "funds_history" || input.data.contract_id || !input.data.student_id) return;
  const schema = qIdent(input.schemaName);
  const { rows } = await pool.query(
    `select id
     from ${schema}.contract
     where student_id = $1 and deleted = false and contract_status = 'ACTIVE'
     order by created_at desc, id desc
     limit 2`,
    [input.data.student_id]
  );
  if (rows.length === 1) input.data.contract_id = rows[0].id;
}

export function buildImportTemplate(fields: ImportField[]) {
  const normalizedFields = fields.map(normalizeImportField).filter((field) => Boolean(fieldHeader(field)));
  const headers = normalizedFields.map(fieldHeader);
  const sheet = XLSX.utils.aoa_to_sheet([headers]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "导入模板");
  const guideSheet = XLSX.utils.json_to_sheet(normalizedFields.map(importFieldGuide));
  guideSheet["!cols"] = [{ wch: 18 }, { wch: 10 }, { wch: 80 }];
  XLSX.utils.book_append_sheet(workbook, guideSheet, "填写说明");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

export async function executeTenantImport(input: {
  schemaName: string;
  pageCode: string;
  apiCode: string;
  fileName: string;
  contentBase64: string;
  fields: ImportField[];
  idResolutionStrategy: "first" | "error";
  validateOnly?: boolean;
  user?: SessionUser;
  sourceRows?: Record<string, unknown>[];
}) {
  const buffer = input.sourceRows ? Buffer.alloc(0) : decodeBase64(input.contentBase64);
  const rows = input.sourceRows ?? parseWorkbook(input.fileName, buffer);
  const fields = input.fields.filter((field) => field.key && field.key !== "id").map(normalizeImportField);
  const resultRows: Record<string, unknown>[] = [];
  const failures: Array<{ row: number; message: string }> = [];
  let total = 0;
  let success = 0;
  let failed = 0;

  for (let i = 0; i < rows.length; i++) {
    const sourceRow = rows[i];
    if (isBlankImportRow(sourceRow)) continue;
    const rowNumber = workbookRowNumber(sourceRow, i);
    total++;
    const data: Record<string, unknown> = {};
    const messages: string[] = [];

    for (const field of fields) {
      const raw = valueFromRow(sourceRow, field);
      if (field.required && isEmpty(raw)) {
        messages.push(`字段[${fieldHeader(field)}]不能为空`);
        continue;
      }
      if (!field.required && isEmpty(raw)) {
        continue;
      }
      if (field.type === "number") {
        const resolved = resolveNumberValue(field, raw);
        if (resolved.error) messages.push(resolved.error);
        if (resolved.value !== undefined) data[field.key] = resolved.value;
      } else if (field.type === "date") {
        const resolved = resolveDateValue(field, raw);
        if (resolved.error) messages.push(resolved.error);
        if (resolved.value !== undefined) data[field.key] = resolved.value;
      } else if (field.type === "time") {
        const resolved = resolveTimeValue(field, raw);
        if (resolved.error) messages.push(resolved.error);
        if (resolved.value !== undefined) data[field.key] = resolved.value;
      } else if (field.type === "datetime") {
        const resolved = resolveDateTimeValue(field, raw);
        if (resolved.error) messages.push(resolved.error);
        if (resolved.value !== undefined) data[field.key] = resolved.value;
      } else if (field.type === "multiSelect" && field.optionSource) {
        const resolved = await resolveMultiNameToIds({
          schemaName: input.schemaName,
          field,
          rawValue: raw,
          strategy: input.idResolutionStrategy,
          context: data,
          user: input.user,
        });
        if (resolved.error) messages.push(resolved.error);
        if (resolved.warning) messages.push(resolved.warning);
        data[field.key] = resolved.value;
      } else if (field.optionSource || field.key.endsWith("_id")) {
        const resolved = await resolveNameToId({
          schemaName: input.schemaName,
          field,
          rawValue: raw,
          strategy: input.idResolutionStrategy,
          context: data,
          user: input.user,
        });
        if (resolved.error) messages.push(resolved.error);
        if (resolved.warning) messages.push(resolved.warning);
        if (resolved.value !== undefined) data[field.key] = resolved.value;
      } else {
        const resolved = resolveEnumValue(field, raw);
        if (resolved.error) messages.push(resolved.error);
        if (resolved.value !== undefined) data[field.key] = resolved.value;
      }
    }
    await enrichImportContext({ schemaName: input.schemaName, pageCode: input.pageCode, data });

    if (messages.some((message) => message.includes("不能为空") || message.includes("未找到") || message.includes("不唯一") || message.includes("枚举值不存在"))) {
      failed++;
      if (failures.length < 20) failures.push({ row: rowNumber, message: messages.join("；") });
      resultRows.push(importResultRow(sourceRow, rowNumber, messages.join("；")));
      continue;
    }

    try {
      if (input.validateOnly) {
        success++;
        resultRows.push(importResultRow(sourceRow, rowNumber, messages.length ? `校验通过；${messages.join("；")}` : "校验通过"));
        continue;
      }
      await executeGatewayApi("tenant", input.schemaName, input.apiCode, { data }, input.user);
      success++;
      resultRows.push(importResultRow(sourceRow, rowNumber, messages.length ? `成功；${messages.join("；")}` : "成功"));
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      if (failures.length < 20) failures.push({ row: rowNumber, message });
      resultRows.push(importResultRow(sourceRow, rowNumber, message));
    }
  }

  const sheet = XLSX.utils.json_to_sheet(resultRows.length ? resultRows : [{ 导入结果: "文件没有可导入数据" }]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "导入结果");
  const resultBuffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
  const resultAttachment = await saveAgentAttachment({
    schemaName: input.schemaName,
    userId: input.user?.userId,
    fileName: `${path.parse(input.fileName).name || "import"}_result_${randomUUID().slice(0, 8)}.xlsx`,
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    contentBase64: resultBuffer.toString("base64"),
  });

  return {
    mode: input.validateOnly ? "validate" : "import",
    total,
    success,
    failed,
    failures,
    resultFile: resultAttachment,
  };
}
