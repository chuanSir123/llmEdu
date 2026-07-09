import { useEffect, useState } from "react";
import { GatewayClient } from "../api/GatewayClient";

export function PreviewRenderer({ schemaName, versionId, onClose }: { schemaName: string; versionId: string; onClose: () => void }) {
  const [previewUrl, setPreviewUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    GatewayClient.tenantAgentPreview(schemaName, versionId)
      .then((res) => {
        if (!cancelled) setPreviewUrl(res.previewUrl);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "加载预览失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [schemaName, versionId]);

  return (
    <div className="fixed inset-0 z-[200] flex items-start justify-center overflow-y-auto bg-black/45 p-4 pt-6 sm:pt-8">
      <div className="flex h-[92vh] w-full max-w-[1180px] flex-col rounded-lg bg-white shadow-[0_18px_48px_rgba(15,23,42,0.28)]">
        <div className="flex h-12 items-center justify-between border-b border-[#e8edf5] px-5">
          <div className="flex items-center gap-3">
            <h3 className="text-base font-semibold text-[#263445]">预览</h3>
            <span className="rounded-[3px] bg-[#fff7e6] px-2 py-0.5 text-xs font-medium text-[#d48806]">
              ⚠ 测试数据预览，实际效果以正式环境为准
            </span>
          </div>
          <button className="text-xl leading-none text-[#9aa4b5] hover:text-[#526075]" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="flex-1 overflow-auto">
          {loading && (
            <div className="flex h-full items-center justify-center p-8">
              <div className="w-full max-w-3xl space-y-4">
                <div className="h-8 w-48 animate-pulse rounded bg-[#eef0f8]" />
                <div className="grid grid-cols-3 gap-4">
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="h-24 animate-pulse rounded bg-[#eef0f8]" />
                  ))}
                </div>
                <div className="h-10 w-full animate-pulse rounded bg-[#eef0f8]" />
                {[0, 1, 2, 3, 4].map((i) => (
                  <div key={i} className="h-12 w-full animate-pulse rounded bg-[#eef0f8]" />
                ))}
              </div>
            </div>
          )}
          {error && (
            <div className="flex h-full items-center justify-center">
              <div className="text-center">
                <p className="text-sm text-[#ff4d64]">{error}</p>
                <button
                  className="mt-3 inline-flex h-8 items-center rounded-[3px] border border-[#2f80ed] bg-[#2f80ed] px-4 text-sm font-medium text-white hover:bg-[#1c6fd8]"
                  onClick={onClose}
                >
                  关闭
                </button>
              </div>
            </div>
          )}
          {previewUrl && !loading && !error && (
            <div className="flex h-full items-center justify-center">
              <div className="text-center">
                <p className="text-sm text-[#526075]">预览环境已生成</p>
                <button
                  className="mt-3 inline-flex h-8 items-center rounded-[3px] border border-[#2f80ed] bg-[#2f80ed] px-4 text-sm font-medium text-white hover:bg-[#1c6fd8]"
                  onClick={() => window.open(previewUrl, "_blank")}
                >
                  打开预览
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
