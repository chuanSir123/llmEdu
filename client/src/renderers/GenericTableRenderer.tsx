import { useState } from "react";
import type { ActionDsl, FieldDsl, PageDsl } from "../dsl/types";
import { sortWithOrder } from "../dsl/sortWithOrder";
import { token } from "../styles/designTokens";

type Presentation = NonNullable<PageDsl["presentation"]>;
type BadgeTone = "green" | "blue" | "amber" | "red" | "gray";

const badgeTone = {
  green: "border-[#b8e6cf] bg-[#eefaf3] text-[#147a44]",
  blue: "border-[#b9def8] bg-[#eef8ff] text-[#126da3]",
  amber: "border-[#f5ddb0] bg-[#fff8ea] text-[#9a630d]",
  red: "border-[#f4bdc2] bg-[#fff1f2] text-[#b42332]",
  gray: "border-[#d7dee7] bg-[#f6f8fa] text-[#607083]"
} satisfies Record<BadgeTone, string>;

function isImageField(column: FieldDsl) {
  const key = column.key.toLowerCase();
  return column.type === "image" || key.includes("image") || key.includes("avatar") || key.includes("photo") || key.includes("cover") || key.includes("logo") || key.endsWith("_url");
}

function formatValue(value: unknown, type?: string): string {
  if (value === null || value === undefined || value === "") return "-";
  if (type === "datetime") return new Date(String(value)).toLocaleString();
  if (type === "date") return String(value).slice(0, 10);
  if (Array.isArray(value)) return value.map((item) => formatValue(item)).filter((item) => item !== "-").join(", ");
  if (typeof value === "object") return typeof value === "string" ? value : JSON.stringify(value);
  return String(value);
}

function isVisibleAction(action: ActionDsl, row: Record<string, unknown>): boolean {
  if (!action.visibleWhen) return true;
  if (action.visibleWhen.always === false) return false;
  for (const [key, val] of Object.entries(action.visibleWhen)) {
    if (key === "always" || key === "permission") continue;
    const rowValue = String(row[key] ?? "");
    if (Array.isArray(val)) {
      if (!val.map(String).includes(rowValue)) return false;
      continue;
    }
    if (String(row[key] ?? "") !== String(val)) return false;
  }
  return true;
}

function alignClass(align?: string) {
  if (align === "right") return "text-right";
  if (align === "center") return "text-center";
  return "text-left";
}

function renderCell(column: FieldDsl, row: Record<string, unknown>, presentation?: Presentation) {
  const rawValue = column.displayKey && row[column.displayKey] !== undefined && row[column.displayKey] !== null && row[column.displayKey] !== ""
    ? row[column.displayKey]
    : row[column.key];
  const text = formatValue(rawValue, column.type);
  const displayText = text === "-" ? text : (presentation?.valueLabels?.[column.key]?.[text] ?? text);
  if (isImageField(column) && text !== "-") {
    return <img src={text} alt={column.title ?? column.label ?? column.key} className="h-12 w-16 rounded border border-[#dde3ee] object-cover" />;
  }
  if (!column.badge || text === "-") return displayText;
  const tone = (presentation?.statusMap?.[column.key]?.[text] ?? "gray") as BadgeTone;
  return <span className={`inline-flex h-6 items-center border px-2 text-xs font-medium ${badgeTone[tone]}`}>{displayText}</span>;
}

