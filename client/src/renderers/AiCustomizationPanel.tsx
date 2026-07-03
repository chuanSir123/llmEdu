import { useEffect, useRef, useState } from "react";
import { GatewayClient } from "../api/GatewayClient";
import { useToast } from "../context/ToastContext";


type DraftInfo = {
  versionId: string;
  versionNo: number;
  summary: string;
  previewed?: boolean;
};

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  draftInfo?: DraftInfo;
  timestamp: string;
  sessionId?: string;
  streaming?: boolean;
  progressEvents?: Array<{ title: string; message: string; stage: string; createdAt: string; toolName?: string; status?: string }>;
  progressExpanded?: boolean;
};

type StepLog = {
  step_name: string;
  display_name?: string;
  tenant_summary?: string;
  input_summary: string;
  output_summary: string;
  duration_ms: number;
  llm_tokens_used: number | null;
  created_at: string;
};

type VersionRow = {
  id: string;
  version_no: number;
  target_type: string;
  target_code: string;
  status: string;
  change_type: string;
  change_summary: string;
  created_at: string;
};

type LlmCallLog = {
  schema_name: string;
  model: string;
  has_tools: boolean;
  tool_names: string[];
  messages_json: Array<{ role: string; content: string }>;
  response_content: string | null;
  function_call: { name?: string; arguments?: string } | null;
  status: string;
  error: string | null;
  duration_ms: number;
  tokens_used: number | null;
  created_at: string;
};

type AttachmentItem = {
  id: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  storageUrl: string;
};

