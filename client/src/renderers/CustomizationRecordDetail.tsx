import { useEffect, useState } from "react";
import { GatewayClient } from "../api/GatewayClient";
import { MarkdownContent } from "./MarkdownContent";

type ProgressEvent = {
  title: string;
  message: string;
  stage: string;
  createdAt: string;
  toolName?: string;
  status?: string;
};

type TimelineEntry = {
  role: string;
  content: string;
  dslDiff?: unknown;
  progressEvents?: ProgressEvent[];
  timestamp: string;
};

type RecordDetail = {
  id: string;
  schemaName: string;
  sessionId: string;
  recordType?: string;
  userPrompt?: string;
  changeSummary: string;
  skillMd: string;
  chatTimeline: TimelineEntry[];
};

function progressStatusLabel(status?: string) {
  if (status === "running") return "执行中";
  if (status === "success") return "完成";
  if (status === "failed") return "失败";
  if (status === "skipped") return "跳过";
  return "";
}

function normalizeProgressEvents(value: unknown): ProgressEvent[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => item && typeof item === "object" ? item as Record<string, unknown> : null)
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item) => ({
      title: String(item.title ?? "执行步骤"),
      message: String(item.message ?? ""),
      stage: String(item.stage ?? "step"),
      createdAt: String(item.createdAt ?? item.created_at ?? ""),
      toolName: item.toolName ? String(item.toolName) : undefined,
      status: item.status ? String(item.status) : undefined,
    }));
}

function ProgressTimeline({ events }: { events: ProgressEvent[] }) {
  if (!events.length) return null;
  return (
    <div className="mt-2 rounded-[8px] border border-[#e8edf5] bg-white px-3 py-3">
      <div className="mb-2 text-xs font-medium text-[#2f80ed]">执行过程</div>
      <div className="space-y-2">
        {events.map((event, eventIdx) => {
          const status = event.status === "running" && eventIdx < events.length - 1 ? "success" : event.status ?? "success";
          const statusLabel = progressStatusLabel(status);
          return (
            <div key={`${event.stage}-${eventIdx}`} className="flex gap-2 text-xs leading-relaxed text-[#526075]">
              <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-[#b8c2d2]" />
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-medium text-[#263445]">{event.title}</span>
                  {statusLabel && (
                    <span className="rounded-[3px] bg-[#eef3f8] px-1.5 py-0.5 text-[10px] text-[#607083]">
                      {statusLabel}
                    </span>
                  )}
                </div>
                <div>{event.message}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function CustomizationRecordDetail({
  recordId,
  onClose,
  onContinue
}: {
  recordId: string;
  onClose: () => void;
  onContinue?: (schemaName: string, sessionId: string) => void;
}) {
  const [detail, setDetail] = useState<RecordDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    GatewayClient.getCustomizationRecordDetail(recordId)
      .then((res) => {
        if (cancelled) return;
        if (!res.record) {
          setError("记录不存在");
          setDetail(null);
          return;
        }
        setDetail({
          ...(res.record as RecordDetail),
          changeSummary: res.record.changeSummary ?? "",
          skillMd: res.record.skillMd ?? "",
          chatTimeline: Array.isArray(res.record.chatTimeline)
            ? res.record.chatTimeline.map((entry) => ({
                ...entry,
                progressEvents: normalizeProgressEvents(entry.progressEvents),
              }))
            : []
        });
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "加载详情失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [recordId]);

  return (
    <div className="fixed inset-0 z-[200] flex items-start justify-center overflow-y-auto bg-black/45 p-4 pt-6 sm:pt-8">
      <div className="flex h-[92vh] w-full max-w-[1180px] flex-col rounded-lg bg-white shadow-[0_18px_48px_rgba(15,23,42,0.28)]">
        <div className="flex h-12 items-center justify-between border-b border-[#e8edf5] px-5">
          <div>
            <h3 className="text-base font-semibold text-[#263445]">AI 对话记录</h3>
            {detail && <div className="text-xs text-[#8b95a7]">{detail.schemaName} / {detail.sessionId}</div>}
          </div>
          <div className="flex items-center gap-2">
            {detail && onContinue && (
              <button
                className="inline-flex h-7 items-center rounded-[3px] border border-[#2f80ed] bg-white px-3 text-xs font-medium text-[#2f80ed] hover:bg-[#edf3ff]"
                onClick={() => onContinue(detail.schemaName, detail.sessionId)}
              >
                继续对话
              </button>
            )}
            <button className="text-xl leading-none text-[#9aa4b5] hover:text-[#526075]" onClick={onClose}>×</button>
          </div>
        </div>
        <div className="flex-1 overflow-hidden">
          {loading && (
            <div className="flex h-full items-center justify-center">
              <div className="space-y-4 w-full max-w-3xl px-8">
                <div className="h-8 w-64 animate-pulse rounded bg-[#eef0f8]" />
                <div className="h-40 animate-pulse rounded bg-[#eef0f8]" />
                <div className="h-32 animate-pulse rounded bg-[#eef0f8]" />
              </div>
            </div>
          )}
          {error && (
            <div className="flex h-full items-center justify-center">
              <p className="text-sm text-[#ff4d64]">{error}</p>
            </div>
          )}
          {detail && !loading && !error && (
            <div className="flex h-full flex-col bg-[#f5f7fb]">
              <div className="flex-1 overflow-auto px-6 py-5">
                <div className="mx-auto max-w-[920px] space-y-5">
                  {(detail.chatTimeline ?? []).map((entry, idx) => {
                    const isUser = entry.role === "user";
                    const progressEvents = normalizeProgressEvents(entry.progressEvents);
                    return (
                      <div key={idx} className={`flex gap-3 ${isUser ? "justify-end" : "justify-start"}`}>
                        {!isUser && (
                          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#e8f1ff] text-xs font-semibold text-[#2f80ed]">AI</div>
                        )}
                        <div className={`min-w-0 max-w-[76%] ${isUser ? "items-end" : "items-start"}`}>
                          <div className={`mb-1 text-xs ${isUser ? "text-right" : ""} text-[#8b95a7]`}>{entry.timestamp ? new Date(entry.timestamp).toLocaleString() : "未知时间"}</div>
                          <div className={`rounded-[8px] px-4 py-3 text-sm leading-6 shadow-sm ${
                            isUser ? "bg-[#2f80ed] text-white" : "border border-[#e8edf5] bg-white text-[#263445]"
                          }`}>
                            <MarkdownContent content={entry.content} inverse={isUser} />
                          </div>
                          {!isUser && <ProgressTimeline events={progressEvents} />}
                        </div>
                        {isUser && (
                          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#2f80ed] text-xs font-semibold text-white">我</div>
                        )}
                      </div>
                    );
                  })}
                  {!(detail.chatTimeline ?? []).length && (
                    <div className="border border-dashed border-[#cfd8e6] bg-white py-10 text-center text-sm text-[#8b95a7]">没有找到原始对话记录</div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