export function GenericTableRenderer({
  columns,
  rows,
  rowActions = [],
  onAction,
  presentation
}: {
  columns: FieldDsl[];
  rows: Record<string, unknown>[];
  rowActions?: ActionDsl[];
  onAction: (action: ActionDsl, row: Record<string, unknown>) => void;
  presentation?: PageDsl["presentation"];
}) {
  const sortedColumns = sortWithOrder(columns);
  const [openMenuRowId, setOpenMenuRowId] = useState<string | null>(null);
  const stickyHeader = presentation?.table?.stickyHeader ?? true;
  const density = presentation?.density ?? "compact";
  const tdDensity = density === "compact" ? "py-2" : "py-3";
  const hasActions = rowActions.length > 0;
  const actionStyle = presentation?.table?.rowActionStyle ?? "button";
  const primaryRowActions = new Set(presentation?.table?.primaryRowActions ?? []);
  const numericColumns = sortedColumns.filter((column) => column.type === "number" || /(_amount|amount|hour|qty|count|total|price|balance)$/i.test(column.key));
  const hasSummary = rows.length > 0 && numericColumns.length > 0;
  const summaryValue = (key: string) => rows.reduce((sum, row) => sum + Number(row[key] ?? 0), 0);

  return (
    <div className="h-full overflow-auto bg-white">
      <table className="min-w-full border-collapse">
        <thead className={stickyHeader ? "sticky top-0 z-10" : undefined}>
          <tr>
            {sortedColumns.map((column) => (
              <th
                key={column.key}
                className={`${token.th} ${alignClass(column.align)} whitespace-nowrap`}
                style={{ minWidth: column.width ? `${column.width}px` : 132 }}
              >
                {column.title ?? column.label ?? column.key}
              </th>
            ))}
            {hasActions && <th className={`${token.th} w-[220px] min-w-[220px] whitespace-nowrap text-center`}>操作</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={String(row.id)} className="hover:bg-[#f2fbfe]">
              {sortedColumns.map((column) => (
                <td
                  key={column.key}
                  className={`${token.td} ${tdDensity} ${alignClass(column.align)} max-w-[300px] truncate`}
                  title={formatValue(column.displayKey ? row[column.displayKey] ?? row[column.key] : row[column.key], column.type)}
                >
                  {renderCell(column, row, presentation)}
                </td>
              ))}
              {hasActions && (
                <td className={`${token.td} ${tdDensity} w-[220px] min-w-[220px] whitespace-nowrap`}>
                  {actionStyle === "linkGroup" ? (
                    <div className="relative flex flex-nowrap items-center justify-center gap-3 text-sm">
                      {(() => {
                        const filteredActions = rowActions.filter((action) => isVisibleAction(action, row));
                        const preferred = filteredActions.filter((action) => primaryRowActions.has(action.actionCode));
                        const fallback = filteredActions.filter((action) => !action.actionCode.endsWith(".delete")).slice(0, 2);
                        const visibleActions = preferred.length ? preferred : fallback;
                        const moreActions = filteredActions.filter((action) => !visibleActions.some((visible) => visible.actionCode === action.actionCode));
                        const rowId = String(row.id);
                        return (
                          <>
                            {visibleActions.map((action) => (
                              <button
                                key={action.actionCode}
                                className={`whitespace-nowrap ${
                                  action.actionCode.endsWith(".delete") ? "text-[#ff4d64] hover:text-[#e63d52]" : "text-[#2f80ed] hover:text-[#1765d8]"
                                }`}
                                onClick={() => onAction(action, row)}
                              >
                                {action.label}
                              </button>
                            ))}
                            {moreActions.length > 0 && (
                              <span className="relative">
                                <button
                                  className="whitespace-nowrap text-[#2f80ed] hover:text-[#1765d8]"
                                  onClick={() => setOpenMenuRowId((current) => (current === rowId ? null : rowId))}
                                >
                                  更多⌄
                                </button>
                                {openMenuRowId === rowId && (
                                  <div className="absolute right-0 top-6 z-20 min-w-[92px] border border-[#dde3ee] bg-white py-1 shadow-[0_8px_20px_rgba(24,36,56,0.12)]">
                                    {moreActions.map((action) => (
                                      <button
                                        key={action.actionCode}
                                        className={`block h-8 w-full whitespace-nowrap px-3 text-left text-sm ${
                                          action.actionCode.endsWith(".delete") ? "text-[#ff4d64] hover:bg-[#fff1f3]" : "text-[#2f80ed] hover:bg-[#f2f7ff]"
                                        }`}
                                        onClick={() => {
                                          setOpenMenuRowId(null);
                                          onAction(action, row);
                                        }}
                                      >
                                        {action.label}
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </span>
                            )}
                          </>
                        );
                      })()}
                    </div>
                  ) : (
                    <div className="flex flex-nowrap items-center justify-center gap-1.5">
                      {rowActions.filter((action) => isVisibleAction(action, row)).map((action) => (
                        <button
                          key={action.actionCode}
                          className={`${token.button} ${action.actionCode.endsWith(".delete") ? token.dangerButton : token.defaultButton} h-7 px-2.5`}
                          onClick={() => onAction(action, row)}
                        >
                          {action.label}
                        </button>
                      ))}
                    </div>
                  )}
                </td>
              )}
            </tr>
          ))}
          {!rows.length && (
            <tr>
              <td className="px-3 py-10 text-center text-sm text-[#607083]" colSpan={columns.length + (hasActions ? 1 : 0)}>
                暂无数据
              </td>
            </tr>
          )}
          {hasSummary && (
            <tr className="sticky bottom-0 z-10 border-t border-[#d9e3ed] bg-white font-semibold text-[#172033] shadow-[0_-1px_0_#e5e8ef]">
              {sortedColumns.map((column, index) => (
                <td key={column.key} className={`${token.td} ${tdDensity} ${alignClass(column.align)} whitespace-nowrap`}>
                  {index === 0 ? "合计" : numericColumns.some((item) => item.key === column.key) ? summaryValue(column.key).toFixed(2).replace(/\.00$/, "") : ""}
                </td>
              ))}
              {hasActions && <td className={`${token.td} ${tdDensity}`} />}
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
