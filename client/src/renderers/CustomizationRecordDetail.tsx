import { useEffect, useState } from "react";
import { GatewayClient } from "../api/GatewayClient";

type TimelineEntry = {
  role: string;
  content: string;
  dslDiff?: unknown;
  timestamp: string;
};

type RecordDetail = {
  id: string;
  schemaName: string;
  sessionId: string;
  changeSummary: string;
  skillMd: string;
  chatTimeline: TimelineEntry[];
};

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
  const [expandedDiffs, setExpandedDiffs] = useState<Record<number, boolean>>({});

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    GatewayClient.getCustomizationRecordDetail(recordId)
      .then((res) => {
        if (!cancelled) setDetail(res.record as RecordDetail);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "加载详情失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [recordId]);

  function toggleDiff(idx: number) {
    setExpandedDiffs((prev) => ({ ...prev, [idx]: !prev[idx] }));
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
      <div className="flex h-[92vh] w-full max-w-[1180px] flex-col rounded-lg bg-white shadow-[0_18px_48px_rgba(15,23,42,0.28)]">
        <div className="flex h-12 items-center justify-between border-b border-[#e8edf5] px-5">
          <div>
            <h3 className="text-base font-semibold text-[#263445]">AI 对话记录</h3>
            {detail && <div className="text-xs text-[#8b95a7]">{detail.schemaName} / {detail.sessionId}</div>}
          </div>
          <div className="flex items-center gap-2">
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
              <div className="border-b border-[#e8edf5] bg-white px-6 py-4">
                <div className="text-sm font-semibold text-[#263445]">本次变更摘要</div>
                <div className="mt-2 whitespace-pre-wrap text-sm leading-6 text-[#526075]">{detail.changeSummary || "无变更摘要"}</div>
              </div>
              <div className="flex-1 overflow-auto px-6 py-5">
                <div className="mx-auto max-w-[920px] space-y-5">
                  {detail.chatTimeline.map((entry, idx) => {
                    const isUser = entry.role === "user";
                    return (
                      <div key={idx} className={`flex gap-3 ${isUser ? "justify-end" : "justify-start"}`}>
                        {!isUser && (
                          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#e8f1ff] text-xs font-semibold text-[#2f80ed]">AI</div>
                        )}
                        <div className={`min-w-0 max-w-[76%] ${isUser ? "items-end" : "items-start"}`}>
                          <div className={`mb-1 text-xs ${isUser ? "text-right" : ""} text-[#8b95a7]`}>{new Date(entry.timestamp).toLocaleString()}</div>
                          <div className={`whitespace-pre-wrap rounded-[8px] px-4 py-3 text-sm leading-6 shadow-sm ${
                            isUser ? "bg-[#2f80ed] text-white" : "border border-[#e8edf5] bg-white text-[#263445]"
                          }`}>
                            {entry.content}
                          </div>
                        {entry.dslDiff != null && (
                          <div className="mt-2">
                            <button
                              className="text-xs text-[#2f80ed] hover:underline"
                              onClick={() => toggleDiff(idx)}
                            >
                              {expandedDiffs[idx] ? "收起 DSL 变更" : "展开 DSL 变更"}
                            </button>
                            {expandedDiffs[idx] && (
                              <pre className="mt-2 max-h-60 overflow-auto rounded bg-[#f7f8fa] p-3 text-xs text-[#526075]">
                                {typeof entry.dslDiff === "string" ? entry.dslDiff : JSON.stringify(entry.dslDiff, null, 2)}
                              </pre>
                            )}
                          </div>
                        )}
                      </div>
                        {isUser && (
                          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#2f80ed] text-xs font-semibold text-white">我</div>
                        )}
                      </div>
                    );
                  })}
                  {!detail.chatTimeline.length && (
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
