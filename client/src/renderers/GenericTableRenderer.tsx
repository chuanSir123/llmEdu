import { useEffect, useRef, useState } from "react";
import type { ActionDsl, FieldDsl, PageDsl } from "../dsl/types";
import { sortWithOrder } from "../dsl/sortWithOrder";
import { token } from "../styles/designTokens";
import { dictionaryLabelFor } from "../dsl/dictionaryLabels";
import { isDangerAction } from "../dsl/actionVariant";
import { evaluateWhen } from "../dsl/conditions";

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

function formatValue(value: unknown, type?: string, key?: string): string {
  if (value === null || value === undefined || value === "") return "-";
  if (type === "datetime") return new Date(String(value)).toLocaleString();
  if (type === "date") return String(value).slice(0, 10);
  if ((type === "number" || /amount|price|balance/i.test(key ?? "")) && Number.isFinite(Number(value))) return Number(value).toFixed(2);
  if (Array.isArray(value)) return value.map((item) => formatValue(item)).filter((item) => item !== "-").join(", ");
  if (typeof value === "object") { try { return JSON.stringify(value); } catch { return String(value); } }
  return String(value);
}

function isVisibleAction(action: ActionDsl, row: Record<string, unknown>): boolean {
  return evaluateWhen(action.visibleWhen, row);
}

function isEnabledAction(action: ActionDsl, row: Record<string, unknown>): boolean {
  return evaluateWhen(action.enabledWhen, row);
}

function isNumericColumn(column: FieldDsl) {
  return column.type === "number" || /(_amount|amount|hour|qty|count|total|price|balance)$/i.test(column.key);
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
  const text = formatValue(rawValue, column.type, column.key);
  const displayText = text === "-" ? text : (dictionaryLabelFor(column.key, text, presentation?.valueLabels) ?? text);
  if (isImageField(column) && text !== "-") {
    return <img src={text} alt={column.title ?? column.label ?? column.key} className="h-12 w-16 rounded border border-[#dde3ee] object-cover" />;
  }
  if (!column.badge || text === "-") return displayText;
  const tone = (presentation?.statusMap?.[column.key]?.[text] ?? "gray") as BadgeTone;
  return <span className={`inline-flex h-6 items-center border px-2 text-xs font-medium ${badgeTone[tone]}`}>{displayText}</span>;
}

function renderPlainCellTitle(column: FieldDsl, row: Record<string, unknown>, presentation?: Presentation) {
  const raw = column.displayKey ? row[column.displayKey] ?? row[column.key] : row[column.key];
  const text = formatValue(raw, column.type, column.key);
  return text === "-" ? text : dictionaryLabelFor(column.key, text, presentation?.valueLabels) ?? text;
}

