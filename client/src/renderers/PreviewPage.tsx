import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { GatewayClient } from "../api/GatewayClient";

export function PreviewPage() {
  const params = useParams();
  const schemaName = params.schemaName;
  const [searchParams] = useSearchParams();
  const versionId = searchParams.get("versionId");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!schemaName || !versionId) {
      setError("缺少参数");
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError("");
    GatewayClient.tenantAgentPreview(schemaName, versionId)
      .then((res) => {
        if (!cancelled && res.previewUrl) {
          window.location.replace(res.previewUrl);
        } else if (!cancelled) {
          setError("预览地址为空");
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "加载预览失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [schemaName, versionId]);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#f4f6f9]">
        <div className="w-full max-w-3xl space-y-4 p-8">
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
    );
  }

  if (error) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#f4f6f9]">
        <div className="text-center">
          <p className="text-sm text-[#ff4d64]">{error}</p>
          <button
            className="mt-3 inline-flex h-8 items-center rounded-[3px] border border-[#2f80ed] bg-[#2f80ed] px-4 text-sm font-medium text-white hover:bg-[#1c6fd8]"
            onClick={() => window.close()}
          >
            关闭
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen overflow-auto bg-[#f4f6f9]">
      <div className="sticky top-0 z-10 flex h-10 items-center justify-between border-b border-[#e8edf5] bg-white px-4">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-semibold text-[#263445]">预览模式</h3>
          <span className="rounded-[3px] bg-[#fff7e6] px-2 py-0.5 text-xs font-medium text-[#d48806]">
            测试数据预览
          </span>
        </div>
        <button
          className="text-xs text-[#7a8494] hover:text-[#2f80ed]"
          onClick={() => window.close()}
        >
          关闭预览
        </button>
      </div>
      <div className="flex h-[calc(100vh-40px)] items-center justify-center text-sm text-[#7a8494]">
        正在打开预览环境...
      </div>
    </div>
  );
}
