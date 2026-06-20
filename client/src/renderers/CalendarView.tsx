import { useMemo, useState } from "react";
import type { ActionDsl, PageDsl } from "../dsl/types";

type CalendarRow = Record<string, unknown>;

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function toDateString(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function getDaysInMonth(year: number, month: number) {
  return new Date(year, month + 1, 0).getDate();
}

function getFirstDayOfWeek(year: number, month: number) {
  return new Date(year, month, 1).getDay();
}

export function CalendarView({
  dsl,
  rows,
  onAction
}: {
  dsl: PageDsl;
  rows: CalendarRow[];
  onAction: (action: ActionDsl, row: CalendarRow) => void;
}) {
  const today = new Date();
  const [viewYear, setViewYear] = useState(today.getFullYear());
  const [viewMonth, setViewMonth] = useState(today.getMonth());
  const [viewMode, setViewMode] = useState<"month" | "week">("month");

  const dateField = (dsl.presentation as Record<string, unknown>)?.calendarField as string ?? "course_date";

  const rowsByDate = useMemo(() => {
    const map = new Map<string, CalendarRow[]>();
    for (const row of rows) {
      const dateVal = String(row[dateField] ?? "").slice(0, 10);
      if (!dateVal) continue;
      map.set(dateVal, [...(map.get(dateVal) ?? []), row]);
    }
    return map;
  }, [rows, dateField]);

  const detailAction = dsl.table?.rowActions?.find((a) => a.actionCode.endsWith(".detail")) ?? dsl.table?.rowActions?.[0];

  function prevMonth() {
    if (viewMonth === 0) { setViewMonth(11); setViewYear(viewYear - 1); }
    else setViewMonth(viewMonth - 1);
  }

  function nextMonth() {
    if (viewMonth === 11) { setViewMonth(0); setViewYear(viewYear + 1); }
    else setViewMonth(viewMonth + 1);
  }

  function goToday() {
    setViewYear(today.getFullYear());
    setViewMonth(today.getMonth());
  }

  const daysInMonth = getDaysInMonth(viewYear, viewMonth);
  const firstDay = getFirstDayOfWeek(viewYear, viewMonth);
  const weekDays = ["日", "一", "二", "三", "四", "五", "六"];
  const monthNames = ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"];

  const calendarCells: Array<{ date: string; day: number; isCurrentMonth: boolean }> = [];
  const prevMonthDays = viewMonth === 0 ? getDaysInMonth(viewYear - 1, 11) : getDaysInMonth(viewYear, viewMonth - 1);
  for (let i = firstDay - 1; i >= 0; i--) {
    const d = prevMonthDays - i;
    const m = viewMonth === 0 ? 11 : viewMonth - 1;
    const y = viewMonth === 0 ? viewYear - 1 : viewYear;
    calendarCells.push({ date: `${y}-${pad(m + 1)}-${pad(d)}`, day: d, isCurrentMonth: false });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    calendarCells.push({ date: `${viewYear}-${pad(viewMonth + 1)}-${pad(d)}`, day: d, isCurrentMonth: true });
  }
  const remaining = 42 - calendarCells.length;
  for (let d = 1; d <= remaining; d++) {
    const m = viewMonth === 11 ? 0 : viewMonth + 1;
    const y = viewMonth === 11 ? viewYear + 1 : viewYear;
    calendarCells.push({ date: `${y}-${pad(m + 1)}-${pad(d)}`, day: d, isCurrentMonth: false });
  }

  const todayStr = toDateString(today);

  function statusColor(status: unknown) {
    const s = String(status ?? "");
    if (s === "FINISHED" || s === "CONFIRMED") return "bg-green-100 text-green-700";
    if (s === "SCHEDULED" || s === "PENDING") return "bg-blue-100 text-blue-700";
    if (s === "CANCELLED" || s === "REVERSED") return "bg-gray-100 text-gray-500";
    return "bg-amber-100 text-amber-700";
  }

  return (
    <div className="flex h-full flex-col bg-white">
      <div className="flex items-center justify-between border-b border-[#e8edf5] px-4 py-3">
        <div className="flex items-center gap-2">
          <button className="rounded px-2 py-1 text-sm text-[#526075] hover:bg-[#f2f7ff]" onClick={prevMonth}>&lt;</button>
          <span className="text-sm font-semibold text-[#263445]">{viewYear}年 {monthNames[viewMonth]}</span>
          <button className="rounded px-2 py-1 text-sm text-[#526075] hover:bg-[#f2f7ff]" onClick={nextMonth}>&gt;</button>
          <button className="ml-2 rounded border border-[#dde3ee] px-2 py-1 text-xs text-[#526075] hover:bg-[#f2f7ff]" onClick={goToday}>今天</button>
        </div>
        <div className="flex gap-1">
          <button className={`rounded px-2 py-1 text-xs ${viewMode === "month" ? "bg-[#4968ff] text-white" : "text-[#526075] hover:bg-[#f2f7ff]"}`} onClick={() => setViewMode("month")}>月</button>
          <button className={`rounded px-2 py-1 text-xs ${viewMode === "week" ? "bg-[#4968ff] text-white" : "text-[#526075] hover:bg-[#f2f7ff]"}`} onClick={() => setViewMode("week")}>周</button>
        </div>
      </div>
      <div className="flex-1 overflow-auto p-2">
        <div className="grid grid-cols-7 gap-px bg-[#e8edf5]">
          {weekDays.map((wd) => (
            <div key={wd} className="bg-[#f7f9fc] py-2 text-center text-xs font-medium text-[#7a8494]">{wd}</div>
          ))}
          {calendarCells.map((cell, idx) => {
            const cellRows = rowsByDate.get(cell.date) ?? [];
            const isToday = cell.date === todayStr;
            return (
              <div key={idx} className={`min-h-[80px] bg-white p-1 ${cell.isCurrentMonth ? "" : "opacity-40"}`}>
                <div className={`mb-1 text-xs ${isToday ? "flex h-5 w-5 items-center justify-center rounded-full bg-[#4968ff] font-semibold text-white" : "text-[#526075]"}`}>
                  {cell.day}
                </div>
                <div className="space-y-0.5">
                  {cellRows.slice(0, 3).map((row, ri) => (
                    <button
                      key={ri}
                      className={`w-full truncate rounded px-1 py-0.5 text-left text-[10px] ${statusColor(row.course_status ?? row.charge_status ?? row.status)}`}
                      onClick={() => detailAction && onAction(detailAction, row)}
                      title={String(row.course_title ?? row.name ?? "")}
                    >
                      {String(row.course_title ?? row.name ?? "")}
                    </button>
                  ))}
                  {cellRows.length > 3 && (
                    <div className="text-[10px] text-[#8b95a7]">+{cellRows.length - 3} 更多</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}