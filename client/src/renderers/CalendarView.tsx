import { useMemo, useState } from "react";
import type { ActionDsl, PageDsl } from "../dsl/types";
import { enumDisplayFor } from "../dsl/enumLabels";
import { ActionRenderer } from "./ActionRenderer";

type CalendarRow = Record<string, unknown>;

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function toDateString(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseDate(value: unknown) {
  const text = String(value ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return undefined;
  const date = new Date(`${text}T00:00:00`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function mondayOf(date: Date) {
  const day = date.getDay() || 7;
  return addDays(date, 1 - day);
}

function timeToMinutes(value: unknown) {
  const [h, m] = String(value ?? "00:00").split(":").map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

function labelFor(value: unknown, labels?: Record<string, Record<string, string>>) {
  const text = String(value ?? "");
  return enumDisplayFor("course_status", text, labels);
}

export function CalendarView({
  dsl,
  rows,
  toolbar = [],
  onToolbar,
  onAction
}: {
  dsl: PageDsl;
  rows: CalendarRow[];
  toolbar?: ActionDsl[];
  onToolbar?: (action: ActionDsl) => void;
  onAction: (action: ActionDsl, row: CalendarRow) => void;
}) {
  const firstRowDate = parseDate(rows[0]?.course_date);
  const today = new Date();
  const [anchorDate, setAnchorDate] = useState(firstRowDate ?? today);
  const [viewMode, setViewMode] = useState<"day" | "week" | "month">("week");
  const [hoverRow, setHoverRow] = useState<CalendarRow | null>(null);

  const dateField = (dsl.presentation as Record<string, unknown>)?.calendarField as string ?? "course_date";
  const weekStart = mondayOf(anchorDate);
  const days = Array.from({ length: viewMode === "day" ? 1 : 7 }, (_, index) => addDays(viewMode === "day" ? anchorDate : weekStart, index));
  const dayKeys = days.map(toDateString);
  const weekDays = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
  const labels = dsl.presentation?.valueLabels;
  const detailAction = dsl.table?.rowActions?.find((a) => a.actionCode.endsWith(".detail")) ?? dsl.table?.rowActions?.[0];

  const visibleRows = useMemo(() => {
    const keys = new Set(dayKeys);
    return rows
      .filter((row) => keys.has(String(row[dateField] ?? "").slice(0, 10)))
      .sort((a, b) => timeToMinutes(a.start_time) - timeToMinutes(b.start_time));
  }, [rows, dateField, dayKeys.join("|")]);

  const rowsByDate = useMemo(() => {
    const map = new Map<string, CalendarRow[]>();
    for (const row of visibleRows) {
      const dateVal = String(row[dateField] ?? "").slice(0, 10);
      map.set(dateVal, [...(map.get(dateVal) ?? []), row]);
    }
    return map;
  }, [visibleRows, dateField]);

  const summary = useMemo(() => {
    const finished = visibleRows.filter((row) => String(row.course_status ?? "") === "FINISHED").length;
    const charged = visibleRows.filter((row) => String(row.charge_status ?? "") === "CONFIRMED").length;
    const notStarted = visibleRows.length - finished;
    const totalHour = visibleRows.reduce((sum, row) => sum + Number(row.course_hour ?? 0), 0);
    const totalAmount = visibleRows.reduce((sum, row) => sum + Number(row.charge_amount ?? 0), 0);
    return { total: visibleRows.length, charged, finished, notStarted, totalHour, totalAmount };
  }, [visibleRows]);

  const toneClass: Record<string, string> = {
    green: "bg-[#50c79b] shadow-[#50c79b]/20",
    gray: "bg-[#98a2b3] shadow-[#98a2b3]/20",
    amber: "bg-[#f0b84f] shadow-[#f0b84f]/20",
    blue: "bg-[#68b4eb] shadow-[#68b4eb]/25"
  };

  function dictionaryTone(dictCode: string, value: unknown) {
    return String(dsl.presentation?.dictionaryMeta?.[dictCode]?.[String(value ?? "")]?.tone ?? "");
  }

  function courseTone(row: CalendarRow) {
    const chargeTone = dictionaryTone("charge_status", row.charge_status);
    if (chargeTone === "green") return toneClass.green;
    const courseTone = dictionaryTone("course_status", row.course_status);
    return toneClass[courseTone] ?? toneClass.blue;
  }

  function shift(days: number) {
    setAnchorDate((current) => addDays(current, days));
  }

  const anchorLabel = `${anchorDate.getFullYear()}年${pad(anchorDate.getMonth() + 1)}月${pad(anchorDate.getDate())}日`;

  return (
    <div className="flex h-full flex-col bg-white text-[#172033]">
      <div className="shrink-0 border-b border-[#edf0f5] px-7 py-4 text-base">
        上课合计： <span className="font-semibold">{summary.total}</span>
        <span className="mx-2 text-[#8b95a7]">|</span>已扣费： <span className="font-semibold">{summary.charged}</span>;
        <span className="mx-2 text-[#8b95a7]">|</span>已考勤： <span className="font-semibold">{summary.finished}</span>;
        <span className="mx-2 text-[#8b95a7]">|</span>未上课： <span className="font-semibold">{summary.notStarted}</span>
        <span className="mx-2 text-[#8b95a7]">|</span>课消课时： <span className="font-semibold">{summary.totalHour.toFixed(2)}</span>;
        <span className="mx-2 text-[#8b95a7]">|</span>课消金额： <span className="font-semibold">{summary.totalAmount.toFixed(2)}</span>
      </div>

      <div className="flex shrink-0 items-center justify-between border-b border-[#edf0f5] px-7 py-3">
        <div className="flex items-center gap-5">
          <div className="flex items-center gap-4 text-sm">
            <span className="inline-flex items-center gap-1"><i className="h-4 w-4 bg-[#68b4eb] shadow-[0_4px_10px_rgba(104,180,235,0.35)]" />未上课</span>
            <span className="inline-flex items-center gap-1"><i className="h-4 w-4 bg-[#9d8be0] shadow-[0_4px_10px_rgba(157,139,224,0.35)]" />已考勤</span>
            <span className="inline-flex items-center gap-1"><i className="h-4 w-4 bg-[#50c79b] shadow-[0_4px_10px_rgba(80,199,155,0.35)]" />已扣费</span>
          </div>
          <div className="flex items-center overflow-hidden rounded-[2px] border border-[#dde3ee] text-sm">
            {(["day", "week", "month"] as const).map((mode) => (
              <button key={mode} className={`h-8 px-4 ${viewMode === mode ? "bg-[#4b8df7] text-white" : "bg-white text-[#526075] hover:bg-[#f2f7ff]"}`} onClick={() => setViewMode(mode)}>
                {mode === "day" ? "日" : mode === "week" ? "周" : "月"}
              </button>
            ))}
          </div>
          <button className="h-8 w-8 rounded-[2px] border border-[#dde3ee] text-[#8b95a7] hover:text-[#2f80ed]" onClick={() => shift(viewMode === "month" ? -30 : viewMode === "week" ? -7 : -1)}>‹</button>
          <span className="min-w-[150px] text-center text-base font-medium">{anchorLabel}</span>
          <button className="h-8 w-8 rounded-[2px] border border-[#dde3ee] text-[#8b95a7] hover:text-[#2f80ed]" onClick={() => shift(viewMode === "month" ? 30 : viewMode === "week" ? 7 : 1)}>›</button>
          <button className="h-8 min-w-[82px] rounded-[2px] border border-[#dde3ee] px-3 text-sm hover:text-[#2f80ed]" onClick={() => setAnchorDate(today)}>今天</button>
          <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-[#c8ced8] text-[10px] font-bold text-white">i</span>
        </div>
        <div className="flex items-center gap-3">
          {toolbar.map((action) => <ActionRenderer key={action.actionCode} action={action} onClick={(item) => onToolbar?.(item)} />)}
        </div>
      </div>

      <div className="grid shrink-0 border-b border-[#edf0f5] bg-[#f7f8fa]" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(180px, 1fr))` }}>
        {days.map((day, index) => (
          <div key={toDateString(day)} className="border-r border-[#edf0f5] py-3 text-center text-sm text-[#7a8494] last:border-r-0">
            {viewMode === "day" ? anchorLabel : weekDays[index]}
          </div>
        ))}
      </div>

      <div className="relative min-h-0 flex-1 overflow-auto bg-white">
        <div className="grid min-h-full" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(180px, 1fr))` }}>
          {days.map((day) => {
            const key = toDateString(day);
            const dayRows = rowsByDate.get(key) ?? [];
            return (
              <div key={key} className="border-r border-[#edf0f5] p-4 last:border-r-0">
                <div className="mb-6 text-xs text-[#8b95a7]">共{dayRows.length}节课</div>
                <div className="space-y-1">
                  {dayRows.map((row, index) => (
                    <button
                      key={`${row.id ?? index}`}
                      className={`block w-full rounded-[3px] px-3 py-2 text-left text-xs text-white shadow ${courseTone(row)}`}
                      onClick={() => detailAction && onAction(detailAction, row)}
                      onMouseEnter={() => setHoverRow(row)}
                      onMouseLeave={() => setHoverRow(null)}
                    >
                      <div className="truncate font-semibold">{String(row.course_title ?? row.name ?? "未命名课程")}</div>
                      <div className="mt-1 flex justify-between gap-2"><span>{String(row.start_time ?? "").slice(0, 5)} - {String(row.end_time ?? "").slice(0, 5)}</span><span>{String(row.teacher_id ?? "")}</span></div>
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        {hoverRow && (
          <div className="pointer-events-none absolute left-[260px] top-6 z-20 w-[304px] border border-[#dde3ee] bg-white p-5 text-sm shadow-[0_4px_14px_rgba(24,36,56,0.18)]">
            {[
              ["上课校区", hoverRow.organization_id],
              ["上课日期", String(hoverRow.course_date ?? "").slice(0, 10)],
              ["上课时间", `${String(hoverRow.start_time ?? "").slice(0, 5)} - ${String(hoverRow.end_time ?? "").slice(0, 5)}`],
              ["老师", hoverRow.teacher_id],
              ["班主任", hoverRow.study_manager_id],
              ["课程名称", hoverRow.course_title],
              ["课程状态", labelFor(hoverRow.course_status, labels)],
              ["应到人数", hoverRow.student_count ?? 1],
              ["标签", hoverRow.tags ?? "无标签"],
              ["备注", hoverRow.remark ?? "无备注"]
            ].map(([label, value]) => (
              <div key={String(label)} className="mb-2 grid grid-cols-[64px_1fr] gap-3"><span className="text-[#172033]">{String(label)}</span><span className="text-[#172033]">{String(value ?? "-")}</span></div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