export function GenericTableRenderer({
  columns,
  rows,
  rowActions = [],
  onAction,
  presentation,
  selectable = false,
  selectedRowIds = [],
  onSelectionChange
}: {
  columns: FieldDsl[];
  rows: Record<string, unknown>[];
  rowActions?: ActionDsl[];
  onAction: (action: ActionDsl, row: Record<string, unknown>) => void;
  presentation?: PageDsl["presentation"];
  selectable?: boolean;
  selectedRowIds?: string[];
  onSelectionChange?: (ids: string[]) => void;
}) {
  const sortedColumns = sortWithOrder(columns);
  const [openMenuRowId, setOpenMenuRowId] = useState<string | null>(null);
  const openMenuRef = useRef<HTMLSpanElement | null>(null);
  const stickyHeader = presentation?.table?.stickyHeader ?? true;
  const density = presentation?.table?.rowDensity ?? presentation?.density ?? "compact";
  const tdDensity = density === "compact" ? "py-1.5" : "py-2.5";
  const hasActions = rowActions.length > 0;
  const actionStyle = presentation?.table?.rowActionStyle ?? "button";
  const primaryRowActions = new Set(presentation?.table?.primaryRowActions ?? []);
  // 数值列未显式配置 align 时默认右对齐（表头/单元格/合计行一致）
  const columnAlign = (column: FieldDsl) => column.align ?? (isNumericColumn(column) ? "right" : undefined);
  const numericColumns = sortedColumns.filter(isNumericColumn);
  const hasSummary = rows.length > 0 && numericColumns.length > 0;
  const cellNumericValue = (row: Record<string, unknown>, key: string) => {
    const raw = row[key];
    if (raw === null || raw === undefined || raw === "") return undefined;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const columnHasNumeric = (key: string) => rows.some((row) => cellNumericValue(row, key) !== undefined);
  const summaryValue = (key: string) => rows.reduce((sum, row) => sum + (cellNumericValue(row, key) ?? 0), 0);
  const rowIds = rows.map((row) => String(row.id));
  const selectedSet = new Set(selectedRowIds);
  const allPageSelected = rowIds.length > 0 && rowIds.every((id) => selectedSet.has(id));
  const toggleRow = (id: string, checked: boolean) => {
    const next = new Set(selectedRowIds);
    if (checked) next.add(id);
    else next.delete(id);
    onSelectionChange?.([...next]);
  };
  const togglePage = (checked: boolean) => {
    const next = new Set(selectedRowIds);
    for (const id of rowIds) checked ? next.add(id) : next.delete(id);
    onSelectionChange?.([...next]);
  };

  useEffect(() => {
    if (!openMenuRowId) return;
    function handleClickOutside(event: MouseEvent) {
      if (openMenuRef.current && !openMenuRef.current.contains(event.target as Node)) setOpenMenuRowId(null);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [openMenuRowId]);

  return (
    <div className="h-full overflow-auto bg-white">
      <table className="min-w-full border-collapse">
        <thead className={stickyHeader ? "sticky top-0 z-10" : undefined}>
          <tr>
            {selectable && (
              <th className={`${token.th} w-[44px] min-w-[44px] text-center`}>
                <input type="checkbox" checked={allPageSelected} onChange={(event) => togglePage(event.target.checked)} />
              </th>
            )}
            {sortedColumns.map((column) => (
              <th
                key={column.key}
                className={`${token.th} ${alignClass(columnAlign(column))} whitespace-nowrap`}
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
              {selectable && (
                <td className={`${token.td} ${tdDensity} w-[44px] text-center`}>
                  <input type="checkbox" checked={selectedSet.has(String(row.id))} onChange={(event) => toggleRow(String(row.id), event.target.checked)} />
                </td>
              )}
              {sortedColumns.map((column) => (
                <td
                  key={column.key}
                  className={`${token.td} ${tdDensity} ${alignClass(columnAlign(column))} max-w-[300px] truncate`}
                  title={String(renderPlainCellTitle(column, row, presentation))}
                >
                  {renderCell(column, row, presentation)}
                </td>
              ))}
              {hasActions && (
                <td className={`${token.td} ${tdDensity} w-[220px] min-w-[220px] whitespace-nowrap`}>
                  {actionStyle === "linkGroup" ? (
                    <div className="relative flex flex-nowrap items-center justify-center gap-3 text-[13px]">
                      {(() => {
                        const filteredActions = rowActions.filter((action) => isVisibleAction(action, row));
                        const preferred = filteredActions.filter((action) => primaryRowActions.has(action.actionCode));
                        const fallback = filteredActions.filter((action) => !isDangerAction(action)).slice(0, 2);
                        const visibleActions = preferred.length ? preferred : fallback;
                        const moreActions = filteredActions.filter((action) => !visibleActions.some((visible) => visible.actionCode === action.actionCode));
                        const rowId = String(row.id);
                        return (
                          <>
                            {visibleActions.map((action) => {
                              const enabled = isEnabledAction(action, row);
                              return (
                                <button
                                  key={action.actionCode}
                                  className={`whitespace-nowrap ${
                                    !enabled
                                      ? "cursor-not-allowed text-[#b9c2d0]"
                                      : isDangerAction(action) ? "text-[#ff4d64] hover:text-[#e63d52]" : "text-[#2f80ed] hover:text-[#1765d8]"
                                  }`}
                                  disabled={!enabled}
                                  title={!enabled ? "当前条件下不可操作" : undefined}
                                  onClick={() => onAction(action, row)}
                                >
                                  {action.label}
                                </button>
                              );
                            })}
                            {moreActions.length > 0 && (
                              <span className="relative" ref={(el) => { if (openMenuRowId === rowId) openMenuRef.current = el; }}>
                                <button
                                  className="whitespace-nowrap text-[#2f80ed] hover:text-[#1765d8]"
                                  onClick={() => setOpenMenuRowId((current) => (current === rowId ? null : rowId))}
                                >
                                  更多⌄
                                </button>
                                {openMenuRowId === rowId && (
                                  <div className="absolute right-0 top-6 z-20 min-w-[92px] border border-[#dde3ee] bg-white py-1 shadow-[0_8px_20px_rgba(24,36,56,0.12)]">
                                    {moreActions.map((action) => {
                                      const enabled = isEnabledAction(action, row);
                                      return (
                                        <button
                                          key={action.actionCode}
                                          className={`block h-8 w-full whitespace-nowrap px-3 text-left text-[13px] ${
                                            !enabled
                                              ? "cursor-not-allowed text-[#b9c2d0]"
                                              : isDangerAction(action) ? "text-[#ff4d64] hover:bg-[#fff1f3]" : "text-[#2f80ed] hover:bg-[#f2f7ff]"
                                          }`}
                                          disabled={!enabled}
                                          title={!enabled ? "当前条件下不可操作" : undefined}
                                          onClick={() => {
                                            setOpenMenuRowId(null);
                                            onAction(action, row);
                                          }}
                                        >
                                          {action.label}
                                        </button>
                                      );
                                    })}
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
                      {rowActions.filter((action) => isVisibleAction(action, row)).map((action) => {
                        const enabled = isEnabledAction(action, row);
                        return (
                          <button
                            key={action.actionCode}
                            className={`${token.button} ${isDangerAction(action) ? token.dangerButton : token.defaultButton} h-7 px-2.5 ${!enabled ? "cursor-not-allowed opacity-50" : ""}`}
                            disabled={!enabled}
                            title={!enabled ? "当前条件下不可操作" : undefined}
                            onClick={() => onAction(action, row)}
                          >
                            {action.label}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </td>
              )}
            </tr>
          ))}
          {!rows.length && (
            <tr>
              <td className="px-3 py-10 text-center text-sm text-[#607083]" colSpan={columns.length + (hasActions ? 1 : 0) + (selectable ? 1 : 0)}>
                暂无数据
              </td>
            </tr>
          )}
          {hasSummary && (
            <tr className="sticky bottom-0 z-10 border-t border-[#d9e3ed] bg-white font-semibold text-[#172033] shadow-[0_-1px_0_#e5e8ef]">
              {selectable && <td className={`${token.td} ${tdDensity}`} />}
              {sortedColumns.map((column, index) => (
                <td key={column.key} className={`${token.td} ${tdDensity} ${alignClass(columnAlign(column))} whitespace-nowrap`}>
                  {index === 0
                    ? "本页合计"
                    : numericColumns.some((item) => item.key === column.key) && columnHasNumeric(column.key)
                      ? summaryValue(column.key).toFixed(2)
                      : ""}
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