export function AiCustomizationPanel({ schemaName, initialSessionId, onClose }: { schemaName: string; initialSessionId?: string; onClose: () => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [sessionId, setSessionId] = useState<string>();
  const [attachments, setAttachments] = useState<AttachmentItem[]>([]);
  const [uploadingAttachment, setUploadingAttachment] = useState(false);

  const [publishConfirm, setPublishConfirm] = useState<DraftInfo | null>(null);
  const [processingVersionId, setProcessingVersionId] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const [stepLogs, setStepLogs] = useState<StepLog[] | null>(null);
  const [llmLogs, setLlmLogs] = useState<LlmCallLog[] | null>(null);
  const [stepLogSessionId, setStepLogSessionId] = useState<string | null>(null);
  const [versionList, setVersionList] = useState<VersionRow[] | null>(null);
  const [rollbackPreviewing, setRollbackPreviewing] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const toast = useToast();
  const [versionStatusLabels, setVersionStatusLabels] = useState<Record<string, string>>({});


  useEffect(() => {
    let cancelled = false;
    GatewayClient.executeApi({
      scope: "tenant",
      schemaName,
      pageCode: "__dictionary__",
      apiCode: "dictionary.options",
      params: { dictCode: "status" }
    })
      .then((res) => {
        if (cancelled) return;
        const rows = Array.isArray((res.data as { rows?: unknown[] })?.rows) ? (res.data as { rows: Array<Record<string, unknown>> }).rows : [];
        setVersionStatusLabels(Object.fromEntries(rows.map((row) => [String(row.itemValue ?? row.item_value ?? row.value ?? ""), String(row.label ?? row.item_label ?? "")]).filter(([value, label]) => value && label)));
      })
      .catch(() => {
        if (!cancelled) setVersionStatusLabels({});
      });
    return () => {
      cancelled = true;
    };
  }, [schemaName]);

  useEffect(() => {
    let cancelled = false;
    requestAnimationFrame(() => setVisible(true));
    setMessages([]);
    setSessionId(initialSessionId);
    setAttachments([]);
    if (initialSessionId) {
      GatewayClient.getActiveChatSession(schemaName, initialSessionId)
        .then((res) => {
          if (cancelled) return;
          setSessionId(res.sessionId || initialSessionId);
          setMessages(
            res.messages
              .filter((msg) => msg.role === "user" || msg.role === "assistant")
              .map((msg) => ({
                role: msg.role as "user" | "assistant",
                content: msg.content,
                draftInfo: msg.draftInfo,
                timestamp: msg.timestamp,
                sessionId: res.sessionId || initialSessionId,
              }))
          );
        })
        .catch((err) => toast.error(`加载原对话失败：${err instanceof Error ? err.message : String(err)}`));
    }
    return () => {
      cancelled = true;
    };
  }, [schemaName, initialSessionId]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  async function send() {
    const text = input.trim();
    if ((!text && attachments.length === 0) || sending) return;
    setInput("");
    const currentAttachments = attachments;
    setAttachments([]);
    const streamId = `stream_${Date.now()}`;
    const attachmentText = currentAttachments.length ? `\n\n附件：${currentAttachments.map((item) => item.fileName).join("、")}` : "";
    const userMsg: ChatMessage = { role: "user", content: `${text}${attachmentText}`, timestamp: new Date().toISOString() };
    const assistantMsg: ChatMessage = {
      role: "assistant",
      content: "",
      timestamp: new Date().toISOString(),
      streaming: true,
      sessionId: streamId,
      progressEvents: [],
      progressExpanded: true,
    };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setSending(true);
    try {
      let streamedSummary = "";
      const res = await GatewayClient.tenantAgentChatStream(schemaName, text || "请根据附件生成定制方案", sessionId, currentAttachments.map((item) => item.id), {
        onProgress: (event) => {
          if (!event.visibleToTenant) return;
          setMessages((prev) =>
            prev.map((msg) =>
              msg.sessionId === streamId && msg.streaming
                ? {
                    ...msg,
                    progressEvents: [
                      ...(msg.progressEvents ?? []),
                      { title: event.title, message: event.message, stage: event.stage, createdAt: event.createdAt, toolName: event.toolName, status: event.status },
                    ],
                  }
                : msg
            )
          );
        },
        onSummary: (summary) => {
          streamedSummary = summary;
          setMessages((prev) =>
            prev.map((msg) =>
              msg.sessionId === streamId && msg.streaming
                ? { ...msg, content: summary, progressExpanded: false }
                : msg
            )
          );
        },
      });
      setSessionId(res.sessionId);
      const tenantSummary = streamedSummary || res.reply;
      setMessages((prev) =>
        prev.map((msg) =>
          msg.sessionId === streamId && msg.streaming
            ? {
                ...msg,
                content: tenantSummary,
                draftInfo: res.draftInfo ? { ...res.draftInfo, previewed: false } : undefined,
                timestamp: new Date().toISOString(),
                sessionId: res.sessionId,
                streaming: false,
                progressExpanded: false,
              }
            : msg
        )
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "请求失败";
      toast.error(message);
      setMessages((prev) =>
        prev.map((msg) =>
          msg.sessionId === streamId && msg.streaming
            ? { ...msg, content: `AI 定制化执行失败：${message}`, streaming: false }
            : msg
        )
      );
    } finally {
      setSending(false);
    }
  }

  function fileToBase64(file: File) {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.onerror = () => reject(reader.error ?? new Error("读取文件失败"));
      reader.readAsDataURL(file);
    });
  }

  async function handleAttachmentFile(file: File) {
    setUploadingAttachment(true);
    try {
      const contentBase64 = await fileToBase64(file);
      const res = await GatewayClient.uploadAgentAttachment({
        schemaName,
        sessionId,
        fileName: file.name,
        mimeType: file.type || "application/octet-stream",
        contentBase64,
      });
      setAttachments((prev) => [...prev, res.attachment]);
    } catch (err) {
      toast.error(`附件上传失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setUploadingAttachment(false);
    }
  }

  async function handlePreview(draft: DraftInfo) {
    try {
      const res = await GatewayClient.tenantAgentPreview(schemaName, draft.versionId);
      if (res.previewUrl) {
        window.open(res.previewUrl, "_blank");
      }
    } catch (err) {
      toast.error(`预览失败：${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    setMessages((prev) =>
      prev.map((msg) =>
        msg.draftInfo?.versionId === draft.versionId ? { ...msg, draftInfo: { ...msg.draftInfo, previewed: true } } : msg
      )
    );
  }

  async function handlePublish(draft: DraftInfo) {
    setPublishConfirm(null);
    setProcessingVersionId(draft.versionId);
    try {
      await GatewayClient.tenantAgentPublish(schemaName, draft.versionId);
      toast.success("发布成功");
      setMessages((prev) =>
        prev.map((msg) =>
          msg.draftInfo?.versionId === draft.versionId ? { ...msg, content: `${msg.content}\n\n已发布，变更已正式生效。`, draftInfo: undefined } : msg
        )
      );
    } catch (err) {
      toast.error(`发布失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setProcessingVersionId(null);
    }
  }

  async function handleShowStepLog(sid: string) {
    if (stepLogSessionId === sid && stepLogs) {
      setStepLogs(null);
      setLlmLogs(null);
      setStepLogSessionId(null);
      return;
    }
    try {
      const res = await GatewayClient.getHarnessLog(sid);
      setStepLogs(res.steps);
      setLlmLogs(res.llmCalls ?? []);
      setStepLogSessionId(sid);
    } catch {
      toast.error("获取执行详情失败");
    }
  }

  async function handleShowVersionList() {
    if (versionList) {
      setVersionList(null);
      return;
    }
    try {
      const res = await GatewayClient.tenantVersionList(schemaName);
      setVersionList(res);
    } catch {
      toast.error("获取版本历史失败");
    }
  }

  async function handleRollbackPreview(versionId: string) {
    setRollbackPreviewing(versionId);
    try {
      await GatewayClient.tenantVersionRollbackPreview(schemaName, versionId);
      toast.success("已回滚到本次预览前的效果");
    } catch (err) {
      toast.error(`回滚预览失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRollbackPreviewing(null);
    }
  }

  async function handleRollbackPreviewForDraft(draft: DraftInfo) {
    try {
      await handleRollbackPreview(draft.versionId);
    } catch (err) {
      toast.error(`回滚预览失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return (
    <>
      <div className={`fixed inset-0 z-50 transition-opacity duration-200 ${visible ? "opacity-100" : "opacity-0"}`}>
        <div className="absolute inset-0 bg-black/45" onClick={onClose} />
        <aside
          className={`absolute right-0 top-0 h-full w-[480px] flex flex-col bg-white shadow-[-8px_0_24px_rgba(15,23,42,0.18)] transition-transform duration-300 ease-out ${
            visible ? "translate-x-0" : "translate-x-full"
          }`}
        >
          <div className="flex h-14 items-center justify-between border-b border-[#e8edf5] px-5">
            <div className="flex items-center gap-2">
              <span className="text-lg">🤖</span>
              <h2 className="text-base font-semibold text-[#263445]">AI 定制助手</h2>
            </div>
            <div className="flex items-center gap-2">
              <button
                className={`inline-flex h-7 items-center rounded-[3px] border px-3 text-xs font-medium ${versionList ? "border-[#2f80ed] bg-[#edf3ff] text-[#2f80ed]" : "border-[#dde3ee] bg-white text-[#526075] hover:border-[#2f80ed] hover:text-[#2f80ed]"}`}
                onClick={() => void handleShowVersionList()}
              >
                版本历史
              </button>
              <button className="text-xl leading-none text-[#9aa4b5] hover:text-[#526075]" onClick={onClose}>
                ×
              </button>
            </div>
          </div>

          <div ref={scrollRef} className="flex-1 overflow-auto p-5 space-y-4">
            {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center py-16 text-[#8b95a7]">
                <span className="text-4xl mb-3">💬</span>
                <p className="text-sm">描述您想要的页面定制需求</p>
                <p className="text-xs mt-1">例如：在学员列表增加"家长手机号"列</p>
              </div>
            )}
            {messages.map((msg, idx) => (
              <div key={idx} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[85%] rounded-lg px-4 py-2.5 text-sm leading-relaxed ${
                    msg.role === "user"
                      ? "bg-[#2f80ed] text-white"
                      : "bg-[#f4f6f9] text-[#263445]"
                  }`}
                >
                  <div className="whitespace-pre-wrap">{msg.content}</div>
                  {msg.progressEvents && msg.progressEvents.length > 0 && (
                    <div className={`${msg.content ? "mt-3 border-t border-[#e0e4eb] pt-3" : ""}`}>
                      <button
                        className="mb-2 text-xs font-medium text-[#2f80ed] hover:underline"
                        onClick={() =>
                          setMessages((prev) =>
                            prev.map((item, itemIdx) =>
                              itemIdx === idx ? { ...item, progressExpanded: !item.progressExpanded } : item
                            )
                          )
                        }
                      >
                        {msg.progressExpanded || msg.streaming ? "收起执行过程" : `展开执行过程（${msg.progressEvents.length}步）`}
                      </button>
                      {(msg.progressExpanded || msg.streaming) && (
                        <div className="space-y-2">
                          {msg.progressEvents.map((event, eventIdx) => (
                            <div key={`${event.stage}-${eventIdx}`} className="flex gap-2 text-xs leading-relaxed text-[#526075]">
                              <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${msg.streaming && eventIdx === msg.progressEvents!.length - 1 ? "bg-[#2f80ed]" : "bg-[#b8c2d2]"}`} />
                              <div>
                                <div className="flex items-center gap-2">
                                  <span className="font-medium text-[#263445]">{event.title}</span>
                                  {event.status && (
                                    <span className="rounded-[3px] bg-[#eef3f8] px-1.5 py-0.5 text-[10px] text-[#607083]">
                                      {event.status === "running" ? "执行中" : event.status === "success" ? "完成" : event.status === "failed" ? "失败" : "跳过"}
                                    </span>
                                  )}
                                </div>
                                <div>{event.message}</div>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  {msg.draftInfo && msg.role === "assistant" && (
                    <div className="mt-3 flex flex-wrap gap-2 border-t border-[#e0e4eb] pt-3">
                      <button
                        className="inline-flex h-7 items-center rounded-[3px] border border-[#2f80ed] bg-white px-3 text-xs font-medium text-[#2f80ed] hover:bg-[#edf3ff]"
                        onClick={() => handlePreview(msg.draftInfo!)}
                        disabled={processingVersionId === msg.draftInfo.versionId}
                      >
                        {msg.draftInfo.previewed ? "再次预览" : "预览"}
                      </button>
                      {msg.draftInfo.previewed && (
                        <button
                          className="inline-flex h-7 items-center rounded-[3px] border border-[#dde3ee] bg-white px-3 text-xs font-medium text-[#526075] hover:border-[#2f80ed] hover:text-[#2f80ed]"
                          onClick={() => void handleRollbackPreviewForDraft(msg.draftInfo!)}
                          disabled={processingVersionId === msg.draftInfo.versionId}
                        >
                          回滚预览
                        </button>
                      )}
                      <button
                        className="inline-flex h-7 items-center rounded-[3px] border border-[#dde3ee] bg-white px-3 text-xs font-medium text-[#526075] hover:border-[#2f80ed] hover:text-[#2f80ed]"
                        onClick={() => setInput("请继续修改：")}
                        disabled={processingVersionId === msg.draftInfo.versionId}
                      >
                        继续修改
                      </button>
                      <button
                        className="inline-flex h-7 items-center rounded-[3px] border border-[#2f80ed] bg-[#2f80ed] px-3 text-xs font-medium text-white hover:bg-[#1c6fd8] disabled:opacity-50"
                        onClick={() => setPublishConfirm(msg.draftInfo!)}
                        disabled={processingVersionId === msg.draftInfo.versionId}
                      >
                        {processingVersionId === msg.draftInfo.versionId ? "处理中..." : "发布"}
                      </button>
                      {msg.sessionId && (
                        <button
                          className="inline-flex h-7 items-center rounded-[3px] border border-[#dde3ee] bg-white px-3 text-xs font-medium text-[#526075] hover:border-[#2f80ed] hover:text-[#2f80ed]"
                          onClick={() => void handleShowStepLog(msg.sessionId!)}
                        >
                          执行详情
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}
            {sending && (
              <div className="flex justify-start">
                <div className="max-w-[85%] rounded-lg bg-[#f4f6f9] px-4 py-2.5 text-sm text-[#8b95a7]">
                  <span className="inline-flex items-center gap-1">
                    <span className="animate-pulse">●</span>
                    <span className="animate-pulse" style={{ animationDelay: "0.2s" }}>●</span>
                    <span className="animate-pulse" style={{ animationDelay: "0.4s" }}>●</span>
                  </span>
                </div>
              </div>
            )}
            {stepLogs && (
              <div className="rounded-lg border border-[#dde3ee] bg-white p-3">
                <div className="flex items-center justify-between mb-2">
                  <h4 className="text-xs font-semibold text-[#263445]">执行详情</h4>
                  <button className="text-xs text-[#8b95a7] hover:text-[#526075]" onClick={() => { setStepLogs(null); setLlmLogs(null); }}>关闭</button>
                </div>
                <div className="mb-2 text-[11px] font-medium text-[#8b95a7]">步骤日志</div>
                {stepLogs.map((step, i) => (
                  <details key={i} className="mb-1">
                    <summary className="cursor-pointer text-xs text-[#2f80ed] hover:underline">
                      {step.display_name ?? step.step_name} — {step.duration_ms}ms{step.llm_tokens_used ? ` / ${step.llm_tokens_used} tokens` : ""}
                    </summary>
                    <div className="mt-1 rounded bg-[#f8f9fb] p-2 text-xs text-[#526075]">
                      {step.tenant_summary && <div className="mb-1 text-[#263445]">{step.tenant_summary}</div>}
                      <div><span className="font-medium">输入：</span>{step.input_summary}</div>
                      <div className="mt-1"><span className="font-medium">输出：</span>{step.output_summary}</div>
                    </div>
                  </details>
                ))}
                {llmLogs && llmLogs.length > 0 && (
                  <div className="mt-3 border-t border-[#e8edf5] pt-3">
                    <div className="mb-2 text-[11px] font-medium text-[#8b95a7]">LLM 调用</div>
                    {llmLogs.map((call, i) => {
                      const lastUser = [...(call.messages_json ?? [])].reverse().find((item) => item.role === "user")?.content ?? "";
                      const response = call.function_call?.arguments || call.response_content || call.error || "";
                      return (
                        <details key={`${call.created_at}-${i}`} className="mb-1">
                          <summary className="cursor-pointer text-xs text-[#2f80ed] hover:underline">
                            {call.model} · {call.has_tools ? `tool: ${(call.tool_names ?? []).join(", ") || "auto"}` : "text"} · {call.duration_ms}ms{call.tokens_used ? ` / ${call.tokens_used} tokens` : ""}
                          </summary>
                          <div className="mt-1 rounded bg-[#f8f9fb] p-2 text-xs text-[#526075]">
                            <div className="font-medium text-[#263445]">最后输入</div>
                            <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words">{lastUser}</pre>
                            <div className="mt-2 font-medium text-[#263445]">返回</div>
                            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words">{response}</pre>
                          </div>
                        </details>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
            {versionList && (
              <div className="rounded-lg border border-[#dde3ee] bg-white p-3">
                <div className="flex items-center justify-between mb-2">
                  <h4 className="text-xs font-semibold text-[#263445]">版本历史</h4>
                  <button className="text-xs text-[#8b95a7] hover:text-[#526075]" onClick={() => setVersionList(null)}>关闭</button>
                </div>
                {versionList.length === 0 ? (
                  <p className="text-xs text-[#8b95a7]">暂无版本记录</p>
                ) : (
                  <div className="max-h-[300px] overflow-auto space-y-2">
                    {versionList.map((ver) => (
                      <div key={ver.id} className="flex items-center justify-between rounded border border-[#e8edf5] bg-[#f8f9fb] px-3 py-2">
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-medium text-[#263445]">
                            v{ver.version_no} · {versionStatusLabels[ver.status] ?? ver.status}
                          </div>
                          <div className="truncate text-xs text-[#8b95a7]">{ver.change_summary}</div>
                        </div>
                        <button
                          className="ml-2 inline-flex h-6 shrink-0 items-center rounded-[3px] border border-[#2f80ed] bg-white px-2 text-[10px] font-medium text-[#2f80ed] hover:bg-[#edf3ff] disabled:opacity-50"
                          onClick={() => void handleRollbackPreview(ver.id)}
                          disabled={rollbackPreviewing === ver.id}
                        >
                          {rollbackPreviewing === ver.id ? "生成中..." : "回滚预览"}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="border-t border-[#e8edf5] p-4">
            {attachments.length > 0 && (
              <div className="mb-3 flex flex-wrap gap-2">
                {attachments.map((item) => (
                  <span key={item.id} className="inline-flex max-w-full items-center gap-2 rounded border border-[#dde3ee] bg-[#f7f9fc] px-2 py-1 text-xs text-[#526075]">
                    <span className="truncate max-w-[240px]">{item.fileName}</span>
                    <button className="text-[#9aa4b5] hover:text-[#526075]" onClick={() => setAttachments((prev) => prev.filter((att) => att.id !== item.id))}>×</button>
                  </span>
                ))}
              </div>
            )}
            <div className="flex gap-2">
              <label className="inline-flex h-9 cursor-pointer items-center justify-center rounded-[3px] border border-[#dde3ee] bg-white px-3 text-sm font-medium text-[#526075] hover:border-[#2f80ed] hover:text-[#2f80ed]">
                {uploadingAttachment ? "上传中" : "附件"}
                <input
                  type="file"
                  className="hidden"
                  accept=".xlsx,.xls,.csv,image/*"
                  disabled={uploadingAttachment || sending}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.currentTarget.value = "";
                    if (file) void handleAttachmentFile(file);
                  }}
                />
              </label>
              <input
                className="h-9 flex-1 border border-[#dde3ee] bg-white px-3 text-sm outline-none transition placeholder:text-[#a7b0bf] focus:border-[#2f80ed]"
                placeholder="输入定制需求..."
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
                disabled={sending}
              />
              <button
                className="inline-flex h-9 items-center justify-center rounded-[3px] border border-[#2f80ed] bg-[#2f80ed] px-4 text-sm font-medium text-white hover:bg-[#1c6fd8] disabled:opacity-50"
                onClick={() => void send()}
                disabled={sending || (!input.trim() && attachments.length === 0)}
              >
                发送
              </button>
            </div>
          </div>
        </aside>
      </div>


      {publishConfirm && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/45">
          <div className="w-full max-w-[420px] rounded-lg bg-white p-6 shadow-xl">
            <h3 className="text-base font-semibold text-[#263445] mb-3">确认发布</h3>
            <p className="text-sm text-[#526075] mb-1">
              即将发布版本 <span className="font-medium text-[#2f80ed]">v{publishConfirm.versionNo}</span> 的变更：
            </p>
            <p className="text-sm text-[#7a8494] mb-5">{publishConfirm.summary}</p>
            <p className="text-xs text-[#ff4d64] mb-5">发布后将立即生效，请确认预览结果无误。</p>
            <div className="flex justify-end gap-2">
              <button
                className="inline-flex h-8 items-center rounded-[3px] border border-[#dde3ee] bg-white px-4 text-sm font-medium text-[#526075] hover:border-[#2f80ed] hover:text-[#2f80ed]"
                onClick={() => setPublishConfirm(null)}
              >
                取消
              </button>
              <button
                className="inline-flex h-8 items-center rounded-[3px] border border-[#2f80ed] bg-[#2f80ed] px-4 text-sm font-medium text-white hover:bg-[#1c6fd8]"
                onClick={() => void handlePublish(publishConfirm)}
              >
                确认发布
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
