import type { PageDsl } from "../dsl/types";

export async function exportToExcel(dsl: PageDsl, rows: Record<string, unknown>[]) {
  if (!rows.length) {
    alert("当前无数据可导出");
    return;
  }

  const columns = dsl.table?.columns ?? [];
  const headers = columns.map((col) => col.title ?? col.key);
  const keys = columns.map((col) => col.key);

  let csv = "\uFEFF";
  csv += headers.map(escapeCsv).join(",") + "\n";
  for (const row of rows) {
    csv += keys.map((key) => escapeCsv(String(row[key] ?? ""))).join(",") + "\n";
  }

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const date = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `${dsl.title}_${date}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function escapeCsv(value: string) {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}