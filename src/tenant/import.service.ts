import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import * as XLSX from "xlsx";
import { executeGatewayApi } from "../gateway/api-executor.js";
import { saveAgentAttachment } from "./attachment.service.js";
import type { SessionUser } from "../types.js";
import { inferForeignKeyMeta } from "../common/foreign-key-meta.js";

type ImportField = {
  key: string;
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

function valueFromRow(row: Record<string, unknown>, field: ImportField) {
  const headers = [fieldHeader(field), field.label, field.title, field.key].filter(Boolean).map(String);
  for (const header of headers) {
    if (header in row) return row[header];
  }
  return "";
}

function isEmpty(value: unknown) {
  return value === undefined || value === null || String(value).trim() === "";
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

async function resolveNameToId(input: {
  schemaName: string;
  field: ImportField;
  rawValue: unknown;
  strategy: "first" | "error";
  user?: SessionUser;
}) {
  const source = input.field.optionSource;
  if (!source || isEmpty(input.rawValue)) return { value: input.rawValue };
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

export function buildImportTemplate(fields: ImportField[]) {
  const headers = fields.map(normalizeImportField).map(fieldHeader).filter(Boolean);
  const sheet = XLSX.utils.aoa_to_sheet([headers]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "导入模板");
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
  user?: SessionUser;
}) {
  const buffer = decodeBase64(input.contentBase64);
  const rows = parseWorkbook(input.fileName, buffer);
  const fields = input.fields.filter((field) => field.key && field.key !== "id").map(normalizeImportField);
  const resultRows: Record<string, unknown>[] = [];
  let success = 0;
  let failed = 0;

  for (let i = 0; i < rows.length; i++) {
    const sourceRow = rows[i];
    const data: Record<string, unknown> = {};
    const messages: string[] = [];

    for (const field of fields) {
      const raw = valueFromRow(sourceRow, field);
      if (field.required && isEmpty(raw)) {
        messages.push(`字段[${fieldHeader(field)}]不能为空`);
        continue;
      }
      if (field.optionSource || field.key.endsWith("_id")) {
        const resolved = await resolveNameToId({
          schemaName: input.schemaName,
          field,
          rawValue: raw,
          strategy: input.idResolutionStrategy,
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

    if (messages.some((message) => message.includes("不能为空") || message.includes("未找到") || message.includes("不唯一") || message.includes("枚举值不存在"))) {
      failed++;
      resultRows.push({ ...sourceRow, 导入结果: messages.join("；") });
      continue;
    }

    try {
      await executeGatewayApi("tenant", input.schemaName, input.apiCode, { data }, input.user);
      success++;
      resultRows.push({ ...sourceRow, 导入结果: messages.length ? `成功；${messages.join("；")}` : "成功" });
    } catch (err) {
      failed++;
      resultRows.push({ ...sourceRow, 导入结果: err instanceof Error ? err.message : String(err) });
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
    total: rows.length,
    success,
    failed,
    resultFile: resultAttachment,
  };
}
