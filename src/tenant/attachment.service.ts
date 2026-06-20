import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import * as XLSX from "xlsx";
import { pool } from "../db/pool.js";

const uploadRoot = path.resolve(process.cwd(), "data", "uploads");

export type UploadedAttachment = {
  id: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  storageUrl: string;
  contentSummary: Record<string, unknown>;
};

function safeFileName(name: string) {
  return name.replace(/[^\w.\-\u4e00-\u9fa5]/g, "_").slice(0, 120) || "attachment";
}

function decodeBase64Data(contentBase64: string) {
  const commaIdx = contentBase64.indexOf(",");
  const raw = commaIdx >= 0 ? contentBase64.slice(commaIdx + 1) : contentBase64;
  return Buffer.from(raw, "base64");
}

function summarizeExcel(buffer: Buffer, fileName: string) {
  const lower = fileName.toLowerCase();
  if (!lower.endsWith(".xlsx") && !lower.endsWith(".xls") && !lower.endsWith(".csv")) return {};
  try {
    const workbook = lower.endsWith(".csv")
      ? XLSX.read(buffer.toString("utf8").replace(/^\uFEFF/, ""), { type: "string" })
      : XLSX.read(buffer, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];
    const sheet = sheetName ? workbook.Sheets[sheetName] : undefined;
    if (!sheet) return {};
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "", raw: false });
    return {
      kind: "spreadsheet",
      sheetName,
      headers: rows[0] ? Object.keys(rows[0]) : [],
      sampleRows: rows.slice(0, 3),
      rowCount: rows.length,
    };
  } catch (err) {
    return { kind: "spreadsheet", parseError: err instanceof Error ? err.message : String(err) };
  }
}

function summarizeImage(fileName: string, mimeType: string) {
  if (!mimeType.startsWith("image/")) return {};
  return {
    kind: "image",
    note: "图片已作为布局参考附件保存。当前临时本地 URL 可传给支持视觉理解的模型；切换 OSS 后使用 storage_url 即可。",
    fileName,
  };
}

export async function saveAgentAttachment(input: {
  schemaName: string;
  userId?: string;
  sessionId?: string;
  fileName: string;
  mimeType: string;
  contentBase64: string;
}): Promise<UploadedAttachment> {
  const id = randomUUID();
  const buffer = decodeBase64Data(input.contentBase64);
  const dir = path.join(uploadRoot, input.schemaName);
  await fs.mkdir(dir, { recursive: true });
  const fileName = safeFileName(input.fileName);
  const localPath = path.join(dir, `${id}_${fileName}`);
  await fs.writeFile(localPath, buffer);
  const storageUrl = `/api/tenant/agent/attachments/${id}/content`;
  const contentSummary = {
    ...summarizeImage(fileName, input.mimeType),
    ...summarizeExcel(buffer, fileName),
  };

  await pool.query(
    `insert into admin.agent_attachment(id, schema_name, user_id, session_id, file_name, mime_type, file_size, storage_provider, storage_url, local_path, content_summary)
     values($1,$2,$3,$4,$5,$6,$7,'local',$8,$9,$10)`,
    [id, input.schemaName, input.userId ?? null, input.sessionId ?? null, fileName, input.mimeType, buffer.length, storageUrl, localPath, JSON.stringify(contentSummary)]
  );

  return { id, fileName, mimeType: input.mimeType, fileSize: buffer.length, storageUrl, contentSummary };
}

export async function loadAttachment(id: string, schemaName: string) {
  const { rows } = await pool.query(
    `select id, schema_name, file_name, mime_type, file_size, storage_url, local_path, content_summary
     from admin.agent_attachment
     where id = $1 and schema_name = $2 and deleted = false`,
    [id, schemaName]
  );
  return rows[0] as {
    id: string;
    schema_name: string;
    file_name: string;
    mime_type: string;
    file_size: number;
    storage_url: string;
    local_path?: string;
    content_summary: Record<string, unknown>;
  } | undefined;
}

export async function loadAttachments(ids: string[], schemaName: string) {
  if (ids.length === 0) return [];
  const { rows } = await pool.query(
    `select id, file_name, mime_type, file_size, storage_url, content_summary
     from admin.agent_attachment
     where id = any($1) and schema_name = $2 and deleted = false
     order by created_at`,
    [ids, schemaName]
  );
  return rows as Array<{
    id: string;
    file_name: string;
    mime_type: string;
    file_size: number;
    storage_url: string;
    content_summary: Record<string, unknown>;
  }>;
}

